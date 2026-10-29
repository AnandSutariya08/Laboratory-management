import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { DatePicker, Select, Table } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { EmptyState } from '../../design/EmptyState'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { SkeletonCard } from '../../design/Skeletons'
import { StatusChip } from '../../design/StatusChip'
import { useBranch } from '../../branch/BranchProvider'
import { loadDashboard, type DashAlert, type DashBranch, type DashboardData } from '../../lib/dashboard'
import { formatINR } from '../../lib/money'
import './dashboard.css'

// Admin dashboard: the lab at a glance for a period and a set of branches. Every number links to the screen with
// the detail. Data comes from one server call (functions/src/dashboard.ts) and refreshes every 2 minutes.

type Preset = 'today' | 'yesterday' | '7d' | 'month' | 'lastMonth' | 'custom'
const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'month', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'custom', label: 'Custom' },
]
const rangeOf = (p: Preset, custom: [Dayjs, Dayjs]): [Dayjs, Dayjs] => {
  const t = dayjs()
  if (p === 'today') return [t, t]
  if (p === 'yesterday') return [t.subtract(1, 'day'), t.subtract(1, 'day')]
  if (p === '7d') return [t.subtract(6, 'day'), t]
  if (p === 'month') return [t.startOf('month'), t]
  if (p === 'lastMonth') return [t.subtract(1, 'month').startOf('month'), t.subtract(1, 'month').endOf('month')]
  return custom
}
const PREV_LABEL: Record<Preset, string> = { today: 'yesterday', yesterday: 'the day before', '7d': 'the 7 days before', month: 'the same days before', lastMonth: 'the month before', custom: 'the period before' }

const LS_KEY = 'hcl.dashboard.filters'
const REFRESH_MS = 2 * 60_000

// Compact rupees for headline numbers: ₹1.2 L, ₹3.4 Cr; exact value in the tooltip.
function compact(paise: number) {
  const r = paise / 100
  const a = Math.abs(r)
  if (a >= 1e7) return `₹${(r / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(r / 1e5).toFixed(2)} L`
  return `₹${Math.round(r).toLocaleString('en-IN')}`
}
const num = (v: number) => v.toLocaleString('en-IN')
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

function Delta({ cur, prev, good = 'up', label }: { cur: number; prev: number; good?: 'up' | 'down'; label: string }) {
  if (!prev && !cur) return <span className="db-delta db-delta--flat">No change vs {label}</span>
  if (!prev) return <span className="db-delta db-delta--flat">New vs {label}</span>
  const d = Math.round(((cur - prev) / Math.abs(prev)) * 100)
  if (d === 0) return <span className="db-delta db-delta--flat">Same as {label}</span>
  const better = good === 'up' ? d > 0 : d < 0
  return (
    <span className={`db-delta ${better ? 'db-delta--good' : 'db-delta--bad'}`}>
      <span aria-hidden>{d > 0 ? '▲' : '▼'}</span> {Math.abs(d)}% vs {label}
    </span>
  )
}

function Kpi({ label, value, title, foot, to }: { label: string; value: string; title?: string; foot: ReactNode; to: string }) {
  return (
    <Link to={to} className="db-kpi card card--interactive" aria-label={`${label}: ${value}`}>
      <span className="db-kpi__label">{label}</span>
      <span className="db-kpi__value" title={title}>{value}</span>
      <span className="db-kpi__foot">{foot}</span>
    </Link>
  )
}

