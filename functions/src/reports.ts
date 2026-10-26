import { createHash, randomBytes, randomInt } from 'node:crypto'
import { FieldValue, getFirestore, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { REGION, SECRETS, FIRESTORE_DB } from './secrets'
import * as core from './index'
import { maskTo } from './mask'
import { buildReportPdf } from './pdf'
import { buildReportHtml, buildReportPayload, getBucket, mergeLayout, type ReportPayload } from './snapshot'
import type { OutgoingMessage } from './providers/types'

// Report files, snapshots, public report access (second factors), patient portal, email sender verification
// and PCPNDT Form F signing. Helpers from index.ts (dispatch, settings, permission check) are used at call
// time only, so the import cycle with index.ts is harmless.

const db = () => getFirestore(FIRESTORE_DB)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const labColl = (labId: string, name: string) => db().collection(`labs/${labId}/${name}`)
const LAB_ID_RE = /^[\w-]{1,64}$/

// ---- Stored report versions ---------------------------------------------------------------------------------

type Settings = core.Settings

function pickSignatory(settings: Settings, r: DocumentData, order: DocumentData, test: DocumentData | undefined, approver: string): DocumentData | null {
  const layout = mergeLayout(settings.reportLayout)
  const active = (settings.signatories ?? []).filter((s) => s.active !== false) as (Settings['signatories'][number] & { userId?: string; autoSign?: boolean; stampDataUrl?: string })[]
  const byUser = layout.signatoryMode === 'byUser' ? active.find((s) => s.userId && s.userId === approver) : undefined
  const pick =
    byUser ??
    active.find((s) => s.id === r.signatoryId) ??
    active.find((s) => s.id === order.reportSignatoryId) ??
    active.find((s) => (s.defaultForDepartmentIds ?? []).includes(test?.departmentId)) ??
    active.find((s) => s.autoSign) ??
    active.find((s) => s.id === settings.reportEntry.defaultSignatoryId)
  return pick
    ? {
        id: pick.id, name: pick.name, qualification: pick.qualification ?? '', registrationNo: pick.registrationNo ?? '', signatureDataUrl: pick.signatureDataUrl ?? '',
        hideNameInReport: !!pick.hideNameInReport, designation: pick.designation ?? '', signatureHeight: pick.signatureHeight ?? null, align: pick.align ?? 'center',
        stampDataUrl: pick.stampDataUrl ?? '',
      }
    : null
}

export interface SnapshotOutcome { id: string; sha256: string; revision: number; created: boolean }

// Freezes the approved report: payload JSON + PDF in Storage, hashed, with a print-ready HTML copy in Firestore.
export async function createReportSnapshot(labId: string, orderId: string, trigger: string, by = 'system'): Promise<SnapshotOutcome> {
  const orderRef = db().doc(`labs/${labId}/orders/${orderId}`)
  const order = (await orderRef.get()).data()
  if (!order || order.deleted) throw new HttpsError('not-found', 'Bill not found.')
  const settings = await core.loadSettings(labId)
  const payload = await buildReportPayload({ db: db(), labId, orderId, order, settings: settings as unknown as DocumentData })
  // Results approved a moment ago may not carry their signatory yet: resolve it the way the trigger does.
  const testById = new Map(payload.tests.map((t) => [String(t.id), t]))
  const resDocs = await db().collection(`labs/${labId}/orders/${orderId}/results`).get()
  const approver = new Map(resDocs.docs.map((d) => [d.id, String(d.data().approvedBy ?? '')]))
  payload.results = payload.results.map((r) => (r.signatorySnapshot || (r.signatureSnapshots as unknown[] | undefined)?.length ? r : { ...r, signatorySnapshot: pickSignatory(settings, r, order, testById.get(r.testId), approver.get(r.testId) ?? '') }))
  const revision = Number(order.reportRevision ?? 0)
  const modelJson = JSON.stringify(payload)
  const sha256 = sha(modelJson)
  const col = labColl(labId, `orders/${orderId}/reportSnapshots`)
  const latest = (await col.orderBy('createdAt', 'desc').limit(1).get()).docs[0]
  if (latest && latest.data().sha256 === sha256 && latest.data().pdfPath) return { id: latest.id, sha256, revision, created: false }

  const generatedAt = Date.now()
  let pdf: Buffer | null = null
  try {
    pdf = buildReportPdf(payload, { revision, sha256, generatedAt })
  } catch (e) {
    console.error('pdf build failed', e)
  }
  let html = buildReportHtml(payload, { revision, generatedAt })
  if (Buffer.byteLength(html) > 900_000) html = html.slice(0, 890_000) + '</body></html>'
  const base = `labs/${labId}/orders/${orderId}/snapshots/r${revision}-${sha256.slice(0, 10)}`
  let pdfPath = ''
  let modelPath = ''
  try {
    const bucket = getBucket()
    await bucket.file(`${base}.json`).save(modelJson, { contentType: 'application/json', resumable: false })
    modelPath = `${base}.json`
    if (pdf) {
      await bucket.file(`${base}.pdf`).save(pdf, { contentType: 'application/pdf', resumable: false })
      pdfPath = `${base}.pdf`
    }
  } catch (e) {
    console.error('snapshot upload failed', e)
  }
  const ref = latest && latest.data().sha256 === sha256 ? latest.ref : col.doc(`r${revision}-${sha256.slice(0, 10)}`)
  await ref.set({
    revision, trigger, status: String(order.reportStatus ?? ''), sha256, format: 'pdf+html', bytes: Buffer.byteLength(html), html,
    billNo: order.billNo ?? '', tests: payload.results.length, by, branchId: order.branchId ?? 'main', pdfPath, pdfBytes: pdf?.length ?? 0, modelPath,
    createdAt: FieldValue.serverTimestamp(),
  })
  return { id: ref.id, sha256, revision, created: true }
}

export interface PdfFile { buffer: Buffer; filename: string; revision: number; url: string }

// The current approved version as a PDF file (created on demand); url is a 7-day link when signing is possible.
export async function reportPdfBuffer(labId: string, orderId: string): Promise<PdfFile | null> {
  const order = (await db().doc(`labs/${labId}/orders/${orderId}`).get()).data()
  if (!order) return null
  const col = labColl(labId, `orders/${orderId}/reportSnapshots`)
  let latest = (await col.orderBy('createdAt', 'desc').limit(1).get()).docs[0]
  const revision = Number(order.reportRevision ?? 0)
  if (!latest || latest.data().revision !== revision || latest.data().status !== order.reportStatus || !latest.data().pdfPath) {
    await createReportSnapshot(labId, orderId, 'send')
    latest = (await col.orderBy('createdAt', 'desc').limit(1).get()).docs[0]
  }
  const path = latest?.data().pdfPath as string | undefined
  if (!path) return null
  const file = getBucket().file(path)
  const [buffer] = await file.download()
  let url = ''
  try {
    ;[url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 7 * 86_400_000 })
  } catch {
    url = ''
  }
  return { buffer, filename: `report-${String(order.billNo ?? orderId)}-r${revision}.pdf`, revision, url }
}

