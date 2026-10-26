import { useEffect, useState } from 'react'
import { getDocs, query, where } from 'firebase/firestore'
import { col, paths, resultsCol } from '../../lib/db'
import type { Order, TestResult } from '../../types'
import { tsToDate } from './common'
import type { Prev } from './TestCard'

// Earlier approved results of the same patient (newest first, up to `per` per test).
export function usePreviousResults(order: Order | null, per = 5, enabled = true) {
  const [map, setMap] = useState<Record<string, Prev[]>>({})
  const patientId = order?.patientId
  const orderId = order?.id
  const branchId = order?.branchId || 'main'
  useEffect(() => {
    if (!patientId || !enabled) return
    let dead = false
    ;(async () => {
      const snap = await getDocs(query(col<Order>(paths.orders), where('branchId', '==', branchId), where('patientId', '==', patientId)))
      const others = snap.docs
        .map((d) => ({ ...d.data(), id: d.id }))
        .filter((o) => o.id !== orderId && !o.deleted)
        .sort((a, b) => (tsToDate(b.createdAt)?.getTime() ?? 0) - (tsToDate(a.createdAt)?.getTime() ?? 0))
        .slice(0, 12)
      const found: Record<string, Prev[]> = {}
      for (const o of others) {
        const rs = await getDocs(resultsCol(o.id))
        rs.docs.forEach((d) => {
          const r = d.data() as TestResult
          if (r.status === 'approved' && (found[r.testId]?.length ?? 0) < per)
            found[r.testId] = [...(found[r.testId] ?? []), { values: r.values, date: o.createdAt, billNo: o.billNo }]
        })
      }
      if (!dead) setMap(found)
    })().catch(() => undefined)
    return () => {
      dead = true
    }
  }, [patientId, orderId, branchId, per, enabled])
  return map
}
