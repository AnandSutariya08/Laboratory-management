import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../../firebase'

const call = <I, O>(name: string) => httpsCallable<I, O>(functions, name)

// Public report second factor: a one-time code delivered by the server dispatch path.
export const requestReportOtp = (token: string) =>
  call<{ token: string }, { sent: boolean; to: string; channel: string }>('requestReportOtp')({ token }).then((r) => r.data)

// Bill PIN (staff): printed on the bill, accepted on the public report page.
export const ensureBillPin = (orderId: string) =>
  call<{ labId: string; orderId: string }, { pin: string }>('ensureBillPin')({ labId: LAB_ID, orderId }).then((r) => r.data.pin)

// Patient portal (phone OTP).
export const requestPortalOtp = (phone: string) => call<{ labId: string; phone: string }, { sent: boolean; to: string }>('requestPortalOtp')({ labId: LAB_ID, phone }).then((r) => r.data)
export const verifyPortalOtp = (phone: string, code: string) => call<{ labId: string; phone: string; code: string }, { session: string }>('verifyPortalOtp')({ labId: LAB_ID, phone, code }).then((r) => r.data.session)
export interface PortalReport { orderId: string; billNo: string; patientName: string; status: string; date: string | null; reportedAt: string | null; tests: string[]; token: string }
export const listPortalReports = (session: string) =>
  call<{ session: string }, { lab: { name: string; phone: string }; reports: PortalReport[] }>('listPortalReports')({ session }).then((r) => r.data)

// Email sender verification (lab profile).
export const requestEmailSenderVerification = (fromName: string, fromEmail: string) =>
  call<{ labId: string; fromName: string; fromEmail: string }, { status: string; to: string }>('requestEmailSenderVerification')({ labId: LAB_ID, fromName, fromEmail }).then((r) => r.data)
export const confirmEmailSender = (code: string) => call<{ labId: string; code: string }, { status: string }>('confirmEmailSender')({ labId: LAB_ID, code }).then((r) => r.data)

// PCPNDT Form F signing by link / QR.
export const createFormFLink = (orderId: string) =>
  call<{ labId: string; orderId: string }, { token: string; url: string; expiresAt: string }>('createFormFLink')({ labId: LAB_ID, orderId }).then((r) => r.data)
export const getFormFSign = (token: string) =>
  call<{ token: string }, { lab: { name: string; address: string }; patientName: string; billNo: string; fields: Record<string, string> }>('getFormFSign')({ token }).then((r) => r.data)
export const submitFormFSign = (input: { token: string; signatureDataUrl: string; signerName: string; agree: boolean }) =>
  call<typeof input, { ok: boolean }>('submitFormFSign')(input).then((r) => r.data)
