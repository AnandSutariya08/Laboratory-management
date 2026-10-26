import { useEffect, useMemo, useState } from 'react'
import { App, Table, Tag, Tooltip } from 'antd'
import { CheckOutlined, DownloadOutlined, SendOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { getDocs, limit, orderBy, query } from 'firebase/firestore'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { can, useAuth } from '../../auth/AuthProvider'
import SendReportModal from '../../components/messaging/SendReportModal'
import BulkSendModal from '../../components/messaging/BulkSendModal'
import { DISPATCH_LABEL, ordersInRange } from '../../components/billing/helpers'
import { fmtDateTime } from '../../components/results/common'
import { useBranchScope } from '../../lib/branchScope'
import { deliveriesCol } from '../../lib/db'
import { useMarkDispatched } from '../../features/report/hardCopy'
import { useLiveQuery } from '../../hooks/useLive'
import { bulkDownloadReports } from '../../features/report/snapshots'
import { hasPendingDispatch } from '../../features/report/dispatch'
import type { Channel, Delivery, DispatchMode, Order } from '../../types'

type Filter = 'all' | DispatchMode
const STATE_COLOR: Record<string, string> = { delivered: 'green', read: 'green', sent: 'blue', logged: 'gold', failed: 'red', queued: 'default', pending: 'default' }

// Pending dispatch (DP-25): bills whose report is final/complete but not yet sent by every selected mode,
// with one status chip per channel, the last attempt, and Send / Resend / Mark manual actions.
export default function PendingDispatchPage() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const scope = useBranchScope()
  const markDispatched = useMarkDispatched()
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<string[]>([])
  const [sendFor, setSendFor] = useState<Order | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [lastBy, setLastBy] = useState<Record<string, Delivery[]>>({})
  const [dl, setDl] = useState(false)

  const range = useMemo(() => [dayjs().subtract(60, 'day'), dayjs()] as const, [])
  const { data, loading } = useLiveQuery<Order>(ordersInRange(range[0], range[1], scope.constraints), [scope.key])
  const rows = useMemo(
    () => data.filter((o) => hasPendingDispatch(o) && (filter === 'all' || o.dispatch.some((d) => d.mode === filter && !d.delivered))),
    [data, filter],
  )

  // Last delivery attempts of the visible bills (one small read each, first 40 rows).
  const key = rows.slice(0, 40).map((o) => o.id).join(',')
  useEffect(() => {
    let dead = false
    Promise.all(
      rows.slice(0, 40).map(async (o) => {
        try {
          const s = await getDocs(query(deliveriesCol(o.id), orderBy('at', 'desc'), limit(12)))
          return [o.id, s.docs.map((d) => ({ ...(d.data() as Delivery), id: d.id }))] as const
        } catch {
          return [o.id, []] as const
        }
      }),
    ).then((all) => !dead && setLastBy(Object.fromEntries(all)))
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sendFor])

  const chip = (o: Order, mode: DispatchMode) => {
    const st = o.dispatch.find((d) => d.mode === mode)
    if (!st) return null
    const last = (lastBy[o.id] ?? []).find((d) => d.channel === mode && d.kind === 'report')
    const label = st.delivered ? 'Delivered' : last ? (last.status === 'logged' ? 'Not sent (dev)' : last.status.charAt(0).toUpperCase() + last.status.slice(1)) : 'Pending'
    const color = st.delivered ? 'green' : STATE_COLOR[last?.status ?? 'pending']
    return (
      <Tooltip key={mode} title={last ? `${fmtDateTime(last.at)}${last.error ? `: ${last.error}` : ''}` : 'No attempt yet'}>
        <Tag color={color}>{DISPATCH_LABEL[mode]}: {label}</Tag>
      </Tooltip>
    )
  }
  const lastAttempt = (o: Order) => {
    const l = (lastBy[o.id] ?? []).find((d) => d.kind === 'report')
    return l ? fmtDateTime(l.at) : '-'
  }
  const markManual = async (o: Order) => {
    try {
      let all = true
      let cur = o
      for (const d of o.dispatch.filter((x) => !x.delivered)) {
        const ok = await markDispatched(cur, d.mode)
        all = ok && all
        if (ok) cur = { ...cur, dispatch: cur.dispatch.map((x) => (x.mode === d.mode ? { ...x, delivered: true } : x)) }
      }
      if (all) message.success('Marked as dispatched')
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const picked = rows.filter((o) => selected.includes(o.id))
  const canSend = can(profile, 'reports.send')
  const modes: DispatchMode[] = ['whatsapp', 'sms', 'email', 'hardcopy', 'manualWhatsapp']

  return (
    <div>
      <PageHeader
        title="Pending Dispatch"
        subtitle={`${rows.length} bills, last 60 days${picked.length ? ` · ${picked.length} selected` : ''}`}
        actions={
          <>
            <Button icon={<DownloadOutlined />} disabled={!picked.length || dl || !can(profile, 'reports.print')} onClick={async () => {
              setDl(true)
              const r = await bulkDownloadReports(picked.slice(0, 10))
              setDl(false)
              message[r.failed.length ? 'warning' : 'success'](`${r.ok} report copy file${r.ok === 1 ? '' : 's'} downloaded${r.failed.length ? `; failed: ${r.failed.join(', ')}` : ''}`)
            }}>Download selected (max 10)</Button>
            <Button variant="primary" icon={<SendOutlined />} disabled={!picked.length || !canSend} onClick={() => setBulkOpen(true)}>Send selected</Button>
          </>
        }
      />
      <Card>
        <Segmented aria-label="Channel" value={filter} onChange={(v) => setFilter(v as Filter)} options={[{ value: 'all', label: 'All' }, ...modes.map((m) => ({ value: m, label: DISPATCH_LABEL[m] }))]} />
        <Table<Order>
          style={{ marginTop: 12 }}
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 25, hideOnSinglePage: true }}
          rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
          locale={{ emptyText: 'Nothing waiting to be dispatched' }}
          columns={[
            { title: 'Bill', dataIndex: 'billNo', width: 120 },
            { title: 'Patient', dataIndex: 'patientName' },
            { title: 'Report', width: 110, render: (_, o) => <Tag>{o.reportStatus}</Tag> },
            { title: 'Channels', render: (_, o) => <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{o.dispatch.map((d) => chip(o, d.mode))}</span> },
            { title: 'Last attempt', width: 150, render: (_, o) => lastAttempt(o) },
            {
              title: '', width: 230,
              render: (_, o) => (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  {canSend && <Button variant="text" icon={<SendOutlined />} onClick={() => setSendFor(o)}>{(lastBy[o.id] ?? []).some((d) => d.kind === 'report') ? 'Resend' : 'Send'}</Button>}
                  <Button variant="text" icon={<CheckOutlined />} onClick={() => void markManual(o)}>Mark manual</Button>
                </span>
              ),
            },
          ]}
        />
      </Card>
      {sendFor && <SendReportModal order={sendFor} open onClose={() => setSendFor(null)} />}
      <BulkSendModal open={bulkOpen} onClose={() => setBulkOpen(false)} orders={picked.map((o) => ({ id: o.id, billNo: o.billNo, patientName: o.patientName }))} defaultChannels={['whatsapp'] as Channel[]} />
    </div>
  )
}
