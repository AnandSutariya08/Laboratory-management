import { createHmac, timingSafeEqual } from 'node:crypto'
import { defineSecret } from 'firebase-functions/params'
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError, onCall, onRequest, type CallableRequest } from 'firebase-functions/v2/https'
import { REGION, FIRESTORE_DB, clean } from './secrets'
import * as core from './index'

// Online payments through Razorpay's REST API (no SDK). Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and
// RAZORPAY_WEBHOOK_SECRET. Without them the app shows "Online payment is not set up" and nothing else changes.
//
// Flow: the app calls createPaymentOrder (writes labs/{lab}/payments/{razorpayOrderId}, status 'created'),
// opens Razorpay Checkout, then calls verifyPayment with the signature. The webhook does the same job for
// payments the browser never reported back. Both go through applyPayment, which claims the payment doc in a
// transaction first, so a payment is posted exactly once. What "posted" means depends on the purpose:
//   bill        a normal ledger payment on the bill (type clearDue, mode online, reference = payment id)
//   b2bTopup    an approved wallet top-up on the centre's wallet statement
//   booking     the booking's prepaid amount (prepaidMode online)
//   credits     credits added to the lab's credit wallet (+ ledger row)

const KEY_ID = defineSecret('RAZORPAY_KEY_ID')
const KEY_SECRET = defineSecret('RAZORPAY_KEY_SECRET')
const WEBHOOK_SECRET = defineSecret('RAZORPAY_WEBHOOK_SECRET')
const SECRETS = [KEY_ID, KEY_SECRET, WEBHOOK_SECRET]
const sec = (s: { value(): string }) => {
  try {
    return clean(s.value())
  } catch {
    return ''
  }
}

const db = () => getFirestore(FIRESTORE_DB)
const LAB_ID_RE = /^[\w-]{1,64}$/
const MIN_PAISE = 100 // Re 1
const MAX_PAISE = 50_000_000 // Rs 5,00,000 per payment

export const CREDIT_PACKS = [
  { id: 'c100', credits: 100, amount: 50_000 },
  { id: 'c500', credits: 500, amount: 225_000 },
  { id: 'c1000', credits: 1000, amount: 400_000 },
] as const

export type Purpose = 'bill' | 'b2bTopup' | 'booking' | 'credits'
const PURPOSES: Purpose[] = ['bill', 'b2bTopup', 'booking', 'credits']
const PARTNER_ROLES = ['b2b', 'collectionCentre', 'corporate', 'referrer']
// order field linking a bill to the partner of each portal role
const ORDER_FIELD: Record<string, string> = { b2b: 'b2bCentreId', collectionCentre: 'collectionCentreId', corporate: 'corporateClientId', referrer: 'referrerId' }

const configured = () => !!(sec(KEY_ID) && sec(KEY_SECRET))
const auth = () => 'Basic ' + Buffer.from(`${sec(KEY_ID)}:${sec(KEY_SECRET)}`).toString('base64')

interface Who {
  uid: string
  name: string
  role: string
  partnerId: string
  denies: string[]
  active: boolean
}
async function whoAmI(request: CallableRequest<unknown>, labId: unknown): Promise<Who> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
  if (typeof labId !== 'string' || !LAB_ID_RE.test(labId)) throw new HttpsError('invalid-argument', 'labId is required.')
  const u = (await db().doc(`labs/${labId}/users/${request.auth.uid}`).get()).data()
  if (!u || u.active !== true) throw new HttpsError('permission-denied', 'You do not have permission to do this.')
  return { uid: request.auth.uid, name: String(u.name ?? request.auth.token.email ?? ''), role: String(u.role ?? ''), partnerId: String(u.partnerId ?? ''), denies: (u.denies ?? []) as string[], active: true }
}

// ---- config -------------------------------------------------------------------------------------------------------

export const getPaymentConfig = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const data = (request.data ?? {}) as { labId?: string }
  await whoAmI(request, data.labId)
  return { configured: configured(), keyId: configured() ? sec(KEY_ID) : '', packs: CREDIT_PACKS }
})

