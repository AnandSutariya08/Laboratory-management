// Firestore rules check for the permission matrix (src/auth/permissions.ts) against firestore.rules.
//
//   node scripts/rules-check.mjs
//
// Needs the emulators running (auth 9099, firestore 8080) with the named database "health-care-labs".
// What it does:
//   1. pushes the current firestore.rules into the running emulator (same as a rules hot reload; no restart),
//   2. creates test users (reception, technician, manager, doctor, admin, labAdmin, a reception user with a
//      grant, a manager with denies, a phlebotomist used for role-document variants) with the Admin SDK,
//   3. signs in as each one with the client SDK and attempts every guarded write; the expected result is
//      derived from effectivePermissions() in src/auth/permissions.ts, so a drift between the app and the
//      rules shows up as a FAIL,
//   4. runs the normal app flows as the right role and asserts they are ALLOWED,
//   5. checks the built-in role defaults and the implied-key table inside firestore.rules against permissions.ts,
//   6. cleans up everything it created and restores the role documents and the lab document.
// Test data uses the id prefix "zz-rc-" and is deleted at the end. It only ever talks to the emulators.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099'
if (!/^(127\.0\.0\.1|localhost)/.test(process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('Refusing to run against a non-local Firestore.')

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const { DEFAULT_ROLE_PERMISSIONS, effectivePermissions, IMPLIED_BY, ALL_PERMISSIONS, PERMISSIONS_V2 } = await import('../src/auth/permissions.ts')

const { initializeApp: adminInit } = await import('firebase-admin/app')
const { getAuth: adminAuth } = await import('firebase-admin/auth')
const { getFirestore: adminFirestore, FieldValue, Timestamp: ATimestamp } = await import('firebase-admin/firestore')
const { initializeApp } = await import('firebase/app')
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = await import('firebase/auth')
const fs_ = await import('firebase/firestore')
const { initializeFirestore, connectFirestoreEmulator, doc, collection, addDoc, setDoc, updateDoc, deleteDoc, getDoc, serverTimestamp, Timestamp, arrayUnion, deleteField } = fs_

const PROJECT = 'demo-health-care-labs'
const DB = 'health-care-labs'
const LAB = 'main'
const PFX = 'zz-rc-'

// ---------------------------------------------------------------------------------------------
// 1. push the rules file to the emulator
// ---------------------------------------------------------------------------------------------
const rulesText = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8')
{
  const r = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/${DB}:securityRules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ignore_errors: false, rules: { files: [{ name: 'security.rules', content: rulesText }] } }),
  })
  const body = await r.text()
  const issues = (() => { try { return JSON.parse(body).issues ?? [] } catch { return [] } })()
  const errs = issues.filter((i) => i.severity === 'ERROR')
  if (!r.ok || errs.length) {
    console.error('Rules failed to load:', body)
    process.exit(2)
  }
  for (const w of issues) console.log(`rules warning line ${w.sourcePosition?.line}: ${w.description}`)
}

// ---------------------------------------------------------------------------------------------
// 2. admin side: users, role documents, fixtures
// ---------------------------------------------------------------------------------------------
adminInit({ projectId: PROJECT })
const aauth = adminAuth()
const adb = adminFirestore(DB)
const labRef = adb.collection('labs').doc(LAB)
const lcol = (n) => labRef.collection(n)

const PASSWORD = 'rules-check-1'
// key: [role, grants, denies, active]
const USERS = {
  L: ['labAdmin', [], [], true],
  A: ['admin', [], [], true],
  M: ['manager', [], [], true],
  R: ['reception', [], [], true],
  T: ['technician', [], [], true],
  D: ['doctor', [], [], true],
  G: ['reception', ['billing.refund', 'catalogue.price'], [], true], // reception + grants
  X: ['manager', [], ['billing.void', 'billing.discount', 'results.enter'], true], // manager + denies
  P: ['phlebotomist', [], [], true], // role document variants are tried on this role
  I: ['manager', [], [], false], // inactive
}
const ORDER = Object.keys(USERS)
const LABEL = { L: 'labAdmin', A: 'admin', M: 'manager', R: 'reception', T: 'technician', D: 'doctor', G: 'reception+grant', X: 'manager+deny', P: 'phlebotomist', I: 'inactive mgr' }

const created = { auth: [], docs: [] } // docs: DocumentReference to delete at the end
const track = (ref) => { created.docs.push(ref); return ref }
const uidOf = (k) => `${PFX}${k.toLowerCase()}`
const emailOf = (k) => `${uidOf(k)}@rules-check.local`

// roles: remember what was there, write the defaults so every run starts from the same matrix
const ROLES = ['admin', 'manager', 'reception', 'technician', 'doctor', 'phlebotomist']
const roleBackup = {}
for (const r of ROLES) {
  const s = await lcol('roles').doc(r).get()
  roleBackup[r] = s.exists ? s.data() : null
}
const labBackup = (await labRef.get()).data() ?? null
async function setRoleDoc(role, permissions) {
  if (permissions === null) await lcol('roles').doc(role).delete()
  else await lcol('roles').doc(role).set({ name: role, builtIn: true, permissions })
  roleDoc[role] = permissions
}
const roleDoc = {} // role -> permissions array as stored now (undefined = no document)
const PAD = Number(process.env.RC_PAD || 0) // debugging aid: pad every role document to this many keys
const padded = (r) => { const l = [...DEFAULT_ROLE_PERMISSIONS[r]]; while (PAD && l.length < PAD) l.push(`zz.pad${l.length}`); return PAD ? l.slice(0, Math.max(PAD, 1)) : l }
for (const r of ROLES) await setRoleDoc(r, padded(r))

// bootstrap users
for (const k of ORDER) {
  const [role, grants, denies, active] = USERS[k]
  try { await aauth.deleteUser(uidOf(k)) } catch { /* not there */ }
  await aauth.createUser({ uid: uidOf(k), email: emailOf(k), password: PASSWORD })
  created.auth.push(uidOf(k))
  await track(lcol('users').doc(uidOf(k))).set({
    uid: uidOf(k), email: emailOf(k), labId: LAB, name: `RC ${LABEL[k]}`, role, active,
    branchIds: ['main'], defaultBranchId: 'main', allBranches: false, grants, denies, maxDiscountPct: 100,
  })
}
// a B2B portal login and its centre (for the partner-portal checks)
const PORTAL = `${PFX}portal`
try { await aauth.deleteUser(PORTAL) } catch { /* */ }
await aauth.createUser({ uid: PORTAL, email: `${PORTAL}@rules-check.local`, password: PASSWORD })
created.auth.push(PORTAL)
await track(lcol('users').doc(PORTAL)).set({ uid: PORTAL, email: `${PORTAL}@rules-check.local`, labId: LAB, name: 'RC portal', role: 'b2b', partnerId: `${PFX}centre`, active: true, branchIds: ['main'], defaultBranchId: 'main', allBranches: false })
await track(lcol('b2bCentres').doc(`${PFX}centre`)).set({ name: 'RC centre', active: true, settings: {} })

// effective permissions of a test user, from the real app function and the CURRENT role document
const hasOf = (k) => {
  const [role, grants, denies, active] = USERS[k]
  if (!active) return () => false
  const set = new Set(effectivePermissions(role, roleDoc[role] ?? undefined, grants, denies))
  return (key) => set.has(key)
}

