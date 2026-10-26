import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { App, Select } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import { getDocs, query, where } from 'firebase/firestore'
import { Button } from '../../design/Button'
import { EmptyState } from '../../design/EmptyState'
import { activeBranchId } from '../../lib/activeBranch'
import { col, docRef, paths } from '../../lib/db'
import { useLiveDoc } from '../../hooks/useLive'
import { downloadHtml, ensureSnapshot, type ReportSnapshot } from '../../features/report/snapshots'
import { fmtDateTime } from '../../components/results/common'
import type { Order } from '../../types'

// Compare PDFs (RP-28): the stored copies of two bills of the same patient side by side.
export default function ReportComparePage() {
  const { orderId = '' } = useParams()
  const { message } = App.useApp()
  const { data: order } = useLiveDoc<Order>(orderId ? docRef(paths.orders, orderId) : null, [orderId])
  const [others, setOthers] = useState<Order[]>([])
  const [otherId, setOtherId] = useState<string>()
  const [left, setLeft] = useState<ReportSnapshot | null>(null)
  const [right, setRight] = useState<ReportSnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = 'Compare reports'
  }, [])
  useEffect(() => {
    if (!order?.patientId) return
    getDocs(query(col<Order>(paths.orders), where('branchId', '==', activeBranchId()), where('patientId', '==', order.patientId)))
      .then((s) => setOthers(s.docs.map((d) => ({ ...(d.data() as Order), id: d.id })).filter((o) => o.id !== orderId && !o.deleted && o.reportStatus !== 'pending')))
      .catch(() => setOthers([]))
  }, [order?.patientId, orderId])

  const load = async (id: string, set: (s: ReportSnapshot) => void) => {
    setBusy(true)
    try {
      set(await ensureSnapshot(id))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (orderId) void load(orderId, setLeft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])
  useEffect(() => {
    setRight(null)
    if (otherId) void load(otherId, setRight)
  }, [otherId])

  if (!order) return <EmptyState title="Bill not found" description="The bill may have been voided or the link is wrong." />
  const pane = (title: string, s: ReportSnapshot | null, billNo: string) => (
    <div style={{ flex: 1, minWidth: 320 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <b>{title}</b>
        {s && <Button variant="text" icon={<DownloadOutlined />} onClick={() => downloadHtml(`report-${billNo}-r${s.revision}.html`, s.html)}>Download</Button>}
      </div>
      {s ? (
        <iframe title={title} sandbox="allow-same-origin" srcDoc={s.html} style={{ width: '100%', height: '80vh', border: '1px solid var(--c-outline, #ccc)', background: '#fff' }} />
      ) : (
        <EmptyState title={busy ? 'Preparing the stored copy' : 'Nothing to show'} description="" />
      )}
    </div>
  )

  return (
    <div style={{ padding: 'var(--s-4) var(--s-3)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <b>Compare reports for {order.patientName}</b>
        <Select
          style={{ minWidth: 300 }}
          placeholder="Choose another bill of this patient"
          value={otherId}
          onChange={setOtherId}
          options={others.map((o) => ({ value: o.id, label: `${o.billNo} - ${fmtDateTime(o.createdAt)} (${o.reportStatus})` }))}
          notFoundContent="No other reports for this patient"
        />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {pane(`This report (${order.billNo})`, left, order.billNo)}
        {pane(otherId ? `Compared with ${others.find((o) => o.id === otherId)?.billNo ?? ''}` : 'Pick a bill to compare', right, others.find((o) => o.id === otherId)?.billNo ?? 'other')}
      </div>
    </div>
  )
}
