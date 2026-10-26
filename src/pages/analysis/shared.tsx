import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { DatePicker } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { collectionGroup, doc, getDoc, getDocs, orderBy, query, Timestamp, where, type QueryConstraint } from 'firebase/firestore'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { useLiveQuery } from '../../hooks/useLive'
import { col, ledgerCol, resultsCol } from '../../lib/db'
import { db, LAB_ID } from '../../firebase'
import { downloadCsv } from '../../components/billing/helpers'
import type { LedgerEntry, Order, OrderItem, Patient, TestResult, UserProfile } from '../../types'
import './analysis.css'

export { downloadCsv }

// Order fields other modules (registration, partners) may add. All optional so
// legacy bills still work; read defensively.
export interface OrderExt extends Order {
  b2bCentreId?: string
  b2bCentreName?: string
  corporateClientId?: string
  corporateClientName?: string
  corporatePlan?: string
  referrerId?: string
  hospitalName?: string
  secondReferral?: string
  proName?: string
  tpaName?: string
  govPanelName?: string
  collectionCentreName?: string
  rateListName?: string
  createdByName?: string
  collectedByName?: string
  areaManager?: string
  districtManager?: string
  stateManager?: string
  zoneHead?: string
  cmo?: string
  tatReasons?: Record<string, { reason: string; by: string; at: unknown }>
  rerunTests?: string[]
}

export type Kind = 'b2b' | 'referral' | 'self'
export const KIND_LABEL: Record<Kind, string> = { b2b: 'B2B', referral: 'Referral', self: 'Self' }
export const KINDS: Kind[] = ['b2b', 'referral', 'self']

export function kindOf(o: OrderExt): Kind {
  if (o.b2bCentreName || o.b2bCentreId) return 'b2b'
  const named = (v?: string) => {
    const x = (v ?? '').trim().toLowerCase()
    return !!x && x !== 'self'
  }
  // Referral when a referring doctor, hospital or second referral is set; otherwise self.
  return named(o.referrerName) || !!o.referrerId || named(o.hospitalName) || named(o.secondReferral) ? 'referral' : 'self'
}

export const liveItems = (o: Order): OrderItem[] => o.items.filter((i) => i.status !== 'refunded')
export const testCount = (o: Order) => liveItems(o).reduce((s, i) => s + i.testIds.length, 0)
// Ledger rows that move money in by payment mode: payments, due clearances and their reversals
// (a reversal is a negative row pointing at the payment it undoes). Refunds are shown separately.
export const isMoneyIn = (e: Pick<LedgerEntry, 'type' | 'amount'>) => e.amount > 0 || e.type === 'reversal'
// Due cleared on a bill: clear-due receipts less the reversals of those receipts.
export const clearedOf = (entries: Pick<LedgerEntry, 'id' | 'type' | 'amount' | 'reversesId'>[]) => {
  const clr = new Set(entries.filter((e) => e.type === 'clearDue').map((e) => e.id))
  return entries.reduce((s, e) => s + (e.type === 'clearDue' || (e.type === 'reversal' && e.reversesId && clr.has(e.reversesId)) ? e.amount : 0), 0)
}
export const collectedOf = (o: Order) => o.paid + o.refunded // money in BEFORE refunds; Analysis and Finance show o.paid (net of refunds)
export const lineNet = (i: OrderItem) => i.price - i.discount

export type ModeBucket = 'cash' | 'card' | 'upi' | 'wallet' | 'other'
export const MODE_BUCKETS: ModeBucket[] = ['cash', 'card', 'upi', 'wallet', 'other']
export const MODE_TITLE: Record<ModeBucket, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', wallet: 'Wallet', other: 'Other' }
export const modeBucket = (m: string): ModeBucket => {
  const k = String(m ?? '').toLowerCase()
  return k === 'cash' || k === 'card' || k === 'upi' || k === 'wallet' ? k : 'other'
}

export const tsMs = (t: unknown): number | null => {
  const x = t as { toMillis?: () => number } | null | undefined
  return x && typeof x.toMillis === 'function' ? x.toMillis() : null
}
export const tsDay = (t: unknown) => {
  const m = tsMs(t)
  return m == null ? '' : dayjs(m).format('DD-MM-YYYY')
}
export const tsFull = (t: unknown) => {
  const m = tsMs(t)
  return m == null ? '' : dayjs(m).format('DD-MM-YYYY HH:mm')
}

export const rupees = (paise: number) => Math.round(paise) / 100

// ---- Live shared data -----------------------------------------------------------
export interface MasterDoc {
  id: string
  name?: string
  type?: string
  commissionType?: 'percent' | 'flat' | 'none'
  commissionValue?: number
  [k: string]: unknown
}
export function useMaster(name: string) {
  return useLiveQuery<MasterDoc>(query(col(name)), []).data
}
export function useUsers() {
  const { data } = useLiveQuery<UserProfile>(query(col('users'), orderBy('name')), [])
  return useMemo(() => ({ list: data, nameOf: new Map(data.map((u) => [u.uid ?? (u as unknown as { id: string }).id, u.name])) }), [data])
}

