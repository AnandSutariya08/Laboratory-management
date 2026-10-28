import { createHash, randomBytes } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { LOG_KEY, MAIL_FROM, MSG91_AUTH_KEY, MSG91_BOOKING_TEMPLATE_ID, MSG91_REPORT_TEMPLATE_ID, REGION, SECRETS, SMTP_URL, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN, secret, FIRESTORE_DB } from './secrets'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { sendEmail } from './providers/email'
import { sendSms } from './providers/sms'
import { sendWhatsapp } from './providers/whatsapp'
import type { OutgoingMessage, ProviderResult } from './providers/types'
import { assertSmartCurrent, createReportSnapshot, reportPdfBuffer } from './reports'
import { decTo, encTo, maskTo } from './mask'

initializeApp()
const db = getFirestore(FIRESTORE_DB)

export type Channel = 'whatsapp' | 'sms' | 'email'
const CHANNELS: Channel[] = ['whatsapp', 'sms', 'email']

export interface SendResult {
  channel: Channel
  to: string
  status: 'sent' | 'failed' | 'logged'
  error?: string
  link?: string
}

export interface Settings {
  name: string
  address: string
  phone: string
  email: string
  publicAppUrl: string
  autoSendOnFinal: boolean
  blockSendWhileDue: boolean
  reportLinkDays: number
  profile: { website: string; city: string; logoDataUrl: string; dateFormat: string }
  registration: { idDisplay: string }
  reportEntry: { defaultSignatoryId: string; criticalWhatsappAlert?: boolean; criticalDoctorAlert?: boolean; notifyOnRejection?: boolean }
  signatories: {
    id: string; name: string; qualification: string; registrationNo: string; signatureDataUrl: string
    hideNameInReport: boolean; defaultForDepartmentIds: string[]; active: boolean
    designation?: string; signatureHeight?: number; align?: string
  }[]
  reportDetails: { reportBlockPartial?: boolean; allowProvisionalSend?: boolean } & Record<string, unknown>
  referrals: { govPanelSendDueReport: boolean }
  reportLayout?: Record<string, unknown>
  radiologyConfig?: Record<string, unknown>
  pcpndt?: { blockReport?: boolean; clinicName?: string; registrationNo?: string }
  emailSender?: { fromName?: string; fromEmail?: string; status?: string; verifiedEmail?: string }
  dailyReport: { enabled: boolean; email: string; whatsapp: string }
  extraTemplates: {
    smsReportReady: string; emailSubject: string; emailBody: string
    waReportFromB2b: string; waReportFromCentre: string; waReportToB2b: string
  }
  templates: {
    reportReady: string
    bookingConfirmed: string
    collectorAssigned: string
    waReportTemplate: string
    waBookingTemplate: string
    waBillTemplate?: string
    waAlertTemplate?: string
    waQuotationTemplate?: string
  }
}

const DEFAULT_SETTINGS: Settings = {
  name: 'Health Care Labs',
  address: '',
  phone: '',
  email: '',
  publicAppUrl: '',
  autoSendOnFinal: false,
  blockSendWhileDue: true,
  reportLinkDays: 30,
  profile: { website: '', city: '', logoDataUrl: '', dateFormat: 'DD/MM/YYYY' },
  registration: { idDisplay: 'patientId' },
  reportEntry: { defaultSignatoryId: '' },
  signatories: [],
  reportDetails: {},
  referrals: { govPanelSendDueReport: false },
  dailyReport: { enabled: false, email: '', whatsapp: '' },
  extraTemplates: { smsReportReady: '', emailSubject: '', emailBody: '', waReportFromB2b: '', waReportFromCentre: '', waReportToB2b: '' },
  templates: {
    reportReady: 'Dear {patientName}, your report for bill {billNo} from {labName} is ready. View it here: {link}',
    bookingConfirmed:
      'Dear {patientName}, your home collection with {labName} is confirmed for {slot}. Booking ID {bookingId}.',
    collectorAssigned:
      'Dear {patientName}, {collectorName} from {labName} will collect your sample at {slot}. Booking ID {bookingId}.',
    waReportTemplate: 'report_ready',
    waBookingTemplate: 'booking_update',
  },
}

export async function loadSettings(labId: string): Promise<Settings> {
  const snap = await db.doc(`labs/${labId}`).get()
  const d = (snap.data() ?? {}) as Partial<Settings>
  const m = <K extends keyof Settings>(k: K) => ({ ...(DEFAULT_SETTINGS[k] as object), ...((d[k] as object) ?? {}) }) as Settings[K]
  return {
    ...DEFAULT_SETTINGS,
    ...d,
    templates: m('templates'),
    profile: m('profile'),
    registration: m('registration'),
    reportEntry: m('reportEntry'),
    reportDetails: m('reportDetails'),
    referrals: m('referrals'),
    dailyReport: m('dailyReport'),
    extraTemplates: m('extraTemplates'),
    signatories: Array.isArray(d.signatories) ? d.signatories : [],
  }
}

// CAT-27: pre-collection guidelines (fasting, water, etc.) of the tests behind booking / quotation lines.
// Package lines contribute their member tests. Returns '' when nothing applies.
async function guidelinesText(labId: string, lines: { kind?: string; refId?: string; testIds?: string[] }[]): Promise<string> {
  const ids = new Set<string>()
  for (const l of lines) {
    if (Array.isArray(l.testIds) && l.testIds.length) l.testIds.forEach((t) => ids.add(String(t)))
    else if (l.refId && l.kind === 'package') ((await db.doc(`labs/${labId}/packages/${l.refId}`).get()).data()?.testIds ?? []).forEach((t: string) => ids.add(t))
    else if (l.refId) ids.add(l.refId)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...ids].slice(0, 60)) {
    if (/\//.test(id)) continue
    const t = (await db.doc(`labs/${labId}/tests/${id}`).get()).data()
    const text = String(t?.preCollectionGuidelines ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(`${t?.name ?? ''}: ${text}`)
  }
  return out.length ? `Before your sample collection: ${out.join('; ')}` : ''
}

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')

const PORTAL_ROLES = ['b2b', 'collectionCentre', 'corporate', 'referrer']
export const REPORT_ROLES = ['labAdmin', 'admin', 'manager', 'reception', 'doctor']
const BOOKING_ROLES = [...REPORT_ROLES, 'phlebotomist']

export interface Caller {
  uid: string
  name: string
  perms: string[]
}

const ROLE_FALLBACK: Record<string, string[]> = {
  labAdmin: ['*'],
  admin: ['*'],
  manager: ['reports.print', 'reports.send', 'reports.sendDue', 'patients.view'],
  reception: ['reports.print', 'reports.send', 'patients.view'],
  doctor: ['reports.print', 'reports.send', 'patients.view'],
  technician: ['reports.print', 'patients.view'],
}

// Permission-matrix check: role doc permissions + user grants - denies (same rule as the web app).
export async function requirePerm(request: CallableRequest<unknown>, labId: unknown, anyOf: string[]): Promise<Caller> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
  if (typeof labId !== 'string' || !labId || labId.includes('/')) throw new HttpsError('invalid-argument', 'labId is required.')
  const u = (await db.doc(`labs/${labId}/users/${request.auth.uid}`).get()).data()
  if (!u || u.active !== true) throw new HttpsError('permission-denied', 'You do not have permission to do this.')
  const role = String(u.role ?? '')
  // External portal roles are never staff, whatever a role document says.
  if (PORTAL_ROLES.includes(role)) throw new HttpsError('permission-denied', 'You do not have permission to do this.')
  const roleDoc = (await db.doc(`labs/${labId}/roles/${role}`).get()).data()
  let set = new Set<string>(role === 'labAdmin' ? ['*'] : Array.isArray(roleDoc?.permissions) ? (roleDoc!.permissions as string[]) : ROLE_FALLBACK[role] ?? [])
  if (role !== 'labAdmin') {
    for (const g of (u.grants ?? []) as string[]) set.add(g)
    for (const d of (u.denies ?? []) as string[]) set.delete(d)
  }
  if (!set.has('*') && !anyOf.some((p) => set.has(p))) {
    throw new HttpsError('permission-denied', 'You do not have permission to do this.')
  }
  const perms = set.has('*') ? ['reports.sendDue', ...anyOf] : [...set]
  return { uid: request.auth.uid, name: String(u.name ?? request.auth.token.email ?? ''), perms }
}

