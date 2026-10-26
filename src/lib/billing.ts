import dayjs from 'dayjs'
import type { AgeUnit, LedgerEntry, LedgerType, Order, OrderItem, Paise, ReportStatus } from '../types'

// Charge lines (home collection, urgent fee...) never take part in discounts.
export const discountable = (i: Pick<OrderItem, 'isCharge'>) => !i.isCharge

// Spread a bill-level rupee discount over lines in proportion to line price, each share
// rounded to paise. Any rounding remainder goes on the largest line so the shares sum
// exactly to the total (Flabs live: 333 over 300/1000/700/550 -> 39.18/130.59/91.41/71.82).
export function allocateDiscount(items: Pick<OrderItem, 'price' | 'isCharge'>[], total: Paise): Paise[] {
  const base = items.map((i) => (discountable(i) ? i.price : 0))
  const gross = base.reduce((s, v) => s + v, 0)
  if (gross === 0 || total <= 0) return items.map(() => 0)
  const capped = Math.min(total, gross)
  const shares = base.map((p) => Math.round((p * capped) / gross))
  const remainder = capped - shares.reduce((s, v) => s + v, 0)
  if (remainder !== 0) {
    let big = 0
    base.forEach((p, idx) => {
      if (p > base[big]) big = idx
    })
    shares[big] += remainder
  }
  // never above the line price (only reachable through rounding on tiny lines)
  return shares.map((v, idx) => Math.max(0, Math.min(v, base[idx])))
}

// Bill-level percent: every line gets price x percent (rounded to paise).
export function allocatePercent(items: Pick<OrderItem, 'price' | 'isCharge'>[], pct: number): Paise[] {
  const p = Math.max(0, Math.min(100, pct))
  return items.map((i) => (discountable(i) ? Math.round((i.price * p) / 100) : 0))
}

export function discountFromPercent(gross: Paise, pct: number): Paise {
  return Math.round((gross * Math.max(0, Math.min(100, pct))) / 100)
}

// Gross of the lines a discount can apply to (charges excluded).
export function discountableGross(items: OrderItem[]): Paise {
  return items.filter((i) => i.status !== 'refunded' && discountable(i)).reduce((s, i) => s + i.price, 0)
}

// Bill-level discount percent shown on the form: sum of line discounts over the
// discountable gross, to 2 decimals.
export function derivedPercent(items: OrderItem[]): number {
  const g = discountableGross(items)
  if (g <= 0) return 0
  const d = items.filter((i) => i.status !== 'refunded' && discountable(i)).reduce((s, i) => s + i.discount, 0)
  return Math.round((d / g) * 10000) / 100
}

// Patient / bill ID shown in lists and receipts, per the "ID to display" setting.
export function displayId(
  x: { patientNo?: string; uhid?: string },
  mode: 'patientId' | 'uhid' | 'daywise' | undefined,
): string {
  const no = x.patientNo ?? ''
  if (mode === 'uhid') return x.uhid || no
  if (mode === 'daywise') return no.length >= 9 ? String(Number(no.slice(6))) : no
  return no
}

// Derived payment status for lists.
export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'partiallyRefunded' | 'refunded'
export function paymentStatus(o: Pick<Order, 'net' | 'paid' | 'due' | 'refunded'>): PaymentStatus {
  if (o.refunded > 0 && o.net === 0) return 'refunded'
  if (o.refunded > 0) return 'partiallyRefunded'
  if (o.due <= 0) return 'paid'
  return o.paid > 0 ? 'partial' : 'unpaid'
}

export interface Totals {
  gross: Paise
  discount: Paise
  net: Paise
}

// Refunded lines leave the bill totals entirely, including their discount share,
// so the remaining lines always reconcile.
export function computeTotals(items: OrderItem[]): Totals {
  const live = items.filter((i) => i.status !== 'refunded')
  const gross = live.reduce((s, i) => s + i.price, 0)
  const discount = live.reduce((s, i) => s + i.discount, 0)
  return { gross, discount, net: gross - discount }
}

// Exhaustive on purpose: adding a LedgerType fails the build until every label is set.
export const LEDGER_TYPE_LABEL: Record<LedgerType, string> = { payment: 'Payment', clearDue: 'Due cleared', refund: 'Refund', reversal: 'Reversal' }

export function ledgerSums(entries: Pick<LedgerEntry, 'type' | 'amount'>[]) {
  const paid = entries.reduce((s, e) => s + e.amount, 0)
  const refunded = -entries.filter((e) => e.type === 'refund').reduce((s, e) => s + e.amount, 0)
  return { paid, refunded }
}

// Net of refunds: what the patient still owes on the remaining lines.
export function dueAmount(net: Paise, paidAfterRefunds: Paise): Paise {
  return Math.max(0, net - paidAfterRefunds)
}

