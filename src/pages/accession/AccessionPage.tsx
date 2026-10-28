import { recomputeOrder } from '../../lib/orders'
import { useEffect, useMemo, useRef, useState } from 'react'
import { showTatIn } from '../../features/settings/lib'
import { tatDue } from '../../features/patient/lib'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  App,
  Button as AButton,
  Checkbox,
  DatePicker,
  Drawer,
  Dropdown,
  Form,
  Input,
  type InputRef,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DownloadOutlined,
  FilterOutlined,
  MoreOutlined,
  PrinterOutlined,
  ScanOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { getDoc, getDocs, orderBy, query, Timestamp, where } from 'firebase/firestore'
import { col, docRef, paths } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { billBarcodeFromScan, sampleLabels } from '../catalogue/flags'
import type { Order, UserProfile } from '../../types'
import { fmtDateTime, REJECT_REASONS, tsToDate, workItemsOf } from '../../components/results/common'
import { useBranchScope } from '../../lib/branchScope'
import { can, useAuth } from '../../auth/AuthProvider'
import { downloadCsv } from '../../lib/bookings'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { Button } from '../../design/Button'
import { EmptyState } from '../../design/EmptyState'
import {
  assignPhlebotomist,
  changeAccessionDate,
  changeBarcode,
  collectLines,
  markNotReceived,
  dispatchManifest,
  printLabels,
  receiveLines,
  sendToProcessingLab,
  rejectLines,
  requestRecollection,
  type AItem,
  type AOrder,
} from './ops'
import { dialogWidth } from '../../design/dialog'
import { FieldGrid, FormSection, SettingRow } from '../../design/FormLayout'
import '../../components/results/results.css'
import CollectionPhotos from '../../components/results/CollectionPhotos'
import { DispatchModal, ManifestReceiveModal, printManifest } from './Manifest'

const { Text } = Typography

type TabKey = 'collect' | 'dept' | 'transit' | 'sentOut' | 'received' | 'rejected' | 'notReceived'
type Source = 'inhouse' | 'cc'

// A table row: one sample type of one bill (one department of one bill on Department Receive), like Flabs.
type ARow = AOrder & { rowKey: string; rowLineIds: string[] }
const ALL_TABS: TabKey[] = ['collect', 'dept', 'transit', 'sentOut', 'received', 'rejected', 'notReceived']
const TAB_LABEL: Record<TabKey, string> = {
  collect: 'Sample Collection',
  dept: 'Department Receive',
  transit: 'In Transit',
  sentOut: 'Sent to Lab',
  received: 'Received',
  rejected: 'Rejected',
  notReceived: 'Not Received',
}
const DATE_TITLE: Record<TabKey, string> = {
  collect: 'Registration Date',
  dept: 'Collection Date',
  transit: 'Dispatched On',
  sentOut: 'Sent On',
  received: 'Receiving Date',
  rejected: 'Rejection Date',
  notReceived: 'Marked On',
}

const RECEIVED_STATES = ['received', 'entered', 'approved', 'hold']
// Department Receive only exists in department-wise mode; otherwise a collected sample waits in Sample Collection
// until Collect & Receive (so it never gets lost between tabs).
const inTab = (i: AItem, t: TabKey, deptMode = true): boolean => {
  const away = !!i.inTransit || !!i.sentToLab
  if (t === 'transit') return !!i.inTransit && i.status === 'collected' && !i.sentToLab
  if (t === 'sentOut') return !!i.sentToLab && ['pending', 'collected', 'received'].includes(i.status)
  if (t === 'collect') return (i.status === 'pending' || (!deptMode && i.status === 'collected')) && !i.notReceived && !away
  if (t === 'dept') return deptMode && i.status === 'collected' && !away
  if (t === 'received') return RECEIVED_STATES.includes(i.status)
  if (t === 'rejected') return i.status === 'rejected'
  return i.status === 'pending' && !!i.notReceived
}

interface Filters {
  b2b: string
  department: string
  place: string
  sampleType: string
  phlebo: string
  centre: string
  rejected: boolean
  urgent: boolean
}
const NO_FILTERS: Filters = { b2b: '', department: '', place: '', sampleType: '', phlebo: '', centre: '', rejected: false, urgent: false }

interface Named {
  id: string
  name: string
  text?: string
  kind?: string
}

