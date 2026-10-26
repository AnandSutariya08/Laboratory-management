import { getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp, type DocumentData, type Firestore } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { FIRESTORE_DB } from './secrets'

// Auto-verification. When an analyser adds machine values to a result that is still open, the lab's rule set
// (lab document field `autoVerify`) decides whether the result is approved without a person. Every rule must pass:
// all non-calculated parameters came from the machine, nothing critical, nothing abnormal (unless allowed),
// delta check ok, latest QC on the analyser not failed, test not excluded, not on hold / rejected, and the
// result is not picked for the random review sample. Otherwise the reasons are stored on the result
// (autoVerifyCheck) and it waits for verification as usual.

interface Cfg {
  enabled: boolean
  samplingPct: number
  blockAbnormal: boolean
  useDeltaCheck: boolean
  requireQcInControl: boolean
  excludedTestIds: string[]
  version: number
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim())
const num = (raw: string): number | null => {
  const s = raw.trim().replace(/^[<>]=?/, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
const DAY = 86_400_000

function ageDays(order: DocumentData, dob: string | undefined): number {
  const billMs = (order.billDate ?? order.createdAt)?.toMillis?.() ?? Date.now()
  const at = order.collectedAt?.toMillis?.() ?? billMs
  if (dob) {
    const b = new Date(dob).getTime()
    if (Number.isFinite(b) && b <= at) return Math.floor((at - b) / DAY)
  }
  const v = Number(order.ageValue) || 0
  const base = order.ageUnit === 'year' ? Math.round(v * 365.25) : order.ageUnit === 'month' ? Math.round(v * 30.44) : v
  return base + Math.max(0, Math.floor((at - billMs) / DAY))
}

function rangeFor(p: DocumentData, age: number, gender: string, condition: string) {
  const sexOf = (r: DocumentData) => r.gender ?? 'any'
  const fits = ((p.ranges ?? []) as DocumentData[]).filter(
    (r) => age >= r.fromDays && age < r.toDays && (!r.condition || (!!condition && r.condition === condition)) && (sexOf(r) === 'any' || sexOf(r) === gender),
  )
  const score = (r: DocumentData) => (r.condition ? 2 : 0) + (sexOf(r) !== 'any' ? 1 : 0)
  const band = [...fits].sort((a, b) => score(b) - score(a))[0]
  return { low: (band ? band.low : p.low) as number | null, high: (band ? band.high : p.high) as number | null }
}

function flagFor(p: DocumentData, raw: string, age: number, gender: string, condition: string) {
  if (p.dataType !== 'numeric' && p.dataType !== 'numericUnbound') {
    const f = p.optionFlags?.[raw.trim()]
    return { abnormal: f === 'abnormal' || f === 'critical' ? 'abnormal' : null, critical: f === 'critical' } as DocumentData
  }
  const v = num(raw)
  if (v === null) return { abnormal: null, critical: false }
  const { low, high } = rangeFor(p, age, gender, condition)
  const abnormal = low !== null && v < low ? 'low' : high !== null && v > high ? 'high' : null
  const cl = p.criticalLow !== null && p.criticalLow !== undefined && v < p.criticalLow
  const ch = p.criticalHigh !== null && p.criticalHigh !== undefined && v > p.criticalHigh
  const out: DocumentData = { abnormal, critical: cl || ch }
  if (cl) out.criticalDir = 'low'
  else if (ch) out.criticalDir = 'high'
  return out
}

async function previousValue(db: Firestore, labId: string, order: DocumentData, orderId: string, testId: string, key: string, lookbackDays: number) {
  const snap = await db.collection(`labs/${labId}/orders`).where('patientId', '==', order.patientId).limit(25).get()
  const others = snap.docs
    .filter((d) => d.id !== orderId && !d.data().deleted)
    .sort((a, b) => (b.data().createdAt?.toMillis?.() ?? 0) - (a.data().createdAt?.toMillis?.() ?? 0))
    .slice(0, 8)
  for (const o of others) {
    const at = o.data().createdAt?.toMillis?.() ?? 0
    if (lookbackDays > 0 && Date.now() - at > lookbackDays * DAY) return null
    const r = (await o.ref.collection('results').doc(testId).get()).data()
    const v = r?.status === 'approved' ? r.values?.[key]?.value : undefined
    if (v !== undefined && num(str(v)) !== null) return { value: str(v), at }
  }
  return null
}

// Same report-status rule as the app (lib/billing deriveReportStatus).
function deriveReportStatus(items: DocumentData[], approved: Set<string>, rejected: Set<string>, provisional: Set<string>, due: number, finalRequiresPayment: boolean) {
  const ids = items.filter((i) => i.status !== 'refunded' && i.status !== 'rejected').flatMap((i) => (i.testIds ?? []) as string[]).filter((t) => !rejected.has(t))
  if (!ids.length) return 'pending'
  const done = ids.filter((t) => approved.has(t)).length
  if (done === 0) return 'pending'
  if (done < ids.length) return 'partial'
  if (finalRequiresPayment && due > 0) return 'provisional'
  if (ids.some((t) => provisional.has(t))) return 'provisional'
  return 'final'
}

export async function tryAutoVerify(labId: string, orderId: string, testId: string): Promise<void> {
  if (!getApps().length) initializeApp()
  const db = getFirestore(FIRESTORE_DB)
  const labSnap = await db.doc(`labs/${labId}`).get()
  const lab = labSnap.data() ?? {}
  const cfg = { enabled: false, samplingPct: 5, blockAbnormal: true, useDeltaCheck: true, requireQcInControl: true, excludedTestIds: [], version: 1, ...(lab.autoVerify ?? {}) } as Cfg
  if (!cfg.enabled) return
  const rRef = db.doc(`labs/${labId}/orders/${orderId}/results/${testId}`)
  const r = (await rRef.get()).data()
  if (!r || (r.status !== 'pending' && r.status !== 'entered') || !Array.isArray(r.machineValues) || !r.machineValues.length) return
  const order = (await db.doc(`labs/${labId}/orders/${orderId}`).get()).data()
  const test = (await db.doc(`labs/${labId}/tests/${testId}`).get()).data()
  if (!order || order.deleted || !test) return

  const reasons: string[] = []
  const params = ((test.parameters ?? []) as DocumentData[]).filter((p) => p.structure !== 'group' && !p.formula && !['richText', 'image', 'pdf'].includes(p.dataType))
  const calc = ((test.parameters ?? []) as DocumentData[]).some((p) => p.formula)
  if (calc) reasons.push('test has calculated parameters')
  if (cfg.excludedTestIds.includes(testId)) reasons.push('test always needs a person')
  if (r.status === 'hold' || r.rejected || (r.rejectedParams ?? []).length) reasons.push('held or rejected')
  const item = ((order.items ?? []) as DocumentData[]).find((i) => (i.testIds ?? []).includes(testId))
  if (!item || ['rejected', 'refunded'].includes(item.status)) reasons.push('sample rejected or line refunded')

  // Latest machine run, mapped to values.
  const run = (r.machineValues as DocumentData[])[r.machineValues.length - 1]
  const mv = (run?.values ?? {}) as Record<string, { value: string; flag?: string }>
  const patient = order.patientId ? (await db.doc(`labs/${labId}/patients/${order.patientId}`).get()).data() : undefined
  const age = ageDays(order, patient?.dob)
  const gender = str(order.gender)
  const condition = str(order.patientCondition)
  const values: Record<string, DocumentData> = {}
  for (const p of params) {
    const m = mv[p.key]
    if (!m || m.value === '') {
      if (p.required) reasons.push(`${p.name} missing from the machine`)
      continue
    }
    const f = flagFor(p, str(m.value), age, gender, condition)
    values[p.key] = { value: str(m.value), overridden: false, ...f }
    if (f.critical) reasons.push(`${p.name} is critical`)
    else if (f.abnormal && cfg.blockAbnormal) reasons.push(`${p.name} is abnormal`)
    if (str(m.flag) && !/^(N|NORMAL)$/i.test(str(m.flag)) && !f.abnormal) reasons.push(`${p.name} has an instrument flag (${m.flag})`)
    if (cfg.useDeltaCheck) {
      const rs = lab.reportEntry ?? {}
      const pct = p.deltaLimitPct ?? Number(rs.deltaCheckPercent ?? 0)
      const abs = p.deltaLimitAbs ?? Number(rs.deltaAbsoluteLimit ?? 0)
      if (pct > 0 || abs > 0) {
        const prev = await previousValue(db, labId, order, orderId, testId, p.key, Number(rs.deltaLookbackDays ?? 0))
        const a = num(str(m.value))
        const b = prev ? num(prev.value) : null
        if (a !== null && b !== null) {
          const dp = b === 0 ? null : Math.abs(((a - b) / Math.abs(b)) * 100)
          if ((pct > 0 && dp !== null && dp >= pct) || (abs > 0 && Math.abs(a - b) >= abs)) reasons.push(`${p.name} changed a lot from the previous result`)
        }
      }
    }
  }
  if (!Object.keys(values).length) reasons.push('no values from the machine')

  if (cfg.requireQcInControl && r.machineId) {
    const qc = await db.collection(`labs/${labId}/qcRuns`).where('machineId', '==', r.machineId).limit(30).get()
    const latest = qc.docs.map((d) => d.data()).filter((d) => !d.deleted).sort((a, b) => (b.runAt?.toMillis?.() ?? 0) - (a.runAt?.toMillis?.() ?? 0))[0]
    if (latest?.status === 'fail') reasons.push('latest QC run on the analyser failed')
  }
  if (!reasons.length && Math.random() * 100 < cfg.samplingPct) reasons.push('picked for the review sample')

  const passed = reasons.length === 0
  const check = { at: Date.now(), passed, reasons, ruleVersion: cfg.version }
  if (!passed) {
    await rRef.update({ autoVerifyCheck: check })
    return
  }

  // Approve as the system, snapshot the default signatory when the lab uses one.
  const signers = ((lab.signatories ?? []) as DocumentData[]).filter((s) => s.active !== false)
  const pick = lab.autoVerify?.signatureMode === 'none' ? undefined : signers.find((s) => s.id === lab.reportEntry?.defaultSignatoryId) ?? signers[0]
  await rRef.update({
    values,
    status: 'approved',
    approvedBy: 'system',
    approvedByName: 'Auto verified',
    approvedAt: FieldValue.serverTimestamp(),
    enteredBy: 'machine',
    releaseType: 'final',
    autoVerified: true,
    autoVerifyRuleVersion: cfg.version,
    autoVerifyCheck: check,
    draft: null,
    verification: null,
    updatedAt: FieldValue.serverTimestamp(),
    ...(pick ? { signatureSnapshots: [{ id: pick.id, name: str(pick.name), qualification: str(pick.qualification), registrationNo: str(pick.registrationNo), signatureDataUrl: str(pick.signatureDataUrl), designation: str(pick.designation), hideNameInReport: !!pick.hideNameInReport }] } : {}),
  })
  await rRef.collection('versions').add({ event: 'approved', auto: true, values, by: 'system', byName: 'Auto verified', at: FieldValue.serverTimestamp() })
  await syncOrder(db, labId, orderId, testId, !!lab.finalRequiresPayment || lab.finalRequiresPayment === undefined)
  await db.collection(`labs/${labId}/activity`).add({
    type: 'result.autoVerified', category: 'VERIFY', text: `${test.name} on bill ${order.billNo ?? ''} auto-verified (rules v${cfg.version})`,
    refPath: `orders/${orderId}`, at: Timestamp.now(), by: 'system', byName: 'Auto verified', branchId: order.branchId ?? 'main',
  })
}

// Line status and bill report status after an automatic approval.
async function syncOrder(db: Firestore, labId: string, orderId: string, _testId: string, finalRequiresPayment: boolean) {
  const ref = db.doc(`labs/${labId}/orders/${orderId}`)
  const results = (await ref.collection('results').get()).docs.map((d) => d.data())
  const status = new Map(results.map((x) => [str(x.testId), str(x.status)]))
  const approved = new Set([...status].filter(([, s]) => s === 'approved').map(([t]) => t))
  const rejected = new Set([...status].filter(([, s]) => s === 'rejected').map(([t]) => t))
  const provisional = new Set(results.filter((x) => x.status === 'approved' && x.releaseType === 'provisional').map((x) => str(x.testId)))
  const autoSet = new Set(results.filter((x) => x.status === 'approved' && x.autoVerified).map((x) => str(x.testId)))
  await db.runTransaction(async (tx) => {
    const o = (await tx.get(ref)).data()
    if (!o) return
    const items = ((o.items ?? []) as DocumentData[]).map((it) => {
      if (it.status === 'refunded') return it
      const live = ((it.testIds ?? []) as string[]).filter((t) => status.get(t) !== 'rejected')
      if (live.length && live.every((t) => approved.has(t)) && it.status !== 'approved') {
        const next: DocumentData = { ...it, status: 'approved' }
        if (live.every((t) => autoSet.has(t))) next.autoVerified = true
        if (live.some((t) => provisional.has(t))) next.provisional = true
        return next
      }
      if (it.status === 'received' && live.some((t) => status.get(t) === 'entered')) return { ...it, status: 'entered' }
      return it
    })
    const reportStatus = deriveReportStatus(items, approved, rejected, provisional, Number(o.due ?? 0), finalRequiresPayment)
    tx.update(ref, { items, reportStatus, ...(reportStatus === 'final' && !o.reportedAt ? { reportedAt: Timestamp.now() } : {}), ...(approved.size > 0 && !o.firstApprovedAt ? { firstApprovedAt: Timestamp.now() } : {}) })
  })
}

export const autoVerifyOnMachineValues = onDocumentWritten(
  { document: 'labs/{labId}/orders/{orderId}/results/{testId}', database: FIRESTORE_DB, region: 'asia-south1' },
  async (event) => {
    const after = event.data?.after.data()
    if (!after || !Array.isArray(after.machineValues)) return
    const before = event.data?.before.data()
    const was = Array.isArray(before?.machineValues) ? before!.machineValues.length : 0
    if (after.machineValues.length <= was) return // only react to a new machine run
    const { labId, orderId, testId } = event.params
    try {
      await tryAutoVerify(labId, orderId, testId)
    } catch (e) {
      console.error('auto-verify failed', e)
    }
  },
)
