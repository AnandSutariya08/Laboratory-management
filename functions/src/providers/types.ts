// Shared by the three channel providers.
export type MessageKind = 'report' | 'booking' | 'daily' | 'bill' | 'alert' | 'quotation' | 'otp'

export interface OutgoingMessage {
  kind: MessageKind
  to: string // phone (any format) or email address
  text: string // fully rendered body (used by email and the dev-mode outbox)
  subject: string
  // Template variables in a fixed order. WhatsApp sends the values positionally
  // ({{1}}, {{2}}, ...), MSG91 sends them by name.
  vars: [string, string][]
  link?: string
  // Approved WhatsApp template name (settings.templates.waReportTemplate / waBookingTemplate).
  waTemplate: string
  // Report PDF: attached to email; for WhatsApp a template with a document header carries documentUrl.
  attachments?: { filename: string; content: Buffer; contentType: string }[]
  documentUrl?: string
  documentName?: string
}

export interface ProviderResult {
  ok: boolean
  providerId: string
  error?: string
}

// Normalise to digits with country code (India default for 10-digit numbers).
export function intlPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`
  return digits
}
