import { query, where } from 'firebase/firestore'
import { useAuth } from '../../auth/AuthProvider'
import { useLiveQuery } from '../../hooks/useLive'
import { col } from '../../lib/db'
import type { RadMacro } from './types'

// Per-user radiology macros (RAD-10): labs/{lab}/userMacros, each owned by one user and visible only to them.
export const USER_MACROS = 'userMacros'

export function useMyMacros(): RadMacro[] {
  const { user, profile } = useAuth()
  const uid = user?.uid ?? profile?.uid ?? ''
  return useLiveQuery<RadMacro>(uid ? query(col<RadMacro>(USER_MACROS), where('ownerUid', '==', uid)) : null, [uid]).data
}
