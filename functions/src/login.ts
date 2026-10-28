import { createHash } from 'node:crypto'
import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { FIRESTORE_DB, REGION } from './secrets'

// Resolves a sign-in identifier to an email so people can sign in with a username. Unauthenticated by nature,
// so it never reveals whether a username exists (no match returns the identifier unchanged) and is rate-limited
// (10 lookups per minute per IP and per identifier) in the server-only collection `_rateLimits`.
const LIMIT = 10
const WINDOW_MS = 60_000

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40)

async function hit(key: string): Promise<boolean> {
  const db = getFirestore(FIRESTORE_DB)
  const ref = db.doc(`_rateLimits/${key}`)
  return db.runTransaction(async (tx) => {
    const now = Date.now()
    const d = (await tx.get(ref)).data() as { start?: number; count?: number } | undefined
    if (!d || !d.start || now - d.start >= WINDOW_MS) {
      tx.set(ref, { start: now, count: 1 })
      return true
    }
    if ((d.count ?? 0) >= LIMIT) return false
    tx.update(ref, { count: (d.count ?? 0) + 1 })
    return true
  })
}

export const resolveLogin = onCall({ region: REGION }, async (request): Promise<{ email: string }> => {
  const { labId, identifier } = (request.data ?? {}) as { labId?: unknown; identifier?: unknown }
  if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 200) throw new HttpsError('invalid-argument', 'Identifier required.')
  const id = identifier.trim()
  if (id.includes('@')) return { email: id }
  if (typeof labId !== 'string' || !labId || labId.includes('/')) throw new HttpsError('invalid-argument', 'Lab required.')

  const ip = request.rawRequest?.ip ?? 'unknown'
  const [okIp, okId] = await Promise.all([hit(`login_ip_${hash(ip)}`), hit(`login_id_${hash(`${labId}:${id.toLowerCase()}`)}`)])
  if (!okIp || !okId) throw new HttpsError('resource-exhausted', 'Too many attempts. Try again in a minute.')

  const snap = await getFirestore(FIRESTORE_DB)
    .collection(`labs/${labId}/users`)
    .where('username', '==', id.toLowerCase())
    .where('active', '==', true)
    .limit(5)
    .get()
  const u = snap.docs.map((d) => d.data()).find((x) => !x.deleted && typeof x.email === 'string' && x.email)
  return { email: u ? String(u.email) : id }
})
