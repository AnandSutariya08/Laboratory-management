import { getDocs, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { col, docRef } from './db'

// Branch-scoped collections whose legacy docs (created before branches existed)
// have no branchId. They belong to branch 'main'; this stamps them so branch-filtered
// queries find them. Safe to run repeatedly.
export const BRANCH_SCOPED_COLLECTIONS = [
  'orders', 'bookings', 'invBatches', 'stockMovements', 'purchaseOrders',
  'qcMachines', 'qcRuns', 'capas', 'eqasRounds', 'ilcStudies', 'validationStudies', 'sampleDiscards',
] as const

export async function backfillMainBranch(onProgress?: (collection: string, updated: number) => void): Promise<number> {
  let total = 0
  for (const name of BRANCH_SCOPED_COLLECTIONS) {
    const snap = await getDocs(col(name))
    const todo = snap.docs.filter((d) => !(d.data() as { branchId?: string }).branchId)
    for (let i = 0; i < todo.length; i += 400) {
      const batch = writeBatch(db)
      todo.slice(i, i + 400).forEach((d) => batch.update(docRef(name, d.id), { branchId: 'main' }))
      await batch.commit()
    }
    total += todo.length
    onProgress?.(name, todo.length)
  }
  return total
}
