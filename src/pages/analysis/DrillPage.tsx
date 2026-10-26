import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Select, Table } from 'antd'
import dayjs from 'dayjs'
import { getDocs, limit, query } from 'firebase/firestore'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { SkeletonCard } from '../../design/Skeletons'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useBranchScope } from '../../lib/branchScope'
import { aggregateRange, type AggResult } from '../../lib/analysisServer'
import { ordersInRange } from '../../components/billing/helpers'
import { CHART_COLORS, downloadCsv, Donut, ExportButton, money, RangeBar, rupees, tsFull, type OrderExt, type Range } from './shared'
import { narrowOrders, patientSlice, PATIENT_SLICES, SCOPE_OPTIONS, sliceCounts, testSlices, TEST_SLICES, type Scope } from './statsModel'

// Graph drill-down pages: /analysis/:kind?from=&to=&scope=&dept=&slice=
//   test-status, patient-status       the bills behind a donut slice
//   billing, registrations, tests     day (or month) series with a table
//   referral, department, b2b, package  ranked breakdown with a chart
const STATUS = ['test-status', 'patient-status']
const SERIES = ['billing', 'registrations', 'tests']
const SEGS = ['referral', 'department', 'b2b', 'package']
const TITLE: Record<string, string> = {
  'test-status': 'Test wise status', 'patient-status': 'Patient wise status', billing: 'Billing amount', registrations: 'Registrations', tests: 'Tests',
  referral: 'Referral breakdown', department: 'Department breakdown', b2b: 'B2B breakdown', package: 'Package breakdown',
}
const LIST_CAP = 3000