export const createReportSnapshotNow = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderId?: string }
  const caller = await core.requirePerm(request, data.labId, ['reports.print', 'reports.send'])
  if (!data.orderId || typeof data.orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId is required.')
  return createReportSnapshot(data.labId as string, data.orderId, 'manual', caller.uid)
})

// ---- Smart report saved copy ---------------------------------------------------------------------------------

// A saved smart report that predates an amendment is stale and cannot be sent.
export async function assertSmartCurrent(labId: string, orderId: string, revision: number) {
  const s = (await db().doc(`labs/${labId}/smartReports/${orderId}`).get()).data()
  if (s && Number(s.revision ?? 0) < revision) {
    throw new HttpsError('failed-precondition', 'The saved smart report is out of date because the report was amended. Open the smart report, regenerate it and save it again before sending.')
  }
}

// ---- Public report -------------------------------------------------------------------------------------------

const codeHash = (token: string, code: string) => sha(`${token}:${code}`)

async function loadPayload(labId: string, orderId: string, order: DocumentData, settings: Settings): Promise<{ payload: ReportPayload; verification: { revision: number; sha256: string; at: string | null } | null }> {
  const issued = order.reportStatus === 'final' || order.reportStatus === 'provisional'
  const col = labColl(labId, `orders/${orderId}/reportSnapshots`)
  const revision = Number(order.reportRevision ?? 0)
  if (issued) {
    let latest = (await col.orderBy('createdAt', 'desc').limit(1).get()).docs[0]
    if (!latest || latest.data().revision !== revision || latest.data().status !== order.reportStatus || !latest.data().modelPath) {
      try {
        await createReportSnapshot(labId, orderId, 'public')
        latest = (await col.orderBy('createdAt', 'desc').limit(1).get()).docs[0]
      } catch (e) {
        console.error('on-demand snapshot failed', e)
      }
    }
    const d = latest?.data()
    if (d?.modelPath) {
      try {
        const [buf] = await getBucket().file(d.modelPath).download()
        const at = (d.createdAt as Timestamp | undefined)?.toDate?.().toISOString() ?? null
        return { payload: JSON.parse(buf.toString('utf8')) as ReportPayload, verification: { revision: d.revision ?? 0, sha256: d.sha256 ?? '', at } }
      } catch (e) {
        console.error('snapshot read failed', e)
      }
    }
  }
  const payload = await buildReportPayload({ db: db(), labId, orderId, order, settings: settings as unknown as DocumentData })
  return { payload, verification: null }
}

