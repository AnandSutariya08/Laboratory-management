import { FieldValue, getFirestore, Timestamp, type DocumentData, type QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { REGION, FIRESTORE_DB } from './secrets'
import * as core from './index'
import { getBucket } from './snapshot'

// Server side reporting for large periods.
//  - aggregateRange: sums bills and payments by day, referrer, test, department, user... for ANY date range
//    (the browser path is capped at 500 bills). Pages through Firestore, so memory stays flat.
//  - processExportJob: background CSV exports. The app writes labs/{lab}/exportJobs/{id} with status 'queued';
//    this trigger builds the CSV, stores it in Cloud Storage (labs/{lab}/exports/{id}.csv) and marks the job completed.
//    The app lists the jobs and downloads through a Storage download URL.

const db = () => getFirestore(FIRESTORE_DB)
const IST = 330 * 60_000
const DAY = 86_400_000
const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (ms: number) => {
  const d = new Date(ms + IST)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const monthKey = (ms: number) => dayKey(ms).slice(0, 7)
const ddmmyyyy = (ms: number | null) => {
  if (ms == null) return ''
  const k = dayKey(ms)
  return `${k.slice(8, 10)}-${k.slice(5, 7)}-${k.slice(0, 4)}`
}
export const ms = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : null)
export const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
export const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function dateBound(s: unknown, end: boolean): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) throw new HttpsError('invalid-argument', 'Dates must be YYYY-MM-DD.')
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST
  return end ? t + DAY : t
}

const STAFF = ['analytics.view', 'finance.view', 'patients.export']

// Branch scope: a branch id, or null for every branch the caller may see.
async function branchScope(labId: string, uid: string, requested: unknown): Promise<string | null> {
  const u = (await db().doc(`labs/${labId}/users/${uid}`).get()).data() ?? {}
  const ids: string[] = Array.isArray(u.branchIds) ? u.branchIds.map(String) : ['main']
  const all = u.allBranches === true
  if (requested === 'all') {
    if (!all) throw new HttpsError('permission-denied', 'You do not have access to all branches.')
    return null
  }
  const id = typeof requested === 'string' && requested ? requested : String(u.defaultBranchId ?? ids[0] ?? 'main')
  if (id.includes('/')) throw new HttpsError('invalid-argument', 'Invalid branchId.')
  if (!all && !ids.includes(id)) throw new HttpsError('permission-denied', 'You do not have access to that branch.')
  return id
}

const ORDER_FIELDS = [
  'billNo', 'patientId', 'patientNo', 'patientName', 'gender', 'ageValue', 'ageUnit', 'referrerName', 'hospitalName', 'secondReferrerName',
  'b2bCentreId', 'b2bCentreName', 'corporateClientName', 'collectionCentreName', 'items', 'gross', 'discount', 'net', 'paid', 'due',
  'refunded', 'reportStatus', 'dispatched', 'createdBy', 'createdByName', 'createdAt', 'branchId', 'rerunTests', 'deleted', 'referrerId',
]

export type Order = DocumentData & { id: string }

export async function scanOrders(labId: string, fromMs: number, toMs: number, branch: string | null, each: (o: Order) => void | Promise<void>): Promise<number> {
  let last: QueryDocumentSnapshot | undefined
  let count = 0
  for (;;) {
    let q = db()
      .collection(`labs/${labId}/orders`)
      .where('deleted', '==', false)
      .where('createdAt', '>=', Timestamp.fromMillis(fromMs))
      .where('createdAt', '<', Timestamp.fromMillis(toMs))
      .orderBy('createdAt')
      .select(...ORDER_FIELDS)
      .limit(1500)
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    if (snap.empty) break
    for (const d of snap.docs) {
      const o: Order = { id: d.id, ...d.data() }
      if (branch !== null && String(o.branchId || 'main') !== branch) continue
      count++
      await each(o)
    }
    last = snap.docs[snap.docs.length - 1]
    if (snap.size < 1500) break
  }
  return count
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++])
    }),
  )
}

interface Ledger { id: string; type: string; mode: string; amount: number; postedBy: string; postedByName: string; postedAt: number | null; reversesId: string; reference: string }
async function ledgerOf(labId: string, orderId: string): Promise<Ledger[]> {
  const s = await db().collection(`labs/${labId}/orders/${orderId}/ledger`).get()
  return s.docs.map((d) => {
    const x = d.data()
    return { id: d.id, type: str(x.type), mode: str(x.mode), amount: n(x.amount), postedBy: str(x.postedBy), postedByName: str(x.postedByName), postedAt: ms(x.postedAt), reversesId: str(x.reversesId), reference: str(x.reference) }
  })
}

