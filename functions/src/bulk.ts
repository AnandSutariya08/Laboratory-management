import { FieldValue, getFirestore, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { randomUUID } from 'node:crypto'
import { REGION, FIRESTORE_DB } from './secrets'
import * as core from './index'
import { getBucket } from './snapshot'

// Bulk registration as a server background job.
//
// The web app validates a spreadsheet, writes the rows that passed as a normalised CSV to Cloud Storage
// (labs/{lab}/bulk/{importId}.csv) and creates labs/{lab}/bulkImports/{importId} with the options. It then
// calls runBulkRegistration, which reads the CSV and registers the patients (and bills) in chunks of 25 rows.
// Progress is written to the bulkImports doc after every chunk (processed / created / skipped / failed), and
// each chunk's per-row results to bulkImports/{importId}/results/{chunk}, so the screen can follow it and the
// job can be resumed. A row is only ever created once: patients carry bulkImportId + bulkRow, which is
// checked before a row is written, so a resumed or repeated run never duplicates.

const db = () => getFirestore(FIRESTORE_DB)
const CHUNK = 25
const MAX_ROWS = 2000
const LAB_ID_RE = /^[\w-]{1,64}$/

interface Opts {
  makeBills: boolean
  payMode: string // 'due' or a payment mode
  policy: 'skip' | 'attach' | 'create'
  uniqueContact: boolean
  autoUhid: boolean
  dispatchModes: string[]
  dispatchModesB2b: string[]
  autoRateList: 'none' | 'referrer' | 'hospital' | 'corporate' | 'all'
  branchId: string
}

interface Row {
  n: number
  first_name: string
  last_name: string
  gender: string
  age_value: string
  age_unit: string
  dob: string
  country_code: string
  phone: string
  email: string
  address: string
  city: string
  pincode: string
  uhid: string
  referrer_id: string
  referrer_name: string
  b2b_id: string
  b2b_name: string
  corporate_id: string
  corporate_name: string
  corporate_user: string
  rate_list_id: string
  codes: string
  discount: string
  pay_mode: string
  paid_amount: string
  bill_date: string
  dup_of: string
  dup_no: string
}

// ---- tiny CSV reader (RFC 4180 quotes) ----------------------------------------------------------
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let cur: string[] = []
  let cell = ''
  let q = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { cur.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      cur.push(cell); cell = ''
      if (cur.some((x) => x !== '')) rows.push(cur)
      cur = []
    } else cell += c
  }
  if (cell !== '' || cur.length) { cur.push(cell); if (cur.some((x) => x !== '')) rows.push(cur) }
  const head = (rows.shift() ?? []).map((h) => h.trim())
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

// ---- helpers mirroring the web app ----------------------------------------------------------------
const toPaise = (rupees: number) => Math.round(rupees * 100)

