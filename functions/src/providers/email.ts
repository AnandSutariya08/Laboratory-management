import nodemailer from 'nodemailer'
import type { OutgoingMessage, ProviderResult } from './types'

export interface EmailConfig {
  smtpUrl: string // smtp(s)://user:pass@host:port
  from: string // e.g. "Health Care Labs <reports@lab.example.com>"
  // A lab sender that passed verification: shown as the display name, and replies go to its address.
  sender?: { name: string; email: string }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderHtml(msg: OutgoingMessage, labName: string): string {
  const body = esc(msg.text).replace(/\n/g, '<br>')
  const button = msg.link
    ? `<p style="margin:24px 0"><a href="${esc(msg.link)}" style="background:#0EA5E9;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;display:inline-block">${
        msg.kind === 'report' ? 'View your report' : 'Open'
      }</a></p>`
    : ''
  return `<!doctype html><html><body style="margin:0;background:#f0f9ff;font-family:Arial,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#ffffff;border-top:4px solid #0EA5E9;border-radius:8px;padding:24px">
<h2 style="margin:0 0 16px;color:#0369A1">${esc(labName)}</h2>
<p style="line-height:1.6">${body}</p>${button}
<p style="color:#64748b;font-size:12px">${msg.kind === 'report' ? 'You will be asked for a second factor to open the report: a one-time code sent to your phone, the PIN on your bill, the last 4 digits of your phone number, your patient number or your date of birth.' : ''}</p>
</div></div></body></html>`
}

export async function sendEmail(cfg: EmailConfig, msg: OutgoingMessage, labName: string): Promise<ProviderResult> {
  const transport = nodemailer.createTransport(cfg.smtpUrl)
  const addr = /<([^>]+)>/.exec(cfg.from)?.[1] ?? cfg.from
  const info = await transport.sendMail({
    from: cfg.sender ? `${cfg.sender.name || labName} <${addr}>` : cfg.from,
    ...(cfg.sender ? { replyTo: cfg.sender.email } : {}),
    to: msg.to,
    attachments: msg.attachments,
    subject: msg.subject,
    text: msg.text,
    html: renderHtml(msg, labName),
  })
  return { ok: true, providerId: info.messageId ?? '' }
}