// ---- create order ---------------------------------------------------------------------------------------------------

interface Prepared { amount: number; branchId: string; label: string; receipt: string; notes: Record<string, string>; meta: DocumentData }

async function prepare(labId: string, who: Who, d: { purpose: Purpose; refId: string; amount?: number; packId?: string; branchId?: string }, request: CallableRequest<unknown>): Promise<Prepared> {
  const partner = PARTNER_ROLES.includes(who.role)
  if (d.purpose === 'bill') {
    const snap = await db().doc(`labs/${labId}/orders/${d.refId}`).get()
    const o = snap.data()
    if (!o || o.deleted) throw new HttpsError('not-found', 'Bill not found.')
    if (partner) {
      if (who.denies.includes('portal.clearDue')) throw new HttpsError('permission-denied', 'You do not have permission to pay dues.')
      const field = ORDER_FIELD[who.role]
      const own = o[field] === who.partnerId || (who.role === 'referrer' && o.hospitalId === who.partnerId)
      if (!own || !who.partnerId) throw new HttpsError('permission-denied', 'This bill does not belong to your organisation.')
    } else {
      await core.requirePerm(request, labId, ['payment.collect', 'billing.clearDue', 'registration.create'])
    }
    const due = Number(o.due) || 0
    const amount = Math.round(Number(d.amount) || due)
    if (amount < MIN_PAISE) throw new HttpsError('invalid-argument', 'This bill has nothing due.')
    if (amount > due) throw new HttpsError('invalid-argument', 'The amount is more than the balance due on this bill.')
    return { amount, branchId: String(o.branchId ?? 'main'), label: `Bill ${o.billNo}`, receipt: `bill-${o.billNo}`, notes: { billNo: String(o.billNo ?? '') }, meta: { orderId: snap.id, billNo: o.billNo } }
  }
  if (d.purpose === 'b2bTopup') {
    const c = (await db().doc(`labs/${labId}/b2bCentres/${d.refId}`).get()).data()
    if (!c) throw new HttpsError('not-found', 'B2B centre not found.')
    if (partner) {
      if (who.role !== 'b2b' || who.partnerId !== d.refId) throw new HttpsError('permission-denied', 'You can only top up your own wallet.')
    } else {
      await core.requirePerm(request, labId, ['b2b.manage'])
    }
    const amount = Math.round(Number(d.amount))
    if (!(amount >= MIN_PAISE)) throw new HttpsError('invalid-argument', 'Enter an amount of at least Re 1.')
    if (amount > MAX_PAISE) throw new HttpsError('invalid-argument', 'The amount is above the online limit of Rs 5,00,000.')
    return { amount, branchId: String(d.branchId || 'main'), label: `Wallet top-up ${c.name}`, receipt: `topup-${d.refId.slice(0, 20)}`, notes: { centreName: String(c.name ?? '') }, meta: { centreId: d.refId, centreName: c.name ?? '', requestedByPartner: partner } }
  }
  if (d.purpose === 'booking') {
    if (partner) throw new HttpsError('permission-denied', 'You do not have permission to do this.')
    await core.requirePerm(request, labId, ['bookings.create'])
    const b = (await db().doc(`labs/${labId}/bookings/${d.refId}`).get()).data()
    if (!b) throw new HttpsError('not-found', 'Booking not found.')
    const total = Math.max(0,
      ((b.items ?? []) as { price?: number }[]).reduce((s, i) => s + (i.price ?? 0), 0) + (b.collectionCharge ?? 0) +
      ((b.otherCharges ?? []) as { price?: number }[]).reduce((s, c) => s + (c.price ?? 0), 0) - (b.discount ?? 0))
    const balance = total - (b.prepaid ?? 0)
    const amount = Math.round(Number(d.amount) || balance)
    if (amount < MIN_PAISE || balance <= 0) throw new HttpsError('invalid-argument', 'This booking has nothing left to pay.')
    if (amount > balance) throw new HttpsError('invalid-argument', 'The amount is more than the booking balance.')
    return { amount, branchId: String(b.branchId ?? 'main'), label: `Booking ${b.bookingNo}`, receipt: `bk-${b.bookingNo}`, notes: { bookingNo: String(b.bookingNo ?? '') }, meta: { bookingId: d.refId, bookingNo: b.bookingNo } }
  }
  // credits
  if (partner) throw new HttpsError('permission-denied', 'You do not have permission to do this.')
  await core.requirePerm(request, labId, ['settings.manage'])
  const pack = CREDIT_PACKS.find((p) => p.id === d.packId)
  if (!pack) throw new HttpsError('invalid-argument', 'Choose a credit pack.')
  return { amount: pack.amount, branchId: 'main', label: `${pack.credits} credits`, receipt: `credits-${pack.id}`, notes: { credits: String(pack.credits) }, meta: { packId: pack.id, credits: pack.credits } }
}

