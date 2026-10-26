import { useMemo, useState } from 'react'
import { App, DatePicker, Input, Modal, Table } from 'antd'
import dayjs from 'dayjs'
import { serverTimestamp, setDoc } from 'firebase/firestore'
import { useAuth } from '../../auth/AuthProvider'
import { branchOf } from '../../lib/activeBranch'
import { useLiveQuery } from '../../hooks/useLive'
import { col, docRef } from '../../lib/db'
import { formatINR } from '../../lib/money'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { usePartnerOrders, type Range } from '../partners/lib/orders'
import '../../pages/catalogue/catalogue.css'

// Outsource jobs (OUT-08): one row per outsourced test on a bill. The sample goes to the lab (dispatched, with a tracking
// number), the lab's report comes back (report received) and the job is closed (returned to the file / patient).
// Job docs live in `outsourceJobs/{orderId}_{testId}`; a row with no doc yet is "Pending dispatch".

type Status = 'pending' | 'dispatched' | 'reportReceived' | 'closed'
interface Job { id: string; status: Status; trackingNo?: string; dispatchedAt?: { toMillis: () => number }; receivedAt?: { toMillis: () => number }; closedAt?: { toMillis: () => number } }
const LABEL: Record<Status, string> = { pending: 'Pending dispatch', dispatched: 'Dispatched', reportReceived: 'Report received', closed: 'Closed' }
const VARIANT: Record<Status, 'neutral' | 'caution' | 'info' | 'success'> = { pending: 'neutral', dispatched: 'caution', reportReceived: 'info', closed: 'success' }

export function OutsourceJobs({ canEdit }: { canEdit: boolean }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const [range, setRange] = useState<Range>([dayjs().subtract(30, 'day'), dayjs()])
  const orders = usePartnerOrders(range).data
  const jobs = useLiveQuery<Job>(col('outsourceJobs'), []).data
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs])
  const [track, setTrack] = useState<{ row: Row; value: string } | null>(null)
  const [filter, setFilter] = useState<Status | 'open'>('open')

  interface Row { key: string; orderId: string; testId: string; billNo: string; patient: string; testName: string; labId: string; labName: string; cost: number; branchId: string }
  const rows = useMemo(() => {
    const out: Row[] = []
    for (const o of orders) {
      for (const it of o.items ?? []) {
        if (it.status === 'refunded') continue
        for (const s of it.outsource ?? []) {
          out.push({ key: `${o.id}_${s.testId}`, orderId: o.id, testId: s.testId, billNo: o.billNo, patient: o.patientName, testName: it.name ?? s.testId, labId: s.labId, labName: s.labName, cost: s.cost, branchId: branchOf(o) })
        }
      }
    }
    return out
  }, [orders])
  const statusOf = (r: Row): Status => jobById.get(r.key)?.status ?? 'pending'
  const shown = rows.filter((r) => (filter === 'open' ? statusOf(r) !== 'closed' : statusOf(r) === filter))

  const write = async (r: Row, patch: Record<string, unknown>, ok: string) => {
    try {
      await setDoc(docRef('outsourceJobs', r.key), {
        orderId: r.orderId, testId: r.testId, billNo: r.billNo, patientName: r.patient, testName: r.testName, labId: r.labId, labName: r.labName, cost: r.cost,
        branchId: r.branchId, updatedBy: profile?.uid ?? '', updatedByName: profile?.name ?? '', updatedAt: serverTimestamp(), ...patch,
      }, { merge: true })
      message.success(ok)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const when = (t?: { toMillis: () => number }) => (t ? dayjs(t.toMillis()).format('DD MMM, HH:mm') : '')

  return (
    <div className="cat-stack">
      <div className="cat-toolbar">
        <DatePicker.RangePicker allowClear={false} value={range} onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} />
        {(['open', 'pending', 'dispatched', 'reportReceived', 'closed'] as const).map((f) => (
          <Button key={f} variant={filter === f ? 'primary' : 'text'} onClick={() => setFilter(f)}>{f === 'open' ? 'Open' : LABEL[f]}</Button>
        ))}
      </div>
      <Table<Row> size="small" rowKey="key" dataSource={shown} pagination={{ pageSize: 20, showSizeChanger: false }} locale={{ emptyText: 'No outsourced tests in this range' }}
        columns={[
          { title: 'Bill', dataIndex: 'billNo', width: 110 },
          { title: 'Patient', dataIndex: 'patient' },
          { title: 'Test', dataIndex: 'testName' },
          { title: 'Lab', dataIndex: 'labName' },
          { title: 'Cost', width: 90, render: (_, r) => formatINR(r.cost) },
          { title: 'Tracking', width: 120, render: (_, r) => jobById.get(r.key)?.trackingNo || '' },
          {
            title: 'Status', width: 220,
            render: (_, r) => {
              const j = jobById.get(r.key)
              const st = statusOf(r)
              return <span><StatusChip variant={VARIANT[st]}>{LABEL[st]}</StatusChip> <span className="cat-muted">{when(st === 'dispatched' ? j?.dispatchedAt : st === 'reportReceived' ? j?.receivedAt : j?.closedAt)}</span></span>
            },
          },
          {
            title: '', width: 160,
            render: (_, r) => {
              const st = statusOf(r)
              if (!canEdit || st === 'closed') return null
              return st === 'pending'
                ? <Button variant="text" onClick={() => setTrack({ row: r, value: '' })}>Dispatch</Button>
                : st === 'dispatched'
                  ? <Button variant="text" onClick={() => void write(r, { status: 'reportReceived', receivedAt: serverTimestamp() }, 'Report received')}>Report received</Button>
                  : <Button variant="text" onClick={() => void write(r, { status: 'closed', closedAt: serverTimestamp() }, 'Job closed')}>Close</Button>
            },
          },
        ]} />
      <Modal title="Dispatch sample to lab" open={!!track} onCancel={() => setTrack(null)} okText="Mark dispatched" destroyOnHidden
        onOk={() => { if (track) void write(track.row, { status: 'dispatched', dispatchedAt: serverTimestamp(), trackingNo: track.value.trim() }, 'Marked dispatched').then(() => setTrack(null)) }}>
        <p className="cat-muted">{track?.row.testName} to {track?.row.labName} (bill {track?.row.billNo}).</p>
        <Input aria-label="Courier tracking number" placeholder="Courier / tracking number (optional)" value={track?.value ?? ''} onChange={(e) => track && setTrack({ ...track, value: e.target.value })} />
      </Modal>
    </div>
  )
}
