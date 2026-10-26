import { Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { z } from 'zod'
import { db } from './common'
import { GROUP_BYS, METRICS, PRESETS, type AnalyticsQuery, type AnalyticsResult, type GroupBy, type Metric } from './types'

// Read-only analytics over a lab's data, shared by the analyst tools, dashboards
// and the MCP server. Results are aggregates only: no patient names, phones or
// emails are ever selected from Firestore or returned.

export const AnalyticsQuerySchema = z
  .object({
    metric: z.enum(METRICS),
    groupBy: z.enum(GROUP_BYS).default('none'),
    range: z.union([
      z.object({ preset: z.enum(PRESETS) }).strict(),
      z.object({ from: z.string().min(8), to: z.string().min(8) }).strict(),
    ]),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()

export function parseQuery(input: unknown): AnalyticsQuery {
  const r = AnalyticsQuerySchema.safeParse(input)
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ')
    throw new HttpsError('invalid-argument', `Invalid analytics query: ${msg}`)
  }
  return r.data
}

// ---- Time (Asia/Kolkata has no DST: fixed +05:30) -----------------------------

const IST_OFFSET_MS = 330 * 60_000
const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 366
const MAX_DOCS = 50_000

const pad = (n: number) => String(n).padStart(2, '0')

function istParts(ms: number) {
  const d = new Date(ms + IST_OFFSET_MS)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() }
}
const istMidnight = (y: number, m: number, d: number) => Date.UTC(y, m, d) - IST_OFFSET_MS
const dateKey = (ms: number) => {
  const p = istParts(ms)
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`
}
export const istDate = (ms: number = Date.now()) => dateKey(ms)

export interface ResolvedRange {
  fromMs: number
  toMs: number // exclusive
  from: string // first day, YYYY-MM-DD (IST)
  to: string // last day included, YYYY-MM-DD (IST)
}

function parseBound(s: string, isEnd: boolean): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (m) {
    const ms = istMidnight(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    // A date-only end bound names the last day to include.
    return isEnd ? ms + DAY_MS : ms
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new HttpsError('invalid-argument', `Invalid date "${s}". Use YYYY-MM-DD.`)
  return t
}

export function resolveRange(range: AnalyticsQuery['range'], nowMs: number = Date.now()): ResolvedRange {
  const t = istParts(nowMs)
  const today = istMidnight(t.y, t.m, t.d)
  const tomorrow = today + DAY_MS
  let fromMs: number
  let toMs: number
  if ('preset' in range) {
    switch (range.preset) {
      case 'today':
        fromMs = today
        toMs = tomorrow
        break
      case 'yesterday':
        fromMs = today - DAY_MS
        toMs = today
        break
      case 'last7':
        fromMs = today - 6 * DAY_MS
        toMs = tomorrow
        break
      case 'last30':
        fromMs = today - 29 * DAY_MS
        toMs = tomorrow
        break
      case 'last90':
        fromMs = today - 89 * DAY_MS
        toMs = tomorrow
        break
      case 'thisMonth':
        fromMs = istMidnight(t.y, t.m, 1)
        toMs = tomorrow
        break
      case 'lastMonth':
        fromMs = istMidnight(t.y, t.m - 1, 1)
        toMs = istMidnight(t.y, t.m, 1)
        break
      case 'thisYear':
        fromMs = istMidnight(t.y, 0, 1)
        toMs = tomorrow
        break
    }
  } else {
    fromMs = parseBound(range.from, false)
    toMs = parseBound(range.to, true)
  }
  if (toMs <= fromMs) throw new HttpsError('invalid-argument', 'The end of the date range must be after its start.')
  if ((toMs - fromMs) / DAY_MS > MAX_RANGE_DAYS + 0.5) {
    throw new HttpsError('invalid-argument', `Date range too long: the maximum is ${MAX_RANGE_DAYS} days.`)
  }
  return { fromMs, toMs, from: dateKey(fromMs), to: dateKey(toMs - 1) }
}

type TimeGroup = 'day' | 'week' | 'month'
const isTimeGroup = (g: GroupBy): g is TimeGroup => g === 'day' || g === 'week' || g === 'month'

function bucketKey(ms: number, g: TimeGroup): string {
  const p = istParts(ms)
  if (g === 'day') return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`
  if (g === 'month') return `${p.y}-${pad(p.m + 1)}`
  // Weeks start on Monday; the label is the Monday's date.
  const monday = istMidnight(p.y, p.m, p.d) - ((p.dow + 6) % 7) * DAY_MS
  return dateKey(monday)
}

function allBuckets(r: ResolvedRange, g: TimeGroup): string[] {
  const out: string[] = []
  for (let ms = r.fromMs; ms < r.toMs; ms += DAY_MS) {
    const k = bucketKey(ms, g)
    if (out[out.length - 1] !== k && !out.includes(k)) out.push(k)
  }
  return out
}

// ---- Context: memoised reads, shared across the queries of one dashboard -------

interface CatalogTest {
  name: string
  code: string
  departmentId: string
  price: number
  tatMinutes: number | null
  urgentTatMinutes: number | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = { id: string; [k: string]: any }

const ORDER_FIELDS = [
  'billNo', 'patientId', 'referrerName', 'items', 'net', 'discount', 'due', 'refunded',
  'reportStatus', 'createdBy', 'createdAt', 'receivedAt', 'reportedAt', 'deleted', 'branchId',
]

export class AnalyticsContext {
  private cache = new Map<string, Promise<unknown>>()
  // branchId: restrict bills / payments / bookings to one branch; null = all branches.
  // Docs without a branchId (legacy) count as branch 'main'.
  constructor(readonly labId: string, readonly branchId: string | null = null) {}

  private inBranch(d: Record<string, unknown>): boolean {
    return this.branchId === null || String(d.branchId || 'main') === this.branchId
  }

  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined
    if (!p) {
      p = load()
      this.cache.set(key, p)
      p.catch(() => this.cache.delete(key))
    }
    return p
  }

  tests() {
    return this.memo('tests', async () => {
      const snap = await db().collection(`labs/${this.labId}/tests`).get()
      const m = new Map<string, CatalogTest>()
      snap.forEach((d) => {
        const t = d.data()
        m.set(d.id, {
          name: String(t.name ?? d.id),
          code: String(t.code ?? ''),
          departmentId: String(t.departmentId ?? ''),
          price: Number(t.price ?? 0),
          tatMinutes: typeof t.tatMinutes === 'number' ? t.tatMinutes : null,
          urgentTatMinutes: typeof t.urgentTatMinutes === 'number' ? t.urgentTatMinutes : null,
        })
      })
      return m
    })
  }

  departments() {
    return this.memo('departments', async () => {
      const snap = await db().collection(`labs/${this.labId}/departments`).get()
      const m = new Map<string, string>()
      snap.forEach((d) => m.set(d.id, String(d.data().name ?? d.id)))
      return m
    })
  }

  users() {
    return this.memo('users', async () => {
      const snap = await db().collection(`labs/${this.labId}/users`).select('name').get()
      const m = new Map<string, string>()
      snap.forEach((d) => m.set(d.id, String(d.data().name ?? d.id)))
      return m
    })
  }

  orders(r: ResolvedRange) {
    return this.memo(`orders:${this.branchId}:${r.fromMs}:${r.toMs}`, async () => {
      const snap = await db()
        .collection(`labs/${this.labId}/orders`)
        .where('deleted', '==', false)
        .where('createdAt', '>=', Timestamp.fromMillis(r.fromMs))
        .where('createdAt', '<', Timestamp.fromMillis(r.toMs))
        .select(...ORDER_FIELDS)
        .limit(MAX_DOCS + 1)
        .get()
      if (snap.size > MAX_DOCS) throw new HttpsError('failed-precondition', 'Too many bills in this range. Use a shorter date range.')
      return snap.docs.map((d): Row => ({ id: d.id, ...d.data() })).filter((o) => this.inBranch(o))
    })
  }

  ledger(r: ResolvedRange) {
    return this.memo(`ledger:${this.branchId}:${r.fromMs}:${r.toMs}`, async () => {
      const snap = await db()
        .collectionGroup('ledger')
        .where('postedAt', '>=', Timestamp.fromMillis(r.fromMs))
        .where('postedAt', '<', Timestamp.fromMillis(r.toMs))
        .select('type', 'mode', 'amount', 'postedBy', 'postedByName', 'postedAt', 'branchId')
        .limit(MAX_DOCS + 1)
        .get()
      if (snap.size > MAX_DOCS) throw new HttpsError('failed-precondition', 'Too many payments in this range. Use a shorter date range.')
      const prefix = `labs/${this.labId}/orders/`
      return snap.docs
        .filter((d) => d.ref.path.startsWith(prefix) && this.inBranch(d.data()))
        .map((d): Row => ({ id: d.id, orderId: d.ref.parent.parent!.id, ...d.data() }))
    })
  }

  bookings(r: ResolvedRange) {
    return this.memo(`bookings:${this.branchId}:${r.fromMs}:${r.toMs}`, async () => {
      const snap = await db()
        .collection(`labs/${this.labId}/bookings`)
        .where('createdAt', '>=', Timestamp.fromMillis(r.fromMs))
        .where('createdAt', '<', Timestamp.fromMillis(r.toMs))
        .select('status', 'createdAt', 'referrerName', 'createdBy', 'branchId')
        .limit(MAX_DOCS + 1)
        .get()
      if (snap.size > MAX_DOCS) throw new HttpsError('failed-precondition', 'Too many bookings in this range. Use a shorter date range.')
      return snap.docs.map((d): Row => ({ id: d.id, ...d.data() })).filter((o) => this.inBranch(o))
    })
  }

  // referrerName of the bills that ledger entries belong to.
  referrersOf(orderIds: string[]) {
    return this.memo(`referrers:${orderIds.length}:${orderIds[0] ?? ''}:${orderIds[orderIds.length - 1] ?? ''}`, async () => {
      const m = new Map<string, string>()
      const unique = [...new Set(orderIds)]
      for (let i = 0; i < unique.length; i += 300) {
        const refs = unique.slice(i, i + 300).map((id) => db().doc(`labs/${this.labId}/orders/${id}`))
        const docs = await db().getAll(...refs, { fieldMask: ['referrerName'] })
        docs.forEach((d) => m.set(d.id, String(d.data()?.referrerName ?? '')))
      }
      return m
    })
  }
}

// ---- Aggregation ----------------------------------------------------------------

interface Acc {
  sum: number
  n: number
  set: Set<string>
  within: number
  withTat: number
}
const newAcc = (): Acc => ({ sum: 0, n: 0, set: new Set(), within: 0, withTat: 0 })

class Groups {
  m = new Map<string, Acc>()
  get(k: string): Acc {
    let a = this.m.get(k)
    if (!a) {
      a = newAcc()
      this.m.set(k, a)
    }
    return a
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const rupees = (paise: number) => r2(paise / 100)
const DIRECT = 'Direct / no referrer'
const tsMs = (v: unknown): number | null => (v instanceof Timestamp ? v.toMillis() : null)

function unsupported(metric: Metric, groupBy: GroupBy, allowed: string): never {
  throw new HttpsError(
    'invalid-argument',
    `Metric "${metric}" cannot be grouped by "${groupBy}". Supported groupBy values: ${allowed}.`,
  )
}

const ORDER_GROUPS: GroupBy[] = ['none', 'day', 'week', 'month', 'referrer', 'department', 'test', 'status', 'user']

export async function runQuery(
  labId: string,
  query: AnalyticsQuery,
  ctx: AnalyticsContext = new AnalyticsContext(labId),
): Promise<AnalyticsResult> {
  const q = parseQuery(query)
  const range = resolveRange(q.range)
  const { metric, groupBy } = q
  const timeGroup = isTimeGroup(groupBy)
  const groups = new Groups()
  let total = 0
  let unit: AnalyticsResult['unit'] = 'count'
  let tatExtra = false
  let tatOverallPct: number | null = null

  const ensureBuckets = () => {
    if (timeGroup) for (const k of allBuckets(range, groupBy)) groups.get(k)
  }

  if (metric === 'collections' || metric === 'refunds') {
    unit = 'INR'
    if (!['none', 'day', 'week', 'month', 'referrer', 'paymentMode', 'status', 'user'].includes(groupBy)) {
      unsupported(metric, groupBy, 'none, day, week, month, referrer, paymentMode, status (entry type), user')
    }
    const entries = await ctx.ledger(range)
    const users = groupBy === 'user' ? await ctx.users() : new Map<string, string>()
    const refs = groupBy === 'referrer' ? await ctx.referrersOf(entries.map((e) => e.orderId as string)) : new Map<string, string>()
    ensureBuckets()
    let totalPaise = 0
    for (const e of entries) {
      if (metric === 'refunds' && e.type !== 'refund') continue
      const amount = Number(e.amount ?? 0)
      const value = metric === 'refunds' ? -amount : amount
      totalPaise += value
      const at = tsMs(e.postedAt) ?? range.fromMs
      let key: string
      if (timeGroup) key = bucketKey(at, groupBy)
      else if (groupBy === 'paymentMode') key = String(e.mode ?? 'unknown')
      else if (groupBy === 'status') key = String(e.type ?? 'unknown')
      else if (groupBy === 'user') key = users.get(String(e.postedBy)) ?? String(e.postedByName || 'Unknown user')
      else if (groupBy === 'referrer') key = refs.get(e.orderId as string) || DIRECT
      else key = 'Total'
      groups.get(key).sum += value
    }
    total = rupees(totalPaise)
  } else if (metric === 'bookings') {
    if (!['none', 'day', 'week', 'month', 'referrer', 'status', 'user'].includes(groupBy)) {
      unsupported(metric, groupBy, 'none, day, week, month, referrer, status, user')
    }
    const rows = await ctx.bookings(range)
    const users = groupBy === 'user' ? await ctx.users() : new Map<string, string>()
    ensureBuckets()
    for (const b of rows) {
      let key: string
      if (timeGroup) key = bucketKey(tsMs(b.createdAt) ?? range.fromMs, groupBy)
      else if (groupBy === 'status') key = String(b.status ?? 'unknown')
      else if (groupBy === 'referrer') key = String(b.referrerName || '') || DIRECT
      else if (groupBy === 'user') key = users.get(String(b.createdBy)) ?? 'Unknown user'
      else key = 'Total'
      groups.get(key).sum += 1
    }
    total = rows.length
  } else if (metric === 'tat') {
    if (!ORDER_GROUPS.includes(groupBy)) unsupported(metric, groupBy, ORDER_GROUPS.join(', '))
    unit = 'minutes'
    tatExtra = true
    const [orders, tests, depts, users] = await Promise.all([ctx.orders(range), ctx.tests(), ctx.departments(), ctx.users()])
    const overall = newAcc()
    for (const o of orders) {
      const rec = tsMs(o.receivedAt)
      const rep = tsMs(o.reportedAt)
      if (rec === null || rep === null || rep < rec) continue
      const minutes = (rep - rec) / 60_000
      const lines = ((o.items ?? []) as DocumentData[]).filter((i) => i.status !== 'refunded')
      const pairs: { testId: string; target: number | null }[] = []
      for (const it of lines) {
        for (const testId of (it.testIds ?? []) as string[]) {
          const t = tests.get(testId)
          const target = t ? (it.urgent && t.urgentTatMinutes ? t.urgentTatMinutes : t.tatMinutes) : null
          pairs.push({ testId, target })
        }
      }
      const withTarget = pairs.filter((p) => p.target !== null)
      const within = withTarget.filter((p) => minutes <= (p.target as number)).length
      overall.n += 1
      overall.sum += minutes
      overall.withTat += withTarget.length
      overall.within += within

      if (groupBy === 'department' || groupBy === 'test') {
        for (const p of pairs) {
          const t = tests.get(p.testId)
          const key =
            groupBy === 'test' ? (t?.name ?? p.testId) : (t && depts.get(t.departmentId)) || 'Unassigned'
          const a = groups.get(key)
          a.n += 1
          a.sum += minutes
          if (p.target !== null) {
            a.withTat += 1
            if (minutes <= p.target) a.within += 1
          }
        }
      } else {
        let key: string
        if (timeGroup) key = bucketKey(tsMs(o.createdAt) ?? rec, groupBy)
        else if (groupBy === 'referrer') key = String(o.referrerName || '') || DIRECT
        else if (groupBy === 'status') key = String(o.reportStatus ?? 'unknown')
        else if (groupBy === 'user') key = users.get(String(o.createdBy)) ?? 'Unknown user'
        else key = 'Total'
        const a = groups.get(key)
        a.n += 1
        a.sum += minutes
        a.withTat += withTarget.length
        a.within += within
      }
    }
    total = overall.n ? r2(overall.sum / overall.n) : 0
    const pct = overall.withTat ? r2((overall.within / overall.withTat) * 100) : null
    tatOverallPct = pct
  } else {
    // revenue, discounts, dues, bills, patients, tests
    if (!ORDER_GROUPS.includes(groupBy)) unsupported(metric, groupBy, ORDER_GROUPS.join(', '))
    if (metric === 'dues' && (groupBy === 'department' || groupBy === 'test')) {
      unsupported(metric, groupBy, 'none (top bills), day, week, month, referrer, status, user')
    }
    unit = metric === 'revenue' || metric === 'discounts' || metric === 'dues' ? 'INR' : 'count'
    const needCatalog = groupBy === 'department' || groupBy === 'test'
    const [orders, tests, depts, users] = await Promise.all([
      ctx.orders(range),
      needCatalog ? ctx.tests() : Promise.resolve(new Map<string, CatalogTest>()),
      needCatalog ? ctx.departments() : Promise.resolve(new Map<string, string>()),
      groupBy === 'user' ? ctx.users() : Promise.resolve(new Map<string, string>()),
    ])
    ensureBuckets()
    const allPatients = new Set<string>()
    let totalPaise = 0
    let totalCount = 0
    const topDues: { label: string; value: number }[] = []

    for (const o of orders) {
      const lines = ((o.items ?? []) as DocumentData[]).filter((i) => i.status !== 'refunded')
      const testCount = lines.reduce((s, i) => s + ((i.testIds ?? []) as string[]).length, 0)
      const patientId = String(o.patientId ?? '')
      if (metric === 'patients') allPatients.add(patientId)
      else if (metric === 'bills') totalCount += 1
      else if (metric === 'tests') totalCount += testCount
      else if (metric === 'revenue') totalPaise += Number(o.net ?? 0)
      else if (metric === 'discounts') totalPaise += Number(o.discount ?? 0)
      else if (metric === 'dues') totalPaise += Number(o.due ?? 0)

      if (groupBy === 'department' || groupBy === 'test') {
        const label = (testId: string, fallbackName: string) => {
          const t = tests.get(testId)
          if (groupBy === 'test') return t?.name ?? fallbackName
          return (t && depts.get(t.departmentId)) || 'Unassigned'
        }
        for (const it of lines) {
          const ids = ((it.testIds ?? []) as string[]).length ? ((it.testIds ?? []) as string[]) : [String(it.refId ?? '')]
          const share = 1 / ids.length
          for (const testId of ids) {
            const a = groups.get(label(testId, String(it.name ?? testId)))
            if (metric === 'revenue') a.sum += (Number(it.price ?? 0) - Number(it.discount ?? 0)) * share
            else if (metric === 'discounts') a.sum += Number(it.discount ?? 0) * share
            else if (metric === 'tests') a.sum += 1
            else if (metric === 'bills') a.set.add(o.id)
            else if (metric === 'patients') a.set.add(patientId)
          }
        }
        continue
      }

      let key: string
      if (timeGroup) key = bucketKey(tsMs(o.createdAt) ?? range.fromMs, groupBy)
      else if (groupBy === 'referrer') key = String(o.referrerName || '') || DIRECT
      else if (groupBy === 'status') key = String(o.reportStatus ?? 'unknown')
      else if (groupBy === 'user') key = users.get(String(o.createdBy)) ?? 'Unknown user'
      else key = 'Total'

      if (metric === 'dues' && groupBy === 'none') {
        if (Number(o.due ?? 0) > 0) topDues.push({ label: String(o.billNo ?? o.id), value: rupees(Number(o.due)) })
        continue
      }
      const a = groups.get(key)
      if (metric === 'revenue') a.sum += Number(o.net ?? 0)
      else if (metric === 'discounts') a.sum += Number(o.discount ?? 0)
      else if (metric === 'dues') a.sum += Number(o.due ?? 0)
      else if (metric === 'bills') a.sum += 1
      else if (metric === 'tests') a.sum += testCount
      else if (metric === 'patients') a.set.add(patientId)
    }

    if (metric === 'patients') total = allPatients.size
    else if (metric === 'bills' || metric === 'tests') total = totalCount
    else total = rupees(totalPaise)

    if (metric === 'dues' && groupBy === 'none') {
      topDues.sort((a, b) => b.value - a.value)
      const limit = Math.min(q.limit ?? 20, 100)
      return finish(q, range, unit, total, topDues.slice(0, limit).map((r) => ({ label: r.label, value: r.value })))
    }
  }

  // ---- Rows ----
  const money = unit === 'INR'
  if (groupBy === 'none' && !tatExtra && groups.m.size === 0) groups.get('Total')
  const useSet = metric === 'patients' || (metric === 'bills' && (groupBy === 'department' || groupBy === 'test'))
  const rows: AnalyticsResult['rows'] = []
  for (const [label, a] of groups.m) {
    if (tatExtra) {
      if (a.n === 0) continue
      rows.push({
        label,
        value: r2(a.sum / a.n),
        extra: { count: a.n, ...(a.withTat ? { percentWithinTat: r2((a.within / a.withTat) * 100) } : {}) },
      })
      continue
    }
    const raw = useSet ? a.set.size : a.sum
    rows.push({ label, value: money ? rupees(raw) : r2(raw) })
  }
  if (tatExtra && groupBy === 'none' && rows[0] && tatOverallPct !== null) {
    rows[0].extra = { ...rows[0].extra, percentWithinTat: tatOverallPct }
  }

  if (timeGroup) {
    rows.sort((a, b) => (a.label < b.label ? -1 : 1))
  } else {
    rows.sort((a, b) => b.value - a.value)
    rows.splice(Math.min(q.limit ?? 20, 100))
  }
  return finish(q, range, unit, total, rows)
}

function finish(
  query: AnalyticsQuery,
  range: ResolvedRange,
  unit: AnalyticsResult['unit'],
  total: number,
  rows: AnalyticsResult['rows'],
): AnalyticsResult {
  return { query, rows, total, unit, from: range.from, to: range.to }
}

// Used by get_kpis and the MCP/analyst summaries.
export async function runQueries(
  labId: string,
  queries: AnalyticsQuery[],
  branchId: string | null = null,
): Promise<PromiseSettledResult<AnalyticsResult>[]> {
  const ctx = new AnalyticsContext(labId, branchId)
  return Promise.allSettled(queries.map((q) => runQuery(labId, q, ctx)))
}
