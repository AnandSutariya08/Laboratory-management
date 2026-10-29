// Creates test logins for client testing: one staff login per role, plus one partner portal login per portal
// role, each linked to its own test partner (B2B centre, collection centre, corporate client, referring doctor).
// Every login gets a random password. The list is written to a private text file and a PDF to share with the
// client (outside the repo; the PDF is printed by the local Google Chrome) and also printed here.
// Everything it creates is marked testAccount: true, so REMOVE=1 deletes exactly these and nothing else.
//
// Local emulators:  node scripts/test-users.mjs   (emulators must be running)
// Real project:     GOOGLE_APPLICATION_CREDENTIALS=~/keys/lms-admin.json PRODUCTION=1 \
//                   FIREBASE_PROJECT=laboratory-management-systems node scripts/test-users.mjs
// Remove them:      add REMOVE=1 to the same command.
import { randomInt } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { ROLE_LABEL } from '../src/auth/permissions.ts'

const production = process.env.PRODUCTION === '1'
const projectId = process.env.FIREBASE_PROJECT || 'demo-health-care-labs'
const labId = process.env.LAB_ID || 'main'
const databaseId = process.env.FIRESTORE_DB || 'health-care-labs'
const domain = process.env.TEST_DOMAIN || 'hcl-test.in'
const appUrl = process.env.APP_URL || (production ? 'https://laboratory-management-systems.web.app' : 'http://localhost:5180')
const outFile = process.env.OUT_FILE || join(homedir(), 'keys', `hcl-test-logins${production ? '' : '-local'}.txt`)

if (!production) {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
}
initializeApp({ projectId })
const db = getFirestore(databaseId)
const auth = getAuth()
const lab = db.collection('labs').doc(labId)
const rupees = (r) => Math.round(r * 100)

// 12 characters without look-alikes (0/O, 1/l/I), so it can be read out or typed from a message.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
const password = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')

const STAFF = [
  { role: 'admin', username: 'test.admin', maxDiscountPct: 100, allBranches: true,
    tests: 'Everything, including lab settings, users and roles' },
  { role: 'manager', username: 'test.manager', maxDiscountPct: 50, allBranches: true,
    tests: 'Daily operations, reports, analysis and finance' },
  { role: 'reception', username: 'test.reception', maxDiscountPct: 10, allBranches: false,
    tests: 'Patient registration, billing, payments and bookings' },
  { role: 'technician', username: 'test.technician', maxDiscountPct: 0, allBranches: false,
    tests: 'Sample accession, result entry and quality control' },
  { role: 'doctor', username: 'test.doctor', maxDiscountPct: 0, allBranches: false,
    tests: 'Reviewing, approving and signing reports' },
  { role: 'phlebotomist', username: 'test.phlebotomist', maxDiscountPct: 0, allBranches: false,
    tests: 'Home-collection bookings and sample collection' },
]

// Portal logins: each is linked to its own test partner through partnerId (that is what limits it to its own data).
const PARTNERS = [
  { role: 'b2b', username: 'test.b2b', collection: 'b2bCentres', id: 'test-b2b', name: 'Test B2B Lab',
    tests: 'Partner portal: register patients, wallet, bills and reports',
    doc: (email) => ({ code: 'B2B-TEST', city: 'Pune', phone: '9000000101', email, address: '', active: true,
      creditType: 'creditLimit', securityAmount: 0, creditLimit: rupees(50000), lowBalanceAlert: rupees(5000), paymentTerms: '', paymentMethod: 'manual',
      rateListId: '', bank: { bank: '', account: '', ifsc: '', pan: '' }, settings: {} }) },
  { role: 'collectionCentre', username: 'test.centre', collection: 'collectionCentres', id: 'test-cc', name: 'Test Collection Centre',
    tests: 'Partner portal: register patients, dispatch samples, dues and reports',
    doc: (email) => ({ code: 'CC-TEST', city: 'Pune', phone: '9000000102', email, address: '', active: true,
      loginEmail: email, rateListId: '', settlementType: 'sharePercent', settlementValue: 20, settlementDays: 30,
      dueReportView: false, allowBillDelete: false, referrals: 'all', upiId: '', qrWidth: 120, qrHeight: 120 }) },
  { role: 'corporate', username: 'test.corporate', collection: 'corporateClients', id: 'test-corp', name: 'Test Corporate Client',
    tests: 'Partner portal: employee tests, bills and reports',
    doc: (email) => ({ phone: '9000000103', email, type: 'company', address: '', contactPerson: 'HR Desk', active: true,
      planPackageIds: [], creditDays: 30, creditLimit: rupees(100000), creditTerms: '', rateListId: '', employeeIdRequired: false, disableLetterhead: false, hidePlan: false,
      loginEmail: email, companies: [], employees: [] }) },
  { role: 'referrer', username: 'test.doctor.referrer', collection: 'referrers', id: 'test-ref', name: 'Dr Test Referrer',
    tests: 'Doctor portal: referred patients, reports and commission',
    doc: (email) => ({ type: 'doctor', phone: '9000000104', email, address: '', speciality: 'General medicine',
      commissionType: 'percent', commissionValue: 10, rateListId: '', proManagerId: '', temporary: false, active: true, loginAccess: true }) },
]

