// Seeds a lab: settings, departments, sample types, a starter test catalogue,
// one package, branches (main + a demo second branch), default roles and the first
// admin login (all branches).
//
// Local emulators:  npm run seed            (emulators must be running)
// Real project:     PRODUCTION=1 FIREBASE_PROJECT=<id> ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seed.mjs
//                   (uses your gcloud application-default login). PRODUCTION=1 creates only the lab settings, the
//                   main branch, roles, departments, sample types, reasons and the admin: no demo tests, demo
//                   branch or demo partner logins.
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
// Node runs the TypeScript source directly (type stripping), so the seeded role
// defaults can never drift from the app's DEFAULT_ROLE_PERMISSIONS.
import { DEFAULT_ROLE_PERMISSIONS, ROLE_LABEL } from '../src/auth/permissions.ts'

const projectId = process.env.FIREBASE_PROJECT || 'demo-health-care-labs'
const labId = process.env.LAB_ID || 'main'
const adminEmail = process.env.ADMIN_EMAIL || 'admin@healthcarelabs.local'
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123'

const production = process.env.PRODUCTION === '1'
const databaseId = process.env.FIRESTORE_DB || 'health-care-labs'
if (production && (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)) {
  console.error('PRODUCTION=1 needs ADMIN_EMAIL and ADMIN_PASSWORD.')
  process.exit(1)
}

initializeApp({ projectId })
const db = getFirestore(databaseId)
const auth = getAuth()
const lab = db.collection('labs').doc(labId)

const rupees = (r) => Math.round(r * 100)

// Parameter helper: numeric with a plain reference range.
const num = (key, name, unit, low, high, extra = {}) => ({
  key, name, structure: 'single', parentKey: null, dataType: 'numeric', unit, options: [],
  low, high, ranges: [], criticalLow: null, criticalHigh: null, displayRange: '', formula: '',
  required: false, hideOnReport: false, method: '', ...extra,
})
const group = (key, name) => ({ ...num(key, name, '', null, null), structure: 'group' })
const calc = (key, name, unit, low, high, formula, parentKey = null) =>
  num(key, name, unit, low, high, { formula, parentKey })

const departments = [
  { id: 'haematology', name: 'Haematology', order: 1 },
  { id: 'biochemistry', name: 'Biochemistry', order: 2 },
  { id: 'clinical-pathology', name: 'Clinical Pathology', order: 3 },
  { id: 'serology', name: 'Serology', order: 4 },
]

const sampleTypes = [
  { id: 'edta', name: 'EDTA Whole Blood', tubeColor: '#7C3AED' },
  { id: 'serum', name: 'Serum', tubeColor: '#DC2626' },
  { id: 'fluoride', name: 'Fluoride Plasma', tubeColor: '#6B7280' },
  { id: 'urine', name: 'Urine', tubeColor: '#EAB308' },
]

