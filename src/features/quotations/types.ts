import type { Timestamp } from 'firebase/firestore'
import type { AgeUnit, Gender, OrderItem, Paise } from '../../types'
import type { PartnerContext } from '../../lib/masters'

export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'expired' | 'converted' | 'cancelled'

export interface Quotation {
  id: string
  branchId?: string
  quoNo: string
  status: QuotationStatus // 'expired' is derived from validUntil, never stored
  prospect: { name: string; phone: string; email: string; gender: Gender | ''; ageValue: number | null; ageUnit: AgeUnit }
  patientId: string // set when created from a registered patient
  patientNo: string
  partners: PartnerContext
  items: OrderItem[]
  gross: Paise
  discount: Paise
  net: Paise
  discountReason: string
  notes: string
  validUntil: Timestamp
  orderId: string // set when converted
  createdAt: Timestamp
  createdBy: string
  createdByName: string
}

export const STATUS_LABEL: Record<QuotationStatus, string> = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted', expired: 'Expired', converted: 'Converted', cancelled: 'Cancelled',
}

export function effectiveStatus(q: Pick<Quotation, 'status' | 'validUntil'>): QuotationStatus {
  const until = q.validUntil?.toDate?.()
  if ((q.status === 'draft' || q.status === 'sent') && until && until.getTime() < Date.now()) return 'expired'
  return q.status
}
