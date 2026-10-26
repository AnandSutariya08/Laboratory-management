import { useEffect, useMemo, useState } from 'react'
import { patientListDefaults, showTatIn } from '../../features/settings/lib'
import { useOutsourceLookup } from '../../features/outsource/lib'
import { App, Checkbox, DatePicker, Dropdown, Input, Modal, Popover, Select, Switch, Table } from 'antd'
import {
  DownloadOutlined, FilterOutlined, MoreOutlined, PrinterOutlined, ProfileOutlined, TableOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { getDocs, orderBy, query, where } from 'firebase/firestore'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { can, useAuth } from '../../auth/AuthProvider'
import { useBranch } from '../../branch/BranchProvider'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { useBranchScope } from '../../lib/branchScope'
import { useMasters } from '../../lib/masters'
import { col, paths } from '../../lib/db'
import { formatINR } from '../../lib/money'
import { useMarkDispatched, useMarkDispatchedMany } from '../../features/report/hardCopy'
import { FormFChip } from '../../features/pcpndt/FormFAction'
import { displayId } from '../../lib/billing'
import BulkSendModal from '../../components/messaging/BulkSendModal'
import SendReportModal from '../../components/messaging/SendReportModal'
import BillReceipt from '../../components/billing/BillReceipt'
import ClearDueModal from '../../components/billing/ClearDueModal'
import ShiftCloseModal from '../../components/billing/ShiftCloseModal'
import { PaymentStatusChip } from '../../components/billing/PaymentStatusChip'
import PaymentHistoryModal from '../../components/billing/PaymentHistoryModal'
import RefundModal from '../../components/billing/RefundModal'
import EditBillModal from '../../components/billing/EditBillModal'
import VoidOrderModal from '../../components/billing/VoidOrderModal'
import { ageText, DISPATCH_LABEL, GENDER_SHORT, ordersByBillDate, ordersInRange, tsDate } from '../../components/billing/helpers'
import type { DispatchMode, Order, OrderItem, UserProfile } from '../../types'
import FiltersDrawer from '../../features/patient/FiltersDrawer'
import WorksheetModal from '../../features/patient/WorksheetModal'
import ReportTrackingModal from '../../features/patient/ReportTrackingModal'
import TrfModal from '../../features/patient/TrfModal'
import BarcodeActions from '../../features/patient/BarcodeActions'
import EditPatientModal from '../../features/patient/EditPatientModal'
import {
  bulkResultsCsv, cellText, consolidatedReport, exportCsv, exportPdf, exportWithPayments, markGovPanel, stampHardCopyDelivered, markPcpndt, markPrinted,
} from '../../features/patient/bulk'
import {
  activeFilterCount, columnsFromSettings, COLUMN_KEYS, COLUMN_LABEL, EMPTY_FILTERS, loadColumns, matchesFilters, saveColumns,
  TABS, isFullyRefunded, useLedgerModes, useRefundInfo, type ColumnKey,
} from '../../features/patient/lib'
import type { Filters, PatientDoc, PatientOrder } from '../../features/patient/types'
import { docRef } from '../../lib/db'
import { getDoc } from 'firebase/firestore'
import '../../features/patient/patient.css'

type MenuRow = { key: string; label: string; danger?: boolean }
type Kind = 'bill' | 'clearDue' | 'refund' | 'history' | 'void' | 'send' | 'trf' | 'track' | 'edit' | 'editBill'

const LETTER: Record<OrderItem['status'], { l: string; v: string; t: string }> = {
  pending: { l: 'P', v: '', t: 'Pending' },
  collected: { l: 'C', v: 'info', t: 'Collected' },
  received: { l: 'R', v: 'info', t: 'Received' },
  rejected: { l: 'X', v: 'urgent', t: 'Rejected' },
  entered: { l: 'E', v: 'caution', t: 'Entered' },
  approved: { l: 'D', v: 'success', t: 'Done (approved)' },
  hold: { l: 'H', v: 'caution', t: 'On hold' },
  refunded: { l: 'F', v: 'urgent', t: 'Refunded' },
}

const PRESETS = [
  { label: 'Today', value: [dayjs(), dayjs()] as [Dayjs, Dayjs] },
  { label: 'Yesterday', value: [dayjs().subtract(1, 'day'), dayjs().subtract(1, 'day')] as [Dayjs, Dayjs] },
  { label: 'Last 7 days', value: [dayjs().subtract(6, 'day'), dayjs()] as [Dayjs, Dayjs] },
  { label: 'Last 30 days', value: [dayjs().subtract(29, 'day'), dayjs()] as [Dayjs, Dayjs] },
  { label: 'This month', value: [dayjs().startOf('month'), dayjs()] as [Dayjs, Dayjs] },
  { label: 'Last month', value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] as [Dayjs, Dayjs] },
]

