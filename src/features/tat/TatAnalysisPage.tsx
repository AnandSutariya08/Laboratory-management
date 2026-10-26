import { useMemo, useState } from 'react'
import { App, Input, Modal, Select, Table } from 'antd'
import dayjs from 'dayjs'
import { serverTimestamp, updateDoc } from 'firebase/firestore'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { SkeletonCard } from '../../design/Skeletons'
import { StatusChip } from '../../design/StatusChip'
import { useAuth } from '../../auth/AuthProvider'
import { useBranch } from '../../branch/BranchProvider'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { useBranchScope } from '../../lib/branchScope'
import { docRef, paths } from '../../lib/db'
import { buildTatRows, effectiveClockStart, type TatRow, type TatStatus } from './tatRows'
import { ordersInRange } from '../../components/billing/helpers'
import { downloadCsv, ExportButton, Kpi, RangeBar, tsFull, useMaster, useResults, type OrderExt, type Range } from '../../pages/analysis/shared'

type Tab = 'all' | 'ongoing' | 'within' | 'out' | 'testwise'
type Row = TatRow
type St = TatStatus | 'none'

const fmtMin = (m: number | null) => (m == null ? '' : m >= 120 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m)} min`)
const STATUS_LABEL: Record<St, string> = { within: 'Within TAT', nearby: 'Nearby TAT', out: 'Out of TAT', none: 'No TAT set' }
const STATUS_VARIANT = { within: 'success', nearby: 'caution', out: 'urgent', none: 'neutral' } as const

export default function TatAnalysisPage() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const { current } = useBranch()
  const settings = useLabSettings()
  const cat = useCatalogueMaps()
  const scope = useBranchScope({ analytics: true })
  const [range, setRange] = useState<Range>([dayjs().subtract(6, 'day'), dayjs()])
  const [tab, setTab] = useState<Tab>('all')
  const [dept, setDept] = useState('')
  const [q, setQ] = useState('')
  const { data: orders, loading } = useLiveQuery<OrderExt>(ordersInRange(range[0], range[1], scope.constraints), [range[0].valueOf(), range[1].valueOf(), scope.key])
  const { map: results, loading: resLoading, truncated } = useResults(orders)
  const reasons = useMaster('reasons').filter((r) => r.kind === 'outOfTat').map((r) => String(r.text ?? ''))

  const clockStart = effectiveClockStart(settings)
  const nearbyPct = settings.tat.nearbyThresholdPercent ?? 80

  const now = Date.now()
  const rows = useMemo<Row[]>(
    () => buildTatRows(orders, results, { settings, testById: cat.testById, departmentById: cat.departmentById, now }),
    [orders, results, cat.testById, cat.departmentById, settings, now],
  )

  const scoped = rows.filter((r) => (!dept || r.dept === dept) && (!q || `${r.patient} ${r.patientNo} ${r.billNo} ${r.test}`.toLowerCase().includes(q.toLowerCase())))
  const count = (f: (r: Row) => boolean) => scoped.filter(f).length
  const ongoing = (r: Row) => !r.done
  const k = {
    total: scoped.length, totalUrgent: count((r) => r.urgent),
    on: count(ongoing), onWithin: count((r) => ongoing(r) && r.status === 'within'), onNearby: count((r) => ongoing(r) && r.status === 'nearby'), onOut: count((r) => ongoing(r) && r.status === 'out'), onUrgent: count((r) => ongoing(r) && r.urgent),
    done: count((r) => r.done), doneWithin: count((r) => r.done && r.status === 'within'), doneOut: count((r) => r.done && r.status === 'out'), doneUrgent: count((r) => r.done && r.urgent),
  }

  const shown = scoped.filter((r) => tab === 'all' || (tab === 'ongoing' && ongoing(r)) || (tab === 'within' && (r.status === 'within' || r.status === 'nearby')) || (tab === 'out' && r.status === 'out'))
  const testWise = useMemo(() => {
    const m = new Map<string, { test: string; total: number; urgent: number; ongoing: number; done: number; within: number; nearby: number; out: number }>()
    for (const r of scoped) {
      const x = m.get(r.test) ?? { test: r.test, total: 0, urgent: 0, ongoing: 0, done: 0, within: 0, nearby: 0, out: 0 }
      x.total++; if (r.urgent) x.urgent++; if (r.done) x.done++; else x.ongoing++
      if (r.status === 'within') x.within++; if (r.status === 'nearby') x.nearby++; if (r.status === 'out') x.out++
      m.set(r.test, x)
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total)
  }, [scoped])

  // Out-of-TAT reason capture
  const [target, setTarget] = useState<Row | null>(null)
  const [reason, setReason] = useState('')
  const saveReason = async () => {
    if (!target || !reason.trim()) return
    try {
      await updateDoc(docRef(paths.orders, target.orderId), { [`tatReasons.${target.testId}`]: { reason: reason.trim(), by: profile?.name ?? '', at: serverTimestamp() } })
      message.success('Reason saved')
      setTarget(null); setReason('')
    } catch (e) { message.error(`Could not save the reason: ${(e as Error).message}`) }
  }

  const exportCsv = () =>
    tab === 'testwise'
      ? downloadCsv('tat-test-wise.csv', [['Test', 'Total bookings', 'Urgent', 'Ongoing', 'Completed', 'Within TAT', 'Nearby TAT', 'Out of TAT'], ...testWise.map((r) => [r.test, r.total, r.urgent, r.ongoing, r.done, r.within, r.nearby, r.out])])
      : downloadCsv(`tat-${tab}.csv`, [['Date and time', 'Patient', 'Patient ID', 'Bill', 'Test', 'Department', 'Urgent', 'Test TAT (min)', 'Completion TAT (min)', 'TAT status', 'Out of TAT reason'], ...shown.map((r) => [tsFull({ toMillis: () => r.at }), r.patient, r.patientNo, r.billNo, r.test, r.dept, r.urgent ? 'Yes' : 'No', r.expected ?? '', r.actual ?? '', STATUS_LABEL[r.status], r.reason])])

  const depts = cat.departments.map((d) => ({ value: d.name, label: d.name }))
  const num = (v: number) => <span className="an-num">{v}</span>

  return (
    <div>
      <PageHeader
        title="TAT analysis"
        subtitle={`${scope.all ? 'All branches' : (current?.name ?? 'Current branch')}: clock starts at ${clockStart === 'receipt' ? 'sample receipt' : clockStart}, stops at approval (auto-verified counts); time on hold is subtracted; pre-analytical allowance is taken off when the clock starts at receipt; tests with no TAT set are left out; nearby from ${nearbyPct}% of the allowed time`}
        actions={<RangeBar value={range} onChange={setRange} />}
      />
      {loading || resLoading ? <SkeletonCard lines={4} /> : (
        <div className="an-stack">
          {truncated && <p className="an-note">Results are read for the first 500 bills of the period; narrow the dates for full coverage.</p>}
          <div className="an-kpis">
            <Kpi label="All tests" value={k.total} hint={`${k.totalUrgent} urgent`} />
            <Kpi label="Ongoing" value={k.on} hint={`${k.onUrgent} urgent`} split={[['Within TAT', String(k.onWithin)], ['Nearby TAT', String(k.onNearby)], ['Out of TAT', String(k.onOut)]]} />
            <Kpi label="Completed" value={k.done} hint={`${k.doneUrgent} urgent`} split={[['Within TAT', String(k.doneWithin)], ['Out of TAT', String(k.doneOut)]]} />
            <Kpi label="Out of TAT now" value={k.onOut + k.doneOut} tone="urgent" />
          </div>

          <Card>
            <div className="an-pill-row">
              <Segmented<Tab> aria-label="TAT views" size="small" value={tab} onChange={setTab} options={[
                { value: 'all', label: 'All', count: k.total }, { value: 'ongoing', label: 'Ongoing', count: k.on },
                { value: 'within', label: 'Within TAT', count: scoped.filter((r) => r.status === 'within' || r.status === 'nearby').length },
                { value: 'out', label: 'Out of TAT', count: k.onOut + k.doneOut }, { value: 'testwise', label: 'Test wise' }]} />
              <Select allowClear placeholder="All departments" aria-label="Department" style={{ width: 190 }} value={dept || undefined} onChange={(v) => setDept(v ?? '')} options={depts} />
              <Input allowClear placeholder="Search patient, bill, test" aria-label="Search" style={{ width: 230 }} value={q} onChange={(e) => setQ(e.target.value)} />
              <span className="an-toolbar__spacer" />
              <ExportButton onClick={exportCsv} disabled={tab === 'testwise' ? !testWise.length : !shown.length} />
            </div>
            {tab === 'testwise' ? (
              <Table size="small" rowKey="test" dataSource={testWise} pagination={{ pageSize: 20, hideOnSinglePage: true }} locale={{ emptyText: 'No tests in this period' }}
                columns={[{ title: 'Test', dataIndex: 'test' }, { title: 'Total bookings', dataIndex: 'total', align: 'right', render: num }, { title: 'Urgent', dataIndex: 'urgent', align: 'right', render: num }, { title: 'Ongoing', dataIndex: 'ongoing', align: 'right', render: num }, { title: 'Completed', dataIndex: 'done', align: 'right', render: num }, { title: 'Within TAT', dataIndex: 'within', align: 'right', render: num }, { title: 'Nearby TAT', dataIndex: 'nearby', align: 'right', render: num }, { title: 'Out of TAT', dataIndex: 'out', align: 'right', render: num }]} />
            ) : (
              <Table<Row> size="small" rowKey="key" dataSource={shown} pagination={{ pageSize: 25, hideOnSinglePage: true }} scroll={{ x: 1000 }} locale={{ emptyText: 'No tests match' }}
                columns={[
                  { title: 'Date and time', width: 150, render: (_, r) => tsFull({ toMillis: () => r.at }) },
                  { title: 'Patient details', render: (_, r) => `${r.patient} (${r.patientNo}) ${r.billNo}` },
                  { title: 'Test', render: (_, r) => <>{r.test} {r.urgent && <StatusChip variant="urgent">Urgent</StatusChip>}</> },
                  { title: 'Department', dataIndex: 'dept' },
                  { title: 'Test TAT', align: 'right', render: (_, r) => fmtMin(r.expected) },
                  { title: 'Completion TAT', align: 'right', render: (_, r) => fmtMin(r.actual) + (r.done ? '' : ' so far') },
                  { title: 'TAT status', render: (_, r) => <StatusChip variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</StatusChip> },
                  { title: 'Reason', render: (_, r) => (r.status === 'out' ? (r.reason ? r.reason : <Button aria-label={`Add out of TAT reason for ${r.test}`} onClick={() => { setTarget(r); setReason('') }}>Add reason</Button>) : '') },
                ]} />
            )}
          </Card>
        </div>
      )}
      <Modal open={!!target} title="Out of TAT reason" onCancel={() => setTarget(null)} onOk={saveReason} okText="Save reason" okButtonProps={{ disabled: !reason.trim() }}>
        <p className="an-note">{target?.test} for {target?.patient} ({target?.billNo})</p>
        <Select showSearch allowClear style={{ width: '100%', marginBottom: 8 }} aria-label="Choose a reason" placeholder="Choose a saved reason" options={reasons.map((r) => ({ value: r, label: r }))} onChange={(v) => setReason(v ?? '')} />
        <Input.TextArea rows={3} aria-label="Reason text" placeholder="Or type the reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </div>
  )
}
