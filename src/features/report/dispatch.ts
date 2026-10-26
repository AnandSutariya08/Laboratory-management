import type { DispatchState, Order } from '../../types'

export type DispatchStatus = 'notReady' | 'pending' | 'partial' | 'dispatched'

// Dispatch state of a bill: not ready until a report exists, partial once some (not all)
// selected modes were delivered.
export function deriveDispatchStatus(o: Pick<Order, 'reportStatus'> & { dispatch: DispatchState[] }): DispatchStatus {
  if (o.reportStatus === 'pending') return 'notReady'
  const d = o.dispatch ?? []
  if (d.length > 0 && d.every((x) => x.delivered)) return 'dispatched'
  if (d.some((x) => x.delivered)) return 'partial'
  return 'pending'
}

export const DISPATCH_STATUS_LABEL: Record<DispatchStatus, string> = {
  notReady: 'Not ready',
  pending: 'Pending dispatch',
  partial: 'Partly dispatched',
  dispatched: 'Dispatched',
}

// Pending Dispatch predicate (DP-06, spec recommendation): at least one test is released (approved, i.e. final or
// complete) and the bill has not been sent through every selected mode yet.
export function hasPendingDispatch(o: Pick<Order, 'items' | 'dispatch' | 'deleted'>): boolean {
  if (o.deleted) return false
  const d = o.dispatch ?? []
  if (d.length === 0 || d.every((x) => x.delivered)) return false
  return (o.items ?? []).some((i) => i.status === 'approved')
}
