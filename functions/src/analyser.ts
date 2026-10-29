import { createHash, timingSafeEqual } from 'node:crypto'
import { getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp, type DocumentData, type Firestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { FIRESTORE_DB } from './secrets'

// Analyser interface. A machine (or the lab's interface agent) POSTs results with a per-machine token:
//   Authorization: Bearer <labId>.<machineId>.<secret>      (or header x-analyser-token)
// The token is made in the app (QC > Connect analyser); only its SHA-256 is stored on the qcMachines doc
// (field ingestTokenHash). Body: JSON {barcode, results:[{code,value,unit?,flag?}]}, or ASTM / HL7 v2 text.
// Codes map through the parameter / test machine codes. Matched values are added to the result doc's
// `machineValues` (the result entry "Machine value" picker reads them); the autoverify trigger may then approve.
// Unmatched codes and unknown barcodes go to the analyserUnmatched queue. A barcode that names a QC lot
// (QC:<lot>[:L1|L2|L3], or a lot number) is stored as a QC run instead of patient data.

export interface MachineResult {
  code: string
  value: string
  unit?: string
  flag?: string
  mic?: string // minimum inhibitory concentration, when the machine sends one
}
export interface ParsedBody {
  barcode: string
  results: MachineResult[]
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim())

function parseJson(b: Record<string, unknown>): ParsedBody | null {
  const barcode = str(b.barcode ?? b.sampleId ?? b.specimenId)
  const list = (Array.isArray(b.results) ? b.results : Array.isArray(b.tests) ? b.tests : null) as Record<string, unknown>[] | null
  if (!barcode || !list) return null
  const results = list
    .map((r) => ({ code: str(r.code ?? r.testCode ?? r.test), value: str(r.value ?? r.result), unit: str(r.unit), flag: str(r.flag), mic: str(r.mic) }))
    .filter((r) => r.code && r.value !== '')
  return { barcode, results }
}

// MIC values: an HL7 OBX-13 / ASTM comment of the form "MIC=<value>".
const micOf = (s: string) => /MIC\s*[=:]\s*([^\s|^]+)/i.exec(s)?.[1] ?? ''

export function parseHl7(text: string): ParsedBody | null {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim()).filter(Boolean)
  let barcode = ''
  const results: MachineResult[] = []
  for (const l of lines) {
    const f = l.split('|')
    const seg = f[0]
    if (seg === 'OBR' || seg === 'ORC') barcode = barcode || str(f[3]).split('^')[0] || str(f[2]).split('^')[0]
    else if (seg === 'SPM') barcode = barcode || str(f[2]).split('^')[0]
    else if (seg === 'OBX') {
      const idc = str(f[3]).split('^')
      const code = idc[0] || idc[1] || ''
      const value = str(f[5])
      if (code && value !== '' && str(f[2]) !== 'ED') results.push({ code, value, unit: str(f[6]).split('^')[0], flag: str(f[8]), mic: micOf(f[13] ?? '') || undefined })
    }
  }
  return barcode ? { barcode, results } : null
}

export function parseAstm(text: string): ParsedBody | null {
  const lines = text
    .replace(/[\x02\x03\x05\x06\x04\x15\x17]/g, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim().replace(/^\d(?=[A-Z]\|)/, ''))
    .filter(Boolean)
  let barcode = ''
  const results: MachineResult[] = []
  for (const l of lines) {
    const f = l.split('|')
    if (f[0] === 'O') barcode = barcode || str(f[2]).split('^')[0] || str(f[3]).split('^')[0]
    else if (f[0] === 'R') {
      const comps = str(f[2]).split('^')
      const code = comps[3] || [...comps].reverse().find(Boolean) || ''
      const value = str(f[3])
      if (code && value !== '') results.push({ code, value, unit: str(f[4]), flag: str(f[6]), mic: micOf(f.slice(7).join('|')) || undefined })
    }
  }
  return barcode ? { barcode, results } : null
}

