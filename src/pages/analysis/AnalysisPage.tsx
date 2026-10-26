import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Drawer, Input, Select, Table } from 'antd'
import dayjs from 'dayjs'
import { orderBy, query, Timestamp, where } from 'firebase/firestore'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { SkeletonCard } from '../../design/Skeletons'
import { StatusChip } from '../../design/StatusChip'
import { aggregateRange, type AggResult } from '../../lib/analysisServer'
import LoginDetails from './LoginDetails'
import { narrowOrders, patientSlice, PATIENT_SLICES, SCOPE_OPTIONS, sliceCounts, testSlices, TEST_SLICES, type NarrowedOrder, type Scope } from './statsModel'
import { useBranch } from '../../branch/BranchProvider'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { runAnalytics } from '../../lib/ai'
import { useBranchScope } from '../../lib/branchScope'
import { col, deliveriesCol } from '../../lib/db'
import { ordersInRange } from '../../components/billing/helpers'
import { getDocs } from 'firebase/firestore'
import type { AnalyticsResult, Delivery, Order } from '../../types'
import {
  CHART_COLORS, clearedOf, isMoneyIn, downloadCsv, Donut, ExportButton, FAN_OUT_CAP, kindOf, Kpi, KIND_LABEL, KINDS, lineNet, liveItems,
  money, MODE_BUCKETS, MODE_TITLE, modeBucket, RangeBar, rupees, testCount, tsFull, tsMs, useLedgers, useResults, useUsers,
  type Kind, type OrderExt, type Range,
} from './shared'

type Tab = 'stats' | 'activity' | 'audit'

export default function AnalysisPage() {
  const [tab, setTab] = useState<Tab>('stats')
  const [range, setRange] = useState<Range>([dayjs(), dayjs()])
  const scope = useBranchScope({ analytics: true })
  const { current } = useBranch()
  // Stats over more than 31 days is summarised on the server, so the bills are not listened to in the browser.
  const longRange = range[1].startOf('day').diff(range[0].startOf('day'), 'day') + 1 > 31
  const skipBills = tab === 'stats' && longRange
  const { data: orders, loading } = useLiveQuery<OrderExt>(skipBills ? null : ordersInRange(range[0], range[1], scope.constraints), [range[0].valueOf(), range[1].valueOf(), scope.key, skipBills])
  return (
    <div>
      <PageHeader
        title="Analysis"
        subtitle={`${scope.all ? 'All branches' : (current?.name ?? 'Current branch')}: bills created in the selected dates`}
        actions={<RangeBar value={range} onChange={setRange} />}
      />
      <div className="an-toolbar">
        <Segmented<Tab> aria-label="Analysis sections" value={tab} onChange={setTab} options={[{ value: 'stats', label: 'Stats' }, { value: 'activity', label: 'Activity tracking' }, { value: 'audit', label: 'Audit log' }]} />
      </div>
      {tab === 'stats' ? <StatsTab orders={orders} loading={loading} range={range} /> : tab === 'activity' ? <ActivityTab orders={orders} range={range} /> : <AuditTab range={range} />}
    </div>
  )
}

// ---------------------------------------------------------------- Stats
type Seg = 'referral' | 'department' | 'b2b' | 'package'
interface SegRow { name: string; bills: number; amount: number; discount: number; net: number; paid: number; due: number }
interface UserRow { key: string; name: string; bills: number; tests: number; modes: Record<string, number>; paid: number; due: number; discount: number; total: number }
interface KpiSet { reg: number; tests: number; billing: number; paid: number; due: number; cleared: number }
interface StatsView {
  kpi: { all: KpiSet; by: Record<Kind, KpiSet> }
  testStatus: { label: string; value: number }[]
  patientStatus: { label: string; value: number }[]
}

// Server aggregation for big periods: more than 31 days or more than 500 bills.
function useAgg(enabled: boolean, range: Range, scope: Scope, dept: string, branchKey: string) {
  const [s, setS] = useState<{ data: AggResult | null; loading: boolean; error: string }>({ data: null, loading: false, error: '' })
  const from = range[0].format('YYYY-MM-DD')
  const to = range[1].format('YYYY-MM-DD')
  useEffect(() => {
    if (!enabled) return
    let live = true
    setS((x) => ({ ...x, loading: true, error: '' }))
    aggregateRange(from, to, scope, dept)
      .then((data) => live && setS({ data, loading: false, error: '' }))
      .catch((e: unknown) => live && setS({ data: null, loading: false, error: (e as { message?: string })?.message ?? 'The summary could not be built.' }))
    return () => { live = false }
  }, [enabled, from, to, scope, dept, branchKey])
  return s
}