async function nextCounter(labId: string, name: string): Promise<number> {
  const ref = db().doc(`labs/${labId}/counters/${name}`)
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref)
    const v = ((s.exists ? s.data()?.value : 0) as number) + 1
    tx.set(ref, { value: v })
    return v
  })
}
const branchCounter = (name: string, branchId: string) => (branchId === 'main' ? name : `${name}-${branchId}`)
const financialYear = (d = new Date()) => {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`
}
const shiftOf = (d = new Date()) => (d.getHours() < 14 ? 'Morning' : d.getHours() < 21 ? 'Evening' : 'Night')
const ymd = (d: Date) => `${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

function ageInDays(v: number, unit: string) {
  return unit === 'year' ? v * 365 : unit === 'month' ? v * 30 : v
}
function salutationFor(gender: string, days: number) {
  if (days < 365 * 12) return gender === 'female' ? 'Baby' : 'Master'
  if (gender === 'female') return 'Ms.'
  if (gender === 'male') return 'Mr.'
  return ''
}
// Same split as the web app: shares are proportional to line price, the remainder lands on the largest line.
function allocateDiscount(prices: number[], total: number): number[] {
  const gross = prices.reduce((s, v) => s + v, 0)
  if (gross === 0 || total <= 0) return prices.map(() => 0)
  const capped = Math.min(total, gross)
  const shares = prices.map((p) => Math.round((p * capped) / gross))
  const remainder = capped - shares.reduce((s, v) => s + v, 0)
  if (remainder !== 0) {
    let big = 0
    prices.forEach((p, i) => { if (p > prices[big]) big = i })
    shares[big] += remainder
  }
  return shares.map((v, i) => Math.max(0, Math.min(v, prices[i])))
}

interface RateList { id: string; entries?: Record<string, number>; parentId?: string; active?: boolean }
function chain(l: RateList, byId: Map<string, RateList>): RateList[] {
  const out = [l]
  const seen = new Set([l.id])
  let cur = l
  while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
    cur = byId.get(cur.parentId)!
    seen.add(cur.id)
    out.push(cur)
  }
  return out
}
function priceFor(itemId: string, mrp: number, lists: RateList[]): number {
  for (const l of lists) {
    if (l.active === false) continue
    const v = l.entries?.[itemId]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return mrp
}

interface Catalogue {
  tests: Map<string, DocumentData & { id: string }>
  packages: Map<string, DocumentData & { id: string }>
  codes: Map<string, { kind: 'test' | 'package'; id: string }>
  rateLists: Map<string, RateList>
}
async function loadCatalogue(labId: string): Promise<Catalogue> {
  const [t, p, r] = await Promise.all([
    db().collection(`labs/${labId}/tests`).get(),
    db().collection(`labs/${labId}/packages`).get(),
    db().collection(`labs/${labId}/rateLists`).get(),
  ])
  const tests = new Map<string, DocumentData & { id: string }>(t.docs.map((d) => [d.id, { ...d.data(), id: d.id }]))
  const packages = new Map<string, DocumentData & { id: string }>(p.docs.map((d) => [d.id, { ...d.data(), id: d.id }]))
  const codes = new Map<string, { kind: 'test' | 'package'; id: string }>()
  for (const x of tests.values()) codes.set(String(x.code ?? '').toLowerCase(), { kind: 'test', id: x.id })
  for (const x of packages.values()) codes.set(String(x.code ?? '').toLowerCase(), { kind: 'package', id: x.id })
  return { tests, packages, codes, rateLists: new Map(r.docs.map((d) => [d.id, { id: d.id, ...(d.data() as object) } as RateList])) }
}

// Inventory for bills the job creates: the same rule as client billing (autoConsumeForTests). With Inventory >
// consume on = "billing" the bill consumes the mapped items FEFO from its branch; with "receipt" (default) the
// sample receipt does it, except when accession is off and the lines are received straight away. Outsourced and
// billing-only tests use no stock. A shortfall is recorded as a zero-quantity movement; stock problems never fail a row.
async function consumeInventory(labId: string, lab: DocumentData, branchId: string, orderId: string, billNo: string, lines: DocumentData[], tests: Map<string, DocumentData>, byName: string, noAccession: boolean) {
  try {
    const consumeOn = (lab.inventory as DocumentData | undefined)?.consumeOn === 'billing' ? 'billing' : 'receipt'
    if (consumeOn !== 'billing' && !noAccession) return
    const counts = new Map<string, number>()
    for (const i of lines) {
      if (i.isCharge || i.onlyBilling || i.status === 'refunded') continue
      for (const tid of (i.testIds ?? []) as string[]) {
        const t = tests.get(tid)
        if (!t || t.onlyBilling === true || ((t.outsourceLabs ?? []) as unknown[]).length > 0) continue
        counts.set(tid, (counts.get(tid) ?? 0) + 1)
      }
    }
    if (!counts.size) return
    const ids = [...counts.keys()]
    const mappings: DocumentData[] = []
    for (let k = 0; k < ids.length; k += 30) {
      const snap = await db().collection(`labs/${labId}/stockMappings`).where('testId', 'in', ids.slice(k, k + 30)).get()
      snap.docs.forEach((d) => mappings.push(d.data()))
    }
    const r4 = (n: number) => Math.round(n * 10000) / 10000
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
    for (const m of mappings) {
      const qty = Number(m.qtyPerTest ?? 0) * (counts.get(String(m.testId)) ?? 1)
      if (!(qty > 0)) continue
      const batchSnap = await db().collection(`labs/${labId}/invBatches`).where('branchId', '==', branchId).where('itemId', '==', m.itemId).get()
      const cand = batchSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }) as DocumentData & { id: string })
        .filter((b) => Number(b.qtyRemaining) > 0 && String(b.expiry) >= today)
        .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))
      await db().runTransaction(async (tx) => {
        const fresh: (DocumentData & { id: string })[] = []
        for (const c of cand) {
          const sn = await tx.get(db().doc(`labs/${labId}/invBatches/${c.id}`))
          if (sn.exists) fresh.push({ id: sn.id, ...sn.data() } as DocumentData & { id: string })
        }
        let need = qty
        const base = { branchId, itemId: m.itemId, orderId, testId: String(m.testId), poId: '', by: byName, at: FieldValue.serverTimestamp(), type: 'consume_auto' }
        const reason = `Auto-consumed for bill ${billNo}`
        for (const b of fresh) {
          if (need <= 0) break
          const take = Math.min(Number(b.qtyRemaining), need)
          if (take <= 0) continue
          tx.update(db().doc(`labs/${labId}/invBatches/${b.id}`), { qtyRemaining: r4(Number(b.qtyRemaining) - take) })
          tx.set(db().collection(`labs/${labId}/stockMovements`).doc(), { ...base, batchId: b.id, qty: -r4(take), unitCost: b.unitCost ?? 0, reason, shortfall: 0 })
          need = r4(need - take)
        }
        if (need > 0) tx.set(db().collection(`labs/${labId}/stockMovements`).doc(), { ...base, batchId: '', qty: 0, unitCost: 0, reason: `Stock shortfall of ${need}: ${reason}`, shortfall: need })
      })
    }
  } catch (e) {
    console.warn('bulk inventory consumption failed', e)
  }
}

