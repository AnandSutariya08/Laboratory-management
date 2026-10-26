import { intlPhone, type OutgoingMessage, type ProviderResult } from './types'

export interface SmsConfig {
  authKey: string
  templateId: string // DLT-registered MSG91 flow template for this message kind
}

// MSG91 Flow API. The template must be DLT-approved; its ##variables## are
// filled from the named vars of the message (patientName, billNo, link, ...).
export async function sendSms(cfg: SmsConfig, msg: OutgoingMessage): Promise<ProviderResult> {
  const recipient: Record<string, string> = { mobiles: intlPhone(msg.to) }
  for (const [name, value] of msg.vars) recipient[name] = value
  const res = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey: cfg.authKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ template_id: cfg.templateId, short_url: '0', recipients: [recipient] }),
  })
  const json = (await res.json().catch(() => ({}))) as { type?: string; message?: string }
  if (!res.ok || json.type === 'error') {
    return { ok: false, providerId: '', error: json.message ?? `MSG91 HTTP ${res.status}` }
  }
  return { ok: true, providerId: json.message ?? '' } // MSG91 returns the request id in "message"
}
