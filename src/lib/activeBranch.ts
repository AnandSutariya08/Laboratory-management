import type { Branch } from '../branch/BranchProvider'

export const MAIN_BRANCH_ID = 'main'

// The branch library code (no React) writes into; kept in sync by BranchProvider.
let active: Branch = { id: MAIN_BRANCH_ID, name: 'Main branch', code: 'MAIN', address: '', phone: '', active: true }
export const setActiveBranch = (b: Branch) => {
  active = b
}
let allView = false
export const setAllBranchesView = (on: boolean) => {
  allView = on
}
// Value sent to Cloud Functions: a branch id, or 'all' in the All-branches view.
export const branchParam = () => (allView ? 'all' : active.id)
export const getActiveBranch = () => active
export const activeBranchId = () => active.id

// Fields to spread into every new branch-scoped document.
export const branchStamp = () => ({ branchId: active.id })

// Counter doc name per branch. 'main' keeps the original lab-wide counter so
// numbering continues for existing data.
export const branchCounterName = (name: string, branchId = active.id) =>
  branchId === MAIN_BRANCH_ID ? name : `${name}-${branchId}`

export const branchOf = (d: { branchId?: string } | null | undefined) => d?.branchId || MAIN_BRANCH_ID