export const createPaymentOrder = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const d = (request.data ?? {}) as { labId?: string; purpose?: Purpose; refId?: string; amount?: number; packId?: string; branchId?: string }
  const who = await whoAmI(request, d.labId)
  const labId = d.labId as string
  if (!configured()) throw new HttpsError('failed-precondition', 'Online payment is not set up.')
  if (!d.purpose || !PURPOSES.includes(d.purpose)) throw new HttpsError('invalid-argument', 'purpose is invalid.')
  if (d.purpose !== 'credits' && (typeof d.refId !== 'string' || !d.refId || d.refId.includes('/'))) throw new HttpsError('invalid-argument', 'refId is required.')
  const p = await prepare(labId, who, { purpose: d.purpose, refId: d.refId ?? '', amount: d.amount, packId: d.packId, branchId: d.branchId }, request)

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: p.amount, currency: 'INR', receipt: p.receipt.slice(0, 40), notes: { labId, purpose: d.purpose, refId: d.refId ?? '', ...p.notes } }),
  })
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { description?: string } }
  if (!res.ok || !body.id) throw new HttpsError('internal', `The payment gateway refused the order: ${body.error?.description ?? res.status}`)
  await db().doc(`labs/${labId}/payments/${body.id}`).set({
    purpose: d.purpose, refId: d.refId ?? '', amount: p.amount, currency: 'INR', label: p.label, branchId: p.branchId, meta: p.meta,
    status: 'created', by: who.uid, byName: who.name, byRole: who.role, createdAt: FieldValue.serverTimestamp(),
  })
  return { orderId: body.id, keyId: sec(KEY_ID), amount: p.amount, currency: 'INR', label: p.label }
})

// ---- posting a verified payment ---------------------------------------------------------------------------------------