export const bucketOfMode = (m: string) => (['cash', 'card', 'upi', 'wallet'].includes(m.toLowerCase()) ? m.toLowerCase() : 'other')
const moneyIn = (e: Ledger) => e.amount > 0 || e.type === 'reversal'
const clearedOf = (es: Ledger[]) => {
  const clr = new Set(es.filter((e) => e.type === 'clearDue').map((e) => e.id))
  return es.reduce((s, e) => s + (e.type === 'clearDue' || (e.type === 'reversal' && e.reversesId && clr.has(e.reversesId)) ? e.amount : 0), 0)
}

interface Cat { tests: Map<string, { name: string; price: number; dept: string; radiology: boolean }>; depts: Map<string, string> }
async function catalogue(labId: string): Promise<Cat> {
  const [t, d] = await Promise.all([db().collection(`labs/${labId}/tests`).get(), db().collection(`labs/${labId}/departments`).get()])
  const depts = new Map<string, string>()
  d.forEach((x) => depts.set(x.id, str(x.data().name) || x.id))
  const tests = new Map<string, { name: string; price: number; dept: string; radiology: boolean }>()
  t.forEach((x) => {
    const v = x.data()
    tests.set(x.id, { name: str(v.name) || x.id, price: n(v.price), dept: depts.get(str(v.departmentId)) ?? 'Unassigned', radiology: !!str(v.modality).trim() })
  })
  return { tests, depts }
}

type Item = { kind?: string; name?: string; price?: number; discount?: number; testIds?: string[]; status?: string; autoVerified?: boolean; outsource?: { testId: string; labName: string; cost: number }[] }
const items = (o: Order): Item[] => (Array.isArray(o.items) ? (o.items as Item[]) : [])
export const live = (o: Order) => items(o).filter((i) => i.status !== 'refunded')
export const testCount = (o: Order) => live(o).reduce((s, i) => s + (i.testIds?.length ?? 0), 0)
const kindOf = (o: Order): 'b2b' | 'referral' | 'self' => {
  if (str(o.b2bCentreName) || str(o.b2bCentreId)) return 'b2b'
  const named = (v: unknown) => {
    const x = str(v).trim().toLowerCase()
    return !!x && x !== 'self'
  }
  return named(o.referrerName) || !!o.referrerId || named(o.hospitalName) || named(o.secondReferrerName) ? 'referral' : 'self'
}
const memberShare = (i: Item, tid: string, cat: Cat) => {
  const ids = i.testIds ?? []
  if (ids.length <= 1) return 1
  const total = ids.reduce((s, id) => s + (cat.tests.get(id)?.price ?? 0), 0)
  return total <= 0 ? 1 / ids.length : (cat.tests.get(tid)?.price ?? 0) / total
}

// Pathology / radiology and department filters: keep only the bill lines with a matching test (a package stays whole
// when any member matches) and scale the bill's money to the kept lines. Returns null when nothing matches.
function narrow(o: Order, scope: string, dept: string, cat: Cat): { o: Order; ratio: number } | null {
  if (scope !== 'pathology' && scope !== 'radiology' && !dept) return null
  const keep = items(o).filter((i) => {
    if (i.status === 'refunded') return false
    return (i.testIds ?? []).some((t) => {
      const c = cat.tests.get(t)
      if (scope === 'radiology' && !c?.radiology) return false
      if (scope === 'pathology' && c?.radiology) return false
      if (dept && (c?.dept ?? 'Unassigned') !== dept) return false
      return true
    })
  })
  const gross = keep.reduce((a, i) => a + n(i.price), 0)
  const discount = keep.reduce((a, i) => a + n(i.discount), 0)
  const net = gross - discount
  const ratio = n(o.net) > 0 ? Math.min(1, net / n(o.net)) : 0
  return { o: { ...o, items: keep, gross, discount, net, paid: n(o.paid) * ratio, due: n(o.due) * ratio, refunded: n(o.refunded) * ratio }, ratio: keep.length ? ratio : -1 }
}

// ---------------------------------------------------------------- aggregateRange

interface Seg { name: string; bills: number; amount: number; discount: number; net: number; paid: number; due: number }
const newSeg = (name: string): Seg => ({ name, bills: 0, amount: 0, discount: 0, net: 0, paid: 0, due: 0 })

