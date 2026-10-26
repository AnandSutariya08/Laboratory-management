import type { Department, LabSettings, Order, OrderItem, Test, TestResult } from '../../types'

// One TAT row per (bill line, test). Shared by the TAT Analysis page and the NABL TAT / urgent logs
// so both always agree.

export type TatStatus = 'within' | 'nearby' | 'out'
export type ClockStart = 'registration' | 'collection' | 'receipt'

export interface TatRow {
  key: string
  orderId: string
  testId: string
  at: number // bill created (ms)
  patient: string
  patientNo: string
  billNo: string
  test: string
  dept: string
  urgent: boolean
  urgentRemark: string
  urgentBy: string // who marked the bill urgent (the biller)
  preAnalytical: number // minutes of the total allowance spent before receipt (from the test editor)
  heldMin: number // minutes the test was on hold, taken off the actual time
  done: boolean
  expected: number // minutes allowed (always set: tests with no TAT are excluded)
  actual: number // minutes elapsed (to approval when done, else to now)
  status: TatStatus
  reason: string
  start: number // clock start (ms)
  end: number | null // approval time (ms) when done
}

export interface TatCtx {
  settings: LabSettings
  testById: Map<string, Test>
  departmentById: Map<string, Department>
  now: number
}

type Ts = { toMillis?: () => number } | null | undefined
export const ms = (t: unknown): number | null => {
  const x = t as Ts
  return x && typeof x.toMillis === 'function' ? x.toMillis() : null
}

// Clock start: sample receipt when accession is enabled, else registration. The lab can still pick
// "collection" explicitly. (A stored 'receipt' choice is honoured too.)
export function effectiveClockStart(settings: LabSettings): ClockStart {
  const picked = settings.tat?.clockStart
  if (picked === 'collection') return 'collection'
  if (picked === 'receipt') return 'receipt'
  return settings.accession?.enabled === false ? 'registration' : 'receipt'
}

// Approval time of a result: the stamped approvedAt, else the last write.
// An auto-verified result counts as approved (it carries autoVerified and its own timestamp).
export const approvedAtOf = (r: TestResult | undefined): number | null => {
  if (!r) return null
  const x = r as TestResult & { approvedAt?: unknown; autoVerified?: boolean; autoVerifiedAt?: unknown }
  if (r.status !== 'approved' && !x.autoVerified) return null
  return ms(x.approvedAt) ?? ms(x.autoVerifiedAt) ?? ms(r.updatedAt)
}

// Pre-analytical allowance (test editor). It is part of the total TAT, so when the clock starts at
// sample receipt that part has already been spent before the clock starts.
export const preAnalyticalOf = (t: Test | undefined): number => Math.max(0, (t as (Test & { preAnalyticalTatMinutes?: number | null }) | undefined)?.preAnalyticalTatMinutes ?? 0)

export function expectedMinutes(t: Test | undefined, it: OrderItem, urgentPct: number): number | null {
  const base = t?.tatMinutes ?? null
  if (!it.urgent) return base
  return t?.urgentTatMinutes ?? (base != null ? Math.round((base * urgentPct) / 100) : null)
}

export function buildTatRows(orders: (Order & { tatReasons?: Record<string, { reason: string }>; urgentRemark?: string })[], results: Record<string, TestResult[]>, ctx: TatCtx): TatRow[] {
  const clock = effectiveClockStart(ctx.settings)
  const nearbyPct = ctx.settings.tat?.nearbyThresholdPercent ?? 80
  const urgentPct = ctx.settings.tat?.urgentTatPercent ?? 50
  const out: TatRow[] = []
  for (const o of orders) {
    const created = ms(o.createdAt)
    const start = clock === 'registration' ? created : clock === 'collection' ? (ms(o.collectedAt) ?? created) : ms(o.receivedAt)
    // Clock not started (sample not received yet): not part of TAT yet.
    if (start == null) continue
    for (const it of o.items) {
      if (it.status === 'refunded' || it.status === 'rejected' || it.isCharge || !it.testIds.length) continue
      for (const tid of it.testIds) {
        const t = ctx.testById.get(tid)
        const total = expectedMinutes(t, it, urgentPct)
        if (total == null || total <= 0) continue // no TAT configured: excluded
        const pre = clock === 'receipt' ? Math.min(preAnalyticalOf(t), Math.max(0, total - 1)) : 0
        const expected = total - pre
        const r = (results[o.id] ?? []).find((x) => x.testId === tid)
        if ((r as { status?: string } | undefined)?.status === 'rejected') continue
        const end = approvedAtOf(r)
        const done = end != null
        const heldMin = Math.round(((r as { holdTotalMs?: number } | undefined)?.holdTotalMs ?? 0) / 60000)
        const actual = Math.max(0, Math.round(((end ?? ctx.now) - start) / 60000) - heldMin)
        const status: TatStatus = actual > expected ? 'out' : !done && actual >= (expected * nearbyPct) / 100 ? 'nearby' : 'within'
        out.push({
          key: `${o.id}:${it.lineId}:${tid}`,
          orderId: o.id,
          testId: tid,
          at: created ?? 0,
          patient: o.patientName,
          patientNo: o.patientNo,
          billNo: o.billNo,
          test: t?.name ?? it.name,
          dept: ctx.departmentById.get(t?.departmentId ?? '')?.name ?? 'Unassigned',
          urgent: it.urgent,
          urgentRemark: o.urgentRemark ?? '',
          urgentBy: (o as { urgentMarkedByName?: string }).urgentMarkedByName ?? o.createdByName ?? '',
          preAnalytical: pre,
          heldMin,
          done,
          expected,
          actual,
          status,
          reason: o.tatReasons?.[tid]?.reason ?? '',
          start,
          end,
        })
      }
    }
  }
  return out.sort((a, b) => b.at - a.at)
}
