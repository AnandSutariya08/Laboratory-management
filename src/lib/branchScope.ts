import { where, type QueryConstraint } from 'firebase/firestore'
import { useBranch } from '../branch/BranchProvider'
import { MAIN_BRANCH_ID } from './activeBranch'

export { MAIN_BRANCH_ID } from './activeBranch'

// ---- Branch scoping helpers --------------------------------------------------
// Branch-scoped collections: orders (+ ledger/results/deliveries), bookings,
// invBatches, stockMovements, purchaseOrders, qcMachines, qcRuns, capas,
// eqasRounds, ilcStudies, validationStudies, sampleDiscards.
// Shared: catalogue, patients, invItems, invSuppliers, stockMappings, qcMaterials.
// Legacy docs without branchId belong to branch 'main' (see backfill in BranchesPage).

// Query constraint for the current branch. `analytics: true` drops the filter when
// the user switched on "All branches" (analytics / finance / dashboards only).
export function useBranchScope(opts: { analytics?: boolean } = {}) {
  const { current, allBranches } = useBranch()
  const all = !!opts.analytics && allBranches
  const id = current?.id ?? MAIN_BRANCH_ID
  const constraints: QueryConstraint[] = all ? [] : [where('branchId', '==', id)]
  return { branchId: id, all, constraints, key: all ? '*' : id, ready: !!current }
}