export const aggregateRange = onCall({ region: REGION, timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  const d = (request.data ?? {}) as { labId?: unknown; from?: unknown; to?: unknown; branchId?: unknown; scope?: unknown; dept?: unknown }
  const caller = await core.requirePerm(request, d.labId, STAFF)
  const labId = String(d.labId)
  const branch = await branchScope(labId, caller.uid, d.branchId)
  const fromMs = dateBound(d.from, false)
  const toMs = dateBound(d.to, true)
  if (toMs <= fromMs) throw new HttpsError('invalid-argument', 'The end of the range must be after its start.')
  if ((toMs - fromMs) / DAY > 1100) throw new HttpsError('invalid-argument', 'The longest range is 3 years.')

  const cat = await catalogue(labId)
  const scope = str(d.scope)
  const dept = str(d.dept)
  const orders: Order[] = []
  const ratios = new Map<string, number>()
  await scanOrders(labId, fromMs, toMs, branch, (o) => {
    const nr = narrow(o, scope, dept, cat)
    if (!nr) orders.push(o)
    else if (nr.ratio >= 0) { orders.push(nr.o); ratios.set(o.id, nr.ratio) }
  })

  const ledgers = new Map<string, Ledger[]>()
  await pool(orders, 30, async (o) => {
    const es = await ledgerOf(labId, o.id)
    const r = ratios.get(o.id)
    ledgers.set(o.id, r === undefined || r === 1 ? es : es.map((e) => ({ ...e, amount: e.amount * r })))
  })

  const z = () => ({ reg: new Set<string>(), tests: 0, billing: 0, paid: 0, due: 0, cleared: 0 })
  const all = z()
  const byKind = { b2b: z(), referral: z(), self: z() }
  const byDay = new Map<string, { bills: number; tests: number; net: number; paid: number; due: number; patients: Set<string> }>()
  const byMonth = new Map<string, { bills: number; tests: number; net: number; patients: Set<string> }>()
  const seg: Record<'referral' | 'department' | 'b2b' | 'package', Map<string, Seg>> = { referral: new Map(), department: new Map(), b2b: new Map(), package: new Map() }
  const byTest = new Map<string, { name: string; freq: number; amount: number }>()
  const testStatus: Record<string, number> = { Pending: 0, 'Re-run': 0, Rejected: 0, Hold: 0, 'Need verification': 0, 'Auto verified': 0, Complete: 0, Delivered: 0 }
  const patientStatus: Record<string, number> = { Pending: 0, Partial: 0, Provisional: 0, Completed: 0, Delivered: 0 }
  const users = new Map<string, { name: string; bills: number; tests: number; modes: Record<string, number>; paid: number; due: number; discount: number; total: number }>()
  const collUsers = new Map<string, { name: string; bills: number; tests: number; modes: Record<string, number>; paid: number; due: number; discount: number; total: number }>()
  const uget = (m: typeof users, uid: string, name: string) => {
    let r = m.get(uid)
    if (!r) { r = { name: name || uid || 'Unknown', bills: 0, tests: 0, modes: {}, paid: 0, due: 0, discount: 0, total: 0 }; m.set(uid, r) }
    return r
  }
  const segAdd = (m: Map<string, Seg>, name: string, o: Order, amount: number, discount: number, frac: number, first: boolean) => {
    const r = m.get(name) ?? newSeg(name)
    if (first) r.bills++
    r.amount += amount; r.discount += discount; r.net += amount - discount; r.paid += n(o.paid) * frac; r.due += n(o.due) * frac
    m.set(name, r)
  }
  const ledgerDay = new Map<string, { collected: number; cleared: number; refunded: number }>()
  const ledgerMode: Record<string, number> = {}
  const registrations = new Set<string>()

  for (const o of orders) {
    const es = ledgers.get(o.id) ?? []
    const clr = clearedOf(es)
    const tc = testCount(o)
    const k = kindOf(o)
    registrations.add(str(o.patientId))
    for (const g of [all, byKind[k]]) { g.reg.add(str(o.patientId)); g.tests += tc; g.billing += n(o.net); g.paid += n(o.paid); g.due += n(o.due); g.cleared += clr }
    const created = ms(o.createdAt) ?? 0
    const dk = dayKey(created)
    const dd = byDay.get(dk) ?? { bills: 0, tests: 0, net: 0, paid: 0, due: 0, patients: new Set<string>() }
    dd.bills++; dd.tests += tc; dd.net += n(o.net); dd.paid += n(o.paid); dd.due += n(o.due); dd.patients.add(str(o.patientId)); byDay.set(dk, dd)
    const mk = monthKey(created)
    const mm = byMonth.get(mk) ?? { bills: 0, tests: 0, net: 0, patients: new Set<string>() }
    mm.bills++; mm.tests += tc; mm.net += n(o.net); mm.patients.add(str(o.patientId)); byMonth.set(mk, mm)

    // status donuts
    const rerun = new Set<string>(Array.isArray(o.rerunTests) ? (o.rerunTests as string[]) : [])
    for (const i of items(o)) {
      if (i.status === 'refunded') continue
      const cnt = i.testIds?.length ?? 0
      const rr = (i.testIds ?? []).filter((t) => rerun.has(t)).length
      testStatus['Re-run'] += rr
      const rest = cnt - rr
      if (i.status === 'rejected') testStatus.Rejected += rest
      else if (i.status === 'hold') testStatus.Hold += rest
      else if (i.status === 'entered') testStatus['Need verification'] += rest
      else if (i.status === 'approved') testStatus[i.autoVerified ? 'Auto verified' : o.dispatched ? 'Delivered' : 'Complete'] += rest
      else testStatus.Pending += rest
    }
    if (o.reportStatus === 'pending') patientStatus.Pending++
    else if (o.reportStatus === 'final') patientStatus[o.dispatched ? 'Delivered' : 'Completed']++
    else if (items(o).some((i) => (i as { provisional?: boolean }).provisional)) patientStatus.Provisional++
    else patientStatus.Partial++

    // breakdown segments
    segAdd(seg.referral, str(o.referrerName) || 'Self', o, n(o.gross), n(o.discount), 1, true)
    if (str(o.b2bCentreName)) segAdd(seg.b2b, str(o.b2bCentreName), o, n(o.gross), n(o.discount), 1, true)
    const seenPkg = new Set<string>()
    const seenDept = new Set<string>()
    for (const i of live(o)) {
      const ids = i.testIds ?? []
      if (!ids.length) continue
      const lineNet = n(i.price) - n(i.discount)
      const frac = n(o.net) > 0 ? lineNet / n(o.net) : 0
      if (i.kind === 'package') { segAdd(seg.package, str(i.name), o, n(i.price), n(i.discount), frac, !seenPkg.has(str(i.name))); seenPkg.add(str(i.name)) }
      const per = new Map<string, number>()
      for (const tid of ids) { const t = cat.tests.get(tid); per.set(t?.dept ?? 'Unassigned', (per.get(t?.dept ?? 'Unassigned') ?? 0) + (t?.price ?? 0)) }
      if ([...per.values()].reduce((a, b) => a + b, 0) <= 0) { per.clear(); for (const tid of ids) { const dn = cat.tests.get(tid)?.dept ?? 'Unassigned'; per.set(dn, (per.get(dn) ?? 0) + 1) } }
      const denom = [...per.values()].reduce((a, b) => a + b, 0)
      per.forEach((cnt, dn) => { const f = cnt / denom; segAdd(seg.department, dn, o, n(i.price) * f, n(i.discount) * f, frac * f, !seenDept.has(dn)); seenDept.add(dn) })
      for (const tid of ids) {
        const name = cat.tests.get(tid)?.name ?? str(i.name)
        const r = byTest.get(name) ?? { name, freq: 0, amount: 0 }
        r.freq++; r.amount += lineNet / ids.length
        byTest.set(name, r)
      }
    }

    // user wise (billing basis)
    const ub = uget(users, str(o.createdBy), str(o.createdByName))
    ub.bills++; ub.tests += tc; ub.discount += n(o.discount); ub.total += n(o.net); ub.due += n(o.due); ub.paid += n(o.paid)
    for (const e of es) if (moneyIn(e)) ub.modes[bucketOfMode(e.mode)] = (ub.modes[bucketOfMode(e.mode)] ?? 0) + e.amount
    // user wise (collection basis)
    const seen = new Set<string>()
    for (const e of es) {
      const r = uget(collUsers, e.postedBy, e.postedByName)
      if (e.amount <= 0) {
        r.paid += e.amount; r.total += e.amount
        if (e.type === 'reversal') r.modes[bucketOfMode(e.mode)] = (r.modes[bucketOfMode(e.mode)] ?? 0) + e.amount
        continue
      }
      if (!seen.has(e.postedBy)) { r.bills++; r.tests += tc; seen.add(e.postedBy) }
      r.modes[bucketOfMode(e.mode)] = (r.modes[bucketOfMode(e.mode)] ?? 0) + e.amount
      r.paid += e.amount; r.total += e.amount
    }
    // payments by posted day
    for (const e of es) {
      if (e.postedAt == null) continue
      const x = ledgerDay.get(dayKey(e.postedAt)) ?? { collected: 0, cleared: 0, refunded: 0 }
      if (e.amount > 0) x.collected += e.amount
      if (e.type === 'clearDue') x.cleared += e.amount
      if (e.type === 'refund') x.refunded += -e.amount
      ledgerDay.set(dayKey(e.postedAt), x)
      if (moneyIn(e)) ledgerMode[bucketOfMode(e.mode)] = (ledgerMode[bucketOfMode(e.mode)] ?? 0) + e.amount
    }
  }

  const fin = (g: ReturnType<typeof z>) => ({ reg: g.reg.size, tests: g.tests, billing: g.billing, paid: g.paid, due: g.due, cleared: g.cleared })
  const segList = (m: Map<string, Seg>) => [...m.values()].sort((a, b) => b.net - a.net).slice(0, 500)
  const userList = (m: typeof users) => [...m.entries()].map(([uid, r]) => ({ uid, ...r })).sort((a, b) => b.total - a.total)
  return {
    from: dayKey(fromMs), to: dayKey(toMs - 1), bills: orders.length, asOf: Date.now(),
    kpi: { all: fin(all), by: { b2b: fin(byKind.b2b), referral: fin(byKind.referral), self: fin(byKind.self) } },
    testStatus, patientStatus,
    segments: { referral: segList(seg.referral), department: segList(seg.department), b2b: segList(seg.b2b), package: segList(seg.package) },
    topTests: [...byTest.values()].sort((a, b) => b.freq - a.freq).slice(0, 200),
    users: { billing: userList(users), collection: userList(collUsers) },
    byDay: [...byDay.entries()].sort().map(([date, v]) => ({ date, bills: v.bills, tests: v.tests, net: v.net, paid: v.paid, due: v.due, registrations: v.patients.size })),
    byMonth: [...byMonth.entries()].sort().map(([month, v]) => ({ month, bills: v.bills, tests: v.tests, net: v.net, registrations: v.patients.size })),
    ledgerByDay: [...ledgerDay.entries()].sort().map(([date, v]) => ({ date, ...v })),
    ledgerByMode: ledgerMode,
    registrations: registrations.size,
  }
})