export function drillUrl(kind: string, range: Range, extra: Record<string, string> = {}) {
  const p = new URLSearchParams({ from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD'), ...extra })
  return `/analysis/${kind}?${p.toString()}`
}

function StatsTab({ orders: rawOrders, loading, range }: { orders: OrderExt[]; loading: boolean; range: Range }) {
  const cat = useCatalogueMaps()
  const users = useUsers()
  const scope = useBranchScope({ analytics: true })
  const nav = useNavigate()
  const [mod, setMod] = useState<Scope>('all')
  const [dept, setDept] = useState('')
  const deptName = useCallback((id: string) => cat.departmentById.get(cat.testById.get(id)?.departmentId ?? '')?.name ?? 'Unassigned', [cat.testById, cat.departmentById])
  const deptOptions = useMemo(() => [...cat.departmentById.values()].filter((d) => d.active !== false && !d.deleted).sort((a, b) => a.order - b.order).map((d) => ({ value: d.name, label: d.name })), [cat.departmentById])

  const days = range[1].startOf('day').diff(range[0].startOf('day'), 'day') + 1
  const serverMode = days > 31 || rawOrders.length > FAN_OUT_CAP
  const orders = useMemo(() => (serverMode ? [] : narrowOrders(rawOrders, mod, dept, cat.testById, deptName)), [serverMode, rawOrders, mod, dept, cat.testById, deptName])
  const agg = useAgg(serverMode, range, mod, dept, scope.key)
  const { map: ledgers } = useLedgers(orders, !serverMode)
  const ratio = (o: OrderExt) => (o as NarrowedOrder).ratio ?? 1

  const clientView = useMemo<StatsView>(() => {
    const z = () => ({ reg: new Set<string>(), tests: 0, billing: 0, paid: 0, due: 0, cleared: 0 })
    const all = z()
    const by: Record<Kind, ReturnType<typeof z>> = { b2b: z(), referral: z(), self: z() }
    const ts: Record<string, number> = {}
    const ps: Record<string, number> = {}
    for (const o of orders) {
      const clr = clearedOf(ledgers[o.id] ?? []) * ratio(o)
      for (const g of [all, by[kindOf(o)]]) {
        g.reg.add(o.patientId); g.tests += testCount(o); g.billing += o.net; g.paid += o.paid; g.due += o.due; g.cleared += clr
      }
      for (const [k, v] of Object.entries(testSlices(o))) ts[k] = (ts[k] ?? 0) + v
      const p = patientSlice(o)
      ps[p] = (ps[p] ?? 0) + 1
    }
    const fin = (g: ReturnType<typeof z>): KpiSet => ({ ...g, reg: g.reg.size })
    return { kpi: { all: fin(all), by: { b2b: fin(by.b2b), referral: fin(by.referral), self: fin(by.self) } }, testStatus: sliceCounts(TEST_SLICES, ts), patientStatus: sliceCounts(PATIENT_SLICES, ps) }
  }, [orders, ledgers]) // eslint-disable-line react-hooks/exhaustive-deps

  const view: StatsView | null = serverMode
    ? agg.data ? { kpi: agg.data.kpi, testStatus: sliceCounts(TEST_SLICES, agg.data.testStatus), patientStatus: sliceCounts(PATIENT_SLICES, agg.data.patientStatus) } : null
    : clientView

  // Breakdown table
  const [seg, setSeg] = useState<Seg>('referral')
  const [q, setQ] = useState('')
  const segRows = useMemo<SegRow[]>(() => {
    if (serverMode) return (agg.data?.segments[seg] ?? []).filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
    const m = new Map<string, SegRow>()
    const add = (name: string, o: Order, amount: number, discount: number, frac: number, firstOfBill: boolean) => {
      const r = m.get(name) ?? { name, bills: 0, amount: 0, discount: 0, net: 0, paid: 0, due: 0 }
      if (firstOfBill) r.bills++
      r.amount += amount; r.discount += discount; r.net += amount - discount
      r.paid += o.paid * frac; r.due += o.due * frac
      m.set(name, r)
    }
    for (const o of orders) {
      if (seg === 'referral') add(o.referrerName || 'Self', o, o.gross, o.discount, 1, true)
      else if (seg === 'b2b') { if (o.b2bCentreName) add(o.b2bCentreName, o, o.gross, o.discount, 1, true) }
      else {
        const seen = new Set<string>()
        for (const i of liveItems(o)) {
          if (!i.testIds.length) continue
          const frac = o.net > 0 ? lineNet(i) / o.net : 0
          if (seg === 'package') { if (i.kind === 'package') add(i.name, o, i.price, i.discount, frac, !seen.has(i.name)), seen.add(i.name) }
          else {
            const per = new Map<string, number>()
            for (const tid of i.testIds) {
              const t = cat.testById.get(tid)
              const d = (t && cat.departmentById.get(t.departmentId)?.name) || 'Unassigned'
              per.set(d, (per.get(d) ?? 0) + (t?.price ?? 0))
            }
            const priceSum = [...per.values()].reduce((a, b) => a + b, 0)
            // share by catalogue price; equal split by test count when no prices are known
            if (priceSum <= 0) { per.clear(); for (const tid of i.testIds) { const t = cat.testById.get(tid); const d = (t && cat.departmentById.get(t.departmentId)?.name) || 'Unassigned'; per.set(d, (per.get(d) ?? 0) + 1) } }
            const denom = [...per.values()].reduce((a, b) => a + b, 0)
            per.forEach((cnt, d) => { const f = cnt / denom; add(d, o, i.price * f, i.discount * f, frac * f, !seen.has(d)); seen.add(d) })
          }
        }
      }
    }
    return Array.from(m.values()).filter((r) => r.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.net - a.net)
  }, [serverMode, agg.data, orders, seg, q, cat.testById, cat.departmentById])

  // Top tests: daily or monthly
  const [topPeriod, setTopPeriod] = useState<'daily' | 'monthly'>('monthly')
  const [topBy, setTopBy] = useState<'freq' | 'amount'>('freq')
  const monthStart = dayjs().startOf('month')
  const { data: monthRaw } = useLiveQuery<OrderExt>(ordersInRange(monthStart, dayjs(), scope.constraints), [scope.key, monthStart.valueOf()])
  const monthOrders = useMemo(() => narrowOrders(monthRaw, mod, dept, cat.testById, deptName), [monthRaw, mod, dept, cat.testById, deptName])
  const topTests = useMemo(() => {
    const m = new Map<string, { name: string; freq: number; amount: number }>()
    const dayStart = dayjs().startOf('day').valueOf()
    for (const o of monthOrders) {
      if (topPeriod === 'daily' && (tsMs(o.createdAt) ?? 0) < dayStart) continue
      for (const i of liveItems(o)) {
        if (!i.testIds.length) continue
        for (const tid of i.testIds) {
          const name = cat.testById.get(tid)?.name ?? i.name
          const r = m.get(name) ?? { name, freq: 0, amount: 0 }
          r.freq++; r.amount += lineNet(i) / i.testIds.length
          m.set(name, r)
        }
      }
    }
    return Array.from(m.values()).sort((a, b) => b[topBy] - a[topBy]).slice(0, 10)
  }, [monthOrders, topPeriod, topBy, cat.testById])

  // User wise collection
  const [userMode, setUserMode] = useState<'billing' | 'collection'>('billing')
  const userRows = useMemo<UserRow[]>(() => {
    if (serverMode) return (agg.data?.users[userMode] ?? []).map((u) => ({ ...u, key: u.uid }))
    const m = new Map<string, UserRow>()
    const get = (uid: string): UserRow => {
      let r = m.get(uid)
      if (!r) { r = { key: uid, name: users.nameOf.get(uid) ?? (uid || 'Unknown'), bills: 0, tests: 0, modes: {}, paid: 0, due: 0, discount: 0, total: 0 }; m.set(uid, r) }
      return r
    }
    for (const o of orders) {
      const k = ratio(o)
      const entries = ledgers[o.id] ?? []
      if (userMode === 'billing') {
        const r = get(o.createdBy)
        r.bills++; r.tests += testCount(o); r.discount += o.discount; r.total += o.net; r.due += o.due; r.paid += o.paid
        for (const e of entries) if (isMoneyIn(e)) r.modes[modeBucket(e.mode)] = (r.modes[modeBucket(e.mode)] ?? 0) + e.amount * k
      } else {
        const seen = new Set<string>()
        for (const e of entries) {
          const amt = e.amount * k
          if (e.amount <= 0) {
            // refunds net off the collecting user's total
            const rr = get(e.postedBy)
            rr.paid += amt; rr.total += amt
            if (e.type === 'reversal') rr.modes[modeBucket(e.mode)] = (rr.modes[modeBucket(e.mode)] ?? 0) + amt
            continue
          }
          const r = get(e.postedBy)
          if (!seen.has(e.postedBy)) { r.bills++; r.tests += testCount(o); seen.add(e.postedBy) }
          r.modes[modeBucket(e.mode)] = (r.modes[modeBucket(e.mode)] ?? 0) + amt
          r.paid += amt; r.total += amt
        }
      }
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total)
  }, [serverMode, agg.data, orders, ledgers, userMode, users.nameOf]) // eslint-disable-line react-hooks/exhaustive-deps

  const exportSeg = () =>
    downloadCsv(`analysis-${seg}.csv`, [['Name', 'Bills', 'Amount', 'Discount', 'Net amount', 'Paid', 'Due'], ...segRows.map((r) => [r.name, r.bills, rupees(r.amount), rupees(r.discount), rupees(r.net), rupees(r.paid), rupees(r.due)])])
  const exportUsers = () =>
    downloadCsv(`user-collection-${userMode}.csv`, [['User', 'Bills', 'Tests', ...MODE_BUCKETS.map((b) => MODE_TITLE[b]), 'Amount paid', 'Due', 'Discount', 'Total'], ...userRows.map((r) => [r.name, r.bills, r.tests, ...MODE_BUCKETS.map((b) => rupees(r.modes[b] ?? 0)), rupees(r.paid), rupees(r.due), rupees(r.discount), rupees(r.total)])])

  const filterBar = (
    <div className="an-pill-row">
      <Segmented<Scope> aria-label="Pathology or radiology" size="small" value={mod} onChange={setMod} options={SCOPE_OPTIONS} />
      <Select allowClear showSearch optionFilterProp="label" placeholder="All departments" aria-label="Filter by department" style={{ width: 200 }} value={dept || undefined} onChange={(v) => setDept(v ?? '')} options={deptOptions} />
      {serverMode && agg.data && <span className="an-note" style={{ margin: 0 }}>Summarised on the server for {agg.data.bills} bills, as of {dayjs(agg.data.asOf).format('DD MMM HH:mm')}.</span>}
    </div>
  )

  if (loading || (serverMode && agg.loading && !agg.data)) return <div className="an-stack">{filterBar}<SkeletonCard lines={3} /><SkeletonCard lines={5} /></div>
  if (serverMode && !view) return <div className="an-stack">{filterBar}<Card><EmptyState title="Summary not available" description={agg.error || 'The summary service did not respond.'} /></Card></div>
  if (!view) return null
  const kpi = view.kpi

  const split = (f: (g: KpiSet) => string): [string, string][] => KINDS.map((k) => [KIND_LABEL[k], f(kpi.by[k])])
  const moneyC = (n: number) => money(Math.round(n))
  const extra = { scope: mod, dept }

  return (
    <div className="an-stack">
      {filterBar}
      <div className="an-kpis">
        <Kpi label="Registrations" value={kpi.all.reg} split={split((g) => String(g.reg))} />
        <Kpi label="Tests" value={kpi.all.tests} split={split((g) => String(g.tests))} />
        <Kpi label="Billing amount" value={money(kpi.all.billing)} split={split((g) => money(g.billing))} />
        <Kpi label="Paid amount" value={money(kpi.all.paid)} tone="success" split={split((g) => money(g.paid))} />
        <Kpi label="Due amount" value={money(kpi.all.due)} tone="urgent" split={split((g) => money(g.due))} />
        <Kpi label="Due cleared" value={money(kpi.all.cleared)} hint="Due payments on these bills" split={split((g) => money(g.cleared))} />
      </div>

      <div className="an-grid">
        <Card>
          <div className="an-card-head"><h2 className="an-card-title">Test wise status</h2><Link to={drillUrl('test-status', range, extra)}>View details</Link></div>
          <Donut title="Test wise status" slices={view.testStatus} onSlice={(s) => nav(drillUrl('test-status', range, { ...extra, slice: s }))} />
        </Card>
        <Card>
          <div className="an-card-head"><h2 className="an-card-title">Patient wise status</h2><Link to={drillUrl('patient-status', range, extra)}>View details</Link></div>
          <Donut title="Patient wise status" slices={view.patientStatus} onSlice={(s) => nav(drillUrl('patient-status', range, { ...extra, slice: s }))} />
        </Card>
      </div>

      <Card>
        <div className="an-card-head">
          <h2 className="an-card-title">Breakdown</h2>
          <div className="an-pill-row" style={{ margin: 0 }}>
            <Segmented<Seg> aria-label="Breakdown by" size="small" value={seg} onChange={setSeg} options={[{ value: 'referral', label: 'Referral' }, { value: 'department', label: 'Department' }, { value: 'b2b', label: 'B2B' }, { value: 'package', label: 'Package' }]} />
            <Input allowClear placeholder="Search name" aria-label="Search breakdown" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
            <Link to={drillUrl(seg, range, extra)}>View details</Link>
            <ExportButton onClick={exportSeg} disabled={!segRows.length} />
          </div>
        </div>
        <Table<SegRow> size="small" rowKey="name" dataSource={segRows} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'No data in this range' }}
          columns={[
            { title: 'Name', dataIndex: 'name' },
            { title: 'Bills', dataIndex: 'bills', align: 'right' },
            { title: 'Amount', dataIndex: 'amount', align: 'right', render: moneyC },
            { title: 'Discount', dataIndex: 'discount', align: 'right', render: moneyC },
            { title: 'Net amount', dataIndex: 'net', align: 'right', render: moneyC },
            { title: 'Paid', dataIndex: 'paid', align: 'right', render: moneyC },
            { title: 'Due', dataIndex: 'due', align: 'right', render: (v: number) => <span className={v > 0 ? 'an-due' : ''}>{moneyC(v)}</span> },
          ]} />
      </Card>

      <Card>
        <div className="an-card-head">
          <h2 className="an-card-title">Top 10 tests</h2>
          <Segmented<'daily' | 'monthly'> aria-label="Top tests period" size="small" value={topPeriod} onChange={setTopPeriod} options={[{ value: 'daily', label: 'Daily' }, { value: 'monthly', label: 'Monthly' }]} />
          <Segmented<'freq' | 'amount'> aria-label="Top tests ranking" size="small" value={topBy} onChange={setTopBy} options={[{ value: 'freq', label: 'By count' }, { value: 'amount', label: 'By revenue' }]} />
        </div>
        <Table size="small" rowKey="name" dataSource={topTests} pagination={false} locale={{ emptyText: 'No tests yet' }}
          columns={[{ title: 'Test name', dataIndex: 'name' }, { title: 'Frequency', dataIndex: 'freq', align: 'right' }, { title: 'Amount', dataIndex: 'amount', align: 'right', render: moneyC }]} />
      </Card>

      <Card>
        <div className="an-card-head">
          <h2 className="an-card-title">User wise collection</h2>
          <div className="an-pill-row" style={{ margin: 0 }}>
            <Segmented<'billing' | 'collection'> aria-label="User collection basis" size="small" value={userMode} onChange={setUserMode} options={[{ value: 'billing', label: 'Billing wise' }, { value: 'collection', label: 'Collection wise' }]} />
            <ExportButton onClick={exportUsers} disabled={!userRows.length} />
          </div>
        </div>
        <Table size="small" rowKey="key" dataSource={userRows} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 900 }} locale={{ emptyText: 'No data in this range' }}
          columns={[
            { title: 'User', dataIndex: 'name' },
            { title: 'Bills', dataIndex: 'bills', align: 'right' },
            { title: 'Tests', dataIndex: 'tests', align: 'right' },
            ...MODE_BUCKETS.map((b) => ({ title: `Total ${MODE_TITLE[b]}`, align: 'right' as const, render: (_: unknown, r: UserRow) => moneyC(r.modes[b] ?? 0) })),
            { title: 'Amount paid', dataIndex: 'paid', align: 'right', render: moneyC },
            { title: 'Due', dataIndex: 'due', align: 'right', render: moneyC },
            { title: 'Discount', dataIndex: 'discount', align: 'right', render: moneyC },
            { title: 'Total amount', dataIndex: 'total', align: 'right', render: moneyC },
          ]} />
      </Card>

      <Trends range={range} />

      <LoginDetails range={range} />
    </div>
  )
}