const financialYear = (d = new Date()) => {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`
}
const shiftOf = (d = new Date()) => (d.getHours() < 14 ? 'Morning' : d.getHours() < 21 ? 'Evening' : 'Night')
async function nextCounter(labId: string, name: string): Promise<number> {
  const ref = db().doc(`labs/${labId}/counters/${name}`)
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref)
    const v = ((s.exists ? s.data()?.value : 0) as number) + 1
    tx.set(ref, { value: v })
    return v
  })
}

// Re-derive paid / due / report status after a payment, like the web app's recomputeOrder.
async function recomputeOrder(labId: string, orderId: string) {
  const oref = db().doc(`labs/${labId}/orders/${orderId}`)
  const [ledger, results, lab, orderSnap] = await Promise.all([oref.collection('ledger').get(), oref.collection('results').get(), db().doc(`labs/${labId}`).get(), oref.get()])
  const o = orderSnap.data()
  if (!o) return
  const entries = ledger.docs.map((d) => d.data())
  const paid = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0)
  const refunded = -entries.filter((e) => e.type === 'refund').reduce((s, e) => s + (Number(e.amount) || 0), 0)
  const due = Math.max(0, (Number(o.net) || 0) - (Number(o.payer?.amount) || 0) - paid)
  const rs = results.docs.map((d) => d.data() as { status: string; testId: string; releaseType?: string })
  const approved = new Set(rs.filter((r) => r.status === 'approved').map((r) => r.testId))
  const rejected = new Set(rs.filter((r) => r.status === 'rejected').map((r) => r.testId))
  const provisional = new Set(rs.filter((r) => r.status === 'approved' && r.releaseType === 'provisional').map((r) => r.testId))
  const testIds = ((o.items ?? []) as DocumentData[]).filter((i) => i.status !== 'refunded' && i.status !== 'rejected').flatMap((i) => (i.testIds ?? []) as string[]).filter((t) => !rejected.has(t))
  let reportStatus = 'pending'
  if (testIds.length) {
    const n = testIds.filter((t) => approved.has(t)).length
    if (n === 0) reportStatus = 'pending'
    else if (n < testIds.length) reportStatus = 'partial'
    else if (lab.data()?.finalRequiresPayment && due > 0) reportStatus = 'provisional'
    else if (testIds.some((t) => provisional.has(t))) reportStatus = 'provisional'
    else reportStatus = 'final'
  }
  await oref.update({ paid, refunded, due, reportStatus, ...(reportStatus === 'final' && !o.reportedAt ? { reportedAt: FieldValue.serverTimestamp() } : {}) })
}

async function post(labId: string, p: DocumentData, rzpOrderId: string, paymentId: string): Promise<void> {
  const amount = Number(p.amount)
  if (p.purpose === 'bill') {
    const oref = db().doc(`labs/${labId}/orders/${p.refId}`)
    const o = (await oref.get()).data()
    if (!o) throw new Error('The bill no longer exists.')
    const receiptNo = `R${financialYear()}${String(await nextCounter(labId, `receipt-${financialYear()}`)).padStart(5, '0')}`
    await oref.collection('ledger').add({
      branchId: o.branchId ?? 'main', type: 'clearDue', mode: 'online', amount, reference: paymentId, remark: `Online payment (${rzpOrderId})`, lineIds: [],
      receiptNo, shift: shiftOf(), postedBy: p.by, postedByName: p.byName, postedAt: FieldValue.serverTimestamp(),
    })
    await recomputeOrder(labId, p.refId)
    await db().collection(`labs/${labId}/activity`).add({ type: 'clearDue', text: `Online payment of Rs ${(amount / 100).toFixed(2)} received on bill ${o.billNo}`, refPath: `orders/${p.refId}`, category: 'BILLING', at: FieldValue.serverTimestamp(), by: p.by, byName: p.byName, branchId: o.branchId ?? 'main' })
  } else if (p.purpose === 'b2bTopup') {
    await db().collection(`labs/${labId}/walletTxns`).add({
      branchId: p.branchId ?? 'main', centreId: p.meta.centreId, centreName: p.meta.centreName, kind: 'topup', mode: 'online', reference: paymentId, amount, status: 'approved',
      remark: 'Online top-up (payment gateway)', requestedByPartner: !!p.meta.requestedByPartner, gateway: true, by: p.by, byName: p.byName, at: FieldValue.serverTimestamp(),
    })
  } else if (p.purpose === 'booking') {
    const bref = db().doc(`labs/${labId}/bookings/${p.refId}`)
    await bref.update({
      prepaid: FieldValue.increment(amount), prepaidMode: 'online', paymentChannel: 'online', paymentRef: paymentId,
      events: FieldValue.arrayUnion({ at: new Date(), by: p.by, byName: p.byName, action: 'online payment', note: `Rs ${(amount / 100).toFixed(2)} paid online (${paymentId})` }),
    })
  } else if (p.purpose === 'credits') {
    const wref = db().doc(`labs/${labId}/aiCredits/wallet`)
    const credits = Number(p.meta.credits) || 0
    const after = await db().runTransaction(async (tx) => {
      const s = await tx.get(wref)
      const bal = ((s.exists ? s.data()?.balance : 0) as number) + credits
      tx.set(wref, { balance: bal, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      return bal
    })
    await db().collection(`labs/${labId}/aiCreditLedger`).add({ type: 'PURCHASE', credits, balanceAfter: after, paymentId, orderId: rzpOrderId, amount, by: p.by, byName: p.byName, at: FieldValue.serverTimestamp() })
  }
}

// Claim the payment doc (so it is posted once), then post it. Returns false when it was already posted.
async function applyPayment(labId: string, rzpOrderId: string, paymentId: string, via: 'verify' | 'webhook'): Promise<boolean> {
  const ref = db().doc(`labs/${labId}/payments/${rzpOrderId}`)
  const claimed = await db().runTransaction(async (tx) => {
    const s = await tx.get(ref)
    const d = s.data()
    if (!d) return null
    if (d.status === 'paid') return { ...d, already: true }
    tx.update(ref, { status: 'paid', paymentId, via, paidAt: FieldValue.serverTimestamp() })
    return { ...d, already: false }
  })
  if (!claimed) throw new HttpsError('not-found', 'Payment order not found.')
  if (claimed.already) return false
  try {
    await post(labId, claimed, rzpOrderId, paymentId)
    await ref.update({ posted: true })
  } catch (e) {
    // money was taken but could not be posted: keep the doc so staff can reconcile by hand
    await ref.update({ posted: false, postError: (e as Error).message })
    throw new HttpsError('internal', `Payment received (${paymentId}) but could not be posted: ${(e as Error).message}. Contact the lab.`)
  }
  return true
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export const verifyPayment = onCall({ region: REGION, secrets: SECRETS }, async (request) => {
  const d = (request.data ?? {}) as { labId?: string; razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string }
  const who = await whoAmI(request, d.labId)
  const labId = d.labId as string
  if (!configured()) throw new HttpsError('failed-precondition', 'Online payment is not set up.')
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = d
  if (!oid || !pid || !sig) throw new HttpsError('invalid-argument', 'The payment details are incomplete.')
  const snap = await db().doc(`labs/${labId}/payments/${oid}`).get()
  const pay = snap.data()
  if (!pay) throw new HttpsError('not-found', 'Payment order not found.')
  if (pay.by !== who.uid) throw new HttpsError('permission-denied', 'This payment was started by someone else.')
  const expected = createHmac('sha256', sec(KEY_SECRET)).update(`${oid}|${pid}`).digest('hex')
  if (!safeEqual(expected, sig)) {
    await snap.ref.update({ status: 'failed', failure: 'Signature mismatch' })
    throw new HttpsError('permission-denied', 'The payment could not be verified.')
  }
  const posted = await applyPayment(labId, oid, pid, 'verify')
  return { ok: true, posted, paymentId: pid }
})

// Razorpay webhook: payment.captured / order.paid. The signature is checked against the webhook secret.
export const razorpayWebhook = onRequest({ region: REGION, secrets: SECRETS }, async (req, res) => {
  const secret = sec(WEBHOOK_SECRET)
  if (!secret) { res.status(503).send('Webhook is not configured'); return }
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody
  const sig = String(req.get('x-razorpay-signature') ?? '')
  if (!raw || !sig || !safeEqual(createHmac('sha256', secret).update(raw).digest('hex'), sig)) { res.status(400).send('Bad signature'); return }
  try {
    const ev = JSON.parse(raw.toString('utf8')) as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; status?: string; notes?: Record<string, string> } } } }
    if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
      const e = ev.payload?.payment?.entity
      const labId = e?.notes?.labId
      if (e?.id && e.order_id && labId && LAB_ID_RE.test(labId)) await applyPayment(labId, e.order_id, e.id, 'webhook')
    }
    res.status(200).send('ok')
  } catch (e) {
    // a payment we never created (not-found) is acknowledged so Razorpay stops retrying; anything else retries
    if ((e as { code?: string }).code === 'not-found') { res.status(200).send('ignored'); return }
    res.status(500).send((e as Error).message)
  }
})