// ---------------------------------------------------------------- export jobs

interface Row { o: Order; item?: Item; testId?: string; entry?: Ledger; frac: number }
interface Col { title: string; money?: boolean; get: (r: Row, x: Ctx) => string | number }
interface Ctx { cat: Cat; ledgers: Map<string, Ledger[]>; users: Map<string, string> }

const age = (o: Order) => `${o.ageValue}${({ year: 'Y', month: 'M', day: 'D' } as Record<string, string>)[str(o.ageUnit)] ?? ''}`
const collected = (o: Order) => n(o.paid) + n(o.refunded)
const payStatus = (o: Order) => (n(o.due) <= 0 ? 'Paid' : collected(o) - n(o.refunded) > 0 ? 'Partial' : 'Due')
const modeSum = (r: Row, x: Ctx, b: string) => {
  if (r.entry) return bucketOfMode(r.entry.mode) === b && moneyIn(r.entry) ? r.entry.amount : 0
  return (x.ledgers.get(r.o.id) ?? []).filter((e) => moneyIn(e) && bucketOfMode(e.mode) === b).reduce((s, e) => s + e.amount, 0) * r.frac
}
const share = (r: Row, v: number) => (r.testId ? v * r.frac : v)
const lineAmt = (r: Row, x: Ctx, f: 'price' | 'discount' | 'net') => {
  if (!r.item || !r.testId) return f === 'price' ? n(r.o.gross) : f === 'discount' ? n(r.o.discount) : n(r.o.net)
  const v = f === 'price' ? n(r.item.price) : f === 'discount' ? n(r.item.discount) : n(r.item.price) - n(r.item.discount)
  return v * memberShare(r.item, r.testId, x.cat)
}
const outsourceOf = (r: Row) => r.item?.outsource?.find((s) => s.testId === r.testId)