export default function PatientListPage() {
  useOutsourceLookup() // outsource tab / columns follow the live lab mapping
  const { message, modal } = App.useApp()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const { testById } = useCatalogueMaps()
  const { branches } = useBranch()
  const urlQ = params.get('q') ?? ''
  const [search, setSearch] = useState(urlQ)
  const defaults = patientListDefaults(settings)
  const rangeOf = (r: typeof defaults.range): [Dayjs, Dayjs] =>
    r === '7d' ? [dayjs().subtract(6, 'day'), dayjs()] : r === '30d' ? [dayjs().subtract(29, 'day'), dayjs()] : r === 'month' ? [dayjs().startOf('month'), dayjs()] : [dayjs(), dayjs()]
  const [range, setRange] = useState<[Dayjs, Dayjs]>(urlQ ? [dayjs().subtract(90, 'day'), dayjs()] : rangeOf(defaults.range))
  // Settings > Patient list > default tab. "Final" opens the reports-ready tab; "Pending" has no tab of its own.
  const [tab, setTab] = useState(defaults.tab === 'due' ? 'due' : defaults.tab === 'final' ? 'pendingDispatch' : 'all')
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, billSort: defaults.newestFirst ? 'desc' : 'asc' })
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [worksheetOpen, setWorksheetOpen] = useState(false)
  const [cols, setCols] = useState<ColumnKey[]>(() => loadColumns(profile?.uid, columnsFromSettings(defaults.columns)))
  const [selected, setSelected] = useState<string[]>([])
  const [active, setActive] = useState<{ id: string; kind: Kind } | null>(null)
  const [patientIds, setPatientIds] = useState<Set<string>>(new Set())
  const [editPatient, setEditPatient] = useState<PatientDoc | null>(null)
  const [bulkDue, setBulkDue] = useState<Order[] | null>(null)
  const [bulkSendOpen, setBulkSendOpen] = useState(false)
  const [showCancelled, setShowCancelled] = useState(false)
  const [shiftOpen, setShiftOpen] = useState(false)
  const [govPick, setGovPick] = useState<string | undefined>()
  const [govOpen, setGovOpen] = useState(false)
  const masters = useMasters()
  const markDispatched = useMarkDispatched()
  const markMany = useMarkDispatchedMany()

  useEffect(() => setCols(loadColumns(profile?.uid, columnsFromSettings(patientListDefaults(settings).columns))), [profile?.uid, settings])
  const setColumns = (c: ColumnKey[]) => {
    const ordered = COLUMN_KEYS.filter((k) => c.includes(k))
    setCols(ordered)
    saveColumns(profile?.uid, ordered)
  }

  const scope = useBranchScope({ analytics: true })
  // The range applies to the bill date. Bills saved before the bill date existed fall back to
  // their creation time, so both windows are read and merged.
  const byBill = useLiveQuery<PatientOrder>(ordersByBillDate(range[0], range[1], scope.constraints, showCancelled), [range[0].valueOf(), range[1].valueOf(), scope.key, showCancelled])
  const legacy = useLiveQuery<PatientOrder>(ordersInRange(range[0], range[1], scope.constraints, showCancelled), [range[0].valueOf(), range[1].valueOf(), scope.key, showCancelled])
  const loading = byBill.loading || legacy.loading
  const billTime = (o: Order) => (tsDate(o.billDate) ?? tsDate(o.createdAt))?.getTime() ?? 0
  const rawOrders = useMemo(() => {
    const m = new Map<string, PatientOrder>()
    for (const o of byBill.data) m.set(o.id, o)
    for (const o of legacy.data) if (!o.billDate && !m.has(o.id)) m.set(o.id, o)
    return [...m.values()].sort((a, b) => billTime(b) - billTime(a))
  }, [byBill.data, legacy.data])
  const users = useLiveQuery<UserProfile>(query(col(paths.users), orderBy('name')), []).data
  const userName = (uid: string) => users.find((u) => u.uid === uid)?.name ?? ''
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? id
  const showTat = showTatIn(settings, 'patientList')
  const cellCtx = { userName, branchName, urgentTatPercent: settings.tat?.urgentTatPercent }

  // Phone / UHID live on the patient, so look those up when the search looks like one.
  useEffect(() => {
    const q = search.trim()
    if (q.length < 5) return setPatientIds(new Set())
    const t = setTimeout(async () => {
      try {
        const snaps = await Promise.all([
          getDocs(query(col(paths.patients), where('phone', '==', q))),
          getDocs(query(col(paths.patients), where('uhid', '==', q))),
        ])
        setPatientIds(new Set(snaps.flatMap((s) => s.docs.map((d) => d.id))))
      } catch {
        setPatientIds(new Set())
      }
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rawOrders
    return rawOrders.filter(
      (o) =>
        [o.patientName, o.patientNo, o.billNo, o.barcode, o.uhid].some((s) => (s ?? '').toLowerCase().includes(q)) ||
        patientIds.has(o.patientId),
    )
  }, [rawOrders, search, patientIds])

  const ledgerModes = useLedgerModes(searched, !!filters.paymentMode)
  const filtered = useMemo(() => {
    const deptTests = (id: string) => new Set([...testById.values()].filter((t) => t.departmentId === id).map((t) => t.id))
    const ctx = { testsOfDept: deptTests, ledgerModes }
    const out = searched.filter((o) => matchesFilters(o, filters, ctx))
    return filters.billSort === 'asc' ? [...out].reverse() : out
    // ledgerModes is a mutable cache; its size changes when loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, filters, testById, ledgerModes.size])

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, filtered.filter(t.test).length])), [filtered])
  const rows = useMemo(() => filtered.filter(TABS.find((t) => t.key === tab)!.test), [filtered, tab])
  const refundInfo = useRefundInfo(rows, tab === 'refunded')
  const picked = rows.filter((o) => selected.includes(o.id))
  const current = active ? rawOrders.find((o) => o.id === active.id) ?? null : null
  const close = () => setActive(null)
  const open = (o: Order, kind: Kind) => setActive({ id: o.id, kind })
  const bulkTarget = picked.length ? picked : rows
  const exportCols = cols.length ? cols : COLUMN_KEYS.slice()
  const canExport = can(profile, 'patients.export')

  const dispatch = async (order: Order) => {
    const pending = order.dispatch.filter((d) => !d.delivered)
    if (order.dispatch.length === 0) return message.info('No dispatch method was selected for this patient.')
    if (pending.length === 0) return message.info('Already dispatched.')
    const run = async () => {
      let cur = order
      for (const d of pending) {
        if (!(await markDispatched(cur, d.mode))) return
        cur = { ...cur, dispatch: cur.dispatch.map((x) => (x.mode === d.mode ? { ...x, delivered: true } : x)) }
      }
      message.success('Marked as dispatched')
    }
    if (order.reportStatus !== 'final') modal.confirm({ title: 'Report is not final yet', content: 'Mark as dispatched anyway?', onOk: run })
    else await run()
  }

  const markMode = async (order: Order, mode: DispatchMode) => {
    if (await markDispatched(order, mode)) message.success(`${DISPATCH_LABEL[mode]} marked delivered`)
  }

  const bulkDispatch = () =>
    modal.confirm({
      title: `Mark ${bulkTarget.length} bills as dispatched?`,
      content: 'Only bills with a final report and a dispatch method are changed.',
      onOk: async () => {
        const n = await markMany(bulkTarget.filter((x) => x.reportStatus === 'final' && !x.dispatched))
        message.success(`${n} bills dispatched`)
      },
    })

  const bulkPrint = () => {
    const finals = bulkTarget.filter((o) => o.reportStatus !== 'pending')
    if (!finals.length) return message.info('No reports are ready to print.')
    if (finals.length > 10) return message.warning('Select at most 10 bills at a time.')
    finals.forEach((o) => window.open(`/report/${o.id}`, '_blank'))
    if (profile) void markPrinted(finals, profile.uid)
  }

  const openEdit = async (o: Order) => {
    const s = await getDoc(docRef<PatientDoc>(paths.patients, o.patientId))
    if (s.exists()) setEditPatient({ ...s.data(), id: s.id } as PatientDoc)
    else message.error('Patient record not found')
  }

  const run = (fn: () => Promise<unknown> | unknown) => async () => {
    try {
      await fn()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const colDefs: Record<ColumnKey, object> = {
    date: {
      title: 'Bill date', width: 110, sorter: (a: Order, b: Order) => billTime(a) - billTime(b),
      render: (_: unknown, o: Order) => {
        const d = tsDate(o.billDate) ?? tsDate(o.createdAt)
        return d ? <>{dayjs(d).format('DD MMM YY')}<div className="pl-sub">{dayjs(d).format('HH:mm')}</div></> : '...'
      },
    },
    billNo: { title: 'Bill no', dataIndex: 'billNo', width: 100 },
    patient: {
      title: 'Patient info',
      render: (_: unknown, o: PatientOrder) => (
        <>
          <b>{o.patientName}</b>
          <div className="pl-sub">{ageText(o.ageValue, o.ageUnit)} / {GENDER_SHORT[o.gender]} · {displayId(o, settings.registration.idDisplay)}</div>
        </>
      ),
    },
    uhid: { title: 'UHID', render: (_: unknown, o: PatientOrder) => o.uhid ?? '', width: 100 },
    referral: { title: 'Referral', dataIndex: 'referrerName', width: 130 },
    tests: {
      title: 'Tests',
      render: (_: unknown, o: Order) => (
        <div className="pl-letters">
          {o.items.map((i) => {
            const m = LETTER[i.status]
            return (
              <span key={i.lineId} className={`pl-letter ${m.v ? `pl-letter--${m.v}` : ''}`} title={`${i.name}: ${m.t}`}>
                {i.status === 'refunded' ? <s>{i.name}</s> : i.name}
                <b aria-hidden="true">{m.l}</b>
                <span className="sr-only">{m.t}</span>
                {i.urgent && <span className="pl-sub"> urgent</span>}
              </span>
            )
          })}
        </div>
      ),
    },
    amount: {
      title: 'Amount', align: 'right', width: 120,
      render: (_: unknown, o: Order) => (
        <>
          {formatINR(o.net)}
          {o.due > 0 && <div className="pl-money-due">Due {formatINR(o.due)}</div>}
          {o.due > 0 && o.dueRemark && <div className="pl-sub">{o.dueRemark}</div>}
          <div><PaymentStatusChip order={o} /></div>
        </>
      ),
    },
    status: {
      title: 'Status', width: 150,
      render: (_: unknown, o: PatientOrder) => (
        <div className="pl-letters">
          <StatusChip variant={o.reportStatus === 'final' ? 'success' : o.reportStatus === 'pending' ? 'neutral' : 'caution'}>
            {o.reportStatus === 'final' ? 'Completed' : o.reportStatus === 'pending' ? 'Pending' : o.reportStatus === 'partial' ? 'Partial' : 'Provisional'}
          </StatusChip>
          {o.deleted && <StatusChip variant="urgent">Cancelled</StatusChip>}
          {o.dispatched && <StatusChip variant="info">Delivered</StatusChip>}
          {o.printed && <StatusChip variant="neutral">Printed</StatusChip>}
          <FormFChip order={o} />
        </div>
      ),
    },
    barcode: { title: 'Barcode', width: 150, render: (_: unknown, o: PatientOrder) => <BarcodeActions order={o} /> },
    createdBy: { title: 'Created by', width: 120, render: (_: unknown, o: PatientOrder) => cellText(o, 'createdBy', cellCtx) },
    branch: { title: 'Branch', width: 120, render: (_: unknown, o: PatientOrder) => cellText(o, 'branch', cellCtx) },
    b2b: { title: 'B2B / corporate', width: 140, render: (_: unknown, o: PatientOrder) => cellText(o, 'b2b', cellCtx) },
    tat: { title: 'TAT', width: 90, render: (_: unknown, o: PatientOrder) => cellText(o, 'tat', cellCtx) },
    collectionCentre: { title: 'Collection centre', width: 140, render: (_: unknown, o: PatientOrder) => cellText(o, 'collectionCentre', cellCtx) },
  }

  const moreItems = [
    { key: 'dispatch', label: 'Bulk dispatch' },
    { key: 'print', label: 'Bulk print reports' },
    { key: 'download', label: 'Bulk download (results CSV)' },
    ...(can(profile, 'reports.send') ? [{ key: 'sendReports', label: 'Send reports' }] : []),
    { key: 'consolidated', label: 'Consolidated report' },
    { key: 'compare', label: 'Compare reports (2 bills)' },
    { key: 'printed', label: 'Mark printed' },
    { key: 'hard', label: 'Mark hard copy delivered' },
    ...(can(profile, 'billing.clearDue') && can(profile, 'payment.collect') ? [{ key: 'clearDue', label: 'Clear due (selected bills)' }] : []),
    ...(canExport ? [{ key: 'export', label: 'Export selected (CSV)' }] : []),
    ...(can(profile, 'billing.edit') ? [{ key: 'pcpndt', label: 'Mark as PCPNDT' }, { key: 'unpcpndt', label: 'Remove PCPNDT mark' }, { key: 'gov', label: 'Mark as government panel bill' }] : []),
  ]
  const onMore = ({ key }: { key: string }) => {
    if (!bulkTarget.length) return message.info('No bills in the list.')
    const f = run(async () => {
      if (key === 'dispatch') bulkDispatch()
      else if (key === 'print') bulkPrint()
      else if (key === 'sendReports') {
        if (!can(profile, 'reports.send')) return
        const sendable = bulkTarget.filter((o) => o.reportStatus !== 'pending')
        if (!sendable.length) return message.info('None of these bills has a report ready to send.')
        setBulkSendOpen(true)
      }
      else if (key === 'download') await bulkResultsCsv(bulkTarget, testById)
      else if (key === 'consolidated') await consolidatedReport(bulkTarget, testById, settings)
      else if (key === 'compare') {
        if (bulkTarget.length !== 2) return message.info('Select exactly two bills to compare.')
        const w = window.open('', '_blank')
        if (w) w.document.write(`<title>Compare reports</title><body style="margin:0;display:flex;height:100vh">${bulkTarget.map((o) => `<iframe src="/report/${o.id}" style="flex:1;border:0;border-right:1px solid #999"></iframe>`).join('')}</body>`)
      } else if (key === 'printed') {
        if (profile) await markPrinted(bulkTarget, profile.uid)
        message.success('Marked printed')
      } else if (key === 'hard') {
        const t = bulkTarget.filter((o) => o.dispatch.some((d) => d.mode === 'hardcopy' && !d.delivered))
        const n = await markMany(t, 'hardcopy')
        if (n) await stampHardCopyDelivered(t)
        message.success(`${n} bills marked delivered`)
      }
      else if (key === 'export') exportCsv(bulkTarget, exportCols, cellCtx)
      else if (key === 'pcpndt' || key === 'unpcpndt') {
        await markPcpndt(bulkTarget, key === 'pcpndt')
        message.success(`${bulkTarget.length} bills ${key === 'pcpndt' ? 'marked PCPNDT' : 'unmarked'}`)
      } else if (key === 'gov') setGovOpen(true)
      else if (key === 'clearDue') {
        const owing = bulkTarget.filter((x) => x.due > 0)
        if (!owing.length) return message.info('None of these bills has a balance due.')
        setBulkDue(owing)
      }
    })
    void f()
  }

  const nFilters = activeFilterCount(filters)

  return (
    <div>
      <PageHeader
        title="Patient List"
        subtitle={`${rows.length} bills${selected.length ? ` · ${picked.length} selected` : ''}`}
        actions={
          <>
            <Button icon={<PrinterOutlined />} onClick={() => setWorksheetOpen(true)}>Worksheet</Button>
            {can(profile, 'payment.collect') && <Button onClick={() => setShiftOpen(true)}>Close shift</Button>}
            {canExport && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [{ key: 'xls', label: 'Export Excel (.xls) with payment modes' }, { key: 'csv', label: 'Export CSV with payment modes' }, { key: 'pdf', label: 'Export PDF (print)' }],
                  onClick: ({ key }) => {
                    if (key === 'pdf') return exportPdf(rows, exportCols, cellCtx, settings) || message.error('Allow pop-ups')
                    void run(() => exportWithPayments(rows, exportCols, cellCtx, key as 'csv' | 'xls'))()
                  },
                }}
              >
                <Button icon={<DownloadOutlined />}>Export</Button>
              </Dropdown>
            )}
            <Dropdown trigger={['click']} menu={{ items: moreItems, onClick: onMore }}>
              <Button icon={<MoreOutlined />}>More</Button>
            </Dropdown>
          </>
        }
      />

      <div className="pl-bar">
        <Input.Search
          className="pl-bar__grow"
          allowClear
          aria-label="Search patients and bills"
          placeholder="Name, phone, patient no, UHID, bill no, barcode"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            if (params.has('q')) setParams({}, { replace: true })
          }}
        />
        <DatePicker.RangePicker value={range} allowClear={false} presets={PRESETS} onChange={(v) => {
            if (!v?.[0] || !v[1]) return
            if (v[1].diff(v[0], 'day') > 92) return message.warning('Pick a range of 92 days or less.')
            setRange([v[0], v[1]])
          }} />
        <label className="pl-toggle" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Switch size="small" checked={showCancelled} onChange={(v) => { setShowCancelled(v); setSelected([]) }} aria-label="Show cancelled bills" />
          <span>Cancelled bills</span>
        </label>
        <Button icon={<FilterOutlined />} onClick={() => setFiltersOpen(true)}>
          {nFilters ? `Filters (${nFilters})` : 'Filters'}
        </Button>
        <Popover
          trigger="click"
          placement="bottomRight"
          title="Columns"
          content={
            <Checkbox.Group
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              value={cols}
              onChange={(v) => setColumns(v as ColumnKey[])}
              options={COLUMN_KEYS.filter((k) => k !== 'tat' || showTat).map((k) => ({ value: k, label: COLUMN_LABEL[k] }))}
            />
          }
        >
          <Button icon={<TableOutlined />} aria-label="Choose columns">Columns</Button>
        </Popover>
      </div>

      <div className="pl-tabs">
        <Segmented
          aria-label="Bill status"
          value={tab}
          onChange={setTab}
          options={TABS.map((t) => ({ value: t.key, label: t.label, count: counts[t.key] }))}
        />
      </div>

      <Card padding={0}>
        <Table<PatientOrder>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
          rowClassName={(o) => (o.due > 0 ? 'pl-row--due' : o.reportStatus === 'final' ? 'pl-row--final' : o.reportStatus !== 'pending' ? 'pl-row--partial' : '')}
          pagination={{ pageSize: 25, showSizeChanger: false }}
          scroll={{ x: 1200 }}
          locale={{ emptyText: <EmptyState icon={<ProfileOutlined />} title="No bills match" description="Change the date range, tab or filters." /> }}
          expandable={{
            expandRowByClick: false,
            expandedRowRender: (o) => (
              <div className="pl-expand">
                <div>
                  <h4>Tests</h4>
                  {o.items.map((i) => <div key={i.lineId}>{i.name} <span className="pl-sub">{formatINR(i.price - i.discount)} · {LETTER[i.status].t}</span></div>)}
                </div>
                <div>
                  <h4>Money</h4>
                  <div>Gross {formatINR(o.gross)} · Discount {formatINR(o.discount)}</div>
                  <div>Net {formatINR(o.net)} · Paid {formatINR(o.paid)}</div>
                  {o.due > 0 && <div className="pl-money-due">Due {formatINR(o.due)}</div>}
                </div>
                <div>
                  <h4>Delivery</h4>
                  {o.dispatch.length ? o.dispatch.map((d) => <div key={d.mode}>{d.mode} {d.delivered ? '(delivered)' : '(pending)'}</div>) : <span className="pl-sub">No method chosen</span>}
                  {o.note && <div className="pl-sub">Note: {o.note}</div>}
                </div>
              </div>
            ),
          }}
          columns={[
            ...cols.filter((k) => k !== 'tat' || showTat).map((k) => ({ key: k, ...colDefs[k] })),
            // The Refunded tab is the refund ledger: what was refunded, when, by whom, how much and why.
            ...(tab === 'refunded'
              ? [
                  { title: 'Refund tests', key: 'rt', render: (_: unknown, o: PatientOrder) => o.items.filter((i) => i.status === 'refunded').map((i) => i.name).join(', ') },
                  { title: 'Refund date', key: 'rd', width: 120, render: (_: unknown, o: PatientOrder) => { const d = refundInfo.get(o.id)?.map((r) => r.at).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0]; return d ? dayjs(d).format('DD MMM YY HH:mm') : '' } },
                  { title: 'Refunded by', key: 'rb', width: 120, render: (_: unknown, o: PatientOrder) => [...new Set((refundInfo.get(o.id) ?? []).map((r) => r.by).filter(Boolean))].join(', ') },
                  { title: 'Refunded', key: 'ra', align: 'right' as const, width: 110, render: (_: unknown, o: PatientOrder) => formatINR((refundInfo.get(o.id) ?? []).reduce((n, r) => n + r.amount, 0) || o.refunded) },
                  { title: 'Remarks', key: 'rr', render: (_: unknown, o: PatientOrder) => (refundInfo.get(o.id) ?? []).map((r) => r.reason).filter(Boolean).join('; ') },
                ]
              : []),
            {
              title: 'Actions', key: 'actions', width: 250, fixed: 'right' as const,
              render: (_: unknown, o: PatientOrder) => isFullyRefunded(o) ? <span className="pl-sub">Refunded</span> : (
                <div className="pl-actions">
                  <Button onClick={() => open(o, 'bill')}>Bill</Button>
                  <Button disabled={!o.items.some((i) => i.status === 'approved')} title={o.items.some((i) => i.status === 'approved') ? undefined : 'Available once a test is approved'} onClick={() => window.open(`/report/${o.id}`, '_blank')}>Report</Button>
                  <Button variant="primary" onClick={() => navigate(`/results/${o.id}`)}>Results</Button>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: (o.deleted ? (xs: MenuRow[]) => xs.filter((x) => ['details', 'history'].includes(x.key)) : (xs: MenuRow[]) => xs)([
                        { key: 'details', label: 'View details' },
                        ...(can(profile, 'patients.edit') ? [{ key: 'edit', label: 'Edit patient' }] : []),
                        ...(can(profile, 'billing.edit') ? [{ key: 'editBill', label: 'Edit bill' }] : []),
                        ...(can(profile, 'billing.clearDue') && can(profile, 'payment.collect') && o.due > 0 ? [{ key: 'clearDue', label: 'Clear due' }] : []),
                        ...(can(profile, 'billing.refund') ? [{ key: 'refund', label: 'Refund' }] : []),
                        { key: 'history', label: 'Payment history' },
                        { key: 'results', label: 'Enter results' },
                        { key: 'trf', label: 'TRF' },
                        { key: 'track', label: 'Report tracking' },
                        { key: 'dispatch', label: 'Dispatch (all modes)' },
                        ...o.dispatch.filter((d) => !d.delivered).map((d) => ({ key: `mark:${d.mode}`, label: `Mark ${DISPATCH_LABEL[d.mode]} delivered` })),
                        ...(o.printed ? [] : [{ key: 'markPrinted', label: 'Mark as printed' }]),
                        ...(can(profile, 'reports.send') ? [{ key: 'send', label: 'Send report' }] : []),
                        ...(can(profile, 'billing.void') ? [{ key: 'void', label: 'Delete bill', danger: true }] : []),
                      ]),
                      onClick: ({ key }) => {
                        if (key === 'dispatch') void dispatch(o)
                        else if (key === 'markPrinted') void run(async () => { if (profile) await markPrinted([o], profile.uid); message.success('Marked printed') })()
                        else if (key.startsWith('mark:')) void run(() => markMode(o, key.slice(5) as DispatchMode))()
                        else if (key === 'details') navigate(`/patients/${o.patientId}`)
                        else if (key === 'results') navigate(`/results/${o.id}`)
                        else if (key === 'edit') void openEdit(o)
                        else open(o, key as Kind)
                      },
                    }}
                  >
                    <Button icon={<MoreOutlined />} aria-label={`More actions for ${o.billNo}`} />
                  </Dropdown>
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Modal open={govOpen} title="Mark as government panel bill" okText="Apply" onCancel={() => setGovOpen(false)} okButtonProps={{ disabled: !govPick }} destroyOnHidden
        onOk={run(async () => {
          const g = masters.govPanels.find((x) => x.id === govPick)
          if (!g) return
          await markGovPanel(bulkTarget, { id: g.id, name: g.name })
          message.success(`${bulkTarget.length} bills moved to ${g.name}`)
          setGovOpen(false)
        })}>
        <p>Applies to {bulkTarget.length} bill{bulkTarget.length === 1 ? '' : 's'} (the selected ones, or every bill in the current tab).</p>
        <Select aria-label="Government panel" showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="Select panel" value={govPick} onChange={setGovPick}
          options={masters.govPanels.map((g) => ({ value: g.id, label: g.name }))} />
      </Modal>
      <ShiftCloseModal open={shiftOpen} onClose={() => setShiftOpen(false)} />
      <FiltersDrawer open={filtersOpen} value={filters} onClose={() => setFiltersOpen(false)} onApply={setFilters} showBranch={scope.all} />
      <WorksheetModal open={worksheetOpen} onClose={() => setWorksheetOpen(false)} orders={bulkTarget} />
      {editPatient && <EditPatientModal patient={editPatient} open onClose={() => setEditPatient(null)} />}
      <BulkSendModal open={bulkSendOpen} onClose={() => setBulkSendOpen(false)} orders={bulkTarget.filter((o) => o.reportStatus !== 'pending').map((o) => ({ id: o.id, billNo: o.billNo, patientName: o.patientName }))} />
      {bulkDue && <ClearDueModal orders={bulkDue} open onClose={() => { setBulkDue(null); setSelected([]) }} />}
      <BillReceipt open={active?.kind === 'bill'} orderId={active?.kind === 'bill' ? active.id : null} onClose={close} />
      {current && (
        <>
          <ClearDueModal order={current} open={active?.kind === 'clearDue'} onClose={close} />
          <RefundModal order={current} open={active?.kind === 'refund'} onClose={close} />
          <EditBillModal order={current} open={active?.kind === 'editBill'} onClose={close} />
          <PaymentHistoryModal order={current} open={active?.kind === 'history'} onClose={close} />
          <VoidOrderModal order={current} open={active?.kind === 'void'} onClose={close} />
          <SendReportModal order={current} open={active?.kind === 'send'} onClose={close} />
          <TrfModal order={current} open={active?.kind === 'trf'} onClose={close} />
          <ReportTrackingModal order={current} open={active?.kind === 'track'} onClose={close} />
        </>
      )}
    </div>
  )
}
