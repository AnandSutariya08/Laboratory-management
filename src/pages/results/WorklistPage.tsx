import { useEffect, useMemo, useState } from 'react'
import { hasParameterGrid, isRadiologyTest, worklistFor } from '../catalogue/behaviour'
import { showTatIn } from '../../features/settings/lib'
import { tatDue } from '../../features/patient/lib'
import { Link, useNavigate } from 'react-router-dom'
import { App, Checkbox, DatePicker, Drawer, Input, Popover, Select, Switch, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CheckOutlined, DownloadOutlined, FilterOutlined, PauseCircleOutlined, PrinterOutlined, SendOutlined, TableOutlined, ThunderboltOutlined, FileTextOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { getDocs, limit, orderBy, query, serverTimestamp, Timestamp, updateDoc, where } from 'firebase/firestore'
import { col, docRef, paths } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { displayId } from '../../lib/billing'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useBranchScope } from '../../lib/branchScope'
import { can, useAuth } from '../../auth/AuthProvider'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { Button } from '../../design/Button'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonRows } from '../../design/Skeletons'
import type { OrderItem, Patient, UserProfile } from '../../types'
import {
  downloadCsv,
  fmtDateTime,
  ITEM_LABEL,
  ITEM_VARIANT,
  liveItems,
  lineStatusKey,
  REPORT_VARIANT,
  saveWorklistIds,
  tsToDate,
} from '../../components/results/common'
import type { OrderExt } from '../../components/results/types'
import { addVersion, approveEntries, checkApprovable, loadResults, syncItems, writeResult, type ApprovalEntry } from '../../components/results/resultOps'
import BatchEntryModal from '../../components/results/BatchEntry'
import AutoVerifyRulesModal from '../../components/results/AutoVerifyRules'
import { ReasonModal } from '../../components/results/Dialogs'
import BulkSendModal from '../../components/messaging/BulkSendModal'
import WorksheetModal from '../../features/patient/WorksheetModal'
import { useQcApprovalBlock } from '../../features/qc/lib/qcBlock'
import { needsResultEntry } from '../catalogue/flags'
import '../../components/results/results.css'

type View = 'patient' | 'test'
type PTab = 'all' | 'pending' | 'partial' | 'completed' | 'delivered'
type TTab = 'all' | 'pending' | 'pastPending' | 'rejected' | 'hold' | 'rerun' | 'verify' | 'provisional' | 'complete'
type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'custom'
// Which date the range applies to: registration (bill), accession (sample received) or report (final) date.
type Basis = 'registration' | 'accession' | 'report'
const BASIS_FIELD: Record<Basis, string> = { registration: 'createdAt', accession: 'receivedAt', report: 'reportedAt' }

interface Filters {
  tests: string[]
  packages: string[]
  referrer: string
  b2b: string
  centre: string
  collectedAt: '' | 'lab' | 'home'
  urgent: boolean
  billSort: 'desc' | 'asc'
  who: '' | 'self' | 'referred'
  machineValue: boolean
  assigned: '' | 'me' | 'unassigned'
}
const NO_FILTERS: Filters = { tests: [], packages: [], referrer: '', b2b: '', centre: '', collectedAt: '', urgent: false, billSort: 'desc', who: '', machineValue: false, assigned: '' }

interface TestRow {
  key: string
  order: OrderExt
  item: OrderItem
}

const workItems = (o: OrderExt) => liveItems(o).filter((i) => i.status !== 'rejected')
const isRerun = (o: OrderExt, i: OrderItem) => (o.rerunTests ?? []).some((t) => i.testIds.includes(t))
const isUrgent = (o: OrderExt) => o.priority === 'urgent' || o.items.some((i) => i.urgent)
const PENDING_STATES = ['pending', 'collected', 'received']

function bucketOf(o: OrderExt): 'pending' | 'partial' | 'completed' | null {
  const items = workItems(o)
  if (!items.length) return null
  const done = items.filter((i) => i.status === 'approved').length
  if (done === items.length) return 'completed'
  return done > 0 ? 'partial' : 'pending'
}

const COLUMN_OPTIONS = [
  { value: 'barcode', label: 'Barcode' },
  { value: 'referral', label: 'Referral' },
  { value: 'dept', label: 'Department' },
  { value: 'report', label: 'Report status' },
  { value: 'assigned', label: 'Assigned to' },
]

function presetRange(p: Preset): [Dayjs, Dayjs] {
  const now = dayjs()
  if (p === 'yesterday') return [now.subtract(1, 'day').startOf('day'), now.subtract(1, 'day').endOf('day')]
  if (p === '7d') return [now.subtract(6, 'day').startOf('day'), now.endOf('day')]
  if (p === '30d') return [now.subtract(29, 'day').startOf('day'), now.endOf('day')]
  return [now.startOf('day'), now.endOf('day')]
}