export function parseBody(body: unknown, raw: string): ParsedBody | null {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return parseJson(body as Record<string, unknown>)
  const text = typeof body === 'string' && body ? body : raw
  if (!text) return null
  const t = text.trim()
  if (t.startsWith('{')) {
    try {
      return parseJson(JSON.parse(t))
    } catch {
      return null
    }
  }
  if (/MSH\|/.test(t)) return parseHl7(t.slice(t.indexOf('MSH|')))
  if (/(^|[\r\n\x02])\d?H\|/.test(t)) return parseAstm(t)
  return null
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex')

// Which labs/machines a token can belong to: "<labId>.<machineId>.<secret>".
async function authMachine(db: Firestore, token: string): Promise<{ labId: string; machineId: string; machine: DocumentData } | null> {
  const [labId, machineId] = token.split('.')
  if (!labId || !machineId || !/^[\w-]{1,64}$/.test(labId) || !/^[\w-]{1,64}$/.test(machineId)) return null
  const snap = await db.doc(`labs/${labId}/qcMachines/${machineId}`).get()
  const m = snap.data()
  if (!m || m.active === false || !m.ingestTokenHash) return null
  const a = Buffer.from(String(m.ingestTokenHash))
  const b = Buffer.from(hash(token))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return { labId, machineId, machine: m }
}

const splitCodes = (s: unknown) => str(s).split(/[,;]/).map((x) => x.trim().toUpperCase()).filter(Boolean)
const branchOf = (d: DocumentData | undefined) => str(d?.branchId) || 'main'

function stripAffixes(code: string, tests: DocumentData[], sampleTypes: DocumentData[]): string {
  let c = code.trim()
  const pre = sampleTypes.map((s) => str(s.barcodePrefix)).filter(Boolean).sort((a, b) => b.length - a.length)
  const suf = [...tests.map((t) => str(t.barcodeSuffix)), ...sampleTypes.map((s) => str(s.barcodeSuffix))].filter(Boolean).sort((a, b) => b.length - a.length)
  const p = pre.find((x) => c.startsWith(x))
  if (p) c = c.slice(p.length)
  const s = suf.find((x) => c.endsWith(x))
  if (s) c = c.slice(0, c.length - s.length)
  return c
}

async function unmatched(db: Firestore, labId: string, machineId: string, machine: DocumentData, barcode: string, items: MachineResult[], reason: string) {
  const at = FieldValue.serverTimestamp()
  for (const r of items.length ? items : [{ code: '', value: '' }]) {
    await db.collection(`labs/${labId}/analyserUnmatched`).add({
      branchId: branchOf(machine), machineId, machineName: str(machine.name), barcode, code: r.code, value: r.value, reason, at,
    })
  }
}

// Store a patient result set. Returns matched / unmatched code lists.
async function storePatient(db: Firestore, labId: string, machineId: string, machine: DocumentData, orderId: string, order: DocumentData, results: MachineResult[], tests: Map<string, DocumentData>) {
  const testIds = [...new Set(((order.items ?? []) as DocumentData[]).filter((i) => i.status !== 'refunded').flatMap((i) => (i.testIds ?? []) as string[]))]
  const matchedCodes = new Set<string>()
  const perTest = new Map<string, Record<string, { value: string; unit: string; flag: string; mic?: string }>>()
  for (const r of results) {
    const code = r.code.toUpperCase()
    for (const tid of testIds) {
      const t = tests.get(tid)
      if (!t) continue
      const params = ((t.parameters ?? []) as DocumentData[]).filter((p) => p.structure !== 'group')
      let p = params.find((x) => splitCodes(x.machineCode).includes(code))
      if (!p && splitCodes(t.machineCode).includes(code)) p = params.length === 1 ? params[0] : params.find((x) => !x.formula)
      if (!p) continue
      const cur = perTest.get(tid) ?? {}
      cur[String(p.key)] = { value: r.value, unit: r.unit ?? '', flag: r.flag ?? '', ...(r.mic ? { mic: r.mic } : {}) }
      perTest.set(tid, cur)
      matchedCodes.add(code)
    }
  }
  for (const [tid, values] of perTest) {
    const t = tests.get(tid)!
    const ref = db.doc(`labs/${labId}/orders/${orderId}/results/${tid}`)
    const cur = (await ref.get()).data()
    if (cur?.status === 'approved') continue
    const run = { machine: str(machine.name), machineId, at: Timestamp.now(), values }
    if (!cur) {
      await ref.set({ id: tid, orderId, testId: tid, testName: str(t.name), values: {}, comment: '', status: 'pending', enteredBy: '', approvedBy: '', approvedByName: '', machineValues: [run], machineId, machineName: str(machine.name), updatedAt: FieldValue.serverTimestamp() })
    } else {
      await ref.update({ machineValues: FieldValue.arrayUnion(run), machineId, machineName: str(machine.name), updatedAt: FieldValue.serverTimestamp() })
    }
  }
  if (perTest.size) await db.doc(`labs/${labId}/orders/${orderId}`).update({ hasMachineValue: true })
  return { matched: [...matchedCodes], unmatched: results.filter((r) => !matchedCodes.has(r.code.toUpperCase())) }
}

// Store a QC lot run (machine-fed QC values).
async function storeQc(db: Firestore, labId: string, machineId: string, machine: DocumentData, material: DocumentData, level: string, results: MachineResult[], tests: Map<string, DocumentData>) {
  const machineTests = ((machine.testIds ?? []) as string[]).length ? ((machine.testIds ?? []) as string[]) : [...tests.keys()]
  const out: DocumentData[] = []
  const missed: MachineResult[] = []
  for (const r of results) {
    const code = r.code.toUpperCase()
    const v = Number(r.value.replace(/^[<>]=?/, ''))
    let hit = false
    for (const tid of machineTests) {
      const t = tests.get(tid)
      const p = ((t?.parameters ?? []) as DocumentData[]).find((x) => splitCodes(x.machineCode).includes(code) || (splitCodes(t?.machineCode).includes(code) && (t?.parameters ?? []).length === 1))
      if (!t || !p || !Number.isFinite(v)) continue
      const tg = ((material.targets ?? []) as DocumentData[]).find((x) => x.testId === tid && x.paramKey === p.key && x.level === level && (!x.machineId || x.machineId === machineId))
      if (!tg || !(Number(tg.sd) > 0)) continue
      const z = (v - Number(tg.mean)) / Number(tg.sd)
      const outcome = Math.abs(z) > 3 ? 'fail' : Math.abs(z) > 2 ? 'warning' : 'pass'
      out.push({ testId: tid, testName: str(t.name), paramKey: str(p.key), paramName: str(p.name), level, value: v, z: Math.round(z * 100) / 100, mean: Number(tg.mean), sd: Number(tg.sd), targetVersion: material.targetVersion ?? 1, outcome })
      hit = true
      break
    }
    if (!hit) missed.push(r)
  }
  if (out.length) {
    const status = out.some((o) => o.outcome === 'fail') ? 'fail' : out.some((o) => o.outcome === 'warning') ? 'warning' : 'pass'
    const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(2, 10).replace(/-/g, '')
    const counter = db.doc(`labs/${labId}/counters/qc-run-${day}`)
    const n = await db.runTransaction(async (tx) => {
      const c = ((await tx.get(counter)).data()?.value as number | undefined) ?? 0
      tx.set(counter, { value: c + 1 })
      return c + 1
    })
    await db.collection(`labs/${labId}/qcRuns`).add({
      branchId: branchOf(machine), machineId, machineName: str(machine.name), departmentId: str(machine.departmentId),
      materialId: str(material.id), materialName: str(material.name), lotNo: str(material.lotNo),
      results: out,
      status,
      violations: out.filter((o) => o.outcome !== 'pass').map((o) => ({ rule: Math.abs(o.z) > 3 ? '1-3s' : '1-2s', level, message: `${o.paramName} ${o.value} (z ${o.z})`, severity: o.outcome === 'fail' ? 'fail' : 'warning', testId: o.testId, paramKey: o.paramKey })),
      note: 'Received from the analyser', source: 'analyser', runBy: 'analyser', runByName: str(machine.name) || 'Analyser',
      runAt: Timestamp.now(), runNo: `QC-${day}-${String(n).padStart(3, '0')}`, approval: 'notRequired', deleted: false,
    })
  }
  return { matched: out.map((o) => o.paramKey), unmatched: missed }
}

export const analyserIngest = onRequest({ region: 'asia-south1', cors: true, timeoutSeconds: 60 }, async (req, res) => {
  if (!getApps().length) initializeApp()
  const db = getFirestore(FIRESTORE_DB)
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' })
    return
  }
  const auth = str(req.get('authorization')).replace(/^Bearer\s+/i, '') || str(req.get('x-analyser-token'))
  const m = auth ? await authMachine(db, auth).catch(() => null) : null
  if (!m) {
    res.status(401).json({ ok: false, error: 'Invalid or missing analyser token' })
    return
  }
  const { labId, machineId, machine } = m
  // Heartbeat from the lab's connector (every minute): proves the token, records the link state for the app.
  const hb = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? (req.body as Record<string, unknown>) : null
  if (hb?.heartbeat === true) {
    const link = str(hb.link)
    await db.doc(`labs/${labId}/qcMachines/${machineId}`).update({
      connector: {
        lastSeenAt: Timestamp.now(),
        version: str(hb.version).slice(0, 20),
        host: str(hb.host).slice(0, 80),
        connection: str(hb.connection).slice(0, 20),
        protocol: str(hb.protocol).slice(0, 10),
        link: link.slice(0, 20),
        detail: str(hb.detail).slice(0, 200),
        queue: Math.max(0, Math.min(1e6, Number(hb.queue) || 0)),
      },
      integrationStatus: link === 'connected' || link === 'listening' ? 'connected' : 'offline',
    })
    res.status(200).json({ ok: true, machine: str(machine.name) })
    return
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : ''
  const parsed = parseBody(req.body, raw)
  if (!parsed || !parsed.results.length) {
    res.status(400).json({ ok: false, error: 'Expected {barcode, results:[{code,value}]} or ASTM / HL7 text with a sample id and results' })
    return
  }
  try {
    await db.doc(`labs/${labId}/qcMachines/${machineId}`).update({ lastIngestAt: Timestamp.now(), integrationStatus: 'connected' })
    const [testSnap, stSnap] = await Promise.all([db.collection(`labs/${labId}/tests`).get(), db.collection(`labs/${labId}/sampleTypes`).get()])
    const tests = new Map(testSnap.docs.map((d) => [d.id, { ...d.data(), id: d.id }] as [string, DocumentData]))

    // QC lot?
    const tok = parsed.barcode.split(':')
    let lot = tok[0].toUpperCase() === 'QC' ? tok[1] ?? '' : ''
    let level = tok[0].toUpperCase() === 'QC' ? (tok[2] ?? 'L1').toUpperCase() : 'L1'
    const materials = await db.collection(`labs/${labId}/qcMaterials`).get()
    let material = lot ? materials.docs.find((d) => str(d.data().lotNo) === lot) : undefined
    if (!material && !lot) material = materials.docs.find((d) => str(d.data().lotNo) === parsed.barcode)
    if (material) {
      lot = str(material.data().lotNo)
      if (!['L1', 'L2', 'L3'].includes(level)) level = 'L1'
      const r = await storeQc(db, labId, machineId, machine, { ...material.data(), id: material.id }, level, parsed.results, tests)
      if (r.unmatched.length) await unmatched(db, labId, machineId, machine, parsed.barcode, r.unmatched, 'No QC target for this code')
      res.status(200).json({ ok: true, kind: 'qc', lot, level, matched: r.matched.length, unmatched: r.unmatched.map((x) => x.code) })
      return
    }

    // Patient sample: exact barcode, then the bill barcode inside a tube code.
    const candidates = [...new Set([parsed.barcode, stripAffixes(parsed.barcode, [...tests.values()], stSnap.docs.map((d) => d.data())), ...(parsed.barcode.match(/\d{4,}/g) ?? [])])]
    let order: { id: string; data: DocumentData } | null = null
    for (const c of candidates) {
      const snap = await db.collection(`labs/${labId}/orders`).where('barcode', '==', c).get()
      const d = snap.docs.find((x) => !x.data().deleted && branchOf(x.data()) === branchOf(machine))
      if (d) {
        order = { id: d.id, data: d.data() }
        break
      }
    }
    if (!order) {
      await unmatched(db, labId, machineId, machine, parsed.barcode, parsed.results, 'No bill with this barcode in the machine’s branch')
      res.status(404).json({ ok: false, error: 'No bill found for this barcode', unmatched: parsed.results.length })
      return
    }
    const r = await storePatient(db, labId, machineId, machine, order.id, order.data, parsed.results, tests)
    if (r.unmatched.length) await unmatched(db, labId, machineId, machine, parsed.barcode, r.unmatched, 'Code not mapped to a test on this bill')
    res.status(200).json({ ok: true, kind: 'patient', orderId: order.id, matched: r.matched, unmatched: r.unmatched.map((x) => x.code) })
  } catch (e) {
    console.error('analyserIngest failed', e)
    res.status(500).json({ ok: false, error: 'Could not store the results' })
  }
})
