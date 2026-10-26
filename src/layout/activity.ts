import { addDoc, serverTimestamp } from 'firebase/firestore'
import { auth } from '../firebase'
import { branchStamp } from '../lib/activeBranch'
import { col } from '../lib/db'

// Display name of the signed-in user, set by AppLayout.
let actorName = ''
export const setActivityActor = (name: string) => {
  actorName = name
}

/** Writes one event to the branch activity feed (shown in the notification bell). Never throws. */
export interface AuditExtra {
  category?: 'LOGIN' | 'BILLING' | 'RESULT' | 'VERIFY' | 'DISCOUNT' | 'DELETE' | 'REFUND' | 'SETTINGS' | 'QC' | 'EXPORT' | 'ADMIN_ACCESS' | 'OTHER'
  before?: unknown // JSON-safe snapshot before the change
  after?: unknown
  reason?: string
  actor?: { uid: string; name: string } // override when the signed-in user is not the actor (defaults to auth.currentUser)
  extra?: Record<string, unknown> // extra top-level fields stored on the entry
}
export async function logActivity(type: string, text: string, refPath = '', extra: AuditExtra = {}): Promise<void> {
  try {
    const u = auth.currentUser
    await addDoc(col('activity'), {
      type,
      text,
      refPath,
      ...(extra.category ? { category: extra.category } : {}),
      ...(extra.before !== undefined ? { before: JSON.parse(JSON.stringify(extra.before)) } : {}),
      ...(extra.after !== undefined ? { after: JSON.parse(JSON.stringify(extra.after)) } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.extra ?? {}),
      at: serverTimestamp(),
      by: extra.actor?.uid ?? u?.uid ?? '',
      byName: extra.actor?.name || actorName || u?.email || '',
      ...branchStamp(),
    })
  } catch {
    /* the feed is best-effort */
  }
}
