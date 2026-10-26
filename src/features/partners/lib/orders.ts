import { useEffect, useMemo, useState } from 'react'
import { onSnapshot, orderBy, query, Timestamp, where, type DocumentData } from 'firebase/firestore'
import type { Dayjs } from 'dayjs'
import { col, paths } from '../../../lib/db'
import { useBranchScope } from '../../../lib/branchScope'
import { branchOf } from '../../../lib/activeBranch'
import { useLiveQuery } from '../../../hooks/useLive'
import type { PartnerOrder } from '../types'

export type Range = [Dayjs, Dayjs]

// Branch-scoped, non-deleted orders created within a date range (uses the existing
// branchId + deleted + createdAt index).
export function usePartnerOrders(range: Range) {
  const { constraints, key } = useBranchScope()
  const from = range[0].startOf('day').valueOf()
  const to = range[1].endOf('day').valueOf()
  const q = useMemo(
    () =>
      query(
        col<DocumentData>(paths.orders),
        ...constraints,
        where('deleted', '==', false),
        where('createdAt', '>=', Timestamp.fromMillis(from)),
        where('createdAt', '<=', Timestamp.fromMillis(to)),
        orderBy('createdAt', 'desc'),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, from, to],
  )
  return useLiveQuery<PartnerOrder>(q, [key, from, to])
}

// All branch orders linked to any of the given partner ids through `field`
// (b2bCentreId, collectionCentreId, corporateClientId...). One equality query per id,
// merged; the branch is filtered client side so no composite index is needed.
export function useOrdersByPartner(field: keyof PartnerOrder & string, ids: string[]) {
  const { branchId } = useBranchScope()
  const [byId, setById] = useState<Record<string, PartnerOrder[]>>({})
  const [loading, setLoading] = useState(true)
  const idKey = ids.slice().sort().join('|')
  useEffect(() => {
    if (!ids.length) {
      setById({})
      setLoading(false)
      return
    }
    setLoading(true)
    let pending = ids.length
    const unsubs = ids.map((id) =>
      onSnapshot(
        query(col<DocumentData>(paths.orders), where(field, '==', id)),
        (snap) => {
          setById((p) => ({
            ...p,
            [id]: snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as PartnerOrder),
          }))
          if (pending > 0) {
            pending--
            if (pending === 0) setLoading(false)
          }
        },
        () => setLoading(false),
      ),
    )
    return () => unsubs.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey, field])
  const data = useMemo(
    () =>
      ids
        .flatMap((id) => byId[id] ?? [])
        .filter((o) => !o.deleted && branchOf(o) === branchId)
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, idKey, branchId],
  )
  return { data, loading }
}

export const orderDate = (o: { createdAt?: Timestamp | null }) => o.createdAt?.toDate?.() ?? new Date(0)