export const getPublicReport = onCall({ region: REGION }, async (request) => {
  const { token, verify, otp, pin, portal } = (request.data ?? {}) as { token?: unknown; verify?: unknown; otp?: unknown; pin?: unknown; portal?: unknown }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    throw new HttpsError('not-found', 'This report link is not valid.')
  }
  const shareRef = db().doc(`reportShares/${token}`)
  const share = (await shareRef.get()).data()
  if (!share) throw new HttpsError('not-found', 'This report link is not valid.')
  if (share.revoked) throw new HttpsError('not-found', 'This report link has been withdrawn by the lab. Please ask for a new one.')
  if ((share.expiresAt as Timestamp).toMillis() < Date.now()) {
    throw new HttpsError('failed-precondition', 'This report link has expired. Please ask the lab to send a new one.')
  }
  if ((share.failedAttempts ?? 0) >= core.MAX_ATTEMPTS) {
    throw new HttpsError('resource-exhausted', 'Too many incorrect attempts. This link is locked; please contact the lab.')
  }

  const labId = String(share.labId)
  const orderId = String(share.orderId)
  const order = (await db().doc(`labs/${labId}/orders/${orderId}`).get()).data()
  if (!order || order.deleted) throw new HttpsError('not-found', 'This report is no longer available.')
  const settings = await core.loadSettings(labId)
  const layout = mergeLayout(settings.reportLayout)

  const supplied = [verify, otp, pin, portal].some((v) => typeof v === 'string' && v.trim())
  if (!supplied) {
    await core.logAccess(token, request as never, 'status', true)
    const testIds = new Set<string>()
    for (const item of (order.items ?? []) as DocumentData[]) {
      if (item.status === 'refunded') continue
      for (const t of item.testIds ?? []) testIds.add(t)
    }
    const [testSnaps, resultSnaps] = await Promise.all([
      Promise.all([...testIds].map((id) => db().doc(`labs/${labId}/tests/${id}`).get())),
      db().collection(`labs/${labId}/orders/${orderId}/results`).get(),
    ])
    const resultDocs = resultSnaps.docs.map((d) => ({ id: d.id, ...d.data() }) as DocumentData & { id: string })
    return {
      mode: 'status',
      lab: { name: settings.name, address: settings.address, phone: settings.phone, email: settings.email, logoDataUrl: settings.profile.logoDataUrl },
      patientName: core.maskName(String(order.patientName ?? '')),
      billNo: order.billNo ?? '',
      reportStatus: order.reportStatus ?? 'pending',
      tests: testSnaps.filter((s) => s.exists).map((s) => ({ name: String(s.data()?.name ?? ''), ready: resultDocs.some((r) => r.id === s.id && r.status === 'approved') })),
      expiresAt: core.iso(share.expiresAt),
      factors: { otp: layout.publicOtp, pin: layout.publicBillPin, legacy: layout.publicOtp !== 'required' },
    }
  }

  const patient = (await db().doc(`labs/${labId}/patients/${order.patientId}`).get()).data() ?? {}
  let ok = false
  let mode = 'verify'
  if (typeof portal === 'string' && portal) {
    const sess = (await db().doc(`portalSessions/${portal}`).get()).data()
    ok = !!sess && sess.labId === labId && (sess.expiresAt as Timestamp).toMillis() > Date.now() && ((sess.patientIds ?? []) as string[]).includes(String(order.patientId))
    mode = 'portal'
  } else if (typeof otp === 'string' && otp) {
    mode = 'otp'
    const exp = (share.otpExpiresAt as Timestamp | undefined)?.toMillis() ?? 0
    ok = layout.publicOtp !== 'off' && !!share.otpHash && exp > Date.now() && share.otpHash === codeHash(token, otp.trim())
    if (ok) await shareRef.update({ otpHash: FieldValue.delete(), otpExpiresAt: FieldValue.delete() })
  } else if (typeof pin === 'string' && pin) {
    mode = 'pin'
    const secretDoc = (await db().doc(`labs/${labId}/orderSecrets/${orderId}`).get()).data()
    ok = layout.publicBillPin && !!secretDoc?.pin && String(secretDoc.pin) === pin.trim()
  } else if (typeof verify === 'string' && layout.publicOtp !== 'required') {
    const code = verify.trim().toLowerCase()
    const phoneDigits = String(patient.phone ?? '').replace(/\D/g, '')
    const patientNo = String(order.patientNo ?? patient.patientNo ?? '').toLowerCase()
    const okPhone = /^\d{4}$/.test(code) && phoneDigits.length >= 4 && phoneDigits.slice(-4) === code
    const okNo = code.length > 0 && patientNo !== '' && code === patientNo
    const dobIso = /^\d{4}-\d{2}-\d{2}$/.test(String(patient.dob ?? '')) ? String(patient.dob) : ''
    const dm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(code)
    const typedDob = dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : /^\d{4}-\d{2}-\d{2}$/.test(code) ? code : ''
    ok = okPhone || okNo || (dobIso !== '' && typedDob === dobIso)
  }
  if (!ok) {
    await shareRef.update({ failedAttempts: FieldValue.increment(1) })
    await core.logAccess(token, request as never, mode, false)
    const left = core.MAX_ATTEMPTS - ((share.failedAttempts ?? 0) + 1)
    throw new HttpsError(
      left <= 0 ? 'resource-exhausted' : 'permission-denied',
      left <= 0 ? 'Too many incorrect attempts. This link is locked; please contact the lab.' : `That does not match our records. ${left} attempt${left === 1 ? '' : 's'} left.`,
    )
  }
  await core.logAccess(token, request as never, mode, true)

  const { payload, verification } = await loadPayload(labId, orderId, order, settings)
  const rf = order.hasReportFile ? (await db().doc(`labs/${labId}/orders/${orderId}/reportFiles/main`).get()).data() : null
  let reportFile: { name: string; dataUrl: string } | null = null
  if (rf) {
    if (rf.dataUrl) reportFile = { name: rf.name ?? 'report.pdf', dataUrl: rf.dataUrl }
    else if (rf.path) {
      try {
        const [buf] = await getBucket().file(String(rf.path)).download()
        if (buf.length <= 6_000_000) reportFile = { name: rf.name ?? 'report.pdf', dataUrl: `data:application/pdf;base64,${buf.toString('base64')}` }
      } catch {
        reportFile = null
      }
    }
  }
  const smart = (await db().doc(`labs/${labId}/smartReports/${orderId}`).get()).data()
  const revision = Number(order.reportRevision ?? 0)
  const o = payload.order as Record<string, unknown>
  return {
    ...payload,
    // Live status always wins over the frozen copy for the banner (provisional to final is a new snapshot anyway).
    order: { ...o, qrShareToken: token },
    reportFile,
    verification,
    smart: smart ? { revision: smart.revision ?? 0, stale: Number(smart.revision ?? 0) < revision, variant: smart.variant ?? 'standard', notes: smart.notes ?? [] } : null,
    expiresAt: core.iso(share.expiresAt),
  }
})