function BarcodeCell({ order, autoGenerate }: { order: AOrder; autoGenerate: boolean }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const scope = useBranchScope()
  const [val, setVal] = useState(order.barcode)
  const [busy, setBusy] = useState(false)
  useEffect(() => setVal(order.barcode), [order.barcode])
  const save = async () => {
    const v = val.trim()
    if (v === order.barcode || busy) return
    if (!v) {
      setVal(order.barcode)
      return
    }
    setBusy(true)
    try {
      await changeBarcode(order, v, profile as UserProfile, scope.constraints)
      message.success('Barcode updated')
    } catch (e) {
      setVal(order.barcode)
      message.error(e instanceof Error ? e.message : 'Could not change the barcode')
    } finally {
      setBusy(false)
    }
  }
  const generate = async () => {
    setBusy(true)
    try {
      const { nextBarcode } = await import('../../lib/db')
      await changeBarcode(order, await nextBarcode(), profile as UserProfile, scope.constraints)
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not generate a barcode')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Space.Compact>
      <Input
        size="small"
        aria-label={`Barcode for ${order.billNo}`}
        value={val}
        disabled={busy}
        placeholder={autoGenerate ? '' : 'Enter barcode'}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onPressEnter={save}
        style={{ width: 110, fontFamily: 'var(--font-mono, monospace)' }}
      />
      {!order.barcode && (
        <AButton size="small" onClick={generate} disabled={busy}>
          Generate
        </AButton>
      )}
    </Space.Compact>
  )
}

export default function AccessionPage() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const acc = settings.accession
  const accEnabled = acc?.enabled !== false
  const deptMode = acc?.mode === 'department'
  const autoBarcode = acc?.autoGenerateBarcode !== false
  const navigate = useNavigate()
  const canCollect = can(profile, 'accession.collect')
  const canReceive = can(profile, 'accession.receive')
  const canReject = can(profile, 'accession.reject')
  const [params, setParams] = useSearchParams()
  const maps = useCatalogueMaps()
  const scope = useBranchScope()
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('day'), dayjs().endOf('day')])
  const [tab, setTab] = useState<TabKey>('collect')
  const [rejectMany, setRejectMany] = useState<{ order: AOrder; lineIds: string[] }[] | null>(null)
  const [source, setSource] = useState<Source>('inhouse')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [draftFilters, setDraftFilters] = useState<Filters>(NO_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [pickFor, setPickFor] = useState<{ order: AOrder; kind: 'collect' | 'collectReceive'; lineIds: string[] } | null>(null)
  const [rejectFor, setRejectFor] = useState<{ order: AOrder; lineIds: string[] } | null>(null)
  const [dateFor, setDateFor] = useState<AOrder | null>(null)
  const [assignFor, setAssignFor] = useState<AOrder | null>(null)
  const [notRecFor, setNotRecFor] = useState<{ order: AOrder; lineIds: string[] } | null>(null)
  const [collector, setCollector] = useState<string>(profile?.role === 'phlebotomist' ? profile.uid : '')
  const [busy, setBusy] = useState(false)
  const [dispatchFor, setDispatchFor] = useState<{ order: AOrder; samples: string }[] | null>(null)
  const [manifestOpen, setManifestOpen] = useState(false)

  const { data: fetched, loading } = useLiveQuery<Order>(
    query(
      col<Order>(paths.orders),
      ...scope.constraints,
      where('createdAt', '>=', Timestamp.fromDate(range[0].toDate())),
      where('createdAt', '<=', Timestamp.fromDate(range[1].toDate())),
      orderBy('createdAt', 'desc'),
    ),
    [range[0].valueOf(), range[1].valueOf(), scope.key],
  )
  const orders = useMemo(() => (fetched as unknown as AOrder[]).filter((o) => !o.deleted), [fetched])

  // Masters: users (phlebotomists), collection centres, B2B centres, reject reasons.
  const { data: users } = useLiveQuery<UserProfile>(col<UserProfile>(paths.users), [])
  const live = <T extends object>(x: T[]) => x.filter((r) => !(r as { deleted?: boolean }).deleted) // soft-deleted masters stay hidden
  const { data: centresAll } = useLiveQuery<Named>(col<Named>('collectionCentres'), [])
  const { data: b2bsAll } = useLiveQuery<Named>(col<Named>('b2bCentres'), [])
  const { data: reasonsAll } = useLiveQuery<Named>(col<Named>('reasons'), [])
  const centres = useMemo(() => live(centresAll), [centresAll])
  const b2bs = useMemo(() => live(b2bsAll), [b2bsAll])
  const reasons = useMemo(() => live(reasonsAll), [reasonsAll])
  const phlebos = useMemo(
    () =>
      users.filter(
        (u) => u.role === 'phlebotomist' && u.active && (u.allBranches || (u.branchIds ?? ['main']).includes(scope.branchId)),
      ),
    [users, scope.branchId],
  )
  const collectorObj = phlebos.find((p) => p.uid === collector)
  const collectorArg = collectorObj ? { id: collectorObj.uid, name: collectorObj.name } : undefined
  const rejectReasons = reasons.filter((r) => r.kind === 'reject' && r.text)

  // ---- one order by id or barcode (may be outside the date range) -------------------
  const [extra, setExtra] = useState<AOrder | null>(null)
  useEffect(() => {
    if (!detailId || orders.some((o) => o.id === detailId)) return
    let cancelled = false
    getDoc(docRef<Order>(paths.orders, detailId)).then((snap) => {
      if (!cancelled && snap.exists()) setExtra({ ...(snap.data() as unknown as AOrder), id: snap.id })
    })
    return () => {
      cancelled = true
    }
  }, [detailId, orders])
  const detail = detailId ? (orders.find((o) => o.id === detailId) ?? (extra?.id === detailId ? extra : null)) : null

  // Every live bill carrying this barcode. A patient-wise barcode is shared by all of a patient's bills, so there can be several.
  const findAllByBarcode = async (code: string): Promise<AOrder[]> => {
    const c = code.trim()
    if (!c) return []
    const snap = await getDocs(query(col<Order>(paths.orders), ...scope.constraints, where('barcode', '==', c)))
    const found = new Map<string, AOrder>()
    for (const o of orders) if (o.barcode === c) found.set(o.id, o)
    for (const d of snap.docs) if (!d.data().deleted && !found.has(d.id)) found.set(d.id, { ...(d.data() as unknown as AOrder), id: d.id })
    return [...found.values()].sort((a, b) => (tsToDate(b.createdAt)?.getTime() ?? 0) - (tsToDate(a.createdAt)?.getTime() ?? 0))
  }
  // Several bills share the scanned barcode: ask which one, instead of opening the first match.
  const [billPick, setBillPick] = useState<{ orders: AOrder[]; done: (o: AOrder | null) => void } | null>(null)
  const pickBill = (list: AOrder[]) => new Promise<AOrder | null>((done) => setBillPick({ orders: list, done }))
  const one = async (code: string): Promise<AOrder | null> => {
    const all = await findAllByBarcode(code)
    if (all.length <= 1) return all[0] ?? null
    const picked = await pickBill(all)
    if (!picked) throw new Error('No bill selected for this barcode')
    return picked
  }

  // Billing navigates here with ?order=<id>; the top-bar Scan dialog with ?scan=<barcode>.
  const orderParam = params.get('order')
  useEffect(() => {
    if (orderParam) setDetailId(orderParam)
  }, [orderParam])
  // /accession?collect=<orderId> opens the Sample Collection dialog for that bill (e.g. after Register & Accession).
  const collectParam = params.get('collect')
  useEffect(() => {
    if (collectParam) setDetailId(collectParam)
  }, [collectParam])
  const scanParam = params.get('scan')
  useEffect(() => {
    if (!scanParam) return
    let cancelled = false
    resolveScan(scanParam)
      .then((r) => {
        if (cancelled) return
        if (r) setDetailId(r.order.id)
        else message.error(`No order found for barcode ${scanParam} in this branch`)
      })
      .catch((e: Error) => {
        if (!cancelled) message.info(e.message)
      })
      .finally(() => {
        if (cancelled) return
        const p = new URLSearchParams(params)
        p.delete('scan')
        setParams(p, { replace: true })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanParam])

  // ---- derived helpers --------------------------------------------------------------
  const workOf = (o: AOrder) => workItemsOf(o as unknown as Order, maps.testById) as AItem[]
  const sampleOf = (it: AItem) => {
    const names = new Set<string>()
    const colours: string[] = []
    it.testIds.forEach((tid) => {
      const st = maps.sampleTypeById.get(maps.testById.get(tid)?.sampleTypeId ?? '')
      if (st && !names.has(st.name)) {
        names.add(st.name)
        colours.push(st.tubeColor)
      }
    })
    return { names: [...names], colours }
  }
  const deptIdsOf = (it: AItem) => [...new Set(it.testIds.map((t) => maps.testById.get(t)?.departmentId ?? '').filter(Boolean))]
  const sampleIdsOf = (it: AItem) => [...new Set(it.testIds.map((t) => maps.testById.get(t)?.sampleTypeId ?? '').filter(Boolean))]
  const itemsIn = (o: AOrder, t: TabKey) => workOf(o).filter((i) => inTab(i, t, deptMode))
  const orderSamples = (o: AOrder) => [...new Set(workOf(o).flatMap((i) => sampleOf(i).names))]
  const isCC = (o: AOrder) => !!o.collectionCentreId
  const isUrgent = (o: AOrder) => o.priority === 'urgent' || o.items.some((i) => i.urgent)
  const placeOf = (o: AOrder) => o.collectedPlace || (isCC(o) ? 'cc' : 'lab')

  const q = search.trim().toLowerCase()
  const f = filters
  const passes = (o: AOrder) => {
    if (source === 'cc' ? !isCC(o) : isCC(o)) return false
    if (q && !(`${o.patientName} ${o.billNo} ${o.barcode} ${o.patientNo}`.toLowerCase().includes(q))) return false
    if (f.b2b && o.b2bCentreId !== f.b2b) return false
    if (f.centre && o.collectionCentreId !== f.centre) return false
    if (f.phlebo && o.phlebotomistId !== f.phlebo) return false
    if (f.place && placeOf(o) !== f.place) return false
    if (f.urgent && !isUrgent(o)) return false
    const items = workOf(o)
    if (f.rejected && !items.some((i) => i.status === 'rejected')) return false
    if (f.department && !items.some((i) => deptIdsOf(i).includes(f.department))) return false
    if (f.sampleType && !items.some((i) => sampleIdsOf(i).includes(f.sampleType))) return false
    return true
  }
  const scoped = useMemo(
    () => orders.filter(passes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orders, q, filters, source, maps],
  )
  const countsByTab = useMemo(() => {
    const c = {} as Record<TabKey, number>
    ALL_TABS.forEach((t) => {
      c[t] = scoped.filter((o) => itemsIn(o, t).length > 0).length
    })
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, maps, deptMode])
  // In Transit and Sent to Lab only show once something is in them (or while open).
  const tabs = ALL_TABS.filter((t) => (t !== 'dept' || deptMode) && (!['transit', 'sentOut'].includes(t) || t === tab || (countsByTab[t] ?? 0) > 0 || (t === 'transit' && source === 'cc')))
  useEffect(() => {
    if (tab === 'dept' && !deptMode) setTab('collect')
  }, [tab, deptMode])
  const rows: ARow[] = useMemo(
    () =>
      scoped.flatMap((o) => {
        const groups = new Map<string, AItem[]>()
        for (const it of itemsIn(o, tab)) {
          const k = tab === 'dept' ? deptIdsOf(it)[0] ?? '' : sampleIdsOf(it)[0] ?? ''
          groups.set(k, [...(groups.get(k) ?? []), it])
        }
        return [...groups.entries()].map(([k, g]): ARow => ({ ...o, rowKey: `${o.id}:${k}`, rowLineIds: g.map((i) => i.lineId) }))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoped, tab, maps, deptMode],
  )
  const inRow = (r: ARow) => (id: string) => r.rowLineIds.includes(id)
  const rowItems = (r: ARow) => itemsIn(r, tab).filter((i) => r.rowLineIds.includes(i.lineId))
  const rowSamples = (r: ARow) => [...new Set(rowItems(r).flatMap((i) => sampleOf(i).names))]
  const selectedRows = () => rows.filter((r) => selected.includes(r.rowKey))
  // Lines of one bill picked through the selected rows (a bill split over several rows is acted on once).
  const selectedByOrder = () => {
    const m = new Map<string, { order: AOrder; ids: string[] }>()
    for (const r of selectedRows()) {
      const cur = m.get(r.id) ?? { order: orders.find((o) => o.id === r.id) ?? r, ids: [] as string[] }
      cur.ids.push(...r.rowLineIds)
      m.set(r.id, cur)
    }
    return [...m.values()]
  }
  const activeFilters = Object.values(filters).filter(Boolean).length

  // ---- actions ----------------------------------------------------------------------
  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      message.success(ok)
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }
  const user = profile as UserProfile
  const ids = (o: AOrder, t: TabKey, dept?: string) =>
    itemsIn(o, t)
      .filter((i) => !dept || deptIdsOf(i).includes(dept))
      .map((i) => i.lineId)
  const toCollect = (o: AOrder) => itemsIn(o, 'collect').filter((i) => i.status === 'pending').map((i) => i.lineId)
  const toReceive = (o: AOrder) => [...new Set([...ids(o, 'collect'), ...ids(o, 'dept')])]
  const collect = (o: AOrder) => act(() => collectLines(o, toCollect(o), user, collectorArg, autoBarcode), 'Sample collected')
  const collectReceive = (o: AOrder) =>
    act(() => receiveLines(o, toReceive(o), user, collectorArg, autoBarcode), 'Status of Accession changed successfully')

  const selectedOrders = () => selectedByOrder().map((x) => x.order)
  const bulk = (kind: 'collect' | 'collectReceive' | 'receive') =>
    act(async () => {
      for (const { order: o, ids: picked } of selectedByOrder()) {
        if (kind === 'collect') await collectLines(o, toCollect(o).filter((id) => picked.includes(id)), user, collectorArg, autoBarcode)
        else if (kind === 'collectReceive') await receiveLines(o, toReceive(o).filter((id) => picked.includes(id)), user, collectorArg, autoBarcode)
        else await receiveLines(o, ids(o, 'dept').filter((id) => picked.includes(id)), user)
      }
      setSelected([])
    }, 'Done')
  // Tube labels of a bill: catalogue prefix / suffix rules, one label per bill or per sample type.
  const labelsOf = (o: AOrder) => sampleLabels(o.barcode, o.items, maps.testById, maps.sampleTypeById, settings, (id) => maps.departmentById.get(id)?.name ?? '')
  const labelSamples = (o: AOrder) => {
    const labels = labelsOf(o)
    if (!labels.length) return [{ name: orderSamples(o).join(', '), barcode: o.barcode }]
    return labels.map((l) => ({ name: acc?.barcodePer === 'bill' ? orderSamples(o).join(', ') : l.sampleName, barcode: l.barcode }))
  }
  const bulkLabels = () => {
    const t = selectedOrders()
    if (!printLabels(t.map((order) => ({ order, samples: labelSamples(order) })), acc?.labelSize)) message.warning('Allow pop-ups to print labels')
  }
  const printOne = (o: AOrder) => {
    if (!printLabels([{ order: o, samples: labelSamples(o) }], acc?.labelSize)) message.warning('Allow pop-ups to print labels')
  }
  // A line can be rejected until its result is approved (then it must be un-approved first).
  const rejectable = (o: AOrder) => [...ids(o, 'collect'), ...ids(o, 'dept'), ...ids(o, 'received')].filter((id) => workOf(o).find((i) => i.lineId === id)?.status !== 'approved')
  // Collected samples that can go into a dispatch manifest / out to a processing lab.
  const dispatchable = (o: AOrder) => workOf(o).filter((i) => i.status === 'collected' && !i.inTransit && !i.sentToLab).map((i) => i.lineId)
  const outsourceable = (o: AOrder) => workOf(o).filter((i) => ['pending', 'collected', 'received'].includes(i.status) && !i.sentToLab && (i.outsource?.length ?? 0) > 0)
  const bulkDispatch = () => {
    const list = selectedByOrder().filter((x) => dispatchable(x.order).some((id) => x.ids.includes(id)))
    if (!list.length) return message.info('Collect the samples first: only collected samples can be dispatched.')
    setDispatchFor(list.map(({ order }) => ({ order, samples: orderSamples(order).join(', ') })))
  }
  const sendOut = (o: AOrder) =>
    act(async () => {
      const groups = new Map<string, { labName: string; ids: string[] }>()
      outsourceable(o).forEach((i) => {
        const lab = i.outsource![0]
        const g = groups.get(lab.labId) ?? { labName: lab.labName, ids: [] }
        g.ids.push(i.lineId)
        groups.set(lab.labId, g)
      })
      for (const [labId, g] of groups) await sendToProcessingLab(o, g.ids, { labId, labName: g.labName }, user)
    }, 'Marked as sent to the processing lab')
  const bulkReject = () => {
    const list = selectedByOrder().map(({ order, ids: picked }) => ({ order, lineIds: rejectable(order).filter((id) => picked.includes(id)) })).filter((x) => x.lineIds.length)
    if (!list.length) return message.info('Nothing in the selection can be rejected (approved tests must be un-approved first).')
    setRejectMany(list)
  }

  // Scan resolves to a bill (and, with per-sample barcodes, one sample type of it).
  const resolveScan = async (code: string): Promise<{ order: AOrder; sampleTypeId?: string } | null> => {
    const exact = await one(code)
    if (exact) return { order: exact }
    // A tube code = sample prefix + bill barcode + test / sample suffix (set in the catalogue).
    const base = await one(billBarcodeFromScan(code, [...maps.testById.values()], [...maps.sampleTypeById.values()]))
    if (!base) return null
    const label = labelsOf(base).find((l) => l.barcode === code.trim())
    return label && acc?.barcodePer !== 'bill' && label.sampleTypeId ? { order: base, sampleTypeId: label.sampleTypeId } : { order: base }
  }

  // Scan dialog hook: collects, receives (the whole bill, or just the scanned sample) or opens the detail.
  // Patient-wise mode always handles the whole bill; sample- and department-wise modes handle the scanned tube.
  const scanAction = async (o: AOrder, kind: ScanKind, sampleTypeId?: string): Promise<ScanFeed> => {
    const sample = acc?.mode === 'patient' ? undefined : sampleTypeId
    const inSample = (id: string) => !sample || sampleIdsOf(workOf(o).find((i) => i.lineId === id) as AItem).includes(sample)
    const what = `${o.patientName} (${o.billNo})${sample ? `, ${maps.sampleTypeById.get(sample)?.name ?? 'sample'}` : ''}`
    if (kind === 'collect') {
      const t = toCollect(o).filter(inSample)
      if (!t.length) return { tone: 'warn', text: `${what}: nothing left to collect`, code: 'dup' }
      if (!canCollect) return { tone: 'bad', text: `${what}: you cannot collect samples`, code: 'bad' }
      await collectLines(o, t, user, collectorArg, autoBarcode)
      return { tone: 'ok', text: `${what} collected`, code: 'ok' }
    }
    if (kind === 'receive') {
      const targets = toReceive(o).filter(inSample)
      if (!targets.length) {
        const at = tsToDate(o.receivedAt)
        return { tone: 'warn', text: `${what}: already received${at ? ` at ${dayjs(at).format('DD-MMM hh:mm A')}` : ''}, nothing left to receive`, code: 'dup' }
      }
      if (!canReceive) return { tone: 'bad', text: `${what}: you cannot receive samples`, code: 'bad' }
      await receiveLines(o, targets, user, collectorArg, autoBarcode)
      return { tone: 'ok', text: `${what} received`, code: 'ok' }
    }
    setDetailId(o.id)
    return { tone: 'ok', text: `${what} opened`, code: 'open' }
  }

  const closeDetail = () => {
    setDetailId(null)
    if (params.has('order') || params.has('collect')) {
      const p = new URLSearchParams(params)
      p.delete('order')
      p.delete('collect')
      setParams(p, { replace: true })
    }
  }

  // ---- table ------------------------------------------------------------------------
  const dateOf = (o: AOrder): Date | null => {
    if (tab === 'collect') return tsToDate(o.accessionDate ?? o.createdAt)
    if (tab === 'dept') return tsToDate(o.collectedAt)
    if (tab === 'transit') return tsToDate(itemsIn(o, 'transit')[0]?.collectedAt ?? o.collectedAt)
    if (tab === 'sentOut') {
      const at = itemsIn(o, 'sentOut')[0]?.sentToLab?.at
      return at ? new Date(at) : null
    }
    if (tab === 'received') return tsToDate(o.receivedAt)
    if (tab === 'rejected')
      return tsToDate(itemsIn(o, 'rejected').map((i) => i.rejectedAt).filter(Boolean).sort((a, b) => b!.toMillis() - a!.toMillis())[0] ?? o.createdAt)
    return tsToDate(itemsIn(o, 'notReceived')[0]?.notReceivedAt ?? o.createdAt)
  }
  const fmtDt = (d: Date | null) => (d ? dayjs(d).format('DD-MMM-YYYY hh:mm A') : '-')
  const sourceText = (o: AOrder) => (isCC(o) ? `Collection Centre${o.collectionCentreName ? `: ${o.collectionCentreName}` : ''}` : 'In-house')
  const priorityText = (o: AOrder) => (isUrgent(o) ? 'Urgent' : o.priority ? o.priority[0].toUpperCase() + o.priority.slice(1) : 'Normal')
  const deptNames = (o: ARow) => [...new Set(rowItems(o).flatMap(deptIdsOf).map((d) => maps.departmentById.get(d)?.name ?? ''))].filter(Boolean)

  const testsCell = (o: ARow) => (
    <Space size={[4, 4]} wrap>
      {rowItems(o).map((it) => {
        const s = sampleOf(it)
        return (
          <StatusChip
            key={it.lineId}
            variant={it.status === 'rejected' ? 'urgent' : it.urgent ? 'caution' : 'neutral'}
            icon={
              <span style={{ display: 'inline-flex', gap: 2 }} aria-hidden="true">
                {s.colours.map((c, i) => (
                  <span key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: c, border: '1px solid var(--c-outline)' }} />
                ))}
              </span>
            }
          >
            {it.name}
            {it.urgent ? ' (urgent)' : ''}
            {(it.recollectCount ?? 0) > 0 ? ' (re-collect)' : ''}
            {it.inTransit ? ' (in transit)' : ''}
            {it.sentToLab ? ` (sent to ${it.sentToLab.labName})` : ''}
          </StatusChip>
        )
      })}
    </Space>
  )

  const rowMenu = (o: ARow) => ({
    items: [
      { key: 'detail', label: 'Open collection dialog' },
      { key: 'label', label: 'Print label' },
      { key: 'assign', label: 'Assign phlebotomist', disabled: !canCollect },
      { key: 'date', label: 'Change accession date', disabled: !canCollect },
      { key: 'notRec', label: 'Mark not received', disabled: !canReceive || !(itemsIn(o, 'dept').filter((i) => o.rowLineIds.includes(i.lineId)).length + itemsIn(o, 'received').filter((i) => o.rowLineIds.includes(i.lineId)).length) },
      { key: 'sendOut', label: 'Send to processing lab', disabled: !canReceive || !outsourceable(o).length },
      { key: 'reject', label: 'Reject sample', danger: true, disabled: !canReject || !rejectable(o).filter(inRow(o)).length },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'detail') setDetailId(o.id)
      else if (key === 'label') printOne(o)
      else if (key === 'assign') setAssignFor(o)
      else if (key === 'date') setDateFor(o)
      else if (key === 'notRec') setNotRecFor({ order: o, lineIds: [...ids(o, 'dept'), ...ids(o, 'received')].filter(inRow(o)) })
      else if (key === 'sendOut') sendOut(o)
      else if (key === 'reject') setRejectFor({ order: o, lineIds: rejectable(o).filter(inRow(o)) })
    },
  })

  // Collect / Collect & Receive: a row with several tests asks which ones (all ticked); a single test acts straight away.
  const runLines = (o: AOrder, kind: 'collect' | 'collectReceive', lineIds: string[]) =>
    act(() => (kind === 'collect' ? collectLines(o, lineIds, user, collectorArg, autoBarcode) : receiveLines(o, lineIds, user, collectorArg, autoBarcode)), kind === 'collect' ? 'Sample collected' : 'Status of Accession changed successfully')
  const askOrRun = (o: AOrder, kind: 'collect' | 'collectReceive', lineIds: string[]) =>
    lineIds.length > 1 ? setPickFor({ order: o, kind, lineIds }) : lineIds.length === 1 ? void runLines(o, kind, lineIds) : undefined

  const actionCell = (o: ARow) => {
    const mine = (t: TabKey) => ids(o, t).filter(inRow(o))
    return (
    <Space size={4} wrap>
      {tab === 'collect' && (
        <>
          <AButton size="small" onClick={() => askOrRun(o, 'collect', toCollect(o).filter(inRow(o)))} disabled={busy || !canCollect || !toCollect(o).some(inRow(o))}>
            Collect
          </AButton>
          <AButton size="small" type="primary" onClick={() => askOrRun(o, 'collectReceive', toReceive(o).filter(inRow(o)))} disabled={busy || !canReceive}>
            Collect &amp; Receive
          </AButton>
        </>
      )}
      {tab === 'dept' && (
        <AButton size="small" type="primary" disabled={busy || !canReceive} onClick={() => act(() => receiveLines(o, mine('dept'), user), 'Received')}>
          Receive
        </AButton>
      )}
      {tab === 'transit' && (
        <AButton size="small" type="primary" disabled={busy || !canReceive} onClick={() => setManifestOpen(true)}>
          Receive batch
        </AButton>
      )}
      {tab === 'sentOut' && (
        <AButton size="small" type="primary" disabled={busy || !canReceive} onClick={() => act(() => receiveLines(o, mine('sentOut'), user, collectorArg, autoBarcode), 'Marked as received back')}>
          Received back
        </AButton>
      )}
      {tab === 'notReceived' && (
        <>
          <AButton size="small" onClick={() => act(() => collectLines(o, mine('notReceived'), user, collectorArg, autoBarcode), 'Sample collected')} disabled={busy || !canCollect}>
            Collect
          </AButton>
          <AButton size="small" type="primary" onClick={() => act(() => receiveLines(o, mine('notReceived'), user, collectorArg, autoBarcode), 'Received')} disabled={busy || !canReceive}>
            Collect &amp; Receive
          </AButton>
        </>
      )}
      {tab === 'rejected' && (
        <>
          <Tooltip title={rowItems(o).map((i) => `${i.name}: ${i.rejectReason || 'No reason recorded'}${i.rejectRemark ? ` (${i.rejectRemark})` : ''}`).join('; ')}>
            <AButton size="small">View reason</AButton>
          </Tooltip>
          <AButton
            size="small"
            disabled={busy || !canCollect}
            onClick={() => act(async () => { await requestRecollection(o, mine('rejected'), user); await recomputeOrder(o.id, settings) }, 'Sent back to Sample Collection')}
          >
            Send for recollection
          </AButton>
        </>
      )}
      <Tooltip title="Print barcode label">
        <AButton size="small" aria-label={`Print label for ${o.billNo}`} icon={<PrinterOutlined />} onClick={() => printOne(o)} />
      </Tooltip>
      <Dropdown menu={rowMenu(o)} trigger={['click']}>
        <AButton size="small" aria-label={`More actions for ${o.billNo}`} icon={<MoreOutlined />} />
      </Dropdown>
    </Space>
    )
  }

  const tatCell = (o: AOrder) => {
    const t = tatDue(o as unknown as Order, settings.tat?.urgentTatPercent)
    return t ? <span style={t.overdue ? { color: 'var(--c-urgent, #b91c1c)', fontWeight: 600 } : undefined}>{t.text}{t.overdue ? ' (late)' : ''}</span> : '-'
  }
  const columns: ColumnsType<ARow> = [
    { title: DATE_TITLE[tab], key: 'date', width: 160, render: (_v, o) => fmtDt(dateOf(o)) },
    {
      title: 'Patient Info',
      key: 'patient',
      render: (_v, o) => (
        <div>
          <Text strong>{o.patientName}</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 'var(--fs-dense)' }}>
              {o.patientNo} · {o.billNo}
            </Text>
          </div>
        </div>
      ),
    },
    ...(tab === 'dept' ? [{ title: 'Department', key: 'dept', render: (_v: unknown, o: ARow) => deptNames(o).join(', ') || '-' }] : []),
    { title: 'Referrals', key: 'ref', render: (_v, o) => o.referrerName || 'Self' },
    { title: 'Barcode', key: 'barcode', width: 130, render: (_v, o) => <BarcodeCell order={o} autoGenerate={autoBarcode} /> },
    { title: 'Tests', key: 'tests', render: (_v, o) => testsCell(o) },
    {
      title: 'Sample',
      key: 'sample',
      render: (_v, o) => rowSamples(o).join(', ') || '-',
    },
    ...(showTatIn(settings, 'accession') ? [{ title: 'TAT', key: 'tat', width: 140, render: (_v: unknown, o: AOrder) => tatCell(o) }] : []),
    { title: 'Phlebotomist', key: 'phlebo', render: (_v, o) => o.phlebotomistName || '-' },
    { title: 'Source', key: 'source', render: (_v, o) => sourceText(o) },
    {
      title: 'Priority',
      key: 'priority',
      render: (_v, o) => <StatusChip variant={isUrgent(o) ? 'urgent' : 'neutral'}>{priorityText(o)}</StatusChip>,
    },
    { title: 'Action', key: 'actions', width: 360, render: (_v, o) => actionCell(o) },
  ]

  const exportCsv = () => {
    const list = selected.length ? rows.filter((o) => selected.includes(o.rowKey)) : rows
    downloadCsv(
      `accession-${tab}-${dayjs().format('YYYYMMDD-HHmm')}.csv`,
      [DATE_TITLE[tab], 'Patient', 'Patient No', 'Bill No', 'Department', 'Referral', 'Barcode', 'Tests', 'Sample', 'Phlebotomist', 'Source', 'Priority'],
      list.map((o) => [
        fmtDt(dateOf(o)),
        o.patientName,
        o.patientNo,
        o.billNo,
        deptNames(o).join(', '),
        o.referrerName || 'Self',
        o.barcode,
        rowItems(o).map((i) => i.name).join(', '),
        rowSamples(o).join(', '),
        o.phlebotomistName ?? '',
        sourceText(o),
        priorityText(o),
      ]),
    )
  }

  if (!accEnabled)
    return (
      <div>
        <PageHeader title="Accession" subtitle="Collect, receive and track samples" />
        <EmptyState
          title="Accession is turned off for this lab"
          description="New bills go straight to result entry with no sample collection or receipt step. Turn accession on in Lab settings to track samples."
          action={<Button variant="primary" onClick={() => navigate('/worklist')}>Open worklist</Button>}
        />
      </div>
    )


  const filterFields = [
    ['b2b', 'B2B Center', b2bs.map((b) => ({ value: b.id, label: b.name }))],
    ['department', 'Department', maps.departments.map((d) => ({ value: d.id, label: d.name }))],
    ['place', 'Collected At', [{ value: 'lab', label: 'Lab' }, { value: 'home', label: 'Home' }, { value: 'cc', label: 'Collection centre' }]],
    ['sampleType', 'Sample Type', maps.sampleTypes.map((s) => ({ value: s.id, label: s.name }))],
    ['phlebo', 'Phlebotomist', phlebos.map((p) => ({ value: p.uid, label: p.name }))],
    ['centre', 'Collection Center', centres.map((c) => ({ value: c.id, label: c.name }))],
  ] as [keyof Filters, string, { value: string; label: string }[]][]

  return (
    <div>
      <PageHeader
        title="Accession"
        subtitle="Collect, receive and track samples"
        actions={
          <Space>
            {(source === 'cc' || (countsByTab.transit ?? 0) > 0) && (
              <Button onClick={() => setManifestOpen(true)}>Receive manifest</Button>
            )}
            <Button variant="primary" icon={<ScanOutlined />} onClick={() => setScanOpen(true)}>
              Scan Mode
            </Button>
          </Space>
        }
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-3)', marginBottom: 'var(--s-3)' }}>
        <Segmented
          aria-label="Sample origin"
          size="small"
          value={source}
          onChange={(v) => {
            setSource(v)
            setSelected([])
          }}
          options={[
            { value: 'inhouse', label: 'In-house' },
            { value: 'cc', label: 'From Collection Centre' },
          ]}
        />
        <div style={{ overflowX: 'auto' }}>
          <Segmented
            aria-label="Accession status"
            value={tab}
            onChange={(v) => {
              setTab(v)
              setSelected([])
            }}
            options={tabs.map((k) => ({ value: k, label: TAB_LABEL[k], count: countsByTab[k] ?? 0 }))}
          />
        </div>
      </div>

      <Space wrap style={{ marginBottom: 'var(--s-3)', width: '100%', justifyContent: 'space-between' }}>
        <Space wrap>
          <DatePicker.RangePicker
            aria-label="Date range"
            value={range}
            allowClear={false}
            onChange={(v) => v && v[0] && v[1] && setRange([v[0].startOf('day'), v[1].endOf('day')])}
          />
          <Input.Search
            allowClear
            aria-label="Search accession"
            placeholder="Search patient, bill no, barcode"
            onChange={(e) => setSearch(e.target.value)}
            className="search-wide"
          />
          <AButton
            icon={<FilterOutlined />}
            onClick={() => {
              setDraftFilters(filters)
              setFiltersOpen(true)
            }}
          >
            Filter{activeFilters ? ` (${activeFilters})` : ''}
          </AButton>
          <AButton icon={<DownloadOutlined />} onClick={exportCsv} disabled={!rows.length}>
            Export
          </AButton>
        </Space>
        <Space wrap>
          {(tab === 'collect' || tab === 'notReceived') && (
            <Select
              allowClear
              aria-label="Collected by"
              placeholder="Collected by"
              style={{ width: 190 }}
              value={collector || undefined}
              onChange={(v) => setCollector(v ?? '')}
              options={phlebos.map((p) => ({ value: p.uid, label: p.name }))}
            />
          )}
          {selected.length > 0 && (
            <>
              {tab === 'collect' && (
                <AButton disabled={busy || !canCollect} onClick={() => bulk('collect')}>
                  Collect ({selected.length})
                </AButton>
              )}
              {(tab === 'collect' || tab === 'notReceived') && (
                <AButton type="primary" disabled={busy || !canReceive} onClick={() => bulk('collectReceive')}>
                  Collect &amp; Receive ({selected.length})
                </AButton>
              )}
              {tab === 'dept' && (
                <AButton type="primary" disabled={busy || !canReceive} onClick={() => bulk('receive')}>
                  Receive ({selected.length})
                </AButton>
              )}
              {source === 'cc' && (tab === 'collect' || tab === 'dept') && (
                <AButton disabled={busy || !canCollect} onClick={bulkDispatch}>
                  Dispatch manifest ({selected.length})
                </AButton>
              )}
              <AButton danger icon={<CloseCircleOutlined />} disabled={busy || !canReject} onClick={bulkReject}>
                Reject ({selected.length})
              </AButton>
              <AButton icon={<PrinterOutlined />} onClick={bulkLabels}>
                Print labels ({selected.length})
              </AButton>
            </>
          )}
        </Space>
      </Space>

      <Table<ARow>
        rowKey="rowKey"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: <EmptyState title="No orders" description={`Nothing in ${TAB_LABEL[tab]} for these filters.`} /> }}
        rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
        expandable={
          tab === 'rejected' || tab === 'notReceived'
            ? {
                expandedRowRender: (o) => (
                  <div>
                    {rowItems(o).map((i) => (
                      <div key={i.lineId} style={{ marginBottom: 'var(--s-1)' }}>
                        <StatusChip variant="urgent">{i.name}</StatusChip>{' '}
                        <Text type="secondary">
                          {(tab === 'rejected' ? i.rejectReason : i.notReceivedReason) || 'No reason recorded'}
                          {i.recollectRequested ? ' · re-collection requested' : ''}
                          {tab === 'notReceived' && i.notReceivedAuto ? ' · marked automatically after the cut-off' : ''}
                        </Text>
                      </div>
                    ))}
                  </div>
                ),
                defaultExpandAllRows: true,
              }
            : undefined
        }
      />

      {/* Filter drawer */}
      <Drawer
        title="Filter"
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        width={380}
        footer={
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <AButton
              onClick={() => {
                setFilters(NO_FILTERS)
                setFiltersOpen(false)
              }}
            >
              Clear All
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
              ['Where it came from', ['b2b', 'place', 'centre']],
              ['Sample and staff', ['department', 'sampleType', 'phlebo']],
            ] as [string, (keyof Filters)[]][]
          ).map(([title, keys]) => (
            <FormSection key={title} title={title}>
              <FieldGrid min={150}>
                {filterFields.filter((f) => keys.includes(f[0])).map(([k, label, options]) => (
                  <Form.Item key={k} label={label} style={{ marginBottom: 0 }}>
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder="Any"
                      value={(draftFilters[k] as string) || undefined}
                      onChange={(v) => setDraftFilters((d) => ({ ...d, [k]: v ?? '' }))}
                      options={options}
                    />
                  </Form.Item>
                ))}
              </FieldGrid>
            </FormSection>
          ))}
          <FormSection title="Show only">
            <SettingRow label="Rejected" help="Only samples that were rejected.">
              <Switch aria-label="Rejected" checked={draftFilters.rejected} onChange={(v) => setDraftFilters((d) => ({ ...d, rejected: v }))} />
            </SettingRow>
            <SettingRow label="Urgent" help="Only urgent bills.">
              <Switch aria-label="Urgent" checked={draftFilters.urgent} onChange={(v) => setDraftFilters((d) => ({ ...d, urgent: v }))} />
            </SettingRow>
          </FormSection>
        </Form>
      </Drawer>

      <ScanDialog
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        orders={orders}
        resolve={resolveScan}
        onResolved={scanAction}
        canReceive={canReceive}
        canCollect={canCollect}
        accessionMode={acc?.mode ?? 'patient'}
        waiting={orders.filter((o) => toReceive(o).length > 0).length}
      />

      <DispatchModal
        open={!!dispatchFor}
        entries={dispatchFor ?? []}
        centres={centres}
        busy={busy}
        onClose={() => setDispatchFor(null)}
        onSubmit={(meta) =>
          dispatchFor &&
          act(async () => {
            const entries = dispatchFor.map((e) => ({ order: e.order, lineIds: dispatchable(e.order), samples: e.samples }))
            const made = await dispatchManifest(entries, meta, user)
            printManifest({ no: made.no, centreName: meta.centreName, courier: meta.courier, tubes: meta.tubes, temperature: meta.temperature, note: meta.note, lines: entries.map((e) => ({ orderId: e.order.id, billNo: e.order.billNo, patientName: e.order.patientName, barcode: e.order.barcode, lineIds: e.lineIds, samples: e.samples })) }, user.name)
            setDispatchFor(null)
            setSelected([])
          }, 'Manifest dispatched')
        }
      />
      <ManifestReceiveModal open={manifestOpen} user={user} autoBarcode={autoBarcode} onClose={() => setManifestOpen(false)} />

      {/* Collection dialog */}
      <Modal
        open={!!detail}
        onCancel={closeDetail}
        title={detail ? `Sample Collection - ${detail.patientName} (${detail.billNo})` : 'Sample Collection'}
        width={dialogWidth(760)}
        destroyOnHidden
        footer={
          detail && (
            <Space wrap>
              <AButton icon={<PrinterOutlined />} onClick={() => printOne(detail)}>
                Print label
              </AButton>
              <AButton onClick={() => collect(detail)} disabled={busy || !canCollect}>
                Collect
              </AButton>
              <AButton
                type="primary"
                icon={<CheckCircleOutlined />}
                disabled={busy || !canReceive}
                onClick={async () => {
                  await collectReceive(detail)
                  closeDetail()
                }}
              >
                Collect &amp; Receive
              </AButton>
            </Space>
          )
        }
      >
        {detail && (
          <div>
            <FormSection title="Sample details">
              <FieldGrid min={200}>
                <div className="re-field"><label>Barcode</label><BarcodeCell order={detail} autoGenerate={autoBarcode} /></div>
                <div className="re-field"><label>Billed</label><div>{fmtDateTime(detail.createdAt)}</div></div>
                <div className="re-field">
                  <label htmlFor="acc-collector">Collected by</label>
                  <Select
                    id="acc-collector"
                    allowClear
                    aria-label="Collected by"
                    placeholder="Collected by"
                    value={collector || undefined}
                    onChange={(v) => setCollector(v ?? '')}
                    options={phlebos.map((p) => ({ value: p.uid, label: p.name }))}
                  />
                </div>
              </FieldGrid>
              <div className="re-field">
                <label>Collection photos</label>
                <CollectionPhotos
                  orderId={detail.id}
                  files={detail.collectionPhotoFiles}
                  legacy={detail.collectionPhotos}
                  canAdd={canCollect}
                  who={{ uid: user.uid, name: user.name }}
                />
              </div>
            </FormSection>
            <FormSection title="Tests">
            <Table<AItem>
              rowKey="lineId"
              size="small"
              pagination={false}
              dataSource={workOf(detail)}
              columns={[
                {
                  title: 'Test',
                  render: (_v, it) => {
                    const s = sampleOf(it)
                    return (
                      <span>
                        {s.colours.map((c, i) => (
                          <span
                            key={i}
                            aria-hidden="true"
                            style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: c, marginRight: 4, border: '1px solid var(--c-outline)' }}
                          />
                        ))}
                        {it.name} <Text type="secondary">{s.names.join(', ')}</Text>
                      </span>
                    )
                  },
                },
                {
                  title: 'Status',
                  width: 150,
                  render: (_v, it) => (
                    <StatusChip variant={it.status === 'rejected' ? 'urgent' : it.status === 'pending' ? 'neutral' : it.status === 'collected' ? 'caution' : 'success'}>
                      {it.notReceived ? 'Not received' : it.status}
                    </StatusChip>
                  ),
                },
                {
                  title: '',
                  width: 110,
                  render: (_v, it) =>
                    ['pending', 'collected'].includes(it.status) ? (
                      <AButton
                        size="small"
                        danger
                        disabled={!canReject}
                        icon={<CloseCircleOutlined />}
                        onClick={() => setRejectFor({ order: detail, lineIds: [it.lineId] })}
                      >
                        Reject
                      </AButton>
                    ) : null,
                },
              ]}
            />
            </FormSection>
          </div>
        )}
      </Modal>

      <Modal
        open={!!billPick}
        title="Several bills share this barcode"
        footer={null}
        onCancel={() => {
          billPick?.done(null)
          setBillPick(null)
        }}
        destroyOnHidden
      >
        <p style={{ marginTop: 0 }}>Pick the bill to work on.</p>
        <Table<AOrder>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={billPick?.orders ?? []}
          columns={[
            { title: 'Patient', render: (_: unknown, o) => o.patientName },
            { title: 'Bill', dataIndex: 'billNo' },
            { title: 'Date', render: (_: unknown, o) => fmtDt(tsToDate(o.billDate ?? o.createdAt)) },
            { title: 'Tests', render: (_: unknown, o) => o.items.filter((i) => i.status !== 'refunded' && !i.isCharge).map((i) => i.name).join(', ') },
            {
              title: '',
              render: (_: unknown, o) => (
                <AButton
                  size="small"
                  type="primary"
                  onClick={() => {
                    billPick?.done(o)
                    setBillPick(null)
                  }}
                >
                  Select
                </AButton>
              ),
            },
          ]}
        />
      </Modal>

      <PickTestsModal
        target={pickFor}
        busy={busy}
        onClose={() => setPickFor(null)}
        onSubmit={(lineIds) => pickFor && runLines(pickFor.order, pickFor.kind, lineIds).then(() => setPickFor(null))}
      />

      <RejectModal
        target={rejectFor}
        reasons={rejectReasons.map((r) => r.text as string)}
        busy={busy}
        onClose={() => setRejectFor(null)}
        pickLines
        onSubmit={(reason, recollect, remark, lineIds) =>
          rejectFor &&
          act(async () => {
            await rejectLines(rejectFor.order, lineIds, reason, recollect, user, remark)
            // A rejected line no longer blocks Final; refresh the bill's report status.
            await recomputeOrder(rejectFor.order.id, settings)
            setRejectFor(null)
          }, 'Sample rejected')
        }
      />

      <RejectModal
        target={rejectMany ? { order: rejectMany[0].order, lineIds: [] } : null}
        label={rejectMany ? `${rejectMany.reduce((n, x) => n + x.lineIds.length, 0)} sample line(s) on ${rejectMany.length} bill(s)` : undefined}
        reasons={rejectReasons.map((r) => r.text as string)}
        busy={busy}
        onClose={() => setRejectMany(null)}
        onSubmit={(reason, recollect, remark) =>
          rejectMany &&
          act(async () => {
            for (const x of rejectMany) {
              await rejectLines(x.order, x.lineIds, reason, recollect, user, remark)
              await recomputeOrder(x.order.id, settings)
            }
            setRejectMany(null)
            setSelected([])
          }, 'Samples rejected')
        }
      />

      <ReasonModal
        title="Mark not received"
        open={!!notRecFor}
        okText="Mark not received"
        requiredReason={false}
        busy={busy}
        onClose={() => setNotRecFor(null)}
        onSubmit={(reason) =>
          notRecFor &&
          act(async () => {
            await markNotReceived(notRecFor.order, notRecFor.lineIds, reason, user)
            setNotRecFor(null)
          }, 'Marked as not received')
        }
      />

      <DateModal
        order={dateFor}
        busy={busy}
        onClose={() => setDateFor(null)}
        onSubmit={(d, reason) =>
          dateFor &&
          act(async () => {
            await changeAccessionDate(dateFor, d, reason, user)
            setDateFor(null)
          }, 'Accession date changed')
        }
      />

      <Modal
        open={!!assignFor}
        title="Assign phlebotomist"
        okText="Assign"
        destroyOnHidden
        onCancel={() => setAssignFor(null)}
        onOk={async () => {
          const p = phlebos.find((x) => x.uid === collector)
          if (!assignFor) return
          await act(() => assignPhlebotomist(assignFor, p ? { id: p.uid, name: p.name } : null), p ? `Assigned to ${p.name}` : 'Assignment cleared')
          setAssignFor(null)
        }}
      >
        <div className="re-field">
        <label htmlFor="acc-assign">Phlebotomist</label>
        <Select
          id="acc-assign"
          allowClear
          style={{ width: '100%' }}
          aria-label="Phlebotomist"
          placeholder={phlebos.length ? 'Select phlebotomist' : 'No phlebotomists in this branch'}
          value={collector || undefined}
          onChange={(v) => setCollector(v ?? '')}
          options={phlebos.map((p) => ({ value: p.uid, label: p.name }))}
        />
        </div>
      </Modal>
    </div>
  )
}

