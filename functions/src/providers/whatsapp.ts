import { intlPhone, type OutgoingMessage, type ProviderResult } from './types'

export interface WhatsappConfig {
  token: string
  phoneNumberId: string
}

// Meta WhatsApp Cloud API. Business-initiated messages must use an approved
// template; body variables are sent positionally in the order of msg.vars.
export async function sendWhatsapp(cfg: WhatsappConfig, msg: OutgoingMessage): Promise<ProviderResult> {
  const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: intlPhone(msg.to),
      type: 'template',
      template: {
        name: msg.waTemplate,
        language: { code: 'en' },
        components: [
          ...(msg.documentUrl ? [{ type: 'header', parameters: [{ type: 'document', document: { link: msg.documentUrl, filename: msg.documentName || 'report.pdf' } }] }] : []),
          {
            type: 'body',
            parameters: msg.vars.map(([, value]) => ({ type: 'text', text: value || '-' })),
          },
        ],
      },
    }),
  })
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[]
    error?: { message?: string }
  }
  if (!res.ok) return { ok: false, providerId: '', error: json.error?.message ?? `WhatsApp HTTP ${res.status}` }
  return { ok: true, providerId: json.messages?.[0]?.id ?? '' }
}