// Patient asks for a one-time code on the report link; the code is delivered through the dispatch path.
async function sendCode(labId: string, settings: Settings, phone: string, email: string, code: string, ref: { orderId?: string }): Promise<{ channel: string; to: string; status: string } | null> {
  const text = `${code} is your one-time code to open your report from ${settings.name}. It is valid for 10 minutes. Do not share it.`
  const vars: [string, string][] = [['otp', code], ['labName', settings.name]]
  const tries: { channel: core.Channel; to: string }[] = []
  if (phone) tries.push({ channel: 'whatsapp', to: phone }, { channel: 'sms', to: phone })
  else if (email) tries.push({ channel: 'email', to: email })
  for (const t of tries) {
    const msg: OutgoingMessage = { kind: 'otp', to: t.to, text, subject: `${settings.name}: your one-time code`, vars, waTemplate: 'otp_code' }
    const d = await core.dispatchOne(labId, t.channel, msg, settings, ref)
    if (d.result.status !== 'failed') return { channel: t.channel, to: maskTo(t.to), status: d.result.status }
  }
  return null
}
const code6 = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

export const requestReportOtp = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const { token } = (request.data ?? {}) as { token?: unknown }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new HttpsError('not-found', 'This report link is not valid.')
  const shareRef = db().doc(`reportShares/${token}`)
  const share = (await shareRef.get()).data()
  if (!share || share.revoked || (share.expiresAt as Timestamp).toMillis() < Date.now()) throw new HttpsError('not-found', 'This report link is not valid.')
  const labId = String(share.labId)
  const settings = await core.loadSettings(labId)
  if (mergeLayout(settings.reportLayout).publicOtp === 'off') throw new HttpsError('failed-precondition', 'Codes are not enabled for this lab.')
  const last = (share.otpRequestedAt as Timestamp | undefined)?.toMillis() ?? 0
  if (Date.now() - last < 60_000) throw new HttpsError('resource-exhausted', 'A code was just sent. Please wait a minute before asking again.')
  if ((share.otpCount ?? 0) >= 8) throw new HttpsError('resource-exhausted', 'Too many codes were requested for this link. Please contact the lab.')
  const order = (await db().doc(`labs/${labId}/orders/${share.orderId}`).get()).data()
  if (!order || order.deleted) throw new HttpsError('not-found', 'This report is no longer available.')
  const patient = (await db().doc(`labs/${labId}/patients/${order.patientId}`).get()).data() ?? {}
  const phone = String(patient.phone ?? '').trim()
  const email = String(patient.email ?? '').trim()
  if (!phone && !email) throw new HttpsError('failed-precondition', 'The lab has no phone number or email for this patient. Please use another way to open the report.')
  const code = code6()
  const sent = await sendCode(labId, settings, phone, email, code, { orderId: String(share.orderId) })
  await shareRef.update({ otpHash: codeHash(token, code), otpExpiresAt: Timestamp.fromMillis(Date.now() + 600_000), otpRequestedAt: Timestamp.now(), otpCount: FieldValue.increment(1) })
  if (!sent) throw new HttpsError('unavailable', 'The code could not be sent right now. Please try again.')
  return { sent: true, to: sent.to, channel: sent.channel }
})

// ---- Bill PIN ------------------------------------------------------------------------------------------------

// Staff: the bill's access PIN (created on first use). Printed on the bill and accepted on the public report page.
export const ensureBillPin = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderId?: string }
  await core.requirePerm(request, data.labId, ['reports.print', 'reports.send', 'patients.view', 'billing.create'])
  if (!data.orderId || typeof data.orderId !== 'string' || !LAB_ID_RE.test(data.orderId)) throw new HttpsError('invalid-argument', 'orderId is required.')
  const ref = db().doc(`labs/${data.labId}/orderSecrets/${data.orderId}`)
  const cur = (await ref.get()).data()
  if (cur?.pin) return { pin: String(cur.pin) }
  const order = (await db().doc(`labs/${data.labId}/orders/${data.orderId}`).get()).data()
  if (!order) throw new HttpsError('not-found', 'Bill not found.')
  const pin = code6()
  await ref.set({ pin, createdAt: FieldValue.serverTimestamp() })
  return { pin }
})

// ---- Patient portal v2 (phone OTP) ---------------------------------------------------------------------------