const COLS: Record<string, Col> = {
  billDate: { title: 'Bill date', get: (r) => ddmmyyyy(ms(r.o.createdAt)) },
  collectionDate: { title: 'Collection date', get: (r) => ddmmyyyy(r.entry?.postedAt ?? null) },
  billId: { title: 'Bill ID', get: (r) => str(r.o.billNo) },
  patientId: { title: 'Patient ID', get: (r) => str(r.o.patientNo) },
  patientInfo: { title: 'Patient info', get: (r) => `${str(r.o.patientName)} (${age(r.o)}/${str(r.o.gender).slice(0, 1).toUpperCase()})` },
  patientName: { title: 'Patient name', get: (r) => str(r.o.patientName) },
  age: { title: 'Age', get: (r) => age(r.o) },
  gender: { title: 'Gender', get: (r) => str(r.o.gender) },
  tests: { title: 'Tests / packages', get: (r, x) => (r.testId ? (x.cat.tests.get(r.testId)?.name ?? str(r.item?.name)) : live(r.o).map((i) => str(i.name)).join(', ')) },
  testName: { title: 'Test', get: (r, x) => (r.testId ? (x.cat.tests.get(r.testId)?.name ?? str(r.item?.name)) : str(r.item?.name)) },
  department: { title: 'Department', get: (r, x) => (r.testId ? (x.cat.tests.get(r.testId)?.dept ?? 'Unassigned') : '') },
  referral: { title: 'Referral doctor', get: (r) => str(r.o.referrerName) },
  hospitalName: { title: 'Referral hospital', get: (r) => str(r.o.hospitalName) },
  b2b: { title: 'B2B centre', get: (r) => str(r.o.b2bCentreName) },
  corporate: { title: 'Corporate client', get: (r) => str(r.o.corporateClientName) },
  collectionCentre: { title: 'Collection centre', get: (r) => str(r.o.collectionCentreName) },
  amount: { title: 'Amount', money: true, get: (r, x) => lineAmt(r, x, 'price') },
  discount: { title: 'Discount', money: true, get: (r, x) => lineAmt(r, x, 'discount') },
  net: { title: 'Net amount', money: true, get: (r, x) => lineAmt(r, x, 'net') },
  paid: { title: 'Paid', money: true, get: (r) => (r.entry ? r.entry.amount : share(r, collected(r.o) - n(r.o.refunded))) },
  due: { title: 'Due', money: true, get: (r) => (r.entry ? n(r.o.due) : share(r, n(r.o.due))) },
  refunded: { title: 'Refunded', money: true, get: (r) => share(r, n(r.o.refunded)) },
  cash: { title: 'Cash', money: true, get: (r, x) => modeSum(r, x, 'cash') },
  card: { title: 'Card', money: true, get: (r, x) => modeSum(r, x, 'card') },
  upi: { title: 'UPI', money: true, get: (r, x) => modeSum(r, x, 'upi') },
  wallet: { title: 'Wallet', money: true, get: (r, x) => modeSum(r, x, 'wallet') },
  otherMode: { title: 'Other mode', money: true, get: (r, x) => modeSum(r, x, 'other') },
  transactionId: { title: 'Transaction ID', get: (r, x) => r.entry?.reference ?? (x.ledgers.get(r.o.id) ?? []).map((e) => e.reference).filter(Boolean).join(', ') },
  entryType: { title: 'Entry type', get: (r) => r.entry?.type ?? '' },
  collectedBy: { title: 'Collected by', get: (r, x) => (r.entry ? (r.entry.postedByName || x.users.get(r.entry.postedBy) || r.entry.postedBy) : '') },
  paymentStatus: { title: 'Payment status', get: (r) => payStatus(r.o) },
  billedBy: { title: 'Billed by', get: (r, x) => str(r.o.createdByName) || x.users.get(str(r.o.createdBy)) || str(r.o.createdBy) },
  toLab: { title: 'Lab name', get: (r) => outsourceOf(r)?.labName ?? '' },
  mrp: { title: 'MRP', money: true, get: (r, x) => lineAmt(r, x, 'price') },
  outsourcePrice: { title: 'Outsource lab price', money: true, get: (r) => outsourceOf(r)?.cost ?? 0 },
  margin: { title: 'Margin', money: true, get: (r, x) => lineAmt(r, x, 'net') - (outsourceOf(r)?.cost ?? 0) },
}

