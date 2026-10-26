import dayjs, { type Dayjs } from 'dayjs'
import { orderBy, query, Timestamp, where, type DocumentData, type QueryConstraint } from 'firebase/firestore'
import { col, paths } from '../../lib/db'
import type { AgeUnit, DispatchMode, PaymentMode, ReportStatus } from '../../types'

// Built-in labels; custom modes label as themselves (use modeLabel() from lib/masters for lookups).
export const MODE_LABEL: Record<string, string> = new Proxy({ cash: 'Cash', upi: 'UPI', card: 'Card', wallet: 'Wallet' } as Record<string, string>, {
  get: (t, k: string) => t[k] ?? k,
})
export const PAYMENT_MODES: PaymentMode[] = ['cash', 'upi', 'card']

export const DISPATCH_LABEL: Record<DispatchMode, string> = {
  email: 'Email',
  hardcopy: 'Hardcopy',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  manualWhatsapp: 'Manual WhatsApp',
}
export const DISPATCH_OPTIONS = (Object.keys(DISPATCH_LABEL) as DispatchMode[]).map((v) => ({
  value: v,
  label: DISPATCH_LABEL[v],
}))

export const REPORT_COLOR: Record<ReportStatus, string> = {
  pending: 'default',
  partial: 'orange',
  provisional: 'gold',
  final: 'green',
}

const UNIT: Record<AgeUnit, string> = { year: 'Y', month: 'M', day: 'D' }
export const ageText = (v: number, u: AgeUnit) => `${v}${UNIT[u]}`
export const GENDER_SHORT = { male: 'M', female: 'F', other: 'O' } as const

export const tsDate = (t: { toDate?: () => Date } | null | undefined): Date | null =>
  t && typeof t.toDate === 'function' ? t.toDate() : null

// Live orders (not voided) created inside [start, end], newest first.
// `scope` = branch constraints from useBranchScope(). Uses the (branchId) + deleted + createdAt composite index.
export function ordersInRange(start: Dayjs, end: Dayjs, scope: QueryConstraint[] = [], deleted = false) {
  return query(
    col<DocumentData>(paths.orders),
    ...scope,
    where('deleted', '==', deleted),
    where('createdAt', '>=', Timestamp.fromDate(start.startOf('day').toDate())),
    where('createdAt', '<=', Timestamp.fromDate(end.endOf('day').toDate())),
    orderBy('createdAt', 'desc'),
  )
}

// Same window on the editable bill date (the Patient List range and column use this). Bills
// saved before the bill date existed have none: query those with ordersInRange and keep the
// ones whose `billDate` is missing.
export function ordersByBillDate(start: Dayjs, end: Dayjs, scope: QueryConstraint[] = [], deleted = false) {
  return query(
    col<DocumentData>(paths.orders),
    ...scope,
    where('deleted', '==', deleted),
    where('billDate', '>=', Timestamp.fromDate(start.startOf('day').toDate())),
    where('billDate', '<=', Timestamp.fromDate(end.endOf('day').toDate())),
    orderBy('billDate', 'desc'),
  )
}

export const today = () => dayjs()

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], {
    type: 'text/csv;charset=utf-8;',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