const last10 = (p: string) => p.replace(/\D/g, '').slice(-10)
const phoneVariants = (p: string) => {
  const d = last10(p)
  return d.length === 10 ? [d, `+91${d}`, `91${d}`, `0${d}`, `+91 ${d}`] : []
}
const phoneKey = (labId: string, p: string) => `${labId}_${sha(`${labId}:${last10(p)}`).slice(0, 40)}`

export const requestPortalOtp = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const { labId, phone } = (request.data ?? {}) as { labId?: unknown; phone?: unknown }
  if (typeof labId !== 'string' || !LAB_ID_RE.test(labId) || typeof phone !== 'string') throw new HttpsError('invalid-argument', 'Enter your mobile number.')
  if (last10(phone).length !== 10) throw new HttpsError('invalid-argument', 'Enter a 10-digit mobile number.')
  const ref = db().doc(`portalOtps/${phoneKey(labId, phone)}`)
  const cur = (await ref.get()).data()
  if (cur && Date.now() - ((cur.requestedAt as Timestamp | undefined)?.toMillis() ?? 0) < 60_000) throw new HttpsError('resource-exhausted', 'A code was just sent. Please wait a minute before asking again.')
  if (cur && (cur.count ?? 0) >= 10 && Date.now() - ((cur.dayStart as Timestamp | undefined)?.toMillis() ?? 0) < 86_400_000) throw new HttpsError('resource-exhausted', 'Too many codes were requested today. Please try tomorrow.')
  // The answer is the same whether or not this number has reports, so numbers cannot be probed.
  const found = await labColl(labId, 'patients').where('phone', 'in', phoneVariants(phone)).limit(20).get()
  const code = code6()
  await ref.set({
    labId, hash: sha(`${phoneKey(labId, phone)}:${code}`), expiresAt: Timestamp.fromMillis(Date.now() + 600_000), attempts: 0, requestedAt: Timestamp.now(),
    count: (cur?.count ?? 0) + 1, dayStart: cur?.dayStart ?? Timestamp.now(), patientIds: found.docs.map((d) => d.id),
  })
  if (!found.empty) {
    const settings = await core.loadSettings(labId)
    await sendCode(labId, settings, phone.trim(), '', code, {})
  }
  return { sent: true, to: maskTo(phone) }
})

export const verifyPortalOtp = onCall({ region: REGION }, async (request) => {
  const { labId, phone, code } = (request.data ?? {}) as { labId?: unknown; phone?: unknown; code?: unknown }
  if (typeof labId !== 'string' || !LAB_ID_RE.test(labId) || typeof phone !== 'string' || typeof code !== 'string') throw new HttpsError('invalid-argument', 'Enter the code.')
  const ref = db().doc(`portalOtps/${phoneKey(labId, phone)}`)
  const cur = (await ref.get()).data()
  if (!cur || !cur.hash || (cur.expiresAt as Timestamp).toMillis() < Date.now()) throw new HttpsError('failed-precondition', 'The code has expired. Ask for a new one.')
  if ((cur.attempts ?? 0) >= 5) throw new HttpsError('resource-exhausted', 'Too many wrong codes. Ask for a new one.')
  if (cur.hash !== sha(`${phoneKey(labId, phone)}:${code.trim()}`) || !(cur.patientIds ?? []).length) {
    await ref.update({ attempts: FieldValue.increment(1) })
    throw new HttpsError('permission-denied', 'That code does not match.')
  }
  await ref.update({ hash: FieldValue.delete() })
  const session = randomBytes(24).toString('base64url')
  await db().doc(`portalSessions/${session}`).set({ labId, patientIds: cur.patientIds, expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60_000), createdAt: Timestamp.now() })
  return { session }
})

export const listPortalReports = onCall({ region: REGION }, async (request) => {
  const { session } = (request.data ?? {}) as { session?: unknown }
  if (typeof session !== 'string' || !/^[\w-]{16,64}$/.test(session)) throw new HttpsError('unauthenticated', 'Please sign in again.')
  const s = (await db().doc(`portalSessions/${session}`).get()).data()
  if (!s || (s.expiresAt as Timestamp).toMillis() < Date.now()) throw new HttpsError('unauthenticated', 'Your session has ended. Please sign in again.')
  const labId = String(s.labId)
  const settings = await core.loadSettings(labId)
  const rows: DocumentData[] = []
  for (const pid of (s.patientIds ?? []) as string[]) {
    const orders = await labColl(labId, 'orders').where('patientId', '==', pid).get()
    for (const d of orders.docs) {
      const o = d.data()
      if (o.deleted || !['final', 'provisional', 'partial'].includes(String(o.reportStatus))) continue
      rows.push({
        orderId: d.id, billNo: o.billNo ?? '', patientName: o.patientName ?? '', status: o.reportStatus, date: core.iso(o.billDate ?? o.createdAt),
        reportedAt: core.iso(o.reportedAt), tests: ((o.items ?? []) as DocumentData[]).map((i) => String(i.name ?? '')).filter(Boolean).slice(0, 6),
        token: await core.getOrCreateShare(labId, d.id, settings.reportLinkDays),
      })
    }
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return { lab: { name: settings.name, phone: settings.phone }, reports: rows.slice(0, 200) }
})

// ---- Email sender verification ------------------------------------------------------------------------------

export const requestEmailSenderVerification = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; fromName?: string; fromEmail?: string }
  await core.requirePerm(request, data.labId, ['settings.manage', 'labprofile.edit'])
  const labId = data.labId as string
  const email = String(data.fromEmail ?? '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Enter a valid sender email address.')
  const settings = await core.loadSettings(labId)
  const code = code6()
  await db().doc(`labs/${labId}/serverSecrets/emailSender`).set({ email, hash: sha(`${email}:${code}`), expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000), attempts: 0 })
  await db().doc(`labs/${labId}`).set({ emailSender: { fromName: String(data.fromName ?? '').trim(), fromEmail: email, status: 'pending', requestedAt: Timestamp.now() } }, { merge: true })
  const msg: OutgoingMessage = {
    kind: 'otp', to: email, text: `${code} is the code to verify ${email} as a sender address for ${settings.name}. It is valid for 24 hours.`,
    subject: `${settings.name}: verify your sender email`, vars: [['otp', code]], waTemplate: '',
  }
  const d = await core.dispatchOne(labId, 'email', msg, settings, {})
  return { status: d.result.status, to: maskTo(email) }
})

