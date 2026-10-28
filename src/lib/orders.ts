import {
  addDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  arrayUnion,
  deleteField,
  updateDoc,
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import { canNow } from '../auth/AuthProvider'
import { branchStamp } from './activeBranch'
import { barcodeType } from '../features/settings/lib'
import { logActivity } from '../layout/activity'
import { autoConsumeForTests, reverseConsumptionForOrder } from '../features/inventory/lib/stock'
import type {
  DispatchMode,
  LabSettings,
  LedgerEntry,
  Order,
  OrderItem,
  OrderRevision,
  Patient,
  PaymentMode,
  TestResult,
  UserProfile,
} from '../types'
import { computeTotals, deriveReportStatus, dueAmount, ledgerSums, lineLocked, lineNet, needsReference, ageAt } from './billing'
import {
  col,
  docRef,
  ledgerCol,
  nextBarcode,
  nextBillNo,
  nextCounter,
  nextPatientNo,
  paths,
  resultsCol,
} from './db'

export type NewPatient = Omit<Patient, 'id' | 'patientNo' | 'createdAt'>

// Firestore rejects undefined values; drop them before writing.
export function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

export async function nextUhid(): Promise<string> {
  return `UH${String(await nextCounter('uhid')).padStart(6, '0')}`
}

// Financial year label: April to March, e.g. 2627 for 1 Apr 2026 - 31 Mar 2027.
export function financialYear(d = new Date()): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`
}

// One receipt number per payment event: R + financial year + 5-digit sequence (R262700001).
export async function nextReceiptNo(): Promise<string> {
  const n = await nextCounter(`receipt-${financialYear()}`)
  return `R${financialYear()}${String(n).padStart(5, '0')}`
}
export async function nextRefundNo(): Promise<string> {
  const n = await nextCounter(`refund-${financialYear()}`)
  return `RF${financialYear()}${String(n).padStart(5, '0')}`
}
// Counter shift the money was taken in (for day-end reconciliation).
export const shiftOf = (d = new Date()): string => (d.getHours() < 14 ? 'Morning' : d.getHours() < 21 ? 'Evening' : 'Night')

// B2B centre flag "No patient edit after report approval": a bill of that centre with an approved test is frozen.
export async function b2bEditLockReason(order: Pick<Order, 'b2bCentreId' | 'items' | 'billNo'>): Promise<string | null> {
  if (!order.b2bCentreId || !order.items.some((i) => i.status === 'approved')) return null
  try {
    const c = await getDoc(docRef<{ settings?: { noEditAfterApproval?: boolean } }>('b2bCentres', order.b2bCentreId))
    return c.exists() && c.data().settings?.noEditAfterApproval ? `Bill ${order.billNo} belongs to a B2B centre that does not allow edits after a report is approved.` : null
  } catch {
    return null
  }
}
// Same lock for editing a patient: any bill of this patient that is frozen blocks the edit.
export async function patientEditLockReason(patientId: string): Promise<string | null> {
  const snap = await getDocs(query(col(paths.orders), where('patientId', '==', patientId), limit(50)))
  for (const d of snap.docs) {
    const o = d.data() as Order
    if (o.deleted) continue
    const r = await b2bEditLockReason(o)
    if (r) return r
  }
  return null
}

// Is this UHID already used by another patient? (UHIDs are lab-unique.)
export async function uhidTaken(uhid: string, exceptPatientId?: string): Promise<boolean> {
  const u = uhid.trim()
  if (!u) return false
  const snap = await getDocs(query(col(paths.patients), where('uhid', '==', u), limit(2)))
  return snap.docs.some((d) => d.id !== exceptPatientId)
}

// Registration creates the patient straight away (before billing), matching the
// front-desk flow; the bill is a separate step. `autoUhid` assigns the next UHID.
export async function createPatient(p: NewPatient, opts: { autoUhid?: boolean } = {}): Promise<Patient> {
  if (p.uhid && (await uhidTaken(p.uhid))) throw new Error(`UHID ${p.uhid} is already used by another patient.`)
  const patientNo = await nextPatientNo()
  const uhid = p.uhid || (opts.autoUhid ? await nextUhid() : undefined)
  const dayNo = Number(patientNo.slice(6)) || undefined
  const data = clean({ ...p, uhid, patientNo, dayNo, createdBranchId: branchStamp().branchId })
  const ref = await addDoc(col(paths.patients), { ...data, createdAt: serverTimestamp() })
  return { ...data, id: ref.id } as unknown as Patient
}

// Update an existing patient in place (registration after picking a patient and editing it).
export async function updatePatient(existing: Patient, patch: Partial<NewPatient>): Promise<Patient> {
  if (patch.uhid && patch.uhid !== existing.uhid && (await uhidTaken(patch.uhid, existing.id))) {
    throw new Error(`UHID ${patch.uhid} is already used by another patient.`)
  }
  const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Record<string, unknown>
  await updateDoc(docRef(paths.patients, existing.id), fields)
  return { ...existing, ...fields } as Patient
}

// One audit helper for the whole app lives in layout/activity.ts (best-effort; never blocks the action).
export { logActivity }

// Partner / registration context stored on the bill.
export interface BillContext {
  referrerId?: string
  referrerName?: string
  hospitalId?: string
  hospitalName?: string
  b2bCentreId?: string
  b2bCentreName?: string
  collectionCentreId?: string
  collectionCentreName?: string
  corporateClientId?: string
  corporateClientName?: string
  govPanelId?: string
  govPanelName?: string
  tpaId?: string
  tpaName?: string
  priority?: 'routine' | 'urgent'
  sampleCollectedAt?: 'lab' | 'home'
  uhid?: string
  secondReferrerId?: string
  secondReferrerName?: string
  rateListIds?: string[]
  rateListId?: string // rate list picked by hand
  // Registration extras (stamped on the bill)
  phlebotomistId?: string
  phlebotomistName?: string
  collectionDateTime?: Date
  proId?: string // PRO picked at registration; overrides the referrer's PRO
  proName?: string
  corporateUser?: string
  corporatePlan?: string
  corporatePlanId?: string
  disableLetterhead?: boolean
  hidePlan?: boolean
  clinicalHistory?: string
  weight?: number
  height?: number
  category?: string
}

export interface NewPayment {
  mode: PaymentMode
  amount: number // paise
  reference: string
  paidAt?: Date // back-dated payment (needs permission, checked by the caller)
}

// PRO (marketing manager) of a referrer, stamped on the bill so commissions can follow it.
async function proOf(referrerId?: string): Promise<{ proId?: string; proName?: string; commission?: Order['commissionSnapshot']; costList?: Record<string, number> }> {
  if (!referrerId) return {}
  try {
    const r = await getDoc(docRef<{ proManagerId?: string; commissionType?: string; commissionValue?: number; discountBearer?: 'lab' | 'referrer' | 'split'; commissionMode?: string; commissionListId?: string }>('referrers', referrerId))
    if (!r.exists()) return {}
    const d = r.data()
    // Rate-list-difference commission: freeze the referrer's cost list on the lines (see commissionCost).
    let costList: Record<string, number> | undefined
    if (d.commissionMode === 'rateListDiff' && d.commissionListId) {
      const l = await getDoc(docRef<{ entries?: Record<string, number> }>('rateLists', d.commissionListId))
      if (l.exists()) costList = l.data().entries ?? {}
    }
    // Commission terms are frozen on the bill so later edits to the referrer never rewrite history.
    const commission: Order['commissionSnapshot'] =
      d.commissionType && d.commissionType !== 'none'
        ? { type: d.commissionType, value: d.commissionValue ?? 0, basis: 'net', bearer: d.discountBearer ?? 'referrer' }
        : undefined
    const proId = d.proManagerId
    if (!proId) return { commission, costList }
    const m = await getDoc(docRef<{ name?: string }>('marketingTeam', proId))
    return { proId, proName: m.exists() ? m.data().name : undefined, commission, costList }
  } catch {
    return {}
  }
}

export interface CreateOrderInput {
  patient: Patient
  items: OrderItem[] // discount already allocated per line
  discountReason: string
  discountedBy: string
  note: string
  payments: NewPayment[]
  settings: LabSettings
  user: UserProfile
  context?: BillContext
  billDate?: Date
  payer?: { kind: 'tpa' | 'govPanel'; id: string; name: string; amount: number }
  billedTo?: 'patient' | 'b2b'
  quotationId?: string
  bookingId?: string
  discountBearer?: 'lab' | 'referrer' | 'split'
  discountSplitReferrerPct?: number
  urgentRemark?: string
  discountApprovedBy?: string
  discountApprovedByName?: string
}

// Barcode for a new bill: a fresh one, or (patient-wise barcodes) the patient's shared one, created on first use.
export async function barcodeFor(settings: Pick<LabSettings, 'barcode'>, patient: Pick<Patient, 'id' | 'barcode'>): Promise<string> {
  if (barcodeType(settings) !== 'patient') return nextBarcode()
  if (patient.barcode) return patient.barcode
  const code = await nextBarcode()
  await updateDoc(docRef(paths.patients, patient.id), { barcode: code })
  return code
}

export async function createOrder(input: CreateOrderInput): Promise<string> {
  const { patient, items, payments, settings, user } = input
  const [billNo, barcode] = await Promise.all([nextBillNo(settings.billPrefix), barcodeFor(settings, patient)])
  // Accession switched off: samples are not tracked, so test lines go straight to result entry.
  const noAccession = settings.accession?.enabled === false
  const lines = noAccession ? items.map((i) => (i.isCharge || i.status !== 'pending' ? i : { ...i, status: 'received' as const })) : items
  const totals = computeTotals(lines)
  const paid = payments.reduce((s, p) => s + p.amount, 0)
  const payer = input.payer && input.payer.amount > 0 ? input.payer : undefined
  const due = dueAmount(totals.net - (payer?.amount ?? 0), paid)
  const ctx = input.context ?? {}
  const refId = ctx.referrerId || patient.referrerId
  const pro = await proOf(refId)
  const billStart = input.billDate ? new Date(input.billDate) : new Date()
  const backdated = billStart.getTime() < new Date().setHours(0, 0, 0, 0)
  const source: Order['source'] = input.bookingId
    ? 'booking'
    : input.quotationId
      ? 'quotation'
      : ctx.b2bCentreId
        ? 'b2b'
        : ctx.corporateClientId
          ? 'corporate'
          : ctx.sampleCollectedAt === 'home'
            ? 'home'
            : 'walkin'

  const order: Omit<Order, 'id'> = clean({
    ...branchStamp(),
    billNo,
    barcode,
    patientId: patient.id,
    patientNo: patient.patientNo,
    patientName: `${patient.salutation} ${patient.firstName} ${patient.lastName}`.replace(/\s+/g, ' ').trim(),
    gender: patient.gender,
    ...ageAt(patient.dob, billStart, patient),
    referrerName: ctx.referrerName || patient.referrerName || 'Self',
    items: lines
      .filter(Boolean)
      .map((i) => {
        const unitCost = pro.costList && !i.isCharge ? pro.costList[i.refId] : undefined
        const withCost = typeof unitCost === 'number' ? { ...i, commissionCost: unitCost * (i.qty ?? 1) } : i
        return clean(withCost as unknown as Record<string, unknown>) as unknown as OrderItem
      }),
    ...totals,
    paid,
    refunded: 0,
    due,
    discountReason: input.discountReason,
    discountedBy: input.discountedBy,
    note: input.note,
    reportStatus: 'pending',
    dispatch: patient.dispatchModes.map((mode) => ({ mode, delivered: false, deliveredAt: null })),
    dispatched: false,
    collectedAt: noAccession ? serverTimestamp() : null,
    receivedAt: noAccession ? serverTimestamp() : null,
    reportedAt: null,
    createdAt: serverTimestamp() as Order['createdAt'],
    createdBy: user.uid,
    deleted: false,
    referrerId: ctx.referrerId || patient.referrerId,
    hospitalId: ctx.hospitalId || patient.hospitalId,
    // Partner names are stored next to the ids so lists, filters and finance
    // columns can show them without loading every master.
    hospitalName: ctx.hospitalName,
    b2bCentreId: ctx.b2bCentreId,
    b2bCentreName: ctx.b2bCentreName,
    collectionCentreId: ctx.collectionCentreId,
    collectionCentreName: ctx.collectionCentreName,
    corporateClientId: ctx.corporateClientId,
    corporateClientName: ctx.corporateClientName,
    govPanelId: ctx.govPanelId,
    govPanelName: ctx.govPanelName,
    tpaId: ctx.tpaId,
    tpaName: ctx.tpaName,
    createdByName: user.name,
    uhid: ctx.uhid || patient.uhid,
    priority: ctx.priority ?? 'routine',
    sampleCollectedAt: ctx.sampleCollectedAt,
    billDate: input.billDate ? Timestamp.fromDate(input.billDate) : undefined,
    payer,
    billedTo: input.billedTo ?? 'patient',
    quotationId: input.quotationId,
    bookingId: input.bookingId,
    source,
    secondReferrerId: ctx.secondReferrerId,
    secondReferrerName: ctx.secondReferrerName,
    discountBearer: input.discountBearer,
    discountSplitReferrerPct: input.discountBearer === 'split' ? input.discountSplitReferrerPct : undefined,
    urgentRemark: input.urgentRemark?.trim() || undefined,
    // Who marked the bill urgent (NABL urgent log): the biller, when the bill or any line is urgent.
    urgentMarkedBy: ctx.priority === 'urgent' || lines.some((i) => i.urgent) ? user.uid : undefined,
    urgentMarkedByName: ctx.priority === 'urgent' || lines.some((i) => i.urgent) ? user.name : undefined,
    discountApprovedBy: input.discountApprovedBy,
    discountApprovedByName: input.discountApprovedByName,
    proId: ctx.proId || pro.proId,
    proName: ctx.proName || pro.proName,
    commissionSnapshot: pro.commission,
    phlebotomistId: ctx.phlebotomistId,
    phlebotomistName: ctx.phlebotomistName,
    collectionDateTime: ctx.collectionDateTime ? Timestamp.fromDate(ctx.collectionDateTime) : undefined,
    corporateUser: ctx.corporateUser,
    corporatePlan: ctx.corporatePlan,
    corporatePlanId: ctx.corporatePlanId,
    disableLetterhead: ctx.disableLetterhead || undefined,
    hidePlan: ctx.hidePlan || undefined,
    clinicalHistory: ctx.clinicalHistory,
    weight: ctx.weight,
    height: ctx.height,
    category: ctx.category,
    pcpndt: lines.some((i) => i.pcpndt) || undefined,
    version: 1,
    billNoReport: billNo,
    rateListIds: ctx.rateListIds?.length ? ctx.rateListIds : undefined,
    billPrints: 0,
    revisions: [],
  }) as Omit<Order, 'id'>
  const ref = await addDoc(col(paths.orders), order)
  const livePays = payments.filter((x) => x.amount > 0)
  // A receipt number is a convenience: never let a counter problem block the bill.
  const receiptNo = livePays.length ? await nextReceiptNo().catch(() => undefined) : undefined
  for (const p of livePays) {
    await addDoc(ledgerCol(ref.id), {
      ...branchStamp(),
      type: 'payment',
      mode: p.mode,
      amount: p.amount,
      reference: p.reference,
      remark: '',
      lineIds: [],
      ...(receiptNo ? { receiptNo } : {}),
      shift: shiftOf(),
      ...(p.paidAt || backdated ? { backdatedTo: Timestamp.fromDate(p.paidAt ?? billStart) } : {}),
      postedBy: user.uid,
      postedByName: user.name,
      postedAt: serverTimestamp(),
    })
  }
  // B2B centre: the bill debits the centre wallet (balances are derived from bills; this
  // row mirrors it for the wallet statement).
  if (input.billedTo === 'b2b' && ctx.b2bCentreId && totals.net > 0) {
    try {
      await addDoc(col('walletTxns'), {
        ...branchStamp(),
        centreId: ctx.b2bCentreId,
        centreName: ctx.b2bCentreName ?? '',
        kind: 'debit',
        reference: billNo,
        amount: -totals.net,
        status: 'approved',
        orderId: ref.id,
        remark: `Bill ${billNo}`,
        by: user.uid,
        byName: user.name,
        at: serverTimestamp(),
      })
    } catch (e) {
      console.warn('wallet mirror failed', e)
    }
  }
  // Stock: with Inventory > consume on = billing the bill itself consumes mapped items. Without
  // accession the lines are received straight away, so the receipt trigger fires here too.
  // autoConsumeForTests ignores the call when the lab chose the other trigger (no double count),
  // and inventory problems never block billing.
  try {
    const testIds = lines.filter((i) => !i.isCharge && !i.onlyBilling && i.status !== 'refunded').flatMap((i) => i.testIds)
    await autoConsumeForTests({ id: ref.id, billNo }, testIds, user.name || user.uid, 'billing')
    if (noAccession) await autoConsumeForTests({ id: ref.id, billNo }, testIds, user.name || user.uid, 'receipt')
  } catch (err) {
    console.warn('Inventory auto-consumption failed', err)
  }
  void logActivity('bill', `Bill ${billNo} created for ${order.patientName}`, `orders/${ref.id}`, { category: 'BILLING', actor: user })
  return ref.id
}

// "Save & Collect": mark every test line as collected; charge lines need no sample.
export async function markCollectedOnCreate(orderId: string, items: OrderItem[]) {
  await updateDoc(docRef(paths.orders, orderId), {
    items: items.map((i) => ({ ...i, status: i.isCharge || i.onlyBilling ? 'received' : 'collected' })),
    collectedAt: serverTimestamp(),
  })
}

export interface EditOrderInput {
  items: OrderItem[]
  note?: string
  referrerId?: string
  referrerName?: string
  hospitalId?: string
  hospitalName?: string
  secondReferrerId?: string
  secondReferrerName?: string
  b2bCentreId?: string
  b2bCentreName?: string
  collectionCentreId?: string
  corporateClientId?: string
  govPanelId?: string
  tpaId?: string
  discountReason?: string
  discountedBy?: string
  summary: string
}

// Mirror row on the B2B wallet statement (balances themselves derive from bills; these
// rows only keep the statement readable). Never blocks the edit.
async function walletMirror(centreId: string, centreName: string, amount: number, order: Order, remark: string, user: UserProfile) {
  if (!centreId || amount === 0) return
  try {
    await addDoc(col('walletTxns'), {
      ...branchStamp(),
      centreId,
      centreName,
      kind: 'debit',
      reference: order.billNo,
      amount,
      status: 'approved',
      orderId: order.id,
      remark,
      by: user.uid,
      byName: user.name,
      at: serverTimestamp(),
    })
  } catch (e) {
    console.warn('wallet mirror failed', e)
  }
}

// Keep the wallet payment of a B2B-billed order equal to its net: top up or give back the difference.
async function syncWalletPayment(order: Order, target: number, user: UserProfile) {
  const snap = await getDocs(ledgerCol(order.id))
  const walletPaid = snap.docs
    .map((d) => d.data() as LedgerEntry)
    .filter((e) => e.mode === 'wallet')
    .reduce((n, e) => n + e.amount, 0)
  const delta = target - walletPaid
  if (delta === 0) return
  await addDoc(ledgerCol(order.id), {
    branchId: order.branchId || 'main',
    type: delta > 0 ? 'payment' : 'refund',
    mode: 'wallet',
    amount: delta,
    reference: order.b2bCentreName ?? '',
    remark: 'B2B bill edited',
    lineIds: [],
    postedBy: user.uid,
    postedByName: user.name,
    postedAt: serverTimestamp(),
  })
}

// Edit a saved bill. Appends to the append-only `revisions` trail, then re-derives money.
// Collected / received / resulted lines cannot be removed. Changing the B2B centre moves the
// wallet debit: the old centre is credited back, the new one debited at the new net.
export async function editOrder(order: Order, input: EditOrderInput, user: UserProfile, settings: LabSettings) {
  const frozen = await b2bEditLockReason(order)
  if (frozen) throw new Error(frozen)
  const keep = new Set(input.items.map((i) => i.lineId))
  const blocked = order.items.filter((i) => !keep.has(i.lineId) && lineLocked(i))
  if (blocked.length) throw new Error(`${blocked.map((i) => i.name).join(', ')} already collected or resulted and cannot be removed. Use refund.`)
  const before = computeTotals(order.items)
  const after = computeTotals(input.items)
  const rev: OrderRevision = {
    at: Timestamp.now(),
    by: user.uid,
    byName: user.name,
    summary: input.summary,
    before: { ...before, items: order.items.length },
    after: { ...after, items: input.items.length },
  }
  const { items, summary, ...rest } = input
  void summary
  const refChanged = (input.referrerId ?? undefined) !== (order.referrerId ?? undefined)
  const pro = refChanged ? await proOf(input.referrerId) : {}
  const centreChanged = (input.b2bCentreId ?? undefined) !== (order.b2bCentreId ?? undefined)
  let billedTo = order.billedTo
  if (centreChanged) billedTo = input.b2bCentreId ? 'b2b' : 'patient'
  const patch: Record<string, unknown> = clean({
    ...rest,
    items,
    ...after,
    billedTo,
    ...(refChanged ? { proId: pro.proId ?? '', proName: pro.proName ?? '' } : {}),
    revisions: arrayUnion(rev),
  })
  if (!input.b2bCentreId) {
    patch.b2bCentreId = deleteField()
    patch.b2bCentreName = deleteField()
  }
  // Optimistic lock: if someone else saved this bill since it was opened, refuse (409-style).
  const orderRef = docRef<Order>(paths.orders, order.id)
  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(orderRef)
    if (fresh.exists() && (fresh.data().rev ?? 0) !== (order.rev ?? 0)) {
      throw new Error('This bill was changed by someone else while you were editing. Close and reopen it to see the latest version.')
    }
    tx.update(orderRef, { ...patch, rev: (order.rev ?? 0) + 1 })
  })

  // B2B wallet: reverse on the old centre, debit the new one (or the same one at the new net).
  const wasB2b = order.billedTo === 'b2b' && !!order.b2bCentreId
  const isB2b = billedTo === 'b2b' && !!input.b2bCentreId
  if (wasB2b && (centreChanged || !isB2b)) {
    await walletMirror(order.b2bCentreId!, order.b2bCentreName ?? '', before.net, order, `Bill ${order.billNo} moved off this centre`, user)
  }
  if (isB2b && (centreChanged || !wasB2b)) {
    await walletMirror(input.b2bCentreId!, input.b2bCentreName ?? '', -after.net, order, `Bill ${order.billNo} (repriced)`, user)
  } else if (isB2b && after.net !== before.net) {
    await walletMirror(input.b2bCentreId!, input.b2bCentreName ?? order.b2bCentreName ?? '', before.net - after.net, order, `Bill ${order.billNo} edited`, user)
  }
  if (wasB2b || isB2b) await syncWalletPayment({ ...order, b2bCentreName: input.b2bCentreName ?? order.b2bCentreName }, isB2b ? Math.max(0, after.net - (order.payer?.amount ?? 0)) : 0, user)
  await recomputeOrder(order.id, settings)
  void logActivity('billEdit', `Bill ${order.billNo} edited: ${input.summary}`, `orders/${order.id}`, { category: 'BILLING', actor: user, before: { ...before, items: order.items.length }, after: { ...after, items: input.items.length } })
}

// Keys that may change a bill's paid / due / refunded / totals (mirrors firestore.rules billMoneyPerms).
const MONEY_KEYS = ['payment.collect', 'billing.clearDue', 'billing.refund', 'billing.reverse', 'billing.void', 'billing.edit', 'billing.discount'] as const

// Re-derive money and report status from the ledger and results.
// Called after every payment, refund, approval or un-approval.
export async function recomputeOrder(orderId: string, settings: LabSettings): Promise<void> {
  const [ledgerSnap, resultSnap] = await Promise.all([
    getDocs(ledgerCol(orderId)),
    getDocs(resultsCol(orderId)),
  ])
  const ledger = ledgerSnap.docs.map((d) => d.data() as LedgerEntry)
  const approved = new Set(
    resultSnap.docs.map((d) => d.data() as TestResult).filter((r) => r.status === 'approved').map((r) => r.testId),
  )
  const rejected = new Set(
    resultSnap.docs.map((d) => d.data() as { status: string; testId: string }).filter((r) => r.status === 'rejected').map((r) => r.testId),
  )
  const provisional = new Set(
    resultSnap.docs
      .map((d) => d.data() as { status: string; testId: string; releaseType?: string })
      .filter((r) => r.status === 'approved' && r.releaseType === 'provisional')
      .map((r) => r.testId),
  )
  const active = new Set(
    resultSnap.docs
      .map((d) => d.data() as { status: string; testId: string; rerun?: boolean })
      .filter((r) => r.status === 'hold' || (!!r.rerun && r.status !== 'approved' && r.status !== 'rejected'))
      .map((r) => r.testId),
  )
  const ref = docRef<Order>(paths.orders, orderId)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) return
    const order = snap.data()
    const totals = computeTotals(order.items)
    const { paid, refunded } = ledgerSums(ledger)
    const due = dueAmount(totals.net - (order.payer?.amount ?? 0), paid)
    const reportStatus = deriveReportStatus({ items: order.items, due }, approved, settings.finalRequiresPayment, rejected, provisional, active)
    // Money fields are derived from the ledger. firestore.rules lets only a key that posts to the ledger move them,
    // so a user who only saves or approves results (no payment / refund / edit key) leaves them as they are.
    const mayMoveMoney = MONEY_KEYS.some((k) => canNow(k))
    tx.update(ref, {
      ...(mayMoveMoney ? { ...totals, paid, refunded, due } : {}),
      reportStatus,
      reportedAt: reportStatus === 'final' && !order.reportedAt ? serverTimestamp() : order.reportedAt,
      // Flabs: the printed Report Date is the time of the first approval on the bill and does not move afterwards.
      ...(approved.size > 0 && !(order as { firstApprovedAt?: unknown }).firstApprovedAt ? { firstApprovedAt: serverTimestamp() } : {}),
    })
  })
}

// Every receipt after billing is tagged as due clearance (partial or full). Over-collection and
// a missing transaction ID on a non-cash mode are rejected here as well as in the forms.
export async function clearDue(
  order: Order,
  payments: NewPayment[],
  remark: string,
  user: UserProfile,
  settings: LabSettings,
) {
  const live = payments.filter((x) => x.amount > 0)
  const total = live.reduce((n, x) => n + x.amount, 0)
  if (total > order.due) throw new Error('Amount is more than the due balance.')
  const noRef = live.find((p) => needsReference(p.mode) && !p.reference.trim())
  if (noRef) throw new Error('Enter the transaction ID for non-cash payments.')
  const receiptNo = live.length ? await nextReceiptNo().catch(() => undefined) : undefined
  for (const p of live) {
    await addDoc(ledgerCol(order.id), {
      branchId: order.branchId || 'main',
      ...(receiptNo ? { receiptNo } : {}),
      shift: shiftOf(),
      type: 'clearDue',
      mode: p.mode,
      amount: p.amount,
      reference: p.reference,
      remark,
      lineIds: [],
      ...(p.paidAt ? { backdatedTo: Timestamp.fromDate(p.paidAt) } : {}),
      postedBy: user.uid,
      postedByName: user.name,
      postedAt: serverTimestamp(),
    })
  }
  // The remark stays on the Due list until the bill is cleared; a later clear with no remark keeps the earlier one.
  const remaining = Math.max(0, order.due - total)
  await updateDoc(docRef(paths.orders, order.id), { dueRemark: remaining > 0 ? remark || (order as { dueRemark?: string }).dueRemark || '' : '' })
  await recomputeOrder(order.id, settings)
  void logActivity('clearDue', `Due cleared on bill ${order.billNo}: Rs ${(total / 100).toFixed(2)} received from ${order.patientName}`, `orders/${order.id}`, { category: 'BILLING', actor: user, after: { received: total, due: Math.max(0, order.due - total) }, before: { due: order.due } })
}

// Oldest bill first, as the allocation order for a lump-sum payment.
const billTime = (o: Order) => (o.billDate ?? o.createdAt)?.toMillis?.() ?? 0

// Bulk clear due: one set of payment rows (mode + reference + amount) is allocated across the
// selected bills oldest-first, each bill taking up to its own due. Returns what was applied per bill.
export async function clearDueBulk(
  orders: Order[],
  payments: NewPayment[],
  remark: string,
  user: UserProfile,
  settings: LabSettings,
): Promise<{ orderId: string; billNo: string; amount: number }[]> {
  const pool = payments.filter((p) => p.amount > 0).map((p) => ({ ...p }))
  const total = pool.reduce((n, p) => n + p.amount, 0)
  const totalDue = orders.reduce((n, o) => n + o.due, 0)
  if (total <= 0) throw new Error('Enter an amount to collect.')
  if (total > totalDue) throw new Error('Amount is more than the total due on the selected bills.')
  const sorted = [...orders].filter((o) => o.due > 0).sort((a, b) => billTime(a) - billTime(b))
  const applied: { orderId: string; billNo: string; amount: number }[] = []
  let cursor = 0
  for (const o of sorted) {
    let need = o.due
    const parts: NewPayment[] = []
    while (need > 0 && cursor < pool.length) {
      const take = Math.min(need, pool[cursor].amount)
      parts.push({ mode: pool[cursor].mode, reference: pool[cursor].reference, amount: take, paidAt: pool[cursor].paidAt })
      pool[cursor].amount -= take
      need -= take
      if (pool[cursor].amount === 0) cursor++
    }
    if (parts.length === 0) break
    await clearDue(o, parts, remark, user, settings)
    applied.push({ orderId: o.id, billNo: o.billNo, amount: parts.reduce((n, p) => n + p.amount, 0) })
  }
  void logActivity('clearDue', `Bulk clear due: Rs ${(total / 100).toFixed(2)} across ${applied.length} bill(s)`, 'orders', { category: 'BILLING', actor: user })
  return applied
}

// Undo a payment: appends a negative "reversal" entry pointing at the original (the ledger stays
// append-only). Only payment and clear-due entries that have not been reversed already.
export async function reversePayment(
  order: Order,
  entry: LedgerEntry,
  reason: string,
  user: UserProfile,
  settings: LabSettings,
) {
  if (entry.type !== 'payment' && entry.type !== 'clearDue') throw new Error('Only payments can be reversed.')
  if (!reason.trim()) throw new Error('Enter a reason for the reversal.')
  const snap = await getDocs(query(ledgerCol(order.id), where('reversesId', '==', entry.id)))
  if (!snap.empty) throw new Error('This payment has already been reversed.')
  await addDoc(ledgerCol(order.id), {
    branchId: order.branchId || 'main',
    type: 'reversal',
    mode: entry.mode,
    amount: -entry.amount,
    reference: entry.reference,
    remark: reason.trim(),
    lineIds: [],
    reversesId: entry.id,
    shift: shiftOf(),
    postedBy: user.uid,
    postedByName: user.name,
    postedAt: serverTimestamp(),
  })
  await recomputeOrder(order.id, settings)
  void logActivity('paymentReversal', `Payment of Rs ${(entry.amount / 100).toFixed(2)} (${entry.mode}) reversed on bill ${order.billNo}: ${reason.trim()}`, `orders/${order.id}`, { category: 'BILLING', actor: user, reason: reason.trim(), before: { amount: entry.amount, mode: entry.mode } })
}

// Refund whole lines at their net value. The lines stay on the bill marked
// "refunded", and the ledger gets one negative entry (append-only) carrying a refund number.
// Above the lab's approval threshold a non-manager only files a request (order.refundPendingApproval);
// a manager or admin approves it with approveRefund. Returns 'paid' or 'requested'.
export async function refundLines(
  order: Order,
  lineIds: string[],
  mode: PaymentMode,
  reason: string,
  user: UserProfile,
  settings: LabSettings,
  opts: { approved?: boolean } = {},
): Promise<'paid' | 'requested'> {
  const lines = order.items.filter((i) => lineIds.includes(i.lineId) && i.status !== 'refunded')
  const amount = lines.reduce((s, i) => s + lineNet(i), 0)
  if (amount <= 0) return 'paid'
  const threshold = settings.frontDesk?.refundApprovalThreshold ?? 0
  const privileged = ['labAdmin', 'admin', 'manager'].includes(user.role)
  if (threshold > 0 && amount > threshold && !privileged && !opts.approved) {
    if (order.refundPendingApproval) throw new Error('A refund is already waiting for approval on this bill.')
    await updateDoc(docRef(paths.orders, order.id), {
      refundPendingApproval: { amount, lineIds: lines.map((l) => l.lineId), mode, reason, requestedBy: user.uid, requestedByName: user.name, requestedAt: Timestamp.now() },
    })
    void logActivity('refund', `Refund of Rs ${(amount / 100).toFixed(2)} requested on bill ${order.billNo}: ${reason || 'no reason'}`, `orders/${order.id}`, { category: 'REFUND', actor: user, reason })
    return 'requested'
  }
  const refundNo = await nextRefundNo()
  await addDoc(ledgerCol(order.id), {
    branchId: order.branchId || 'main',
    type: 'refund',
    mode,
    amount: -amount,
    reference: '',
    remark: reason,
    lineIds,
    refundNo,
    status: 'paid',
    shift: shiftOf(),
    postedBy: user.uid,
    postedByName: user.name,
    postedAt: serverTimestamp(),
  })
  await updateDoc(docRef(paths.orders, order.id), {
    items: order.items.map((i) => (lineIds.includes(i.lineId) ? { ...i, status: 'refunded' } : i)),
    refundPendingApproval: deleteField(),
  })
  if (mode === 'wallet' && order.b2bCentreId) {
    await walletMirror(order.b2bCentreId, order.b2bCentreName ?? '', amount, order, `Refund ${refundNo} on bill ${order.billNo}`, user)
  }
  // Inventory: stock consumed for the refunded tests goes back. Commission follows the bill's live
  // net (refunded lines drop out of computeTotals), so nothing extra is stored for it.
  try {
    await reverseConsumptionForOrder(order, user.name || user.uid, lines.flatMap((i) => i.testIds))
  } catch (err) {
    console.warn('Inventory reversal failed', err)
  }
  await recomputeOrder(order.id, settings)
  void logActivity('refund', `Refund ${refundNo} on bill ${order.billNo}: Rs ${(amount / 100).toFixed(2)} (${reason || 'no reason'})`, `orders/${order.id}`, { category: 'REFUND', actor: user, reason, after: { refundNo, amount } })
  return 'paid'
}

// A manager or admin approves the refund a colleague requested; the refund is then posted.
export async function approveRefund(order: Order, user: UserProfile, settings: LabSettings) {
  const req = order.refundPendingApproval
  if (!req) throw new Error('There is no refund waiting for approval.')
  if (!['labAdmin', 'admin', 'manager'].includes(user.role)) throw new Error('Only a manager or admin can approve a refund.')
  return refundLines(order, req.lineIds, req.mode, `${req.reason} (requested by ${req.requestedByName}, approved by ${user.name})`, user, settings, { approved: true })
}

export async function rejectRefund(order: Order, user: UserProfile) {
  if (!order.refundPendingApproval) return
  if (!['labAdmin', 'admin', 'manager'].includes(user.role)) throw new Error('Only a manager or admin can reject a refund.')
  await updateDoc(docRef(paths.orders, order.id), { refundPendingApproval: deleteField() })
  void logActivity('refund', `Refund request of Rs ${(order.refundPendingApproval.amount / 100).toFixed(2)} rejected on bill ${order.billNo}`, `orders/${order.id}`, { category: 'REFUND', actor: user })
}

// Write off (part of) the balance as a discount adjustment: the amount is spread over the lines that
// still have room (price minus discount), pro rata, and the bill gets a revision entry and a write-off row.
export async function writeOffDue(order: Order, amount: number, reason: string, user: UserProfile, settings: LabSettings) {
  if (!reason.trim()) throw new Error('Enter a reason for the write-off.')
  if (amount <= 0) throw new Error('Enter an amount to write off.')
  if (amount > order.due) throw new Error('Write-off is more than the due balance.')
  const live = order.items.filter((i) => i.status !== 'refunded' && !i.isCharge)
  const room = live.map((i) => Math.max(0, i.price - i.discount))
  const totalRoom = room.reduce((n, v) => n + v, 0)
  if (totalRoom < amount) throw new Error('The discount room on the lines is smaller than the amount.')
  const shares = room.map((r) => Math.floor((r * amount) / totalRoom))
  let rest = amount - shares.reduce((n, v) => n + v, 0)
  for (let k = 0; rest > 0 && k < shares.length; k++) {
    const add = Math.min(rest, room[k] - shares[k])
    shares[k] += add
    rest -= add
  }
  const share = new Map(live.map((i, k) => [i.lineId, shares[k]]))
  const items = order.items.map((i) => (share.has(i.lineId) ? { ...i, discount: i.discount + (share.get(i.lineId) ?? 0) } : i))
  const before = computeTotals(order.items)
  const after = computeTotals(items)
  const rev: OrderRevision = {
    at: Timestamp.now(), by: user.uid, byName: user.name,
    summary: `Write-off Rs ${(amount / 100).toFixed(2)}: ${reason.trim()}`,
    before: { ...before, items: order.items.length }, after: { ...after, items: items.length },
  }
  await updateDoc(docRef(paths.orders, order.id), {
    items,
    ...after,
    writeOffs: arrayUnion({ amount, reason: reason.trim(), by: user.uid, byName: user.name, at: Timestamp.now() }),
    revisions: arrayUnion(rev),
  })
  await recomputeOrder(order.id, settings)
  void logActivity('writeOff', `Rs ${(amount / 100).toFixed(2)} written off on bill ${order.billNo}: ${reason.trim()}`, `orders/${order.id}`, { category: 'BILLING', actor: user, reason: reason.trim(), before, after })
}

export async function setItemsStatus(order: Order, lineIds: string[], status: OrderItem['status']) {
  const patch: Record<string, unknown> = {
    items: order.items.map((i) => (lineIds.includes(i.lineId) ? { ...i, status } : i)),
  }
  if (status === 'collected' && !order.collectedAt) patch.collectedAt = serverTimestamp()
  if (status === 'received') {
    if (!order.collectedAt) patch.collectedAt = serverTimestamp()
    if (!order.receivedAt) patch.receivedAt = serverTimestamp()
  }
  await updateDoc(docRef(paths.orders, order.id), patch)

  // Auto-consume mapped stock for lines newly received. Inventory problems (missing
  // permission, no stock) must never block sample receipt.
  if (status === 'received') {
    try {
      const testIds = order.items
        .filter((i) => lineIds.includes(i.lineId) && i.status !== 'received')
        .flatMap((i) => i.testIds)
      const by = auth.currentUser?.displayName || auth.currentUser?.email || auth.currentUser?.uid || 'system'
      await autoConsumeForTests(order, testIds, by, 'receipt')
    } catch (err) {
      console.warn('Inventory auto-consumption failed', err)
    }
  }
}

export async function markDispatched(
  order: Order,
  mode: DispatchMode,
  extra?: { receiverName?: string; trackingNo?: string },
) {
  const dispatch = order.dispatch.map((d) =>
    d.mode === mode ? { ...d, delivered: true, deliveredAt: new Date(), ...(extra?.receiverName ? { receiverName: extra.receiverName } : {}), ...(extra?.trackingNo ? { trackingNo: extra.trackingNo } : {}) } : d,
  )
  // Dispatched once every selected mode has been delivered.
  const all = dispatch.length > 0 && dispatch.every((d) => d.delivered)
  await updateDoc(docRef(paths.orders, order.id), {
    dispatch,
    dispatched: all,
    // Which approved lines this delivery covered: tests approved later put the bill back in Pending Dispatch.
    ...(all ? { dispatchedLineIds: order.items.filter((i) => i.status === 'approved').map((i) => i.lineId) } : {}),
    dispatchStatus: all ? 'dispatched' : dispatch.some((d) => d.delivered) ? 'partial' : 'pending',
  })
}

// Voiding replaces hard delete: the bill is hidden from lists but kept for audit.
// Money already collected is either refunded straight away (one refund entry per payment mode,
// so the ledger nets to zero) or, with `refundNow: false`, left flagged on the bill as
// "refund pending" for the front desk to pay out. The B2B wallet debit is reversed.
export async function voidOrder(
  order: Order,
  reason: string,
  user: UserProfile,
  opts: { refundNow?: boolean; reasonRequired?: boolean } = {},
) {
  const refundNow = opts.refundNow ?? true
  if (opts.reasonRequired && !reason.trim()) throw new Error('Enter a reason for deleting the bill.')
  const snap = await getDocs(ledgerCol(order.id))
  const entries = snap.docs.map((d) => d.data() as LedgerEntry)
  const byMode = new Map<string, number>()
  for (const e of entries) byMode.set(e.mode, (byMode.get(e.mode) ?? 0) + e.amount)
  const owed = [...byMode.entries()].filter(([, v]) => v > 0)
  const totalOwed = owed.reduce((n, [, v]) => n + v, 0)
  const isWallet = order.billedTo === 'b2b'
  const pending = totalOwed > 0 && !refundNow && !isWallet ? totalOwed : 0
  // The bill is marked deleted first: the security rules accept the pay-back entries below (which a user with
  // only the void permission posts) because the bill is already voided.
  await updateDoc(docRef(paths.orders, order.id), {
    deleted: true,
    voidReason: reason,
    voidedBy: user.uid,
    voidedByName: user.name,
    voidedAt: serverTimestamp(),
    // The barcode no longer resolves to a live sample and commission on the bill is reversed
    // (commission is derived from live bills, so these flags make the reversal explicit and auditable).
    barcodeVoided: true,
    voidedBarcode: order.barcode,
    commissionReversed: true,
    commissionReversedAt: serverTimestamp(),
    ...(pending > 0 ? { voidRefundPending: pending } : { paid: 0, due: 0 }),
  })
  if (totalOwed > 0 && (refundNow || isWallet)) {
    for (const [mode, amount] of owed) {
      await addDoc(ledgerCol(order.id), {
        branchId: order.branchId || 'main',
        type: 'refund',
        mode,
        amount: -amount,
        reference: '',
        remark: `Bill deleted: ${reason.trim() || 'no reason'}`,
        lineIds: [],
        shift: shiftOf(),
        postedBy: user.uid,
        postedByName: user.name,
        postedAt: serverTimestamp(),
      })
    }
  }
  if (order.billedTo === 'b2b' && order.b2bCentreId) {
    await walletMirror(order.b2bCentreId, order.b2bCentreName ?? '', order.net, order, `Bill ${order.billNo} deleted`, user)
  }
  try {
    await reverseConsumptionForOrder(order, user.name || user.uid)
  } catch (err) {
    console.warn('Inventory reversal failed', err)
  }
  const money = totalOwed > 0 ? (pending > 0 ? `; refund of Rs ${(pending / 100).toFixed(2)} pending` : `; Rs ${(totalOwed / 100).toFixed(2)} refunded`) : ''
  void logActivity('billDelete', `Bill ${order.billNo} deleted by ${user.name}: ${reason || 'no reason'}${money}; barcode ${order.barcode || '-'} voided${order.referrerId || order.hospitalId ? '; commission reversed' : ''}`, `orders/${order.id}`, { category: 'DELETE', actor: user, reason, before: { net: order.net, paid: order.paid, due: order.due } })
}

// Mark the pending refund of a voided bill as paid out.
export async function settleVoidRefund(order: Order, mode: PaymentMode, user: UserProfile) {
  const owed = order.voidRefundPending ?? 0
  if (owed <= 0) return
  await addDoc(ledgerCol(order.id), {
    branchId: order.branchId || 'main',
    type: 'refund',
    mode,
    amount: -owed,
    reference: '',
    remark: 'Refund of deleted bill paid out',
    lineIds: [],
    shift: shiftOf(),
    postedBy: user.uid,
    postedByName: user.name,
    postedAt: serverTimestamp(),
  })
  await updateDoc(docRef(paths.orders, order.id), { voidRefundPending: 0, paid: 0, due: 0 })
  void logActivity('refund', `Refund of Rs ${(owed / 100).toFixed(2)} paid out on deleted bill ${order.billNo}`, `orders/${order.id}`, { category: 'REFUND', actor: user })
}

// Re-open a quotation-style helper: count a receipt print (bill printed N times -> DUPLICATE from 2nd).
export async function countBillPrint(order: Pick<Order, 'id' | 'billPrints'>) {
  await updateDoc(docRef(paths.orders, order.id), { billPrints: (order.billPrints ?? 0) + 1 })
}

// `permissions` is computed from role + grants - denies on the client; never stored.
export async function saveUserProfile(profile: Omit<UserProfile, 'permissions'> & { permissions?: string[] }) {
  const { permissions: _computed, ...stored } = profile
  void _computed
  await setDoc(doc(db, 'labs', profile.labId, 'users', profile.uid), stored)
}