export function lineNet(item: Pick<OrderItem, 'price' | 'discount'>): Paise {
  return item.price - item.discount
}

// Report status: pending until any test is approved; partial while some are open;
// provisional when all are approved but (per setting) money is still due; final otherwise.
export function deriveReportStatus(
  order: Pick<Order, 'items' | 'due'>,
  approvedTestIds: Set<string>,
  finalRequiresPayment: boolean,
  // Flabs: rejected tests do not hold the bill back; the rest decide Final.
  rejectedTestIds: Set<string> = new Set(),
  // Tests the verifier approved as Provisional keep the bill Provisional.
  provisionalTestIds: Set<string> = new Set(),
  // Tests on hold or waiting for a re-run: with nothing approved yet they still move the bill from Pending to Partial.
  activeTestIds: Set<string> = new Set(),
): ReportStatus {
  const testIds = order.items
    .filter((i) => i.status !== 'refunded' && i.status !== 'rejected')
    .flatMap((i) => i.testIds)
    .filter((id) => !rejectedTestIds.has(id))
  if (testIds.length === 0) return 'pending'
  const approved = testIds.filter((id) => approvedTestIds.has(id)).length
  if (approved === 0) return testIds.some((id) => activeTestIds.has(id)) ? 'partial' : 'pending'
  // Any provisional test makes the bill Provisional, even while other tests are still open.
  if (testIds.some((id) => provisionalTestIds.has(id))) return 'provisional'
  if (approved < testIds.length) return 'partial'
  if (finalRequiresPayment && order.due > 0) return 'provisional'
  return 'final'
}

// A line for "other charges" (home collection, urgent fee...): billed, but no tests to run.
export function chargeLine(id: string, name: string, price: Paise, showOnBill = true): OrderItem {
  return {
    lineId: crypto.randomUUID(),
    kind: 'test',
    refId: id,
    code: 'CHG',
    name,
    price,
    discount: 0,
    urgent: false,
    testIds: [],
    status: 'pending',
    isCharge: true,
    showOnBill,
  }
}

export function catalogueLine(
  kind: 'test' | 'package',
  refId: string,
  code: string,
  name: string,
  price: Paise,
  testIds: string[],
  tatMinutes?: number | null,
  opts: { onlyBilling?: boolean; departmentId?: string } = {},
): OrderItem {
  // Billed-only services have nothing to collect or resulted: no tests, already "received".
  const billOnly = !!opts.onlyBilling
  return {
    lineId: crypto.randomUUID(),
    kind,
    refId,
    code,
    name,
    price,
    listPrice: price,
    discount: 0,
    urgent: false,
    testIds: billOnly ? [] : testIds,
    status: billOnly ? 'received' : 'pending',
    tatMinutes: tatMinutes ?? null,
    ...(billOnly ? { onlyBilling: true } : {}),
    ...(opts.departmentId ? { departmentId: opts.departmentId } : {}),
  }
}

// A test line that has moved past billing and cannot be removed from a saved bill.
export const lineLocked = (i: OrderItem): boolean =>
  !i.isCharge && !i.onlyBilling && ['collected', 'received', 'rejected', 'entered', 'approved', 'hold', 'refunded'].includes(i.status)

// Payment modes other than cash and the B2B wallet carry a transaction reference.
export const needsReference = (mode: string) => mode !== 'cash' && mode !== 'wallet'

// Back-dating (bill date or payment date before today): permission billing.backdate.
export function canBackdate(profile: { role: string; permissions?: string[] } | null): boolean {
  return !!profile && (profile.role === 'labAdmin' || (profile.permissions ?? []).includes('billing.backdate'))
}

// Kept for the refund-of-approved-line rule (managers and admins only).
export function isManagerOrAdmin(profile: { role: string } | null): boolean {
  return !!profile && ['labAdmin', 'admin', 'manager'].includes(profile.role)
}

// Age shown on a bill: from the date of birth at the bill date when known (years, else months,
// else days); otherwise the age recorded on the patient.
export function ageAt(
  dob: string | undefined,
  at: Date,
  fallback: { ageValue: number; ageUnit: AgeUnit },
): { ageValue: number; ageUnit: AgeUnit } {
  const b = dob ? dayjs(dob) : null
  if (!b || !b.isValid() || b.isAfter(at)) return { ageValue: fallback.ageValue, ageUnit: fallback.ageUnit }
  const years = dayjs(at).diff(b, 'year')
  if (years > 0) return { ageValue: years, ageUnit: 'year' }
  const months = dayjs(at).diff(b, 'month')
  if (months > 0) return { ageValue: months, ageUnit: 'month' }
  return { ageValue: Math.max(0, dayjs(at).diff(b, 'day')), ageUnit: 'day' }
}
