import { useMemo, useState } from 'react'
import { App, Badge, Button as AButton, Calendar, Checkbox, DatePicker, Drawer, Dropdown, Empty, Form, Input, Modal, Select, Space, Table, Tooltip, Typography } from 'antd'
import {
  CalendarOutlined,
  ColumnHeightOutlined,
  DownloadOutlined,
  FilterOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { query, Timestamp, where } from 'firebase/firestore'
import { can, useAuth } from '../../auth/AuthProvider'
import { useBranch } from '../../branch/BranchProvider'
import { useBranchScope } from '../../lib/branchScope'
import { useLiveQuery } from '../../hooks/useLive'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import {
  bookingName,
  bookingTotal,
  convertToBill,
  createPreBooking,
  downloadCsv,
  duplicateBooking,
  markPreBookingConverted,
  otherChargesTotal,
  paymentStatusOf,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  STAGE_LABEL,
  STATUS_LABEL,
  STATUS_VARIANT,
  type BookingSource,
  type BookingX,
} from '../../lib/bookings'
import { col, paths } from '../../lib/db'
import { formatINR } from '../../lib/money'
import type { BookingStatus, BookingType } from '../../types'
import BookingDrawer, { type DrawerAction } from '../../components/bookings/BookingDrawer'
import CollectorsModal from '../../components/bookings/CollectorsModal'
import { rescheduleBooking } from '../../lib/bookings'
import NewBookingWizard from '../../components/bookings/NewBookingWizard'
import BulkActions from '../../components/bookings/BulkActions'
import type { BookingDraft } from '../../components/bookings/BookingFields'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'

const STATUS_KEYS: BookingStatus[] = ['unmapped', 'scheduled', 'confirmed', 'assigned', 'inProgress', 'completed', 'rescheduled', 'cancelled']

const fmtDate = (t: { toDate?: () => Date } | null | undefined, f = 'DD MMM YYYY') =>
  t?.toDate ? dayjs(t.toDate()).format(f) : ''

// ---- Columns chooser (persisted) -------------------------------------------------
const COLUMN_DEFS: { key: string; label: string; on: boolean }[] = [
  { key: 'idx', label: '#', on: true },
  { key: 'crm', label: 'CRM ID', on: true },
  { key: 'patient', label: 'Patient', on: true },
  { key: 'tests', label: 'Tests & Packages', on: true },
  { key: 'type', label: 'Type', on: true },
  { key: 'status', label: 'Status', on: true },
  { key: 'payment', label: 'Payment', on: true },
  { key: 'amount', label: 'Amount', on: true },
  { key: 'other', label: 'Other Charges', on: true },
  { key: 'assignedTo', label: 'Assigned To', on: true },
  { key: 'phlebo', label: 'Phlebotomist', on: false },
  { key: 'address', label: 'Address', on: false },
  { key: 'pincode', label: 'Pincode', on: false },
  { key: 'company', label: 'Company Name', on: false },
  { key: 'corporate', label: 'Corporate', on: false },
  { key: 'uhid', label: 'UHID', on: false },
  { key: 'location', label: 'Location', on: false },
  { key: 'branch', label: 'Branch', on: false },
  { key: 'source', label: 'Source', on: true },
  { key: 'priority', label: 'Priority', on: true },
  { key: 'scheduled', label: 'Scheduled', on: true },
  { key: 'created', label: 'Booking Created', on: true },
]
const COL_STORE = 'hcl.bookings.columns'
const defaultCols = () => COLUMN_DEFS.filter((c) => c.on).map((c) => c.key)
function loadCols(): string[] {
  try {
    const raw = localStorage.getItem(COL_STORE)
    const arr = raw ? (JSON.parse(raw) as string[]) : null
    if (Array.isArray(arr) && arr.length) return arr.filter((k) => COLUMN_DEFS.some((c) => c.key === k))
  } catch {
    /* storage unavailable */
  }
  return defaultCols()
}

interface Filters {
  phlebo: string
  doctor: string
  hospital: string
  corporate: string
  rateList: string
  payment: string
  pincode: string
  location: string
  createdBy: string
}
const NO_FILTERS: Filters = { phlebo: '', doctor: '', hospital: '', corporate: '', rateList: '', payment: '', pincode: '', location: '', createdBy: '' }

type RowAction = 'call' | 'whatsapp' | DrawerAction | 'convert' | 'duplicate'

export default function BookingsPage() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const { branches } = useBranch()
  const settings = useLabSettings()
  const cat = useCatalogueMaps()
  const isPhlebo = profile?.role === 'phlebotomist'
  const scope = useBranchScope()
  const [sectionPick, setSection] = useState<'bookings' | 'pre'>('bookings')
  // Flabs: Bookings is one list with status chips. The separate Pre Bookings view is an extra, off unless the lab turns it on.
  const showPre = settings.frontDesk?.showPreBookings === true
  const section = showPre ? sectionPick : 'bookings'
  const [status, setStatus] = useState<'all' | BookingStatus>('all')
  const [search, setSearch] = useState('')
  const [type, setType] = useState<BookingType | 'all'>('all')
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>([dayjs().startOf('day'), dayjs().endOf('day')])
  const [unscheduled, setUnscheduled] = useState(true)
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [month, setMonth] = useState<Dayjs>(dayjs())
  const [day, setDay] = useState<Dayjs>(dayjs())
  const [wizard, setWizard] = useState(false)
  const [wizardInit, setWizardInit] = useState<Partial<BookingDraft> | undefined>()
  const [convertingPre, setConvertingPre] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openAction, setOpenAction] = useState<DrawerAction | null>(null)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [draftFilters, setDraftFilters] = useState<Filters>(NO_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [colsOpen, setColsOpen] = useState(false)
  const [cols, setCols] = useState<string[]>(loadCols)
  const [draftCols, setDraftCols] = useState<string[]>(cols)
  const [selected, setSelected] = useState<string[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [preOpen, setPreOpen] = useState(false)
  const [collectorsOpen, setCollectorsOpen] = useState(false)
  const [calCollector, setCalCollector] = useState<string | undefined>()
  const [drag, setDrag] = useState<{ b: BookingX; date: Dayjs } | null>(null)
  const [dragReason, setDragReason] = useState('')

  const q = useMemo(() => {
    if (!profile) return null
    const base = col<BookingX>(paths.bookings)
    // Phlebotomists can only ever read their own bookings.
    return isPhlebo
      ? query(base, ...scope.constraints, where('assignedTo', '==', profile.uid))
      : query(base, ...scope.constraints)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, isPhlebo, scope.key, refreshKey])
  const { data, loading } = useLiveQuery<BookingX>(q, [q])

  const sorted = useMemo(
    () => [...data].sort((a, b) => (b.createdAt?.toMillis?.() ?? Infinity) - (a.createdAt?.toMillis?.() ?? Infinity)),
    [data],
  )
  const bookings = useMemo(() => sorted.filter((b) => !b.preBooking), [sorted])
  const preBookings = useMemo(() => sorted.filter((b) => b.preBooking), [sorted])

  const branchName = (id?: string) => branches.find((b) => b.id === (id || 'main'))?.name ?? id ?? 'main'

  // Option lists for the More Filters drawer come from the data itself.
  const uniq = (f: (b: BookingX) => string | undefined) =>
    [...new Set(bookings.map(f).filter((v): v is string => !!v))].sort().map((v) => ({ value: v, label: v }))

  const matches = (b: BookingX) => {
    if (type !== 'all' && b.type !== type) return false
    const s = search.trim().toLowerCase()
    if (s && !`${bookingName(b)} ${b.phone} ${b.bookingNo} ${b.crmId ?? ''}`.toLowerCase().includes(s)) return false
    const f = filters
    if (f.phlebo && b.assignedToName !== f.phlebo) return false
    if (f.doctor && b.referrerName !== f.doctor) return false
    if (f.hospital && b.hospitalName !== f.hospital) return false
    if (f.corporate && b.corporateName !== f.corporate) return false
    if (f.rateList && b.rateListName !== f.rateList) return false
    if (f.payment && paymentStatusOf(b) !== f.payment) return false
    if (f.pincode && !b.pincode.includes(f.pincode.trim())) return false
    if (f.location && !(b.location ?? '').toLowerCase().includes(f.location.trim().toLowerCase())) return false
    if (f.createdBy && b.createdByName !== f.createdBy) return false
    return true
  }

  const dateFiltered = useMemo(
    () =>
      bookings.filter((b) => {
        if (!matches(b)) return false
        if (view === 'calendar' || !range) return true
        if (!b.scheduledAt) return unscheduled
        const t = dayjs(b.scheduledAt.toDate())
        return !t.isBefore(range[0].startOf('day')) && !t.isAfter(range[1].endOf('day'))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookings, search, type, range, unscheduled, view, filters],
  )

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: dateFiltered.length }
    for (const b of dateFiltered) c[b.status] = (c[b.status] ?? 0) + 1
    return c
  }, [dateFiltered])

  const visible = dateFiltered.filter((b) => status === 'all' || b.status === status)
  const activeFilterCount = Object.values(filters).filter(Boolean).length

  // ---- cell helpers shared by the table and CSV export --------------------------
  const typeText = (t: BookingType) => (t === 'homeCollection' ? 'Home Collection' : 'Lab Visit')
  const testsText = (b: BookingX) => (b.items.length ? b.items.map((i) => i.name).join(', ') : b.freeTextTests || '')
  const scheduledText = (b: BookingX) => (b.scheduledAt ? `${fmtDate(b.scheduledAt)} ${b.slot}`.trim() : '')
  const exportVal: Record<string, (b: BookingX, i: number) => string | number> = {
    idx: (_b, i) => i + 1,
    crm: (b) => b.crmId ?? '',
    patient: (b) => `${bookingName(b)} ${b.phone}`,
    tests: testsText,
    type: (b) => typeText(b.type),
    status: (b) => STATUS_LABEL[b.status],
    payment: (b) => `${paymentStatusOf(b)} (${formatINR(b.prepaid)})`,
    amount: (b) => formatINR(bookingTotal(b)),
    other: (b) => formatINR(otherChargesTotal(b)),
    assignedTo: (b) => b.ownerName ?? b.createdByName ?? '',
    phlebo: (b) => b.assignedToName,
    address: (b) => b.address,
    pincode: (b) => b.pincode,
    company: (b) => b.companyName ?? '',
    corporate: (b) => b.corporateName ?? '',
    uhid: (b) => b.uhid ?? '',
    location: (b) => b.location ?? '',
    branch: (b) => branchName(b.branchId),
    source: (b) => SOURCE_LABEL[b.source ?? 'phone'],
    priority: (b) => PRIORITY_LABEL[b.priority ?? 'medium'],
    scheduled: scheduledText,
    created: (b) => fmtDate(b.createdAt, 'DD MMM YYYY HH:mm'),
  }
  const exportCsv = (rows: BookingX[]) => {
    const defs = COLUMN_DEFS.filter((c) => cols.includes(c.key))
    downloadCsv(
      `bookings-${dayjs().format('YYYYMMDD-HHmm')}.csv`,
      defs.map((d) => d.label),
      rows.map((b, i) => defs.map((d) => exportVal[d.key](b, i))),
    )
  }

  // ---- row actions --------------------------------------------------------------
  const rowAction = async (b: BookingX, a: RowAction) => {
    if (!profile) return
    try {
      if (a === 'call') window.location.href = `tel:${b.phone}`
      else if (a === 'whatsapp') window.open(`https://wa.me/${b.phone.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1')}`, '_blank', 'noopener')
      else if (a === 'duplicate') {
        const d = await duplicateBooking(b, profile)
        message.success(`Duplicated as ${d.bookingNo}`)
      } else if (a === 'convert') {
        await convertToBill(b, settings, profile, cat.packages, branches)
        message.success('Bill created')
      } else {
        setOpenAction(a)
        setOpenId(b.id)
      }
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const canAct = (b: BookingX, a: RowAction) => {
    const closed = b.status === 'completed' || b.status === 'cancelled'
    if (a === 'convert') return !closed && b.items.length > 0
    if (a === 'assign') return !closed && can(profile, 'bookings.assign')
    if (a === 'reschedule' || a === 'cancel') return !closed && can(profile, 'bookings.create')
    if (a === 'duplicate') return can(profile, 'bookings.create')
    return true
  }
  const menuFor = (b: BookingX) => ({
    items: ([
      ['call', 'Call patient'],
      ['whatsapp', 'WhatsApp'],
      ['reschedule', 'Reschedule'],
      ['assign', 'Assign phlebotomist'],
      ['convert', 'Convert to bill'],
      ['duplicate', 'Duplicate'],
      ['cancel', 'Cancel booking'],
    ] as [RowAction, string][]).map(([key, label]) => ({ key, label, disabled: !canAct(b, key), danger: key === 'cancel' })),
    onClick: ({ key }: { key: string }) => rowAction(b, key as RowAction),
  })

  const allColumns: Record<string, ColumnsType<BookingX>[number]> = {
    idx: { title: '#', width: 52, render: (_v, _b, i) => i + 1 },
    crm: { title: 'CRM ID', render: (_v, b) => b.crmId || '-' },
    patient: {
      title: 'Patient',
      render: (_v, b) => (
        <div>
          <b>{bookingName(b)}</b>
          <div style={{ fontSize: 'var(--fs-dense)', color: 'var(--c-on-surface-variant)' }}>
            {b.bookingNo} · {b.phone}
          </div>
        </div>
      ),
    },
    tests: {
      title: 'Tests & Packages',
      ellipsis: true,
      render: (_v, b) =>
        b.items.length ? b.items.map((i) => i.name).join(', ') : <Typography.Text type="warning">{b.freeTextTests || '-'}</Typography.Text>,
    },
    type: { title: 'Type', render: (_v, b) => typeText(b.type) },
    status: {
      title: 'Status',
      render: (_v, b) => (
        <StatusChip variant={STATUS_VARIANT[b.status]}>
          {STATUS_LABEL[b.status]}
          {b.status === 'inProgress' && b.phleboStage ? ` · ${STAGE_LABEL[b.phleboStage]}` : ''}
        </StatusChip>
      ),
    },
    payment: {
      title: 'Payment',
      render: (_v, b) => {
        const s = paymentStatusOf(b)
        return (
          <StatusChip variant={s === 'Paid' ? 'success' : s === 'Partial' ? 'caution' : 'neutral'}>
            {s}
            {b.paymentChannel === 'online' ? ' (online)' : ''}
          </StatusChip>
        )
      },
    },
    amount: { title: 'Amount', align: 'right', render: (_v, b) => formatINR(bookingTotal(b)) },
    other: { title: 'Other Charges', align: 'right', render: (_v, b) => formatINR(otherChargesTotal(b)) },
    assignedTo: { title: 'Assigned To', render: (_v, b) => b.ownerName || b.createdByName || '-' },
    phlebo: { title: 'Phlebotomist', render: (_v, b) => b.assignedToName || '-' },
    address: { title: 'Address', ellipsis: true, render: (_v, b) => b.address || '-' },
    pincode: { title: 'Pincode', render: (_v, b) => b.pincode || '-' },
    company: { title: 'Company Name', render: (_v, b) => b.companyName || '-' },
    corporate: { title: 'Corporate', render: (_v, b) => b.corporateName || '-' },
    uhid: { title: 'UHID', render: (_v, b) => b.uhid || '-' },
    location: { title: 'Location', render: (_v, b) => b.location || '-' },
    branch: { title: 'Branch', render: (_v, b) => branchName(b.branchId) },
    source: { title: 'Source', render: (_v, b) => SOURCE_LABEL[b.source ?? 'phone'] },
    priority: {
      title: 'Priority',
      render: (_v, b) => {
        const p = b.priority ?? 'medium'
        return <StatusChip variant={p === 'urgent' ? 'urgent' : p === 'high' ? 'caution' : 'neutral'}>{PRIORITY_LABEL[p]}</StatusChip>
      },
    },
    scheduled: {
      title: 'Scheduled',
      render: (_v, b) => scheduledText(b) || <Typography.Text type="secondary">Unscheduled</Typography.Text>,
    },
    created: { title: 'Booking Created', render: (_v, b) => fmtDate(b.createdAt, 'DD MMM, HH:mm') },
  }
  const columns: ColumnsType<BookingX> = [
    ...COLUMN_DEFS.filter((c) => cols.includes(c.key)).map((c) => ({ key: c.key, ...allColumns[c.key] })),
    {
      title: '',
      key: 'actions',
      width: 56,
      fixed: 'right',
      render: (_v, b) => (
        <Dropdown menu={menuFor(b)} trigger={['click']}>
          <AButton type="text" aria-label={`Actions for ${b.bookingNo}`} icon={<MoreOutlined />} onClick={(e) => e.stopPropagation()} />
        </Dropdown>
      ),
    },
  ]

  // ---- calendar -----------------------------------------------------------------
  const byDay = useMemo(() => {
    const m = new Map<string, BookingX[]>()
    for (const b of dateFiltered) {
      if (!b.scheduledAt) continue
      if (status !== 'all' && b.status !== status) continue
      if (calCollector && b.assignedTo !== calCollector) continue
      const k = dayjs(b.scheduledAt.toDate()).format('YYYY-MM-DD')
      m.set(k, [...(m.get(k) ?? []), b])
    }
    return m
  }, [dateFiltered, status, calCollector])
  const dayRows = byDay.get(day.format('YYYY-MM-DD')) ?? []
  const bySlot = useMemo(() => {
    const m = new Map<string, BookingX[]>()
    for (const b of dayRows) m.set(b.slot || 'No slot', [...(m.get(b.slot || 'No slot') ?? []), b])
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [dayRows])

  const startConvertPre = (b: BookingX) => {
    setConvertingPre(b.id)
    setWizardInit({
      firstName: b.firstName,
      lastName: b.lastName,
      phone: b.phone,
      freeTextTests: b.freeTextTests,
      source: b.source ?? 'phone',
      notes: b.notes,
      date: b.preferredDate ? dayjs(b.preferredDate.toDate()) : null,
    })
    setWizard(true)
  }

  const statusOptions = [
    { value: 'all' as const, label: 'All', count: counts.all ?? 0 },
    ...STATUS_KEYS.map((k) => ({ value: k, label: STATUS_LABEL[k], count: counts[k] ?? 0 })),
  ]
  const canCreate = !isPhlebo && can(profile, 'bookings.create')

  return (
    <div>
      <PageHeader
        title="Bookings"
        subtitle="Home collection and lab-visit appointments"
        actions={
          canCreate && (
            <Button
              variant="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                if (section === 'pre') setPreOpen(true)
                else {
                  setConvertingPre(null)
                  setWizardInit(undefined)
                  setWizard(true)
                }
              }}
            >
              {section === 'pre' ? 'New Enquiry' : 'New Booking'}
            </Button>
          )
        }
      />

      <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap', marginBottom: 'var(--s-3)' }}>
        {showPre && (
          <Segmented
            aria-label="Bookings section"
            value={section}
            onChange={setSection}
            options={[
              { value: 'bookings', label: 'Bookings', count: bookings.length },
              { value: 'pre', label: 'Pre Bookings', count: preBookings.filter((p) => !p.convertedTo).length },
            ]}
          />
        )}
        {can(profile, 'bookings.manage') && !isPhlebo && <AButton onClick={() => setCollectorsOpen(true)}>Collectors</AButton>}
      </div>

      {section === 'pre' ? (
        <PreBookings rows={preBookings} loading={loading} onConvert={startConvertPre} canCreate={canCreate} />
      ) : (
        <>
          <div style={{ overflowX: 'auto', marginBottom: 'var(--s-3)' }}>
            <Segmented aria-label="Booking status" value={status} onChange={setStatus} options={statusOptions} size="small" />
          </div>

          <Space wrap style={{ marginBottom: 'var(--s-3)' }}>
            <Input.Search
              allowClear
              aria-label="Search bookings"
              placeholder="Name, phone, booking no or CRM ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="search-wide"
            />
            <Select
              aria-label="Booking type"
              value={type}
              onChange={setType}
              style={{ width: 170 }}
              options={[
                { value: 'all', label: 'All Types' },
                { value: 'homeCollection', label: 'Home Collection' },
                { value: 'labVisit', label: 'Lab Visit' },
              ]}
            />
            {view === 'list' && (
              <>
                <DatePicker.RangePicker
                  aria-label="Scheduled from and to"
                  value={range}
                  placeholder={['Scheduled from', 'Scheduled to']}
                  onChange={(v) => setRange(v?.[0] && v[1] ? [v[0], v[1]] : null)}
                />
                <Checkbox checked={unscheduled} onChange={(e) => setUnscheduled(e.target.checked)}>
                  Include unscheduled
                </Checkbox>
              </>
            )}
            <Badge count={activeFilterCount} size="small">
              <AButton
                icon={<FilterOutlined />}
                onClick={() => {
                  setDraftFilters(filters)
                  setFiltersOpen(true)
                }}
              >
                More Filters
              </AButton>
            </Badge>
            {view === 'list' && (
              <AButton
                icon={<ColumnHeightOutlined rotate={90} />}
                onClick={() => {
                  setDraftCols(cols)
                  setColsOpen(true)
                }}
              >
                Columns
              </AButton>
            )}
            <Tooltip title="Data is live; this re-subscribes the list">
              <AButton aria-label="Refresh" icon={<ReloadOutlined />} onClick={() => setRefreshKey((k) => k + 1)} />
            </Tooltip>
            <AButton
              icon={<DownloadOutlined />}
              onClick={() => exportCsv(selected.length ? visible.filter((b) => selected.includes(b.id)) : visible)}
              disabled={visible.length === 0}
            >
              Export{selected.length ? ` (${selected.length})` : ''}
            </AButton>
            {!isPhlebo && can(profile, 'bookings.manage') && (
              <BulkActions rows={visible.filter((b) => selected.includes(b.id))} onDone={() => setSelected([])} />
            )}
            <Segmented
              aria-label="View"
              size="small"
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: 'List', icon: <UnorderedListOutlined /> },
                { value: 'calendar', label: 'Calendar', icon: <CalendarOutlined /> },
              ]}
            />
            {isPhlebo && <StatusChip variant="info">My bookings</StatusChip>}
          </Space>

          {view === 'list' ? (
            <Table<BookingX>
              rowKey="id"
              size="small"
              loading={loading}
              columns={columns}
              dataSource={visible}
              scroll={{ x: 'max-content' }}
              pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
              rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
              locale={{ emptyText: <EmptyState title="No bookings" description="Nothing matches these filters." /> }}
              onRow={(b) => ({
                onClick: () => {
                  setOpenAction(null)
                  setOpenId(b.id)
                },
                style: { cursor: 'pointer' },
              })}
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 'var(--s-4)' }}>
              <Card padding="var(--s-3)">
                <Calendar
                  fullscreen={false}
                  value={day}
                  onSelect={(d) => setDay(d)}
                  onPanelChange={(d) => setMonth(d)}
                  cellRender={(d, info) => {
                    if (info.type !== 'date') return info.originNode
                    const rows = byDay.get(d.format('YYYY-MM-DD')) ?? []
                    const amt = rows.reduce((s, b) => s + bookingTotal(b), 0)
                    return (
                      <div
                        className="ant-picker-cell-inner ant-picker-calendar-date"
                        style={{ minHeight: 44 }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault()
                          const bk = data.find((x) => x.id === e.dataTransfer.getData('text/booking'))
                          if (bk) { setDragReason(''); setDrag({ b: bk, date: d }) }
                        }}
                      >
                        <div className="ant-picker-calendar-date-value">{d.date()}</div>
                        {rows.length > 0 && (
                          <div style={{ fontSize: 'var(--fs-dense)', lineHeight: 1.2 }}>
                            <b>{rows.length}</b>
                            <div>{formatINR(amt)}</div>
                          </div>
                        )}
                      </div>
                    )
                  }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-2)', marginTop: 'var(--s-3)' }} aria-label={`Status legend, ${month.format('MMMM YYYY')}`}>
                  {STATUS_KEYS.map((k) => (
                    <StatusChip key={k} variant={STATUS_VARIANT[k]}>{STATUS_LABEL[k]}</StatusChip>
                  ))}
                  {(['started', 'atLocation', 'collected'] as const).map((k) => (
                    <StatusChip key={k} variant="caution">{STAGE_LABEL[k]}</StatusChip>
                  ))}
                </div>
              </Card>
              <Card padding="var(--s-4)">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  aria-label="Filter calendar by collector"
                  placeholder="All collectors"
                  style={{ width: '100%', marginBottom: 'var(--s-3)' }}
                  value={calCollector}
                  onChange={setCalCollector}
                  options={[...new Map(data.filter((b) => b.assignedTo).map((b) => [b.assignedTo, b.assignedToName])).entries()].map(([value, label]) => ({ value, label }))}
                />
                <p style={{ margin: '0 0 var(--s-2)', color: 'var(--c-on-surface-variant)' }}>Drag a booking onto another date to reschedule it.</p>
                <h2 style={{ margin: '0 0 var(--s-3)', fontSize: 'var(--fs-body)' }}>
                  {day.format('ddd, DD MMM YYYY')} · {dayRows.length} booking(s)
                </h2>
                {bySlot.length === 0 ? (
                  <Empty description="No bookings this day" />
                ) : (
                  bySlot.map(([slot, rows]) => (
                    <div key={slot} style={{ marginBottom: 'var(--s-3)' }}>
                      <div style={{ fontWeight: 600, marginBottom: 'var(--s-1)' }}>{slot}</div>
                      {rows.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          draggable={canCreate && !['completed', 'cancelled', 'inProgress', 'rescheduled'].includes(b.status)}
                          onDragStart={(e) => e.dataTransfer.setData('text/booking', b.id)}
                          onClick={() => {
                            setOpenAction(null)
                            setOpenId(b.id)
                          }}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            cursor: 'pointer',
                            padding: 'var(--s-2) var(--s-3)',
                            border: '1px solid var(--c-outline-variant)',
                            background: 'transparent',
                            color: 'inherit',
                            borderRadius: 'var(--r-control)',
                            marginBottom: 'var(--s-1)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 'var(--s-2)',
                          }}
                        >
                          <span>
                            {b.bookingNo} · {bookingName(b)} <span style={{ color: 'var(--c-on-surface-variant)' }}>{b.phone}</span>
                          </span>
                          <StatusChip variant={STATUS_VARIANT[b.status]}>{STATUS_LABEL[b.status]}</StatusChip>
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </Card>
            </div>
          )}
        </>
      )}

      <Drawer
        title="More Filters"
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        width={380}
        footer={
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <AButton
              onClick={() => {
                setFilters(NO_FILTERS)
                setDraftFilters(NO_FILTERS)
                setFiltersOpen(false)
              }}
            >
              Reset
            </AButton>
            <AButton
              type="primary"
              onClick={() => {
                setFilters(draftFilters)
                setFiltersOpen(false)
              }}
            >
              Apply
            </AButton>
          </Space>
        }
      >
        <Form layout="vertical">
          {(
            [
              ['phlebo', 'Phlebotomist', uniq((b) => b.assignedToName)],
              ['doctor', 'Referring Doctor', uniq((b) => b.referrerName)],
              ['hospital', 'Referring Hospital', uniq((b) => b.hospitalName)],
              ['corporate', 'Corporate', uniq((b) => b.corporateName)],
              ['rateList', 'Rate List', uniq((b) => b.rateListName)],
              ['createdBy', 'Created By', uniq((b) => b.createdByName)],
            ] as [keyof Filters, string, { value: string; label: string }[]][]
          ).map(([k, label, options]) => (
            <Form.Item key={k} label={label}>
              <Select
                allowClear
                showSearch
                value={draftFilters[k] || undefined}
                onChange={(v) => setDraftFilters((f) => ({ ...f, [k]: v ?? '' }))}
                options={options}
                placeholder="Any"
              />
            </Form.Item>
          ))}
          <Form.Item label="Payment Status">
            <Select
              allowClear
              value={draftFilters.payment || undefined}
              onChange={(v) => setDraftFilters((f) => ({ ...f, payment: v ?? '' }))}
              options={['Paid', 'Partial', 'Unpaid'].map((v) => ({ value: v, label: v }))}
              placeholder="Any"
            />
          </Form.Item>
          <Form.Item label="Pincode">
            <Input value={draftFilters.pincode} onChange={(e) => setDraftFilters((f) => ({ ...f, pincode: e.target.value }))} />
          </Form.Item>
          <Form.Item label="Patient Location">
            <Input value={draftFilters.location} onChange={(e) => setDraftFilters((f) => ({ ...f, location: e.target.value }))} />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        title="Columns"
        open={colsOpen}
        onClose={() => setColsOpen(false)}
        width={340}
        footer={
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <AButton onClick={() => setDraftCols(defaultCols())}>Reset</AButton>
            <AButton
              type="primary"
              onClick={() => {
                const next = draftCols.length ? draftCols : defaultCols()
                setCols(next)
                try {
                  localStorage.setItem(COL_STORE, JSON.stringify(next))
                } catch {
                  /* storage unavailable: applies for this session only */
                }
                setColsOpen(false)
              }}
            >
              Save
            </AButton>
          </Space>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
          {COLUMN_DEFS.map((c) => (
            <Checkbox
              key={c.key}
              checked={draftCols.includes(c.key)}
              onChange={(e) => setDraftCols((cur) => (e.target.checked ? [...cur, c.key] : cur.filter((k) => k !== c.key)))}
            >
              {c.label}
            </Checkbox>
          ))}
        </div>
      </Drawer>

      <PreBookingModal open={preOpen} onClose={() => setPreOpen(false)} />

      <NewBookingWizard
        open={wizard}
        initial={wizardInit}
        onClose={() => {
          setWizard(false)
          setConvertingPre(null)
        }}
        onCreated={async (id) => {
          if (convertingPre && profile) {
            try {
              await markPreBookingConverted(convertingPre, id, profile)
            } catch (e) {
              message.warning(`Booking saved; the enquiry could not be marked converted: ${(e as Error).message}`)
            }
          }
          setOpenAction(null)
          setOpenId(id)
          setSection('bookings')
        }}
      />
      <CollectorsModal open={collectorsOpen} onClose={() => setCollectorsOpen(false)} />
      <Modal
        open={!!drag}
        title={drag ? `Reschedule ${drag.b.bookingNo} to ${drag.date.format('DD MMM YYYY')}` : ''}
        okText="Reschedule"
        okButtonProps={{ disabled: !dragReason.trim() }}
        onCancel={() => setDrag(null)}
        onOk={async () => {
          if (!drag || !profile) return
          try {
            if (!drag.b.slot) throw new Error('This booking has no slot. Open it and reschedule with a slot.')
            const h = Number(drag.b.slot.slice(0, 2)) || 0
            const m = Number(drag.b.slot.slice(3, 5)) || 0
            await rescheduleBooking(drag.b, { scheduledAt: Timestamp.fromDate(drag.date.startOf('day').hour(h).minute(m).toDate()), slot: drag.b.slot, reason: dragReason.trim() }, profile)
            message.success('Rescheduled. Confirm the new slot when the patient agrees.')
            setDrag(null)
          } catch (e) {
            message.error((e as Error).message)
          }
        }}
      >
        <p>The same time slot is kept. Any assigned collector is released.</p>
        <Input.TextArea rows={2} aria-label="Reason" placeholder="Reason (required)" value={dragReason} onChange={(e) => setDragReason(e.target.value)} />
      </Modal>
      <BookingDrawer
        bookingId={openId}
        action={openAction}
        onClose={() => {
          setOpenId(null)
          setOpenAction(null)
        }}
      />
    </div>
  )
}

