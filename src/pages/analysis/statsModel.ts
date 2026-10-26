import type { Test } from '../../types'
import { modalityOf } from '../../features/radiology/lib'
import { liveItems, type OrderExt } from './shared'

// Shared by the Stats tab and the drill-down pages.

export type Scope = 'all' | 'pathology' | 'radiology'
export const SCOPE_OPTIONS: { value: Scope; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'pathology', label: 'Pathology' }, { value: 'radiology', label: 'Radiology' }]

export const TEST_SLICES = ['Pending', 'Re-run', 'Rejected', 'Hold', 'Need verification', 'Auto verified', 'Complete', 'Delivered'] as const
export const PATIENT_SLICES = ['Pending', 'Partial', 'Provisional', 'Completed', 'Delivered'] as const

export type NarrowedOrder = OrderExt & { ratio?: number }

// Pathology / radiology and department filters: keep only the bill lines with a matching test (a package stays whole
// when any member matches) and scale the bill's money to the kept lines.
export function narrowOrders(
  orders: OrderExt[], scope: Scope, dept: string,
  testById: Map<string, Test>, deptName: (testId: string) => string,
): NarrowedOrder[] {
  if (scope === 'all' && !dept) return orders
  const out: NarrowedOrder[] = []
  for (const o of orders) {
    const keep = o.items.filter((i) => i.status !== 'refunded' && i.testIds.some((t) => {
      const test = testById.get(t)
      const rad = !!modalityOf(test, deptName(t))
      if (scope === 'radiology' && !rad) return false
      if (scope === 'pathology' && rad) return false
      if (dept && deptName(t) !== dept) return false
      return true
    }))
    if (!keep.length) continue
    const gross = keep.reduce((s, i) => s + i.price, 0)
    const discount = keep.reduce((s, i) => s + i.discount, 0)
    const net = gross - discount
    const ratio = o.net > 0 ? Math.min(1, net / o.net) : 1
    out.push({ ...o, items: keep, gross, discount, net, paid: o.paid * ratio, due: o.due * ratio, refunded: o.refunded * ratio, ratio })
  }
  return out
}

// Test counts per status slice for one bill. Re-run: tests the bill has sent back for another run.
export function testSlices(o: OrderExt): Record<string, number> {
  const c: Record<string, number> = {}
  const add = (k: string, n: number) => { if (n > 0) c[k] = (c[k] ?? 0) + n }
  const rerun = new Set(o.rerunTests ?? [])
  for (const i of o.items) {
    if (i.status === 'refunded') continue
    const rr = i.testIds.filter((t) => rerun.has(t)).length
    add('Re-run', rr)
    const rest = i.testIds.length - rr
    const auto = !!(i as { autoVerified?: boolean }).autoVerified
    if (i.status === 'rejected') add('Rejected', rest)
    else if (i.status === 'hold') add('Hold', rest)
    else if (i.status === 'entered') add('Need verification', rest)
    else if (i.status === 'approved') add(auto ? 'Auto verified' : o.dispatched ? 'Delivered' : 'Complete', rest)
    else add('Pending', rest)
  }
  return c
}

export function patientSlice(o: OrderExt): string {
  if (o.reportStatus === 'pending') return 'Pending'
  if (o.reportStatus === 'final') return o.dispatched ? 'Delivered' : 'Completed'
  return liveItems(o).some((i) => i.provisional) ? 'Provisional' : 'Partial'
}

export const sliceCounts = (labels: readonly string[], counts: Record<string, number>) => labels.map((label) => ({ label, value: counts[label] ?? 0 }))