// ---- Scan and Collect Sample dialog ------------------------------------------------

type ScanKind = 'receive' | 'collect' | 'open'
interface ScanFeed {
  tone: 'ok' | 'warn' | 'bad'
  text: string
  code: 'ok' | 'dup' | 'bad' | 'open'
}
const MODE_TEXT: Record<string, string> = {
  patient: 'Patient-wise: one scan handles the whole bill.',
  sample: 'Sample-wise: one scan handles the tube you scanned.',
  department: 'Department-wise: one scan handles the tube; each department then receives its own tests.',
}
const KIND_LABEL: Record<ScanKind, string> = { receive: 'Collect and receive', collect: 'Collect only', open: 'Open details' }

function ScanDialog({
  open,
  onClose,
  orders,
  resolve,
  onResolved,
  canReceive,
  canCollect,
  accessionMode,
  waiting,
}: {
  open: boolean
  onClose: () => void
  orders: AOrder[]
  resolve: (code: string) => Promise<{ order: AOrder; sampleTypeId?: string } | null>
  onResolved: (o: AOrder, kind: ScanKind, sampleTypeId?: string) => Promise<ScanFeed>
  canReceive: boolean
  canCollect: boolean
  accessionMode: string
  waiting: number
}) {
  const { message } = App.useApp()
  const [mode, setMode] = useState<'scan' | 'manual'>('scan')
  const [kind, setKind] = useState<ScanKind>('receive')
  const [code, setCode] = useState('')
  const [manualId, setManualId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [feed, setFeed] = useState<ScanFeed[]>([])
  // Session counters: every scan counts once; the expected figure is what was waiting when the dialog opened.
  const [count, setCount] = useState({ scanned: 0, ok: 0, dup: 0, bad: 0 })
  const [expected, setExpected] = useState(0)
  const lastScan = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const ref = useRef<InputRef>(null)

  useEffect(() => {
    if (open && mode === 'scan') setTimeout(() => ref.current?.focus(), 50)
  }, [open, mode, kind])
  useEffect(() => {
    if (!open) return
    setFeed([])
    setCount({ scanned: 0, ok: 0, dup: 0, bad: 0 })
    setExpected(waiting)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (kind === 'receive' && !canReceive) setKind(canCollect ? 'collect' : 'open')
  }, [kind, canReceive, canCollect])

  const beep = (ok: boolean) => {
    try {
      const Ctx = window.AudioContext
      const ctx = new Ctx()
      const o = ctx.createOscillator()
      o.frequency.value = ok ? 880 : 220
      o.connect(ctx.destination)
      o.start()
      o.stop(ctx.currentTime + 0.12)
      setTimeout(() => void ctx.close(), 300)
    } catch {
      /* sound is optional */
    }
  }
  const push = (f: ScanFeed) => {
    setFeed((x) => [f, ...x].slice(0, 8))
    setCount((c) => ({ scanned: c.scanned + 1, ok: c.ok + (f.code === 'ok' || f.code === 'open' ? 1 : 0), dup: c.dup + (f.code === 'dup' ? 1 : 0), bad: c.bad + (f.code === 'bad' ? 1 : 0) }))
  }

  const go = async () => {
    const c = code.trim()
    // Scanners can fire twice: ignore the same code within half a second.
    if (mode === 'scan' && c && lastScan.current.code === c && Date.now() - lastScan.current.at < 500) return
    lastScan.current = { code: c, at: Date.now() }
    setBusy(true)
    try {
      let hit: { order: AOrder; sampleTypeId?: string } | null = null
      if (mode === 'manual') {
        const o = orders.find((x) => x.id === manualId)
        hit = o ? { order: o } : null
      } else hit = await resolve(c)
      if (!hit) {
        beep(false)
        if (mode === 'scan') push({ tone: 'bad', text: `No order found for barcode ${c}`, code: 'bad' })
        else message.error('Select an order first')
      } else {
        const rec = await onResolved(hit.order, mode === 'scan' ? kind : 'open', hit.sampleTypeId)
        beep(rec.tone !== 'bad')
        if (mode === 'scan') push(rec)
        setCode('')
        if (!(mode === 'scan' && kind !== 'open')) onClose()
      }
    } catch (e) {
      beep(false)
      push({ tone: 'bad', text: (e as Error).message, code: 'bad' })
      message.error((e as Error).message)
    } finally {
      setBusy(false)
      if (mode === 'scan') ref.current?.focus()
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title="Scan and Collect Sample" footer={null} destroyOnHidden>
      <Radio.Group
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        optionType="button"
        options={[
          { value: 'scan', label: 'Scan Mode' },
          { value: 'manual', label: 'Manual Search' },
        ]}
        style={{ marginBottom: 'var(--s-3)' }}
      />
      {mode === 'scan' ? (
        <>
          <div style={{ marginBottom: 'var(--s-3)' }}>
            <Text type="secondary">On scan</Text>
            <div>
              <Radio.Group
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                options={(['receive', 'collect', 'open'] as ScanKind[]).map((k) => ({ value: k, label: KIND_LABEL[k], disabled: (k === 'receive' && !canReceive) || (k === 'collect' && !canCollect) }))}
              />
            </div>
            <Text type="secondary" style={{ fontSize: 'var(--fs-dense)' }}>{MODE_TEXT[accessionMode] ?? MODE_TEXT.patient}</Text>
          </div>
          <Input
            ref={ref}
            size="large"
            prefix={<ScanOutlined />}
            aria-label="Barcode"
            placeholder="Scan barcode and press Enter"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onPressEnter={go}
            style={{ fontFamily: 'var(--font-mono, monospace)', marginBottom: 'var(--s-3)' }}
          />
          <div role="status" aria-live="polite" style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap', marginBottom: 'var(--s-2)' }}>
            <StatusChip variant="info">Scanned {count.scanned}{kind !== 'open' && expected > 0 ? ` (${count.ok} of ${expected} waiting done)` : ''}</StatusChip>
            <StatusChip variant="success">{kind === 'collect' ? 'Collected' : kind === 'receive' ? 'Received' : 'Opened'} {count.ok}</StatusChip>
            {count.dup > 0 && <StatusChip variant="caution">Already done {count.dup}</StatusChip>}
            {count.bad > 0 && <StatusChip variant="urgent">Not found / failed {count.bad}</StatusChip>}
          </div>
          {feed.length > 0 && (
            <div role="log" aria-live="polite" style={{ display: 'grid', gap: 4 }}>
              {feed.map((x, i) => (
                <StatusChip key={i} variant={x.tone === 'ok' ? 'success' : x.tone === 'warn' ? 'caution' : 'urgent'}>
                  {x.text}
                </StatusChip>
              ))}
            </div>
          )}
        </>
      ) : (
        <Select
          showSearch
          aria-label="Order"
          style={{ width: '100%' }}
          placeholder="Search patient, bill no or barcode"
          value={manualId}
          onChange={setManualId}
          optionFilterProp="label"
          options={orders.map((o) => ({ value: o.id, label: `${o.patientName} · ${o.billNo} · ${o.barcode}` }))}
        />
      )}
      <div style={{ textAlign: 'right', marginTop: 'var(--s-4)' }}>
        <AButton type="primary" loading={busy} onClick={go}>
          Get Details
        </AButton>
      </div>
    </Modal>
  )
}

// ---- Reject with reasons master and optional re-collection ---------------------------

// Collect / Collect & Receive for a row with several tests: choose the tests (all ticked to start with).
function PickTestsModal({
  target,
  busy,
  onClose,
  onSubmit,
}: {
  target: { order: AOrder; kind: 'collect' | 'collectReceive'; lineIds: string[] } | null
  busy: boolean
  onClose: () => void
  onSubmit: (lineIds: string[]) => void
}) {
  const [chosen, setChosen] = useState<string[]>([])
  useEffect(() => {
    if (target) setChosen(target.lineIds)
  }, [target])
  const lines = target ? target.order.items.filter((i) => target.lineIds.includes(i.lineId)) : []
  return (
    <Modal
      open={!!target}
      title={target?.kind === 'collect' ? 'Collect sample' : 'Collect and receive'}
      okText={target?.kind === 'collect' ? 'Collect' : 'Collect & Receive'}
      okButtonProps={{ disabled: !chosen.length, loading: busy }}
      onOk={() => onSubmit(chosen)}
      onCancel={onClose}
      destroyOnHidden
    >
      <FormSection title="Select test(s)" description="Only the ticked tests are collected.">
      <Checkbox.Group style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--s-2) var(--s-4)' }} value={chosen} onChange={(v) => setChosen(v as string[])} options={lines.map((i) => ({ value: i.lineId, label: i.name }))} />
      </FormSection>
    </Modal>
  )
}

function RejectModal({
  target,
  label,
  reasons,
  busy,
  pickLines,
  onClose,
  onSubmit,
}: {
  target: { order: AOrder; lineIds: string[] } | null
  label?: string
  reasons: string[]
  busy: boolean
  pickLines?: boolean // single bill: choose which of its tests to reject (none ticked to start with)
  onClose: () => void
  onSubmit: (reason: string, recollect: boolean, remark: string, lineIds: string[]) => void
}) {
  const { message } = App.useApp()
  const [pick, setPick] = useState<string>()
  const [other, setOther] = useState('')
  const [remark, setRemark] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [recollect, setRecollect] = useState(false)
  const OTHER = '__other'
  useEffect(() => {
    if (target) {
      setPick(undefined)
      setOther('')
      setRemark('')
      setChosen([])
      setRecollect(false)
    }
  }, [target])
  const list = [...REJECT_REASONS, ...reasons.filter((r) => !REJECT_REASONS.includes(r))]
  const lines = target ? target.order.items.filter((i) => target.lineIds.includes(i.lineId)) : []
  const submit = () => {
    const reason = (pick && pick !== OTHER ? pick : other).trim()
    if (pickLines && !chosen.length) return void message.warning('Select at least one test to reject')
    if (!reason) {
      message.warning('A reason is required to reject a sample')
      return
    }
    onSubmit(reason, recollect, remark.trim(), pickLines ? chosen : target?.lineIds ?? [])
  }
  return (
    <Modal open={!!target} title="Reason for rejection" okText="Reject" okButtonProps={{ danger: true, loading: busy }} onOk={submit} onCancel={onClose} destroyOnHidden>
      {target && (
        <>
          <FormSection title={pickLines ? 'Which tests' : 'Sample'}>
            {pickLines ? (
              <Checkbox.Group
                style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--s-2) var(--s-4)' }}
                value={chosen}
                onChange={(v) => setChosen(v as string[])}
                options={lines.map((i) => ({ value: i.lineId, label: i.name }))}
              />
            ) : (
              <p style={{ margin: 0 }}>
                {label ?? `${lines.map((i) => i.name).join(', ')} for ${target.order.patientName}`}
              </p>
            )}
          </FormSection>
          <FormSection title="Why">
            <div className="re-field">
              <label htmlFor="rej-reason">Rejection reason</label>
              <Select
                id="rej-reason"
                aria-label="Rejection reason"
                placeholder="Select a reason"
                value={pick}
                onChange={setPick}
                options={[...list.map((r) => ({ value: r, label: r })), { value: OTHER, label: 'Other (type below)' }]}
              />
            </div>
            {pick === OTHER && (
              <div className="re-field">
                <label htmlFor="rej-other">Reason (required)</label>
                <Input.TextArea id="rej-other" rows={2} aria-label="Reason" placeholder="Reason (required)" value={other} onChange={(e) => setOther(e.target.value)} />
              </div>
            )}
            <div className="re-field">
              <label htmlFor="rej-remark">Remark (optional)</label>
              <Input.TextArea id="rej-remark" rows={2} aria-label="Remark" placeholder="Remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
            </div>
            <Checkbox checked={recollect} onChange={(e) => setRecollect(e.target.checked)}>
              Send for recollection
            </Checkbox>
          </FormSection>
        </>
      )}
    </Modal>
  )
}