// Reference values follow commonly published adult ranges; a pathologist must
// review them before clinical use.
const tests = [
  {
    id: 'cbc', code: 'CBC', name: 'Complete Blood Count', departmentId: 'haematology',
    sampleTypeId: 'edta', price: rupees(350), gender: 'both', tatMinutes: 240, urgentTatMinutes: 60,
    interpretation: '', disabled: false, order: 1,
    parameters: [
      num('HB', 'Haemoglobin', 'g/dL', 12, 17, { criticalLow: 7, criticalHigh: 20 }),
      num('TLC', 'Total Leucocyte Count', '/cumm', 4000, 11000, { criticalLow: 2000, criticalHigh: 30000 }),
      group('DLC', 'Differential Leucocyte Count'),
      num('NEUT', 'Neutrophils', '%', 40, 75, { parentKey: 'DLC' }),
      num('LYMPH', 'Lymphocytes', '%', 20, 45, { parentKey: 'DLC' }),
      num('EOS', 'Eosinophils', '%', 1, 6, { parentKey: 'DLC' }),
      num('MONO', 'Monocytes', '%', 2, 10, { parentKey: 'DLC' }),
      calc('BASO', 'Basophils', '%', 0, 1, '100 - (NEUT + LYMPH + EOS + MONO)', 'DLC'),
      group('ALC', 'Absolute Leucocyte Count'),
      calc('ANC', 'Absolute Neutrophils', '/cumm', 2000, 7000, 'TLC * NEUT / 100', 'ALC'),
      calc('ALC_L', 'Absolute Lymphocytes', '/cumm', 1000, 3000, 'TLC * LYMPH / 100', 'ALC'),
      calc('AEC', 'Absolute Eosinophils', '/cumm', 20, 500, 'TLC * EOS / 100', 'ALC'),
      calc('AMC', 'Absolute Monocytes', '/cumm', 200, 1000, 'TLC * MONO / 100', 'ALC'),
      group('RBCI', 'RBC Indices'),
      num('RBC', 'RBC Count', 'million/cumm', 4.5, 5.5, { parentKey: 'RBCI' }),
      num('HCT', 'Haematocrit (PCV)', '%', 40, 50, { parentKey: 'RBCI' }),
      calc('MCV', 'MCV', 'fL', 83, 101, 'HCT / RBC * 10', 'RBCI'),
      calc('MCH', 'MCH', 'pg', 27, 32, 'HB / RBC * 10', 'RBCI'),
      calc('MCHC', 'MCHC', 'g/dL', 31.5, 34.5, 'HB / HCT * 100', 'RBCI'),
      num('PLT', 'Platelet Count', 'lakh/cumm', 1.5, 4.1, { criticalLow: 0.2 }),
    ],
  },
  {
    id: 'fbs', code: 'FBS', name: 'Glucose Fasting', departmentId: 'biochemistry', sampleTypeId: 'fluoride',
    price: rupees(80), gender: 'both', tatMinutes: 120, urgentTatMinutes: 30, interpretation: '',
    disabled: false, order: 2,
    parameters: [num('FBS', 'Glucose, Fasting', 'mg/dL', 70, 100, { criticalLow: 40, criticalHigh: 400 })],
  },
  {
    id: 'lipid', code: 'LIPID', name: 'Lipid Profile', departmentId: 'biochemistry', sampleTypeId: 'serum',
    price: rupees(500), gender: 'both', tatMinutes: 360, urgentTatMinutes: 120, interpretation: '',
    disabled: false, order: 3,
    parameters: [
      num('CHOL', 'Total Cholesterol', 'mg/dL', null, 200),
      num('TG', 'Triglycerides', 'mg/dL', null, 150),
      num('HDL', 'HDL Cholesterol', 'mg/dL', 40, null),
      calc('VLDL', 'VLDL Cholesterol', 'mg/dL', null, 30, 'TG / 5'),
      calc('LDL', 'LDL Cholesterol', 'mg/dL', null, 100, 'CHOL - HDL - TG / 5'),
      calc('CHOL_HDL', 'Cholesterol / HDL Ratio', '', null, 5, 'CHOL / HDL'),
    ],
  },
  {
    id: 'lft', code: 'LFT', name: 'Liver Function Test', departmentId: 'biochemistry', sampleTypeId: 'serum',
    price: rupees(600), gender: 'both', tatMinutes: 360, urgentTatMinutes: 120, interpretation: '',
    disabled: false, order: 4,
    parameters: [
      num('TBIL', 'Bilirubin, Total', 'mg/dL', 0.2, 1.2),
      num('DBIL', 'Bilirubin, Direct', 'mg/dL', 0, 0.3),
      calc('IBIL', 'Bilirubin, Indirect', 'mg/dL', 0.2, 0.9, 'TBIL - DBIL'),
      num('SGOT', 'AST (SGOT)', 'U/L', 0, 40),
      num('SGPT', 'ALT (SGPT)', 'U/L', 0, 41),
      num('ALP', 'Alkaline Phosphatase', 'U/L', 40, 129),
      num('TP', 'Total Protein', 'g/dL', 6.4, 8.3),
      num('ALB', 'Albumin', 'g/dL', 3.5, 5.2),
      calc('GLOB', 'Globulin', 'g/dL', 2.3, 3.5, 'TP - ALB'),
      calc('AG', 'A/G Ratio', '', 1.0, 2.1, 'ALB / (TP - ALB)'),
    ],
  },
  {
    id: 'ue', code: 'URINE', name: 'Urine Routine Examination', departmentId: 'clinical-pathology',
    sampleTypeId: 'urine', price: rupees(150), gender: 'both', tatMinutes: 120, urgentTatMinutes: 60,
    interpretation: '', disabled: false, order: 5,
    parameters: [
      { ...num('COLOUR', 'Colour', '', null, null), dataType: 'options', options: ['Pale Yellow', 'Yellow', 'Dark Yellow', 'Red', 'Colourless'], displayRange: 'Pale Yellow' },
      { ...num('APP', 'Appearance', '', null, null), dataType: 'options', options: ['Clear', 'Slightly Turbid', 'Turbid'], displayRange: 'Clear' },
      num('SG', 'Specific Gravity', '', 1.005, 1.03),
      num('PH', 'pH', '', 4.5, 8),
      { ...num('PROT', 'Protein', '', null, null), dataType: 'options', options: ['Nil', 'Trace', '+', '++', '+++'], displayRange: 'Nil' },
      { ...num('GLU', 'Glucose', '', null, null), dataType: 'options', options: ['Nil', 'Trace', '+', '++', '+++'], displayRange: 'Nil' },
      { ...num('PUS', 'Pus Cells', '/hpf', null, null), dataType: 'text', displayRange: '0 - 5' },
      { ...num('EPI', 'Epithelial Cells', '/hpf', null, null), dataType: 'text', displayRange: '0 - 5' },
    ],
  },
  {
    id: 'tsh', code: 'TSH', name: 'Thyroid Stimulating Hormone', departmentId: 'serology', sampleTypeId: 'serum',
    price: rupees(300), gender: 'both', tatMinutes: 480, urgentTatMinutes: 180, interpretation: '',
    disabled: false, order: 6,
    parameters: [num('TSH', 'TSH', 'µIU/mL', 0.27, 4.2)],
  },
]

