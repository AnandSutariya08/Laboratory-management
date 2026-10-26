import { StatusChip, type StatusVariant } from '../../design/StatusChip'
import { paymentStatus, type PaymentStatus } from '../../lib/billing'
import type { Order } from '../../types'

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  unpaid: 'Unpaid',
  partial: 'Partly paid',
  paid: 'Paid',
  partiallyRefunded: 'Part refunded',
  refunded: 'Refunded',
}
const VARIANT: Record<PaymentStatus, StatusVariant> = {
  unpaid: 'urgent',
  partial: 'caution',
  paid: 'success',
  partiallyRefunded: 'info',
  refunded: 'neutral',
}

// Derived payment status (unpaid / partial / paid / refunded) for a bill. A bill billed to a B2B
// wallet or a TPA share counts as paid when its due is zero, so the chip follows `due`, not the cash paid.
export function PaymentStatusChip({ order }: { order: Pick<Order, 'net' | 'paid' | 'due' | 'refunded' | 'deleted'> }) {
  if (order.deleted) return null
  const st = paymentStatus(order)
  return <StatusChip variant={VARIANT[st]}>{PAYMENT_STATUS_LABEL[st]}</StatusChip>
}