function ReasonModal({
  title,
  open,
  okText,
  requiredReason,
  busy,
  onClose,
  onSubmit,
}: {
  title: string
  open: boolean
  okText: string
  requiredReason: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (reason: string) => void
}) {
  const { message } = App.useApp()
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  return (
    <Modal
      open={open}
      title={title}
      okText={okText}
      okButtonProps={{ loading: busy }}
      onCancel={onClose}
      onOk={() => (requiredReason && !reason.trim() ? message.warning('A reason is required') : onSubmit(reason.trim()))}
      destroyOnHidden
    >
      <div className="re-field">
        <label htmlFor="acc-reason">{requiredReason ? 'Reason (required)' : 'Reason (optional)'}</label>
        <Input.TextArea id="acc-reason" rows={3} aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  )
}

function DateModal({
  order,
  busy,
  onClose,
  onSubmit,
}: {
  order: AOrder | null
  busy: boolean
  onClose: () => void
  onSubmit: (d: Date, reason: string) => void
}) {
  const { message } = App.useApp()
  const [d, setD] = useState<Dayjs | null>(null)
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (order) {
      setD(dayjs(tsToDate(order.accessionDate ?? order.createdAt) ?? new Date()))
      setReason('')
    }
  }, [order])
  return (
    <Modal
      open={!!order}
      title="Change accession date"
      okText="Change date"
      okButtonProps={{ loading: busy }}
      onCancel={onClose}
      onOk={() => {
        if (!d) return message.warning('Choose a date')
        if (!reason.trim()) return message.warning('A reason is required')
        onSubmit(d.toDate(), reason.trim())
      }}
      destroyOnHidden
    >
      <div className="re-field">
        <label htmlFor="acc-date">New accession date and time</label>
        <DatePicker id="acc-date" showTime style={{ width: '100%' }} value={d} onChange={setD} aria-label="New accession date" allowClear={false} />
      </div>
      <div className="re-field">
        <label htmlFor="acc-date-reason">Reason (required)</label>
        <Input.TextArea id="acc-date-reason" rows={2} aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {(order?.accessionLog ?? []).length > 0 && (
        <Text type="secondary">Changed {order?.accessionLog?.length} time(s) before.</Text>
      )}
    </Modal>
  )
}