interface Result { n: number; ok: boolean; text: string; patientNo?: string; orderId?: string }

async function processRow(labId: string, importId: string, row: Row, o: Opts, cat: Catalogue, lab: DocumentData, branchPrefix: string, user: { uid: string; name: string }): Promise<Result> {
  const n = row.n
  const first = row.first_name.trim()
  // idempotency: this row of this import already created a patient
  const done = await db().collection(`labs/${labId}/patients`).where('bulkImportId', '==', importId).where('bulkRow', '==', n).limit(1).get()
  if (!done.empty) return { n, ok: true, text: `Already registered (${done.docs[0].data().patientNo})`, patientNo: done.docs[0].data().patientNo }
  if (row.dup_of && o.policy === 'skip') return { n, ok: true, text: `Skipped: already registered (${row.dup_no})` }

  const ageValue = Number(row.age_value)
  const ageUnit = row.age_unit || 'year'
  const gender = row.gender
  if (!first || !['male', 'female', 'other'].includes(gender) || !Number.isFinite(ageValue)) return { n, ok: false, text: 'Row is missing a name, gender or age' }

  if (!(row.dup_of && o.policy === 'attach') && o.uniqueContact && row.phone) {
    const same = await db().collection(`labs/${labId}/patients`).where('phone', '==', row.phone).limit(1).get()
    if (!same.empty && !row.dup_of) return { n, ok: false, text: 'Phone is already registered' }
  }

  // ---- patient
  let patientId: string
  let patient: DocumentData
  if (row.dup_of && o.policy === 'attach') {
    const snap = await db().doc(`labs/${labId}/patients/${row.dup_of}`).get()
    if (!snap.exists) return { n, ok: false, text: 'The existing patient was not found' }
    patientId = snap.id
    patient = snap.data() as DocumentData
  } else {
    if (row.uhid && !(await db().collection(`labs/${labId}/patients`).where('uhid', '==', row.uhid).limit(1).get()).empty) {
      return { n, ok: false, text: `UHID ${row.uhid} is already used by another patient` }
    }
    const day = ymd(new Date())
    const seq = await nextCounter(labId, `patient-${day}`)
    const patientNo = `${day}${String(seq).padStart(3, '0')}`
    const uhid = row.uhid || (o.autoUhid ? `UH${String(await nextCounter(labId, 'uhid')).padStart(6, '0')}` : undefined)
    const dispatch = row.b2b_id && o.dispatchModesB2b.length ? o.dispatchModesB2b : o.dispatchModes
    const data: DocumentData = {
      salutation: salutationFor(gender, ageInDays(ageValue, ageUnit)),
      firstName: first, lastName: row.last_name.trim(), gender, ageValue, ageUnit,
      ...(row.dob ? { dob: row.dob } : {}),
      countryCode: row.country_code || '+91', phone: row.phone, email: row.email,
      ...(row.address ? { address: row.address } : {}), ...(row.city ? { city: row.city } : {}), ...(row.pincode ? { pincode: row.pincode } : {}),
      ...(uhid ? { uhid } : {}),
      dispatchModes: dispatch, referrerName: row.referrer_name, ...(row.referrer_id ? { referrerId: row.referrer_id } : {}),
      ...(row.corporate_user ? { corporateUser: row.corporate_user } : {}),
      patientNo, dayNo: seq, createdBranchId: o.branchId, bulkImportId: importId, bulkRow: n,
    }
    const ref = await db().collection(`labs/${labId}/patients`).add({ ...data, createdAt: FieldValue.serverTimestamp() })
    patientId = ref.id
    patient = data
  }
  let text = `${row.dup_of && o.policy === 'attach' ? 'Attached to patient' : 'Patient'} ${patient.patientNo}`
  const result: Result = { n, ok: true, text, patientNo: patient.patientNo }

  // ---- bill
  const codes = row.codes.split(/[;|]/).map((c) => c.trim()).filter(Boolean)
  if (o.makeBills && codes.length) {
    const lists: RateList[] = []
    const pushList = (id?: string) => { const l = id ? cat.rateLists.get(id) : undefined; if (l) for (const x of chain(l, cat.rateLists)) if (!lists.some((y) => y.id === x.id)) lists.push(x) }
    pushList(row.rate_list_id)
    if (row.b2b_id) pushList((await db().doc(`labs/${labId}/b2bCentres/${row.b2b_id}`).get()).data()?.rateListId)
    if ((o.autoRateList === 'corporate' || o.autoRateList === 'all') && row.corporate_id) pushList((await db().doc(`labs/${labId}/corporateClients/${row.corporate_id}`).get()).data()?.rateListId)
    let refDoc: DocumentData | undefined
    if (row.referrer_id) {
      refDoc = (await db().doc(`labs/${labId}/referrers/${row.referrer_id}`).get()).data()
      if (o.autoRateList === 'referrer' || o.autoRateList === 'all') pushList(refDoc?.rateListId)
    }
    const items = codes.map((c) => {
      const ref = cat.codes.get(c.toLowerCase())!
      if (ref.kind === 'test') {
        const t = cat.tests.get(ref.id)!
        const price = priceFor(t.id, Number(t.price) || 0, lists)
        const billOnly = !!t.onlyBilling
        return { lineId: randomUUID(), kind: 'test', refId: t.id, code: t.code, name: t.name, price, listPrice: price, discount: 0, urgent: false, testIds: billOnly ? [] : [t.id], status: billOnly ? 'received' : 'pending', tatMinutes: t.tatMinutes ?? null, ...(billOnly ? { onlyBilling: true } : {}) } as DocumentData
      }
      const pk = cat.packages.get(ref.id)!
      const price = priceFor(pk.id, Number(pk.price) || 0, lists)
      return { lineId: randomUUID(), kind: 'package', refId: pk.id, code: pk.code, name: pk.name, price, listPrice: price, discount: 0, urgent: false, testIds: pk.testIds ?? [], status: 'pending', tatMinutes: null } as DocumentData
    })
    const shares = allocateDiscount(items.map((i) => i.price as number), toPaise(Number(row.discount) || 0))
    const billed: DocumentData[] = items.map((x, k) => ({ ...x, discount: shares[k] }))
    const gross = billed.reduce((s, x) => s + (x.price as number), 0)
    const discount = billed.reduce((s, x) => s + (x.discount as number), 0)
    const net = gross - discount
    const rowMode = row.pay_mode || (o.payMode === 'due' ? '' : o.payMode)
    const paidIn = row.paid_amount !== '' ? Math.min(toPaise(Number(row.paid_amount)), net) : rowMode ? net : 0
    const paid = rowMode && paidIn > 0 ? paidIn : 0

    const noAccession = (lab.accession as DocumentData | undefined)?.enabled === false
    const lines = noAccession ? billed.map((i) => (i.status !== 'pending' ? i : { ...i, status: 'received' })) : billed
    const billPrefix = branchPrefix || String(lab.billPrefix ?? '')
    const billNo = `${billPrefix}${await nextCounter(labId, 'bill')}`
    const barcode = String(await nextCounter(labId, branchCounter('barcode', o.branchId))).padStart(6, '0')
    const billStart = row.bill_date ? new Date(row.bill_date) : new Date()
    const backdated = billStart.getTime() < new Date().setHours(0, 0, 0, 0)
    // PRO and commission terms frozen on the bill, as the web app does
    let proId: string | undefined
    let proName: string | undefined
    let commissionSnapshot: DocumentData | undefined
    if (refDoc) {
      if (refDoc.commissionType && refDoc.commissionType !== 'none') commissionSnapshot = { type: refDoc.commissionType, value: refDoc.commissionValue ?? 0, basis: 'net', bearer: refDoc.discountBearer ?? 'referrer' }
      if (refDoc.proManagerId) {
        proId = refDoc.proManagerId
        proName = (await db().doc(`labs/${labId}/marketingTeam/${proId}`).get()).data()?.name
      }
    }
    const patientName = `${patient.salutation ?? ''} ${patient.firstName} ${patient.lastName ?? ''}`.replace(/\s+/g, ' ').trim()
    const order: DocumentData = {
      branchId: o.branchId, billNo, barcode, patientId, patientNo: patient.patientNo, patientName, gender: patient.gender,
      ageValue: patient.ageValue, ageUnit: patient.ageUnit, referrerName: row.referrer_name || 'Self',
      items: lines, gross, discount, net, paid, refunded: 0, due: Math.max(0, net - paid),
      discountReason: discount > 0 ? 'Bulk registration' : '', discountedBy: '', note: 'Bulk registration',
      reportStatus: 'pending', dispatch: ((patient.dispatchModes ?? []) as string[]).map((mode) => ({ mode, delivered: false, deliveredAt: null })), dispatched: false,
      collectedAt: noAccession ? FieldValue.serverTimestamp() : null, receivedAt: noAccession ? FieldValue.serverTimestamp() : null, reportedAt: null,
      createdAt: FieldValue.serverTimestamp(), createdBy: user.uid, createdByName: user.name, deleted: false,
      ...(row.referrer_id ? { referrerId: row.referrer_id } : {}),
      ...(row.b2b_id ? { b2bCentreId: row.b2b_id, b2bCentreName: row.b2b_name } : {}),
      ...(row.corporate_id ? { corporateClientId: row.corporate_id, corporateClientName: row.corporate_name } : {}),
      ...(patient.uhid ? { uhid: patient.uhid } : {}),
      priority: 'routine', billedTo: 'patient', source: row.b2b_id ? 'b2b' : row.corporate_id ? 'corporate' : 'walkin',
      ...(row.bill_date ? { billDate: Timestamp.fromDate(billStart) } : {}),
      ...(proId ? { proId } : {}), ...(proName ? { proName } : {}), ...(commissionSnapshot ? { commissionSnapshot } : {}),
      ...(row.corporate_user ? { corporateUser: row.corporate_user } : {}),
      ...(row.rate_list_id ? { rateListIds: [row.rate_list_id] } : {}),
      version: 1, billNoReport: billNo, billPrints: 0, revisions: [], bulkImportId: importId, bulkRow: n,
    }
    const orderRef = await db().collection(`labs/${labId}/orders`).add(order)
    if (paid > 0) {
      const receiptNo = `R${financialYear()}${String(await nextCounter(labId, `receipt-${financialYear()}`)).padStart(5, '0')}`
      await orderRef.collection('ledger').add({
        branchId: o.branchId, type: 'payment', mode: rowMode, amount: paid, reference: '', remark: '', lineIds: [], receiptNo, shift: shiftOf(),
        ...(row.bill_date || backdated ? { backdatedTo: Timestamp.fromDate(billStart) } : {}),
        postedBy: user.uid, postedByName: user.name, postedAt: FieldValue.serverTimestamp(),
      })
    }
    await consumeInventory(labId, lab, o.branchId, orderRef.id, billNo, lines, cat.tests, user.name || user.uid, noAccession)
    result.orderId = orderRef.id
    result.text = `${text} · bill ${billNo}`
    text = result.text
  }
  return result
}