export async function requireStaff(request: CallableRequest<unknown>, labId: unknown, roles: string[]): Promise<Caller> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
  if (typeof labId !== 'string' || !labId || labId.includes('/')) throw new HttpsError('invalid-argument', 'labId is required.')
  const snap = await db.doc(`labs/${labId}/users/${request.auth.uid}`).get()
  const u = snap.data()
  if (!u || u.active !== true || !roles.includes(u.role)) {
    throw new HttpsError('permission-denied', 'You do not have permission to send messages.')
  }
  return { uid: request.auth.uid, name: String(u.name ?? request.auth.token.email ?? ''), perms: [] }
}

export function parseChannels(v: unknown): Channel[] {
  if (!Array.isArray(v)) throw new HttpsError('invalid-argument', 'channels must be a list.')
  const out = [...new Set(v)].filter((c): c is Channel => CHANNELS.includes(c as Channel))
  if (out.length === 0) throw new HttpsError('invalid-argument', 'Choose at least one channel.')
  return out
}

// ---- Channel dispatch -------------------------------------------------------

interface Dispatched {
  result: SendResult
  providerId: string
}

// Sends one message on one channel; falls back to the outbox when the channel
// has no credentials (dev mode). Never throws.
export async function dispatchOne(
  labId: string,
  channel: Channel,
  msg: OutgoingMessage,
  settings: Settings,
  ref: { orderId?: string; bookingId?: string; quotationId?: string },
): Promise<Dispatched> {
  const base = { channel, to: msg.to, link: msg.link }
  if (!msg.to) {
    const error = channel === 'email' ? 'No email address on file.' : 'No phone number on file.'
    return { result: { ...base, status: 'failed', error }, providerId: '' }
  }
  try {
    let out: ProviderResult | null = null
    if (channel === 'whatsapp') {
      const token = secret(WHATSAPP_TOKEN)
      const phoneNumberId = secret(WHATSAPP_PHONE_NUMBER_ID)
      if (token && phoneNumberId) out = await sendWhatsapp({ token, phoneNumberId }, msg)
    } else if (channel === 'sms') {
      const authKey = secret(MSG91_AUTH_KEY)
      const templateId = secret(msg.kind === 'report' || msg.kind === 'bill' || msg.kind === 'alert' || msg.kind === 'otp' ? MSG91_REPORT_TEMPLATE_ID : MSG91_BOOKING_TEMPLATE_ID)
      if (authKey && templateId) out = await sendSms({ authKey, templateId }, msg)
    } else {
      const smtpUrl = secret(SMTP_URL)
      const from = secret(MAIL_FROM)
      if (smtpUrl && from) out = await sendEmail({ smtpUrl, from, sender: settings.emailSender?.status === 'verified' && settings.emailSender.fromEmail && settings.emailSender.verifiedEmail === settings.emailSender.fromEmail ? { name: settings.emailSender.fromName || settings.name, email: settings.emailSender.fromEmail } : undefined }, msg, settings.name)
    }
    if (!out) {
      await db.collection(`labs/${labId}/outbox`).add({
        channel,
        to: maskTo(msg.to),
        attachment: msg.attachments?.[0]?.filename ?? '',
        kind: msg.kind,
        subject: msg.subject,
        text: msg.text,
        link: msg.link ?? '',
        waTemplate: channel === 'whatsapp' ? msg.waTemplate : '',
        vars: Object.fromEntries(msg.vars),
        status: 'logged',
        ...ref,
        createdAt: FieldValue.serverTimestamp(),
      })
      return { result: { ...base, status: 'logged' }, providerId: '' }
    }
    if (!out.ok) return { result: { ...base, status: 'failed', error: out.error }, providerId: '' }
    return { result: { ...base, status: 'sent' }, providerId: out.providerId }
  } catch (e) {
    return { result: { ...base, status: 'failed', error: (e as Error).message }, providerId: '' }
  }
}

// ---- Report sharing ---------------------------------------------------------

type ShareKind = 'link' | 'qr'

export async function getOrCreateShare(labId: string, orderId: string, days: number, kind: ShareKind = 'link'): Promise<string> {
  const now = Date.now()
  const existing = await db.collection('reportShares').where('orderId', '==', orderId).get()
  for (const d of existing.docs) {
    const s = d.data()
    const exp = (s.expiresAt as Timestamp | undefined)?.toMillis() ?? 0
    if (s.labId === labId && !s.revoked && (s.kind ?? 'link') === kind && exp > now && (s.failedAttempts ?? 0) < MAX_ATTEMPTS) return d.id
  }
  const token = randomBytes(24).toString('base64url')
  await db.doc(`reportShares/${token}`).set({
    labId,
    orderId,
    kind,
    revoked: false,
    failedAttempts: 0,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(now + Math.max(1, days) * 86_400_000),
  })
  return token
}

// Staff-only: QR code token for the printed report (long-lived, status page first).
export const createReportShare = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderId?: string }
  await requirePerm(request, data.labId, ['reports.print', 'reports.send', 'patients.view'])
  const labId = data.labId as string
  if (!data.orderId || typeof data.orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId is required.')
  const orderRef = db.doc(`labs/${labId}/orders/${data.orderId}`)
  const order = (await orderRef.get()).data()
  if (!order || order.deleted) throw new HttpsError('not-found', 'Bill not found.')
  const settings = await loadSettings(labId)
  const token = await getOrCreateShare(labId, data.orderId, Math.max(settings.reportLinkDays, 365), 'qr')
  if (order.qrShareToken !== token) await orderRef.update({ qrShareToken: token })
  return { token }
})

// Staff-only: invalidate every link of a bill; the next send creates a fresh one.
export const revokeReportShare = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderId?: string }
  await requirePerm(request, data.labId, ['reports.send'])
  const labId = data.labId as string
  if (!data.orderId || typeof data.orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId is required.')
  const snaps = await db.collection('reportShares').where('orderId', '==', data.orderId).get()
  let n = 0
  for (const d of snaps.docs) {
    if (d.data().labId !== labId) continue
    await d.ref.update({ revoked: true, revokedAt: Timestamp.now() })
    n++
  }
  return { revoked: n }
})

type Recipient = 'patient' | 'doctor' | 'b2b' | 'centre' | 'corporate'
const RECIPIENTS: Recipient[] = ['patient', 'doctor', 'b2b', 'centre', 'corporate']
// Partner recipients: master collection + the order field holding the partner id.
const PARTNER_RECIPIENT: Record<string, { col: string; idField: string; nameField: string }> = {
  b2b: { col: 'b2bCentres', idField: 'b2bCentreId', nameField: 'b2bCentreName' },
  centre: { col: 'collectionCentres', idField: 'collectionCentreId', nameField: 'collectionCentreName' },
  corporate: { col: 'corporateClients', idField: 'corporateClientId', nameField: 'corporateClientName' },
}

