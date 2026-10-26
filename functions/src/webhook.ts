import { createHmac, timingSafeEqual } from 'node:crypto'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
import { defineSecret } from 'firebase-functions/params'
import { onRequest } from 'firebase-functions/v2/https'
import { FIRESTORE_DB, clean } from './secrets'

// Delivery receipts from messaging providers (WhatsApp Cloud API, MSG91, or any provider that can POST
// JSON). Provider-agnostic: every payload is normalised to {providerId, status, error?} and applied to the
// matching `labs/{lab}/orders/{order}/deliveries/{id}` doc (matched by providerId).
//
// Auth: HMAC-SHA256 of the raw body with DELIVERY_WEBHOOK_SECRET, hex, sent as `X-Webhook-Signature`
// (or `X-Hub-Signature-256: sha256=<hex>` as Meta does). No secret configured => 503 (nothing is accepted).
// Meta also verifies the endpoint with GET ?hub.mode=subscribe&hub.verify_token=<secret>&hub.challenge=...
const DELIVERY_WEBHOOK_SECRET = defineSecret('DELIVERY_WEBHOOK_SECRET')

export type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled' | 'logged'
// A receipt may only move a delivery forward (a late "sent" must not undo "delivered").
const RANK: Record<string, number> = { queued: 0, logged: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 2, cancelled: 2 }

interface Event { providerId: string; status: DeliveryStatus; error?: string; at?: number }

export function normaliseStatus(s: unknown): DeliveryStatus | null {
  const v = String(s ?? '').toLowerCase()
  if (['queued', 'accepted', 'pending', 'submitted'].includes(v)) return 'queued'
  if (['sending', 'processing'].includes(v)) return 'sending'
  if (['sent', 'dispatched'].includes(v)) return 'sent'
  if (['delivered', 'delivery_success', 'success'].includes(v)) return 'delivered'
  if (['read', 'seen'].includes(v)) return 'read'
  if (['failed', 'undelivered', 'rejected', 'error', 'bounced', 'delivery_failed'].includes(v)) return 'failed'
  if (['cancelled', 'canceled'].includes(v)) return 'cancelled'
  return null
}

export function parseEvents(body: unknown): Event[] {
  const out: Event[] = []
  const b = (body ?? {}) as Record<string, unknown>
  // Meta WhatsApp Cloud API
  for (const entry of (Array.isArray(b.entry) ? b.entry : []) as Record<string, unknown>[]) {
    for (const ch of (Array.isArray(entry.changes) ? entry.changes : []) as Record<string, unknown>[]) {
      const statuses = ((ch.value as Record<string, unknown> | undefined)?.statuses ?? []) as Record<string, unknown>[]
      for (const s of statuses) {
        const st = normaliseStatus(s.status)
        const errs = (s.errors ?? []) as { title?: string; message?: string }[]
        if (st && typeof s.id === 'string') {
          out.push({ providerId: s.id, status: st, error: errs[0]?.message ?? errs[0]?.title, at: Number(s.timestamp) ? Number(s.timestamp) * 1000 : undefined })
        }
      }
    }
  }
  // Generic: {providerId,status} | {events:[...]} | MSG91-style {requestId,status}
  const list = Array.isArray(b.events) ? (b.events as Record<string, unknown>[]) : [b]
  for (const e of list) {
    const id = e.providerId ?? e.messageId ?? e.requestId ?? e.request_id
    const st = normaliseStatus(e.status)
    if (typeof id === 'string' && id && st) out.push({ providerId: id, status: st, error: typeof e.error === 'string' ? e.error : undefined })
  }
  return out
}

export function signatureOk(raw: Buffer | undefined, header: string, secret: string): boolean {
  if (!raw || !secret || !header) return false
  const given = header.replace(/^sha256=/i, '').trim().toLowerCase()
  const want = createHmac('sha256', secret).update(raw).digest('hex')
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function applyDeliveryEvent(e: Event): Promise<boolean> {
  const db = getFirestore(FIRESTORE_DB)
  const snap = await db.collectionGroup('deliveries').where('providerId', '==', e.providerId).limit(5).get()
  let hit = false
  for (const d of snap.docs) {
    const parts = d.ref.path.split('/') // labs/{lab}/orders/{order}/deliveries/{id}
    if (parts.length !== 6 || parts[0] !== 'labs') continue
    hit = true
    const cur = String(d.data().status ?? '')
    if (e.status !== 'failed' && (RANK[e.status] ?? 0) <= (RANK[cur] ?? 0)) continue
    const at = Timestamp.fromMillis(e.at ?? Date.now())
    const patch: Record<string, unknown> = {
      status: e.status,
      statusAt: at,
      statusLog: FieldValue.arrayUnion({ status: e.status, at, ...(e.error ? { error: e.error } : {}) }),
    }
    if (e.status === 'delivered') patch.deliveredAt = at
    if (e.status === 'read') patch.readAt = at
    if (e.status === 'failed') patch.error = e.error ?? 'Provider reported the message as undelivered.'
    await d.ref.update(patch)
  }
  return hit
}

export const deliveryWebhook = onRequest({ region: 'asia-south1', secrets: [DELIVERY_WEBHOOK_SECRET] }, async (req, res) => {
  let secret = ''
  try {
    secret = clean(DELIVERY_WEBHOOK_SECRET.value())
  } catch {
    secret = ''
  }
  if (!secret) {
    res.status(503).send('Delivery webhook is not configured.')
    return
  }
  if (req.method === 'GET') {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === secret) {
      res.status(200).send(String(req.query['hub.challenge'] ?? ''))
    } else res.status(403).send('Forbidden')
    return
  }
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed')
    return
  }
  const header = String(req.get('x-webhook-signature') ?? req.get('x-hub-signature-256') ?? '')
  if (!signatureOk(req.rawBody, header, secret)) {
    res.status(401).send('Invalid signature')
    return
  }
  let matched = 0
  for (const e of parseEvents(req.body)) {
    try {
      if (await applyDeliveryEvent(e)) matched++
    } catch (err) {
      console.error('delivery webhook event failed', e.providerId, err)
    }
  }
  res.status(200).json({ ok: true, matched })
})