export default function DashboardPage() {
  const { branches } = useBranch()
  const saved = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as { preset?: Preset; branchIds?: string[] }
    } catch {
      return {}
    }
  }, [])
  const [preset, setPreset] = useState<Preset>(saved.preset && saved.preset !== 'custom' ? saved.preset : 'today')
  const [custom, setCustom] = useState<[Dayjs, Dayjs]>([dayjs().subtract(6, 'day'), dayjs()])
  const [branchIds, setBranchIds] = useState<string[]>(saved.branchIds ?? [])
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const range = useMemo(() => rangeOf(preset, custom), [preset, custom])
  const from = range[0].format('YYYY-MM-DD')
  const to = range[1].format('YYYY-MM-DD')
  const key = `${from}|${to}|${branchIds.join(',')}`

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ preset, branchIds }))
    } catch {
      // private mode: filters are simply not remembered
    }
  }, [preset, branchIds])

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true)
      setError('')
      try {
        setData(await loadDashboard(from, to, branchIds))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The dashboard could not be loaded.')
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  )
  useEffect(() => {
    void load()
    const t = setInterval(() => document.visibilityState === 'visible' && void load(true), REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  const options = (data?.branchesAvailable ?? branches.map((b) => ({ id: b.id, name: b.name, active: b.active }))).map((b) => ({ value: b.id, label: b.name }))
  const scopeLabel = !branchIds.length ? 'All branches' : branchIds.length === 1 ? (options.find((o) => o.value === branchIds[0])?.label ?? 'One branch') : `${branchIds.length} branches`
  const vs = PREV_LABEL[preset]
  const k = data?.kpi

  return (
    <div className="db">
      <PageHeader
        title="Dashboard"
        subtitle={data ? `${scopeLabel} · ${from === to ? range[0].format('D MMM YYYY') : `${range[0].format('D MMM')} – ${range[1].format('D MMM YYYY')}`} · updated ${dayjs(data.asOf).format('h:mm A')}` : scopeLabel}
        actions={<Button icon={<ReloadOutlined />} onClick={() => void load()} disabled={loading}>Refresh</Button>}
      />

      <div className="db-filters" role="group" aria-label="Dashboard filters">
        <Select
          mode="multiple"
          allowClear
          aria-label="Branches"
          className="db-filters__branch"
          placeholder="All branches"
          value={branchIds}
          onChange={setBranchIds}
          options={options}
          maxTagCount="responsive"
        />
        <Segmented<Preset> aria-label="Period" value={preset} onChange={setPreset} options={PRESETS} />
        {preset === 'custom' && (
          <DatePicker.RangePicker
            aria-label="Custom dates"
            allowClear={false}
            value={custom}
            disabledDate={(d) => d.isAfter(dayjs(), 'day')}
            onChange={(v) => v?.[0] && v[1] && setCustom([v[0], v[1]])}
          />
        )}
      </div>

      {error && (
        <Card className="db-error" role="alert">
          <EmptyState title="Could not load the dashboard" description={error} />
          <Button onClick={() => void load()}>Try again</Button>
        </Card>
      )}

      {loading && !data ? (
        <div className="db-kpis">{Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} lines={2} />)}</div>
      ) : data && k ? (
        <div className={loading ? 'db-body db-body--loading' : 'db-body'} aria-busy={loading}>
          <section className="db-kpis" aria-label="Headline numbers">
            <Kpi label="Revenue billed" value={compact(k.cur.billed)} title={formatINR(k.cur.billed)} to="/analysis" foot={<Delta cur={k.cur.billed} prev={k.prev.billed} label={vs} />} />
            <Kpi label="Collected" value={compact(k.cur.collected)} title={formatINR(k.cur.collected)} to="/finance" foot={<Delta cur={k.cur.collected} prev={k.prev.collected} label={vs} />} />
            <Kpi label="Outstanding due" value={compact(k.outstanding.amount)} title={formatINR(k.outstanding.amount)} to="/finance" foot={<span className="db-delta db-delta--flat">{num(k.outstanding.bills)} unpaid bill{k.outstanding.bills === 1 ? '' : 's'}, all time</span>} />
            <Kpi label="Patients" value={num(k.cur.patients)} to="/patients" foot={<Delta cur={k.cur.patients} prev={k.prev.patients} label={vs} />} />
            <Kpi label="Tests" value={num(k.cur.tests)} to="/worklist" foot={<Delta cur={k.cur.tests} prev={k.prev.tests} label={vs} />} />
            <Kpi label="Average bill" value={compact(k.cur.avgBill)} title={formatINR(k.cur.avgBill)} to="/analysis" foot={<Delta cur={k.cur.avgBill} prev={k.prev.avgBill} label={vs} />} />
            <Kpi label="Reports completed" value={`${pct(k.cur.final, k.cur.bills)}%`} to="/patients" foot={<span className="db-delta db-delta--flat">{num(k.cur.final)} of {num(k.cur.bills)} bills fully reported</span>} />
            <Kpi label="Reports delivered" value={`${pct(k.cur.delivered, k.cur.bills)}%`} to="/dispatch" foot={<span className="db-delta db-delta--flat">{num(k.cur.delivered)} of {num(k.cur.bills)} sent to patients</span>} />
          </section>

          <div className="db-row db-row--ops">
            <Pipeline data={data} />
            <Alerts alerts={data.alerts} />
          </div>

          <div className="db-row db-row--money">
            <Trend data={data} vs={vs} />
            <Modes modes={data.modes} discount={k.cur.discount} refunds={k.cur.refunds} />
          </div>

          {data.branches.length > 1 && <Branches rows={data.branches} />}
        </div>
      ) : null}
    </div>
  )
}

