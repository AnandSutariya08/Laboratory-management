import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { FIRESTORE_DB } from '../secrets'

// ai/* modules are imported by index.ts before it calls initializeApp(), so the
// Firestore handle must be resolved lazily.
export function db(): Firestore {
  if (getApps().length === 0) initializeApp()
  return getFirestore(FIRESTORE_DB)
}

export const REGION = 'asia-south1'

export const ANALYST_ROLES = ['labAdmin', 'admin', 'manager']
export const INTERPRET_ROLES = ['labAdmin', 'admin', 'doctor']
export const ADMIN_ROLES = ['labAdmin', 'admin']
export const STAFF_ROLES = ['labAdmin', 'admin', 'manager', 'reception', 'technician', 'doctor', 'phlebotomist']
export const FLAG_ROLES = ['labAdmin', 'admin', 'doctor', 'technician']

export interface Caller {
  uid: string
  name: string
  role: string
  branchIds: string[]
  defaultBranchId: string
  allBranches: boolean
}

export function validLabId(labId: unknown): string {
  if (typeof labId !== 'string' || !labId || labId.includes('/')) {
    throw new HttpsError('invalid-argument', 'labId is required.')
  }
  return labId
}

export async function requireRole(request: CallableRequest<unknown>, labId: unknown, roles: string[]): Promise<Caller> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
  const id = validLabId(labId)
  const snap = await db().doc(`labs/${id}/users/${request.auth.uid}`).get()
  const u = snap.data()
  if (!u || u.active !== true || !roles.includes(u.role)) {
    throw new HttpsError('permission-denied', 'You do not have permission to use this feature.')
  }
  const branchIds: string[] = Array.isArray(u.branchIds) ? u.branchIds.map(String) : ['main'] // legacy profile = main
  return {
    uid: request.auth.uid,
    name: String(u.name ?? request.auth.token.email ?? ''),
    role: String(u.role),
    branchIds,
    defaultBranchId: String(u.defaultBranchId ?? branchIds[0] ?? 'main'),
    allBranches: u.allBranches === true,
  }
}

// Firestore rejects `undefined`; JSON round-trip drops it (and class instances).
export function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// Branch scope of an analytics call. `requested` is a branch id, 'all', or absent.
// Returns the branch id to filter on, or null for every branch. A caller may only
// see branches in their profile (or any branch with allBranches).
export function resolveBranch(caller: Caller, requested: unknown): string | null {
  if (requested === 'all') {
    if (!caller.allBranches) throw new HttpsError('permission-denied', 'You do not have access to all branches.')
    return null
  }
  const id = typeof requested === 'string' && requested ? requested : caller.defaultBranchId
  if (id.includes('/')) throw new HttpsError('invalid-argument', 'Invalid branchId.')
  if (!caller.allBranches && !caller.branchIds.includes(id)) {
    throw new HttpsError('permission-denied', 'You do not have access to that branch.')
  }
  return id
}
