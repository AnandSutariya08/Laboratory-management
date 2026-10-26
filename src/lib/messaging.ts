import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../firebase'
import type { Channel } from '../types'

// Contract shared by the web app and the Cloud Functions in /functions.
// Provider credentials live only on the server (Secret Manager).

export interface SendResult {
  channel: Channel
  to: string
  status: 'sent' | 'failed' | 'logged' // logged = provider not configured (dev mode)
  error?: string
  link?: string
}

// Who receives the report: the patient, the referring doctor, or the bill's B2B centre / collection centre / corporate client.
export type ReportRecipient = 'patient' | 'doctor' | 'b2b' | 'centre' | 'corporate'

export interface SendReportInput {
  labId: string
  orderId: string
  channels: Channel[]
  // Optional overrides; default to the patient's phone / email on the bill.
  phone?: string
  email?: string
  recipient?: ReportRecipient
  withLetterhead?: boolean
  letterheadId?: string // a letterhead from the Lab profile library
  testIds?: string[]
  smart?: boolean
  // Send again even if the same channel got this report within the last hour.
  allowDuplicate?: boolean
}

export interface SendBookingInput {
  labId: string
  bookingId: string
  event: 'bookingConfirmed' | 'collectorAssigned'
  channels: Channel[]
}

export interface PublicReportInput {
  token: string
  // Second factor typed by the patient. Omitted => status view only.
  verify?: string
  otp?: string // one-time code delivered by requestReportOtp
  pin?: string // PIN printed on the bill
  portal?: string // patient portal session
}

const call = <I, O>(name: string) => httpsCallable<I, O>(functions, name)

export const sendReport = (input: Omit<SendReportInput, 'labId'>) =>
  call<SendReportInput, { results: SendResult[]; duplicates: Channel[] }>('sendReport')({ ...input, labId: LAB_ID }).then((r) => r.data)

export const createReportShare = (orderId: string) =>
  call<{ labId: string; orderId: string }, { token: string }>('createReportShare')({ labId: LAB_ID, orderId }).then((r) => r.data.token)

export const revokeReportShare = (orderId: string) =>
  call<{ labId: string; orderId: string }, { revoked: number }>('revokeReportShare')({ labId: LAB_ID, orderId }).then((r) => r.data)

export const retryReportDelivery = (orderId: string, deliveryId: string) =>
  call<{ labId: string; orderId: string; deliveryId: string }, { result: SendResult }>('retryReportDelivery')({ labId: LAB_ID, orderId, deliveryId }).then((r) => r.data.result)

export const sendBookingMessage = (input: Omit<SendBookingInput, 'labId'>) =>
  call<SendBookingInput, { results: SendResult[] }>('sendBookingMessage')({ ...input, labId: LAB_ID }).then(
    (r) => r.data,
  )

// Quotation send: provider when configured, dev outbox otherwise. A Draft becomes Sent on the server.
export const sendQuotation = (quotationId: string, channels: Channel[]) =>
  call<{ labId: string; quotationId: string; channels: Channel[] }, { results: SendResult[] }>('sendQuotation')({
    labId: LAB_ID,
    quotationId,
    channels,
  }).then((r) => r.data)

// Returns the report payload (order, approved results, tests, lab header) or throws.
export const getPublicReport = (input: PublicReportInput) =>
  call<PublicReportInput, unknown>('getPublicReport')(input).then((r) => r.data)

// Fill {placeholders} in a template.
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')
}

// Click-to-chat link for sending from the staff member's own WhatsApp (no API needed).
export function whatsappLink(phone: string, text: string): string {
  const digits = phone.replace(/\D/g, '')
  const intl = digits.length === 10 ? `91${digits}` : digits
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`
}

export interface BulkSendRow {
  orderId: string
  billNo: string
  ok: boolean
  skipped?: boolean
  error?: string
  results: SendResult[]
}

// Up to 25 bills per call; each bill is checked on its own and one failure never stops the rest.
export const sendReportsBulk = (input: { orderIds: string[]; channels: Channel[]; recipient?: ReportRecipient }) =>
  call<{ labId: string; orderIds: string[]; channels: Channel[]; recipient?: ReportRecipient }, { results: BulkSendRow[] }>('sendReportsBulk')({
    ...input,
    labId: LAB_ID,
  }).then((r) => r.data.results)

// Sends the bill summary (independent of the report); logged in the delivery history as kind "bill".
export const sendBill = (input: { orderId: string; channels: Channel[]; phone?: string; email?: string }) =>
  call<{ labId: string; orderId: string; channels: Channel[]; phone?: string; email?: string }, { results: SendResult[] }>('sendBill')({
    ...input,
    labId: LAB_ID,
  }).then((r) => r.data.results)

// Builds (or reuses when unchanged) the stored, hashed snapshot of the bill's current report.
export const createReportSnapshotNow = (orderId: string) =>
  call<{ labId: string; orderId: string }, { id: string; sha256: string; revision: number; created: boolean }>('createReportSnapshotNow')({
    labId: LAB_ID,
    orderId,
  }).then((r) => r.data)