interface ReportSendArgs {
  labId: string
  orderId: string
  order: DocumentData
  channels: Channel[]
  phone?: string
  email?: string
  recipient?: Recipient
  withLetterhead?: boolean
  letterheadId?: string
  testIds?: string[]
  smart?: boolean
  allowDuplicate?: boolean
  caller: Caller
  originFallback: string
  settings: Settings
}

interface SendOutcome {
  results: SendResult[]
  duplicates: Channel[]
}

// Throws HttpsError when the report may not be sent.
export function assertReportSendable(order: DocumentData, settings: Settings, caller: Caller, recipient: Recipient = 'patient') {
  const govDueOk = !!order.govPanelId && settings.referrals.govPanelSendDueReport
  if (recipient === 'patient' && settings.blockSendWhileDue && (order.due ?? 0) > 0 && !caller.perms.includes('reports.sendDue') && !govDueOk) {
    throw new HttpsError('failed-precondition', 'This bill has an outstanding balance. Clear the due amount before sending the report.')
  }
  const st = order.reportStatus
  const partialOk = settings.reportDetails.reportBlockPartial === false
  if (st === 'final') return
  if (st === 'provisional') {
    if (settings.reportDetails.allowProvisionalSend === false) {
      throw new HttpsError('failed-precondition', 'Provisional reports cannot be sent. Wait until the report is final.')
    }
    return
  }
  if (st === 'partial' && partialOk) return
  throw new HttpsError('failed-precondition', 'The report is not ready yet (it must be provisional or final).')
}

// Template rendering: supports {camelCase}, {{camelCase}} and {{snake_case}} placeholders.
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
export function render(template: string, vars: Record<string, string>): string {
  const all: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) {
    all[k] = v
    all[snake(k)] = v
  }
  return template.replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (_, a: string, b: string) => all[a ?? b] ?? '')
}

