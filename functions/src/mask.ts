import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { LOG_KEY, secret } from './secrets'

// Recipient addresses in logs: masked for display, encrypted (AES-256-GCM) where a retry needs the real value.

export function maskTo(to: string): string {
  const v = String(to ?? '').trim()
  if (!v) return ''
  if (v.includes('@')) {
    const [u, d] = v.split('@')
    return `${u.slice(0, 1)}${'*'.repeat(Math.max(2, u.length - 1))}@${d}`
  }
  const digits = v.replace(/\D/g, '')
  if (digits.length < 5) return '*'.repeat(digits.length)
  return `${'*'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`
}

const key = (labId: string) => createHash('sha256').update(`${secret(LOG_KEY) || 'hcl-dev-log-key'}:${labId}`).digest()

export function encTo(labId: string, to: string): string {
  if (!to) return ''
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(labId), iv)
  const body = Buffer.concat([c.update(to, 'utf8'), c.final()])
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}`
}

export function decTo(labId: string, enc: string): string {
  try {
    const [iv, tag, body] = String(enc).split('.')
    const d = createDecipheriv('aes-256-gcm', key(labId), Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8')
  } catch {
    return ''
  }
}
