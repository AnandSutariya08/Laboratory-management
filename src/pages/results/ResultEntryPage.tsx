import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { hasParameterGrid } from '../catalogue/behaviour'
import { formulaDecimals, nablPrompts, showPreviousResults } from '../../features/settings/lib'
import { withRangeSnapshot } from '../catalogue/behaviour'
import FlagSuggestions from '../ai/FlagSuggestions'
import { useQcApprovalBlock } from '../../features/qc/lib/qcBlock'
import { useNavigate, useParams } from 'react-router-dom'
import { App, Checkbox, Drawer, Dropdown, Modal, Popover, Select } from 'antd'
import {
  ArrowLeftOutlined,
  CheckOutlined,
  EyeOutlined,
  LeftOutlined,
  MoreOutlined,
  NotificationOutlined,
  PrinterOutlined,
  QuestionCircleOutlined,
  RightOutlined,
  RobotOutlined,
  SaveOutlined,
  SendOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { getDoc, getDocs, query, serverTimestamp, updateDoc, where } from 'firebase/firestore'
import type { Timestamp } from 'firebase/firestore'
import { col, docRef, paths, resultsCol } from '../../lib/db'
import { ageDaysAtCollection, applyFormulas, conditionsOf, deltaCheck, emptyValue, externalValues, flagValue, formulaCycle, hasAnyValue, rangeTextFor, resolveRange } from '../../lib/results'
import { formatINR } from '../../lib/money'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { displayId } from '../../lib/billing'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { can, useAuth } from '../../auth/AuthProvider'
import { interpretResult } from '../../lib/ai'
import { useTodayQcStatus } from '../../features/qc/lib/useQcStatus'
import InterpretationDrawer from '../../components/ai/InterpretationDrawer'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { FieldGrid, FormSection } from '../../design/FormLayout'
import { Glass } from '../../design/Glass'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonCard } from '../../design/Skeletons'
import type { Order, Parameter, Test, TestResult } from '../../types'
import {
  ageText,
  fmtDateTime,
  genderText,
  loadWorklistIds,
  RERUN_REASONS,
  REPORT_VARIANT,
  tsToDate,
  workItemsOf,
} from '../../components/results/common'
import type { OrderExt, ResultExt, Values } from '../../components/results/types'
import {
  addVersion,
  approveEntries,
  checkApprovable,
  cleanValues,
  logActivity,
  MAX_SIGNATORIES,
  recordCriticalAlert,
  recordRangeEdits,
  syncItems,
  writeResult,
  type ApprovalEntry,
  type ApprovalWarning,
  type Flag,
} from '../../components/results/resultOps'
import CollectionPhotos from '../../components/results/CollectionPhotos'
import { useResultLock } from '../../components/results/useResultLock'
import TestCard, { type Prev } from '../../components/results/TestCard'
import VersionsDrawer, { type VersionRow } from '../../components/results/VersionsDrawer'
import { CriticalAckModal, IssueModal, MachineValueModal, RangeEditModal, ReasonModal, RejectModal, TextTemplateModal } from '../../components/results/Dialogs'
import { machineRuns } from '../../components/results/types'
import '../../components/results/results.css'

type Status = ResultExt['status']
interface Draft {
  values: Values
  comment: string
  paramComments: Record<string, string>
}
type Speed = 'fast' | 'balanced' | 'thorough'

// Keyed by bill: drafts, release picks and amendments never leak from one bill to the next.
export default function ResultEntryPage() {
  const { orderId = '' } = useParams()
  return <ResultEntry key={orderId} />
}

