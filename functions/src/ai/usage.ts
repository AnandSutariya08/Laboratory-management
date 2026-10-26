import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { db, REGION } from './common'
import { FIRESTORE_DB } from '../secrets'

// AI governance: every AI call is metered. A monthly call cap per lab and a per-user
// rate limit are enforced; each call is written to aiInteractionLog (who, what, when, no content).
// Limits live on the lab document as `aiLimits: { monthlyCap, perMinute }` (defaults below).

const DEFAULT_MONTHLY_CAP = 5000
const DEFAULT_PER_MINUTE = 20

export type AiFeature = 'analyst' | 'interpret' | 'mcp' | 'extract' | 'support'

const monthKey = (d = new Date()) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 7)

export async function meterAi(labId: string, actor: { uid: string; name: string }, feature: AiFeature): Promise<void> {
  const lab = ((await db().doc(`labs/${labId}`).get()).data() ?? {}) as { aiLimits?: { monthlyCap?: number; perMinute?: number } }
  const cap = Number(lab.aiLimits?.monthlyCap ?? DEFAULT_MONTHLY_CAP)
  const perMinute = Number(lab.aiLimits?.perMinute ?? DEFAULT_PER_MINUTE)
  const usageRef = db().doc(`labs/${labId}/aiUsage/${monthKey()}`)
  const rateRef = db().doc(`labs/${labId}/aiRate/${actor.uid.replace(/\//g, '_')}`)
  const now = Date.now()

  await db().runTransaction(async (tx) => {
    const [u, r] = await Promise.all([tx.get(usageRef), tx.get(rateRef)])
    const calls = Number(u.data()?.calls ?? 0)
    if (cap > 0 && calls >= cap) throw new HttpsError('resource-exhausted', `This lab has used its monthly AI allowance (${cap} calls). An admin can raise it in the lab settings.`)
    const recent = ((r.data()?.recent ?? []) as number[]).filter((t) => now - t < 60_000)
    if (perMinute > 0 && recent.length >= perMinute) throw new HttpsError('resource-exhausted', 'Too many AI requests in the last minute. Wait a moment and try again.')
    tx.set(rateRef, { recent: [...recent, now] })
    tx.set(usageRef, { calls: FieldValue.increment(1), [`byFeature.${feature}`]: FieldValue.increment(1), [`byUser.${actor.uid.replace(/[./]/g, '_')}`]: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  })
  await db().collection(`labs/${labId}/aiInteractionLog`).add({ feature, uid: actor.uid, name: actor.name, at: Timestamp.now() }).catch(() => undefined)
}

// Consent record: when an admin switches AI on, stamp when it happened (the lab document carries no
// actor, so the name is the lab admin on file).
export const recordAiConsent = onDocumentUpdated({ document: 'labs/{labId}', database: FIRESTORE_DB, region: REGION }, async (event) => {
  const b = event.data?.before.data() as { aiEnabled?: boolean } | undefined
  const a = event.data?.after.data() as { aiEnabled?: boolean; profile?: { adminName?: string } } | undefined
  if (!a || a.aiEnabled !== true || b?.aiEnabled === true) return
  await event.data!.after.ref.update({
    aiConsent: { at: Timestamp.now(), byName: a.profile?.adminName || 'Lab admin', text: 'AI features switched on: de-identified aggregates and values may be sent to the AI provider.' },
  })
})
