import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { getAuth } from 'firebase-admin/auth'
import { FIRESTORE_DB, REGION } from './secrets'

// Storage rules can only read the (default) Firestore database, and ours is a named one. So the facts the
// storage rules need (lab, role, active, partnerId) are copied onto the user's sign-in token as custom claims
// whenever their user document changes. The web app refreshes its token when it sees the claims are stale.
export const syncUserClaims = onDocumentWritten(
  { document: 'labs/{labId}/users/{uid}', database: FIRESTORE_DB, region: REGION },
  async (event) => {
    const { labId, uid } = event.params
    const after = event.data?.after.data()
    const auth = getAuth()
    try {
      if (!after || after.deleted === true) {
        await auth.setCustomUserClaims(uid, { lab: labId, active: false })
        return
      }
      await auth.setCustomUserClaims(uid, {
        lab: labId,
        role: String(after.role ?? ''),
        active: after.active === true,
        partnerId: typeof after.partnerId === 'string' ? after.partnerId : '',
      })
    } catch (e) {
      // The user doc may exist before the auth account (e.g. invited users); nothing to update yet.
      console.warn('syncUserClaims skipped', uid, (e as Error).message)
    }
  },
)