function ResultEntry() {
  const { orderId = '' } = useParams()
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const { user, profile } = useAuth()
  const settings = useLabSettings()
  const re = settings.reportEntry
  const qcFor = useTodayQcStatus()
  const qcBlock = useQcApprovalBlock()
  const showPrev = showPreviousResults(settings)
  const prompts = nablPrompts(settings)
  const maps = useCatalogueMaps()
  const { data: orderRaw, loading } = useLiveDoc<OrderExt>(orderId ? docRef(paths.orders, orderId) : null, [orderId])
  const order = orderRaw
  const { data: results } = useLiveQuery<ResultExt>(orderId ? resultsCol(orderId) : null, [orderId])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [prevMap, setPrevMap] = useState<Record<string, Prev[]>>({})
  const [versionsFor, setVersionsFor] = useState<Test | null>(null)
  const [busy, setBusy] = useState(false)
  const [interpFor, setInterpFor] = useState<Test | null>(null)
  const [interpBusy, setInterpBusy] = useState(false)
  const [interpError, setInterpError] = useState<string | null>(null)
  const [speed, setSpeed] = useState<Speed>('fast')
  const [abnormalOnly, setAbnormalOnly] = useState(false)
  const [deptFilter, setDeptFilter] = useState('')
  const [testFilter, setTestFilter] = useState<string[]>([])
  const [selParams, setSelParams] = useState<Record<string, string[]>>({})
  const [moreOpen, setMoreOpen] = useState(false)
  // Dialog targets
  const [rerunFor, setRerunFor] = useState<Test | null>(null)
  const [holdFor, setHoldFor] = useState<Test | null>(null)
  const [rejectFor, setRejectFor] = useState<Test | null>(null)
  const [issueFor, setIssueFor] = useState<Test | null>(null)
  const [commentFor, setCommentFor] = useState<Test | null>(null)
  const [machineFor, setMachineFor] = useState<Test | null>(null)
  const [ackFor, setAckFor] = useState<Test | null>(null)
  const [sendBackFor, setSendBackFor] = useState<Test | null>(null)
  // Approved tests opened for amendment (test id -> reason), and which release type is picked per test.
  const [amend, setAmend] = useState<Record<string, string>>({})
  const [amendFor, setAmendFor] = useState<{ test: Test; restore?: VersionRow } | null>(null)
  const [restoredFrom, setRestoredFrom] = useState<Record<string, string>>({})
  const [relFor, setRelFor] = useState<{ test: Test; next: 'final' | 'provisional' } | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [rangeFor, setRangeFor] = useState<{ test: Test; param: Parameter } | null>(null)
  const [autoAt, setAutoAt] = useState<number | null>(null)

  const canApprove = can(profile, 'results.approve')
  const canUnapprove = can(profile, 'results.unapprove') || can(profile, 'results.amend')
  const canEnter = can(profile, 'results.enter')
  const aiOn = settings.aiEnabled && can(profile, 'ai.interpret')
  const resultById = useMemo(() => new Map(results.map((r) => [r.testId, r])), [results])
  // Age is taken on the day the sample was collected (exact when the patient has a date of birth).
  const [dob, setDob] = useState<string | undefined>()
  const ageDays = order ? ageDaysAtCollection(order, dob) : 0
  const condition = order?.patientCondition ?? ''
  const uid = user?.uid ?? profile?.uid ?? ''
  const who = { uid, name: profile?.name ?? '' }

  const accOn = settings.accession?.enabled !== false
  const tests = useMemo(() => {
    if (!order) return []
    const seen = new Set<string>()
    const out: Test[] = []
    workItemsOf(order, maps.testById)
      .forEach((i) =>
        i.testIds.forEach((tid) => {
          const t = maps.testById.get(tid)
          const rejectedHere = resultById.get(tid)?.status === 'rejected'
          if (i.status === 'rejected' && !rejectedHere) return
          // Flabs: with accession on, a test cannot be entered until its sample has been received.
          if (accOn && ['pending', 'collected'].includes(i.status) && !resultById.has(tid)) return
          // Imaging tests are reported from the Radiology worklist; billing-only services have no result.
          if (t && hasParameterGrid(t) && !t.onlyBilling && !seen.has(tid)) {
            seen.add(tid)
            out.push(t)
          }
        }),
      )
    // Catalogue order (stable for tests that share a position).
    return out.map((t, n) => ({ t, n })).sort((a, b) => (a.t.order ?? 1e9) - (b.t.order ?? 1e9) || a.n - b.n).map((x) => x.t)
  }, [order, maps.testById, resultById, accOn])

  // Previous approved results (up to 5 per test) for this patient, loaded once.
  const patientId = order?.patientId
  const branchId = order?.branchId || 'main'
  useEffect(() => {
    if (!patientId || !showPrev) return
    let cancelled = false
    ;(async () => {
      const snap = await getDocs(query(col<Order>(paths.orders), where('branchId', '==', branchId), where('patientId', '==', patientId)))
      const others = snap.docs
        .map((d) => ({ ...d.data(), id: d.id }))
        .filter((o) => o.id !== orderId && !o.deleted)
        .sort((a, b) => (tsToDate(b.createdAt)?.getTime() ?? 0) - (tsToDate(a.createdAt)?.getTime() ?? 0))
        .slice(0, 10)
      const found: Record<string, Prev[]> = {}
      for (const o of others) {
        const rs = await getDocs(resultsCol(o.id))
        rs.docs.forEach((d) => {
          const r = d.data() as TestResult
          if (r.status === 'approved' && (found[r.testId]?.length ?? 0) < 5)
            found[r.testId] = [...(found[r.testId] ?? []), { values: r.values, date: o.createdAt as Timestamp, billNo: o.billNo }]
        })
      }
      if (!cancelled) setPrevMap(found)
    })().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [patientId, orderId, branchId, showPrev])

  const dirtyIds = Object.keys(drafts)
  useEffect(() => {
    if (!dirtyIds.length) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirtyIds.length])

  // Worklist neighbours for Previous / Next.
  const ids = useMemo(() => loadWorklistIds(), [orderId])
  const idx = ids.indexOf(orderId)
  const prevId = idx > 0 ? ids[idx - 1] : null
  const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null

  // Date of birth for the exact age at collection.
  useEffect(() => {
    if (!patientId) return
    let cancelled = false
    getDoc(docRef<{ dob?: string }>(paths.patients, patientId))
      .then((snap) => !cancelled && setDob(snap.data()?.dob))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [patientId])

  // Re-run is blocked once the sample of this bill has been discarded.
  const { data: discards } = useLiveQuery<{ id: string }>(
    orderId ? query(col('sampleDiscards'), where('branchId', '==', branchId), where('orderIds', 'array-contains', orderId)) : null,
    [orderId, branchId],
  )
  const rerunBlocked = discards.length > 0 ? 'The sample for this bill has been discarded, so a re-run is not possible. Ask for a fresh sample instead.' : null

  // Conditions (pregnancy etc.) that any range of this bill's tests is written for.
  const conditions = useMemo(() => [...new Set(tests.flatMap((t) => conditionsOf(t.parameters)))], [tests])

  // Formula loops across the bill's tests: the parameters in a loop are left blank and a warning is shown.
  const cycle = useMemo(() => formulaCycle(tests.map((t) => ({ code: t.code, parameters: t.parameters }))), [tests])
  const cyclicKeys = (t: Test) => (cycle ? cycle.filter((n) => n.startsWith(`${t.code.toUpperCase()}.`)).map((n) => n.slice(t.code.length + 1)) : [])

  // Concurrent-edit warning: a short-lived marker per bill.
  const lock = useResultLock(orderId, canEnter && !!order, { uid, name: profile?.name ?? '' })

  // Values of every test with flags and formulas applied. Cross-test formulas read the other tests' values,
  // so the bill is computed in a few passes.
  const decimals = formulaDecimals(settings)
  const valuesMap = useMemo(() => {
    const out: Record<string, Values> = {}
    if (!order) return out
    const gender = order.gender
    const flagFor = (p: Parameter, raw: string, ov?: Values[string]['rangeOverride']) => flagValue(p, raw, ageDays, gender, condition, ov)
    const bases: Record<string, Values> = {}
    for (const t of tests) {
      const r = resultById.get(t.id)
      if (r?.status === 'approved' && !drafts[t.id] && !amend[t.id]) {
        out[t.id] = r.values ?? {}
        continue
      }
      // Until approval, flags follow the current age, sex, condition and range; descriptive parameters start from their default text.
      const base: Values = { ...(drafts[t.id]?.values ?? r?.values ?? {}) }
      for (const p of t.parameters) {
        const cur = base[p.key]
        if (cur && cur.value && ['numeric', 'numericUnbound'].includes(p.dataType) && (!p.formula || cur.overridden)) base[p.key] = { ...cur, ...flagFor(p, cur.value, cur.rangeOverride) }
        else if (!drafts[t.id] && !cur?.value && p.defaultText && ['text', 'richText'].includes(p.dataType) && !r) base[p.key] = { ...(cur ?? emptyValue()), value: p.defaultText }
      }
      bases[t.id] = base
    }
    const open = tests.filter((t) => !(t.id in out))
    let ext = externalValues(tests, (t) => out[(t as Test).id] ?? bases[(t as Test).id] ?? {})
    let cur: Record<string, Values> = { ...bases }
    for (let pass = 0; pass < 3; pass++) {
      for (const t of open) cur[t.id] = applyFormulas(t.parameters, bases[t.id], ageDays, gender, { condition, external: ext, decimals, cyclic: cyclicKeys(t) })
      ext = externalValues(tests, (t) => out[(t as Test).id] ?? cur[(t as Test).id] ?? {})
    }
    for (const t of open) out[t.id] = cur[t.id]
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, tests, drafts, resultById, amend, ageDays, condition, decimals, cycle])

  // Autosave: unsaved edits are written to the result's `draft` field every few seconds (they stay drafts; nothing
  // is reported). A draft left behind is offered again when the bill is reopened.
  const autosaveRef = useRef<() => Promise<void>>(async () => undefined)
  useEffect(() => {
    if (!canEnter) return
    const h = setInterval(() => void autosaveRef.current(), 5000)
    return () => clearInterval(h)
  }, [canEnter])
  const draftSig = useRef<Record<string, string>>({})
  const restored = useRef<Set<string>>(new Set())
  useEffect(() => {
    // Offer back drafts saved by an earlier session (once per test).
    const found: Record<string, Draft> = {}
    for (const r of results) {
      if (restored.current.has(r.testId)) continue
      restored.current.add(r.testId)
      if (r.draft && r.status !== 'approved' && r.status !== 'rejected' && !drafts[r.testId]) {
        found[r.testId] = { values: r.draft.values ?? {}, comment: r.draft.comment ?? '', paramComments: r.draft.paramComments ?? {} }
        draftSig.current[r.testId] = JSON.stringify(found[r.testId])
      }
    }
    if (Object.keys(found).length) {
      setDrafts((d) => ({ ...found, ...d }))
      message.info(`Restored unsaved edits from an autosaved draft (${Object.keys(found).length} test${Object.keys(found).length === 1 ? '' : 's'}).`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results])

  // Keyboard: Enter moves to the next result field, Ctrl+S saves, Ctrl+Enter approves, Alt+Up/Down changes test.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  if (loading)
    return (
      <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
        <SkeletonCard lines={2} />
        <SkeletonCard lines={5} />
      </div>
    )
  if (!order) return <EmptyState title="Order not found" description="The bill may have been voided or the link is wrong." />

  const valuesOf = (t: Test): Values => valuesMap[t.id] ?? {}
  const flagFor = (p: Parameter, raw: string, ov?: Values[string]['rangeOverride']) => flagValue(p, raw, ageDays, order?.gender, condition, ov)
  const recalc = (t: Test, v: Values) => applyFormulas(t.parameters, v, ageDays, order?.gender, { condition, decimals, cyclic: cyclicKeys(t) })
  const commentOf = (t: Test) => drafts[t.id]?.comment ?? resultById.get(t.id)?.comment ?? ''
  const pcOf = (t: Test) => drafts[t.id]?.paramComments ?? resultById.get(t.id)?.paramComments ?? {}
  const draftOf = (t: Test): Draft => drafts[t.id] ?? { values: valuesOf(t), comment: commentOf(t), paramComments: pcOf(t) }
  const setDraft = (t: Test, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [t.id]: { ...draftOf(t), ...(d[t.id] ?? {}), ...patch } }))

  const edit = (t: Test, next: Values) => setDraft(t, { values: next })
  const onChange = (t: Test, p: Parameter, raw: string) => {
    const base = valuesOf(t)
    const ov = base[p.key]?.rangeOverride
    edit(t, recalc(t, { ...base, [p.key]: { value: raw, overridden: !!p.formula, ...(ov ? { rangeOverride: ov } : {}), ...flagFor(p, raw, ov) } }))
  }
  const onOverride = (t: Test, p: Parameter, on: boolean) => {
    const base = valuesOf(t)
    edit(t, recalc(t, { ...base, [p.key]: { ...(base[p.key] ?? emptyValue()), overridden: on } }))
  }
  // Reference range of one result (needs a reason; the change is audited when saved). null = back to the catalogue range.
  const applyRange = (t: Test, p: Parameter, r: { low: number | null; high: number | null; text: string; reason: string } | null) => {
    const base = valuesOf(t)
    const { rangeOverride: _drop, ...cur } = base[p.key] ?? emptyValue()
    void _drop
    const ov = r ? { ...r, by: uid, byName: who.name, at: Date.now() } : undefined
    const next = { ...cur, ...(ov ? { rangeOverride: ov } : {}), ...(cur.value ? flagFor(p, cur.value, ov) : {}) }
    edit(t, { ...base, [p.key]: next })
    setRangeFor(null)
  }

  const onFlag = (t: Test, p: Parameter, on: boolean) => {
    const base = valuesOf(t)
    edit(t, { ...base, [p.key]: { ...(base[p.key] ?? emptyValue()), abnormal: on ? 'abnormal' : null } })
  }

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) message.success(ok)
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const baseFields = (t: Test) =>
    resultById.has(t.id)
      ? {}
      : { id: t.id, orderId, testId: t.id, testName: t.name, values: {}, comment: '', status: 'pending', enteredBy: '', approvedBy: '', approvedByName: '' }
  const statusOf = (over: Record<string, string> = {}) => (tid: string) => over[tid] ?? resultById.get(tid)?.status
  const provisionalOf = (tid: string) => resultById.get(tid)?.status === 'approved' && resultById.get(tid)?.releaseType === 'provisional'
  const autoOf = (tid: string) => resultById.get(tid)?.status === 'approved' && !!resultById.get(tid)?.autoVerified
  // Forget autosaved drafts (after a save, approval or undo) so they are not offered again.
  const clearDrafts = (only?: string[]) => {
    const ids = only ?? Object.keys(drafts)
    ids.forEach((id) => delete draftSig.current[id])
    setDrafts((d) => (only ? Object.fromEntries(Object.entries(d).filter(([k]) => !only.includes(k))) : {}))
    ids.forEach((id) => {
      if (resultById.get(id)?.draft) void writeResult(orderId, id, { draft: null }).catch(() => undefined)
    })
  }
  const stamp = () => ({ updatedAt: serverTimestamp() })

  // Keep the reference range as it stood when each value was first entered (printed range falls back to it).
  const snapshotValues = (t: Test, v: Values): Values => {
    const out: Values = { ...v }
    for (const p of t.parameters) if (out[p.key]) out[p.key] = withRangeSnapshot(p, out[p.key], ageDays, order?.gender, condition)
    return out
  }

  const saveAll = (extra?: (t: Test) => Record<string, unknown>) =>
    run(async () => {
      const over: Record<string, string> = {}
      const amended: string[] = []
      const amendLog: { test: string; reason: string; before: unknown; after: unknown }[] = []
      for (const id of dirtyIds) {
        const t = maps.testById.get(id)
        if (!t) continue
        const r = resultById.get(id)
        const values = snapshotValues(t, cleanValues(valuesOf(t)))
        const amending = r?.status === 'approved' && !!amend[id]
        // Saving never approves: a test stays Pending (or awaiting verification / on hold) until it is approved.
        const status: Status = amending ? 'approved' : r?.status === 'hold' ? 'hold' : r?.status === 'rejected' ? 'rejected' : r?.status === 'entered' ? 'entered' : 'pending'
        await writeResult(orderId, id, {
          ...baseFields(t),
          values,
          comment: commentOf(t),
          paramComments: pcOf(t),
          status,
          draft: null,
          ...(await recordRangeEdits(order, t, r, values, who)),
          ...(amending
            ? { amendments: [...(r?.amendments ?? []), { reason: amend[id], by: uid, byName: who.name, at: Date.now() }] }
            : { enteredBy: uid, approvedBy: '', approvedByName: '' }),
          ...(extra?.(t) ?? {}),
          ...stamp(),
        })
        await addVersion(orderId, id, amending ? 'amended' : 'saved', values, who, {
          ...(amending ? { reason: amend[id] } : {}),
          ...(restoredFrom[id] ? { restoredFrom: restoredFrom[id] } : {}),
        })
        over[id] = status
        if (amending) {
          amended.push(t.name)
          amendLog.push({ test: t.name, reason: amend[id], before: r?.values ?? {}, after: values })
        }
      }
      clearDrafts()
      setAmend({})
      setRestoredFrom({})
      await syncItems(order, statusOf(over), {}, provisionalOf, autoOf)
      if (amended.length) {
        await updateDoc(docRef(paths.orders, orderId), {
          reportRevision: (order.reportRevision ?? 0) + 1,
          amendedAt: serverTimestamp(),
          amendSummary: `Amended: ${amended.join(', ')}`,
        })
        await logActivity('result.amend', `Result amended on bill ${order.billNo}: ${amended.join(', ')}`, orderId, who, {
          category: 'RESULT',
          reason: amendLog.map((a) => `${a.test}: ${a.reason}`).join('; '),
          before: amendLog.map((a) => ({ test: a.test, values: a.before })),
          after: amendLog.map((a) => ({ test: a.test, values: a.after })),
        })
      }
    }, 'Results saved')

  // Saving while someone else holds the bill's edit marker asks first.
  const guardedSave = () => {
    if (!lock.other) return void saveAll()
    modal.confirm({
      title: `${lock.other.name || 'Another user'} is editing this bill`,
      content: 'Saving now may overwrite what they are entering. Save anyway?',
      okText: 'Save anyway',
      onOk: () => saveAll(),
    })
  }

  const sendForVerification = () =>
    run(async () => {
      const over: Record<string, string> = {}
      const targets = tests.filter((t) => ['entered', 'pending'].includes(resultById.get(t.id)?.status ?? 'pending') && (drafts[t.id] || hasAnyValue(resultById.get(t.id)?.values ?? {})))
      for (const t of targets) {
        const values = snapshotValues(t, cleanValues(valuesOf(t)))
        const r = resultById.get(t.id)
        await writeResult(orderId, t.id, {
          ...baseFields(t),
          values,
          comment: commentOf(t),
          paramComments: pcOf(t),
          status: 'entered',
          enteredBy: drafts[t.id] ? uid : r?.enteredBy || uid,
          approvedBy: '',
          approvedByName: '',
          verification: { requestedBy: uid, requestedByName: who.name, at: Date.now() },
          sentBack: null,
          draft: null,
          ...(await recordRangeEdits(order, t, r, values, who)),
          ...stamp(),
        })
        if (drafts[t.id]) await addVersion(orderId, t.id, 'saved', values, who)
        over[t.id] = 'entered'
      }
      clearDrafts()
      await syncItems(order, statusOf(over), {}, provisionalOf, autoOf)
      if (nextId) navigate(`/results/${nextId}`)
    }, 'Sent for verification')

  // Flabs: On Hold holds the test straight away; the reason dialog only appears when the lab switches it on.
  const doHold = (t: Test, reason: string) =>
    run(async () => {
      await writeResult(orderId, t.id, { ...baseFields(t), status: 'hold', holdReason: reason, heldBy: uid, heldAt: Date.now(), ...stamp() })
      await addVersion(orderId, t.id, 'hold', resultById.get(t.id)?.values ?? {}, who, { reason })
      await syncItems(order, statusOf({ [t.id]: 'hold' }), {}, provisionalOf, autoOf)
      // A held test moves the bill from Pending to Partial.
      const { recomputeOrder } = await import('../../lib/orders')
      await recomputeOrder(orderId, settings)
      setHoldFor(null)
    }, 'Test put on hold')
  const holdOrAsk = (t: Test) => (re.holdReasonModal ? setHoldFor(t) : void doHold(t, ''))
  // Releasing a hold records how long the test was held (the TAT view can subtract it).
  const release = (t: Test) =>
    run(async () => {
      const r = resultById.get(t.id)
      const status: Status = r?.verification ? 'entered' : 'pending'
      const now = Date.now()
      const ms = r?.heldAt ? Math.max(0, now - r.heldAt) : 0
      await writeResult(orderId, t.id, {
        status,
        holdReason: '',
        heldAt: null,
        holdTotalMs: (r?.holdTotalMs ?? 0) + ms,
        holdLog: [...(r?.holdLog ?? []), { by: r?.heldBy ?? '', byName: who.name, from: r?.heldAt ?? now, to: now, ms, reason: r?.holdReason ?? '' }],
        ...stamp(),
      })
      await syncItems(order, statusOf({ [t.id]: status }), {}, provisionalOf, autoOf)
      const { recomputeOrder } = await import('../../lib/orders')
      await recomputeOrder(orderId, settings)
      await logActivity('result.holdRelease', `${t.name} on bill ${order.billNo} released from hold after ${Math.round(ms / 60000)} min`, orderId, who)
    }, 'Released')

  // Flabs: Re-run needs a reason from the fixed list (remark optional). The value is cleared, the test shows Re Run
  // (also from Hold, which it releases) and the Re-run button counts the runs.
  const doRerun = (t: Test, reason: string, remark = '') =>
    run(async () => {
      if (rerunBlocked) throw new Error(rerunBlocked)
      const r = resultById.get(t.id)
      await addVersion(orderId, t.id, 'rerun', r?.values ?? {}, who, { reason, ...(remark ? { remark } : {}) })
      await writeResult(orderId, t.id, {
        ...baseFields(t),
        values: {},
        status: 'pending',
        rerun: true,
        rerunCount: (r?.rerunCount ?? 0) + 1,
        rerunReason: reason,
        rerunRemark: remark,
        holdReason: '',
        heldAt: null,
        ...(r?.status === 'hold' && r.heldAt ? { holdTotalMs: (r.holdTotalMs ?? 0) + Math.max(0, Date.now() - r.heldAt) } : {}),
        approvedBy: '',
        approvedByName: '',
        releaseType: 'final',
        criticalAck: null,
        ...stamp(),
      })
      clearDrafts([t.id])
      await syncItems(order, statusOf({ [t.id]: 'pending' }), { rerunTests: [...new Set([...(order.rerunTests ?? []), t.id])] })
      const { recomputeOrder } = await import('../../lib/orders')
      await recomputeOrder(orderId, settings)
      if (r?.status === 'approved') await logActivity('result.rerun', `${t.name} on bill ${order.billNo} un-approved for re-run: ${reason}`, orderId, who)
      setAmend((a) => {
        const n = { ...a }
        delete n[t.id]
        return n
      })
      setRerunFor(null)
    }, 'Re-run requested. The previous value is kept in versions.')

  const doReject = (t: Test, reason: string, params: string[] | null) =>
    run(async () => {
      const r = resultById.get(t.id)
      if (r?.status === 'approved') throw new Error('Un-approve this test before rejecting it')
      const rec = { reason, by: uid, byName: who.name, at: Date.now() }
      if (params === null) {
        await writeResult(orderId, t.id, { ...baseFields(t), status: 'rejected', rejected: rec, ...stamp() })
        await syncItems(order, statusOf({ [t.id]: 'rejected' }), {}, provisionalOf, autoOf)
        // A rejected test no longer holds the bill back: re-derive the bill's report status.
        const { recomputeOrder } = await import('../../lib/orders')
        await recomputeOrder(orderId, settings)
      } else {
        const cur = valuesOf(t)
        const keep = Object.fromEntries(Object.entries(cur).filter(([k]) => !params.includes(k)))
        // The rejected values are kept (struck out in the editor) but leave the result and the report.
        const struck = { ...(r?.rejectedValues ?? {}), ...Object.fromEntries(params.filter((k) => cur[k]?.value).map((k) => [k, cur[k]])) }
        await writeResult(orderId, t.id, {
          ...baseFields(t),
          values: cleanValues(keep),
          rejectedValues: JSON.parse(JSON.stringify(struck)),
          rejectedParams: [...new Set([...(r?.rejectedParams ?? []), ...params])],
          rejected: { ...rec, params },
          ...stamp(),
        })
        clearDrafts([t.id])
      }
      await logActivity('reject', `${t.name} rejected on bill ${order.billNo}${params ? ' (parameters)' : ''}: ${reason}`, orderId, who)
      setSelParams((s) => ({ ...s, [t.id]: [] }))
      setRejectFor(null)
    }, 'Rejected. Accession has been notified.')
  const restore = (t: Test) =>
    run(async () => {
      const r = resultById.get(t.id)
      await writeResult(orderId, t.id, {
        status: 'pending',
        rejected: null,
        rejectedParams: [],
        rejectedValues: {},
        ...(r?.rejectedValues && Object.keys(r.rejectedValues).length ? { values: JSON.parse(JSON.stringify({ ...(r.values ?? {}), ...r.rejectedValues })) } : {}),
        ...stamp(),
      })
      await syncItems(order, statusOf({ [t.id]: 'pending' }), {}, provisionalOf, autoOf)
      const { recomputeOrder } = await import('../../lib/orders')
      await recomputeOrder(orderId, settings)
    }, 'Test restored')

  const doIssue = (t: Test, i: { type: string; note: string }) =>
    run(async () => {
      const r = resultById.get(t.id)
      await writeResult(orderId, t.id, { ...baseFields(t), issues: [...(r?.issues ?? []), { ...i, by: uid, byName: who.name, at: Date.now() }], ...stamp() })
      await logActivity('sampleIssue', `${t.name} on bill ${order.billNo}: ${i.type}${i.note ? `. ${i.note}` : ''}`, orderId, who)
      setIssueFor(null)
    }, 'Issue added')

  const doAck = (t: Test, a: { notifiedTo: string; mode: 'phone' | 'inPerson' | 'whatsapp' | 'other'; readBack: boolean; note: string }) =>
    run(async () => {
      const v = valuesOf(t)
      const params = t.parameters.filter((p) => v[p.key]?.critical).map((p) => `${p.name} ${v[p.key].value} ${p.unit}`.trim()).join('; ')
      await recordCriticalAlert(order, t, params, { by: uid, byName: who.name, at: Date.now(), ...a }, who, resultById.get(t.id)?.criticalAlerts)
      setAckFor(null)
    }, 'Critical value notification recorded')

  const doSendBack = (t: Test, reason: string) =>
    run(async () => {
      const r = resultById.get(t.id)
      await writeResult(orderId, t.id, { status: 'pending', verification: null, sentBack: { reason, by: uid, byName: who.name, at: Date.now() }, ...stamp() })
      await addVersion(orderId, t.id, 'sentBack', r?.values ?? {}, who, { reason })
      await logActivity('result.sendBack', `${t.name} on bill ${order.billNo} sent back to the technician: ${reason}`, orderId, who)
      await syncItems(order, statusOf({ [t.id]: 'pending' }), {}, provisionalOf, autoOf)
      setSendBackFor(null)
    }, 'Sent back to the technician')

  const startAmend = (t: Test, reason: string, restore?: VersionRow) => {
    setAmend((a) => ({ ...a, [t.id]: reason }))
    setAmendFor(null)
    if (restore) applyRestore(t, restore)
  }
  const cancelAmend = (t: Test) => {
    setAmend((a) => {
      const n = { ...a }
      delete n[t.id]
      return n
    })
    setDrafts((d) => {
      const n = { ...d }
      delete n[t.id]
      return n
    })
  }
  const applyRestore = (t: Test, v: VersionRow) => {
    setDraft(t, { values: v.values ?? {} })
    setRestoredFrom((m) => ({ ...m, [t.id]: v.id }))
    message.info('Values restored into the editor. Save to keep them.')
  }
  const restoreVersion = (t: Test, v: VersionRow) => {
    const r = resultById.get(t.id)
    if (r?.status === 'approved' && !amend[t.id]) setAmendFor({ test: t, restore: v })
    else if (r?.status === 'rejected') message.error('Restore the rejected test first')
    else applyRestore(t, v)
    setVersionsFor(null)
  }

  const applyMachine = (t: Test, picked: Record<string, string>, mic: Record<string, string> = {}) => {
    let vals = valuesOf(t)
    for (const [k, raw] of Object.entries(picked)) {
      const p = t.parameters.find((x) => x.key === k)
      if (p) vals = { ...vals, [k]: { value: raw, overridden: !!p.formula, ...(vals[k]?.rangeOverride ? { rangeOverride: vals[k].rangeOverride } : {}), ...(mic[k] ? { mic: mic[k] } : vals[k]?.mic ? { mic: vals[k].mic } : {}), ...flagFor(p, raw, vals[k]?.rangeOverride) } }
    }
    edit(t, recalc(t, vals))
    setMachineFor(null)
  }

  const toggleInterp = (t: Test, on: boolean) => run(async () => writeResult(orderId, t.id, { ...baseFields(t), showInterpretation: on, ...stamp() }))

  const resolveRangeFor = (p: Parameter, v: Values[string] | undefined) => resolveRange(p, ageDays, order.gender, condition, v?.rangeOverride)
  const deltaCfg = { pct: re.deltaCheckPercent, abs: re.deltaAbsoluteLimit ?? 0, lookbackDays: re.deltaLookbackDays ?? 0 }
  const rangeOf = (t: Test, p: Parameter) => rangeTextFor(p, valuesOf(t)[p.key], ageDays, order.gender, condition)
  const ctx = { settings, uid, qcBlock, rangeOf }
  const entryFor = (t: Test): ApprovalEntry => ({ test: t, values: valuesOf(t), comment: commentOf(t), result: resultById.get(t.id), hadDraft: !!drafts[t.id], releaseType: 'final' })

  const approve = (testIds: string[]) => {
    if (!canApprove) return message.error('You do not have permission to approve results')
    const blocked: string[] = []
    const ok: ApprovalEntry[] = []
    const flagged: Flag[] = []
    const deltas: string[] = []
    const warns: ApprovalWarning[] = []
    for (const id of testIds) {
      const t = maps.testById.get(id)
      if (!t) continue
      const e = entryFor(t)
      const c = checkApprovable(e, ctx)
      if (c.reason) {
        blocked.push(`${t.name}: ${c.reason}`)
        continue
      }
      ok.push(e)
      flagged.push(...c.flags)
      warns.push(...(c.warnings ?? []))
      // Delta check: change against the latest earlier result inside the look-back window (lab or per-parameter limits).
      const pv = prevMap[t.id]?.[0]
      if (pv) {
        t.parameters.forEach((p) => {
          const d = pv.values[p.key]?.value ? deltaCheck(e.values[p.key]?.value ?? '', pv.values[p.key].value, tsToDate(pv.date), p, deltaCfg) : null
          if (d?.flagged) deltas.push(`${t.name} - ${p.name}: ${d.pct !== null ? `${d.pct > 0 ? '+' : ''}${d.pct}%` : `${d.abs > 0 ? '+' : ''}${d.abs}`} vs previous`)
        })
      }
    }
    if (!ok.length) {
      // Nothing entered at all: a plain message, like the original (no dialog).
      if (blocked.length && blocked.every((b) => b.endsWith('Please fill the data'))) return message.error('Please fill the data')
      return modal.error({ title: 'Cannot approve', content: <div>{blocked.map((b) => <div key={b}>{b}</div>)}</div> })
    }
    flagged.sort((a, b) => Number(b.critical) - Number(a.critical))
    const showAlert = re.abnormalAlertBeforeApproval && (flagged.length > 0 || deltas.length > 0)
    const go = () =>
      run(async () => {
        await approveEntries(order, ok, statusOf(), who, settings, autoOf)
        setAmend((a) => {
          const n = { ...a }
          ok.forEach((e) => delete n[e.test.id])
          return n
        })
        clearDrafts(ok.map((e) => e.test.id))
      }, 'Approved')
    // Approving goes straight through unless there is something to look at (abnormal values, warnings, skipped tests).
    if (!showAlert && warns.length === 0 && blocked.length === 0) return void go()
    modal.confirm({
      title: showAlert ? 'Abnormal values' : `Approve ${ok.length} test(s)?`,
      width: 560,
      content: (
        <div>
          {showAlert && flagged.length > 0 && (
            <div className="re-notice re-notice--warn">
              <b>Abnormal and critical values</b>
              {flagged.map((f, i) => (
                <div key={i} style={{ fontWeight: f.critical ? 700 : 400 }}>
                  {f.critical ? 'CRITICAL ' : ''}{f.test} - {f.name}: {f.value} {f.unit} {f.flag}{f.range ? ` (range ${f.range})` : ''}
                </div>
              ))}
            </div>
          )}
          {warns.length > 0 && (
            <div className="re-notice re-notice--warn">
              <b>Check before approving</b>
              {warns.map((w) => <div key={w.test + w.text}>{w.test}: {w.text}</div>)}
            </div>
          )}
          {showAlert && deltas.length > 0 && (
            <div className="re-notice re-notice--info">
              <b>Delta check (large change from the previous result)</b>
              {deltas.map((d) => <div key={d}>{d}</div>)}
            </div>
          )}
          <div>{ok.map((e) => e.test.name).join(', ')}</div>
          {blocked.length > 0 && (
            <div className="re-notice re-notice--crit" style={{ marginTop: 8 }}>
              <b>Skipped</b>
              {blocked.map((b) => <div key={b}>{b}</div>)}
            </div>
          )}
        </div>
      ),
      okText: ok.length > 1 ? 'Approve all' : 'Approve',
      onOk: go,
    })
  }

  // Final / Provisional can only be changed after approval. The dialog offers to change just the status or to save
  // the values being edited with it. The bill follows (Provisional while any test is provisional).
  const changeRelease = (t: Test, next: 'final' | 'provisional', withValues: boolean) =>
    run(async () => {
      const r = resultById.get(t.id)
      let values = r?.values ?? {}
      const extra: Record<string, unknown> = {}
      if (withValues && drafts[t.id]) {
        values = snapshotValues(t, cleanValues(valuesOf(t)))
        Object.assign(extra, { values, comment: commentOf(t), paramComments: pcOf(t), draft: null })
        if (amend[t.id]) extra.amendments = [...(r?.amendments ?? []), { reason: amend[t.id], by: uid, byName: who.name, at: Date.now() }]
      }
      await writeResult(orderId, t.id, { releaseType: next, ...extra, ...stamp() })
      await addVersion(orderId, t.id, 'amended', values, who, { reason: `Report status changed to ${next === 'provisional' ? 'Provisional' : 'Final'}` })
      if (extra.values) {
        clearDrafts([t.id])
        setAmend((a) => {
          const n = { ...a }
          delete n[t.id]
          return n
        })
      }
      await syncItems(order, statusOf(), {}, (tid) => (tid === t.id ? next === 'provisional' : provisionalOf(tid)), autoOf)
      const { recomputeOrder } = await import('../../lib/orders')
      await recomputeOrder(orderId, settings)
      setRelFor(null)
    })

  // Un-approve takes effect straight away (no confirmation), like the original; the change is kept in Versions.
  const unapprove = (t: Test) =>
    run(async () => {
      const r = resultById.get(t.id)
      await writeResult(orderId, t.id, { status: 'pending', approvedBy: '', approvedByName: '', ...stamp() })
      await addVersion(orderId, t.id, 'unapproved', r?.values ?? {}, who)
      await syncItems(order, statusOf({ [t.id]: 'pending' }), {}, provisionalOf, autoOf)
      const { recomputeOrder } = await import('../../lib/orders')
      await recomputeOrder(orderId, settings)
    }, 'Un-approved. The report for this test is withdrawn until it is approved again.')

  const startInterpret = async (t: Test) => {
    setInterpFor(t)
    setInterpError(null)
    if (resultById.get(t.id)?.aiInterpretation?.status === 'draft') return
    setInterpBusy(true)
    try {
      await interpretResult({ orderId, testId: t.id, speed })
    } catch (e) {
      setInterpError(e instanceof Error ? e.message : 'Could not generate an interpretation')
    } finally {
      setInterpBusy(false)
    }
  }
  const insertInterpretation = async (t: Test, text: string) => {
    const cur = commentOf(t)
    const next = cur.trim() ? `${cur.trim()}\n\n${text}` : text
    if (drafts[t.id]) setDraft(t, { comment: next })
    else await writeResult(orderId, t.id, { comment: next, ...stamp() })
  }

  const go = (id: string | null) => {
    if (!id) return
    if (dirtyIds.length) {
      modal.confirm({ title: 'Discard unsaved changes?', content: 'Moving to another patient drops what you have typed here.', okText: 'Discard and move', onOk: () => navigate(`/results/${id}`) })
    } else navigate(`/results/${id}`)
  }

  const setOrderField = (patch: Record<string, unknown>) => run(async () => updateDoc(docRef(paths.orders, orderId), patch))

  const notReceived = workItemsOf(order, maps.testById)
    .filter((i) => ['pending', 'collected'].includes(i.status) || (i as { notReceived?: boolean }).notReceived)
    .map((i) => i.name)
  const approvable = tests.filter((t) => !['approved', 'rejected'].includes(resultById.get(t.id)?.status ?? 'pending')).map((t) => t.id)
  // Approve all only touches tests that have values; the others stay pending without an error.
  const approvableWithValues = approvable.filter((id) => { const t = maps.testById.get(id); return !!t && (hasAnyValue(valuesOf(t)) || !!resultById.get(id)?.radiology) })
  const approveAll = () => approve(approvableWithValues.length ? approvableWithValues : approvable)
  const departments = [...new Map(tests.map((t) => [t.departmentId, maps.departmentById.get(t.departmentId)?.name ?? 'Other'])).entries()]
  const shown = tests.filter((t) => (!deptFilter || t.departmentId === deptFilter) && (!testFilter.length || testFilter.includes(t.id)))
  const signers = settings.signatories.filter((s) => s.active)
  const approverNames = [...new Set(results.filter((r) => r.status === 'approved' && r.approvedByName).map((r) => r.approvedByName))]
  const signValue = order.reportSignatoryIds?.length ? order.reportSignatoryIds : [order.reportSignatoryId || re.defaultSignatoryId].filter(Boolean)
  const eligibleAi = tests.filter((t) => hasAnyValue(resultById.get(t.id)?.values ?? {}) && !drafts[t.id])

  // Autosave tick: write each unsaved test's edits to its draft field when they changed since the last write.
  autosaveRef.current = async () => {
    let wrote = false
    for (const [id, d] of Object.entries(drafts)) {
      const t = maps.testById.get(id)
      const r = resultById.get(id)
      if (!t || r?.status === 'approved' || r?.status === 'rejected' || busy) continue
      const draft = { values: cleanValues(valuesOf(t)), comment: d.comment, paramComments: d.paramComments }
      const sig = JSON.stringify(d)
      if (draftSig.current[id] === sig) continue
      draftSig.current[id] = sig
      try {
        await writeResult(orderId, id, {
          ...baseFields(t),
          draft: JSON.parse(JSON.stringify({ ...draft, by: uid, byName: who.name, at: Date.now() })),
          updatedAt: serverTimestamp(),
        })
        wrote = true
      } catch {
        delete draftSig.current[id]
      }
    }
    if (wrote) setAutoAt(Date.now())
  }

  // Keyboard shortcuts (registered once, always call the latest handler).
  const focusables = () =>
    Array.from(document.querySelectorAll<HTMLElement>('.re-entry .re-test input:not([disabled]):not([type=checkbox]):not([type=hidden]), .re-entry .re-test textarea:not([disabled])')).filter((el) => el.offsetParent !== null)
  keyRef.current = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    const el = document.activeElement as HTMLElement | null
    const card = el?.closest?.('section[aria-label]') as HTMLElement | null
    const cardTest = card ? tests.find((t) => t.name === card.getAttribute('aria-label')) : undefined
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (canEnter && dirtyIds.length && !busy) guardedSave()
    } else if (mod && e.key === 'Enter') {
      e.preventDefault()
      if (canApprove && !busy) (cardTest ? approve([cardTest.id]) : approveAll())
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
      e.preventDefault()
      if (cardTest && canEnter && resultById.get(cardTest.id)?.status !== 'approved') (resultById.get(cardTest.id)?.status === 'hold' ? release(cardTest) : holdOrAsk(cardTest))
    } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.re-entry section.re-test'))
      const i = card ? cards.indexOf(card) : -1
      const next = cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      next?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])')?.focus()
    } else if (e.key === 'Enter' && !mod && !e.altKey && el && el.tagName === 'INPUT' && el.closest('.re-entry .re-test')) {
      const inp = el as HTMLInputElement
      if (inp.type === 'checkbox') return
      // Enter inside an open dropdown picks the option instead of moving on.
      if (inp.getAttribute('role') === 'combobox' && document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-active')) return
      e.preventDefault()
      const list = focusables()
      const i = list.indexOf(el)
      list[Math.max(0, Math.min(list.length - 1, i + (e.shiftKey ? -1 : 1)))]?.focus()
    }
  }

  return (
    <div className="re-entry">
      <PageHeader
        title={order.patientName}
        subtitle={`${ageText(order)} / ${genderText(order.gender)} / ${displayId(order, settings.registration.idDisplay)}`}
        actions={
          <div className="re-actions">
            <Button variant="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/worklist')} aria-label="Back to worklist" />
            <Popover
              trigger="click"
              placement="bottomRight"
              title="Keyboard shortcuts"
              content={
                <div className="re-keys">
                  <kbd>Enter</kbd><span>Next result field (Shift+Enter for previous)</span>
                  <kbd>Tab</kbd><span>Next control</span>
                  <kbd>Ctrl+S</kbd><span>Save</span>
                  <kbd>Ctrl+Enter</kbd><span>Approve the test you are in (or all)</span>
                  <kbd>Ctrl+Shift+H</kbd><span>Hold or release the test you are in</span>
                  <kbd>Alt+Down / Up</kbd><span>Next or previous test</span>
                </div>
              }
            >
              <Button icon={<QuestionCircleOutlined />} aria-label="Keyboard shortcuts" />
            </Popover>
            <Button icon={<EyeOutlined />} onClick={() => window.open(`/report/${orderId}`, '_blank')}>Report preview</Button>
            <Button icon={<SendOutlined />} disabled={!canEnter || busy} onClick={sendForVerification}>Send for verification</Button>
            <Button variant="primary" icon={<SaveOutlined />} disabled={!canEnter || !dirtyIds.length || busy} onClick={guardedSave}>Save</Button>
            <Dropdown menu={{ items: [{ key: 'more', label: 'View more', onClick: () => setMoreOpen(true) }] }} trigger={['click']}>
              <Button variant="text" icon={<MoreOutlined />} aria-label="More patient details" />
            </Dropdown>
          </div>
        }
      />
      <Card padding="var(--s-4)">
        <div className="re-head">
          <div className="re-head__line" style={{ marginTop: 0 }}>
            <span>Bill <b>{order.billNo}</b></span>
            <span>Barcode <b>{order.barcode}</b></span>
            <span>Referred by <b>{order.referrerName || 'Self'}</b></span>
            <span>{fmtDateTime(order.createdAt)}</span>
            {order.due > 0 && <StatusChip variant="urgent">Due {formatINR(order.due)}</StatusChip>}
            <StatusChip variant={REPORT_VARIANT[order.reportStatus]}>Report: {order.reportStatus}</StatusChip>
          </div>
        </div>
      </Card>

      {lock.other && (
        <div className="re-notice re-notice--warn re-lock" role="alert">
          <span>{lock.other.name || 'Another user'} is editing this bill right now (since {fmtDateTime(new Date(lock.other.at))}). Saving could overwrite their changes.</span>
          <Button onClick={lock.takeOver}>Continue anyway</Button>
        </div>
      )}
      {cycle && (
        <div className="re-notice re-notice--crit" role="alert">
          A formula refers back to itself ({cycle.join(' to ')}). Those results are left blank until the catalogue formula is fixed.
        </div>
      )}
      {conditions.length > 0 && (
        <div className="re-filterbar" style={{ marginTop: 0 }}>
          <label htmlFor="pat-cond">Patient condition</label>
          <Select
            id="pat-cond"
            allowClear
            style={{ width: 260 }}
            placeholder="None (normal ranges)"
            value={condition || undefined}
            disabled={!canEnter}
            onChange={(v) => setOrderField({ patientCondition: v ?? '' })}
            options={conditions.map((c) => ({ value: c, label: c }))}
          />
          <span className="wl-muted">Picks the reference ranges written for this condition (for example pregnancy).</span>
        </div>
      )}
      {settings.accession?.enabled !== false && notReceived.length > 0 && (
        <div className="re-notice re-notice--warn" role="status">
          Sample not yet received for {notReceived.join(', ')}. Results can be entered, but confirm the sample is in the lab.
        </div>
      )}

      {aiOn && canEnter && <FlagSuggestions orderId={orderId} />}

      <div className="re-filterbar">
        <Checkbox checked={abnormalOnly} onChange={(e) => setAbnormalOnly(e.target.checked)}>Show abnormal values only</Checkbox>
        <Select allowClear aria-label="Department" placeholder="All departments" style={{ width: 190 }} value={deptFilter || undefined} onChange={(v) => setDeptFilter(v ?? '')} options={departments.map(([value, label]) => ({ value, label }))} />
        <Select mode="multiple" allowClear aria-label="Tests" placeholder="All tests" style={{ minWidth: 220 }} value={testFilter} onChange={setTestFilter} maxTagCount="responsive" options={tests.map((t) => ({ value: t.id, label: t.name }))} />
      </div>

      {dirtyIds.length > 0 && (
        <div className="re-notice re-notice--warn" role="status" style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>You have unsaved changes in {dirtyIds.length} test(s).{autoAt ? ` Draft autosaved at ${new Date(autoAt).toLocaleTimeString()}.` : ''}</span>
          <Button icon={<UndoOutlined />} onClick={() => clearDrafts()}>Undo</Button>
          <Button variant="primary" onClick={guardedSave} disabled={busy}>Save</Button>
        </div>
      )}

      {tests.length === 0 && <EmptyState title="No tests to enter results for" />}
      {shown.map((t) => {
        const r = resultById.get(t.id)
        return (
          <Fragment key={t.id}>
          <TestCard
            key={t.id}
            test={t}
            values={valuesOf(t)}
            comment={commentOf(t)}
            paramComments={pcOf(t)}
            result={r}
            history={showPrev ? prevMap[t.id] ?? [] : []}
            dirty={!!drafts[t.id]}
            ageDays={ageDays}
            gender={order.gender}
            condition={condition}
            delta={deltaCfg}
            rerunBlocked={rerunBlocked}
            onEditRange={(p) => setRangeFor({ test: t, param: p })}
            onCommentOnReport={(on) => run(async () => writeResult(orderId, t.id, { ...baseFields(t), commentOnReport: on, ...stamp() }))}
            onParamCommentOnReport={(k, on) => run(async () => writeResult(orderId, t.id, { ...baseFields(t), paramCommentHidden: { ...(r?.paramCommentHidden ?? {}), [k]: !on }, ...stamp() }))}
            colourRows={re.colourCodedBackground}
            abnormalOnly={abnormalOnly}
            selectedParams={selParams[t.id] ?? []}
            canEnter={canEnter}
            canApprove={canApprove}
            canUnapprove={canUnapprove}
            qc={qcFor(t.id)}
            qcReason={qcBlock(t.id)}
            amending={!!amend[t.id] && r?.status === 'approved'}
            onReleaseChange={(v) => setRelFor({ test: t, next: v })}
            onFlag={(p, on) => onFlag(t, p, on)}
            onAmend={() => setAmendFor({ test: t })}
            onCancelAmend={() => cancelAmend(t)}
            onSendBack={() => setSendBackFor(t)}
            onChange={(p, raw) => onChange(t, p, raw)}
            onOverride={(p, on) => onOverride(t, p, on)}
            onComment={(c) => setDraft(t, { comment: c })}
            onParamComment={(k, c) => setDraft(t, { paramComments: { ...pcOf(t), [k]: c } })}
            onSelectParams={(k) => setSelParams((s) => ({ ...s, [t.id]: k }))}
            onApprove={() => approve([t.id])}
            onUnapprove={() => unapprove(t)}
            onHold={() => (r?.status === 'hold' ? release(t) : holdOrAsk(t))}
            onRerun={() => (prompts.rerunReason ? setRerunFor(t) : void doRerun(t, ''))}
            onReject={() => setRejectFor(t)}
            onRestore={() => restore(t)}
            onIssue={() => setIssueFor(t)}
            onAddComment={() => setCommentFor(t)}
            onMachine={() => setMachineFor(t)}
            onVersions={() => setVersionsFor(t)}
            onAck={() => setAckFor(t)}
            onToggleInterpretation={(on) => toggleInterp(t, on)}
            onInterpret={aiOn ? () => startInterpret(t) : undefined}
            interpreting={interpBusy && interpFor?.id === t.id}
          />
            {canEnter && r && r.status !== 'approved' && signers.length > 1 && (
              <div className="re-field" style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', margin: '0 0 var(--s-3)' }}>
                <label htmlFor={`sig-${t.id}`}>Signed by (this test)</label>
                <Select
                  id={`sig-${t.id}`}
                  allowClear
                  size="small"
                  style={{ minWidth: 220 }}
                  placeholder="Report default"
                  value={r.signatoryId || undefined}
                  onChange={(v) => run(async () => writeResult(orderId, t.id, { signatoryId: v ?? '', ...stamp() }))}
                  options={signers.map((s) => ({ value: s.id, label: s.name || 'Unnamed doctor' }))}
                />
              </div>
            )}
          </Fragment>
        )
      })}

      <Glass className="re-bottom" radius="var(--r-capsule)">
        <div className="re-bottom__group">
          <Button icon={<NotificationOutlined />} onClick={() => setNoteOpen(true)}>Note on report{order.reportNote ? ' (added)' : ''}</Button>
          <Select
            aria-label="Signature"
            mode="multiple"
            maxCount={MAX_SIGNATORIES}
            maxTagCount="responsive"
            style={{ minWidth: 220 }}
            allowClear
            placeholder={approverNames.length ? `Signed by ${approverNames[0]}` : `Signatures (up to ${MAX_SIGNATORIES})`}
            value={signValue}
            disabled={!canEnter}
            onChange={(v: string[]) => setOrderField({ reportSignatoryIds: v.slice(0, MAX_SIGNATORIES), reportSignatoryId: v[0] ?? '' })}
            options={signers.map((s) => ({ value: s.id, label: s.name || 'Unnamed doctor' }))}
          />
          {aiOn && (
            <>
              <Select
                aria-label="AI interpretation speed"
                style={{ width: 120 }}
                value={speed}
                onChange={setSpeed}
                options={[{ value: 'fast', label: 'Fast' }, { value: 'balanced', label: 'Balanced' }, { value: 'thorough', label: 'Thorough' }]}
              />
              <Dropdown
                disabled={!eligibleAi.length}
                menu={{ items: eligibleAi.map((t) => ({ key: t.id, label: t.name, onClick: () => startInterpret(t) })) }}
                trigger={['click']}
              >
                <Button icon={<RobotOutlined />} disabled={!eligibleAi.length}>AI interpretation</Button>
              </Dropdown>
            </>
          )}
        </div>
        <div className="re-bottom__group">
          <Button icon={<LeftOutlined />} aria-label="Previous patient" disabled={!prevId} onClick={() => go(prevId)}>Previous</Button>
          <Button icon={<RightOutlined />} aria-label="Next patient" disabled={!nextId} onClick={() => go(nextId)}>Next</Button>
          <Button icon={<PrinterOutlined />} onClick={() => window.open(`/report/${orderId}?print=1`, '_blank')}>Print</Button>
          {canApprove && (
            <Button variant="primary" icon={<CheckOutlined />} disabled={!approvable.length || busy} onClick={approveAll}>Approve all</Button>
          )}
        </div>
      </Glass>

      {aiOn && (
        <InterpretationDrawer
          open={!!interpFor}
          orderId={orderId}
          testId={interpFor?.id ?? ''}
          testName={interpFor?.name ?? ''}
          loading={interpBusy}
          error={interpError}
          draft={(interpFor && resultById.get(interpFor.id)?.aiInterpretation) || null}
          locked={!!interpFor && resultById.get(interpFor.id)?.status === 'approved'}
          onClose={() => setInterpFor(null)}
          onInsert={(text) => insertInterpretation(interpFor!, text)}
        />
      )}
      <VersionsDrawer
        orderId={orderId}
        test={versionsFor}
        onClose={() => setVersionsFor(null)}
        onRestore={canEnter ? (v) => restoreVersion(versionsFor!, v) : undefined}
      />
      <ReasonModal
        open={!!amendFor}
        title={`Amend approved result: ${amendFor?.test.name ?? ''}`}
        kind="amend"
        required
        okText="Start amendment"
        onCancel={() => setAmendFor(null)}
        onOk={(r) => startAmend(amendFor!.test, r, amendFor!.restore)}
      />
      <Modal
        open={!!relFor}
        title="Change report status"
        onCancel={() => setRelFor(null)}
        footer={
          <div className="re-actions">
            <Button onClick={() => setRelFor(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => relFor && changeRelease(relFor.test, relFor.next, false)}>Only change status</Button>
            <Button variant="primary" disabled={busy || !(relFor && drafts[relFor.test.id])} onClick={() => relFor && changeRelease(relFor.test, relFor.next, true)}>Save values and change status</Button>
          </div>
        }
      >
        <p>New status: <b>{relFor?.next === 'provisional' ? 'Provisional' : 'Final'}</b></p>
        <p>Save the entry values along with the status change, or change only the status?{relFor && !drafts[relFor.test.id] ? ' There are no unsaved edits for this test.' : ''}</p>
      </Modal>
      <ReasonModal open={!!sendBackFor} title={`Send back: ${sendBackFor?.name ?? ''}`} kind="sendback" required okText="Send back" onCancel={() => setSendBackFor(null)} onOk={(r) => doSendBack(sendBackFor!, r)} />

      <ReasonModal open={!!rerunFor} title="Reason for Re-run" kind="rerun" fixedReasons={RERUN_REASONS} pickRequired noteLabel="Remark (optional)" okText="Confirm Re-run" onCancel={() => setRerunFor(null)} onOk={(_t, parts) => doRerun(rerunFor!, parts?.reason ?? '', parts?.note ?? '')} />
      <ReasonModal open={!!holdFor} title={`Put on hold: ${holdFor?.name ?? ''}`} kind="hold" required={re.holdReasonModal} okText="Hold" onCancel={() => setHoldFor(null)} onOk={(r) => doHold(holdFor!, r)} />
      <CriticalAckModal
        open={!!ackFor}
        noteRequired={prompts.criticalRemark}
        testName={ackFor?.name ?? ''}
        summary={ackFor ? ackFor.parameters.filter((p) => valuesOf(ackFor)[p.key]?.critical).map((p) => `${p.name} ${valuesOf(ackFor)[p.key].value} ${p.unit}`).join('; ') : ''}
        onCancel={() => setAckFor(null)}
        onOk={(a) => doAck(ackFor!, a)}
      />
      <RejectModal open={!!rejectFor} test={rejectFor} preselected={rejectFor ? selParams[rejectFor.id] ?? [] : []} onCancel={() => setRejectFor(null)} onOk={(r, p) => doReject(rejectFor!, r, p)} />
      <IssueModal open={!!issueFor} testName={issueFor?.name ?? ''} onCancel={() => setIssueFor(null)} onOk={(i) => doIssue(issueFor!, i)} />
      <TextTemplateModal
        open={!!commentFor}
        title={`Add comment: ${commentFor?.name ?? ''}`}
        initial=""
        mode="append"
        onCancel={() => setCommentFor(null)}
        onOk={(text) => {
          const t = commentFor!
          const cur = commentOf(t)
          setDraft(t, { comment: cur.trim() ? `${cur.trim()}\n${text}` : text })
          setCommentFor(null)
        }}
      />
      <TextTemplateModal
        open={noteOpen}
        title="Note on report"
        initial={order.reportNote ?? ''}
        mode="replace"
        onCancel={() => setNoteOpen(false)}
        onOk={async (text) => {
          await setOrderField({ reportNote: text })
          setNoteOpen(false)
        }}
      />
      <RangeEditModal
        open={!!rangeFor}
        paramName={rangeFor?.param.name ?? ''}
        unit={rangeFor?.param.unit ?? ''}
        current={rangeFor ? (() => { const v = valuesOf(rangeFor.test)[rangeFor.param.key]; const rr = resolveRangeFor(rangeFor.param, v); return rr })() : { low: null, high: null, text: '' }}
        edited={!!(rangeFor && valuesOf(rangeFor.test)[rangeFor.param.key]?.rangeOverride)}
        onCancel={() => setRangeFor(null)}
        onOk={(r) => applyRange(rangeFor!.test, rangeFor!.param, r)}
      />
      <MachineValueModal
        open={!!machineFor}
        test={machineFor}
        runs={machineFor ? machineRuns(resultById.get(machineFor.id)?.machineValues) : []}
        current={machineFor ? valuesOf(machineFor) : {}}
        onCancel={() => setMachineFor(null)}
        onApply={(p, mic) => applyMachine(machineFor!, p, mic)}
      />
      <Drawer open={moreOpen} onClose={() => setMoreOpen(false)} title="Patient and bill details" width="min(480px, 100vw)">
        <FormSection title="Patient">
          <FieldGrid min={170}>
            <div className="re-field"><label>Patient</label><div>{order.patientName}, {ageText(order)} / {genderText(order.gender)}</div></div>
            <div className="re-field"><label>Patient no</label><div>{displayId(order, settings.registration.idDisplay)}</div></div>
            <div className="re-field"><label>Age at collection</label><div>{Math.floor(ageDays / 365.25) >= 1 ? `${Math.floor(ageDays / 365.25)} years` : `${ageDays} days`}</div></div>
          </FieldGrid>
        </FormSection>
        <FormSection title="Bill and sample">
          <FieldGrid min={170}>
            <div className="re-field"><label>Bill and barcode</label><div>{order.billNo} / {order.barcode}</div></div>
            <div className="re-field"><label>Registered</label><div>{fmtDateTime(order.createdAt)}</div></div>
            <div className="re-field"><label>Collected</label><div>{fmtDateTime(order.collectedAt)}</div></div>
            <div className="re-field"><label>Received</label><div>{fmtDateTime(order.receivedAt)}</div></div>
          </FieldGrid>
          {order.note && <div className="re-field"><label>Bill note</label><div>{order.note}</div></div>}
        </FormSection>
        <FormSection title="Collection photos">
          <CollectionPhotos orderId={orderId} files={order.collectionPhotoFiles} legacy={order.collectionPhotos} canAdd={canEnter} who={who} />
        </FormSection>
      </Drawer>
    </div>
  )
}
