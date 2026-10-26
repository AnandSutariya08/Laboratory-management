import { Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { AnalyticsContext, resolveRange, runQuery } from './analytics'
import { db } from './common'
import type { AnalyticsQuery, AnalyticsResult } from './types'
import { maskTo } from '../mask'

// Read-only data tools shared by the analyst chat and the MCP server. Everything here is aggregate
// or masked: no full patient name, phone or email is ever returned.

const r2 = (n: number) => Math.round(n * 100) / 100
const rupees = (paise: number) => r2(Number(paise || 0) / 100)
const tsIso = (v: unknown): string => (v instanceof Timestamp ? new Date(v.toMillis() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ') : '')

export const initialsOf = (name: string): string => {
  const parts = String(name ?? '').replace(/[^\p{L}\s.]/gu, ' ').split(/[\s.]+/).filter(Boolean)
  if (!parts.length) return '?'
  return parts.slice(0, 3).map((p) => p[0].toUpperCase()).join('.') + '.'
}
const ageLabel = (v: unknown, u: unknown) => (v === undefined || v === null || v === '' ? '' : `${Number(v)} ${String(u ?? 'year')}${Number(v) === 1 ? '' : 's'}`)

export type Range = AnalyticsQuery['range']

// ---- Ranking and comparison --------------------------------------------------

export async function listTopN(
  labId: string,
  ctx: AnalyticsContext,
  a: { metric: AnalyticsQuery['metric']; groupBy: AnalyticsQuery['groupBy']; range: Range; n?: number; order?: 'desc' | 'asc' },
): Promise<AnalyticsResult> {
  const n = Math.min(Math.max(a.n ?? 10, 1), 100)
  const full = await runQuery(labId, { metric: a.metric, groupBy: a.groupBy, range: a.range, limit: 500 }, ctx)
  const rows = [...full.rows].sort((x, y) => (a.order === 'asc' ? x.value - y.value : y.value - x.value)).slice(0, n)
  return { ...full, query: { ...full.query, limit: n }, rows }
}

export async function comparePeriods(
  labId: string,
  ctx: AnalyticsContext,
  a: { metric: AnalyticsQuery['metric']; groupBy: AnalyticsQuery['groupBy']; rangeA: Range; rangeB: Range; limit?: number },
) {
  const limit = Math.min(Math.max(a.limit ?? 20, 1), 100)
  const [ra, rb] = await Promise.all([
    runQuery(labId, { metric: a.metric, groupBy: a.groupBy, range: a.rangeA, limit: 500 }, ctx),
    runQuery(labId, { metric: a.metric, groupBy: a.groupBy, range: a.rangeB, limit: 500 }, ctx),
  ])
  const pct = (cur: number, prev: number) => (prev ? r2(((cur - prev) / Math.abs(prev)) * 100) : null)
  const mb = new Map(rb.rows.map((r) => [r.label, r.value]))
  const ma = new Map(ra.rows.map((r) => [r.label, r.value]))
  const labels = [...new Set([...ra.rows.map((r) => r.label), ...rb.rows.map((r) => r.label)])]
  const rows = labels
    .map((label) => {
      const x = ma.get(label) ?? 0
      const y = mb.get(label) ?? 0
      return { label, periodA: x, periodB: y, change: r2(x - y), changePct: pct(x, y) }
    })
    .sort((p, q) => Math.max(q.periodA, q.periodB) - Math.max(p.periodA, p.periodB))
    .slice(0, limit)
  return {
    unit: ra.unit,
    periodA: { from: ra.from, to: ra.to, total: ra.total },
    periodB: { from: rb.from, to: rb.to, total: rb.total },
    change: r2(ra.total - rb.total),
    changePct: pct(ra.total, rb.total),
    rowCount: rows.length,
    rows,
    results: [ra, rb],
  }
}

// ---- Bills ---------------------------------------------------------------------

const BILL_FIELDS = ['billNo', 'patientName', 'gender', 'ageValue', 'ageUnit', 'referrerName', 'items', 'gross', 'discount', 'net', 'paid', 'refunded', 'due', 'reportStatus', 'createdAt', 'deleted', 'branchId']

async function billDocs(labId: string, ctx: AnalyticsContext, range: Range): Promise<(DocumentData & { id: string })[]> {
  const r = resolveRange(range)
  const snap = await db()
    .collection(`labs/${labId}/orders`)
    .where('deleted', '==', false)
    .where('createdAt', '>=', Timestamp.fromMillis(r.fromMs))
    .where('createdAt', '<', Timestamp.fromMillis(r.toMs))
    .select(...BILL_FIELDS)
    .limit(20_001)
    .get()
  if (snap.size > 20_000) throw new HttpsError('failed-precondition', 'Too many bills in this range. Use a shorter date range.')
  return snap.docs
    .map((d): DocumentData & { id: string } => ({ id: d.id, ...d.data() }))
    .filter((o) => ctx.branchId === null || String(o.branchId || 'main') === ctx.branchId)
}

function billRow(o: DocumentData, withPatient: boolean) {
  const items = ((o.items ?? []) as DocumentData[]).filter((i) => i.status !== 'refunded' && !i.isCharge)
  return {
    billNo: String(o.billNo ?? ''),
    date: tsIso(o.createdAt),
    ...(withPatient ? { patient: { initials: initialsOf(String(o.patientName ?? '')), age: ageLabel(o.ageValue, o.ageUnit), gender: String(o.gender ?? '') } } : {}),
    referrer: String(o.referrerName ?? '') || 'Direct',
    tests: items.length,
    netInr: rupees(o.net),
    paidInr: rupees(o.paid),
    dueInr: rupees(o.due),
    refundedInr: rupees(o.refunded),
    reportStatus: String(o.reportStatus ?? ''),
  }
}

export async function getBillStats(labId: string, ctx: AnalyticsContext, range: Range) {
  const bills = await billDocs(labId, ctx, range)
  const r = resolveRange(range)
  let net = 0
  let due = 0
  let discount = 0
  let withDue = 0
  const byStatus: Record<string, number> = {}
  for (const b of bills) {
    net += Number(b.net ?? 0)
    due += Number(b.due ?? 0)
    discount += Number(b.discount ?? 0)
    if (Number(b.due ?? 0) > 0) withDue++
    const s = String(b.reportStatus ?? 'unknown')
    byStatus[s] = (byStatus[s] ?? 0) + 1
  }
  return {
    from: r.from,
    to: r.to,
    bills: bills.length,
    netInr: rupees(net),
    averageBillInr: bills.length ? r2(rupees(net) / bills.length) : 0,
    dueInr: rupees(due),
    billsWithDue: withDue,
    discountInr: rupees(discount),
    byReportStatus: byStatus,
  }
}

export async function listBills(
  labId: string,
  ctx: AnalyticsContext,
  a: { range: Range; reportStatus?: string; dueOnly?: boolean; limit: number; withPatient: boolean; sortByDue?: boolean },
) {
  let bills = await billDocs(labId, ctx, a.range)
  if (a.reportStatus) bills = bills.filter((b) => String(b.reportStatus) === a.reportStatus)
  if (a.dueOnly) bills = bills.filter((b) => Number(b.due ?? 0) > 0)
  bills.sort((x, y) => (a.sortByDue ? Number(y.due ?? 0) - Number(x.due ?? 0) : (y.createdAt?.toMillis?.() ?? 0) - (x.createdAt?.toMillis?.() ?? 0)))
  const limit = Math.max(1, a.limit)
  return { count: bills.length, truncated: bills.length > limit, bills: bills.slice(0, limit).map((b) => billRow(b, a.withPatient)) }
}

export async function getBill(labId: string, ctx: AnalyticsContext, billNo: string, withPatient: boolean) {
  const snap = await db().collection(`labs/${labId}/orders`).where('billNo', '==', billNo).limit(5).get()
  const doc = snap.docs.find((d) => d.data().deleted !== true && (ctx.branchId === null || String(d.data().branchId || 'main') === ctx.branchId))
  if (!doc) throw new HttpsError('not-found', `No bill found with number "${billNo}".`)
  const o = doc.data()
  return {
    ...billRow(o, withPatient),
    grossInr: rupees(o.gross),
    discountInr: rupees(o.discount),
    items: ((o.items ?? []) as DocumentData[]).map((i) => ({ name: String(i.name ?? ''), code: String(i.code ?? ''), kind: String(i.kind ?? ''), priceInr: rupees(i.price), status: String(i.status ?? '') })),
  }
}

export async function billPayments(labId: string, ctx: AnalyticsContext, billNo: string) {
  const snap = await db().collection(`labs/${labId}/orders`).where('billNo', '==', billNo).limit(5).get()
  const doc = snap.docs.find((d) => d.data().deleted !== true && (ctx.branchId === null || String(d.data().branchId || 'main') === ctx.branchId))
  if (!doc) throw new HttpsError('not-found', `No bill found with number "${billNo}".`)
  const led = await doc.ref.collection('ledger').orderBy('postedAt').get()
  return {
    billNo,
    netInr: rupees(doc.data().net),
    dueInr: rupees(doc.data().due),
    payments: led.docs.map((d) => {
      const e = d.data()
      return { type: String(e.type ?? ''), mode: String(e.mode ?? ''), amountInr: rupees(e.amount), date: tsIso(e.postedAt), receiptNo: String(e.receiptNo ?? ''), reference: String(e.reference ?? '') }
    }),
  }
}

// ---- QC, tests, bookings, patients ------------------------------------------------

export async function qcSummary(labId: string, days: number, branchId: string | null) {
  const from = Timestamp.fromMillis(Date.now() - days * 86_400_000)
  const snap = await db().collection(`labs/${labId}/qcRuns`).where('runAt', '>=', from).get()
  const byMachine = new Map<string, { machine: string; runs: number; pass: number; warning: number; fail: number }>()
  for (const d of snap.docs) {
    const r = d.data()
    if (r.deleted === true) continue
    if (branchId && String(r.branchId ?? 'main') !== branchId) continue
    const key = String(r.machineName ?? r.machineId ?? 'Unknown')
    const m = byMachine.get(key) ?? { machine: key, runs: 0, pass: 0, warning: 0, fail: 0 }
    m.runs++
    if (r.status === 'pass') m.pass++
    else if (r.status === 'warning') m.warning++
    else if (r.status === 'fail') m.fail++
    byMachine.set(key, m)
  }
  const machines = [...byMachine.values()].map((m) => ({ ...m, passRatePct: m.runs ? Math.round((m.pass / m.runs) * 1000) / 10 : null })).sort((a, b) => b.runs - a.runs)
  return { days, machines }
}

export async function catalogueLookup(labId: string, ctx: AnalyticsContext, a: { search?: string; department?: string; limit: number }) {
  const snap = await db().collection(`labs/${labId}/tests`).get()
  const depts = await ctx.departments()
  const s = a.search?.trim().toLowerCase()
  const dep = a.department?.trim().toLowerCase()
  const rows = snap.docs
    .map((d) => d.data())
    .filter((t) => t.disabled !== true && t.deleted !== true)
    .map((t) => ({ code: String(t.code ?? ''), name: String(t.name ?? ''), department: depts.get(String(t.departmentId)) ?? '', priceInr: rupees(t.price) }))
    .filter((t) => (!s || t.code.toLowerCase().includes(s) || t.name.toLowerCase().includes(s)) && (!dep || t.department.toLowerCase() === dep))
    .sort((x, y) => x.name.localeCompare(y.name))
  return { count: rows.length, tests: rows.slice(0, a.limit) }
}

export async function bookingsSummary(labId: string, ctx: AnalyticsContext, range: Range) {
  const [byStatus, byReferrer, byDay] = await Promise.all([
    runQuery(labId, { metric: 'bookings', groupBy: 'status', range }, ctx),
    runQuery(labId, { metric: 'bookings', groupBy: 'referrer', range, limit: 5 }, ctx),
    runQuery(labId, { metric: 'bookings', groupBy: 'day', range }, ctx),
  ])
  return {
    from: byStatus.from,
    to: byStatus.to,
    total: byStatus.total,
    byStatus: byStatus.rows.map((r) => ({ status: r.label, count: r.value })),
    topReferrers: byReferrer.rows.map((r) => ({ referrer: r.label, count: r.value })),
    busiestDays: [...byDay.rows].sort((a, b) => b.value - a.value).slice(0, 5).map((r) => ({ day: r.label, count: r.value })),
    results: [byStatus, byDay],
  }
}

export async function listPatientsMasked(labId: string, a: { limit: number }) {
  const snap = await db()
    .collection(`labs/${labId}/patients`)
    .orderBy('createdAt', 'desc')
    .select('firstName', 'lastName', 'gender', 'ageValue', 'ageUnit', 'phone', 'createdAt')
    .limit(Math.min(Math.max(a.limit, 1), 200))
    .get()
  return {
    patients: snap.docs.map((d) => {
      const p = d.data()
      return {
        initials: initialsOf(`${p.firstName ?? ''} ${p.lastName ?? ''}`),
        age: ageLabel(p.ageValue, p.ageUnit),
        gender: String(p.gender ?? ''),
        phoneMasked: maskTo(String(p.phone ?? '')),
        registered: tsIso(p.createdAt).slice(0, 10),
      }
    }),
  }
}

export async function patientDemographics(labId: string, range: Range) {
  const r = resolveRange(range)
  const snap = await db()
    .collection(`labs/${labId}/patients`)
    .where('createdAt', '>=', Timestamp.fromMillis(r.fromMs))
    .where('createdAt', '<', Timestamp.fromMillis(r.toMs))
    .select('gender', 'ageValue', 'ageUnit')
    .limit(20_001)
    .get()
  const gender: Record<string, number> = {}
  const bands: Record<string, number> = { 'under 1': 0, '1-12': 0, '13-30': 0, '31-50': 0, '51-70': 0, '71+': 0, unknown: 0 }
  for (const d of snap.docs) {
    const p = d.data()
    const g = String(p.gender || 'unknown')
    gender[g] = (gender[g] ?? 0) + 1
    const unit = String(p.ageUnit ?? 'year')
    let years = Number(p.ageValue)
    if (!Number.isFinite(years)) {
      bands.unknown++
      continue
    }
    if (unit === 'month') years /= 12
    else if (unit === 'day') years /= 365
    const k = years < 1 ? 'under 1' : years <= 12 ? '1-12' : years <= 30 ? '13-30' : years <= 50 ? '31-50' : years <= 70 ? '51-70' : '71+'
    bands[k]++
  }
  return { from: r.from, to: r.to, newPatients: snap.size, byGender: gender, byAgeBand: bands }
}