// client sessions
const sessions = {}
async function session(k, email = emailOf(k)) {
  if (sessions[k]) return sessions[k]
  const app = initializeApp({ apiKey: 'rules-check', projectId: PROJECT }, `rc-${k}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
  const db = initializeFirestore(app, { experimentalForceLongPolling: false }, DB)
  const [h, p] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  connectFirestoreEmulator(db, h, Number(p))
  await signInWithEmailAndPassword(auth, email, PASSWORD)
  const uid = auth.currentUser.uid
  const L = (...a) => doc(db, 'labs', LAB, ...a)
  const C = (...a) => collection(db, 'labs', LAB, ...a)
  return (sessions[k] = { db, uid, doc: L, col: C })
}
for (const k of ORDER) await session(k)
await session('portal', `${PORTAL}@rules-check.local`)

// ---------------------------------------------------------------------------------------------
// fixtures (Admin SDK, bypass rules)
// ---------------------------------------------------------------------------------------------
let seq = 0
const nid = (p) => `${PFX}${p}-${Date.now().toString(36)}-${++seq}`
const line = (id, price, extra = {}) => ({ lineId: id, kind: 'test', refId: `t-${id}`, code: id.toUpperCase(), name: `Test ${id}`, price, discount: 0, urgent: false, testIds: [`tst-${id}`], status: 'pending', ...extra })
function orderData(extra = {}) {
  const items = extra.items ?? [line('l1', 10000), line('l2', 20000)]
  const live = items.filter((i) => i.status !== 'refunded')
  const gross = live.reduce((s, i) => s + i.price, 0)
  const discount = live.reduce((s, i) => s + i.discount, 0)
  return {
    branchId: 'main', billNo: 'RC1', barcode: '000001', patientId: 'zz-rc-pat', patientNo: '260101001', patientName: 'RC Patient', gender: 'male',
    ageValue: 30, ageUnit: 'year', referrerName: 'Self', items, gross, discount, net: gross - discount, paid: 0, refunded: 0, due: gross - discount,
    reportStatus: 'pending', dispatch: [{ mode: 'email', delivered: false, deliveredAt: null }], dispatched: false, deleted: false,
    createdBy: 'zz', createdAt: ATimestamp.now(), version: 1, revisions: [], billedTo: 'patient', source: 'walkin', ...extra, items,
  }
}
async function mkOrder(extra = {}, ledger = []) {
  const id = nid('ord')
  const ref = track(lcol('orders').doc(id))
  await ref.set(orderData(extra))
  for (const e of ledger) await ref.collection('ledger').add({ branchId: 'main', postedBy: 'zz', postedByName: 'zz', postedAt: ATimestamp.now(), lineIds: [], reference: '', remark: '', ...e })
  return id
}
const paidLedger = (amount, mode = 'cash', type = 'payment') => ({ type, mode, amount })
async function mkResult(orderId, testId, data) {
  await lcol('orders').doc(orderId).collection('results').doc(testId).set({ id: testId, orderId, testId, testName: testId, values: { a: { value: '1', overridden: false } }, comment: '', status: 'pending', enteredBy: 'zz', approvedBy: '', approvedByName: '', ...data })
}

// ---------------------------------------------------------------------------------------------
// check runner
// ---------------------------------------------------------------------------------------------
const rows = [] // { group, name, cells: {k: {exp, got}} , normal }
const fails = []
const isDenied = (e) => e?.code === 'permission-denied' || /permission|insufficient/i.test(String(e?.message))
async function attempt(fn) {
  try { await fn(); return 'allow' } catch (e) {
    if (isDenied(e)) return 'deny'
    return `error:${e?.code ?? ''} ${String(e?.message ?? e).slice(0, 120)}`
  }
}

// action: { group, name, need(has, k) -> bool, setup?(k) -> fixture, run(s, fx, k) }
const ACTIVE = ORDER.filter((k) => USERS[k][3])
async function runAction(a, users = ACTIVE) {
  const row = { group: a.group, name: a.name, cells: {} }
  for (const k of users) {
    const exp = a.need(hasOf(k), k) ? 'allow' : 'deny'
    const fx = a.setup ? await a.setup(k) : {}
    const s = await session(k)
    const got = await attempt(() => a.run(s, fx, k))
    row.cells[k] = { exp, got }
    if (exp !== got) fails.push(`${a.name} as ${LABEL[k]}: expected ${exp}, got ${got}`)
  }
  rows.push(row)
}
// single explicit expectation (normal flows)
const normal = []
async function runNormal(name, k, fn, fx) {
  const s = await session(k)
  const got = await attempt(() => fn(s, fx))
  normal.push({ name, who: LABEL[k], exp: 'allow', got })
  if (got !== 'allow') fails.push(`normal flow "${name}" as ${LABEL[k]}: expected allow, got ${got}`)
}
async function runExpect(name, who, s, exp, fn) {
  const got = await attempt(() => fn(s))
  normal.push({ name, who, exp, got })
  if (got !== exp) fails.push(`"${name}" as ${who}: expected ${exp}, got ${got}`)
}

const rupees = (n) => n * 100
const yesterdayMinus = (days) => Timestamp.fromDate(new Date(Date.now() - days * 86400000))
const stdLedger = (s, extra) => ({ branchId: 'main', lineIds: [], reference: '', remark: '', postedBy: s.uid, postedByName: 'rc', postedAt: serverTimestamp(), ...extra })

// ---------------------------------------------------------------------------------------------
// 3. guarded writes
// ---------------------------------------------------------------------------------------------
const ACTIONS = []
const act = (group, name, need, run, setup) => ACTIONS.push({ group, name, need, run, setup })

// --- bills ---
const newOrderDoc = (s, extra = {}) => {
  const items = extra.items ?? [line('l1', 10000), line('l2', 20000)]
  const gross = items.reduce((n, i) => n + i.price, 0)
  const discount = items.reduce((n, i) => n + i.discount, 0)
  return { ...orderData({ items }), createdAt: serverTimestamp(), createdBy: s.uid, gross, discount, net: gross - discount, due: gross - discount, ...extra, items }
}
const trackedAdd = async (s, colName, data) => { const r = await addDoc(s.col(colName), data); created.docs.push(lcol(colName).doc(r.id)); return r }
act('bill', 'create bill, no discount', () => true, async (s) => { await trackedAdd(s, 'orders', newOrderDoc(s)) })
act('bill', 'create bill with discount', (h) => h('billing.discount'), async (s) => {
  const items = [line('l1', 10000, { discount: 2000 }), line('l2', 20000, { discount: 1000 })]
  await trackedAdd(s, 'orders', newOrderDoc(s, { items }))
})
act('bill', 'create bill, header discount only', (h) => h('billing.discount'), async (s) => {
  await trackedAdd(s, 'orders', newOrderDoc(s, { discount: 3000, net: 27000, due: 27000 }))
})
act('bill', 'create back-dated bill', (h) => h('billing.backdate'), async (s) => {
  await trackedAdd(s, 'orders', newOrderDoc(s, { billDate: yesterdayMinus(3) }))
})
act('bill', 'create bill with money already paid', (h) => h('payment.collect'), async (s) => {
  await trackedAdd(s, 'orders', newOrderDoc(s, { paid: 10000, due: 20000 }))
})
act('bill', 'create bill dated today (picker at midnight IST)', () => true, async (s) => {
  const istMidnight = Math.floor((Date.now() + 19800000) / 86400000) * 86400000 - 19800000
  await trackedAdd(s, 'orders', newOrderDoc(s, { billDate: Timestamp.fromMillis(istMidnight) }))
})
act('bill', 'void bill (deleted false -> true)', (h) => h('billing.void'),
  (s, fx) => updateDoc(s.doc('orders', fx.id), { deleted: true, voidReason: 'x', voidedBy: s.uid, voidedAt: serverTimestamp(), barcodeVoided: true, commissionReversed: true, paid: 0, due: 0 }),
  () => mkOrder().then((id) => ({ id })))
act('bill', 'edit-bill: add a line (revision + rev)', (h) => h('billing.edit'), (s, fx) => updateDoc(s.doc('orders', fx.id), {
  items: [line('l1', 10000), line('l2', 20000), line('l3', 5000)], gross: 35000, discount: 0, net: 35000,
  revisions: arrayUnion({ at: Timestamp.now(), by: s.uid, byName: 'rc', summary: 'add', before: {}, after: {} }), rev: 1,
}), () => mkOrder().then((id) => ({ id })))
act('bill', 'edit-bill: remove a line', (h) => h('billing.edit'), (s, fx) => updateDoc(s.doc('orders', fx.id), {
  items: [line('l1', 10000)], gross: 10000, discount: 0, net: 10000, revisions: arrayUnion({ at: Timestamp.now(), by: s.uid, summary: 'rm' }), rev: 1,
}), () => mkOrder().then((id) => ({ id })))
act('bill', 're-price a line without a revision (SDK bypass)', (h) => h('billing.edit'), (s, fx) => updateDoc(s.doc('orders', fx.id), {
  items: [line('l1', 100), line('l2', 20000)], gross: 20100, net: 20100,
}), () => mkOrder().then((id) => ({ id })))
act('bill', 're-price a line, totals left alone (SDK bypass)', (h) => h('billing.edit'), (s, fx) => updateDoc(s.doc('orders', fx.id), {
  items: [line('l1', 100), line('l2', 20000)],
}), () => mkOrder().then((id) => ({ id })))
act('bill', 'discount a line, totals left alone (SDK bypass)', (h) => h('billing.edit') || h('billing.discount') && false, (s, fx) => updateDoc(s.doc('orders', fx.id), {
  items: [line('l1', 10000, { discount: 9000 }), line('l2', 20000)],
}), () => mkOrder().then((id) => ({ id })))
act('bill', 'header discount changed', (h) => h('billing.edit'), (s, fx) => updateDoc(s.doc('orders', fx.id), { discount: 5000, net: 25000 }), () => mkOrder().then((id) => ({ id })))
act('bill', 'change referrer on a saved bill', (h) => h('billing.edit') || h('referrals.manage'), (s, fx) => updateDoc(s.doc('orders', fx.id), { referrerId: 'r1', referrerName: 'Dr RC' }), () => mkOrder().then((id) => ({ id })))
act('bill', 'write off a due balance (items, totals, writeOffs, revisions; then recompute)', (h) => h('billing.discount') || h('billing.edit'), async (s, fx) => {
  await updateDoc(s.doc('orders', fx.id), {
    items: [line('l1', 10000, { discount: 2000 }), line('l2', 20000)], gross: 30000, discount: 2000, net: 28000,
    writeOffs: arrayUnion({ amount: 2000, reason: 'x', by: s.uid, at: Timestamp.now() }), revisions: arrayUnion({ at: Timestamp.now(), by: s.uid, summary: 'wo' }),
  })
  await updateDoc(s.doc('orders', fx.id), { due: 28000 })
}, () => mkOrder().then((id) => ({ id })))
act('bill', 'write-off payload that also re-prices a line (SDK bypass)', (h) => h('billing.edit'), (s, fx) => updateDoc(s.doc('orders', fx.id), {
  items: [line('l1', 100, { discount: 2000 }), line('l2', 20000)], gross: 20100, discount: 2000, net: 18100,
  writeOffs: arrayUnion({ amount: 2000, reason: 'x', by: s.uid, at: Timestamp.now() }), revisions: arrayUnion({ at: Timestamp.now(), by: s.uid, summary: 'wo' }),
}), () => mkOrder().then((id) => ({ id })))
act('bill', 'file a refund request (refundPendingApproval)', (h) => h('billing.refund'), (s, fx) => updateDoc(s.doc('orders', fx.id), {
  refundPendingApproval: { amount: 10000, lineIds: ['l1'], mode: 'cash', reason: 'x', requestedBy: s.uid, requestedByName: 'rc', requestedAt: Timestamp.now() },
}), () => mkOrder({ paid: 30000, due: 0 }, [paidLedger(30000)]).then((id) => ({ id })))
act('bill', 'set paid / due without a ledger key (SDK bypass)', (h) => ['payment.collect', 'billing.clearDue', 'billing.refund', 'billing.reverse', 'billing.void', 'billing.edit', 'billing.discount'].some(h), (s, fx) => updateDoc(s.doc('orders', fx.id), { paid: 30000, due: 0 }), () => mkOrder().then((id) => ({ id })))

// --- ledger ---
act('ledger', 'payment (ledger + paid/due on the bill)', (h) => h('payment.collect'), async (s, fx) => {
  await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 10000, receiptNo: 'R1', shift: 'Morning' }))
  await updateDoc(s.doc('orders', fx.id), { paid: 10000, due: 20000 })
}, () => mkOrder().then((id) => ({ id })))
act('ledger', 'payment back-dated (backdatedTo)', (h) => h('payment.collect') && h('billing.backdate'), (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 10000, backdatedTo: yesterdayMinus(2) })), () => mkOrder().then((id) => ({ id })))
act('ledger', 'payment with a forged postedAt', () => false, (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 10000, postedAt: yesterdayMinus(5) })), () => mkOrder().then((id) => ({ id })))
act('ledger', 'payment posted in someone else\'s name', () => false, (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 10000, postedBy: 'somebody-else' })), () => mkOrder().then((id) => ({ id })))
act('ledger', 'clear due (ledger + due on the bill)', (h) => h('billing.clearDue') && h('payment.collect'), async (s, fx) => {
  await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'clearDue', mode: 'upi', reference: 'U1', amount: 20000, remark: 'rest' }))
  await updateDoc(s.doc('orders', fx.id), { dueRemark: '' })
  await updateDoc(s.doc('orders', fx.id), { paid: 30000, due: 0 })
}, () => mkOrder({ paid: 10000, due: 20000 }, [paidLedger(10000)]).then((id) => ({ id })))
act('ledger', 'refund entry', (h) => h('billing.refund'), (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'refund', mode: 'cash', amount: -10000, lineIds: ['l1'], refundNo: 'RF1', status: 'paid' })), () => mkOrder({ paid: 30000, due: 0 }, [paidLedger(30000)]).then((id) => ({ id })))
act('ledger', 'refund flow (entry, line refunded, totals recomputed)', (h) => h('billing.refund'), async (s, fx) => {
  await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'refund', mode: 'cash', amount: -10000, lineIds: ['l1'], refundNo: 'RF1', status: 'paid' }))
  await updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'refunded' }), line('l2', 20000)], refundPendingApproval: deleteField() })
  await updateDoc(s.doc('orders', fx.id), { gross: 20000, discount: 0, net: 20000, paid: 20000, refunded: 10000, due: 0, reportStatus: 'pending' })
}, () => mkOrder({ paid: 30000, due: 0 }, [paidLedger(30000)]).then((id) => ({ id })))
act('ledger', 'KNOWN GAP: mark a line refunded (status only, no ledger entry, no totals)', () => true, (s, fx) =>
  updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'refunded' }), line('l2', 20000)] }), () => mkOrder().then((id) => ({ id })))
act('ledger', 'payment reversal', (h) => h('billing.reverse'), (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'reversal', mode: 'cash', amount: -10000, reversesId: 'x', remark: 'wrong' })), () => mkOrder({ paid: 10000, due: 20000 }, [paidLedger(10000)]).then((id) => ({ id })))
act('ledger', 'void flow (bill voided, then pay-back entry)', (h) => h('billing.void'), async (s, fx) => {
  await updateDoc(s.doc('orders', fx.id), { deleted: true, voidReason: 'x', voidedBy: s.uid, barcodeVoided: true, commissionReversed: true, paid: 0, due: 0 })
  await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'refund', mode: 'cash', amount: -10000, remark: 'Bill deleted: x' }))
}, () => mkOrder({ paid: 10000, due: 20000 }, [paidLedger(10000)]).then((id) => ({ id })))
act('ledger', 'refund entry on a live bill labelled as a void pay-back', (h) => h('billing.refund'), (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'refund', mode: 'cash', amount: -10000, remark: 'Bill deleted: x' })), () => mkOrder({ paid: 10000, due: 20000 }, [paidLedger(10000)]).then((id) => ({ id })))
act('ledger', 'wallet payment on a B2B bill', (h) => h('payment.collect') || h('registration.create') || h('billing.edit'), (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'wallet', amount: 30000 })), () => mkOrder({ billedTo: 'b2b', b2bCentreId: `${PFX}centre` }).then((id) => ({ id })))
act('ledger', 'wallet payment on a patient bill', (h) => h('payment.collect'), (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'wallet', amount: 30000 })), () => mkOrder().then((id) => ({ id })))
act('ledger', 'ledger entry of an unknown type', () => false, (s, fx) =>
  addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'bonus', mode: 'cash', amount: 100 })), () => mkOrder().then((id) => ({ id })))
act('ledger', 'ledger entry edited afterwards', () => false, async (s, fx) => {
  await updateDoc(s.doc('orders', fx.id, 'ledger', fx.entry), { amount: 1 })
}, async () => { const id = await mkOrder({ paid: 10000, due: 20000 }, [paidLedger(10000)]); const e = await lcol('orders').doc(id).collection('ledger').get(); return { id, entry: e.docs[0].id } })

// --- bookings carried onto a bill (a phlebotomist converts a home-collection booking) ---
async function mkBooking(extra = {}) {
  const id = nid('bk')
  await track(lcol('bookings').doc(id)).set({ branchId: 'main', bookingNo: 'BK1', discount: 4000, prepaid: 10000, ...extra })
  return id
}
act('booking', 'bill from a booking: its own discount', () => true, async (s, fx) => {
  const items = [line('l1', 10000, { discount: 3000 }), line('l2', 20000, { discount: 1000 })]
  await trackedAdd(s, 'orders', newOrderDoc(s, { items, bookingId: fx.bk, source: 'booking' }))
}, async () => ({ bk: await mkBooking() }))
act('booking', 'bill from a booking: more discount than the booking has', (h) => h('billing.discount'), async (s, fx) => {
  const items = [line('l1', 10000, { discount: 9000 }), line('l2', 20000, { discount: 1000 })]
  await trackedAdd(s, 'orders', newOrderDoc(s, { items, bookingId: fx.bk, source: 'booking' }))
}, async () => ({ bk: await mkBooking() }))
act('booking', 'bill from a booking: its prepayment on the ledger', () => true, async (s, fx) => {
  await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 10000, reference: 'BK1' }))
}, async () => { const bk = await mkBooking(); return { id: await mkOrder({ bookingId: bk, source: 'booking' }) } })
act('booking', 'bill from a booking: more than the prepayment', (h) => h('payment.collect'), async (s, fx) => {
  await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 30000, reference: 'BK1' }))
}, async () => { const bk = await mkBooking(); return { id: await mkOrder({ bookingId: bk, source: 'booking' }) } })

// --- results ---
const rpath = (s, fx) => s.doc('orders', fx.id, 'results', 'tst-l1')
const resultFx = (status, extra = {}) => async () => { const id = await mkOrder({ items: [line('l1', 10000, { status: status === 'approved' ? 'approved' : 'received' }), line('l2', 20000)] }); await mkResult(id, 'tst-l1', { status, ...extra }); return { id } }
act('result', 'save result values (pending)', (h) => h('results.enter'), (s, fx) => setDoc(rpath(s, fx), { values: { a: { value: '9', overridden: false } }, comment: 'c', status: 'pending', draft: null, enteredBy: s.uid, updatedAt: serverTimestamp() }, { mergeFields: ['values', 'comment', 'status', 'draft', 'enteredBy', 'updatedAt'] }), resultFx('pending'))
act('result', 'create a new result document', (h) => h('results.enter'), (s, fx) => setDoc(s.doc('orders', fx.id, 'results', 'tst-l2'), { id: 'tst-l2', orderId: fx.id, testId: 'tst-l2', testName: 'x', values: {}, comment: '', status: 'pending', enteredBy: s.uid, approvedBy: '', approvedByName: '' }), resultFx('pending'))
act('result', 'autosave a draft', (h) => h('results.enter'), (s, fx) => setDoc(rpath(s, fx), { draft: { values: {}, comment: 'x', by: s.uid }, updatedAt: serverTimestamp() }, { mergeFields: ['draft', 'updatedAt'] }), resultFx('pending'))
act('result', 'send for verification (entered)', (h) => h('results.enter'), (s, fx) => setDoc(rpath(s, fx), { status: 'entered', verification: { requestedBy: s.uid, at: 1 }, enteredBy: s.uid, updatedAt: serverTimestamp() }, { mergeFields: ['status', 'verification', 'enteredBy', 'updatedAt'] }), resultFx('pending'))
act('result', 'put on hold', (h) => h('results.enter'), (s, fx) => setDoc(rpath(s, fx), { status: 'hold', holdReason: 'x', heldBy: s.uid, heldAt: Date.now(), updatedAt: serverTimestamp() }, { mergeFields: ['status', 'holdReason', 'heldBy', 'heldAt', 'updatedAt'] }), resultFx('pending'))
act('result', 'send back to the technician', (h) => h('results.enter') || h('results.approve'), (s, fx) => setDoc(rpath(s, fx), { status: 'pending', verification: null, sentBack: { reason: 'x', by: s.uid }, updatedAt: serverTimestamp() }, { mergeFields: ['status', 'verification', 'sentBack', 'updatedAt'] }), resultFx('entered', { verification: { requestedBy: 'zz' } }))
act('result', 'approve (status -> approved)', (h) => h('results.approve'), async (s, fx) => {
  await setDoc(rpath(s, fx), { status: 'approved', approvedBy: s.uid, approvedByName: 'rc', approvedAt: serverTimestamp(), releaseType: 'final', draft: null, updatedAt: serverTimestamp() }, { mergeFields: ['status', 'approvedBy', 'approvedByName', 'approvedAt', 'releaseType', 'draft', 'updatedAt'] })
}, resultFx('entered'))
act('result', 'approve a test that has no result document yet', (h) => h('results.approve'), (s, fx) => setDoc(s.doc('orders', fx.id, 'results', 'tst-new'), { id: 'tst-new', orderId: fx.id, testId: 'tst-new', testName: 'x', values: {}, comment: '', status: 'approved', enteredBy: s.uid, approvedBy: s.uid, approvedByName: 'rc' }), resultFx('entered'))
act('result', 'un-approve', (h) => h('results.unapprove') || h('results.amend'), (s, fx) => setDoc(rpath(s, fx), { status: 'pending', approvedBy: '', approvedByName: '', updatedAt: serverTimestamp() }, { mergeFields: ['status', 'approvedBy', 'approvedByName', 'updatedAt'] }), resultFx('approved'))
act('result', 'amend an approved value', (h) => h('results.amend'), (s, fx) => setDoc(rpath(s, fx), { values: { a: { value: '77', overridden: false } }, status: 'approved', amendments: [{ reason: 'x', by: s.uid }], updatedAt: serverTimestamp() }, { mergeFields: ['values', 'status', 'amendments', 'updatedAt'] }), resultFx('approved'))
act('result', 'edit the comment of an approved result', (h) => h('results.amend'), (s, fx) => setDoc(rpath(s, fx), { comment: 'changed', updatedAt: serverTimestamp() }, { mergeFields: ['comment', 'updatedAt'] }), resultFx('approved'))
act('result', 'critical-value call-out on an approved result', (h) => ['results.enter', 'results.approve', 'results.amend', 'ai.interpret'].some(h), (s, fx) => setDoc(rpath(s, fx), { criticalAck: { by: s.uid }, criticalAlerts: [{ by: s.uid }], updatedAt: serverTimestamp() }, { mergeFields: ['criticalAck', 'criticalAlerts', 'updatedAt'] }), resultFx('approved'))
act('result', 'AI interpretation status', (h) => h('ai.interpret') || h('results.enter'), (s, fx) => updateDoc(rpath(s, fx), { 'aiInterpretation.status': 'inserted' }), resultFx('pending', { aiInterpretation: { status: 'draft', text: 'x' } }))
act('result', 'version row (audit trail)', (h) => ['results.enter', 'results.approve', 'results.unapprove', 'results.amend'].some(h), (s, fx) => addDoc(s.col('orders', fx.id, 'results', 'tst-l1', 'versions'), { event: 'saved', values: {}, by: s.uid, byName: 'rc', at: serverTimestamp() }), resultFx('pending'))

// --- normal bill updates that must stay open (accession, dispatch, report) ---
const plainOrder = () => mkOrder({ paid: 30000, due: 0 }, [paidLedger(30000)]).then((id) => ({ id }))
act('flow', 'accession: collect samples', () => true, (s, fx) => updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'collected', collectedByName: 'rc', collectedAt: Timestamp.now() }), line('l2', 20000, { status: 'collected' })], collectedAt: serverTimestamp() }), plainOrder)
act('flow', 'accession: receive samples', () => true, (s, fx) => updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'received' }), line('l2', 20000, { status: 'received' })], receivedAt: serverTimestamp(), collectedAt: serverTimestamp(), phlebotomistId: 'p1', phlebotomistName: 'P' }), plainOrder)
act('flow', 'accession: reject a sample', () => true, (s, fx) => updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'rejected', rejectReason: 'haemolysed' }), line('l2', 20000)] }), plainOrder)
act('flow', 'dispatch mark', () => true, (s, fx) => updateDoc(s.doc('orders', fx.id), { dispatch: [{ mode: 'email', delivered: true, deliveredAt: new Date() }], dispatched: true, dispatchedLineIds: ['l1'], dispatchStatus: 'dispatched' }), plainOrder)
act('flow', 'recompute after approval (status, reportStatus)', () => true, (s, fx) => updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'approved' }), line('l2', 20000, { status: 'approved' })], reportStatus: 'final', reportedAt: serverTimestamp(), firstApprovedAt: serverTimestamp(), gross: 30000, discount: 0, net: 30000, paid: 30000, refunded: 0, due: 0 }), plainOrder)
act('flow', 'bill print counter and report marks', () => true, (s, fx) => updateDoc(s.doc('orders', fx.id), { billPrints: 1, printed: true, hasReportFile: true }), plainOrder)

// --- settings and admin ---
const labPatch = (s, data) => setDoc(s.doc(), data, { merge: true })
// (s.doc() with no args is labs/main)
act('admin', 'lab settings (registration)', (h) => h('settings.manage'), (s) => labPatch(s, { registration: { zzRulesCheck: nid('v') } }))
act('admin', 'lab profile field (dailyReport)', (h) => h('settings.manage') || h('labprofile.edit'), (s) => labPatch(s, { dailyReport: { enabled: false, zzRulesCheck: nid('v') } }))
act('admin', 'lab profile + settings keys in one write', (h) => h('settings.manage'), (s) => labPatch(s, { dailyReport: { enabled: false, zz: nid('v') }, registration: { zzRulesCheck: nid('v') } }))
act('admin', 'QC settings', (h) => h('settings.manage') || h('qc.setup'), (s) => labPatch(s, { qcSettings: { zzRulesCheck: nid('v') } }))
act('admin', 'platform-owned subscription field', () => false, (s) => labPatch(s, { subscription: { plan: 'free' } }))
act('admin', 'delete the lab document', () => false, (s) => deleteDoc(s.doc()))
act('admin', 'edit another user (users.manage)', (h) => h('users.manage'), (s, fx) => updateDoc(s.doc('users', fx.uid), { name: 'renamed' }), async () => {
  const uid = nid('usr'); await track(lcol('users').doc(uid)).set({ uid, email: `${uid}@x.local`, labId: LAB, name: 'tmp', role: 'reception', active: true, branchIds: ['main'] }); return { uid }
})
act('admin', 'create a user profile', (h) => h('users.manage'), (s) => setDoc(s.doc('users', nid('usr')), { uid: 'x', email: 'x@x.local', labId: LAB, name: 'tmp', role: 'reception', active: true, branchIds: ['main'] }).then(() => undefined))
act('admin', 'change own role (no self-service)', (h) => h('users.manage'), (s, fx, k) => updateDoc(s.doc('users', uidOf(k)), { role: 'labAdmin' }))
act('admin', 'edit own name and phone (self profile)', () => true, (s, fx, k) => updateDoc(s.doc('users', uidOf(k)), { name: `RC ${LABEL[k]}`, phone: '1' }))
act('admin', 'edit the permission matrix (roles)', (h) => h('roles.manage'), (s) => setDoc(s.doc('roles', `${PFX}role`), { name: nid('v'), permissions: ['patients.view'] }))
act('admin', 'create a branch', (h) => h('branches.manage'), (s) => setDoc(s.doc('branches', `${PFX}branch`), { name: nid('v'), code: 'X', active: true }))
act('admin', 'end another user\'s session', (h) => h('users.manage'), (s, fx) => deleteDoc(s.doc('users', fx.uid, 'sessions', 's1')), async () => {
  const uid = nid('usr'); await track(lcol('users').doc(uid)).set({ uid, labId: LAB, name: 'tmp', role: 'reception', active: true, branchIds: ['main'] }); await lcol('users').doc(uid).collection('sessions').doc('s1').set({ seenAt: 1 }); return { uid }
})

// --- catalogue ---
const mkCat = async (c, extra = {}) => { const id = nid(c); await track(lcol(c).doc(id)).set({ name: 'RC', code: 'RC', price: 10000, deleted: false, ...extra }); return { id } }
act('catalogue', 'create a test', (h) => h('catalogue.edit') || h('catalogue.import'), (s) => setDoc(s.doc('tests', nid('t')), { name: 'x', code: 'X', price: 5000, parameters: [], deleted: false }, { merge: true }).then(() => undefined))
act('catalogue', 'edit a test (name, description)', (h) => h('catalogue.edit') || h('catalogue.import'), (s, fx) => updateDoc(s.doc('tests', fx.id), { name: 'edited', updatedAt: serverTimestamp() }), () => mkCat('tests'))
act('catalogue', 'change a test price (editor save)', (h) => h('catalogue.edit') && h('catalogue.price') || h('catalogue.import') && true, (s, fx) => setDoc(s.doc('tests', fx.id), { name: 'edited2', price: 99900 }, { merge: true }), () => mkCat('tests'))
act('catalogue', 'change a test price (list cell)', (h) => h('catalogue.price') || h('catalogue.import'), (s, fx) => updateDoc(s.doc('tests', fx.id), { price: 12300 }), () => mkCat('tests'))
act('catalogue', 'change a package price', (h) => h('catalogue.price') || h('catalogue.import'), (s, fx) => setDoc(s.doc('packages', fx.id), { price: 12300 }, { merge: true }), () => mkCat('packages'))
act('catalogue', 'soft delete a test', (h) => h('catalogue.delete') || h('settings.manage'), (s, fx) => setDoc(s.doc('tests', fx.id), { deleted: true, deletedAt: serverTimestamp() }, { merge: true }), () => mkCat('tests'))
act('catalogue', 'restore a deleted package', (h) => h('catalogue.delete') || h('settings.manage'), (s, fx) => setDoc(s.doc('packages', fx.id), { deleted: false, deletedAt: null }, { merge: true }), () => mkCat('packages', { deleted: true }))
act('catalogue', 'create a department', (h) => h('catalogue.edit') || h('catalogue.import'), (s) => setDoc(s.doc('departments', nid('dep')), { name: 'x', order: 1, active: true, deleted: false }, { merge: true }).then(() => undefined))
act('catalogue', 'map a test to outsource labs', (h) => h('catalogue.edit') || h('catalogue.import') || h('outsource.edit'), (s, fx) => setDoc(s.doc('tests', fx.id), { outsourceLabs: [{ labId: 'l', cost: 1, tatMinutes: null, isDefault: true }] }, { merge: true }), () => mkCat('tests'))
act('catalogue', 'hard delete a sample type', (h) => h('catalogue.delete'), (s, fx) => deleteDoc(s.doc('sampleTypes', fx.id)), () => mkCat('sampleTypes'))

// --- partner masters and rate lists ---
const mkMaster = async (c, extra = {}) => { const id = nid(c); await track(lcol(c).doc(id)).set({ name: 'RC', active: true, ...extra }); return { id } }
const RL_KEYS = ['ratelists.edit', 'referrals.manage', 'b2b.manage', 'centres.manage', 'corporate.manage', 'outsource.edit', 'catalogue.price']
act('master', 'create a rate list', (h) => RL_KEYS.some(h), (s) => setDoc(s.doc('rateLists', nid('rl')), { name: 'x', kind: 'shared', entries: {}, active: true }).then(() => undefined))
act('master', 'edit rate-list entries', (h) => RL_KEYS.some(h), (s, fx) => setDoc(s.doc('rateLists', fx.id), { entries: { a: 1 } }, { merge: true }), () => mkMaster('rateLists', { entries: {} }))
act('master', 'create a referring doctor', (h) => h('referrals.manage'), (s) => setDoc(s.doc('referrers', nid('ref')), { name: 'Dr', type: 'doctor', active: true }).then(() => undefined))
act('master', 'quick-add a TEMPORARY referring doctor', (h, k) => ['reception', 'phlebotomist', 'technician'].includes(USERS[k][0]) || h('referrals.manage'), (s) => setDoc(s.doc('referrers', nid('ref')), { name: 'Dr tmp', temporary: true, active: true }).then(() => undefined))
act('master', 'point a referrer at a shared rate list', (h) => h('ratelists.edit') || h('referrals.manage'), (s, fx) => setDoc(s.doc('referrers', fx.id), { rateListId: 'rl1', updatedAt: serverTimestamp() }, { merge: true }), () => mkMaster('referrers'))
act('master', 'assign a PRO to a referrer (marketing page)', (h) => h('marketing.manage') || h('referrals.manage'), (s, fx) => updateDoc(s.doc('referrers', fx.id), { proManagerId: 'pro1' }), () => mkMaster('referrers'))
act('master', 'edit a TPA', (h) => h('referrals.manage'), (s, fx) => setDoc(s.doc('tpas', fx.id), { name: 'edited' }, { merge: true }), () => mkMaster('tpas'))
act('master', 'edit a B2B centre', (h) => h('b2b.manage'), (s, fx) => setDoc(s.doc('b2bCentres', fx.id), { name: 'edited', updatedAt: serverTimestamp() }, { merge: true }), () => mkMaster('b2bCentres'))
act('master', 'edit a collection centre', (h) => h('centres.manage'), (s, fx) => setDoc(s.doc('collectionCentres', fx.id), { name: 'edited' }, { merge: true }), () => mkMaster('collectionCentres'))
act('master', 'edit a corporate client', (h) => h('corporate.manage'), (s, fx) => setDoc(s.doc('corporateClients', fx.id), { name: 'edited' }, { merge: true }), () => mkMaster('corporateClients'))
act('master', 'edit a marketing team member', (h) => h('marketing.manage'), (s, fx) => setDoc(s.doc('marketingTeam', fx.id), { name: 'edited' }, { merge: true }), () => mkMaster('marketingTeam'))
act('master', 'edit a processing (outsource) lab', (h) => h('outsource.edit'), (s, fx) => setDoc(s.doc('processingLabs', fx.id), { name: 'edited' }, { merge: true }), () => mkMaster('processingLabs'))
act('master', 'soft delete a corporate client', (h) => h('corporate.manage') || h('catalogue.delete') || h('settings.manage'), (s, fx) => setDoc(s.doc('corporateClients', fx.id), { deleted: true, deletedAt: serverTimestamp() }, { merge: true }), () => mkMaster('corporateClients'))
act('master', 'add a payment mode', (h) => h('settings.manage') || h('labmgmt.manage'), (s) => addDoc(s.col('paymentModes'), { name: 'RC mode', active: true, builtIn: false }).then((r) => { created.docs.push(lcol('paymentModes').doc(r.id)) }))
act('master', 'save a canned comment (report template)', (h) => h('catalogue.edit') || h('settings.manage') || h('labprofile.edit') || h('labmgmt.manage'), (s) => addDoc(s.col('reportTemplates'), { kind: 'comment', name: 'RC', text: 'x', active: true }).then((r) => { created.docs.push(lcol('reportTemplates').doc(r.id)) }))
act('master', 'edit the collector master', (h) => h('bookings.manage') || h('referrals.manage'), (s) => setDoc(s.doc('collectors', nid('col')), { name: 'x' }).then(() => undefined))
act('master', 'price batch (mass price update log)', (h) => h('catalogue.price') || h('ratelists.edit'), (s) => addDoc(s.col('priceBatches'), { kind: 'x' }).then((r) => { created.docs.push(lcol('priceBatches').doc(r.id)) }))
act('master', 'outsource settlement', (h) => h('outsource.edit'), (s) => addDoc(s.col('outsourceSettlements'), { createdBy: s.uid, status: 'pending' }).then((r) => { created.docs.push(lcol('outsourceSettlements').doc(r.id)) }))

// --- B2B wallet ---
const wtx = (s, extra) => ({ branchId: 'main', centreId: `${PFX}centre`, centreName: 'RC', reference: 'x', by: s.uid, byName: 'rc', at: serverTimestamp(), ...extra })
const addTrack = (name) => async (s, data) => { const r = await addDoc(s.col(name), data); created.docs.push(lcol(name).doc(r.id)) }
const addWallet = addTrack('walletTxns')
act('wallet', 'approve a top-up (approval row)', (h) => h('b2b.manage'), (s) => addWallet(s, wtx(s, { kind: 'approval', refTxnId: 'x', status: 'approved', amount: 0 })))
act('wallet', 'decline a top-up (approval row)', (h) => h('b2b.manage'), (s) => addWallet(s, wtx(s, { kind: 'approval', refTxnId: 'x', status: 'declined', amount: 0 })))
act('wallet', 'add money, approved immediately', (h) => h('b2b.manage'), (s) => addWallet(s, wtx(s, { kind: 'topup', mode: 'upi', amount: 50000, status: 'approved' })))
act('wallet', 'record a top-up request (pending)', (h) => h('b2b.view') || h('b2b.manage'), (s) => addWallet(s, wtx(s, { kind: 'topup', mode: 'upi', amount: 50000, status: 'pending' })))
act('wallet', 'wallet discount row', (h) => h('b2b.manage'), (s) => addWallet(s, wtx(s, { kind: 'discount', mode: 'cash', amount: 100, status: 'approved' })))
act('wallet', 'bill debit mirror (negative amount)', () => true, (s) => addWallet(s, wtx(s, { kind: 'debit', amount: -30000, status: 'approved' })))
act('wallet', 'positive "debit" row (refund / void / edit mirror)', (h) => ['billing.refund', 'billing.edit', 'billing.void', 'b2b.manage'].some(h), (s) => addWallet(s, wtx(s, { kind: 'debit', amount: 30000, status: 'approved' })))
act('wallet', 'edit a wallet row afterwards', () => false, (s, fx) => updateDoc(s.doc('walletTxns', fx.id), { status: 'approved' }), async () => { const id = nid('wt'); await track(lcol('walletTxns').doc(id)).set({ branchId: 'main', centreId: `${PFX}centre`, kind: 'topup', status: 'pending', amount: 100 }); return { id } })
act('wallet', 'credit / debit note', (h) => h('b2b.manage'), (s) => addTrack('creditNotes')(s, wtx(s, { kind: 'credit', amount: 100, reason: 'x' })))
act('wallet', 'B2B invoice', (h) => h('b2b.manage'), (s) => addTrack('partnerInvoices')(s, { branchId: 'main', kind: 'b2b', partyId: 'x', status: 'draft', amount: 1 }))
act('wallet', 'corporate invoice', (h) => h('corporate.manage'), (s) => addTrack('partnerInvoices')(s, { branchId: 'main', kind: 'corporate', partyId: 'x', status: 'draft', amount: 1 }))
act('wallet', 'delete a draft B2B invoice', (h) => h('b2b.manage'), (s, fx) => deleteDoc(s.doc('partnerInvoices', fx.id)), async () => { const id = nid('inv'); await track(lcol('partnerInvoices').doc(id)).set({ branchId: 'main', kind: 'b2b', status: 'draft', amount: 1 }); return { id } })


// --- never allowed, for any role (guards against wildcard rules opening a collection by accident) ---
act('never', 'delete a bill', () => false, (s, fx) => deleteDoc(s.doc('orders', fx.id)), () => mkOrder().then((id) => ({ id })))
act('never', 'delete a patient', () => false, (s, fx) => deleteDoc(s.doc('patients', fx.id)), async () => { const id = nid('pat'); await track(lcol('patients').doc(id)).set({ name: 'x' }); return { id } })
act('never', 'write the audit log', () => false, (s) => setDoc(s.doc('auditLog', nid('a')), { text: 'x', branchId: 'main' }))
act('never', 'write the outbox', () => false, (s) => setDoc(s.doc('outbox', nid('o')), { text: 'x' }))
act('never', 'write to a collection that has no rule', () => false, (s) => setDoc(s.doc('zzUnknownCollection', nid('u')), { x: 1 }))
act('never', 'edit a stock movement', () => false, (s, fx) => updateDoc(s.doc('stockMovements', fx.id), { qty: 1 }), async () => { const id = nid('sm'); await track(lcol('stockMovements').doc(id)).set({ branchId: 'main', qty: 5 }); return { id } })
act('never', 'delete a ledger entry', () => false, (s, fx) => deleteDoc(s.doc('orders', fx.id, 'ledger', fx.entry)), async () => { const id = await mkOrder({ paid: 100, due: 0 }, [paidLedger(100)]); const e = await lcol('orders').doc(id).collection('ledger').get(); return { id, entry: e.docs[0].id } })
act('never', 'write a lab-level payment gateway doc', () => false, (s) => setDoc(s.doc('payments', nid('p')), { x: 1 }))

// ---------------------------------------------------------------------------------------------
console.log('Running guarded writes (this takes a minute)...')
const ONLY = process.env.RC_ONLY ? new RegExp(process.env.RC_ONLY, 'i') : null // debugging aid: RC_ONLY='lab settings' node scripts/rules-check.mjs
for (const a of ACTIONS) if (!ONLY || ONLY.test(a.name)) await runAction(a)
if (ONLY) { for (const r of rows) console.log(r.name, JSON.stringify(Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, c.got + (c.exp === c.got ? '' : ' !!')])))); console.log(fails.join('\n')); await cleanup(); process.exit(0) }

// Restores the role and lab documents, then removes everything this script created (tracked documents, anything
// under the zz-rc- id prefix in any collection of the lab, bills carrying the test patient id, the auth users).
async function cleanup() {
  for (const r of ROLES) {
    if (roleBackup[r] === null) await lcol('roles').doc(r).delete().catch(() => undefined)
    else await lcol('roles').doc(r).set(roleBackup[r])
  }
  if (labBackup) await labRef.set(labBackup)
  let removed = 0
  const kill = async (ref) => { try { await adb.recursiveDelete(ref); removed++ } catch { await ref.delete().catch(() => undefined) } }
  for (const ref of created.docs) await kill(ref)
  for (const col of await labRef.listCollections()) {
    const snap = await col.get()
    for (const d of snap.docs) if (d.id.startsWith(PFX) || d.data().patientId === 'zz-rc-pat') await kill(d.ref)
  }
  for (const uid of created.auth) await aauth.deleteUser(uid).catch(() => undefined)
  let left = 0
  for (const col of await labRef.listCollections()) {
    const snap = await col.get()
    for (const d of snap.docs) if (d.id.startsWith(PFX) || d.data().patientId === 'zz-rc-pat') left++
  }
  console.log(`cleanup: test data removed, ${left} test document(s) left`)
}
// ---------------------------------------------------------------------------------------------
// 4. normal flows, asserted ALLOWED for the role that does the job
// ---------------------------------------------------------------------------------------------
console.log('Running normal flows...')
// create bill (no discount) + payment + clear due, as reception
{
  let id
  await runNormal('reception: create bill (no discount)', 'R', async (s) => { const r = await trackedAdd(s, 'orders', newOrderDoc(s)); id = r.id })
  await runNormal('reception: record a payment on it', 'R', async (s) => {
    await addDoc(s.col('orders', id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 10000, receiptNo: 'R9', shift: 'Morning' }))
    await updateDoc(s.doc('orders', id), { paid: 10000, due: 20000, gross: 30000, discount: 0, net: 30000, refunded: 0, reportStatus: 'pending' })
  })
  await runNormal('reception: clear the due', 'R', async (s) => {
    await addDoc(s.col('orders', id, 'ledger'), stdLedger(s, { type: 'clearDue', mode: 'upi', reference: 'U9', amount: 20000, remark: 'rest', receiptNo: 'R10' }))
    await updateDoc(s.doc('orders', id), { dueRemark: '' })
    await updateDoc(s.doc('orders', id), { paid: 30000, due: 0, reportStatus: 'pending' })
  })
  await runNormal('reception: create bill with payment taken (collect on create)', 'R', async (s) => {
    const r = await trackedAdd(s, 'orders', newOrderDoc(s, { paid: 30000, due: 0 }))
    await addDoc(s.col('orders', r.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 30000, receiptNo: 'R11' }))
  })
  await runNormal('reception: create bill with a discount', 'R', async (s) => { await trackedAdd(s, 'orders', newOrderDoc(s, { items: [line('l1', 10000, { discount: 1000 }), line('l2', 20000)] })) })
  await runNormal('reception: Save & Collect (items collected right after create)', 'R', async (s) => {
    const r = await trackedAdd(s, 'orders', newOrderDoc(s))
    await updateDoc(s.doc('orders', r.id), { items: [line('l1', 10000, { status: 'collected' }), line('l2', 20000, { status: 'collected' })], collectedAt: serverTimestamp() })
  })
  await runNormal('manager: bill a B2B centre (bill + wallet payment + wallet debit row)', 'M', async (s) => {
    const r = await trackedAdd(s, 'orders', newOrderDoc(s, { billedTo: 'b2b', b2bCentreId: `${PFX}centre`, b2bCentreName: 'RC', paid: 30000, due: 0 }))
    await addDoc(s.col('orders', r.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'wallet', amount: 30000 }))
    await addWallet(s, wtx(s, { kind: 'debit', amount: -30000, status: 'approved', orderId: r.id }))
  })
  await runNormal('phlebotomist: convert a booking (discount and prepayment of the booking)', 'P', async (s) => {
    const bk = await mkBooking()
    const r = await trackedAdd(s, 'orders', newOrderDoc(s, { items: [line('l1', 10000, { discount: 4000 }), line('l2', 20000)], bookingId: bk, source: 'booking', paid: 10000, due: 16000 }))
    await addDoc(s.col('orders', r.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 10000, reference: 'BK1' }))
  })
}
// accession as technician, receive as reception
{
  const fx = await plainOrder()
  await runNormal('technician: collect samples', 'T', (s) => updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'collected' }), line('l2', 20000, { status: 'collected' })], collectedAt: serverTimestamp() }))
  await runNormal('technician: receive samples', 'T', (s) => updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'received' }), line('l2', 20000, { status: 'received' })], receivedAt: serverTimestamp() }))
  await runNormal('reception: dispatch mark', 'R', (s) => updateDoc(s.doc('orders', fx.id), { dispatch: [{ mode: 'email', delivered: true }], dispatched: true, dispatchedLineIds: ['l1', 'l2'], dispatchStatus: 'dispatched' }))
}
// result entry as technician, approve as doctor (the whole approveEntries sequence)
{
  const fx = await resultFx('pending')()
  await runNormal('technician: save a result', 'T', async (s) => {
    await setDoc(rpath(s, fx), { values: { a: { value: '5', overridden: false } }, comment: '', status: 'pending', draft: null, enteredBy: s.uid, updatedAt: serverTimestamp() }, { mergeFields: ['values', 'comment', 'status', 'draft', 'enteredBy', 'updatedAt'] })
    await addDoc(s.col('orders', fx.id, 'results', 'tst-l1', 'versions'), { event: 'saved', values: {}, by: s.uid, byName: 'rc', at: serverTimestamp() })
    await updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'entered' }), line('l2', 20000)] })
  })
  await runNormal('technician: send for verification', 'T', (s) => setDoc(rpath(s, fx), { status: 'entered', verification: { requestedBy: s.uid, at: 1 }, updatedAt: serverTimestamp() }, { mergeFields: ['status', 'verification', 'updatedAt'] }))
  await runNormal('doctor: approve (result, version, bill lines, recompute)', 'D', async (s) => {
    await setDoc(rpath(s, fx), { id: 'tst-l1', orderId: fx.id, testId: 'tst-l1', values: { a: { value: '5', overridden: false } }, status: 'approved', approvedBy: s.uid, approvedByName: 'rc', approvedAt: serverTimestamp(), releaseType: 'final', verification: null, sentBack: null, draft: null, autoVerified: false, signatureSnapshots: [], selfVerified: false, updatedAt: serverTimestamp() }, { mergeFields: ['id', 'orderId', 'testId', 'values', 'status', 'approvedBy', 'approvedByName', 'approvedAt', 'releaseType', 'verification', 'sentBack', 'draft', 'autoVerified', 'signatureSnapshots', 'selfVerified', 'updatedAt'] })
    await addDoc(s.col('orders', fx.id, 'results', 'tst-l1', 'versions'), { event: 'approved', values: {}, by: s.uid, byName: 'rc', at: serverTimestamp() })
    await updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'approved' }), line('l2', 20000)] })
    await updateDoc(s.doc('orders', fx.id), { gross: 30000, discount: 0, net: 30000, paid: 0, refunded: 0, due: 30000, reportStatus: 'partial', firstApprovedAt: serverTimestamp() })
  })
  await runNormal('doctor: amend the approved value', 'D', async (s) => {
    await setDoc(rpath(s, fx), { values: { a: { value: '6', overridden: false } }, status: 'approved', amendments: [{ reason: 'typo', by: s.uid }], updatedAt: serverTimestamp() }, { mergeFields: ['values', 'status', 'amendments', 'updatedAt'] })
    await updateDoc(s.doc('orders', fx.id), { reportRevision: 1, amendedAt: serverTimestamp(), amendSummary: 'Amended: x' })
  })
  await runNormal('doctor: un-approve', 'D', async (s) => {
    await setDoc(rpath(s, fx), { status: 'pending', approvedBy: '', approvedByName: '', updatedAt: serverTimestamp() }, { mergeFields: ['status', 'approvedBy', 'approvedByName', 'updatedAt'] })
    await addDoc(s.col('orders', fx.id, 'results', 'tst-l1', 'versions'), { event: 'unapproved', values: {}, by: s.uid, byName: 'rc', at: serverTimestamp() })
  })
}
// refund as a role that holds the refund key (manager), full app sequence incl. approval of a request
{
  const fx = await mkOrder({ paid: 30000, due: 0 }, [paidLedger(30000)]).then((id) => ({ id }))
  await runNormal('manager: refund one line (ledger, line refunded, recompute)', 'M', async (s) => {
    await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'refund', mode: 'cash', amount: -10000, lineIds: ['l1'], refundNo: 'RF9', status: 'paid' }))
    await updateDoc(s.doc('orders', fx.id), { items: [line('l1', 10000, { status: 'refunded' }), line('l2', 20000)], refundPendingApproval: deleteField() })
    await updateDoc(s.doc('orders', fx.id), { gross: 20000, discount: 0, net: 20000, paid: 20000, refunded: 10000, due: 0 })
  })
  await runNormal('reception+refund grant: refund a line', 'G', async (s) => {
    const o = await mkOrder({ paid: 30000, due: 0 }, [paidLedger(30000)])
    await addDoc(s.col('orders', o, 'ledger'), stdLedger(s, { type: 'refund', mode: 'cash', amount: -10000, lineIds: ['l1'], refundNo: 'RF8', status: 'paid' }))
    await updateDoc(s.doc('orders', o), { items: [line('l1', 10000, { status: 'refunded' }), line('l2', 20000)] })
    await updateDoc(s.doc('orders', o), { gross: 20000, discount: 0, net: 20000, paid: 20000, refunded: 10000, due: 0 })
  })
  const v = await mkOrder({ paid: 10000, due: 20000 }, [paidLedger(10000)])
  await runNormal('manager: void a bill with a refund pay-back', 'M', async (s) => {
    await updateDoc(s.doc('orders', v), { deleted: true, voidReason: 'dup', voidedBy: s.uid, barcodeVoided: true, commissionReversed: true, paid: 0, due: 0 })
    await addDoc(s.col('orders', v, 'ledger'), stdLedger(s, { type: 'refund', mode: 'cash', amount: -10000, remark: 'Bill deleted: dup' }))
  })
  const e = await mkOrder({}, [])
  await runNormal('manager: edit-bill (add line, wallet untouched)', 'M', async (s) => {
    await updateDoc(s.doc('orders', e), { items: [line('l1', 10000), line('l2', 20000), line('l3', 5000)], gross: 35000, discount: 0, net: 35000, revisions: arrayUnion({ at: Timestamp.now(), by: s.uid, summary: 'x' }), rev: 1 })
    await updateDoc(s.doc('orders', e), { gross: 35000, discount: 0, net: 35000, paid: 0, refunded: 0, due: 35000 })
  })
}

// big bills: the per-line checks look at the first 10 lines, so flows on a 30-line bill must still fit the rules budget
{
  const many = (n, f = () => ({})) => Array.from({ length: n }, (_, i) => line(`m${i}`, 1000 + i, f(i)))
  const mkBig = (extra = {}, ledger = []) => mkOrder({ items: many(30), paid: 30000, due: 0, ...extra }, ledger).then((id) => ({ id }))
  const sumOf = (items) => items.filter((i) => i.status !== 'refunded').reduce((n, i) => n + i.price, 0)
  let fx = await mkBig({}, [paidLedger(30000)])
  await runNormal('30-line bill, technician: collect all samples', 'T', (s) => updateDoc(s.doc('orders', fx.id), { items: many(30, () => ({ status: 'collected', collectedAt: Timestamp.now() })), collectedAt: serverTimestamp() }))
  await runNormal('30-line bill, technician: receive all samples', 'T', (s) => updateDoc(s.doc('orders', fx.id), { items: many(30, () => ({ status: 'received', receivedAt: Timestamp.now() })), receivedAt: serverTimestamp() }))
  await runNormal('30-line bill, doctor: approve line (items + recompute)', 'D', async (s) => {
    await updateDoc(s.doc('orders', fx.id), { items: many(30, (i) => ({ status: i === 0 ? 'approved' : 'received' })) })
    await updateDoc(s.doc('orders', fx.id), { reportStatus: 'partial', firstApprovedAt: serverTimestamp() })
  })
  fx = await mkBig({}, [paidLedger(30000)])
  await runNormal('30-line bill, manager: refund one line (3 writes)', 'M', async (s) => {
    const items = many(30, (i) => (i === 3 ? { status: 'refunded' } : {}))
    await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'refund', mode: 'cash', amount: -1003, lineIds: ['m3'], refundNo: 'RF30', status: 'paid' }))
    await updateDoc(s.doc('orders', fx.id), { items, refundPendingApproval: deleteField() })
    await updateDoc(s.doc('orders', fx.id), { gross: sumOf(items), discount: 0, net: sumOf(items), paid: 30000 - 1003, refunded: 1003, due: 0 })
  })
  fx = await mkBig({ paid: 0, due: 40000 })
  await runNormal('30-line bill, reception: take a payment', 'R', async (s) => {
    await addDoc(s.col('orders', fx.id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 20000, receiptNo: 'R30' }))
    await updateDoc(s.doc('orders', fx.id), { paid: 20000, due: 20000 })
  })
  fx = await mkBig({ paid: 0, due: 40000 })
  await runNormal('30-line bill, manager: edit-bill (add a line, totals, revision)', 'M', async (s) => {
    const items = [...many(30), line('extra', 500)]
    await updateDoc(s.doc('orders', fx.id), { items, gross: sumOf(items), net: sumOf(items), revisions: arrayUnion({ at: Timestamp.now(), by: s.uid, summary: 'x' }), rev: 1 })
    await updateDoc(s.doc('orders', fx.id), { gross: sumOf(items), net: sumOf(items), paid: 0, due: sumOf(items) })
  })
  fx = await mkBig({ paid: 0, due: 40000 })
  await runNormal('30-line bill, manager: void', 'M', (s) => updateDoc(s.doc('orders', fx.id), { deleted: true, voidReason: 'x', voidedBy: s.uid, paid: 0, due: 0 }))
  fx = await mkBig({ paid: 0, due: 40000 })
  await runNormal('30-line bill, reception: write off a due balance (holds billing.discount)', 'R', async (s) => {
    await updateDoc(s.doc('orders', fx.id), { items: many(30, (i) => (i === 0 ? { discount: 100 } : {})), gross: sumOf(many(30)), discount: 100, net: sumOf(many(30)) - 100, writeOffs: arrayUnion({ amount: 100, reason: 'x', by: s.uid, at: Timestamp.now() }), revisions: arrayUnion({ at: Timestamp.now(), by: s.uid, summary: 'wo' }) })
    await updateDoc(s.doc('orders', fx.id), { due: 40000 - 100 })
  })
  const T30 = await session('T')
  fx = await mkBig({ paid: 0, due: 40000 })
  await runExpect('30-line bill, technician: re-price line 3 (checked)', 'technician', T30, 'deny', (s) => updateDoc(s.doc('orders', fx.id), { items: many(30, (i) => (i === 3 ? { price: 1 } : {})) }))
  await runExpect('30-line bill, technician: re-price line 25 (KNOWN GAP: only the first 10 lines are checked)', 'technician', T30, 'allow', (s) => updateDoc(s.doc('orders', fx.id), { items: many(30, (i) => (i === 25 ? { price: 1 } : {})) }))
  await runExpect('30-line bill, technician: add a 31st line (size check, any length)', 'technician', T30, 'deny', (s) => updateDoc(s.doc('orders', fx.id), { items: [...many(30), line('extra', 500)] }))
}

// settings / users / roles / branches as admin and labAdmin
await runNormal('admin: save lab settings', 'A', (s) => labPatch(s, { registration: { zzRulesCheck: nid('v') } }))
await runNormal('labAdmin: save lab settings', 'L', (s) => labPatch(s, { registration: { zzRulesCheck: nid('v') }, dailyReport: { enabled: false, zz: nid('v') } }))
await runNormal('labAdmin: stamp own last login', 'L', (s) => updateDoc(s.doc('users', uidOf('L')), { lastLoginAt: serverTimestamp() }))
await runNormal('reception: stamp own last login', 'R', (s) => updateDoc(s.doc('users', uidOf('R')), { lastLoginAt: serverTimestamp() }))
await runNormal('reception: write own session document', 'R', (s) => setDoc(s.doc('users', uidOf('R'), 'sessions', 's1'), { device: 'x', seenAt: 1 }))

// partner portal rules stay as they were
{
  const portal = sessions.portal
  const own = `${PFX}centre`
  const bill = (extra = {}) => ({ ...orderData({ b2bCentreId: own, b2bCentreName: 'RC', billedTo: 'b2b' }), createdAt: serverTimestamp(), createdBy: portal.uid, ...extra })
  await runExpect('portal b2b: create its own bill', 'b2b portal', portal, 'allow', async (s) => { await trackedAdd(s, 'orders', bill()) })
  await runExpect('portal b2b: bill for another centre', 'b2b portal', portal, 'deny', async (s) => { await trackedAdd(s, 'orders', bill({ b2bCentreId: 'someone-else' })) })
  await runExpect('portal b2b: wallet debit for its bill', 'b2b portal', portal, 'allow', (s) => addWallet(s, wtx(s, { kind: 'debit', amount: -100, status: 'approved', centreId: own })))
  await runExpect('portal b2b: pending top-up request', 'b2b portal', portal, 'allow', (s) => addWallet(s, wtx(s, { kind: 'topup', amount: 5000, status: 'pending', centreId: own, requestedByPartner: true })))
  await runExpect('portal b2b: top-up that approves itself', 'b2b portal', portal, 'deny', (s) => addWallet(s, wtx(s, { kind: 'topup', amount: 5000, status: 'approved', centreId: own, requestedByPartner: true })))
  await runExpect('portal b2b: approval row', 'b2b portal', portal, 'deny', (s) => addWallet(s, wtx(s, { kind: 'approval', amount: 0, status: 'approved', centreId: own })))
  const id = await mkOrder({ b2bCentreId: own, b2bCentreName: 'RC', billedTo: 'b2b' })
  await runExpect('portal b2b: read its own bill', 'b2b portal', portal, 'allow', (s) => getDoc(s.doc('orders', id)).then((d) => { if (!d.exists()) throw new Error('missing') }))
  await runExpect('portal b2b: edit a bill', 'b2b portal', portal, 'deny', (s) => updateDoc(s.doc('orders', id), { discount: 1 }))
  await runExpect('portal b2b: void a bill', 'b2b portal', portal, 'deny', (s) => updateDoc(s.doc('orders', id), { deleted: true }))
  await runExpect('portal b2b: add a ledger payment', 'b2b portal', portal, 'deny', (s) => addDoc(s.col('orders', id, 'ledger'), stdLedger(s, { type: 'payment', mode: 'cash', amount: 100 })))
  await runExpect('portal b2b: write a test price', 'b2b portal', portal, 'deny', (s) => setDoc(s.doc('tests', nid('t')), { name: 'x', price: 1 }))
  await runExpect('portal b2b: change a lab setting', 'b2b portal', portal, 'deny', (s) => labPatch(s, { registration: { zzRulesCheck: nid('v') } }))
  await runExpect('inactive manager: void a bill', 'inactive mgr', sessions.I, 'deny', async (s) => updateDoc(s.doc('orders', await mkOrder()), { deleted: true }))
}

// ---------------------------------------------------------------------------------------------
// role document variants (phlebotomist carries the variants; expected values come from effectivePermissions)
// ---------------------------------------------------------------------------------------------
console.log('Running role-document variants...')
const VARIANT_ACTIONS = ACTIONS.filter((a) => ['bill', 'ledger', 'result', 'admin', 'catalogue', 'master', 'wallet'].includes(a.group)
  && !/forged|someone else|unknown type|edited afterwards|own role|own name|delete the lab|subscription/.test(a.name))
async function variant(title, role, permissions, users) {
  if (permissions !== undefined) await setRoleDoc(role, permissions)
  const before = rows.length
  for (const a of VARIANT_ACTIONS) await runAction({ ...a, name: `[${title}] ${a.name}`, group: `variant` }, users)
  return rows.length - before
}
// 1. no role document at all: built-in defaults apply (technician, doctor, reception, manager, admin)
for (const r of ['technician', 'doctor', 'reception', 'manager', 'admin']) {
  const k = { technician: 'T', doctor: 'D', reception: 'R', manager: 'M', admin: 'A' }[r]
  await variant(`no ${r} role doc`, r, null, [k])
  await setRoleDoc(r, [...DEFAULT_ROLE_PERMISSIONS[r]])
}
// 2. role document saved BEFORE the __v2 marker: implied keys are added (IMPLIED_BY)
const OLD = ['settings.manage', 'billing.void', 'billing.edit', 'registration.create', 'catalogue.edit', 'finance.view', 'users.manage', 'bookings.create', 'patients.view', 'results.view']
await variant('un-versioned role doc', 'phlebotomist', OLD, ['P'])
// 3. the same list WITH the marker: nothing implied
await variant('versioned role doc', 'phlebotomist', [...OLD, PERMISSIONS_V2], ['P'])
// 4. a role document with an empty list / without a permissions field falls back like the app does
await variant('role doc, empty list', 'phlebotomist', [PERMISSIONS_V2], ['P'])
await lcol('roles').doc('phlebotomist').set({ name: 'phlebotomist', builtIn: true })
roleDoc.phlebotomist = undefined
await variant('role doc without permissions field', 'phlebotomist', undefined, ['P'])
await setRoleDoc('phlebotomist', [...DEFAULT_ROLE_PERMISSIONS.phlebotomist])

// ---------------------------------------------------------------------------------------------
// 5. rules text vs permissions.ts (defaults and implied keys)
// ---------------------------------------------------------------------------------------------
const drift = []
{
  const keyRe = /'([a-z0-9]+\.[A-Za-z0-9]+)'/g
  const fnBody = (name) => {
    const i = rulesText.indexOf(`function ${name}(`)
    if (i < 0) return ''
    let depth = 0, j = rulesText.indexOf('{', i)
    const start = j
    for (; j < rulesText.length; j++) { if (rulesText[j] === '{') depth++; else if (rulesText[j] === '}' && --depth === 0) break }
    return rulesText.slice(start, j + 1)
  }
  const defaultsBody = fnBody('roleDefaults')
  const impliedBody = fnBody('impliedKeys')
  const rest = rulesText.replace(defaultsBody, '').replace(impliedBody, '')
  const guarded = new Set([...rest.matchAll(keyRe)].map((m) => m[1]).filter((k) => ALL_PERMISSIONS.includes(k)))
  const listFor = (role) => {
    const m = new RegExp(`role == '${role}' \\? \\[([^\\]]*)\\]`).exec(defaultsBody)
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null
  }
  for (const role of ROLES) {
    const got = listFor(role)
    const want = [...DEFAULT_ROLE_PERMISSIONS[role]].filter((k) => guarded.has(k) || k === PERMISSIONS_V2)
    if (role === 'phlebotomist') {
      const tail = /: \['__v2'\];/.test(defaultsBody)
      drift.push({ name: `defaults in rules: ${role}`, ok: tail && want.length === 1, why: `rules fall through to ['__v2']; permissions.ts has ${want.join(', ')}` })
      continue
    }
    const missing = want.filter((k) => !(got ?? []).includes(k))
    const extra = (got ?? []).filter((k) => !want.includes(k))
    drift.push({ name: `defaults in rules: ${role}`, ok: !!got && !missing.length && !extra.length, why: `missing [${missing}] extra [${extra}]` })
  }
  // guarded keys a role default has but roleDefaults lacks are caught above; keys in roleDefaults that no rule uses:
  const unusedDefaults = [...new Set([...defaultsBody.matchAll(keyRe)].map((m) => m[1]))].filter((k) => !guarded.has(k))
  drift.push({ name: 'roleDefaults only lists keys that some rule checks', ok: !unusedDefaults.length, why: `unused [${unusedDefaults}]` })
  // implied keys
  const gotImplied = {}
  for (const m of impliedBody.matchAll(/\('([^']+)' in rp\) \? \[([^\]]*)\]/g)) for (const k of m[2].matchAll(/'([^']+)'/g)) (gotImplied[k[1]] ??= []).push(m[1])
  const wantImplied = Object.entries(IMPLIED_BY).filter(([k]) => guarded.has(k) || k === 'bookings.manage' || k === 'quotation.manage')
  for (const [k, old] of wantImplied) drift.push({ name: `implied: ${k} <- ${old}`, ok: (gotImplied[k] ?? []).includes(old), why: 'missing in impliedKeys()' })
  for (const [k, olds] of Object.entries(gotImplied)) for (const old of olds) drift.push({ name: `implied (rules): ${k} <- ${old} exists in IMPLIED_BY`, ok: IMPLIED_BY[k] === old, why: `IMPLIED_BY says ${IMPLIED_BY[k]}` })
  drift.push({ name: 'rules use the same marker as the app', ok: /'__v2' in rp/.test(rulesText) && PERMISSIONS_V2 === '__v2', why: '' })
}
for (const d of drift) if (!d.ok) fails.push(`drift: ${d.name} (${d.why})`)

// ---------------------------------------------------------------------------------------------
// 6. clean up
// ---------------------------------------------------------------------------------------------
await cleanup()

// ---------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n)
const cell = (c) => (c ? `${c.got === 'allow' ? 'Y' : c.got === 'deny' ? '-' : 'E'}${c.exp === c.got ? ' ' : '!'}` : ' .')
const mainRows = rows.filter((r) => r.group !== 'variant')
const variantRows = rows.filter((r) => r.group === 'variant')
const header = `${pad('result', 6)} ${pad('guarded write', 62)} ${ACTIVE.map((k) => pad(k, 2)).join(' ')}`
console.log('\nUsers: ' + ACTIVE.map((k) => `${k}=${LABEL[k]}`).join(', ') + '.  Y = write allowed, - = denied, E = other error, "!" = differs from the expectation derived from permissions.ts')
console.log('\n' + header)
let lastGroup = ''
for (const r of mainRows) {
  if (r.group !== lastGroup) { console.log(`-- ${r.group}`); lastGroup = r.group }
  const ok = Object.values(r.cells).every((c) => c.exp === c.got)
  console.log(`${pad(ok ? 'PASS' : 'FAIL', 6)} ${pad(r.name, 62)} ${ACTIVE.map((k) => pad(cell(r.cells[k]), 2)).join(' ')}`)
}
console.log('\nRole document variants (expected from effectivePermissions with that role document):')
for (const r of variantRows) {
  const ok = Object.values(r.cells).every((c) => c.exp === c.got)
  const [k, c] = Object.entries(r.cells)[0]
  console.log(`${pad(ok ? 'PASS' : 'FAIL', 6)} ${pad(r.name, 84)} ${LABEL[k]}: ${c.got}`)
}
console.log('\nNormal flows (must be ALLOWED) and partner-portal checks:')
for (const n of normal) console.log(`${pad(n.exp === n.got ? 'PASS' : 'FAIL', 6)} ${pad(n.name, 74)} as ${pad(n.who, 16)} expected ${n.exp}, got ${n.got}`)
console.log('\nRules text vs src/auth/permissions.ts:')
for (const d of drift) console.log(`${pad(d.ok ? 'PASS' : 'FAIL', 6)} ${d.name}${d.ok ? '' : ' -> ' + d.why}`)

const cellCount = rows.reduce((n, r) => n + Object.keys(r.cells).length, 0)
const total = cellCount + normal.length + drift.length
console.log(`\n${total - fails.length} of ${total} checks passed (${cellCount} guarded-write cells, ${normal.length} flow / portal checks, ${drift.length} drift checks).`)
if (fails.length) {
  console.log('\nFAILURES:')
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
console.log('ALL PASS')
process.exit(0)