export const confirmEmailSender = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; code?: string }
  await core.requirePerm(request, data.labId, ['settings.manage', 'labprofile.edit'])
  const labId = data.labId as string
  const ref = db().doc(`labs/${labId}/serverSecrets/emailSender`)
  const cur = (await ref.get()).data()
  if (!cur || (cur.expiresAt as Timestamp).toMillis() < Date.now()) throw new HttpsError('failed-precondition', 'The code has expired. Request a new one.')
  if ((cur.attempts ?? 0) >= 5) throw new HttpsError('resource-exhausted', 'Too many wrong codes. Request a new one.')
  if (cur.hash !== sha(`${cur.email}:${String(data.code ?? '').trim()}`)) {
    await ref.update({ attempts: FieldValue.increment(1) })
    throw new HttpsError('permission-denied', 'That code does not match.')
  }
  await ref.delete()
  await db().doc(`labs/${labId}`).set({ emailSender: { fromEmail: cur.email, verifiedEmail: cur.email, status: 'verified', verifiedAt: Timestamp.now() } }, { merge: true })
  return { status: 'verified' }
})

// ---- PCPNDT Form F e-signature ------------------------------------------------------------------------------

export const createFormFLink = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderId?: string }
  await core.requirePerm(request, data.labId, ['billing.edit', 'results.enter', 'patients.view'])
  const labId = data.labId as string
  if (!data.orderId || !LAB_ID_RE.test(data.orderId)) throw new HttpsError('invalid-argument', 'orderId is required.')
  const form = (await db().doc(`labs/${labId}/formF/${data.orderId}`).get()).data()
  if (!form) throw new HttpsError('failed-precondition', 'Save Form F first, then create the signing link.')
  const token = randomBytes(24).toString('base64url')
  const expiresAt = Timestamp.fromMillis(Date.now() + 48 * 3_600_000)
  await db().doc(`formFTokens/${token}`).set({ labId, orderId: data.orderId, expiresAt, used: false, createdAt: Timestamp.now() })
  await db().doc(`labs/${labId}/formF/${data.orderId}`).update({ status: 'awaitingSignature', signToken: token, signLinkExpiresAt: expiresAt })
  await db().doc(`labs/${labId}/orders/${data.orderId}`).update({ formFStatus: 'pending' })
  const settings = await core.loadSettings(labId)
  const base = (settings.publicAppUrl || String(request.rawRequest?.headers?.origin ?? '')).replace(/\/+$/, '')
  return { token, url: `${base}/formf/${token}`, expiresAt: expiresAt.toDate().toISOString() }
})

async function formFByToken(token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new HttpsError('not-found', 'This link is not valid.')
  const t = (await db().doc(`formFTokens/${token}`).get()).data()
  if (!t) throw new HttpsError('not-found', 'This link is not valid.')
  if (t.used) throw new HttpsError('failed-precondition', 'This form has already been signed.')
  if ((t.expiresAt as Timestamp).toMillis() < Date.now()) throw new HttpsError('failed-precondition', 'This link has expired. Please ask the clinic for a new one.')
  return { t, labId: String(t.labId), orderId: String(t.orderId), token: token }
}

export const getFormFSign = onCall({ region: REGION }, async (request) => {
  const { token } = (request.data ?? {}) as { token?: unknown }
  const { labId, orderId } = await formFByToken(token)
  const form = (await db().doc(`labs/${labId}/formF/${orderId}`).get()).data()
  if (!form) throw new HttpsError('not-found', 'This form is no longer available.')
  const settings = await core.loadSettings(labId)
  return { lab: { name: settings.name, address: settings.address }, patientName: form.patientName ?? '', fields: form.fields ?? {}, billNo: form.billNo ?? '' }
})