const PRESET: Record<string, string[]> = {
  billing: ['patientId', 'billDate', 'billId', 'patientInfo', 'tests', 'referral', 'amount', 'discount', 'paid', 'due', 'net', 'paymentStatus'],
  collection: ['collectionDate', 'billId', 'patientInfo', 'tests', 'referral', 'amount', 'paymentStatus', 'paid', 'due', 'net', 'entryType', 'collectedBy'],
  test: ['billDate', 'billId', 'patientInfo', 'tests', 'department', 'referral', 'amount', 'discount', 'net'],
  outsource: ['billDate', 'billId', 'patientInfo', 'testName', 'toLab', 'mrp', 'outsourcePrice', 'margin'],
  fullLedger: ['billDate', 'billId', 'patientId', 'patientInfo', 'tests', 'referral', 'b2b', 'corporate', 'amount', 'discount', 'net', 'paid', 'due', 'refunded', 'cash', 'card', 'upi', 'wallet', 'otherMode', 'transactionId', 'paymentStatus', 'billedBy'],
}

interface Settings { fileName?: string; includeTotals?: boolean; delimiter?: string; includeHeader?: boolean }
interface Filters { search?: string; referral?: string; status?: string; user?: string; dept?: string; test?: string; lab?: string }

const cell = (v: unknown, d: string) => {
  const s = String(v ?? '')
  return s.includes(d) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const rs = (p: number) => (Math.round(p) / 100).toFixed(2)
const delim = (s?: string) => (s === ';' || s === '\t' || s === '|' ? s : ',')

async function buildCsv(labId: string, job: DocumentData): Promise<{ csv: string; rows: number }> {
  const kind = str(job.kind) || 'billing'
  const fromMs = n(job.from)
  const toMs = n(job.to)
  if (!fromMs || toMs <= fromMs) throw new Error('The job has no valid date range.')
  const branch = typeof job.branchId === 'string' && job.branchId && job.branchId !== 'all' ? job.branchId : null
  const base = kind === 'custom' ? str(job.base) || 'billing' : kind === 'fullLedger' ? 'billing' : kind
  if (!['billing', 'collection', 'test', 'outsource'].includes(base)) throw new Error(`Unknown export "${kind}".`)
  const keys = (Array.isArray(job.columns) && job.columns.length ? (job.columns as string[]) : PRESET[kind] ?? PRESET[base]).filter((k) => COLS[k])
  if (!keys.length) throw new Error('No exportable columns were selected.')
  const cols = keys.map((k) => COLS[k])
  const f = (job.filters ?? {}) as Filters
  const st = (job.exportSettings ?? {}) as Settings
  const d = delim(st.delimiter)

  const cat = await catalogue(labId)
  const usersSnap = await db().collection(`labs/${labId}/users`).get()
  const userNames = new Map<string, string>()
  usersSnap.forEach((u) => userNames.set(u.id, str(u.data().name)))
  const ctx: Ctx = { cat, ledgers: new Map(), users: userNames }

  const orders: Order[] = []
  const rows: Row[] = []
  if (base === 'collection') {
    // by payment date
    let q = db().collectionGroup('ledger').where('postedAt', '>=', Timestamp.fromMillis(fromMs)).where('postedAt', '<', Timestamp.fromMillis(toMs))
    const snap = await q.get()
    const byOrder = new Map<string, Ledger[]>()
    for (const e of snap.docs) {
      if (!e.ref.path.startsWith(`labs/${labId}/orders/`)) continue
      const oid = e.ref.parent.parent!.id
      const x = e.data()
      const row: Ledger = { id: e.id, type: str(x.type), mode: str(x.mode), amount: n(x.amount), postedBy: str(x.postedBy), postedByName: str(x.postedByName), postedAt: ms(x.postedAt), reversesId: str(x.reversesId), reference: str(x.reference) }
      byOrder.set(oid, [...(byOrder.get(oid) ?? []), row])
    }
    await pool([...byOrder.keys()], 30, async (oid) => {
      const s = await db().doc(`labs/${labId}/orders/${oid}`).get()
      const o = s.data()
      if (!o || o.deleted === true) return
      if (branch !== null && String(o.branchId || 'main') !== branch) return
      const ord = { id: oid, ...o }
      orders.push(ord)
      for (const e of byOrder.get(oid) ?? []) rows.push({ o: ord, entry: e, frac: 1 })
      ctx.ledgers.set(oid, byOrder.get(oid) ?? [])
    })
  } else {
    await scanOrders(labId, fromMs, toMs, branch, (o) => {
      orders.push(o)
    })
    if (keys.some((k) => ['cash', 'card', 'upi', 'wallet', 'otherMode', 'transactionId'].includes(k))) {
      await pool(orders, 30, async (o) => {
        ctx.ledgers.set(o.id, await ledgerOf(labId, o.id))
      })
    }
    for (const o of orders) {
      if (base === 'billing') rows.push({ o, frac: 1 })
      else {
        for (const i of items(o)) {
          if (i.status === 'refunded') continue
          for (const tid of i.testIds ?? []) {
            const r: Row = { o, item: i, testId: tid, frac: n(o.net) > 0 && i.testIds?.length ? ((n(i.price) - n(i.discount)) / n(o.net)) * memberShare(i, tid, cat) : 0 }
            if (base === 'outsource' && !outsourceOf(r)) continue
            rows.push(r)
          }
        }
      }
    }
  }

  const s = str(f.search).trim().toLowerCase()
  let list = rows.filter((r) => {
    if (f.referral && str(r.o.referrerName) !== f.referral) return false
    if (f.status && payStatus(r.o) !== f.status) return false
    if (f.user && str(r.o.createdBy) !== f.user) return false
    if (f.dept && (!r.testId || (cat.tests.get(r.testId)?.dept ?? 'Unassigned') !== f.dept)) return false
    if (f.test && r.testId !== f.test) return false
    if (f.lab && outsourceOf(r)?.labName !== f.lab) return false
    if (s && !`${r.o.billNo} ${r.o.patientName} ${r.o.patientNo} ${r.o.referrerName} ${r.testId ? cat.tests.get(r.testId)?.name : ''}`.toLowerCase().includes(s)) return false
    return true
  })

  const val = (c: Col, r: Row) => c.get(r, ctx)
  let table: (string | number)[][]
  const groupKey = typeof job.groupBy === 'string' && COLS[job.groupBy] ? job.groupBy : ''
  if (groupKey) {
    const g = new Map<string, (string | number)[]>()
    const cnt = new Map<string, number>()
    for (const r of list) {
      const k = String(val(COLS[groupKey], r))
      let acc = g.get(k)
      if (!acc) { acc = cols.map((c, i) => (c.money ? 0 : keys[i] === groupKey ? k : '')); g.set(k, acc) }
      cols.forEach((c, i) => { if (c.money) acc![i] = Number(acc![i]) + Number(val(c, r)) })
      cnt.set(k, (cnt.get(k) ?? 0) + 1)
    }
    table = [...g.values()]
  } else table = list.map((r) => cols.map((c) => val(c, r)))
  const sortIdx = keys.indexOf(str(job.sortBy))
  if (sortIdx >= 0) {
    const dir = job.sortDir === 'asc' ? 1 : -1
    table.sort((a, b) => (typeof a[sortIdx] === 'number' && typeof b[sortIdx] === 'number' ? (Number(a[sortIdx]) - Number(b[sortIdx])) * dir : String(a[sortIdx]).localeCompare(String(b[sortIdx])) * dir))
  }
  const out: string[] = []
  if (st.includeHeader !== false) out.push(cols.map((c) => cell(c.title, d)).join(d))
  for (const r of table) out.push(r.map((v, i) => cell(cols[i].money ? rs(Number(v)) : v, d)).join(d))
  if (st.includeTotals !== false) out.push(cols.map((c, i) => (i === 0 ? 'Total' : c.money ? rs(table.reduce((a, r) => a + Number(r[i]), 0)) : '')).map((v) => cell(v, d)).join(d))
  return { csv: '﻿' + out.join('\n'), rows: table.length }
}

export const processExportJob = onDocumentWritten(
  { document: 'labs/{labId}/exportJobs/{jobId}', database: FIRESTORE_DB, region: REGION, timeoutSeconds: 540, memory: '1GiB' },
  async (event) => {
    const after = event.data?.after
    if (!after?.exists) return
    const job = after.data() as DocumentData
    const before = event.data?.before.data() as DocumentData | undefined
    if (job.status !== 'queued' || before?.status === 'queued') return
    const { labId, jobId } = event.params
    const ref = after.ref
    const started = Date.now()
    await ref.update({ status: 'processing', startedAt: FieldValue.serverTimestamp(), error: '' })
    try {
      const { csv, rows } = await buildCsv(labId, job)
      const path = `labs/${labId}/exports/${jobId}.csv`
      await getBucket().file(path).save(csv, { contentType: 'text/csv', resumable: false })
      await ref.update({ status: 'completed', completedAt: FieldValue.serverTimestamp(), tookMs: Date.now() - started, rows, bytes: Buffer.byteLength(csv), storagePath: path })
    } catch (e) {
      await ref.update({ status: 'failed', completedAt: FieldValue.serverTimestamp(), tookMs: Date.now() - started, error: (e as Error).message.slice(0, 300) })
    }
  },
)