// Starter reasons master (picklists for delete, discount, reject, hold, re-run and amend dialogs).
const reasons = [
  ['void', 'Entered by mistake'], ['void', 'Duplicate bill'], ['void', 'Patient cancelled'],
  ['discount', 'Senior citizen'], ['discount', 'Staff / family'], ['discount', 'Referral'],
  ['reject', 'Haemolysed sample'], ['reject', 'Insufficient quantity'], ['reject', 'Wrong container'],
  ['hold', 'Awaiting repeat sample'], ['rerun', 'Value out of range'], ['amend', 'Transcription error'], ['sendback', 'Please re-check'],
].map(([kind, text], i) => ({ id: `${kind}-${i + 1}`, kind, text }))

const packages = [
  { id: 'basic-health', code: 'BHC', name: 'Basic Health Check', price: rupees(999), testIds: ['cbc', 'fbs', 'lipid', 'ue'], disabled: false },
]

async function main() {
  await lab.set({
    name: 'Health Care Labs', address: '', phone: '', email: '', billPrefix: 'HCL',
    finalRequiresPayment: true, allowEmptyApproval: false, allowSelfVerification: true,
    discountReasonRequired: true, dispatchDefaults: ['hardcopy'],
  }, { merge: true })

  const batch = db.batch()
  for (const d of departments) batch.set(lab.collection('departments').doc(d.id), d)
  for (const s of sampleTypes) batch.set(lab.collection('sampleTypes').doc(s.id), s)
  if (!production) {
    for (const t of tests) batch.set(lab.collection('tests').doc(t.id), t)
    for (const p of packages) batch.set(lab.collection('packages').doc(p.id), p)
  }
  for (const r of reasons) batch.set(lab.collection('reasons').doc(r.id), r, { merge: true })
  await batch.commit()

  // Branches. Catalogue and patients are shared; bills, stock, QC etc. are per branch.
  await lab.collection('branches').doc('main').set(
    { name: 'Main Branch', code: 'MAIN', address: '', phone: '', email: '', billPrefix: '', active: true },
    { merge: true },
  )
  if (!production) {
    await lab.collection('branches').doc('city').set(
      { name: 'City Branch', code: 'CITY', address: '', phone: '', email: '', billPrefix: '', active: true },
      { merge: true },
    )
  }

  // Roles: the editable permissions matrix. Existing (edited) roles are never overwritten.
  for (const [role, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const ref = lab.collection('roles').doc(role)
    if (!(await ref.get()).exists) await ref.set({ name: ROLE_LABEL[role], permissions, builtIn: true })
  }

  let user
  try {
    user = await auth.getUserByEmail(adminEmail)
  } catch {
    user = await auth.createUser({ email: adminEmail, password: adminPassword, displayName: 'Lab Admin' })
  }
  await lab.collection('users').doc(user.uid).set({
    uid: user.uid, name: 'Lab Admin', email: adminEmail, role: 'labAdmin', labId, active: true, maxDiscountPct: 100,
    branchIds: production ? ['main'] : ['main', 'city'], defaultBranchId: 'main', allBranches: true, grants: [], denies: [],
  })
  // Storage rules read the role from the sign-in token (the syncUserClaims function keeps it current).
  await auth.setCustomUserClaims(user.uid, { lab: labId, role: 'labAdmin', active: true, partnerId: '' })
  if (production) {
    console.log(`Production lab "${labId}" set up in database ${databaseId}. Admin login: ${adminEmail}`)
    return
  }
  // Demo partner portal logins: one per portal role, each linked to a seeded partner document.
  // Same password as the admin unless PARTNER_PASSWORD is set. Existing partner docs are merged, not replaced.
  const partnerPassword = process.env.PARTNER_PASSWORD || adminPassword
  const partners = [
    { role: 'b2b', email: 'b2b@healthcarelabs.local', name: 'Demo B2B Centre', collection: 'b2bCentres', id: 'demo-b2b',
      doc: { name: 'Demo B2B Centre', code: 'B2B-DEMO', city: 'Pune', phone: '9000000001', email: 'b2b@healthcarelabs.local', address: '', active: true,
        creditType: 'creditLimit', securityAmount: 0, creditLimit: rupees(50000), lowBalanceAlert: rupees(5000), paymentTerms: '', paymentMethod: 'manual',
        rateListId: '', bank: { bank: '', account: '', ifsc: '', pan: '' }, settings: {} } },
    { role: 'collectionCentre', email: 'collectioncentre@healthcarelabs.local', name: 'Demo Collection Centre', collection: 'collectionCentres', id: 'demo-cc',
      doc: { name: 'Demo Collection Centre', code: 'CC-DEMO', city: 'Pune', phone: '9000000002', email: 'collectioncentre@healthcarelabs.local', address: '', active: true,
        loginEmail: 'collectioncentre@healthcarelabs.local', rateListId: '', settlementType: 'sharePercent', settlementValue: 20, settlementDays: 30,
        dueReportView: false, allowBillDelete: false, referrals: 'all', upiId: '', qrWidth: 120, qrHeight: 120 } },
    { role: 'corporate', email: 'corporate@healthcarelabs.local', name: 'Demo Corporate Client', collection: 'corporateClients', id: 'demo-corp',
      doc: { name: 'Demo Corporate Client', phone: '9000000003', email: 'corporate@healthcarelabs.local', type: 'company', address: '', contactPerson: 'HR Desk', active: true,
        planPackageIds: [], creditDays: 30, creditLimit: rupees(100000), creditTerms: '', rateListId: '', employeeIdRequired: false, disableLetterhead: false, hidePlan: false,
        loginEmail: 'corporate@healthcarelabs.local', companies: [], employees: [] } },
    { role: 'referrer', email: 'referrer@healthcarelabs.local', name: 'Dr Demo Referrer', collection: 'referrers', id: 'demo-ref',
      doc: { name: 'Dr Demo Referrer', type: 'doctor', phone: '9000000004', email: 'referrer@healthcarelabs.local', address: '', speciality: 'General medicine',
        commissionType: 'percent', commissionValue: 10, rateListId: '', proManagerId: '', temporary: false, active: true, loginAccess: true } },
  ]
  for (const p of partners) {
    await lab.collection(p.collection).doc(p.id).set({ id: p.id, ...p.doc }, { merge: true })
    let pu
    try {
      pu = await auth.getUserByEmail(p.email)
    } catch {
      pu = await auth.createUser({ email: p.email, password: partnerPassword, displayName: p.name })
    }
    await lab.collection('users').doc(pu.uid).set({
      uid: pu.uid, name: p.name, email: p.email, role: p.role, partnerId: p.id, labId, active: true, maxDiscountPct: 0,
      branchIds: ['main'], defaultBranchId: 'main', allBranches: false, grants: [], denies: [],
    })
    await auth.setCustomUserClaims(pu.uid, { lab: labId, role: p.role, active: true, partnerId: p.id })
  }

  console.log(`Seeded lab "${labId}" with ${tests.length} tests, 2 branches, ${Object.keys(DEFAULT_ROLE_PERMISSIONS).length} roles. Admin login: ${adminEmail}. Portal logins: ${partners.map((p) => p.email).join(', ')}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