export const submitFormFSign = onCall({ region: REGION }, async (request) => {
  const { token, signatureDataUrl, signerName, agree } = (request.data ?? {}) as { token?: unknown; signatureDataUrl?: unknown; signerName?: unknown; agree?: unknown }
  const { labId, orderId, token: tk } = await formFByToken(token)
  if (agree !== true) throw new HttpsError('invalid-argument', 'Please confirm the declaration.')
  if (typeof signerName !== 'string' || signerName.trim().length < 2) throw new HttpsError('invalid-argument', 'Type your full name.')
  if (typeof signatureDataUrl !== 'string' || !/^data:image\/png;base64,/.test(signatureDataUrl) || signatureDataUrl.length > 200_000) throw new HttpsError('invalid-argument', 'Draw your signature.')
  const ip = String(request.rawRequest?.ip ?? '')
  await db().doc(`labs/${labId}/formF/${orderId}`).update({
    status: 'complete', signatureDataUrl, signerName: signerName.trim().slice(0, 120), signedAt: FieldValue.serverTimestamp(), signedVia: 'link',
    ipHash: ip ? sha(ip).slice(0, 16) : '', signToken: FieldValue.delete(),
  })
  await db().doc(`labs/${labId}/orders/${orderId}`).update({ formFStatus: 'complete' })
  await db().doc(`formFTokens/${tk}`).update({ used: true, usedAt: Timestamp.now() })
  return { ok: true }
})

// ---- Report versions: signature snapshot + amendment tracking ----------------------------------------------

export const onResultApproved = onDocumentWritten(
  { document: 'labs/{labId}/orders/{orderId}/results/{testId}', database: FIRESTORE_DB, region: REGION },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    if (!after || after.status !== 'approved' || before?.status === 'approved') return
    const { labId, orderId, testId } = event.params
    const orderRef = db().doc(`labs/${labId}/orders/${orderId}`)
    const order = (await orderRef.get()).data()
    if (!order) return
    const settings = await core.loadSettings(labId)
    const test = (await db().doc(`labs/${labId}/tests/${testId}`).get()).data()
    const snapshot = pickSignatory(settings, after, order, test, String(after.approvedBy ?? ''))
    const prior = await db().collection(`labs/${labId}/orders/${orderId}/reportVersions`).where('testId', '==', testId).get()
    const amended = prior.size > 0
    const revision = prior.size
    await db().collection(`labs/${labId}/orders/${orderId}/reportVersions`).add({
      testId,
      testName: after.testName ?? test?.name ?? '',
      revision,
      trigger: amended ? 'amend' : 'approve',
      values: after.values ?? {},
      comment: after.comment ?? '',
      radiology: after.radiology ? { ...after.radiology, images: [] } : null,
      signatory: snapshot,
      approvedBy: after.approvedBy ?? '',
      approvedByName: after.approvedByName ?? '',
      createdAt: FieldValue.serverTimestamp(),
    })
    if (snapshot) await event.data!.after.ref.update({ signatorySnapshot: snapshot })
    if (amended) {
      const patch: DocumentData = {
        reportRevision: FieldValue.increment(1),
        amendedAt: Timestamp.now(),
        amendSummary: `Revised result: ${after.testName ?? test?.name ?? 'test'}`,
      }
      // Earlier dispatches carried the old version: queue the bill for redelivery.
      const dispatch = (order.dispatch ?? []) as DocumentData[]
      if (dispatch.some((d) => d.delivered)) {
        patch.dispatch = dispatch.map((d) => ({ ...d, delivered: false, deliveredAt: null, superseded: true }))
        patch.dispatched = false
        patch.dispatchStatus = 'pending'
      }
      await orderRef.update(patch)
    }
    // A saved smart report stops matching once a result is amended: it is marked stale, not silently rewritten.
    if (amended) await db().doc(`labs/${labId}/smartReports/${orderId}`).set({ staleSince: FieldValue.serverTimestamp() }, { merge: true }).catch(() => undefined)
    // Every release after the bill is provisional or final refreshes the stored copy (identical content is skipped).
    const fresh = (await orderRef.get()).data()
    if (fresh && (fresh.reportStatus === 'final' || fresh.reportStatus === 'provisional')) {
      await createReportSnapshot(labId, orderId, amended ? 'amend' : 'approve').catch((e) => console.error('snapshot failed', e))
    }
  },
)

// ---- Radiology: external second opinion and co-sign ------------------------------------------------------------

async function opinionByToken(token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new HttpsError('not-found', 'This link is not valid.')
  const t = (await db().doc(`radOpinionTokens/${token}`).get()).data()
  if (!t) throw new HttpsError('not-found', 'This link is not valid.')
  if (t.used) throw new HttpsError('failed-precondition', 'An opinion was already submitted for this study.')
  if ((t.expiresAt as Timestamp).toMillis() < Date.now()) throw new HttpsError('failed-precondition', 'This link has expired. Ask the lab to send a new one.')
  return { labId: String(t.labId), orderId: String(t.orderId), testId: String(t.testId), token }
}