export default function DrillPage() {
  const { kind = '' } = useParams()
  const [sp, setSp] = useSearchParams()
  const nav = useNavigate()
  const range: Range = [dayjs(sp.get('from') || undefined).isValid() ? dayjs(sp.get('from')) : dayjs(), dayjs(sp.get('to') || undefined).isValid() ? dayjs(sp.get('to')) : dayjs()]
  const scopeSel = (sp.get('scope') as Scope) || 'all'
  const dept = sp.get('dept') || ''
  const slice = sp.get('slice') || ''
  const patch = (p: Record<string, string>) => {
    const n = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(p)) v ? n.set(k, v) : n.delete(k)
    setSp(n, { replace: true })
  }
  const back = (
    <Link to="/analysis">Back to Analysis</Link>
  )
  if (![...STATUS, ...SERIES, ...SEGS].includes(kind)) {
    return <div><PageHeader title="Analysis" subtitle="This graph has no detail page." actions={back} /><Card><EmptyState title="Nothing to show" description="Open a graph from the Analysis page and use View details." /></Card></div>
  }
  return (
    <div>
      <PageHeader title={TITLE[kind]} subtitle={`${range[0].format('DD MMM YYYY')} to ${range[1].format('DD MMM YYYY')}${scopeSel !== 'all' ? `, ${scopeSel}` : ''}${dept ? `, ${dept}` : ''}`}
        actions={<div className="an-pill-row" style={{ margin: 0 }}>{back}<RangeBar value={range} onChange={(r) => patch({ from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') })} /></div>} />
      <div className="an-toolbar">
        <Segmented<Scope> aria-label="Pathology or radiology" size="small" value={scopeSel} onChange={(v) => patch({ scope: v === 'all' ? '' : v })} options={SCOPE_OPTIONS} />
      </div>
      {STATUS.includes(kind) ? <StatusDrill kind={kind} range={range} scope={scopeSel} dept={dept} slice={slice} setSlice={(s) => patch({ slice: s })} nav={nav} />
        : <AggDrill kind={kind} range={range} scope={scopeSel} dept={dept} />}
    </div>
  )
}

function StatusDrill({ kind, range, scope, dept, slice, setSlice }: { kind: string; range: Range; scope: Scope; dept: string; slice: string; setSlice: (s: string) => void; nav: ReturnType<typeof useNavigate> }) {
  const cat = useCatalogueMaps()
  const bscope = useBranchScope({ analytics: true })
  const [raw, setRaw] = useState<OrderExt[]>([])
  const [loading, setLoading] = useState(true)
  const [capped, setCapped] = useState(false)
  useEffect(() => {
    let live = true
    setLoading(true)
    getDocs(query(ordersInRange(range[0], range[1], bscope.constraints), limit(LIST_CAP + 1)))
      .then((s) => { if (!live) return; setCapped(s.size > LIST_CAP); setRaw(s.docs.slice(0, LIST_CAP).map((d) => ({ ...(d.data() as object), id: d.id }) as OrderExt)); setLoading(false) })
      .catch(() => live && (setRaw([]), setLoading(false)))
    return () => { live = false }
  }, [range[0].valueOf(), range[1].valueOf(), bscope.key]) // eslint-disable-line react-hooks/exhaustive-deps
  const deptName = (id: string) => cat.departmentById.get(cat.testById.get(id)?.departmentId ?? '')?.name ?? 'Unassigned'
  const orders = useMemo(() => narrowOrders(raw, scope, dept, cat.testById, deptName), [raw, scope, dept, cat.testById, cat.departmentById]) // eslint-disable-line react-hooks/exhaustive-deps
  const labels = kind === 'test-status' ? TEST_SLICES : PATIENT_SLICES
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const o of orders) {
      if (kind === 'test-status') for (const [k, v] of Object.entries(testSlices(o))) c[k] = (c[k] ?? 0) + v
      else { const k = patientSlice(o); c[k] = (c[k] ?? 0) + 1 }
    }
    return c
  }, [orders, kind])
  const rows = useMemo(() => orders
    .map((o) => ({ o, n: kind === 'test-status' ? (slice ? (testSlices(o)[slice] ?? 0) : Object.values(testSlices(o)).reduce((a, b) => a + b, 0)) : (!slice || patientSlice(o) === slice ? 1 : 0) }))
    .filter((r) => r.n > 0), [orders, kind, slice])
  if (loading) return <SkeletonCard lines={6} />
  const exportCsv = () => downloadCsv(`${kind}-${slice || 'all'}.csv`, [['Bill', 'Patient', 'Referral', 'Date', kind === 'test-status' ? 'Tests' : 'Status', 'Net', 'Paid', 'Due'], ...rows.map((r) => [r.o.billNo, r.o.patientName, r.o.referrerName, tsFull(r.o.createdAt), kind === 'test-status' ? r.n : patientSlice(r.o), rupees(r.o.net), rupees(r.o.paid), rupees(r.o.due)])])
  return (
    <div className="an-stack">
      <div className="an-grid">
        <Card><Donut title={TITLE[kind]} slices={sliceCounts(labels, counts)} onSlice={(s) => setSlice(s === slice ? '' : s)} /></Card>
        <Card>
          <div className="an-pill-row">
            <Select allowClear placeholder="All slices" aria-label="Status slice" style={{ width: 220 }} value={slice || undefined} onChange={(v) => setSlice(v ?? '')} options={labels.map((l) => ({ value: l, label: `${l} (${counts[l] ?? 0})` }))} />
          </div>
          <p className="an-note">{rows.length} bills{slice ? ` with ${slice.toLowerCase()} ${kind === 'test-status' ? 'tests' : 'status'}` : ''}. {capped ? `Showing the first ${LIST_CAP} bills of the period; narrow the dates for the rest.` : ''}</p>
        </Card>
      </div>
      <Card>
        <div className="an-card-head"><h2 className="an-card-title">Bills</h2><ExportButton onClick={exportCsv} disabled={!rows.length} /></div>
        <Table size="small" rowKey={(r) => r.o.id} dataSource={rows} pagination={{ pageSize: 20, hideOnSinglePage: true }} locale={{ emptyText: 'No bills for this slice' }} scroll={{ x: 800 }}
          columns={[
            { title: 'Bill', render: (_, r) => <Link to={`/results/${r.o.id}`}>{r.o.billNo}</Link> },
            { title: 'Patient', render: (_, r) => r.o.patientName },
            { title: 'Referral', render: (_, r) => r.o.referrerName || 'Self' },
            { title: 'Date', render: (_, r) => tsFull(r.o.createdAt) },
            { title: kind === 'test-status' ? 'Tests' : 'Status', align: kind === 'test-status' ? 'right' : undefined, render: (_, r) => (kind === 'test-status' ? r.n : patientSlice(r.o)) },
            { title: 'Net', align: 'right', render: (_, r) => money(r.o.net) },
            { title: 'Due', align: 'right', render: (_, r) => money(r.o.due) },
          ]} />
      </Card>
    </div>
  )
}

