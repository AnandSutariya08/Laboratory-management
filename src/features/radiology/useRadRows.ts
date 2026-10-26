import { useEffect, useMemo, useState } from 'react'
import { orderBy, onSnapshot, query, Timestamp, where } from 'firebase/firestore'
import type { Dayjs } from 'dayjs'
import { col, paths, resultsCol } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useBranchScope } from '../../lib/branchScope'
import { liveItems } from '../../components/results/common'
import type { OrderExt, ResultExt } from '../../components/results/types'
import type { OrderItem, Test } from '../../types'
import { modalityOf } from './lib'
import { useRadConfig } from './config'
import type { RadiologyData, RadStatus } from './types'

export interface RadRow {
  key: string
  order: OrderExt
  item: OrderItem
  test: Test
  modality: string
  result?: ResultExt
  rad?: Partial<RadiologyData>
  status: RadStatus
}

const MAX_ORDERS = 150

export function radStatus(order: OrderExt, r?: ResultExt): RadStatus {
  const rad = r?.radiology as Partial<RadiologyData> | undefined
  if (r?.status === 'approved') return order.dispatched ? 'delivered' : 'completed'
  if (r?.status === 'hold') return 'hold'
  if (rad?.secondOpinion?.status === 'requested' || r?.verification) return 'second'
  return 'pending'
}

export function useRadRows(range: [Dayjs, Dayjs]) {
  const maps = useCatalogueMaps()
  const radCfg = useRadConfig()
  const scope = useBranchScope()
  const { data, loading } = useLiveQuery<OrderExt>(
    query(
      col<OrderExt>(paths.orders),
      ...scope.constraints,
      where('createdAt', '>=', Timestamp.fromDate(range[0].toDate())),
      where('createdAt', '<=', Timestamp.fromDate(range[1].toDate())),
      orderBy('createdAt', 'desc'),
    ),
    [range[0].valueOf(), range[1].valueOf(), scope.key],
  )
  const modalityFor = (tid: string) => {
    const t = maps.testById.get(tid)
    return t ? modalityOf(t, maps.departmentById.get(t.departmentId)?.name ?? '', radCfg.modalities) : ''
  }
  const radOrders = useMemo(
    () => data.filter((o) => !o.deleted && liveItems(o).some((i) => i.testIds.some((t) => modalityFor(t)))).slice(0, MAX_ORDERS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, maps.testById, maps.departmentById, radCfg.modalities],
  )
  const [resMap, setResMap] = useState<Record<string, ResultExt[]>>({})
  const idKey = radOrders.map((o) => o.id).join(',')
  useEffect(() => {
    const unsubs = radOrders.map((o) =>
      onSnapshot(
        resultsCol(o.id),
        (snap) => setResMap((m) => ({ ...m, [o.id]: snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as ResultExt) })),
        () => undefined,
      ),
    )
    return () => unsubs.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey])

  const rows: RadRow[] = useMemo(
    () =>
      radOrders.flatMap((o) =>
        liveItems(o).flatMap((item) =>
          item.testIds
            .filter((t) => modalityFor(t))
            .map((tid) => {
              const test = maps.testById.get(tid)!
              const result = resMap[o.id]?.find((r) => r.testId === tid)
              return { key: `${o.id}-${item.lineId}-${tid}`, order: o, item, test, modality: modalityFor(tid), result, rad: result?.radiology as Partial<RadiologyData> | undefined, status: radStatus(o, result) }
            }),
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [radOrders, resMap, maps.testById],
  )
  return { rows, loading, maps }
}
