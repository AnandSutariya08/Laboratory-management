import { useMemo } from 'react'
import { orderBy, query } from 'firebase/firestore'
import { col } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import type { InventoryItem, PurchaseOrder, StockBatch, StockMapping, Supplier } from '../types'
import { INV, stockLevels } from './stock'
import { useBranchScope } from '../../../lib/branchScope'

export function useInventory() {
  const items = useLiveQuery<InventoryItem>(query(col(INV.items), orderBy('name')), [])
  const suppliers = useLiveQuery<Supplier>(query(col(INV.suppliers), orderBy('name')), [])
  const scope = useBranchScope()
  const batches = useLiveQuery<StockBatch>(query(col(INV.batches), ...scope.constraints), [scope.key])
  const pos = useLiveQuery<PurchaseOrder>(query(col(INV.pos), ...scope.constraints), [scope.key])
  const mappings = useLiveQuery<StockMapping>(col(INV.mappings), [])

  return useMemo(() => {
    const levels = stockLevels(items.data, batches.data)
    return {
      items: items.data,
      suppliers: suppliers.data,
      batches: batches.data,
      pos: [...pos.data].sort((a, b) => (b.createdAt?.toMillis() ?? Date.now()) - (a.createdAt?.toMillis() ?? Date.now())),
      mappings: mappings.data,
      levels,
      itemById: new Map(items.data.map((i) => [i.id, i])),
      supplierById: new Map(suppliers.data.map((s) => [s.id, s])),
      batchById: new Map(batches.data.map((b) => [b.id, b])),
      loading: items.loading || suppliers.loading || batches.loading || pos.loading || mappings.loading,
    }
  }, [items, suppliers, batches, pos, mappings])
}

export type InventoryData = ReturnType<typeof useInventory>