// ---- Work pipeline ------------------------------------------------------------------------------------------
function Pipeline({ data }: { data: DashboardData }) {
  const p = data.pipeline
  const steps = [
    ...(p.accessionOn
      ? [
          { label: 'To collect', count: p.toCollect, unit: 'tests', to: '/accession', hint: 'Billed, sample not collected yet' },
          { label: 'On the way', count: p.collected, unit: 'tests', to: '/accession', hint: 'Collected, not received in the lab' },
        ]
      : []),
    { label: 'In the lab', count: p.inLab, unit: 'tests', to: '/worklist', hint: 'Waiting for results' },
    { label: 'Waiting approval', count: p.waitingApproval, unit: 'tests', to: '/worklist', hint: 'Results entered, not approved' },
    { label: 'Ready to send', count: p.readyToSend, unit: 'bills', to: '/dispatch', hint: 'Reports complete, not delivered' },
  ]
  const h = data.home
  return (
    <Card as="section" className="db-card" aria-label="Work in progress">
      <div className="db-card__head">
        <h2 className="db-card__title">Work in progress</h2>
        <span className="db-card__sub">Right now, last 90 days of bills</span>
      </div>
      <ol className="db-pipe">
        {steps.map((s) => (
          <li key={s.label}>
            <Link to={s.to} className="db-pipe__step" title={s.hint}>
              <span className="db-pipe__count">{num(s.count)}</span>
              <span className="db-pipe__label">{s.label}</span>
              <span className="db-pipe__unit">{s.unit}</span>
            </Link>
          </li>
        ))}
      </ol>
      <div className="db-pipe__foot">
        {p.lateTests > 0 ? (
          <Link to="/tat"><StatusChip variant="urgent">{num(p.lateTests)} test{p.lateTests === 1 ? '' : 's'} late</StatusChip></Link>
        ) : (
          <StatusChip variant="success">Nothing late</StatusChip>
        )}
        {p.nearlyLate > 0 && <Link to="/tat"><StatusChip variant="caution">{num(p.nearlyLate)} due soon</StatusChip></Link>}
        {p.hold > 0 && <Link to="/worklist"><StatusChip variant="caution">{num(p.hold)} on hold</StatusChip></Link>}
        {h.total > 0 && (
          <Link to="/bookings" className="db-pipe__home">
            Home collections: {num(h.done)} done, {num(h.pending)} upcoming{h.missed ? `, ${num(h.missed)} overdue` : ''}{h.cancelled ? `, ${num(h.cancelled)} cancelled` : ''}
          </Link>
        )}
      </div>
    </Card>
  )
}