// ---- Fan-out readers (one read per bill; capped; cached) -------------------------
const ledgerCache = new Map<string, LedgerEntry[]>()
const resultCache = new Map<string, TestResult[]>()
const patientCache = new Map<string, Patient | null>()
export const FAN_OUT_CAP = 500

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>, alive: () => boolean) {
  for (let i = 0; i < items.length && alive(); i += size) await Promise.all(items.slice(i, i + size).map(fn))
}

export function useLedgers(orders: Order[], enabled = true) {
  const [map, setMap] = useState<Record<string, LedgerEntry[]>>({})
  const [loading, setLoading] = useState(false)
  const targets = orders.slice(0, FAN_OUT_CAP)
  const sig = targets.map((o) => `${o.id}:${o.paid}:${o.refunded}`).join('|')
  useEffect(() => {
    if (!enabled) return
    let live = true
    setLoading(true)
    const out: Record<string, LedgerEntry[]> = {}
    const todo: Order[] = []
    for (const o of targets) {
      const hit = ledgerCache.get(`${o.id}:${o.paid}:${o.refunded}`)
      if (hit) out[o.id] = hit
      else todo.push(o)
    }
    inBatches(todo, 20, async (o) => {
      const s = await getDocs(ledgerCol(o.id))
      const rows = s.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as LedgerEntry)
      ledgerCache.set(`${o.id}:${o.paid}:${o.refunded}`, rows)
      out[o.id] = rows
    }, () => live)
      .catch(() => undefined)
      .finally(() => {
        if (live) {
          setMap({ ...out })
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, enabled])
  return { map, loading, truncated: orders.length > FAN_OUT_CAP }
}

export function useResults(orders: Order[], enabled = true) {
  const [map, setMap] = useState<Record<string, TestResult[]>>({})
  const [loading, setLoading] = useState(false)
  const targets = orders.slice(0, FAN_OUT_CAP)
  const keyOf = (o: Order) => `${o.id}:${o.reportStatus}:${tsMs(o.reportedAt) ?? 0}:${o.items.map((i) => i.status).join('')}`
  const sig = targets.map(keyOf).join('|')
  useEffect(() => {
    if (!enabled) return
    let live = true
    setLoading(true)
    const out: Record<string, TestResult[]> = {}
    const todo: Order[] = []
    for (const o of targets) {
      const hit = resultCache.get(keyOf(o))
      if (hit) out[o.id] = hit
      else todo.push(o)
    }
    inBatches(todo, 20, async (o) => {
      const s = await getDocs(resultsCol(o.id))
      const rows = s.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as TestResult)
      resultCache.set(keyOf(o), rows)
      out[o.id] = rows
    }, () => live)
      .catch(() => undefined)
      .finally(() => {
        if (live) {
          setMap({ ...out })
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, enabled])
  return { map, loading, truncated: orders.length > FAN_OUT_CAP }
}

export function usePatients(orders: Order[], enabled = true) {
  const [map, setMap] = useState<Record<string, Patient | null>>({})
  const ids = useMemo(() => Array.from(new Set(orders.map((o) => o.patientId))).slice(0, FAN_OUT_CAP), [orders])
  const sig = ids.join('|')
  useEffect(() => {
    if (!enabled) return
    let live = true
    const todo = ids.filter((id) => !patientCache.has(id))
    inBatches(todo, 25, async (id) => {
      const s = await getDoc(doc(db, 'labs', LAB_ID, 'patients', id))
      patientCache.set(id, s.exists() ? ({ ...(s.data() as object), id: s.id } as Patient) : null)
    }, () => live)
      .catch(() => undefined)
      .finally(() => live && setMap(Object.fromEntries(ids.map((id) => [id, patientCache.get(id) ?? null]))))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, enabled])
  return map
}

// ---- UI bits -----------------------------------------------------------------------
export const RANGE_PRESETS = [
  { label: 'Today', value: [dayjs(), dayjs()] as [Dayjs, Dayjs] },
  { label: 'Yesterday', value: [dayjs().subtract(1, 'day'), dayjs().subtract(1, 'day')] as [Dayjs, Dayjs] },
  { label: 'Last 7 days', value: [dayjs().subtract(6, 'day'), dayjs()] as [Dayjs, Dayjs] },
  { label: 'This month', value: [dayjs().startOf('month'), dayjs()] as [Dayjs, Dayjs] },
  { label: 'Last month', value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] as [Dayjs, Dayjs] },
  { label: 'Last 30 days', value: [dayjs().subtract(29, 'day'), dayjs()] as [Dayjs, Dayjs] },
]

export type Range = [Dayjs, Dayjs]
export function RangeBar({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <DatePicker.RangePicker
      aria-label="Date range"
      value={value}
      allowClear={false}
      presets={RANGE_PRESETS}
      onChange={(v) => v?.[0] && v[1] && onChange([v[0], v[1]])}
    />
  )
}

export function Kpi({
  label,
  value,
  tone,
  hint,
  split,
}: {
  label: string
  value: ReactNode
  tone?: 'urgent' | 'success' | 'caution'
  hint?: ReactNode
  split?: [string, ReactNode][]
}) {
  return (
    <Card as="article" className="kpi" aria-label={label}>
      <p className="kpi__label">{label}</p>
      <p className={`kpi__value ${tone ? `kpi__value--${tone}` : ''}`}>{value}</p>
      {hint && <p className="kpi__hint">{hint}</p>}
      {split && (
        <dl className="kpi__split">
          {split.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  )
}

export const CHART_COLORS = [
  'var(--c-primary)',
  'var(--c-success)',
  'var(--c-caution)',
  'var(--c-urgent)',
  'var(--c-accent)',
  'var(--c-outline)',
  'var(--c-info)',
  'var(--c-on-surface-variant)',
]

// Donut with a text legend (label, count, share) so colour is never the only cue.
export function Donut({ title, slices, onSlice }: { title: string; slices: { label: string; value: number }[]; onSlice?: (label: string) => void }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  const data = slices.filter((s) => s.value > 0)
  return (
    <div className="donut">
      <div className="donut__chart" role="img" aria-label={`${title}: ${slices.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data.length ? data : [{ label: 'No data', value: 1 }]} dataKey="value" nameKey="label" innerRadius={55} outerRadius={80} stroke="var(--c-surface-container-high)" isAnimationActive={false}
              onClick={onSlice && data.length ? (e: { label?: string; name?: string }) => onSlice(String(e.label ?? e.name ?? '')) : undefined} style={onSlice ? { cursor: 'pointer' } : undefined}>
              {(data.length ? data : [{ label: 'No data', value: 1 }]).map((s) => {
                const idx = slices.findIndex((x) => x.label === s.label)
                return <Cell key={s.label} fill={data.length ? CHART_COLORS[idx % CHART_COLORS.length] : 'var(--c-outline-variant)'} />
              })}
            </Pie>
            {data.length > 0 && <Tooltip />}
          </PieChart>
        </ResponsiveContainer>
        <div className="donut__centre">
          <b>{total}</b>
          <span>total</span>
        </div>
      </div>
      <ul className="legend">
        {slices.map((s, i) => (
          <li key={s.label}>
            <span className="legend__sw" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} aria-hidden="true" />
            {onSlice && s.value > 0 ? <button type="button" className="legend__link" onClick={() => onSlice(s.label)} aria-label={`Show ${s.label}`}>{s.label}</button> : <span>{s.label}</span>}
            <span className="legend__n">{s.value}</span>
            <span className="legend__p">{total ? `${Math.round((s.value / total) * 100)}%` : '0%'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ExportButton({ onClick, disabled, label = 'Export CSV' }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <Button onClick={onClick} disabled={disabled} aria-label={label}>
      {label}
    </Button>
  )
}

export const money = (paise: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(paise / 100)


// ---- Collection by payment date ------------------------------------------------
// Ledger entries posted inside the range (any bill date), with their parent bills.
// Used by Collection wise so backdated receipts land on the day the money came in.
export function useLedgerByPostedAt(range: [Dayjs, Dayjs], constraints: QueryConstraint[], key: string, enabled = true) {
  const [state, setState] = useState<{ orders: OrderExt[]; ledgers: Record<string, LedgerEntry[]>; loading: boolean }>({ orders: [], ledgers: {}, loading: false })
  const from = range[0].startOf('day').valueOf()
  const to = range[1].endOf('day').valueOf()
  useEffect(() => {
    if (!enabled) return
    let live = true
    setState((s) => ({ ...s, loading: true }))
    ;(async () => {
      const snap = await getDocs(query(collectionGroup(db, 'ledger'), ...constraints, where('postedAt', '>=', Timestamp.fromMillis(from)), where('postedAt', '<=', Timestamp.fromMillis(to))))
      const ledgers: Record<string, LedgerEntry[]> = {}
      for (const d of snap.docs) {
        const oid = d.ref.parent.parent?.id
        if (oid) (ledgers[oid] ??= []).push({ ...(d.data() as object), id: d.id } as LedgerEntry)
      }
      const ids = Object.keys(ledgers)
      const orders: OrderExt[] = []
      await inBatches(ids, 25, async (id) => {
        const s = await getDoc(doc(db, 'labs', LAB_ID, 'orders', id))
        if (s.exists() && (s.data() as { deleted?: boolean }).deleted !== true) orders.push({ ...(s.data() as object), id: s.id } as OrderExt)
      }, () => live)
      if (live) setState({ orders: orders.sort((a, b) => (tsMs(b.createdAt) ?? 0) - (tsMs(a.createdAt) ?? 0)), ledgers, loading: false })
    })().catch(() => live && setState({ orders: [], ledgers: {}, loading: false }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, key, enabled])
  return state
}