// ---- 7 day and 12 month trends: billing, registrations or tests (server aggregates, branch aware)
type TrendMetric = 'billing' | 'registrations' | 'tests'
const TREND_QUERY: Record<TrendMetric, 'revenue' | 'patients' | 'tests'> = { billing: 'revenue', registrations: 'patients', tests: 'tests' }
const TREND_LABEL: Record<TrendMetric, string> = { billing: 'billing amount', registrations: 'registrations', tests: 'tests' }

function Trends({ range }: { range: Range }) {
  const [metric, setMetric] = useState<TrendMetric>('billing')
  const trends = useTrends(metric)
  return (
    <div className="an-stack">
      <div className="an-pill-row">
        <Segmented<TrendMetric> aria-label="Trend measure" size="small" value={metric} onChange={setMetric} options={[{ value: 'billing', label: 'Billing' }, { value: 'registrations', label: 'Registrations' }, { value: 'tests', label: 'Tests' }]} />
        <Link to={drillUrl(metric === 'billing' ? 'billing' : metric, range)}>View details</Link>
      </div>
      <div className="an-grid">
        <TrendCard title="Last 7 days" metric={metric} result={trends.days} loading={trends.loading} fmt={(l) => dayjs(l).isValid() ? dayjs(l).format('DD MMM') : l} />
        <TrendCard title="Last 12 months" metric={metric} result={trends.months} loading={trends.loading} fmt={(l) => dayjs(l + '-01').isValid() ? dayjs(l + '-01').format('MMM YY') : l} />
      </div>
    </div>
  )
}

