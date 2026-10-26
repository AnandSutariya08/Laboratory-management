import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { onSnapshot, orderBy, query } from 'firebase/firestore'
import { Result, Spin } from 'antd'
import { useAuth, can } from '../auth/AuthProvider'
import { col } from '../lib/db'
import { MAIN_BRANCH_ID, setActiveBranch, setAllBranchesView } from '../lib/activeBranch'

// The branch the user is working in. Catalogue and patients are shared across
// branches; bills, samples, results, bookings, stock, QC and reports belong to one.
export interface Branch {
  id: string
  name: string
  code: string // short code used in bill numbers, e.g. "MAIN"
  address: string
  phone: string
  active: boolean
  email?: string
  billPrefix?: string // overrides the lab bill prefix + branch code in bill numbers
}

export interface BranchState {
  branches: Branch[] // branches the signed-in user may work in
  current: Branch | null
  setCurrent: (branchId: string) => void
  allBranches: boolean // owner/admin "All branches" view for analytics
  setAllBranches: (on: boolean) => void
}

const fallback: Branch = { id: MAIN_BRANCH_ID, name: 'Main branch', code: 'MAIN', address: '', phone: '', active: true }

const BranchContext = createContext<BranchState>({
  branches: [fallback],
  current: fallback,
  setCurrent: () => {},
  allBranches: false,
  setAllBranches: () => {},
})

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* ignore */
  }
}

export function BranchProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth()
  const uid = profile?.uid
  const [all, setAll] = useState<Branch[] | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [allOn, setAllOn] = useState(false)

  // Live branch list (staff may read all branch docs; access is filtered below).
  useEffect(() => {
    if (!uid) {
      setAll(null)
      return
    }
    return onSnapshot(
      query(col<Omit<Branch, 'id'>>('branches'), orderBy('name')),
      (snap) => setAll(snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Branch)),
      () => setAll([]),
    )
  }, [uid])

  useEffect(() => {
    if (!uid) return
    setCurrentId(lsGet(`hcl.branch.${uid}`))
    setAllOn(lsGet(`hcl.allBranches.${uid}`) === '1')
  }, [uid])

  const branches = useMemo<Branch[]>(() => {
    if (!profile || !all) return []
    // A lab that has no branch documents yet runs as the single implicit 'main' branch.
    if (all.length === 0) return profile.branchIds.includes(MAIN_BRANCH_ID) || profile.allBranches ? [fallback] : []
    const active = all.filter((b) => b.active !== false)
    return profile.allBranches ? active : active.filter((b) => profile.branchIds.includes(b.id))
  }, [profile, all])

  const current = useMemo<Branch | null>(() => {
    if (!branches.length) return null
    return (
      branches.find((b) => b.id === currentId) ??
      branches.find((b) => b.id === profile?.defaultBranchId) ??
      branches[0]
    )
  }, [branches, currentId, profile?.defaultBranchId])

  // Keep non-React library code (counters, stock, orders) on the same branch.
  const setCurrent = useCallback(
    (id: string) => {
      setCurrentId(id)
      if (uid) lsSet(`hcl.branch.${uid}`, id)
    },
    [uid],
  )

  const allowAll = !!profile && (profile.allBranches && can(profile, 'branches.allView'))
  const allBranches = allowAll && allOn
  const setAllBranches = useCallback(
    (on: boolean) => {
      setAllOn(on)
      if (uid) lsSet(`hcl.allBranches.${uid}`, on ? '1' : '0')
    },
    [uid],
  )

  if (current) setActiveBranch(current)
  setAllBranchesView(allBranches)

  const value = useMemo<BranchState>(
    () => ({ branches, current, setCurrent, allBranches, setAllBranches }),
    [branches, current, setCurrent, allBranches, setAllBranches],
  )

  // Public report pages and the login screen do not need a branch.
  const needsBranch = !!profile && profile.active && !window.location.pathname.startsWith('/r/')
  if (needsBranch && all === null) {
    return (
      <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }
  if (needsBranch && !current) {
    return (
      <Result
        status="warning"
        title="No branch assigned"
        subTitle="Your account has no active branch. Ask a lab admin to give you access to a branch."
      />
    )
  }
  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>
}

export const useBranch = () => useContext(BranchContext)
