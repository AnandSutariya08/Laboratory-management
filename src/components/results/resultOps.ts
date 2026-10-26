import { logActivity as sharedLogActivity, type AuditExtra } from '../../layout/activity'
import { addDoc, getDocs, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { branchStamp } from '../../lib/activeBranch'
import { col, docRef, paths, resultDoc, resultsCol, versionsCol } from '../../lib/db'
import { recomputeOrder } from '../../lib/orders'
import { dlcTotal, dlcOff, flagLetter, hasAnyValue, parseNumeric } from '../../lib/results'
import type { LabSettings, Order, OrderItem, Parameter, Test } from '../../types'
import type { Ack, OrderExt, RangeEdit, ResultExt, SignatureSnapshot, Values } from './types'

export const cleanValues = (v: Values): Values =>
  Object.fromEntries(Object.entries(v).filter(([, x]) => x.value.trim() !== '' || x.overridden))

// Replace exactly these top-level fields on the result doc (maps are replaced, not deep-merged).
export const writeResult = (orderId: string, testId: string, data: Record<string, unknown>) =>
  setDoc(resultDoc(orderId, testId), data, { mergeFields: Object.keys(data) })

export const addVersion = (
  orderId: string,
  testId: string,
  event: string,
  values: Values,
  who: { uid: string; name: string },
  extra: Record<string, unknown> = {},
) => addDoc(versionsCol(orderId, testId), { event, values, by: who.uid, byName: who.name, at: serverTimestamp(), ...extra })

// Result audit entries go through the shared helper (layout/activity.ts); `orderId` becomes the ref path.
export const logActivity = (type: string, text: string, orderId: string, who: { uid: string; name: string }, extra: AuditExtra = {}) =>
  sharedLogActivity(type, text, `orders/${orderId}`, { category: 'RESULT', ...extra, actor: who })

// Keep each order line's status in step with its tests' results.
export async function syncItems(
  order: Order,
  statusOf: (testId: string) => string | undefined,
  extra: Record<string, unknown> = {},
  provisionalOf: (testId: string) => boolean = () => false,
  autoVerifiedOf: (testId: string) => boolean = () => false,
) {
  let changed = false
  const items = order.items.map((it: OrderItem): OrderItem => {
    if (it.status === 'refunded') return it
    const all = it.testIds.map((t) => statusOf(t) ?? 'pending')
    const s = all.filter((x) => x !== 'rejected')
    let next: OrderItem['status'] = it.status
    if (!s.length && all.length) next = 'rejected'
    else if (s.length && s.every((x) => x === 'approved')) next = 'approved'
    else if (s.includes('hold')) next = 'hold'
    else if (s.some((x) => x === 'entered' || x === 'approved')) next = 'entered'
    else if (['entered', 'approved', 'hold', 'rejected'].includes(it.status)) next = 'received'
    // Approved line is Provisional when any of its approved tests was released as Provisional.
    const prov = next === 'approved' && s.some(provisionalOf)
    // Approved entirely by the auto-verification rules: the line reads "Auto verified".
    const auto = next === 'approved' && s.length > 0 && s.every(autoVerifiedOf)
    const was = !!(it as { autoVerified?: boolean }).autoVerified
    if (next !== it.status || !!it.provisional !== prov || was !== auto) changed = true
    if (next === it.status && !!it.provisional === prov && was === auto) return it
    const out: OrderItem & { autoVerified?: boolean } = { ...it, status: next }
    if (prov) out.provisional = true
    else delete out.provisional
    if (auto) out.autoVerified = true
    else delete out.autoVerified
    return out
  })
  if (changed || Object.keys(extra).length) await updateDoc(docRef(paths.orders, order.id), { ...(changed ? { items } : {}), ...extra })
}

// Up to three doctors sign one report; their details are frozen into the result when it is approved.
export const MAX_SIGNATORIES = 3

export function signersFor(order: Pick<OrderExt, 'reportSignatoryId' | 'reportSignatoryIds'>, r: Pick<ResultExt, 'signatoryId'> | undefined, settings: LabSettings): SignatureSnapshot[] {
  const wanted = r?.signatoryId
    ? [r.signatoryId]
    : order.reportSignatoryIds?.length
      ? order.reportSignatoryIds
      : [order.reportSignatoryId || settings.reportEntry.defaultSignatoryId]
  const active = settings.signatories.filter((x) => x.active !== false)
  return [...new Set(wanted.filter(Boolean) as string[])]
    .slice(0, MAX_SIGNATORIES)
    .map((id) => active.find((x) => x.id === id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => ({
      id: x.id,
      name: x.name,
      qualification: x.qualification ?? '',
      registrationNo: x.registrationNo ?? '',
      signatureDataUrl: x.signatureDataUrl ?? '',
      designation: x.designation ?? '',
      hideNameInReport: !!x.hideNameInReport,
    }))
}

// ---- Reference range edits -----------------------------------------------------
const rangeLabel = (o: { low: number | null; high: number | null; text: string } | undefined) =>
  !o ? 'table range' : o.text || (o.low !== null && o.high !== null ? `${o.low} - ${o.high}` : o.low !== null ? `> ${o.low}` : o.high !== null ? `< ${o.high}` : 'no range')

// Differences in per-result range edits between the saved and the new values (the audit trail of range changes).
export function rangeEdits(test: Test, before: Values, after: Values, who: { uid: string; name: string }): RangeEdit[] {
  const out: RangeEdit[] = []
  for (const p of test.parameters) {
    const a = before[p.key]?.rangeOverride
    const b = after[p.key]?.rangeOverride
    if (rangeLabel(a) === rangeLabel(b) && (a?.low ?? null) === (b?.low ?? null) && (a?.high ?? null) === (b?.high ?? null)) continue
    out.push({ param: p.key, paramName: p.name, from: rangeLabel(a), to: rangeLabel(b), reason: b?.reason ?? 'Range reset to the table', by: who.uid, byName: who.name, at: Date.now() })
  }
  return out
}

// Writes the trail onto the result (returned as fields to merge) and into the activity feed.
export async function recordRangeEdits(order: Order, test: Test, existing: ResultExt | undefined, after: Values, who: { uid: string; name: string }): Promise<Record<string, unknown>> {
  const edits = rangeEdits(test, existing?.values ?? {}, after, who)
  if (!edits.length) return {}
  await logActivity(
    'result.rangeEdit',
    `Reference range edited on bill ${order.billNo}, ${test.name}: ${edits.map((e) => `${e.paramName} ${e.from} to ${e.to}`).join('; ')}`,
    order.id,
    who,
    { category: 'RESULT', reason: edits.map((e) => e.reason).join('; '), before: edits.map((e) => ({ param: e.param, range: e.from })), after: edits.map((e) => ({ param: e.param, range: e.to })) },
  )
  return { rangeEditLog: [...(existing?.rangeEditLog ?? []), ...edits] }
}

export interface Flag {
  test: string
  name: string
  value: string
  unit: string
  critical: boolean
  flag: string
  range: string
}

// Soft warnings shown before approving (they never block).
export interface ApprovalWarning {
  test: string
  text: string
}

export interface ApprovalEntry {
  test: Test
  values: Values
  comment: string
  result?: ResultExt
  hadDraft: boolean
  releaseType?: 'final' | 'provisional'
}

export interface ApprovalCtx {
  settings: LabSettings
  uid: string
  qcBlock: (testId: string) => string | null // reason when QC blocks approval
  rangeOf?: (t: Test, p: Parameter) => string // reference range text for the abnormal-values list
}

// The single set of approval checks used by one-test approve, approve-all and bulk approve.
export function checkApprovable(e: ApprovalEntry, ctx: ApprovalCtx): { reason: string | null; flags: Flag[]; warnings?: ApprovalWarning[] } {
  const { test: t, values: v, result: r } = e
  const q = ctx.qcBlock(t.id)
  if (q) return { reason: q, flags: [] }
  if (r?.status === 'rejected') return { reason: 'test rejected', flags: [] }
  if (!hasAnyValue(v) && !ctx.settings.allowEmptyApproval && !(r?.radiology && (r.radiology.findings || r.radiology.impression)))
    return { reason: 'Please fill the data', flags: [] }
  const enteredBy = e.hadDraft ? ctx.uid : r?.enteredBy
  if (!ctx.settings.allowSelfVerification && enteredBy === ctx.uid) return { reason: 'entered by you, needs another approver', flags: [] }
  const missing = t.parameters.filter((p) => p.required && !(v[p.key]?.value ?? '').trim() && !(r?.rejectedParams ?? []).includes(p.key) && p.structure !== 'group')
  if (missing.length && !ctx.settings.allowEmptyApproval) return { reason: `required: ${missing.map((p) => p.name).join(', ')}`, flags: [] }
  const flags: Flag[] = []
  t.parameters.forEach((p) => {
    const x = v[p.key]
    if (x && (x.abnormal || x.critical))
      flags.push({ test: t.name, name: p.name, value: x.value, unit: p.unit, critical: x.critical, flag: flagLetter(x), range: ctx.rangeOf?.(t, p) ?? '' })
  })
  if (ctx.settings.reportEntry.criticalAckRequired && flags.some((f) => f.critical) && !r?.criticalAck)
    return { reason: 'critical value not acknowledged', flags }
  const warnings: ApprovalWarning[] = []
  const dlc = dlcTotal(t.parameters, v)
  if (dlc && dlcOff(dlc)) warnings.push({ test: t.name, text: `Differential count adds up to ${dlc.total}%, not 100%` })
  return { reason: null, flags, warnings }
}

export async function approveEntries(
  order: Order,
  entries: ApprovalEntry[],
  statusOf: (testId: string) => string | undefined,
  who: { uid: string; name: string },
  settings: LabSettings,
  autoVerifiedOf: (testId: string) => boolean = () => false, // tests approved earlier by the auto-verification rules
) {
  const done: Record<string, string> = {}
  const release: Record<string, string> = {}
  for (const e of entries) {
    const values = cleanValues(e.values)
    const r = e.result
    await writeResult(order.id, e.test.id, {
      id: e.test.id,
      orderId: order.id,
      testId: e.test.id,
      testName: e.test.name,
      values,
      comment: e.comment,
      status: 'approved',
      enteredBy: e.hadDraft ? who.uid : r?.enteredBy ?? who.uid,
      approvedBy: who.uid,
      approvedByName: who.name,
      approvedAt: serverTimestamp(),
      releaseType: e.releaseType ?? 'final',
      rerun: false,
      verification: null,
      sentBack: null,
      draft: null,
      autoVerified: false,
      signatureSnapshots: signersFor(order as OrderExt, r, settings),
      ...(await recordRangeEdits(order, e.test, r, values, who)),
      selfVerified: (e.hadDraft ? who.uid : r?.enteredBy ?? who.uid) === who.uid,
      updatedAt: serverTimestamp(),
    })
    if (e.hadDraft) await addVersion(order.id, e.test.id, 'saved', values, who)
    await addVersion(order.id, e.test.id, 'approved', values, who)
    done[e.test.id] = 'approved'
    release[e.test.id] = e.releaseType ?? 'final'
  }
  const rerun = ((order as OrderExt).rerunTests ?? []).filter((t) => !(t in done))
  await syncItems(
    order,
    (t) => done[t] ?? statusOf(t),
    (order as OrderExt).rerunTests ? { rerunTests: rerun } : {},
    (t) => (t in done ? release[t] === 'provisional' : !!(order.items.find((i) => i.testIds.includes(t))?.provisional)),
    (t) => (t in done ? false : autoVerifiedOf(t)),
  )
  await recomputeOrder(order.id, settings)
}

export async function loadResults(orderId: string): Promise<ResultExt[]> {
  const snap = await getDocs(resultsCol(orderId))
  return snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as ResultExt)
}

// Percentage change of the current value against a previous one (null when not numeric).
export function deltaPct(cur: string, prev: string): number | null {
  const a = parseNumeric(cur)
  const b = parseNumeric(prev)
  if (a === null || b === null || b === 0) return null
  return Math.round(((a - b) / Math.abs(b)) * 1000) / 10
}

// Critical value call-out: kept on the result and in the activity feed (the alert log).
export async function recordCriticalAlert(
  order: Order,
  test: Test,
  params: string,
  ack: Ack,
  who: { uid: string; name: string },
  existing: ResultExt['criticalAlerts'] = [],
) {
  await writeResult(order.id, test.id, { criticalAck: ack, criticalAlerts: [...(existing ?? []), { ...ack, params }], updatedAt: serverTimestamp() })
  await addDoc(col('activity'), {
    type: 'criticalAlert',
    text: `Critical value on bill ${order.billNo}, ${test.name} (${params}): ${ack.notifiedTo ? `told ${ack.notifiedTo}` : 'acknowledged'}${ack.mode ? ` by ${ack.mode}` : ''}${ack.readBack ? ', read back' : ''}${ack.note ? `. ${ack.note}` : ''}`,
    refPath: `orders/${order.id}`,
    testId: test.id,
    notifiedTo: ack.notifiedTo ?? '',
    mode: ack.mode ?? '',
    readBack: !!ack.readBack,
    at: serverTimestamp(),
    by: who.uid,
    byName: who.name,
    ...branchStamp(),
  })
}