// Staff: ask an outside consultant for a second opinion; the consultant gets an email with a private link.
export const requestExternalOpinion = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string; orderId?: string; testId?: string; name?: string; email?: string; note?: string }
  const caller = await core.requirePerm(request, data.labId, ['results.enter', 'results.approve'])
  const labId = data.labId as string
  if (!data.orderId || !LAB_ID_RE.test(data.orderId) || !data.testId || !LAB_ID_RE.test(data.testId)) throw new HttpsError('invalid-argument', 'orderId and testId are required.')
  const email = String(data.email ?? '').trim()
  const name = String(data.name ?? '').trim()
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Enter the consultant name and a valid email address.')
  const resRef = db().doc(`labs/${labId}/orders/${data.orderId}/results/${data.testId}`)
  const res = (await resRef.get()).data()
  if (!res?.radiology) throw new HttpsError('failed-precondition', 'Save the report before asking for an opinion.')
  const settings = await core.loadSettings(labId)
  const token = randomBytes(24).toString('base64url')
  await db().doc(`radOpinionTokens/${token}`).set({ labId, orderId: data.orderId, testId: data.testId, email, used: false, expiresAt: Timestamp.fromMillis(Date.now() + 7 * 86_400_000), createdAt: Timestamp.now() })
  await resRef.update({
    'radiology.secondOpinion': {
      doctorId: `ext:${email}`, doctorName: name, note: String(data.note ?? '').slice(0, 1000), requestedBy: caller.uid, requestedByName: caller.name, requestedAt: Date.now(),
      status: 'requested', opinion: '', external: true, externalEmail: email,
    },
  })
  const base = (settings.publicAppUrl || String(request.rawRequest?.headers?.origin ?? '')).replace(/\/+$/, '')
  const link = `${base}/rad-opinion/${token}`
  const msg: OutgoingMessage = {
    kind: 'alert', to: email, link, subject: `${settings.name}: second opinion requested`, vars: [['labName', settings.name], ['link', link]], waTemplate: '',
    text: `Dear ${name}, ${settings.name} asks for your second opinion on an imaging study. Open this private link to read the report and reply: ${link}\nThe link is valid for 7 days.${data.note ? `\n\nNote from the lab: ${String(data.note).slice(0, 500)}` : ''}`,
  }
  const d = await core.dispatchOne(labId, 'email', msg, settings, { orderId: data.orderId })
  return { status: d.result.status, to: maskTo(email) }
})

export const getExternalOpinion = onCall({ region: REGION }, async (request) => {
  const { labId, orderId, testId, token } = await opinionByToken((request.data as { token?: unknown } | undefined)?.token)
  const [order, res, test, settings] = await Promise.all([
    db().doc(`labs/${labId}/orders/${orderId}`).get().then((s) => s.data()),
    db().doc(`labs/${labId}/orders/${orderId}/results/${testId}`).get().then((s) => s.data()),
    db().doc(`labs/${labId}/tests/${testId}`).get().then((s) => s.data()),
    core.loadSettings(labId),
  ])
  if (!order || !res?.radiology) throw new HttpsError('not-found', 'This study is no longer available.')
  const rad = res.radiology as DocumentData
  const bucket = getBucket()
  const images: DocumentData[] = []
  for (const im of ((rad.images ?? []) as DocumentData[]).slice(0, 4)) {
    if (im.dataUrl) images.push({ caption: im.caption ?? '', dataUrl: im.dataUrl })
    else if (im.path) {
      try {
        const [buf] = await bucket.file(String(im.path)).download()
        if (buf.length < 1_500_000) images.push({ caption: im.caption ?? '', dataUrl: `data:${im.contentType || 'image/jpeg'};base64,${buf.toString('base64')}` })
      } catch { /* image unavailable */ }
    }
  }
  void token
  return {
    lab: { name: settings.name },
    study: { name: test?.name ?? res.testName ?? '', modality: rad.modality ?? '', bodyPart: rad.bodyPart ?? '' },
    // Identity is limited to initials, age and sex for an outside reader.
    patient: { initials: String(order.patientName ?? '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('.').toUpperCase(), age: `${order.ageValue ?? ''} ${order.ageUnit ?? ''}`, gender: order.gender ?? '' },
    technique: rad.technique ?? '', findings: rad.findings ?? '', impression: rad.impression ?? '', images,
    note: rad.secondOpinion?.note ?? '', consultant: rad.secondOpinion?.doctorName ?? '',
  }
})

export const submitExternalOpinion = onCall({ region: REGION }, async (request) => {
  const { token: raw, name, regNo, opinion, cosign } = (request.data ?? {}) as { token?: unknown; name?: unknown; regNo?: unknown; opinion?: unknown; cosign?: unknown }
  const { labId, orderId, testId, token } = await opinionByToken(raw)
  if (typeof name !== 'string' || name.trim().length < 2) throw new HttpsError('invalid-argument', 'Enter your name.')
  if (typeof opinion !== 'string' || opinion.trim().length < 3) throw new HttpsError('invalid-argument', 'Write your opinion.')
  const resRef = db().doc(`labs/${labId}/orders/${orderId}/results/${testId}`)
  const cur = (await resRef.get()).data()?.radiology?.secondOpinion as DocumentData | undefined
  if (!cur) throw new HttpsError('failed-precondition', 'This request was withdrawn.')
  await resRef.update({
    'radiology.secondOpinion': {
      ...cur, status: 'given', opinion: opinion.trim().slice(0, 4000), doctorName: name.trim().slice(0, 120), externalRegNo: String(regNo ?? '').slice(0, 60),
      cosigned: cosign === true, cosignedByName: cosign === true ? name.trim().slice(0, 120) : '', givenAt: Date.now(),
    },
  })
  await db().doc(`radOpinionTokens/${token}`).update({ used: true, usedAt: Timestamp.now() })
  const order = (await db().doc(`labs/${labId}/orders/${orderId}`).get()).data()
  if (order && (order.reportStatus === 'final' || order.reportStatus === 'provisional')) await createReportSnapshot(labId, orderId, 'cosign').catch(() => undefined)
  return { ok: true }
})
