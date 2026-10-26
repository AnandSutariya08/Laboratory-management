import { useCallback, useMemo, useState } from 'react'
import { useOutsourceLookup } from '../../features/outsource/lib'
import dayjs from 'dayjs'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { SkeletonCard } from '../../design/Skeletons'
import { useBranch } from '../../branch/BranchProvider'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { useBranchScope } from '../../lib/branchScope'
import { ordersInRange } from '../../components/billing/helpers'
import { RangeBar, useLedgerByPostedAt, useLedgers, usePatients, useMaster, useResults, useUsers, type OrderExt, type Range } from './shared'
import { BASE_LABEL, buildRows, PRESETS, type BaseTab, type Ctx } from './finance/model'
import { applyFilters, FilterBar, resolveCols, RowsTable, type TabFilters } from './finance/RowsTable'
import CommissionTab from './finance/CommissionTab'
import CustomTab from './finance/CustomTab'
import ExportsTab from './finance/ExportsTab'
import MarginTab from './finance/MarginTab'
import StatementsTab from './finance/StatementsTab'
import SummaryTab from './finance/SummaryTab'

type Tab = BaseTab | 'margin' | 'commission' | 'custom' | 'summary' | 'statements' | 'exports'

export default function FinancePage() {
  useOutsourceLookup() // outsource tab / columns follow the live lab mapping
  const [tab, setTab] = useState<Tab>('billing')
  const [range, setRange] = useState<Range>([dayjs(), dayjs()])
  const [filters, setFilters] = useState<TabFilters>({})
  // Summary basis: bills created in the dates, or money received (ledger) in the dates.
  const [summaryBasis, setSummaryBasis] = useState<'bill' | 'payment'>('bill')
  const payBasis = tab === 'collection' || (tab === 'summary' && summaryBasis === 'payment')
  const scope = useBranchScope({ analytics: true })
  const { current } = useBranch()
  const settings = useLabSettings()
  const cat = useCatalogueMaps()
  const users = useUsers()
  const referrers = [...useMaster('referrers'), ...useMaster('hospitals').map((h) => ({ ...h, type: h.type ?? 'hospital' }))]
  const labs = useMaster('processingLabs')
  const { data: billOrders, loading: billLoading } = useLiveQuery<OrderExt>(ordersInRange(range[0], range[1], scope.constraints), [range[0].valueOf(), range[1].valueOf(), scope.key])
  // Collection wise is selected by PAYMENT date (ledger postedAt), not the bill's date.
  const byPay = useLedgerByPostedAt(range, scope.constraints, scope.key, payBasis)
  const orders = payBasis ? byPay.orders : billOrders
  const loading = payBasis ? byPay.loading : billLoading
  const needsResults = tab === 'test' || tab === 'custom'
  const { map: billLedgers, truncated } = useLedgers(billOrders, !payBasis)
  const ledgers = payBasis ? byPay.ledgers : billLedgers
  const { map: results } = useResults(orders, needsResults)
  const patients = usePatients(orders, tab === 'billing' || tab === 'custom' || tab === 'statements')

  const ctx: Ctx = useMemo(() => ({
    orders, ledgers, results, patients, testById: cat.testById,
    deptName: (id) => cat.departmentById.get(cat.testById.get(id)?.departmentId ?? '')?.name ?? 'Unassigned',
    userName: (uid) => users.nameOf.get(uid) ?? uid,
    referrers, settings,
  }), [orders, ledgers, results, patients, cat.testById, cat.departmentById, users.nameOf, referrers.length, settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const ctxFor = useCallback(() => ({ ctx, labs }), [ctx, labs])

  const base = (['billing', 'collection', 'test', 'outsource'] as BaseTab[]).includes(tab as BaseTab) ? (tab as BaseTab) : null
  const rows = useMemo(() => (base ? applyFilters(buildRows(base, ctx, labs), filters, ctx, labs) : []), [base, ctx, filters, labs])
  const stamp = `${range[0].format('YYYYMMDD')}-${range[1].format('YYYYMMDD')}`

  return (
    <div>
      <PageHeader
        title="Financial analysis"
        subtitle={`${scope.all ? 'All branches' : (current?.name ?? 'Current branch')}: ${orders.length} bills${tab === 'collection' ? ' with payments in the dates' : ''}. Paid is money collected net of refunds.`}
        actions={<RangeBar value={range} onChange={setRange} />}
      />
      <div className="an-toolbar" style={{ overflowX: 'auto' }}>
        <Segmented<Tab> aria-label="Finance sections" value={tab} onChange={(t) => { setTab(t); setFilters({}) }}
          options={[
            ...(Object.keys(BASE_LABEL) as BaseTab[]).map((v) => ({ value: v as Tab, label: BASE_LABEL[v] })),
            { value: 'margin', label: 'Outsource margin' }, { value: 'commission', label: 'Referral commission' }, { value: 'custom', label: 'Custom tab' }, { value: 'summary', label: 'Summary' },
            { value: 'statements', label: 'Mass statements' }, { value: 'exports', label: 'Exports' },
          ]} />
      </div>
      {truncated && <p className="an-note">Payment details are read for the first 500 bills of the period; narrow the dates for exact mode totals.</p>}
      {loading ? <SkeletonCard lines={6} /> : (
        <>
          {base && (
            <div className="an-stack">
              <FilterBar base={base} filters={filters} onChange={setFilters} ctx={ctx} labs={labs} users={users.list} />
              <RowsTable rows={rows} cols={resolveCols(PRESETS[base], labs)} ctx={ctx} fileName={`${base}-wise-${stamp}`}
                empty={base === 'outsource' ? 'No outsourced tests in this period. Tests sent to a processing lab appear here once the outsource module records the lab on the test or bill line.' : undefined} />
            </div>
          )}
          {tab === 'margin' && <MarginTab ctx={ctx} labs={labs} range={range} />}
          {tab === 'commission' && <CommissionTab ctx={ctx} />}
          {tab === 'custom' && <CustomTab ctxFor={ctxFor} users={users.list} range={range} />}
          {tab === 'summary' && <SummaryTab ctx={ctx} basis={summaryBasis} onBasis={setSummaryBasis} range={range} />}
          {tab === 'statements' && <StatementsTab ctx={ctx} range={range} labName={settings.name} />}
          {tab === 'exports' && <ExportsTab ctx={ctx} labs={labs} stamp={stamp} range={range} />}
        </>
      )}
    </div>
  )
}