// Callable: process (or resume) a bulk registration import.
export const runBulkRegistration = onCall({ region: REGION, timeoutSeconds: 3600, memory: '512MiB' }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; importId?: string }
  const caller = await core.requirePerm(request, data.labId, ['registration.create'])
  const labId = data.labId as string
  const importId = String(data.importId ?? '')
  if (!LAB_ID_RE.test(labId) || !LAB_ID_RE.test(importId)) throw new HttpsError('invalid-argument', 'labId and importId are required.')
  const ref = db().doc(`labs/${labId}/bulkImports/${importId}`)
  const snap = await ref.get()
  const job = snap.data()
  if (!job) throw new HttpsError('not-found', 'Import not found. Upload the file first.')
  if (job.by && job.by !== caller.uid) throw new HttpsError('permission-denied', 'This import belongs to another user.')
  if (job.status === 'done') return { status: 'done', processed: job.processed ?? 0, created: job.created ?? 0, skipped: job.skipped ?? 0, failed: job.failed ?? 0 }
  if (job.status === 'running' && Date.now() - Number(job.heartbeat ?? 0) < 120_000) throw new HttpsError('failed-precondition', 'This import is already running.')

  const opts = job.options as Opts
  const path = String(job.csvPath ?? '')
  if (!path.startsWith(`labs/${labId}/bulk/`)) throw new HttpsError('invalid-argument', 'The stored file path is not valid.')
  await ref.set({ status: 'running', startedAt: job.startedAt ?? FieldValue.serverTimestamp(), heartbeat: Date.now(), error: FieldValue.delete() }, { merge: true })

  try {
    const [buf] = await getBucket().file(path).download()
    const rows = parseCsv(buf.toString('utf8')).slice(0, MAX_ROWS).map((r) => ({ ...r, n: Number(r.n) })) as unknown as Row[]
    const lab = (await db().doc(`labs/${labId}`).get()).data() ?? {}
    const branchPrefix = String((await db().doc(`labs/${labId}/branches/${opts.branchId}`).get()).data()?.billPrefix ?? '').trim()
    const cat = await loadCatalogue(labId)
    let processed = Number(job.processed ?? 0)
    let created = Number(job.created ?? 0)
    let skipped = Number(job.skipped ?? 0)
    let failed = Number(job.failed ?? 0)
    await ref.set({ total: rows.length }, { merge: true })
    // resume from the cursor: whole chunks done earlier are not repeated
    for (let start = processed; start < rows.length; start += CHUNK) {
      const slice = rows.slice(start, start + CHUNK)
      const results: Result[] = []
      for (const row of slice) {
        let res: Result
        try {
          res = await processRow(labId, importId, row, opts, cat, lab, branchPrefix, { uid: caller.uid, name: caller.name })
        } catch (e) {
          res = { n: row.n, ok: false, text: (e as Error).message }
        }
        results.push(res)
        if (!res.ok) failed++
        else if (res.text.startsWith('Skipped') || res.text.startsWith('Already')) skipped++
        else created++
      }
      processed = start + slice.length
      await db().doc(`labs/${labId}/bulkImports/${importId}/results/${String(start / CHUNK).padStart(4, '0')}`).set({ from: start, rows: results })
      await ref.set({ processed, created, skipped, failed, heartbeat: Date.now() }, { merge: true })
    }
    await ref.set({ status: 'done', finishedAt: FieldValue.serverTimestamp(), processed, created, skipped, failed }, { merge: true })
    await db().collection(`labs/${labId}/activity`).add({
      type: 'bulkRegistration', text: `Bulk registration ${job.fileName ?? importId}: ${created} registered, ${skipped} skipped, ${failed} failed`, refPath: `bulkImports/${importId}`, category: 'OTHER',
      at: FieldValue.serverTimestamp(), by: caller.uid, byName: caller.name, branchId: opts.branchId,
    })
    return { status: 'done', processed, created, skipped, failed }
  } catch (e) {
    await ref.set({ status: 'failed', error: (e as Error).message, heartbeat: 0 }, { merge: true })
    throw new HttpsError('internal', `The import stopped: ${(e as Error).message}. You can resume it.`)
  }
})