function AggDrill({ kind, range, scope, dept }: { kind: string; range: Range; scope: Scope; dept: string }) {
  const bscope = useBranchScope({ analytics: true })
  const [data, setData] = useState<AggResult | null>(null)
  const [state, setState] = useState<{ loading: boolean; error: string }>({ loading: true, error: '' })
  const from = range[0].format('YYYY-MM-DD'), to = range[1].format('YYYY-MM-DD')
  useEffect(() => {
    let live = true
    setState({ loading: true, error: '' })
    aggregateRange(from, to, scope, dept).then((d) => live && (setData(d), setState({ loading: false, error: '' }))).catch((e: unknown) => live && setState({ loading: false, error: (e as { message?: string })?.message ?? 'Could not load.' }))
    return () => { live = false }
  }, [from, to, scope, dept, bscope.key])
  const [grain, setGrain] = useState<'day' | 'month'>('day')
  useEffect(() => { setGrain(range[1].diff(range[0], 'day') > 92 ? 'month' : 'day') }, [from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  if (state.loading) return <SkeletonCard lines={6} />
  if (!data) return <Card><EmptyState title="Not available" description={state.error} /></Card>

  if (SERIES.includes(kind)) {
    const money$ = kind === 'billing'
    type P = { label: string; value: number; bills: number }
    const pick = (x: { net: number; registrations: number; tests: number; bills: number }) => (kind === 'billing' ? x.net : kind === 'registrations' ? x.registrations : x.tests)
    const series: P[] = grain === 'day'
      ? data.byDay.map((d) => ({ label: dayjs(d.date).format('DD MMM'), value: pick(d), bills: d.bills }))
      : data.byMonth.map((d) => ({ label: dayjs(`${d.month}-01`).format('MMM YY'), value: pick(d), bills: d.bills }))
    const show = (v: number) => (money$ ? money(v) : String(Math.round(v)))
    return (
      <div className="an-stack">
        <Card>
          <div className="an-card-head">
            <h2 className="an-card-title">{TITLE[kind]} by {grain}</h2>
            <Segmented<'day' | 'month'> aria-label="Grain" size="small" value={grain} onChange={setGrain} options={[{ value: 'day', label: 'Daily' }, { value: 'month', label: 'Monthly' }]} />
            <ExportButton onClick={() => downloadCsv(`${kind}-by-${grain}.csv`, [[grain === 'day' ? 'Date' : 'Month', TITLE[kind], 'Bills'], ...series.map((p) => [p.label, money$ ? rupees(p.value) : p.value, p.bills])])} disabled={!series.length} />
          </div>
          {!series.length ? <EmptyState title="No bills in this range" /> : (
            <div style={{ height: 300 }} role="img" aria-label={`${TITLE[kind]}: ${series.map((p) => `${p.label} ${Math.round(p.value)}`).join(', ')}`}>
              <ResponsiveContainer>
                <BarChart data={series.map((p) => ({ ...p, v: money$ ? p.value / 100 : p.value }))}>
                  <CartesianGrid stroke="var(--c-outline-variant)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: 'var(--c-on-surface-variant)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'var(--c-on-surface-variant)', fontSize: 12 }} width={60} />
                  <Tooltip formatter={(v) => (money$ ? money(Number(v) * 100) : String(v))} />
                  <Bar dataKey="v" fill={CHART_COLORS[0]} radius={[6, 6, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card>
          <Table size="small" rowKey="label" dataSource={series} pagination={{ pageSize: 31, hideOnSinglePage: true }}
            columns={[{ title: grain === 'day' ? 'Date' : 'Month', dataIndex: 'label' }, { title: 'Bills', dataIndex: 'bills', align: 'right' }, { title: TITLE[kind], align: 'right', render: (_, p: P) => show(p.value) }]} />
        </Card>
      </div>
    )
  }

  const segKey = kind as 'referral' | 'department' | 'b2b' | 'package'
  const rows = data.segments[segKey]
  return (
    <div className="an-stack">
      <Card>
        <div className="an-card-head">
          <h2 className="an-card-title">Top 15 by net amount</h2>
          <ExportButton onClick={() => downloadCsv(`${kind}-breakdown.csv`, [['Name', 'Bills', 'Amount', 'Discount', 'Net', 'Paid', 'Due'], ...rows.map((r) => [r.name, r.bills, rupees(r.amount), rupees(r.discount), rupees(r.net), rupees(r.paid), rupees(r.due)])])} disabled={!rows.length} />
        </div>
        {!rows.length ? <EmptyState title="No data in this range" /> : (
          <div style={{ height: 320 }} role="img" aria-label={`Top ${kind} by net amount: ${rows.slice(0, 15).map((r) => `${r.name} ${Math.round(r.net / 100)}`).join(', ')}`}>
            <ResponsiveContainer>
              <BarChart data={rows.slice(0, 15).map((r) => ({ name: r.name, v: r.net / 100 }))} layout="vertical" margin={{ left: 40 }}>
                <CartesianGrid stroke="var(--c-outline-variant)" horizontal={false} />
                <XAxis type="number" tick={{ fill: 'var(--c-on-surface-variant)', fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={140} tick={{ fill: 'var(--c-on-surface-variant)', fontSize: 12 }} />
                <Tooltip formatter={(v) => money(Number(v) * 100)} />
                <Bar dataKey="v" fill={CHART_COLORS[0]} radius={[0, 6, 6, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
      <Card>
        <Table size="small" rowKey="name" dataSource={rows} pagination={{ pageSize: 20, hideOnSinglePage: true }}
          columns={[{ title: 'Name', dataIndex: 'name' }, { title: 'Bills', dataIndex: 'bills', align: 'right' },
            { title: 'Amount', align: 'right', render: (_, r) => money(Math.round(r.amount)) }, { title: 'Discount', align: 'right', render: (_, r) => money(Math.round(r.discount)) },
            { title: 'Net', align: 'right', render: (_, r) => money(Math.round(r.net)) }, { title: 'Paid', align: 'right', render: (_, r) => money(Math.round(r.paid)) }, { title: 'Due', align: 'right', render: (_, r) => money(Math.round(r.due)) }]} />
      </Card>
    </div>
  )
}
