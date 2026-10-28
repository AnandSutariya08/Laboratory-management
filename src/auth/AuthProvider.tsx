import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { onSnapshot } from 'firebase/firestore'
import { auth } from '../firebase'
import { docRef, paths } from '../lib/db'
import type { RoleDoc, UserProfile } from '../types'
import { effectivePermissions, resolvePermission, type Permission } from './permissions'

export type { Permission } from './permissions'

interface AuthState {
  user: User | null
  profile: UserProfile | null
  loading: boolean
  logout: () => Promise<void>
  // Super-admin "view as user" (USR-15): read-only, audited. realProfile is always the signed-in admin.
  realProfile: UserProfile | null
  viewingAs: boolean
  startViewAs: (uid: string) => Promise<void>
  stopViewAs: () => void
}

const AuthContext = createContext<AuthState>({
  user: null,
  profile: null,
  loading: true,
  logout: async () => {},
  realProfile: null,
  viewingAs: false,
  startViewAs: async () => {},
  stopViewAs: () => {},
})

// The signed-in (or viewed) profile for code outside React, e.g. master-data helpers that must check a permission.
let currentProfile: UserProfile | null = null

const VIEW_KEY = 'hcl.viewAs'
const lsGet = (): string | null => {
  try { return sessionStorage.getItem(VIEW_KEY) } catch { return null }
}
const lsSet = (v: string | null) => {
  try { if (v) sessionStorage.setItem(VIEW_KEY, v); else sessionStorage.removeItem(VIEW_KEY) } catch { /* ignore */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [raw, setRaw] = useState<UserProfile | null>(null)
  // undefined = role doc not loaded yet; null = no doc (fall back to built-in defaults)
  const [role, setRole] = useState<RoleDoc | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [viewUid, setViewUid] = useState<string | null>(lsGet)
  const [viewRaw, setViewRaw] = useState<UserProfile | null>(null)

  useEffect(() => onAuthStateChanged(auth, (u) => {
    setUser(u)
    if (!u) {
      setRaw(null)
      setLoading(false)
      // A support "view as" session never outlives the admin's sign-in.
      lsSet(null)
      setViewUid(null)
    }
  }), [])

  // The staff profile (role, lab) is a Firestore doc keyed by the auth uid.
  useEffect(() => {
    if (!user) return
    setLoading(true)
    return onSnapshot(docRef<UserProfile>(paths.users, user.uid), (snap) => {
      setRaw(snap.exists() ? { ...snap.data(), uid: snap.id } : null)
      setLoading(false)
    })
  }, [user])

  // File storage checks the role from the sign-in token (claims written by the syncUserClaims function).
  // When the profile changes, refresh the token until its claims match, so uploads and downloads use the new role.
  useEffect(() => {
    if (!user || !raw) return
    let stop = false
    const want = { role: String(raw.role ?? ''), active: raw.active === true, partnerId: raw.partnerId ?? '' }
    const check = async (attempt: number) => {
      if (stop) return
      const t = await user.getIdTokenResult(attempt > 0).catch(() => null)
      const c = (t?.claims ?? {}) as Record<string, unknown>
      const ok = c.role === want.role && c.active === want.active && (c.partnerId ?? '') === want.partnerId
      if (!ok && attempt < 6) setTimeout(() => void check(attempt + 1), 2000 * (attempt + 1))
    }
    void check(0)
    return () => { stop = true }
  }, [user, raw?.role, raw?.active, raw?.partnerId]) // eslint-disable-line react-hooks/exhaustive-deps

  // View as: only a signed-in lab admin may look through another user's eyes.
  const viewing = !!viewUid && raw?.role === 'labAdmin' && raw.uid !== viewUid
  useEffect(() => {
    if (!viewing || !viewUid) {
      setViewRaw(null)
      return
    }
    return onSnapshot(docRef<UserProfile>(paths.users, viewUid), (snap) => setViewRaw(snap.exists() ? { ...snap.data(), uid: snap.id } : null), () => setViewRaw(null))
  }, [viewing, viewUid])
  const eff = viewing && viewRaw ? viewRaw : raw

  // The role's permission matrix column, live so admin edits apply immediately.
  const roleId = eff?.role
  useEffect(() => {
    if (!roleId) {
      setRole(undefined)
      return
    }
    return onSnapshot(
      docRef<RoleDoc>('roles', roleId),
      (snap) => setRole(snap.exists() ? { ...snap.data(), id: snap.id } : null),
      () => setRole(null),
    )
  }, [roleId])

  const build = (r: UserProfile): UserProfile => ({
    // Legacy profiles (before branches/roles) get safe defaults.
    ...r,
    branchIds: r.branchIds ?? ['main'],
    defaultBranchId: r.defaultBranchId ?? r.branchIds?.[0] ?? 'main',
    allBranches: r.allBranches ?? false,
    grants: r.grants ?? [],
    denies: r.denies ?? [],
    permissions: effectivePermissions(r.role, role?.permissions, r.grants, r.denies),
  })
  const realProfile = useMemo<UserProfile | null>(() => {
    if (!raw) return null
    if (!viewing) return null
    return { ...raw, branchIds: raw.branchIds ?? ['main'], defaultBranchId: raw.defaultBranchId ?? 'main', allBranches: raw.allBranches ?? false, grants: raw.grants ?? [], denies: raw.denies ?? [], permissions: [] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, viewing])
  const profile = useMemo<UserProfile | null>(() => {
    if (!eff) return null
    const p = build(eff)
    // Audit entries made while viewing carry both names (the real actor uid is still the admin's).
    return viewing && viewRaw && raw ? { ...p, name: `${p.name} (viewed by ${raw.name})`, viewOnly: true, viewedBy: { uid: raw.uid, name: raw.name } } : p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eff, role, viewing, viewRaw, raw])

  currentProfile = profile

  const startViewAs = async (uid: string) => {
    if (raw?.role !== 'labAdmin') return
    lsSet(uid)
    setViewUid(uid)
  }
  const stopViewAs = () => {
    lsSet(null)
    setViewUid(null)
  }

  // Hold the UI until the role doc answered, so permissions never flash wrong.
  const ready = !loading && (!raw || role !== undefined)

  return (
    <AuthContext.Provider value={{ user, profile, loading: !ready, logout: () => { lsSet(null); setViewUid(null); return signOut(auth) }, realProfile: viewing ? (realProfile ?? raw) : (profile ?? null), viewingAs: viewing && !!viewRaw, startViewAs, stopViewAs }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

export function can(profile: UserProfile | null, permission: Permission): boolean {
  if (!profile || !profile.active) return false
  // View-as is read-only: only viewing / printing keys pass.
  if (profile.viewOnly) return VIEW_ONLY_OK.test(resolvePermission(permission))
  if (profile.role === 'labAdmin') return true
  return (profile.permissions ?? []).includes(resolvePermission(permission))
}

const VIEW_ONLY_OK = /(\.view|^reports\.print|^branches\.allView)$/

/** Permission check for code outside React (uses the signed-in profile, like assertCan). */
export const canNow = (permission: Permission): boolean => can(currentProfile, permission)

/** Throws unless the current user holds the permission (catalogue.delete guards every master delete, USR-12). */
export function assertCan(permission: Permission, what = 'do this'): void {
  if (!can(currentProfile, permission)) throw new Error(`You do not have permission to ${what}.`)
}
