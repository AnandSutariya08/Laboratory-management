import dayjs from 'dayjs'
import type { Timestamp } from 'firebase/firestore'
import { needsResultEntry } from '../../pages/catalogue/flags'
import type { Order, OrderItem, Test } from '../../types'

// Firestore timestamps are null for a moment after serverTimestamp() writes.
export function tsToDate(ts: Timestamp | Date | null | undefined): Date | null {
  if (!ts) return null
  if (ts instanceof Date) return ts
  return typeof ts.toDate === 'function' ? ts.toDate() : null
}

export function fmtDateTime(ts: Timestamp | Date | null | undefined): string {
  const d = tsToDate(ts)
  return d ? dayjs(d).format('DD-MMM-YYYY hh:mm A') : '-'
}

export function fmtDate(ts: Timestamp | Date | null | undefined): string {
  const d = tsToDate(ts)
  return d ? dayjs(d).format('DD MMM YYYY') : '-'
}

// Lab work items only: refunded lines and pure charges (e.g. home collection, no tests) are skipped.
export const liveItems = (o: Order): OrderItem[] =>
  o.items.filter((i) => i.status !== 'refunded' && i.testIds.length > 0)

// Items that go through accession and result entry: no refunded lines, charges or billing-only services.
export const workItemsOf = (o: Order, testById: Map<string, Test>): OrderItem[] =>
  liveItems(o).filter((i) => !i.onlyBilling && !i.testIds.every((t) => !needsResultEntry(testById.get(t))))

export const ageText = (o: Pick<Order, 'ageValue' | 'ageUnit'>) => `${o.ageValue} ${o.ageUnit}${o.ageValue === 1 ? '' : 's'}`

export const genderText = (g: string) => (g ? g.charAt(0).toUpperCase() + g.slice(1) : '')

export const ITEM_STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  collected: 'gold',
  received: 'blue',
  rejected: 'red',
  entered: 'processing',
  approved: 'green',
  hold: 'orange',
  refunded: 'default',
}

export type ChipVariant = 'neutral' | 'info' | 'success' | 'caution' | 'urgent'

export const ITEM_VARIANT: Record<string, ChipVariant> = {
  pending: 'neutral',
  collected: 'caution',
  received: 'info',
  rejected: 'urgent',
  entered: 'info',
  approved: 'success',
  hold: 'caution',
  rerun: 'caution',
  refunded: 'neutral',
  provisional: 'info',
  delivered: 'success',
  autoVerified: 'success',
}

// What a line is called on the worklist: approved lines can be Provisional or Delivered.
export const lineStatusKey = (i: OrderItem, delivered = false, rerun = false): string =>
  rerun && i.status !== 'approved' && i.status !== 'rejected' && i.status !== 'refunded'
    ? 'rerun'
    : i.status === 'approved'
    ? delivered
      ? 'delivered'
      : i.provisional
        ? 'provisional'
        : (i as { autoVerified?: boolean }).autoVerified
          ? 'autoVerified'
          : 'approved'
    : i.status

// Re-run reasons (Flabs). The remark is optional.
export const RERUN_REASONS = ['Sample contamination', 'Equipment error', 'Inconclusive result', 'Quality control failure', 'Patient request', 'Technician error', 'Other']
// Sample rejection reasons (Flabs). Labs can add their own under Settings > Reasons.
export const REJECT_REASONS = [
  'Clotted sample', 'Hemolyzed sample', 'Improper specimen collection', 'Incorrect specimen', 'Inappropriate transport conditions',
  'Insufficient information on the TRF', 'Insufficient sample', 'Leaking container', 'Lipemic sample', 'Mislabeled specimen',
]

export const ITEM_LABEL: Record<string, string> = {
  pending: 'Pending',
  collected: 'Collected',
  received: 'Received',
  rejected: 'Rejected',
  entered: 'Need Verification',
  approved: 'Completed',
  hold: 'Hold',
  rerun: 'Re Run',
  refunded: 'Refunded',
  provisional: 'Provisional',
  delivered: 'Delivered',
  autoVerified: 'Auto verified',
}

export const REPORT_VARIANT: Record<string, ChipVariant> = {
  pending: 'neutral',
  partial: 'caution',
  provisional: 'info',
  final: 'success',
}

export function downloadCsv(filename: string, rows: unknown[][]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Order of the worklist the user came from, so result entry can step Previous/Next.
export const WORKLIST_IDS_KEY = 'hcl.worklist.ids'
export function saveWorklistIds(ids: string[]) {
  try {
    sessionStorage.setItem(WORKLIST_IDS_KEY, JSON.stringify(ids))
  } catch {
    /* storage unavailable */
  }
}
export function loadWorklistIds(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(WORKLIST_IDS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