// ---- Pre Bookings: enquiries that convert into a booking ----------------------------

function PreBookings({
  rows,
  loading,
  onConvert,
  canCreate,
}: {
  rows: BookingX[]
  loading: boolean
  onConvert: (b: BookingX) => void
  canCreate: boolean
}) {
  return (
    <Table<BookingX>
      rowKey="id"
      size="small"
      loading={loading}
      dataSource={rows}
      pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
      locale={{ emptyText: <EmptyState title="No pre bookings" description="Quick enquiries you log here convert into full bookings." /> }}
      columns={[
        { title: 'Enquiry', dataIndex: 'bookingNo', render: (v: string) => <b>{v}</b> },
        {
          title: 'Patient',
          render: (_v, b) => (
            <div>
              {bookingName(b)}
              <div style={{ fontSize: 'var(--fs-dense)', color: 'var(--c-on-surface-variant)' }}>{b.phone}</div>
            </div>
          ),
        },
        { title: 'Tests requested', dataIndex: 'freeTextTests', ellipsis: true },
        { title: 'Source', render: (_v, b) => SOURCE_LABEL[b.source ?? 'phone'] },
        { title: 'Preferred date', render: (_v, b) => fmtDate(b.preferredDate) || '-' },
        { title: 'Created', render: (_v, b) => fmtDate(b.createdAt, 'DD MMM, HH:mm') },
        {
          title: 'Status',
          render: (_v, b) => (b.convertedTo ? <StatusChip variant="success">Converted</StatusChip> : <StatusChip variant="info">Open</StatusChip>),
        },
        {
          title: '',
          width: 130,
          render: (_v, b) =>
            !b.convertedTo && canCreate ? (
              <AButton size="small" type="primary" onClick={() => onConvert(b)}>
                Convert to booking
              </AButton>
            ) : null,
        },
      ]}
    />
  )
}

function PreBookingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const [form] = Form.useForm<{
    firstName: string
    lastName: string
    phone: string
    tests: string
    source: BookingSource
    date: Dayjs | null
    notes: string
  }>()
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    const v = await form.validateFields()
    if (!profile) return
    setSaving(true)
    try {
      await createPreBooking(
        {
          firstName: v.firstName.trim(),
          lastName: (v.lastName ?? '').trim(),
          phone: v.phone.trim(),
          tests: (v.tests ?? '').trim(),
          source: v.source,
          preferredDate: v.date ? Timestamp.fromDate(v.date.startOf('day').toDate()) : null,
          notes: (v.notes ?? '').trim(),
        },
        profile,
      )
      message.success('Enquiry saved')
      form.resetFields()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title="New enquiry" open={open} onCancel={onClose} onOk={submit} okText="Save enquiry" confirmLoading={saving} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ source: 'phone' }}>
        <Space.Compact block>
          <Form.Item name="firstName" label="First name" rules={[{ required: true, message: 'Required' }]} style={{ flex: 1, marginRight: 8 }}>
            <Input />
          </Form.Item>
          <Form.Item name="lastName" label="Last name" style={{ flex: 1 }}>
            <Input />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="phone" label="Phone" rules={[{ required: true, pattern: /^\d{10}$/, message: '10 digits' }]}>
          <Input maxLength={10} inputMode="numeric" />
        </Form.Item>
        <Form.Item name="tests" label="Tests asked about">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="source" label="Source">
          <Select options={Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        <Form.Item name="date" label="Preferred date">
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="notes" label="Notes">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