export default function WorklistPage() {
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const { user, profile } = useAuth()
  const settings = useLabSettings()
  const maps = useCatalogueMaps()
  const qcBlock = useQcApprovalBlock()
  const [preset, setPreset] = useState<Preset>('30d')
  const [range, setRange] = useState<[Dayjs, Dayjs]>(presetRange('30d'))
  const [view, setView] = useState<View>('patient')
  const [ptab, setPtab] = useState<PTab>('pending')
  const [ttab, setTtab] = useState<TTab>('pending')
  const [dept, setDept] = useState('')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [cols, setCols] = useState<string[]>(['barcode', 'referral', 'dept', 'report', 'assigned'])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [basis, setBasis] = useState<Basis>('registration')
  const [pickStart, setPickStart] = useState<Dayjs | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [holdOpen, setHoldOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)

  const scope = useBranchScope()
  const { data: rawData, loading } = useLiveQuery<OrderExt>(
    query(
      col<OrderExt>(paths.orders),
      ...scope.constraints,
      where(BASIS_FIELD[basis], '>=', Timestamp.fromDate(range[0].toDate())),
      where(BASIS_FIELD[basis], '<=', Timestamp.fromDate(range[1].toDate())),
      orderBy(BASIS_FIELD[basis], 'desc'),
    ),
    [range[0].valueOf(), range[1].valueOf(), scope.key, basis],
  )
  const { data: staff } = useLiveQuery<UserProfile>(col<UserProfile>(paths.users), [])
  const assignees = useMemo(() => staff.filter((u) => u.active && ['technician', 'doctor', 'manager', 'labAdmin', 'admin'].includes(u.role) && (u.allBranches || (u.branchIds ?? ['main']).includes(scope.branchId))), [staff, scope.branchId])
  // Imaging lines (every test has a radiology modality) belong to the Radiology worklist.
  const accOn = settings.accession?.enabled !== false
  const data = useMemo(
    () =>
      rawData.map((o) => ({
        ...o,
        // Radiology lines and billing-only services never appear in the pathology worklist.
        items: o.items.filter(
          (i) =>
            // Flabs: with accession on, a test is not on the worklist until its sample is received.
            (!accOn || i.isCharge || !['pending', 'collected'].includes(i.status)) &&
            !i.onlyBilling &&
            !(i.testIds.length > 0 && i.testIds.every((t) => worklistFor(maps.testById.get(t)) === 'radiology' || !needsResultEntry(maps.testById.get(t)))),
        ),
      })),
    [rawData, maps.testById, accOn],
  )

  const deptOf = (item: OrderItem) =>
    [...new Set(item.testIds.map((t) => maps.departmentById.get(maps.testById.get(t)?.departmentId ?? '')?.name).filter(Boolean))] as string[]
  const itemInDept = (i: OrderItem) =>
    !dept || i.testIds.some((t) => maps.testById.get(t)?.departmentId === dept)

  const q = search.trim().toLowerCase()
  // Search by phone or UHID: look the patient up, then match their bills by patientId.
  const [matchedPatients, setMatchedPatients] = useState<Set<string>>(new Set())
  useEffect(() => {
    const term = search.trim()
    if (term.length < 3) {
      setMatchedPatients(new Set())
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const ids = new Set<string>()
        const upper = term.toUpperCase()
        const [byPhone, byUhid] = await Promise.all([
          /\d{3,}/.test(term) ? getDocs(query(col<Patient>(paths.patients), where('phone', '>=', term), where('phone', '<=', term + '\uf8ff'), limit(25))) : null,
          getDocs(query(col<Patient>(paths.patients), where('uhid', '>=', upper), where('uhid', '<=', upper + '\uf8ff'), limit(25))),
        ])
        byPhone?.docs.forEach((d) => ids.add(d.id))
        byUhid.docs.forEach((d) => ids.add(d.id))
        if (!cancelled) setMatchedPatients(ids)
      } catch {
        if (!cancelled) setMatchedPatients(new Set())
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [search])
  const visible = useMemo(() => {
    const f = filters
    const rows = data.filter((o) => {
      if (o.deleted) return false
      const items = liveItems(o)
      if (q && !(o.patientName.toLowerCase().includes(q) || o.billNo.toLowerCase().includes(q) || o.barcode.toLowerCase().includes(q) || o.patientNo.toLowerCase().includes(q) || (o.uhid ?? '').toLowerCase().includes(q) || matchedPatients.has(o.patientId) || items.some((i) => i.name.toLowerCase().includes(q)))) return false
      if (f.urgent && !items.some((i) => i.urgent)) return false
      if (f.tests.length && !items.some((i) => i.kind === 'test' && f.tests.includes(i.refId))) return false
      if (f.packages.length && !items.some((i) => i.kind === 'package' && f.packages.includes(i.refId))) return false
      if (f.referrer && !(o.referrerName || 'Self').toLowerCase().includes(f.referrer.toLowerCase())) return false
      if (f.b2b && !(o.b2bCentreName || o.b2bCentreId || '').toLowerCase().includes(f.b2b.toLowerCase())) return false
      if (f.centre && !(o.collectionCentreName || o.collectionCentreId || '').toLowerCase().includes(f.centre.toLowerCase())) return false
      if (f.collectedAt && o.collectionType !== f.collectedAt) return false
      if (f.who === 'self' && (o.referrerName || 'Self').toLowerCase() !== 'self') return false
      if (f.who === 'referred' && (o.referrerName || 'Self').toLowerCase() === 'self') return false
      if (f.machineValue && !o.hasMachineValue) return false
      if (f.assigned === 'me' && o.assignedToId !== (user?.uid ?? profile?.uid)) return false
      if (f.assigned === 'unassigned' && o.assignedToId) return false
      if (dept && !items.some(itemInDept)) return false
      return true
    })
    const sorted = f.billSort === 'asc' ? [...rows].reverse() : rows
    // Urgent bills first (stable within each group).
    return [...sorted].sort((a, b) => Number(isUrgent(b)) - Number(isUrgent(a)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, q, filters, dept, maps.testById, matchedPatients])

  const now = Date.now()
  const startToday = dayjs().startOf('day').valueOf()
  const testClass = (o: OrderExt, i: OrderItem): TTab[] => {
    const c: TTab[] = ['all']
    if (i.status === 'rejected') c.push('rejected')
    if (PENDING_STATES.includes(i.status)) {
      c.push('pending')
      // Flabs: Past Pending = tests still pending whose bill date is before today.
      const created = (tsToDate(o.billDate) ?? tsToDate(o.createdAt))?.getTime() ?? now
      if (created < startToday) c.push('pastPending')
    }
    if (i.status === 'hold') c.push('hold')
    if (i.status === 'entered') c.push('verify')
    if (i.status === 'approved') c.push('complete')
    if ((o.rerunTests ?? []).some((t) => i.testIds.includes(t))) c.push('rerun')
    if (i.status === 'approved' && (i.provisional || o.reportStatus === 'provisional')) c.push('provisional')
    return c
  }

  const testRowsAll: TestRow[] = useMemo(
    () =>
      visible.flatMap((o) =>
        liveItems(o)
          .filter((i) => itemInDept(i))
          .filter((i) => !filters.urgent || i.urgent)
          .map((item) => ({ key: `${o.id}-${item.lineId}`, order: o, item })),
      ).sort((a, b) => Number(!!b.item.urgent) - Number(!!a.item.urgent)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, dept, filters.urgent, maps.testById],
  )
  const tcounts = useMemo(() => {
    const c: Record<TTab, number> = { all: 0, pending: 0, pastPending: 0, rejected: 0, hold: 0, rerun: 0, verify: 0, provisional: 0, complete: 0 }
    testRowsAll.forEach((r) => testClass(r.order, r.item).forEach((k) => c[k]++))
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testRowsAll])

  const pcounts = useMemo(() => {
    const c: Record<PTab, number> = { all: 0, pending: 0, partial: 0, completed: 0, delivered: 0 }
    visible.forEach((o) => {
      const b = bucketOf(o)
      if (!b) return
      c.all++
      if (b === 'completed') c.completed++
      else if (b === 'partial') c.partial++
      else c.pending++
      if (o.dispatched) c.delivered++
    })
    return c
  }, [visible])

  const orders = useMemo(
    () =>
      visible.filter((o) => {
        const b = bucketOf(o)
        if (!b) return false
        if (ptab === 'all') return true
        if (ptab === 'delivered') return !!o.dispatched
        return b === ptab
      }),
    [visible, ptab],
  )
  const testRows = useMemo(
    () => testRowsAll.filter((r) => testClass(r.order, r.item).includes(ttab)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [testRowsAll, ttab],
  )

  // Hand the current order list to result entry for Previous / Next.
  const idList = useMemo(() => (view === 'patient' ? orders.map((o) => o.id) : [...new Set(testRows.map((r) => r.order.id))]), [view, orders, testRows])
  useEffect(() => saveWorklistIds(idList), [idList])
  useEffect(() => setSelected([]), [view, ptab, ttab])

  const canApprove = can(profile, 'results.approve')
  const uid = user?.uid ?? profile?.uid ?? ''
  const who = { uid, name: profile?.name ?? '' }

  const orderIdsSelected = view === 'patient' ? selected : [...new Set(selected.map((k) => testRows.find((r) => r.key === k)?.order.id).filter(Boolean) as string[])]

  const bulkApprove = async () => {
    setBusy(true)
    try {
      const ctx = { settings, uid, qcBlock: (id: string) => qcBlock(id) }
      const plan: { order: OrderExt; entries: ApprovalEntry[]; statusOf: (t: string) => string | undefined; autoOf: (t: string) => boolean }[] = []
      const skipped: string[] = []
      let flagged = 0
      for (const id of orderIdsSelected) {
        const o = data.find((x) => x.id === id)
        if (!o) continue
        const rs = await loadResults(id)
        const byTest = new Map(rs.map((r) => [r.testId, r]))
        const entries: ApprovalEntry[] = []
        const seen = new Set<string>()
        workItems(o).forEach((i) =>
          i.testIds.forEach((tid) => {
            const t = maps.testById.get(tid)
            const r = byTest.get(tid)
            if (!t || seen.has(tid) || !r || r.status !== 'entered') return
            seen.add(tid)
            const e: ApprovalEntry = { test: t, values: r.values ?? {}, comment: r.comment ?? '', result: r, hadDraft: false }
            const c = checkApprovable(e, ctx)
            if (c.reason) skipped.push(`${o.billNo} ${t.name}: ${c.reason}`)
            else {
              entries.push(e)
              flagged += c.flags.length
            }
          }),
        )
        if (entries.length) plan.push({ order: o, entries, statusOf: (t) => byTest.get(t)?.status, autoOf: (t) => byTest.get(t)?.status === 'approved' && !!byTest.get(t)?.autoVerified })
      }
      const total = plan.reduce((s, p) => s + p.entries.length, 0)
      if (!total) {
        modal.info({ title: 'Nothing to approve', content: skipped.length ? skipped.map((s) => <div key={s}>{s}</div>) : 'No test in the selection is waiting for verification.' })
        return
      }
      modal.confirm({
        title: `Approve ${total} test(s) on ${plan.length} bill(s)?`,
        width: 560,
        content: (
          <div>
            {flagged > 0 && <p>{flagged} abnormal or critical value(s) are included. Review them before releasing.</p>}
            {skipped.length > 0 && (
              <div>
                <b>Skipped ({skipped.length})</b>
                {skipped.slice(0, 12).map((s) => <div key={s} className="wl-muted">{s}</div>)}
              </div>
            )}
          </div>
        ),
        okText: 'Approve',
        onOk: async () => {
          for (const p of plan) await approveEntries(p.order, p.entries, p.statusOf, who, settings, p.autoOf)
          setSelected([])
          message.success(`Approved ${total} test(s)`)
        },
      })
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Bulk approve failed')
    } finally {
      setBusy(false)
    }
  }

  const canEnter = can(profile, 'results.enter')
  const canSend = can(profile, 'reports.send')
  const isAdmin = can(profile, 'settings.manage')
  const selectedOrders = orderIdsSelected.map((id) => data.find((x) => x.id === id)).filter(Boolean) as OrderExt[]

  // Bulk hold: every open test on the selected bills (patient-wise) or the selected test lines (test-wise).
  const bulkHold = async (reason: string) => {
    setBusy(true)
    try {
      const wanted = new Map<string, Set<string>>()
      if (view === 'patient') selectedOrders.forEach((o) => wanted.set(o.id, new Set(workItems(o).flatMap((i) => i.testIds))))
      else
        selected.forEach((k) => {
          const r = testRows.find((x) => x.key === k)
          if (r) wanted.set(r.order.id, new Set([...(wanted.get(r.order.id) ?? []), ...r.item.testIds]))
        })
      let n = 0
      for (const [orderId, tids] of wanted) {
        const o = data.find((x) => x.id === orderId)
        if (!o) continue
        const rs = await loadResults(orderId)
        const byTest = new Map(rs.map((r) => [r.testId, r]))
        const over: Record<string, string> = {}
        for (const tid of tids) {
          const t = maps.testById.get(tid)
          const r = byTest.get(tid)
          if (!t || isRadiologyTest(t) || ['approved', 'rejected', 'hold'].includes(r?.status ?? '')) continue
          await writeResult(orderId, tid, {
            ...(r ? {} : { id: tid, orderId, testId: tid, testName: t.name, values: {}, comment: '', enteredBy: '', approvedBy: '', approvedByName: '' }),
            status: 'hold',
            holdReason: reason,
            heldBy: uid,
            heldAt: Date.now(),
            updatedAt: serverTimestamp(),
          })
          await addVersion(orderId, tid, 'hold', r?.values ?? {}, who, { reason })
          over[tid] = 'hold'
          n++
        }
        if (Object.keys(over).length) await syncItems(o, (t) => over[t] ?? byTest.get(t)?.status)
      }
      message.success(n ? `Put ${n} test(s) on hold` : 'Nothing to hold: tests already approved, rejected or on hold are skipped')
      setHoldOpen(false)
      setSelected([])
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Bulk hold failed')
    } finally {
      setBusy(false)
    }
  }
  // Bulk print: opens each report's print view (browsers may ask to allow pop-ups).
  const bulkPrint = () => {
    const list = selectedOrders.filter((o) => o.reportStatus !== 'pending')
    if (!list.length) return message.info('None of the selected bills has an approved result to print yet.')
    if (list.length > 10) message.warning('Printing the first 10 reports. Print the rest in another batch.')
    list.slice(0, 10).forEach((o) => window.open(`/report/${o.id}?print=1`, '_blank'))
  }
  const assign = async (o: OrderExt, uidPicked?: string) => {
    const u = assignees.find((x) => x.uid === uidPicked)
    try {
      await updateDoc(docRef(paths.orders, o.id), { assignedToId: u?.uid ?? '', assignedToName: u?.name ?? '' })
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not assign')
    }
  }
  const assignCell = (o: OrderExt) =>
    canEnter ? (
      <Select
        size="small"
        allowClear
        aria-label={`Assign ${o.billNo}`}
        placeholder="Unassigned"
        style={{ width: 150 }}
        value={o.assignedToId || undefined}
        onChange={(v) => assign(o, v)}
        options={assignees.map((u) => ({ value: u.uid, label: u.name }))}
      />
    ) : (
      o.assignedToName || '-'
    )
  // Batch entry: one test across patients. Rows are bills whose line for that test still needs a result.
  const batchRows = useMemo(() => {
    const open = testRowsAll.filter((r) => ['pending', 'collected', 'received', 'entered', 'hold'].includes(r.item.status) && (settings.accession?.enabled === false || ['received', 'entered', 'hold'].includes(r.item.status)))
    return (testId: string) => open.filter((r) => r.item.testIds.includes(testId)).map((r) => ({ order: r.order, lineId: r.item.lineId }))
  }, [testRowsAll, settings.accession?.enabled])
  const batchTests = useMemo(() => {
    const ids = new Set<string>()
    testRowsAll.forEach((r) => {
      if (['pending', 'collected', 'received', 'entered', 'hold'].includes(r.item.status)) r.item.testIds.forEach((t) => ids.add(t))
    })
    return [...ids].map((id) => maps.testById.get(id)).filter((t) => t && hasParameterGrid(t) && !t.onlyBilling && t.parameters.length) as import('../../types').Test[]
  }, [testRowsAll, maps.testById])

  const exportCsv = () => {
    if (view === 'patient')
      downloadCsv(`worklist-patients-${dayjs().format('YYYYMMDD')}.csv`, [
        ['Bill date', 'Bill no', 'Barcode', 'Patient', 'Referral', 'Tests', 'Report status'],
        ...orders.map((o) => [fmtDateTime(o.createdAt), o.billNo, o.barcode, o.patientName, o.referrerName, workItems(o).map((i) => `${i.name} (${i.status})`).join('; '), o.reportStatus]),
      ])
    else
      downloadCsv(`worklist-tests-${dayjs().format('YYYYMMDD')}.csv`, [
        ['Bill date', 'Bill no', 'Barcode', 'Patient', 'Referral', 'Test', 'Department', 'Status'],
        ...testRows.map((r) => [fmtDateTime(r.order.createdAt), r.order.billNo, r.order.barcode, r.order.patientName, r.order.referrerName, r.item.name, deptOf(r.item).join('; '), ITEM_LABEL[lineStatusKey(r.item, !!r.order.dispatched, isRerun(r.order, r.item))]]),
      ])
  }

  const itemChip = (i: OrderItem, o: OrderExt) => {
    const k = lineStatusKey(i, !!o.dispatched, isRerun(o, i))
    return (
      <StatusChip key={i.lineId} variant={ITEM_VARIANT[k] ?? 'neutral'}>
        {i.name}
        {i.urgent ? ' (urgent)' : ''}: {ITEM_LABEL[k] ?? k}
      </StatusChip>
    )
  }
  const actionBtn = (o: OrderExt, done: boolean) => (
    <Button variant={done ? 'default' : 'primary'} onClick={() => navigate(`/results/${o.id}`)}>
      {done ? 'Check results' : 'Enter results'}
    </Button>
  )
  const patientCell = (o: OrderExt) => (
    <div>
      <Link className="wl-link" to={`/results/${o.id}`}>{o.patientName}</Link>
      <div className="wl-muted">{o.ageValue} {o.ageUnit}{o.ageValue === 1 ? '' : 's'} / {o.gender} / {displayId(o, settings.registration.idDisplay)}</div>
    </div>
  )
  const tatCell = (o: OrderExt) => {
    const t = tatDue(o, settings.tat?.urgentTatPercent)
    return t ? <span style={t.overdue ? { color: 'var(--c-urgent, #b91c1c)', fontWeight: 600 } : undefined}>{t.text}{t.overdue ? ' (late)' : ''}</span> : '-'
  }
  const optional = <T,>(key: string, c: ColumnsType<T>[number]): ColumnsType<T> => (cols.includes(key) ? [c] : [])

  const patientCols: ColumnsType<OrderExt> = [
    { title: 'Bill date', width: 150, render: (_, o) => fmtDateTime(o.createdAt) },
    { title: 'Bill no', dataIndex: 'billNo', width: 110 },
    ...optional<OrderExt>('barcode', { title: 'Barcode', dataIndex: 'barcode', width: 100 }),
    { title: 'Patient', render: (_, o) => patientCell(o) },
    ...optional<OrderExt>('referral', { title: 'Referral', render: (_, o) => o.referrerName || 'Self' }),
    ...optional<OrderExt>('dept', { title: 'Department', render: (_, o) => [...new Set(workItems(o).flatMap(deptOf))].join(', ') }),
    ...(showTatIn(settings, 'enterVerify') ? [{ title: 'TAT', width: 140, render: (_: unknown, o: OrderExt) => tatCell(o) }] : []),
    ...optional<OrderExt>('assigned', { title: 'Assigned to', width: 170, render: (_, o) => assignCell(o) }),
    { title: 'Tests', render: (_, o) => <div className="wl-tests">{workItems(o).map((i) => itemChip(i, o))}</div> },
    ...optional<OrderExt>('report', { title: 'Report', width: 120, render: (_, o) => <StatusChip variant={REPORT_VARIANT[o.reportStatus]}>{o.reportStatus}</StatusChip> }),
    { title: 'Action', width: 150, render: (_, o) => actionBtn(o, bucketOf(o) === 'completed') },
  ]
  const testCols: ColumnsType<TestRow> = [
    { title: 'Bill date', width: 150, render: (_, r) => fmtDateTime(r.order.createdAt) },
    { title: 'Bill no', width: 110, render: (_, r) => r.order.billNo },
    ...optional<TestRow>('barcode', { title: 'Barcode', width: 100, render: (_, r) => r.order.barcode }),
    { title: 'Patient', render: (_, r) => patientCell(r.order) },
    ...optional<TestRow>('referral', { title: 'Referral', render: (_, r) => r.order.referrerName || 'Self' }),
    { title: 'Test', render: (_, r) => r.item.name },
    ...optional<TestRow>('dept', { title: 'Department', render: (_, r) => deptOf(r.item).join(', ') }),
    ...(showTatIn(settings, 'enterVerify') ? [{ title: 'TAT', width: 140, render: (_: unknown, r: TestRow) => tatCell(r.order) }] : []),
    ...optional<TestRow>('assigned', { title: 'Assigned to', width: 170, render: (_, r) => assignCell(r.order) }),
    { title: 'Status', width: 180, render: (_, r) => itemChip(r.item, r.order) },
    ...optional<TestRow>('report', { title: 'Report', width: 120, render: (_, r) => <StatusChip variant={REPORT_VARIANT[r.order.reportStatus]}>{r.order.reportStatus}</StatusChip> }),
    { title: 'Action', width: 150, render: (_, r) => actionBtn(r.order, r.item.status === 'approved') },
  ]

  const activeFilterCount = Object.entries(filters).filter(([k, v]) => (k === 'billSort' ? v !== 'desc' : Array.isArray(v) ? v.length : !!v)).length

  const PTABS: { value: PTab; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'partial', label: 'Partial' },
    { value: 'completed', label: 'Completed' },
    { value: 'delivered', label: 'Delivered' },
  ]
  const TTABS: { value: TTab; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'pastPending', label: 'Past pending' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'hold', label: 'Hold' },
    { value: 'rerun', label: 'Re-run' },
    { value: 'verify', label: 'Need Verification' },
    { value: 'provisional', label: 'Provisional' },
    { value: 'complete', label: 'Complete' },
  ]
  const setF = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }))
  const empty = view === 'patient' ? orders.length === 0 : testRows.length === 0

  return (
    <div>
      <PageHeader
        title="Enter and verify"
        subtitle="Pathology worklist"
        actions={
          <>
            {view === 'test' && canEnter && (
              <Button icon={<TableOutlined />} onClick={() => setBatchOpen(true)} disabled={!batchTests.length}>Batch entry</Button>
            )}
            {isAdmin && <Button icon={<ThunderboltOutlined />} onClick={() => setRulesOpen(true)}>Auto-verify rules</Button>}
            <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export</Button>
            {canApprove && (
              <Button variant="primary" icon={<CheckOutlined />} disabled={!selected.length || busy} onClick={bulkApprove}>
                Approve selected
              </Button>
            )}
          </>
        }
      />
      <div className="wl-toolbar">
        <Segmented<View>
          aria-label="Worklist view"
          value={view}
          onChange={setView}
          options={[{ value: 'patient', label: 'Patient-wise' }, { value: 'test', label: 'Test-wise' }]}
        />
        <Segmented<Preset>
          aria-label="Date range"
          value={preset}
          onChange={(p) => {
            setPreset(p)
            if (p !== 'custom') setRange(presetRange(p))
          }}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'yesterday', label: 'Yesterday' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        <Select
          aria-label="Date basis"
          style={{ width: 190 }}
          value={basis}
          onChange={setBasis}
          options={[
            { value: 'registration', label: 'Registration date' },
            { value: 'accession', label: 'Accession (received) date' },
            { value: 'report', label: 'Report date' },
          ]}
        />
        {preset === 'custom' && (
          <DatePicker.RangePicker
            aria-label="Custom date range"
            value={range}
            allowClear={false}
            onChange={(v) => v && v[0] && v[1] && setRange([v[0].startOf('day'), v[1].endOf('day')])}
            // The range can span about a month at most: once a start date is picked, dates beyond 30 days from it are greyed out.
            onCalendarChange={(v) => setPickStart(v?.[0] && !v?.[1] ? v[0] : null)}
            disabledDate={(d) => !!pickStart && Math.abs(d.diff(pickStart, 'day')) > 30}
          />
        )}
      </div>
      <div className="wl-toolbar">
        <Input.Search allowClear aria-label="Search worklist" placeholder="Search patient, bill, barcode, UHID, phone, test" className="search-wide search-wide--long" onChange={(e) => setSearch(e.target.value)} />
        <Select
          allowClear
          aria-label="Department"
          placeholder="All departments"
          style={{ width: 200 }}
          value={dept || undefined}
          onChange={(v) => setDept(v ?? '')}
          options={maps.departments.map((d) => ({ value: d.id, label: d.name }))}
        />
        <Button icon={<FilterOutlined />} onClick={() => setFiltersOpen(true)}>
          Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
        </Button>
        <Popover
          trigger="click"
          placement="bottomLeft"
          content={<Checkbox.Group value={cols} onChange={(v) => setCols(v as string[])} options={COLUMN_OPTIONS} style={{ display: 'grid', gap: 8 }} />}
        >
          <Button icon={<TableOutlined />} aria-label="Choose columns">Columns</Button>
        </Popover>
        <span className="wl-toolbar__spacer" />
        <label className="wl-muted">
          <Switch size="small" checked={filters.urgent} onChange={(v) => setF('urgent', v)} aria-label="Urgent only" /> Urgent only
        </label>
      </div>

      <div style={{ marginBottom: 'var(--s-4)' }}>
        {view === 'patient' ? (
          <Segmented<PTab> aria-label="Patient-wise status" value={ptab} onChange={setPtab} options={PTABS.map((t) => ({ ...t, count: pcounts[t.value] }))} />
        ) : (
          <Segmented<TTab> aria-label="Test-wise status" value={ttab} onChange={setTtab} options={TTABS.map((t) => ({ ...t, count: tcounts[t.value] }))} />
        )}
      </div>

      {selected.length > 0 && (
        <div className="wl-bulk" role="status">
          <b>{selected.length} selected</b>
          {canEnter && <Button icon={<PauseCircleOutlined />} disabled={busy} onClick={() => (settings.reportEntry.holdReasonModal ? setHoldOpen(true) : void bulkHold(''))}>Hold</Button>}
          <Button icon={<PrinterOutlined />} onClick={bulkPrint}>Print reports</Button>
          <Button icon={<FileTextOutlined />} onClick={() => setSheetOpen(true)}>Worksheet</Button>
          {canSend && <Button icon={<SendOutlined />} onClick={() => setSendOpen(true)}>Send reports</Button>}
          <Button variant="text" onClick={() => setSelected([])}>Clear</Button>
        </div>
      )}

      <Card padding={0}>
        {loading ? (
          <SkeletonRows rows={8} columns={6} />
        ) : empty ? (
          <EmptyState title="Nothing in this view" description="Change the tab, date range or filters to see other work." />
        ) : view === 'patient' ? (
          <Table<OrderExt>
            rowKey="id"
            columns={patientCols}
            dataSource={orders}
            rowClassName={(o) => (isUrgent(o) ? 'wl-row--urgent' : '')}
            rowSelection={canApprove ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) } : undefined}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ x: 'max-content' }}
          />
        ) : (
          <Table<TestRow>
            rowKey="key"
            columns={testCols}
            dataSource={testRows}
            rowClassName={(r) => (r.item.urgent || r.order.priority === 'urgent' ? 'wl-row--urgent' : '')}
            rowSelection={canApprove ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) } : undefined}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ x: 'max-content' }}
          />
        )}
      </Card>

      <Drawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        width={380}
        footer={<Button onClick={() => setFilters(NO_FILTERS)}>Reset filters</Button>}
      >
        <div className="re-field"><label htmlFor="f-tests">Test</label>
          <Select id="f-tests" mode="multiple" allowClear value={filters.tests} onChange={(v) => setF('tests', v)} optionFilterProp="label" options={maps.tests.map((t) => ({ value: t.id, label: t.name }))} /></div>
        <div className="re-field"><label htmlFor="f-pk">Package</label>
          <Select id="f-pk" mode="multiple" allowClear value={filters.packages} onChange={(v) => setF('packages', v)} optionFilterProp="label" options={maps.packages.map((t) => ({ value: t.id, label: t.name }))} /></div>
        <div className="re-field"><label htmlFor="f-ref">Referral doctor or hospital</label>
          <Input id="f-ref" value={filters.referrer} onChange={(e) => setF('referrer', e.target.value)} /></div>
        <div className="re-field"><label htmlFor="f-b2b">B2B lab</label>
          <Input id="f-b2b" value={filters.b2b} onChange={(e) => setF('b2b', e.target.value)} /></div>
        <div className="re-field"><label htmlFor="f-cc">Collection centre</label>
          <Input id="f-cc" value={filters.centre} onChange={(e) => setF('centre', e.target.value)} /></div>
        <div className="re-field"><label htmlFor="f-ca">Collected at</label>
          <Select id="f-ca" value={filters.collectedAt} onChange={(v) => setF('collectedAt', v)} options={[{ value: '', label: 'Anywhere' }, { value: 'lab', label: 'Lab' }, { value: 'home', label: 'Home' }]} /></div>
        <div className="re-field"><label htmlFor="f-who">Patient type</label>
          <Select id="f-who" value={filters.who} onChange={(v) => setF('who', v)} options={[{ value: '', label: 'All' }, { value: 'self', label: 'Self / walk-in' }, { value: 'referred', label: 'Referred' }]} /></div>
        <div className="re-field"><label htmlFor="f-sort">Bill order</label>
          <Select id="f-sort" value={filters.billSort} onChange={(v) => setF('billSort', v)} options={[{ value: 'desc', label: 'Newest first' }, { value: 'asc', label: 'Oldest first' }]} /></div>
        <div className="re-field"><label htmlFor="f-asg">Assigned to</label>
          <Select id="f-asg" value={filters.assigned} onChange={(v) => setF('assigned', v)} options={[{ value: '', label: 'Anyone' }, { value: 'me', label: 'Me' }, { value: 'unassigned', label: 'Unassigned' }]} /></div>
        <div className="re-field"><Checkbox checked={filters.urgent} onChange={(e) => setF('urgent', e.target.checked)}>Urgent only</Checkbox></div>
        <div className="re-field"><Checkbox checked={filters.machineValue} onChange={(e) => setF('machineValue', e.target.checked)}>Has machine value</Checkbox></div>
      </Drawer>
      <ReasonModal
        open={holdOpen}
        title={`Put ${selected.length} selected on hold`}
        kind="hold"
        required={settings.reportEntry.holdReasonModal}
        okText="Hold"
        onCancel={() => setHoldOpen(false)}
        onOk={(r) => bulkHold(r)}
      />
      <BatchEntryModal open={batchOpen} tests={batchTests} rowsFor={batchRows} who={who} onClose={() => setBatchOpen(false)} onSaved={() => undefined} />
      <AutoVerifyRulesModal open={rulesOpen} canEdit={isAdmin} who={who.name} onClose={() => setRulesOpen(false)} />
      <BulkSendModal open={sendOpen} onClose={() => setSendOpen(false)} orders={selectedOrders.map((o) => ({ id: o.id, billNo: o.billNo, patientName: o.patientName }))} />
      <WorksheetModal open={sheetOpen} onClose={() => setSheetOpen(false)} orders={selectedOrders as never} />
    </div>
  )
}
