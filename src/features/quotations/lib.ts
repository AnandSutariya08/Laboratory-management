import { addDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import dayjs from 'dayjs'
import { branchCounterName, branchStamp } from '../../lib/activeBranch'
import { col, nextCounter } from '../../lib/db'
import { clean, logActivity } from '../../lib/orders'
import { formatINR } from '../../lib/money'
import type { LabSettings, UserProfile } from '../../types'
import type { Quotation } from './types'

export async function nextQuoNo(settings: LabSettings): Promise<string> {
  const n = await nextCounter(branchCounterName('quotation'))
  return `${settings.quotation.prefix || 'QT'}-${String(n).padStart(5, '0')}`
}

// A fresh Draft copy of a quotation (new number, new validity window, no conversion link).
export async function duplicateQuotation(q: Quotation, settings: LabSettings, user: UserProfile): Promise<string> {
  const quoNo = await nextQuoNo(settings)
  const { id: _id, ...rest } = q
  void _id
  const doc = clean({
    ...rest,
    ...branchStamp(),
    quoNo,
    status: 'draft',
    orderId: '',
    validUntil: Timestamp.fromDate(dayjs().add(settings.quotation.validityDays, 'day').endOf('day').toDate()),
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    createdByName: user.name,
  } as Record<string, unknown>)
  const ref = await addDoc(col('quotations'), doc)
  void logActivity('quotation', `Quotation ${quoNo} duplicated from ${q.quoNo}`, `quotations/${ref.id}`, { category: 'OTHER', actor: user })
  return ref.id
}

// Plain-text summary used for WhatsApp / SMS / email sharing.
export function quotationText(q: Quotation, settings: LabSettings): string {
  const lines = q.items.map((i, n) => `${n + 1}. ${i.name} - ${formatINR(i.price - i.discount)}`)
  return [
    `Quotation ${q.quoNo} from ${settings.name}`,
    `For: ${q.prospect.name}`,
    ...lines,
    `Total: ${formatINR(q.net)}`,
    `Valid until ${dayjs(q.validUntil?.toDate?.()).format('DD-MM-YYYY')}`,
  ].join('\n')
}
