import { useMemo } from 'react'
import { limit, query, where, Timestamp, type DocumentData } from 'firebase/firestore'
import dayjs from 'dayjs'
import { can, type Permission } from '../auth/AuthProvider'
import { useLiveQuery } from '../hooks/useLive'
import { col, paths } from '../lib/db'
import type { Booking, Order, UserProfile } from '../types'
import type { InventoryItem, StockBatch } from '../features/inventory/types'

// Collection names of the inventory module (see features/inventory/lib/stock.ts INV).
const INV_ITEMS = 'invItems'
const INV_BATCHES = 'invBatches'

export type AlertSeverity = 'urgent' | 'caution' | 'info'

export interface LabAlert {
  key: string
  severity: AlertSeverity
  title: string
  detail: string
  count: number
  to: string
}

// Live alert counts for the notification bell. Queries are single-field and
// limited (no composite indexes); each is paused unless the user may act on it.
// Counts are "at least N" once a limit is reached.
const LIMIT = { orders: 100, bookings: 50, items: 300, batches: 600 }

export function useAlerts(profile: UserProfile | null) {
  const ok = (p: Permission) => can(profile, p)
  const canApprove = ok('results.approve')
  const canSend = ok('reports.send')
  const canStock = ok('inventory.view')
  const canBook = ok('bookings.view')

  // Orders with results entered but not yet approved.
  const approvalQ = useMemo(
    () => (canApprove ? query(col<DocumentData>(paths.orders), where('reportStatus', 'in', ['partial', 'provisional']), limit(LIMIT.orders)) : null),
    [canApprove],
  )
  // Reports that became final today and have not been dispatched.
  const todayStart = useMemo(() => Timestamp.fromDate(dayjs().startOf('day').toDate()), [])
  const finalQ = useMemo(
    () => (canSend ? query(col<DocumentData>(paths.orders), where('reportedAt', '>=', todayStart), limit(LIMIT.orders)) : null),
    [canSend, todayStart],
  )
  const itemsQ = useMemo(() => (canStock ? query(col<DocumentData>(INV_ITEMS), limit(LIMIT.items)) : null), [canStock])
  const batchesQ = useMemo(() => (canStock ? query(col<DocumentData>(INV_BATCHES), limit(LIMIT.batches)) : null), [canStock])
  const bookingsQ = useMemo(
    () => (canBook ? query(col<DocumentData>(paths.bookings), where('status', 'in', ['unmapped', 'scheduled', 'confirmed']), limit(LIMIT.bookings)) : null),
    [canBook],
  )

  const approval = useLiveQuery<Order>(approvalQ, [approvalQ])
  const finals = useLiveQuery<Order>(finalQ, [finalQ])
  const items = useLiveQuery<InventoryItem>(itemsQ, [itemsQ])
  const batches = useLiveQuery<StockBatch>(batchesQ, [batchesQ])
  const bookings = useLiveQuery<Booking>(bookingsQ, [bookingsQ])

  const loading = approval.loading || finals.loading || items.loading || batches.loading || bookings.loading

  const alerts = useMemo<LabAlert[]>(() => {
    const out: LabAlert[] = []
    const awaiting = approval.data.filter((o) => !o.deleted && o.items?.some((i) => i.status === 'entered')).length
    if (awaiting) {
      out.push({
        key: 'approval',
        severity: 'urgent',
        title: 'Results awaiting approval',
        detail: `${awaiting} bill${awaiting === 1 ? '' : 's'} with entered results need verification`,
        count: awaiting,
        to: '/worklist',
      })
    }
    const pendingDispatch = finals.data.filter((o) => !o.deleted && o.reportStatus === 'final' && !o.dispatched).length
    if (pendingDispatch) {
      out.push({
        key: 'dispatch',
        severity: 'caution',
        title: 'Reports pending dispatch today',
        detail: `${pendingDispatch} final report${pendingDispatch === 1 ? '' : 's'} not yet sent`,
        count: pendingDispatch,
        to: '/patients',
      })
    }
    const stock = new Map<string, number>()
    for (const b of batches.data) stock.set(b.itemId, (stock.get(b.itemId) ?? 0) + (b.qtyRemaining ?? 0))
    const low = items.data.filter((i) => i.active && i.reorderLevel > 0 && (stock.get(i.id) ?? 0) <= i.reorderLevel).length
    if (low) {
      out.push({
        key: 'stock',
        severity: 'caution',
        title: 'Low stock',
        detail: `${low} item${low === 1 ? ' is' : 's are'} at or below the reorder level`,
        count: low,
        to: '/inventory/stock',
      })
    }
    const unassigned = bookings.data.filter((b) => b.type === 'homeCollection' && !b.assignedTo).length
    if (unassigned) {
      out.push({
        key: 'bookings',
        severity: 'info',
        title: 'Unassigned bookings',
        detail: `${unassigned} home collection${unassigned === 1 ? '' : 's'} need a phlebotomist`,
        count: unassigned,
        to: '/bookings',
      })
    }
    return out
  }, [approval.data, finals.data, items.data, batches.data, bookings.data])

  return { alerts, total: alerts.reduce((n, a) => n + a.count, 0), loading }
}