// ---- Attention needed ---------------------------------------------------------------------------------------
const LEVEL: Record<DashAlert['level'], { variant: 'urgent' | 'caution' | 'info'; label: string }> = {
  urgent: { variant: 'urgent', label: 'Urgent' },
  caution: { variant: 'caution', label: 'Check' },
  info: { variant: 'info', label: 'For info' },
}
function Alerts({ alerts }: { alerts: DashAlert[] }) {
  return (
    <Card as="section" className="db-card" aria-label="Attention needed">
      <div className="db-card__head">
        <h2 className="db-card__title">Attention needed</h2>
        {alerts.length > 0 && <span className="db-card__sub">{alerts.length} item{alerts.length === 1 ? '' : 's'}</span>}
      </div>
      {!alerts.length ? (
        <div className="db-clear">
          <StatusChip variant="success">All clear</StatusChip>
          <p>No late reports, critical values, failed sends, QC failures or offline analysers.</p>
        </div>
      ) : (
        <ul className="db-alerts">
          {alerts.map((a) => (
            <li key={a.key} className={`db-alert db-alert--${a.level}`}>
              <div className="db-alert__top">
                <StatusChip variant={LEVEL[a.level].variant}>{LEVEL[a.level].label}</StatusChip>
                <Link to={a.link} className="db-alert__title">
                  {a.title}: <b>{num(a.count)}</b>
                </Link>
              </div>
              <p className="db-alert__detail">{a.detail}</p>
              {!!a.items?.length && (
                <ul className="db-alert__items">
                  {a.items.map((it, i) => (
                    <li key={i}><Link to={it.link}>{it.label}</Link></li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---- Money --------------------------------------------------------------------------------------------------
function Trend({ data, vs }: { data: DashboardData; vs: string }) {
  const rows = data.trend.map((t) => ({ ...t, label: dayjs(t.date).format(data.trend.length > 62 ? 'MMM D' : 'D MMM') }))
  const k = data.kpi
  return (
    <Card as="section" className="db-card" aria-label="Revenue">
      <div className="db-card__head">
        <h2 className="db-card__title">Billed and collected</h2>
        <span className="db-card__sub">Per day, with {vs} as a dashed line</span>
      </div>
      {rows.length < 2 ? (
        <div className="db-compare">
          {[
            { label: 'Billed', cur: k.cur.billed, prev: k.prev.billed, cls: 'db-series-1' },
            { label: 'Collected', cur: k.cur.collected, prev: k.prev.collected, cls: 'db-series-2' },
          ].map((r) => {
            const max = Math.max(r.cur, r.prev, 1)
            return (
              <div key={r.label} className="db-compare__row">
                <span className="db-compare__name">{r.label}</span>
                <div className="db-compare__bars">
                  <div className="db-compare__line"><span className={`db-compare__bar ${r.cls}`} style={{ width: `${(r.cur / max) * 100}%` }} /><span className="db-compare__val">{formatINR(r.cur)}</span></div>
                  <div className="db-compare__line"><span className={`db-compare__bar ${r.cls} db-compare__bar--prev`} style={{ width: `${(r.prev / max) * 100}%` }} /><span className="db-compare__val db-compare__val--muted">{formatINR(r.prev)} {vs}</span></div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="db-chart" role="img" aria-label={`Billed and collected per day: ${rows.map((r) => `${r.label} billed ${Math.round(r.billed / 100)} collected ${Math.round(r.collected / 100)}`).join('; ')}`}>
          <ResponsiveContainer>
            <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--c-outline-variant)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: 'var(--c-on-surface-variant)', fontSize: 12 }} tickLine={false} axisLine={{ stroke: 'var(--c-outline-variant)' }} minTickGap={16} />
              <YAxis tick={{ fill: 'var(--c-on-surface-variant)', fontSize: 12 }} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => compact(Number(v))} />
              <Tooltip
                formatter={(v, name) => [formatINR(Number(v)), name]}
                contentStyle={{ background: 'var(--c-surface-container-high)', border: '1px solid var(--c-outline-variant)', borderRadius: 12, color: 'var(--c-on-surface)' }}
                labelStyle={{ color: 'var(--c-on-surface)', fontWeight: 600 }}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--c-on-surface-variant)' }} />
              <Line type="monotone" dataKey="prevBilled" name={`Billed, ${vs}`} stroke="var(--db-series-1)" strokeOpacity={0.45} strokeDasharray="5 4" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="billed" name="Billed" stroke="var(--db-series-1)" strokeWidth={2} dot={rows.length <= 14 ? { r: 4 } : false} activeDot={{ r: 5 }} isAnimationActive={false} />
              <Line type="monotone" dataKey="collected" name="Collected" stroke="var(--db-series-2)" strokeWidth={2} dot={rows.length <= 14 ? { r: 4 } : false} activeDot={{ r: 5 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

const MODE_NAMES: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', wallet: 'B2B wallet', other: 'Other / online' }
function Modes({ modes, discount, refunds }: { modes: Record<string, number>; discount: number; refunds: number }) {
  const rows = Object.entries(modes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const total = rows.reduce((a, [, v]) => a + v, 0)
  const max = Math.max(1, ...rows.map(([, v]) => v))
  return (
    <Card as="section" className="db-card" aria-label="Payment methods">
      <div className="db-card__head">
        <h2 className="db-card__title">How patients paid</h2>
        <span className="db-card__sub">Money taken in the period</span>
      </div>
      {!rows.length ? (
        <EmptyState title="No payments in this period" />
      ) : (
        <ul className="db-modes">
          {rows.map(([m, v]) => (
            <li key={m} className="db-modes__row">
              <span className="db-modes__name">{MODE_NAMES[m] ?? m}</span>
              <span className="db-modes__track" aria-hidden><span className="db-modes__bar" style={{ width: `${(v / max) * 100}%` }} /></span>
              <span className="db-modes__val">{formatINR(v)} <span className="db-modes__pct">{pct(v, total)}%</span></span>
            </li>
          ))}
        </ul>
      )}
      <dl className="db-modes__foot">
        <div><dt>Discounts given</dt><dd>{formatINR(discount)}</dd></div>
        <div><dt>Refunds paid</dt><dd>{formatINR(refunds)}</dd></div>
      </dl>
    </Card>
  )
}

// ---- Branch comparison --------------------------------------------------------------------------------------
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 96 + 2},${22 - (v / max) * 20}`).join(' ')
  return (
    <svg className="db-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--db-series-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}
function Branches({ rows }: { rows: DashBranch[] }) {
  const money = (v: number) => <span title={formatINR(v)}>{compact(v)}</span>
  return (
    <Card as="section" className="db-card" aria-label="Branch comparison">
      <div className="db-card__head">
        <h2 className="db-card__title">Branches</h2>
        <span className="db-card__sub">Click a column title to sort</span>
      </div>
      <Table<DashBranch>
        rowKey="id"
        size="middle"
        pagination={false}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: 'Branch', dataIndex: 'name', fixed: 'left', sorter: (a, b) => a.name.localeCompare(b.name) },
          { title: 'Billed', dataIndex: 'billed', align: 'right', defaultSortOrder: 'descend', sorter: (a, b) => a.billed - b.billed, render: money },
          { title: 'Collected', dataIndex: 'collected', align: 'right', sorter: (a, b) => a.collected - b.collected, render: money },
          { title: 'Outstanding', dataIndex: 'outstanding', align: 'right', sorter: (a, b) => a.outstanding - b.outstanding, render: money },
          { title: 'Bills', dataIndex: 'bills', align: 'right', sorter: (a, b) => a.bills - b.bills, render: num },
          { title: 'Patients', dataIndex: 'patients', align: 'right', sorter: (a, b) => a.patients - b.patients, render: num },
          { title: 'Tests', dataIndex: 'tests', align: 'right', sorter: (a, b) => a.tests - b.tests, render: num },
          { title: 'Open bills', dataIndex: 'openBills', align: 'right', sorter: (a, b) => a.openBills - b.openBills, render: num },
          {
            title: 'Late tests',
            dataIndex: 'lateTests',
            align: 'right',
            sorter: (a, b) => a.lateTests - b.lateTests,
            render: (v: number) => (v ? <StatusChip variant="urgent">{num(v)}</StatusChip> : <span className="db-muted">0</span>),
          },
          ...(rows[0]?.trend.length > 1 ? [{ title: 'Billed per day', dataIndex: 'trend', width: 140, render: (v: number[]) => <Spark values={v} /> }] : []),
        ]}
      />
    </Card>
  )
}