function useTrends(metric: TrendMetric) {
  const [s, setS] = useState<{ days: AnalyticsResult | null; months: AnalyticsResult | null; loading: boolean }>({ days: null, months: null, loading: true })
  const scope = useBranchScope({ analytics: true })
  useEffect(() => {
    let live = true
    setS((x) => ({ ...x, loading: true }))
    const to = dayjs().format('YYYY-MM-DD')
    const m = TREND_QUERY[metric]
    Promise.all([
      runAnalytics({ query: { metric: m, groupBy: 'day', range: { from: dayjs().subtract(6, 'day').format('YYYY-MM-DD'), to } } }).catch(() => null),
      runAnalytics({ query: { metric: m, groupBy: 'month', range: { from: dayjs().subtract(11, 'month').startOf('month').format('YYYY-MM-DD'), to } } }).catch(() => null),
    ]).then(([days, months]) => live && setS({ days, months, loading: false }))
    return () => { live = false }
  }, [scope.key, metric])
  return s
}

function TrendCard({ title, metric, result, loading, fmt }: { title: string; metric: TrendMetric; result: AnalyticsResult | null; loading: boolean; fmt: (l: string) => string }) {
  const data = (result?.rows ?? []).map((r) => ({ label: fmt(r.label), value: r.value }))
  const isMoney = metric === 'billing'
  const show = (v: number) => (isMoney ? money(v * 100) : String(Math.round(v)))
  return (
    <Card>
      <h2 className="an-card-title">{title}: {TREND_LABEL[metric]}</h2>
      {loading ? <SkeletonCard lines={2} /> : !data.length ? <EmptyState title="Trend not available" description="The analytics service did not return data." /> : (
        <div style={{ height: 220 }} role="img" aria-label={`${title} ${TREND_LABEL[metric]}: ${data.map((d) => `${d.label} ${Math.round(d.value)}`).join(', ')}`}>
          <ResponsiveContainer>
            <BarChart data={data}>
              <CartesianGrid stroke="var(--c-outline-variant)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: 'var(--c-on-surface-variant)', fontSize: 12 }} />
              <YAxis tick={{ fill: 'var(--c-on-surface-variant)', fontSize: 12 }} width={56} />
              <Tooltip formatter={(v) => show(Number(v))} />
              <Bar dataKey="value" name={TREND_LABEL[metric]} fill={CHART_COLORS[0]} radius={[6, 6, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------- Activity tracking
interface Act { key: string; at: number; type: string; billNo: string; patient: string; userId: string; user: string; text: string; total: number | null }

const ACT_TYPES = ['Bill created', 'Payment', 'Due cleared', 'Refund', 'Payment reversed', 'Approval', 'Dispatch', 'Other'] as const

function ActivityTab({ orders, range }: { orders: OrderExt[]; range: Range }) {
  const scope = useBranchScope({ analytics: true })
  const users = useUsers()
  const { map: ledgers } = useLedgers(orders)
  const { map: results } = useResults(orders)
  const [deliv, setDeliv] = useState<Record<string, Delivery[]>>({})
  useEffect(() => {
    let live = true
    Promise.all(orders.slice(0, FAN_OUT_CAP).map((o) => getDocs(deliveriesCol(o.id)).then((s) => [o.id, s.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as Delivery)] as const).catch(() => [o.id, []] as const)))
      .then((p) => live && setDeliv(Object.fromEntries(p)))
    return () => { live = false }
  }, [orders])

  const feed = useLiveQuery<{ id: string; type: string; text: string; refPath?: string; at: Timestamp; by: string; byName: string }>(
    query(col('activity'), ...scope.constraints, where('at', '>=', Timestamp.fromDate(range[0].startOf('day').toDate())), where('at', '<=', Timestamp.fromDate(range[1].endOf('day').toDate())), orderBy('at', 'desc')),
    [range[0].valueOf(), range[1].valueOf(), scope.key],
  )

  const [user, setUser] = useState<string>('')
  const [type, setType] = useState<string>('')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const out: Act[] = []
    const lo = range[0].startOf('day').valueOf(), hi = range[1].endOf('day').valueOf()
    const inR = (t: number | null) => t != null && t >= lo && t <= hi
    const nm = (uid: string, fallback?: string) => fallback || users.nameOf.get(uid) || uid || 'Unknown'
    for (const o of orders) {
      const base = { billNo: o.billNo, patient: o.patientName }
      out.push({ ...base, key: `b${o.id}`, at: tsMs(o.createdAt) ?? 0, type: 'Bill created', userId: o.createdBy, user: nm(o.createdBy, o.createdByName), text: `${o.items.length} line(s), ${testCount(o)} test(s)`, total: o.net })
      for (const e of ledgers[o.id] ?? []) {
        const at = tsMs(e.postedAt)
        if (!inR(at)) continue
        out.push({ ...base, key: `l${o.id}${e.id}`, at: at!, type: e.type === 'clearDue' ? 'Due cleared' : e.type === 'refund' ? 'Refund' : e.type === 'reversal' ? 'Payment reversed' : 'Payment', userId: e.postedBy, user: nm(e.postedBy, e.postedByName), text: `${MODE_TITLE[modeBucket(e.mode)]}${e.reference ? ` ref ${e.reference}` : ''}`, total: Math.abs(e.amount) })
      }
      for (const r of results[o.id] ?? []) {
        const at = tsMs(r.updatedAt)
        if (r.status === 'approved' && inR(at)) out.push({ ...base, key: `a${o.id}${r.id}`, at: at!, type: 'Approval', userId: r.approvedBy, user: nm(r.approvedBy, r.approvedByName), text: `Approved ${r.testName}`, total: null })
      }
      for (const d of deliv[o.id] ?? []) {
        const at = tsMs(d.at)
        if (inR(at)) out.push({ ...base, key: `d${o.id}${d.id}`, at: at!, type: 'Dispatch', userId: d.sentBy, user: nm(d.sentBy, d.sentByName), text: `${d.kind} via ${d.channel} (${d.status})`, total: null })
      }
    }
    for (const f of feed.data) out.push({ key: `f${f.id}`, at: tsMs(f.at) ?? 0, type: 'Other', billNo: '', patient: '', userId: f.by, user: nm(f.by, f.byName), text: `${f.type}: ${f.text}`, total: null })
    return out.sort((a, b) => b.at - a.at)
  }, [orders, ledgers, results, deliv, feed.data, range, users.nameOf])

  const shown = rows.filter((r) => (!user || r.userId === user) && (!type || r.type === type) && (!q || `${r.billNo} ${r.patient} ${r.text}`.toLowerCase().includes(q.toLowerCase())))
  const variant = (t: string) => (t === 'Refund' || t === 'Payment reversed' ? 'urgent' : t === 'Due cleared' || t === 'Payment' ? 'success' : t === 'Approval' ? 'info' : 'neutral') as 'urgent' | 'success' | 'info' | 'neutral'

  return (
    <Card>
      <div className="an-pill-row">
        <Select allowClear showSearch optionFilterProp="label" placeholder="All users" aria-label="Filter by user" style={{ width: 200 }} value={user || undefined} onChange={(v) => setUser(v ?? '')} options={users.list.map((u) => ({ value: u.uid, label: u.name }))} />
        <Select allowClear placeholder="All activity" aria-label="Filter by activity" style={{ width: 170 }} value={type || undefined} onChange={(v) => setType(v ?? '')} options={ACT_TYPES.map((t) => ({ value: t, label: t }))} />
        <Input allowClear placeholder="Search bill, patient, change" aria-label="Search activity" style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="an-toolbar__spacer" />
        <ExportButton disabled={!shown.length} onClick={() => downloadCsv('activity.csv', [['Date and time', 'Bill ID', 'Patient name', 'User name', 'Activity', 'Changes', 'Total amount'], ...shown.map((r) => [tsFull({ toMillis: () => r.at }), r.billNo, r.patient, r.user, r.type, r.text, r.total == null ? '' : rupees(r.total)])])} />
      </div>
      {feed.error && <p className="an-note">The activity feed needs an index that is not deployed yet; showing bill events only.</p>}
      <Table<Act> size="small" rowKey="key" dataSource={shown} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 900 }} locale={{ emptyText: 'No activity in this range' }}
        columns={[
          { title: 'Date and time', width: 150, render: (_, r) => tsFull({ toMillis: () => r.at }) },
          { title: 'Bill ID', dataIndex: 'billNo', width: 110 },
          { title: 'Patient name', dataIndex: 'patient' },
          { title: 'User name', dataIndex: 'user' },
          { title: 'Activity', render: (_, r) => <StatusChip variant={variant(r.type)}>{r.type}</StatusChip> },
          { title: 'Changes', dataIndex: 'text' },
          { title: 'Total amount', align: 'right', render: (_, r) => (r.total == null ? '' : money(r.total)) },
        ]} />
    </Card>
  )
}

// ---------------------------------------------------------------- Audit log (append-only)
const AUDIT_CATEGORIES = ['LOGIN', 'BILLING', 'RESULT', 'VERIFY', 'DISCOUNT', 'DELETE', 'REFUND', 'SETTINGS', 'QC', 'EXPORT', 'ADMIN_ACCESS', 'OTHER']
interface AuditRow { id: string; category: string; type: string; text: string; entity: string; before: unknown; after: unknown; reason: string; by: string; byName: string; role: string; at: Timestamp }

function AuditTab({ range }: { range: Range }) {
  const scope = useBranchScope({ analytics: true })
  const feed = useLiveQuery<AuditRow>(
    query(col('auditLog'), ...scope.constraints, where('at', '>=', Timestamp.fromDate(range[0].startOf('day').toDate())), where('at', '<=', Timestamp.fromDate(range[1].endOf('day').toDate())), orderBy('at', 'desc')),
    [range[0].valueOf(), range[1].valueOf(), scope.key],
  )
  const [cat, setCat] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<AuditRow | null>(null)
  const shown = feed.data.filter((r) => (!cat || r.category === cat) && (!q || `${r.byName} ${r.text} ${r.entity}`.toLowerCase().includes(q.toLowerCase())))
  return (
    <Card>
      <p className="an-note">Append-only: entries cannot be edited or deleted and are kept for audit. Support-access sessions, when used, appear under ADMIN_ACCESS.</p>
      <div className="an-pill-row">
        <Select allowClear placeholder="All categories" aria-label="Filter by category" style={{ width: 190 }} value={cat || undefined} onChange={(v) => setCat(v ?? '')} options={AUDIT_CATEGORIES.map((c) => ({ value: c, label: c }))} />
        <Input allowClear placeholder="Search user or change" aria-label="Search audit log" style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="an-toolbar__spacer" />
        <ExportButton disabled={!shown.length} onClick={() => downloadCsv('audit-log.csv', [['Date and time', 'Category', 'User', 'Role', 'Change', 'Entity', 'Reason'], ...shown.map((r) => [tsFull(r.at), r.category, r.byName, r.role, r.text, r.entity, r.reason])])} />
      </div>
      {feed.error && <p className="an-note">The audit log needs an index that is not deployed yet.</p>}
      <Table<AuditRow> size="small" rowKey="id" loading={feed.loading} dataSource={shown} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 900 }} locale={{ emptyText: 'No audit entries in this range' }}
        columns={[
          { title: 'Date and time', width: 150, render: (_, r) => tsFull(r.at) },
          { title: 'Category', render: (_, r) => <StatusChip variant={r.category === 'DELETE' || r.category === 'REFUND' ? 'urgent' : 'neutral'}>{r.category}</StatusChip> },
          { title: 'User', render: (_, r) => `${r.byName}${r.role ? ` (${r.role})` : ''}` },
          { title: 'Change', dataIndex: 'text' },
          { title: '', render: (_, r) => <a href="#details" onClick={(e) => { e.preventDefault(); setOpen(r) }} aria-label="Show before and after">Details</a> },
        ]} />
      <Drawer title="Audit entry" open={!!open} onClose={() => setOpen(null)} width={460}>
        {open && (
          <div>
            <p><strong>{open.category}</strong> by {open.byName} ({open.role || 'role unknown'}) at {tsFull(open.at)}</p>
            <p>{open.text}</p>
            {open.reason && <p>Reason: {open.reason}</p>}
            <p>Entity: {open.entity || '-'}</p>
            <h4>Before</h4><pre style={{ whiteSpace: 'pre-wrap' }}>{open.before == null ? 'Not recorded' : JSON.stringify(open.before, null, 2)}</pre>
            <h4>After</h4><pre style={{ whiteSpace: 'pre-wrap' }}>{open.after == null ? 'Not recorded' : JSON.stringify(open.after, null, 2)}</pre>
          </div>
        )}
      </Drawer>
    </Card>
  )
}
