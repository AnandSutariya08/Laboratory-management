import { defineSecret } from 'firebase-functions/params'

// Provider credentials: Secret Manager only. Missing/empty => dev mode (outbox).
export const REGION = 'asia-south1'
// Named Firestore database (prod: 'health-care-labs' in asia-south1). Override with FIRESTORE_DB in functions/.env.
export const FIRESTORE_DB = process.env.FIRESTORE_DB || 'health-care-labs'
export const WHATSAPP_TOKEN = defineSecret('WHATSAPP_TOKEN')
export const WHATSAPP_PHONE_NUMBER_ID = defineSecret('WHATSAPP_PHONE_NUMBER_ID')
export const MSG91_AUTH_KEY = defineSecret('MSG91_AUTH_KEY')
export const MSG91_REPORT_TEMPLATE_ID = defineSecret('MSG91_REPORT_TEMPLATE_ID')
export const MSG91_BOOKING_TEMPLATE_ID = defineSecret('MSG91_BOOKING_TEMPLATE_ID')
export const SMTP_URL = defineSecret('SMTP_URL')
export const MAIL_FROM = defineSecret('MAIL_FROM')
// Encrypts recipient addresses kept for retries in delivery logs. Empty => a per-lab development key.
export const LOG_KEY = defineSecret('LOG_KEY')
export const SECRETS = [
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  MSG91_AUTH_KEY,
  MSG91_REPORT_TEMPLATE_ID,
  MSG91_BOOKING_TEMPLATE_ID,
  SMTP_URL,
  MAIL_FROM,
  LOG_KEY,
]

// A provider that is not set up yet holds the placeholder NOT_SET (Firebase needs every declared secret to exist
// before it deploys); it reads as empty, i.e. "not configured".
export const PLACEHOLDER = 'NOT_SET'
export const clean = (v: string | undefined | null): string => {
  const t = (v ?? '').trim()
  return t === PLACEHOLDER ? '' : t
}

export const secret = (s: { value(): string }): string => {
  try {
    return clean(s.value())
  } catch {
    return ''
  }
}