export const rupees = (paise: number) => `Rs ${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const AGE_UNIT: Record<string, string> = { year: 'Y', month: 'M', day: 'D' }

async function markChannelsDelivered(labId: string, orderId: string, channels: Set<string>) {
  const ref = db.doc(`labs/${labId}/orders/${orderId}`)
  const order = (await ref.get()).data()
  if (!order || !Array.isArray(order.dispatch) || channels.size === 0) return
  const dispatch = (order.dispatch as DocumentData[]).map((d) =>
    channels.has(d.mode) && !d.delivered ? { ...d, delivered: true, deliveredAt: Timestamp.now(), superseded: false } : d,
  )
  const all = dispatch.length > 0 && dispatch.every((d) => d.delivered)
  await ref.update({
    dispatch,
    dispatched: all,
    dispatchStatus: all ? 'dispatched' : dispatch.some((d) => d.delivered) ? 'partial' : 'pending',
  })
}

const RETRY_MINUTES = [5, 20, 60]
const MAX_RETRIES = 3

async function sendReportCore(a: ReportSendArgs): Promise<SendOutcome> {
  const { labId, orderId, order, settings } = a
  const recipient: Recipient = a.recipient ?? 'patient'
  const patientSnap = order.patientId ? await db.doc(`labs/${labId}/patients/${order.patientId}`).get() : null
  const patient = patientSnap?.data() ?? {}
  let phone = (a.phone ?? patient.phone ?? '').trim()
  let email = (a.email ?? patient.email ?? '').trim()
  let toName = String(order.patientName ?? '')
  if (recipient === 'doctor') {
    const ref = order.referrerId ? (await db.doc(`labs/${labId}/referrers/${order.referrerId}`).get()).data() : undefined
    phone = (a.phone ?? ref?.phone ?? '').trim()
    email = (a.email ?? ref?.email ?? '').trim()
    toName = String(ref?.name ?? order.referrerName ?? 'Doctor')
  } else if (recipient !== 'patient') {
    const pr = PARTNER_RECIPIENT[recipient]
    const pid = order[pr.idField] ? String(order[pr.idField]) : ''
    const c = pid ? (await db.doc(`labs/${labId}/${pr.col}/${pid}`).get()).data() : undefined
    phone = (a.phone ?? c?.phone ?? '').trim()
    email = (a.email ?? c?.email ?? '').trim()
    toName = String(c?.name ?? order[pr.nameField] ?? 'Partner')
  }

  // Duplicate guard: same channel + recipient + revision within an hour.
  const revision = Number(order.reportRevision ?? 0)
  const duplicates: Channel[] = []
  if (!a.allowDuplicate) {
    const recent = await db.collection(`labs/${labId}/orders/${orderId}/deliveries`).where('status', 'in', ['sent', 'delivered', 'read']).get()
    const cutoff = Date.now() - 3_600_000
    for (const ch of a.channels) {
      const hit = recent.docs.some((d) => {
        const x = d.data()
        return (x.kind ?? 'report') === 'report' && x.channel === ch && (x.recipient ?? 'patient') === recipient && (x.revision ?? 0) === revision && ((x.at as Timestamp | undefined)?.toMillis() ?? 0) > cutoff
      })
      if (hit) duplicates.push(ch)
    }
    if (duplicates.length) return { results: [], duplicates }
  }

  // Restricted tests never go out over WhatsApp / SMS.
  const testIds = new Set<string>()
  for (const item of (order.items ?? []) as DocumentData[]) for (const t of item.testIds ?? []) testIds.add(t)
  let restricted = false
  if (a.channels.some((c) => c !== 'email')) {
    const snaps = await Promise.all([...testIds].map((id) => db.doc(`labs/${labId}/tests/${id}`).get()))
    restricted = snaps.some((s) => s.data()?.restricted === true)
  }

  const token = await getOrCreateShare(labId, orderId, settings.reportLinkDays)
  const base = (settings.publicAppUrl || a.originFallback || '').replace(/\/+$/, '')
  const params = new URLSearchParams()
  if (a.letterheadId) params.set('lh', a.letterheadId)
  else if (a.withLetterhead) params.set('lh', '1')
  if (a.testIds?.length) params.set('t', a.testIds.join(','))
  const reportLink = `${base}/r/${token}${params.toString() ? `?${params}` : ''}`
  const smartParams = new URLSearchParams(params)
  smartParams.set('smart', '1')
  const smartLink = `${base}/r/${token}?${smartParams}`
  const link = a.smart ? smartLink : reportLink
  const vars = {
    patientName: toName,
    labName: settings.name,
    billNo: order.billNo ?? '',
    link,
    ageGender: `${order.ageValue ?? ''}${AGE_UNIT[order.ageUnit] ?? ''} / ${order.gender ?? ''}`,
    labContact: [settings.phone, settings.email].filter(Boolean).join(' | '),
    dueAmount: rupees(Number(order.due ?? 0)),
    reportLink,
    smartReportLink: smartLink,
  }
  const ex = settings.extraTemplates
  const waText =
    recipient !== 'patient' && ex.waReportToB2b
      ? ex.waReportToB2b
      : order.b2bCentreId && ex.waReportFromB2b
        ? ex.waReportFromB2b
        : order.collectionCentreId && ex.waReportFromCentre
          ? ex.waReportFromCentre
          : settings.templates.reportReady

  if (a.smart) await assertSmartCurrent(labId, orderId, revision)
  // PCPNDT: the ultrasound report is not released until Form F is complete (a send that leaves those tests out is fine).
  if (settings.pcpndt?.blockReport !== false && order.formFStatus !== 'complete') {
    const flagged = ((order.items ?? []) as DocumentData[]).filter((i) => i.pcpndt === true && i.status !== 'refunded').flatMap((i) => (i.testIds ?? []) as string[])
    if (flagged.length && (!a.testIds?.length || a.testIds.some((t) => flagged.includes(t)))) {
      throw new HttpsError('failed-precondition', 'This bill has a PCPNDT test and Form F is not complete. Complete Form F before sending the report.')
    }
  }
  // The approved version as a stored PDF file: attached to email, and to WhatsApp when a document template is set.
  const pdf = await reportPdfBuffer(labId, orderId).catch(() => null)
  const layout = (settings.reportLayout ?? {}) as { waDocTemplate?: string }
  const results: SendResult[] = []
  const ok = new Set<string>()
  for (const channel of a.channels) {
    const text =
      channel === 'sms' && ex.smsReportReady ? render(ex.smsReportReady, vars) : channel === 'email' && ex.emailBody ? render(ex.emailBody, vars) : render(waText, vars)
    const subject = render(ex.emailSubject || 'Your report from {labName} ({billNo})', vars)
    const msg: OutgoingMessage = {
      kind: 'report',
      to: channel === 'email' ? email : phone,
      text,
      subject,
      vars: [['patientName', vars.patientName], ['labName', vars.labName], ['billNo', vars.billNo], ['link', link]],
      link,
      waTemplate: channel === 'whatsapp' && pdf?.url && layout.waDocTemplate ? layout.waDocTemplate : settings.templates.waReportTemplate,
      ...(pdf && channel === 'email' ? { attachments: [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }] } : {}),
      ...(pdf?.url && channel === 'whatsapp' && layout.waDocTemplate ? { documentUrl: pdf.url, documentName: pdf.filename } : {}),
    }
    let result: SendResult
    let providerId = ''
    if (restricted && channel !== 'email') {
      result = { channel, to: msg.to, status: 'failed', error: 'Contains a restricted test; send by email or hand over a hard copy.', link }
    } else {
      const d = await dispatchOne(labId, channel, msg, settings, { orderId })
      result = d.result
      providerId = d.providerId
    }
    const retryable = result.status === 'failed' && !restricted && !!msg.to
    await db.collection(`labs/${labId}/orders/${orderId}/deliveries`).add({
      channel,
      to: maskTo(result.to),
      toEnc: encTo(labId, result.to),
      attachment: pdf && (channel === 'email' || (channel === 'whatsapp' && layout.waDocTemplate)) ? pdf.filename : '',
      kind: 'report',
      recipient,
      status: result.status,
      providerId,
      error: result.error ?? '',
      link,
      smart: !!a.smart,
      withLetterhead: !!a.withLetterhead || !!a.letterheadId,
      revision,
      attempts: 1,
      retryAt: retryable ? Timestamp.fromMillis(Date.now() + RETRY_MINUTES[0] * 60_000) : null,
      msg: retryable ? { text, subject, vars: msg.vars, waTemplate: msg.waTemplate, link } : null,
      sentBy: a.caller.uid,
      sentByName: a.caller.name,
      at: FieldValue.serverTimestamp(),
    })
    results.push(result)
    // Only a real provider send counts as delivered (dev "logged" does not).
    if (result.status === 'sent' && recipient === 'patient') ok.add(channel)
  }
  await markChannelsDelivered(labId, orderId, ok)
  return { results, duplicates: [] }
}

// Retries one failed delivery (back-off queue or manual).
async function retryDelivery(labId: string, orderId: string, deliveryId: string, force: boolean): Promise<SendResult | null> {
  const ref = db.doc(`labs/${labId}/orders/${orderId}/deliveries/${deliveryId}`)
  const d = (await ref.get()).data()
  if (!d || d.status !== 'failed' || !d.msg) return null
  if (!force && (d.attempts ?? 1) >= MAX_RETRIES) return null
  const settings = await loadSettings(labId)
  const m = d.msg as { text: string; subject: string; vars: [string, string][]; waTemplate: string; link: string }
  const msg: OutgoingMessage = { kind: 'report', to: d.toEnc ? decTo(labId, d.toEnc) : d.to, text: m.text, subject: m.subject, vars: m.vars, link: m.link, waTemplate: m.waTemplate }
  const { result, providerId } = await dispatchOne(labId, d.channel as Channel, msg, settings, { orderId })
  const attempts = (d.attempts ?? 1) + 1
  const again = result.status === 'failed' && attempts < MAX_RETRIES
  await ref.update({
    status: result.status,
    error: result.error ?? '',
    providerId,
    attempts,
    retryAt: again ? Timestamp.fromMillis(Date.now() + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60_000) : null,
    msg: result.status === 'failed' ? d.msg : null,
    lastAttemptAt: FieldValue.serverTimestamp(),
  })
  if (result.status === 'sent' && (d.recipient ?? 'patient') === 'patient') await markChannelsDelivered(labId, orderId, new Set([d.channel]))
  return result
}

export const sendReport = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const data = (request.data ?? {}) as {
    labId?: string
    orderId?: string
    channels?: unknown
    phone?: string
    email?: string
    recipient?: string
    withLetterhead?: boolean
    letterheadId?: string
    testIds?: unknown
    smart?: boolean
    allowDuplicate?: boolean
  }
  const caller = await requirePerm(request, data.labId, ['reports.send'])
  const labId = data.labId as string
  if (!data.orderId || typeof data.orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId is required.')
  const channels = parseChannels(data.channels)
  const recipient: Recipient = RECIPIENTS.includes(data.recipient as Recipient) ? (data.recipient as Recipient) : 'patient'

  const snap = await db.doc(`labs/${labId}/orders/${data.orderId}`).get()
  const order = snap.data()
  if (!order || order.deleted) throw new HttpsError('not-found', 'Bill not found.')
  const settings = await loadSettings(labId)
  assertReportSendable(order, settings, caller, recipient)

  const testIds = Array.isArray(data.testIds) ? data.testIds.filter((t): t is string => typeof t === 'string' && /^[\w-]{1,64}$/.test(t)).slice(0, 100) : []
  return sendReportCore({
    labId,
    orderId: data.orderId,
    order,
    channels,
    phone: data.phone,
    email: data.email,
    recipient,
    withLetterhead: data.withLetterhead === true,
    letterheadId: typeof data.letterheadId === 'string' && /^[\w-]{1,40}$/.test(data.letterheadId) ? data.letterheadId : undefined,
    testIds,
    smart: data.smart === true,
    allowDuplicate: data.allowDuplicate === true,
    caller,
    originFallback: String(request.rawRequest?.headers?.origin ?? ''),
    settings,
  })
})

// Manual retry of a failed delivery.
export const retryReportDelivery = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderId?: string; deliveryId?: string }
  await requirePerm(request, data.labId, ['reports.send'])
  if (!data.orderId || !data.deliveryId) throw new HttpsError('invalid-argument', 'orderId and deliveryId are required.')
  const r = await retryDelivery(data.labId as string, data.orderId, data.deliveryId, true)
  if (!r) throw new HttpsError('failed-precondition', 'This delivery cannot be retried.')
  return { result: r }
})

// Back-off queue: failed sends are retried up to 3 times.
export const retryFailedDeliveries = onSchedule(
  { schedule: 'every 10 minutes', region: REGION, secrets: SECRETS, timeZone: 'Asia/Kolkata' },
  async () => {
    const due = await db.collectionGroup('deliveries').where('retryAt', '<=', Timestamp.now()).limit(50).get()
    for (const d of due.docs) {
      const parts = d.ref.path.split('/') // labs/{lab}/orders/{order}/deliveries/{id}
      if (parts.length !== 6 || parts[0] !== 'labs') continue
      try {
        await retryDelivery(parts[1], parts[3], parts[5], false)
      } catch (e) {
        console.error('retry failed', d.ref.path, e)
      }
    }
  },
)

// ---- Booking messages -------------------------------------------------------

const slotText = (booking: DocumentData): string => {
  const ts = booking.scheduledAt as Timestamp | null | undefined
  const day = ts
    ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(ts.toDate())
    : ''
  // Unscheduled bookings would otherwise read "confirmed for ." in the message.
  return [day, booking.slot].filter(Boolean).join(', ') || 'a time we will confirm shortly'
}

export const sendBookingMessage = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; bookingId?: string; event?: string; channels?: unknown }
  const caller = await requireStaff(request, data.labId, BOOKING_ROLES)
  const labId = data.labId as string
  if (!data.bookingId || typeof data.bookingId !== 'string') throw new HttpsError('invalid-argument', 'bookingId is required.')
  if (data.event !== 'bookingConfirmed' && data.event !== 'collectorAssigned') {
    throw new HttpsError('invalid-argument', 'Unknown booking event.')
  }
  const event = data.event
  const channels = parseChannels(data.channels)

  const ref = db.doc(`labs/${labId}/bookings/${data.bookingId}`)
  const booking = (await ref.get()).data()
  if (!booking) throw new HttpsError('not-found', 'Booking not found.')
  const settings = await loadSettings(labId)

  const vars = {
    patientName: [booking.firstName, booking.lastName].filter(Boolean).join(' '),
    labName: settings.name,
    bookingId: booking.bookingNo ?? data.bookingId,
    slot: slotText(booking),
    collectorName: booking.assignedToName ?? '',
  }
  const guide = event === 'bookingConfirmed' ? await guidelinesText(labId, (booking.items ?? []) as { kind?: string; refId?: string }[]) : ''
  const text = [fill(settings.templates[event], vars), guide].filter(Boolean).join('\n')

  const results: SendResult[] = []
  const events: DocumentData[] = []
  for (const channel of channels) {
    const msg: OutgoingMessage = {
      kind: 'booking',
      to: String((channel === 'email' ? booking.email : booking.phone) ?? '').trim(),
      text,
      subject: `${settings.name}: your home collection booking ${vars.bookingId}`,
      vars: Object.entries(vars),
      waTemplate: settings.templates.waBookingTemplate,
    }
    const { result } = await dispatchOne(labId, channel, msg, settings, { bookingId: data.bookingId })
    results.push(result)
    events.push({
      at: Timestamp.now(),
      by: caller.uid,
      byName: caller.name,
      action: `message: ${event} via ${channel}`,
      note: result.status,
    })
  }
  await ref.update({ events: FieldValue.arrayUnion(...events) })
  return { results }
})

// BK-32: reminder before a home collection. Runs every 15 minutes; for each lab it finds active bookings whose
// scheduled time is within the lab's reminder lead time (settings.frontDesk.bookingReminderMinutes, default 120)
// and that have no reminderSentAt, sends through the same dispatch path (outbox in dev), then stamps reminderSentAt.
export const bookingReminders = onSchedule(
  { schedule: 'every 15 minutes', region: REGION, secrets: SECRETS, timeZone: 'Asia/Kolkata' },
  async () => {
    const labs = await db.collection('labs').get()
    const now = Date.now()
    for (const lab of labs.docs) {
      try {
        const fd = ((lab.data().frontDesk ?? {}) as { bookingReminderMinutes?: unknown })
        const lead = Number(fd.bookingReminderMinutes)
        const leadMinutes = Number.isFinite(lead) && lead > 0 ? lead : 120
        const due = await db
          .collection(`labs/${lab.id}/bookings`)
          .where('scheduledAt', '>', Timestamp.fromMillis(now))
          .where('scheduledAt', '<=', Timestamp.fromMillis(now + leadMinutes * 60_000))
          .get()
        const todo = due.docs.filter((d) => {
          const b = d.data()
          return ['confirmed', 'assigned', 'scheduled'].includes(String(b.status)) && !b.reminderSentAt
        })
        if (!todo.length) continue
        const settings = await loadSettings(lab.id)
        for (const d of todo) {
          // Claim the booking first so an overlapping run cannot send twice.
          const claimed = await db.runTransaction(async (tx) => {
            const cur = (await tx.get(d.ref)).data()
            if (!cur || cur.reminderSentAt) return false
            tx.update(d.ref, { reminderSentAt: Timestamp.now() })
            return true
          })
          if (!claimed) continue
          const b = d.data()
          const vars = {
            patientName: [b.firstName, b.lastName].filter(Boolean).join(' '),
            labName: settings.name,
            bookingId: b.bookingNo ?? d.id,
            slot: slotText(b),
            collectorName: b.assignedToName ?? '',
          }
          const guide = await guidelinesText(lab.id, (b.items ?? []) as { kind?: string; refId?: string }[])
          const text = [fill(`Reminder: Dear {patientName}, your home collection with {labName} is scheduled for {slot}. Booking ID {bookingId}.`, vars), guide].filter(Boolean).join('\n')
          const channel: Channel = String(b.phone ?? '').trim() ? 'whatsapp' : 'email'
          const msg: OutgoingMessage = {
            kind: 'booking',
            to: String((channel === 'email' ? b.email : b.phone) ?? '').trim(),
            text,
            subject: `${settings.name}: reminder for your home collection ${vars.bookingId}`,
            vars: Object.entries(vars),
            waTemplate: settings.templates.waBookingTemplate,
          }
          const { result } = await dispatchOne(lab.id, channel, msg, settings, { bookingId: d.id })
          await d.ref.update({
            events: FieldValue.arrayUnion({ at: Timestamp.now(), by: 'system', byName: 'Reminder job', action: `message: reminder via ${channel}`, note: result.status }),
          })
        }
      } catch (e) {
        console.error('booking reminders failed for lab', lab.id, e)
      }
    }
  },
)

// ---- Public report ----------------------------------------------------------

export const MAX_ATTEMPTS = 5
export const iso = (v: unknown): string | null => {
  const t = v as { toDate?: () => Date } | null | undefined
  return t && typeof t.toDate === 'function' ? t.toDate().toISOString() : null
}

export const maskName = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w : `${w.charAt(0)}${'*'.repeat(Math.max(2, w.length - 1))}`))
    .join(' ')

export async function logAccess(token: string, request: CallableRequest<unknown>, mode: string, ok: boolean) {
  try {
    const ip = String(request.rawRequest?.ip ?? '')
    await db.collection(`reportShares/${token}/access`).add({
      at: Timestamp.now(),
      mode,
      ok,
      ipHash: ip ? createHash('sha256').update(ip).digest('hex').slice(0, 16) : '',
    })
  } catch {
    /* logging must never block the patient */
  }
}

// ---- Auto-send when a report becomes final ------------------------------------

export const onOrderFinal = onDocumentUpdated(
  { document: 'labs/{labId}/orders/{orderId}', database: FIRESTORE_DB, region: REGION, secrets: SECRETS },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    if (!before || !after || after.deleted) return
    const { labId, orderId } = event.params
    // Stored report snapshot whenever the bill first reaches Provisional or Final.
    if (before.reportStatus !== after.reportStatus && (after.reportStatus === 'final' || after.reportStatus === 'provisional')) {
      await createReportSnapshot(labId, orderId, after.reportStatus === 'final' ? 'final' : 'provisional').catch((e) => console.error('snapshot failed', e))
    }
    if (before.reportStatus === 'final' || after.reportStatus !== 'final') return
    const settings = await loadSettings(labId)
    const system: Caller = { uid: 'system', name: 'Auto-send', perms: [] }

    // B2B centre with "Auto send report" on gets the report on its own contact details.
    if (after.b2bCentreId) {
      const centre = (await db.doc(`labs/${labId}/b2bCentres/${after.b2bCentreId}`).get()).data()
      if (centre?.settings?.autoSendReport) {
        const channels: Channel[] = []
        if (centre.phone) channels.push('whatsapp')
        if (centre.email) channels.push('email')
        if (channels.length) {
          await sendReportCore({ labId, orderId, order: after, channels, recipient: 'b2b', caller: system, originFallback: '', settings }).catch((e) =>
            console.error('b2b auto-send failed', e),
          )
        }
      }
    }

    // Referring doctor with "Auto-send paid reports" on gets the report through the normal dispatch path
    // (WhatsApp on the doctor's phone, email when only an address is on file) once the bill is fully paid.
    if (after.referrerId && (after.due ?? 0) <= 0) {
      const ref = (await db.doc(`labs/${labId}/referrers/${after.referrerId}`).get()).data()
      if (ref?.autoSendReports === true && (ref.phone || ref.email)) {
        const docChannels: Channel[] = []
        if (ref.phone) docChannels.push('whatsapp')
        if (ref.email) docChannels.push('email')
        await sendReportCore({
          labId, orderId, order: after, channels: docChannels, recipient: 'doctor', caller: system, originFallback: '', settings,
        }).catch((e) => console.error('doctor auto-send failed', e))
      }
    }

    if (!settings.autoSendOnFinal) return
    if (settings.blockSendWhileDue && (after.due ?? 0) > 0) return
    const channels = ((after.dispatch ?? []) as DocumentData[])
      .filter((d) => !d.delivered && CHANNELS.includes(d.mode))
      .map((d) => d.mode as Channel)
    if (channels.length === 0) return
    await sendReportCore({ labId, orderId, order: after, channels, caller: system, originFallback: '', settings })
  },
)

// ---- Daily sample report (09:30 IST) -------------------------------------------

export const dailyReport = onSchedule(
  { schedule: '30 9 * * *', timeZone: 'Asia/Kolkata', region: REGION, secrets: SECRETS },
  async () => {
    const labs = await db.collection('labs').get()
    const IST = 5.5 * 3_600_000
    const now = Date.now()
    const startToday = Math.floor((now + IST) / 86_400_000) * 86_400_000 - IST
    const from = Timestamp.fromMillis(startToday - 86_400_000)
    const to = Timestamp.fromMillis(startToday)
    for (const lab of labs.docs) {
      const settings = await loadSettings(lab.id)
      const dr = settings.dailyReport
      if (!dr.enabled || (!dr.email && !dr.whatsapp)) continue
      const orders = await db.collection(`labs/${lab.id}/orders`).where('createdAt', '>=', from).where('createdAt', '<', to).get()
      let tests = 0
      let collected = 0
      let final = 0
      let revenue = 0
      let dues = 0
      let pending = 0
      for (const o of orders.docs) {
        const x = o.data()
        if (x.deleted) continue
        tests += ((x.items ?? []) as DocumentData[]).reduce((n, i) => n + (i.testIds?.length ?? 0), 0)
        if (x.collectedAt) collected++
        if (x.reportStatus === 'final') final++
        revenue += Number(x.paid ?? 0)
        dues += Number(x.due ?? 0)
        if (x.reportStatus !== 'final') pending++
      }
      const live = orders.docs.filter((o) => !o.data().deleted).length
      const day = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(startToday - 43_200_000))
      const text = `Daily sample report for ${day}: ${live} bills, ${tests} tests, ${collected} samples collected, ${final} reports final, ${pending} pending, ${rupees(revenue)} collected (net of refunds), ${rupees(dues)} due.`
      const sys = { orderId: '' }
      if (dr.email) {
        await dispatchOne(lab.id, 'email', { kind: 'daily', to: dr.email, text, subject: `${settings.name}: daily sample report ${day}`, vars: [], waTemplate: '' }, settings, sys)
      }
      if (dr.whatsapp) {
        await dispatchOne(lab.id, 'whatsapp', { kind: 'daily', to: dr.whatsapp, text, subject: '', vars: [['summary', text]], waTemplate: 'daily_report' }, settings, sys)
      }
    }
  },
)

// ---- Delivery webhook, bills, bulk send, snapshots, alerts ----------------------
export { syncUserClaims } from './claims'
export { deliveryWebhook } from './webhook'
// ---- Send bill (DP-21) --------------------------------------------------------
// Sends the bill summary on its own: independent of the report, same delivery log (kind "bill").
// Quotation send: same dispatch path as reports and bookings (provider when configured, dev outbox otherwise).
// A Draft becomes Sent once at least one channel was accepted; every attempt is kept on the quotation.
export const sendQuotation = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; quotationId?: string; channels?: unknown }
  const caller = await requirePerm(request, data.labId, ['quotation.manage', 'registration.create'])
  const labId = data.labId as string
  if (!data.quotationId || typeof data.quotationId !== 'string' || data.quotationId.includes('/')) {
    throw new HttpsError('invalid-argument', 'quotationId is required.')
  }
  const channels = parseChannels(data.channels)
  const ref = db.doc(`labs/${labId}/quotations/${data.quotationId}`)
  const q = (await ref.get()).data()
  if (!q) throw new HttpsError('not-found', 'Quotation not found.')
  if (q.status === 'cancelled' || q.status === 'converted') throw new HttpsError('failed-precondition', 'This quotation can no longer be sent.')
  const settings = await loadSettings(labId)

  const prospect = (q.prospect ?? {}) as { name?: string; phone?: string; email?: string }
  const items = (Array.isArray(q.items) ? q.items : []) as { name?: string; price?: number; discount?: number }[]
  const valid = (q.validUntil as Timestamp | undefined)?.toDate()
  const validText = valid ? valid.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }) : ''
  const text = [
    `Quotation ${q.quoNo ?? ''} from ${settings.name}`,
    `For: ${prospect.name ?? ''}`,
    ...items.map((i, n) => `${n + 1}. ${i.name ?? ''} - ${rupees((i.price ?? 0) - (i.discount ?? 0))}`),
    `Total: ${rupees(Number(q.net ?? 0))}`,
    validText ? `Valid until ${validText}` : '',
    await guidelinesText(labId, items as { testIds?: string[] }[]),
  ].filter(Boolean).join('\n')
  const vars: [string, string][] = [
    ['patientName', prospect.name ?? ''],
    ['labName', settings.name],
    ['quotationNo', String(q.quoNo ?? '')],
    ['total', rupees(Number(q.net ?? 0))],
    ['validUntil', validText],
  ]

  const results: SendResult[] = []
  const log: DocumentData[] = []
  for (const channel of channels) {
    const msg: OutgoingMessage = {
      kind: 'quotation',
      to: String((channel === 'email' ? prospect.email : prospect.phone) ?? '').trim(),
      text,
      subject: `Quotation ${q.quoNo ?? ''} from ${settings.name}`,
      vars,
      waTemplate: settings.templates.waQuotationTemplate ?? 'quotation',
    }
    const { result } = await dispatchOne(labId, channel, msg, settings, { quotationId: data.quotationId })
    results.push(result)
    log.push({ at: Timestamp.now(), by: caller.uid, byName: caller.name, channel, to: maskTo(result.to), status: result.status, error: result.error ?? '' })
  }
  const accepted = results.some((r) => r.status === 'sent' || r.status === 'logged')
  await ref.update({
    sendLog: FieldValue.arrayUnion(...log),
    ...(accepted && q.status === 'draft' ? { status: 'sent' } : {}),
    ...(accepted ? { sentAt: FieldValue.serverTimestamp() } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  })
  return { results }
})

export const sendBill = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderId?: string; channels?: unknown; phone?: string; email?: string }
  const caller = await requirePerm(request, data.labId, ['reports.send', 'billing.clearDue', 'patients.view'])
  const labId = data.labId as string
  if (!data.orderId || typeof data.orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId is required.')
  const channels = parseChannels(data.channels)
  const order = (await db.doc(`labs/${labId}/orders/${data.orderId}`).get()).data()
  if (!order || order.deleted) throw new HttpsError('not-found', 'Bill not found.')
  const settings = await loadSettings(labId)
  const patient = order.patientId ? (await db.doc(`labs/${labId}/patients/${order.patientId}`).get()).data() ?? {} : {}
  const phone = (data.phone ?? patient.phone ?? '').trim()
  const email = (data.email ?? patient.email ?? '').trim()
  const net = Number(order.net ?? 0)
  const due = Number(order.due ?? 0)
  const text = `Dear ${order.patientName ?? ''}, your bill ${order.billNo ?? ''} from ${settings.name}: total ${rupees(net)}, paid ${rupees(Number(order.paid ?? 0))}${due > 0 ? `, balance due ${rupees(due)}` : ', fully paid'}. ${[settings.phone, settings.email].filter(Boolean).join(' | ')}`.trim()
  const vars: [string, string][] = [
    ['patientName', String(order.patientName ?? '')], ['labName', settings.name], ['billNo', String(order.billNo ?? '')],
    ['total', rupees(net)], ['dueAmount', rupees(due)],
  ]
  const results: SendResult[] = []
  for (const channel of channels) {
    const msg: OutgoingMessage = {
      kind: 'bill', to: channel === 'email' ? email : phone, text, subject: `${settings.name}: bill ${order.billNo ?? ''}`, vars,
      waTemplate: settings.templates.waBillTemplate || 'bill_summary',
    }
    const d = await dispatchOne(labId, channel, msg, settings, { orderId: data.orderId })
    results.push(d.result)
    await db.collection(`labs/${labId}/orders/${data.orderId}/deliveries`).add({
      channel, to: maskTo(d.result.to), toEnc: encTo(labId, d.result.to), kind: 'bill', recipient: 'patient', status: d.result.status, providerId: d.providerId, error: d.result.error ?? '',
      link: '', attempts: 1, retryAt: null, msg: null, sentBy: caller.uid, sentByName: caller.name, at: FieldValue.serverTimestamp(),
    })
  }
  return { results }
})

// ---- Bulk report send (DP-20) -------------------------------------------------
// Sends reports for many bills; each bill is checked on its own (due, status) so one failure never stops the rest.
export const sendReportsBulk = onCall({ region: REGION, secrets: SECRETS, timeoutSeconds: 300 }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderIds?: unknown; channels?: unknown; recipient?: string }
  const caller = await requirePerm(request, data.labId, ['reports.send'])
  const labId = data.labId as string
  const ids = Array.isArray(data.orderIds) ? [...new Set(data.orderIds.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,64}$/.test(x)))] : []
  if (ids.length === 0) throw new HttpsError('invalid-argument', 'Choose at least one bill.')
  if (ids.length > 25) throw new HttpsError('invalid-argument', 'Send at most 25 bills at a time.')
  const channels = parseChannels(data.channels)
  const recipient: Recipient = RECIPIENTS.includes(data.recipient as Recipient) ? (data.recipient as Recipient) : 'patient'
  const settings = await loadSettings(labId)
  const out: { orderId: string; billNo: string; ok: boolean; skipped?: boolean; error?: string; results: SendResult[] }[] = []
  for (const orderId of ids) {
    const order = (await db.doc(`labs/${labId}/orders/${orderId}`).get()).data()
    if (!order || order.deleted) {
      out.push({ orderId, billNo: '', ok: false, error: 'Bill not found.', results: [] })
      continue
    }
    try {
      assertReportSendable(order, settings, caller, recipient)
      const r = await sendReportCore({
        labId, orderId, order, channels, recipient, caller, originFallback: String(request.rawRequest?.headers?.origin ?? ''), settings,
      })
      if (r.duplicates.length) out.push({ orderId, billNo: order.billNo ?? '', ok: false, skipped: true, error: 'Already sent in the last hour.', results: [] })
      else out.push({ orderId, billNo: order.billNo ?? '', ok: r.results.every((x) => x.status !== 'failed'), results: r.results })
    } catch (e) {
      out.push({ orderId, billNo: order.billNo ?? '', ok: false, error: (e as Error).message, results: [] })
    }
  }
  return { results: out }
})

// ---- Critical value alert (MS-09) -----------------------------------------------
// Behind the Report Entry toggle `criticalWhatsappAlert`. The message never contains the value: it asks
// the recipient to contact the lab. Without provider credentials it lands in the dev outbox.
async function notifyOrderParties(
  labId: string, orderId: string, order: DocumentData, settings: Settings, kind: 'alert', text: string, dedupeId: string, subject: string,
) {
  const dRef = (id: string) => db.doc(`labs/${labId}/orders/${orderId}/deliveries/${id}`)
  const patient = order.patientId ? (await db.doc(`labs/${labId}/patients/${order.patientId}`).get()).data() ?? {} : {}
  const targets: { who: Recipient; phone: string; email: string }[] = [{ who: 'patient', phone: String(patient.phone ?? ''), email: String(patient.email ?? '') }]
  for (const w of ['b2b', 'centre'] as const) {
    const pr = PARTNER_RECIPIENT[w]
    if (!order[pr.idField]) continue
    const c = (await db.doc(`labs/${labId}/${pr.col}/${order[pr.idField]}`).get()).data()
    if (c) targets.push({ who: w, phone: String(c.phone ?? ''), email: String(c.email ?? '') })
  }
  for (const t of targets) {
    const channel: Channel | null = t.phone ? 'whatsapp' : t.email ? 'email' : null
    if (!channel) continue
    const id = `${dedupeId}-${t.who}`
    try {
      await dRef(id).create({ placeholder: true }) // dedupe: one alert per event and party
    } catch {
      continue
    }
    const msg: OutgoingMessage = {
      kind, to: channel === 'email' ? t.email : t.phone, text, subject,
      vars: [['patientName', String(order.patientName ?? '')], ['labName', settings.name], ['billNo', String(order.billNo ?? '')], ['link', '']],
      waTemplate: settings.templates.waAlertTemplate || 'result_alert',
    }
    const d = await dispatchOne(labId, channel, msg, settings, { orderId })
    await dRef(id).set({
      channel, to: maskTo(d.result.to), toEnc: encTo(labId, d.result.to), kind, recipient: t.who, status: d.result.status, providerId: d.providerId, error: d.result.error ?? '',
      link: '', attempts: 1, retryAt: null, msg: null, sentBy: 'system', sentByName: 'Auto alert', at: FieldValue.serverTimestamp(),
    })
  }
}

export const onResultCritical = onDocumentWritten(
  { document: 'labs/{labId}/orders/{orderId}/results/{testId}', database: FIRESTORE_DB, region: REGION, secrets: SECRETS },
  async (event) => {
    const after = event.data?.after.data()
    if (!after || (after.status !== 'entered' && after.status !== 'approved')) return
    const hasCritical = (v: unknown) => Object.values((v ?? {}) as Record<string, DocumentData>).some((x) => x?.critical === true)
    if (!hasCritical(after.values) || hasCritical(event.data?.before.data()?.values)) return
    const { labId, orderId, testId } = event.params
    const settings = await loadSettings(labId)
    const order = (await db.doc(`labs/${labId}/orders/${orderId}`).get()).data()
    if (!order || order.deleted) return

    // RE-46: the verifier and the referring doctor are told which value is critical (clinicians see the value),
    // and the event lands in the in-app activity feed. Sent through the same dispatch path as every message.
    const test = (await db.doc(`labs/${labId}/tests/${testId}`).get()).data()
    const before = (event.data?.before.data()?.values ?? {}) as Record<string, DocumentData>
    const crit = Object.entries((after.values ?? {}) as Record<string, DocumentData>)
      .filter(([k, v]) => v?.critical === true && before[k]?.critical !== true)
      .map(([k, v]) => {
        const p = ((test?.parameters ?? []) as DocumentData[]).find((x) => x.key === k)
        return `${p?.name ?? k}: ${v.value ?? ''}${p?.unit ? ` ${p.unit}` : ''}${v.criticalDir ? (v.criticalDir === 'low' ? ' (LL)' : ' (HH)') : ''}`
      })
    const testName = String(after.testName ?? test?.name ?? 'test')
    const clinText = `CRITICAL RESULT: ${order.patientName ?? ''} (bill ${order.billNo ?? ''}), ${testName}. ${crit.join('; ')}. Please act and acknowledge in ${settings.name}.`
    await db.collection(`labs/${labId}/activity`).add({
      type: 'critical', text: `Critical result on ${order.billNo ?? ''} (${order.patientName ?? ''}): ${testName}. ${crit.join('; ')}`, refPath: `labs/${labId}/orders/${orderId}`,
      category: 'RESULT', at: FieldValue.serverTimestamp(), by: 'system', byName: 'Critical alert', branchId: order.branchId ?? 'main',
    }).catch(() => undefined)
    if (settings.reportEntry.criticalDoctorAlert !== false) {
      const targets: { who: string; phone: string; email: string }[] = []
      const verifierId = String(after.approvedBy || after.verification?.requestedBy || '')
      if (verifierId) {
        const u = (await db.doc(`labs/${labId}/users/${verifierId}`).get()).data()
        if (u) targets.push({ who: 'verifier', phone: String(u.phone ?? ''), email: String(u.email ?? '') })
      }
      if (order.referrerId) {
        const r = (await db.doc(`labs/${labId}/referrers/${order.referrerId}`).get()).data()
        if (r) targets.push({ who: 'doctor', phone: String(r.phone ?? ''), email: String(r.email ?? '') })
      }
      for (const t of targets) {
        const channel: Channel | null = t.phone ? 'whatsapp' : t.email ? 'email' : null
        if (!channel) continue
        const id = `alert-crit-clin-${testId}-${t.who}`
        try {
          await db.doc(`labs/${labId}/orders/${orderId}/deliveries/${id}`).create({ placeholder: true })
        } catch {
          continue
        }
        const msg: OutgoingMessage = {
          kind: 'alert', to: channel === 'email' ? t.email : t.phone, text: clinText, subject: `${settings.name}: CRITICAL result, bill ${order.billNo ?? ''}`,
          vars: [['patientName', String(order.patientName ?? '')], ['labName', settings.name], ['billNo', String(order.billNo ?? '')], ['link', clinText]],
          waTemplate: settings.templates.waAlertTemplate || 'result_alert',
        }
        const d = await dispatchOne(labId, channel, msg, settings, { orderId })
        await db.doc(`labs/${labId}/orders/${orderId}/deliveries/${id}`).set({
          channel, to: maskTo(d.result.to), toEnc: encTo(labId, d.result.to), kind: 'alert', recipient: t.who === 'doctor' ? 'doctor' : 'patient', status: d.result.status, providerId: d.providerId,
          error: d.result.error ?? '', link: '', attempts: 1, retryAt: null, msg: null, sentBy: 'system', sentByName: `Critical alert (${t.who})`, at: FieldValue.serverTimestamp(),
        })
      }
    }

    if (!settings.reportEntry.criticalWhatsappAlert) return
    const text = `Dear ${order.patientName ?? ''}, one or more results on bill ${order.billNo ?? ''} at ${settings.name} need prompt attention. Please contact the lab${settings.phone ? ` on ${settings.phone}` : ''} or your doctor as soon as possible.`
    await notifyOrderParties(labId, orderId, order, settings, 'alert', text, `alert-crit-${testId}`, `${settings.name}: important result on bill ${order.billNo ?? ''}`)
  },
)

// ---- Sample rejection notice (ACC-29) ---------------------------------------------
// When a line turns Rejected the patient (and the B2B / collection centre) is told a fresh sample is needed.
export const onSampleRejected = onDocumentUpdated(
  { document: 'labs/{labId}/orders/{orderId}', database: FIRESTORE_DB, region: REGION, secrets: SECRETS },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    if (!before || !after || after.deleted) return
    const was = new Map(((before.items ?? []) as DocumentData[]).map((i) => [i.lineId, i.status]))
    const fresh = ((after.items ?? []) as DocumentData[]).filter((i) => i.status === 'rejected' && was.get(i.lineId) !== 'rejected')
    if (fresh.length === 0) return
    const { labId, orderId } = event.params
    const settings = await loadSettings(labId)
    if (settings.reportEntry.notifyOnRejection === false) return
    const names = fresh.map((i) => String(i.name ?? '')).filter(Boolean).join(', ')
    const reason = fresh.map((i) => String(i.rejectReason ?? '')).filter(Boolean)[0]
    const text = `Dear ${after.patientName ?? ''}, the sample for ${names || 'your test'} (bill ${after.billNo ?? ''}) could not be processed${reason ? `: ${reason}` : ''}. Please contact ${settings.name}${settings.phone ? ` on ${settings.phone}` : ''} to arrange a fresh sample.`
    await notifyOrderParties(labId, orderId, after, settings, 'alert', text, `alert-rej-${fresh.map((i) => i.lineId).join('_').slice(0, 60)}-${Date.now().toString(36)}`, `${settings.name}: sample could not be processed (${after.billNo ?? ''})`)
  },
)
// ---- AI (Claude analyst, result interpretation, MCP connector) ---------------------
export { analystChat, analystChatStream, runAnalytics, runDashboard, getAiDatasetAccess, setAiDatasetAccess, listAiDashboards, shareAiDashboard } from './ai/analyst'
export { suggestResultFlags } from './ai/flags'
export { supportChat } from './support'
export { interpretResult } from './ai/interpret'
export { draftTestInterpretation } from './ai/draftInterpretation'
export { draftTestFromPdf } from './ai/draftTestPdf'
export { recordAiConsent } from './ai/usage'
export { mcp, createMcpConnection, confirmMcpConnection, revokeMcpConnection, updateMcpConnection, revokeMcpOnUserLeave } from './ai/mcp'
export { extractEqasReport, draftTestFromText, draftRadiologyImpression } from './ai/extract'
export { mirrorActivityToAudit } from './audit'
export { resolveLogin } from './login'

// ---- Mass statements (async jobs) ------------------------------------------------
export { processStatementJob } from './statements'

// ---- Reports: stored PDF versions, public access factors, patient portal, email sender, Form F -------------------
export {
  createReportSnapshotNow, getPublicReport, onResultApproved, requestReportOtp, ensureBillPin, requestPortalOtp, verifyPortalOtp, listPortalReports,
  requestEmailSenderVerification, confirmEmailSender, createFormFLink, getFormFSign, submitFormFSign,
  requestExternalOpinion, getExternalOpinion, submitExternalOpinion,
} from './reports'

// ---- Round 3: bulk registration job, online payments, collection-centre portal manifest ----------------------------
export { runBulkRegistration } from './bulk'
export { getPaymentConfig, createPaymentOrder, verifyPayment, razorpayWebhook } from './payments'
export { portalDispatchManifest, portalVoidBill, portalEditBarcode } from './portal'

// ---- Analyser ingest, auto-verification, Not-received sweep ------------------------
export { analyserIngest } from './analyser'
export { autoVerifyOnMachineValues } from './autoverify'
export { notReceivedSweep } from './cutoffs'

// ---- Analysis: server range aggregation and background export jobs ---------------------
export { aggregateRange, processExportJob } from './exports'

// ---- QC: server-side Westgard multi-rule evaluation of machine-fed runs ------------------------------------------
export { evaluateMachineQcRun } from './qcEval'