const emailFor = (username) => `${username}@${domain}`

async function upsertLogin({ email, name, pw }) {
  try {
    const u = await auth.getUserByEmail(email)
    await auth.updateUser(u.uid, { password: pw, displayName: name, disabled: false })
    return u.uid
  } catch {
    return (await auth.createUser({ email, password: pw, displayName: name })).uid
  }
}

async function create() {
  const rows = []
  for (const s of STAFF) {
    const email = emailFor(s.username)
    const name = `Test ${ROLE_LABEL[s.role]}`
    const pw = password()
    const uid = await upsertLogin({ email, name, pw })
    await lab.collection('users').doc(uid).set({
      uid, name, email, username: s.username, role: s.role, labId, active: true, maxDiscountPct: s.maxDiscountPct,
      branchIds: ['main'], defaultBranchId: 'main', allBranches: s.allBranches, grants: [], denies: [], testAccount: true,
    })
    await auth.setCustomUserClaims(uid, { lab: labId, role: s.role, active: true, partnerId: '' })
    rows.push({ who: name, role: ROLE_LABEL[s.role], email, username: s.username, pw, linked: '', tests: s.tests, portal: false })
  }
  for (const p of PARTNERS) {
    const email = emailFor(p.username)
    await lab.collection(p.collection).doc(p.id).set({ id: p.id, name: p.name, ...p.doc(email), testAccount: true }, { merge: true })
    const pw = password()
    const uid = await upsertLogin({ email, name: p.name, pw })
    await lab.collection('users').doc(uid).set({
      uid, name: p.name, email, username: p.username, role: p.role, partnerId: p.id, labId, active: true, maxDiscountPct: 0,
      branchIds: ['main'], defaultBranchId: 'main', allBranches: false, grants: [], denies: [], testAccount: true,
    })
    await auth.setCustomUserClaims(uid, { lab: labId, role: p.role, active: true, partnerId: p.id })
    rows.push({ who: p.name, role: ROLE_LABEL[p.role], email, username: p.username, pw, linked: p.name, tests: p.tests, portal: true })
  }

  const text = [
    `Health Care Labs: test logins (${production ? 'live site' : 'local emulator'})`,
    `Sign in at: ${appUrl}`,
    `Sign in with the email or the username. Patients check reports at ${appUrl}/my-reports`,
    '',
    ...rows.map((r) => [
      `${r.role}${r.linked ? ` (linked to ${r.linked})` : ''}`,
      `  Email:    ${r.email}`,
      `  Username: ${r.username}`,
      `  Password: ${r.pw}`,
      '',
    ].join('\n')),
  ].join('\n')
  mkdirSync(join(outFile, '..'), { recursive: true })
  writeFileSync(outFile, text, { mode: 0o600 })
  console.log(text)
  console.log(`Saved to ${outFile} (only you can read it). Running this again gives every test login a new password.`)
  const pdf = writePdf(rows, outFile.replace(/\.txt$/, '') + '.pdf')
  if (pdf) console.log(`PDF for the client: ${pdf}`)
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function loginTable(rows) {
  return `<table><colgroup><col><col class="c-role"><col class="c-tests"><col><col><col></colgroup><thead><tr><th>#</th><th>Role</th><th>What to test</th><th>Username</th><th>Email</th><th>Password</th></tr></thead><tbody>${rows
    .map((r, i) => `<tr><td class="n">${i + 1}</td><td><b>${esc(r.role.replace(/ \(portal\)$/, ''))}</b>${r.linked ? `<div class="sub">Linked to ${esc(r.linked)}</div>` : ''}</td>`
      + `<td>${esc(r.tests)}</td><td class="mono">${esc(r.username)}</td><td class="mono small">${esc(r.email)}</td><td class="mono pw">${esc(r.pw)}</td></tr>`)
    .join('')}</tbody></table>`
}

// One landscape A4 page (two if needed), printed by the local Google Chrome so the links stay clickable.
function writePdf(rows, pdfFile) {
  const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (!existsSync(chrome)) {
    console.log('Google Chrome not found, so no PDF was made (set CHROME to its path).')
    return ''
  }
  const date = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Health Care Labs test logins</title><style>
@page { size: A4 landscape; margin: 10mm 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 9.5pt/1.35 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #10202e; }
a { color: #0369a1; text-decoration: none; font-weight: 600; }
.head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #0369a1; padding-bottom: 8px; }
h1 { margin: 0; font-size: 20pt; color: #062b45; }
.head p { margin: 2px 0 0; color: #4a5d6c; }
.date { color: #4a5d6c; font-size: 9.5pt; text-align: right; }
.links { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0 4px; }
.box { border: 1px solid #c9d8e4; border-radius: 8px; padding: 6px 12px; background: #f3f8fc; }
.box .k { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #4a5d6c; font-weight: 700; }
.box a { font-size: 12pt; }
.box .sub { margin-top: 1px; }
h2 { font-size: 11pt; margin: 10px 0 5px; color: #062b45; }
table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { background: #062b45; color: #fff; text-align: left; font-size: 8.5pt; padding: 5px 8px; }
td { border-bottom: 1px solid #dbe5ed; padding: 4px 8px; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f7fafc; }
.n { color: #4a5d6c; width: 22px; }
.sub { color: #4a5d6c; font-size: 8.5pt; }
.mono { font-family: Menlo, Consolas, monospace; font-size: 9.5pt; }
.small { font-size: 8.5pt; white-space: nowrap; }
.mono:not(.small) { white-space: nowrap; }
col.c-role { width: 20%; } col.c-tests { width: 31%; }
.pw { font-weight: 700; color: #062b45; letter-spacing: .03em; white-space: nowrap; }
ol { margin: 4px 0 0; padding-left: 18px; }
ol li { margin-bottom: 1px; }
</style></head><body>
<div class="head"><div><h1>Health Care Labs: test logins</h1><p>Logins for testing the lab system${production ? '' : ' (local test copy)'}.</p></div>
<div class="date">Prepared ${esc(date)}<br>Confidential: do not forward</div></div>
<div class="links">
<div class="box"><div class="k">Sign in here (staff and partners)</div><a href="${esc(appUrl)}">${esc(appUrl)}</a><div class="sub">Sign in with the username or the email, and the password below.</div></div>
<div class="box"><div class="k">Patients: view and download reports</div><a href="${esc(appUrl)}/my-reports">${esc(appUrl)}/my-reports</a><div class="sub">Patients sign in with a code sent to their mobile. Available once SMS is switched on.</div></div>
</div>
<h2>Lab staff logins</h2>${loginTable(rows.filter((r) => !r.portal))}
<h2>Partner portal logins</h2>${loginTable(rows.filter((r) => r.portal))}
<h2>How to start</h2><ol>
<li>Open the sign-in link above in Chrome, Edge or Safari, on a computer or phone.</li>
<li>Enter the username (for example <span class="mono">test.reception</span>) and its password, then select <b>Sign in</b>.</li>
<li>Each login only shows the screens its role allows. Partner logins see only their own partner's patients and bills.</li>
<li>Use made-up patient names and numbers. Everything you enter is saved. Passwords are case-sensitive.</li>
<li>WhatsApp, SMS and online payment are not switched on yet; reports can be downloaded and sent by email. These test logins will be removed after testing.</li>
</ol>
</body></html>`
  const htmlFile = pdfFile.replace(/\.pdf$/, '.html')
  writeFileSync(htmlFile, html, { mode: 0o600 })
  try {
    execFileSync(chrome, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfFile}`, `file://${htmlFile}`], { stdio: 'ignore' })
    chmodSync(pdfFile, 0o600)
  } finally {
    rmSync(htmlFile, { force: true })
  }
  return pdfFile
}

async function remove() {
  const users = await lab.collection('users').where('testAccount', '==', true).get()
  for (const d of users.docs) {
    await auth.deleteUser(d.id).catch(() => {})
    await d.ref.delete()
  }
  let partners = 0
  for (const p of PARTNERS) {
    const ref = lab.collection(p.collection).doc(p.id)
    const snap = await ref.get()
    if (snap.exists && snap.get('testAccount') === true) {
      await ref.delete()
      partners++
    }
  }
  console.log(`Removed ${users.size} test logins and ${partners} test partners. Bills and patients they created are kept.`)
}

;(process.env.REMOVE === '1' ? remove() : create()).then(() => process.exit(0), (e) => {
  console.error(e)
  process.exit(1)
})
