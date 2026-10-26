// Help topics for the in-app support assistant. The assistant answers ONLY from this list, so every
// topic is a short, self-contained explanation of how the app works. Keep ids stable: answers cite them.
// Screen names match the sidebar (src/layout/nav.ts).

export interface HelpTopic {
  id: string
  area: string
  title: string
  screen: string // where to find it in the app
  keywords: string[]
  body: string
}

export const HELP_TOPICS: HelpTopic[] = [
  // ---- Registration and billing ----
  {
    id: 'reg-new-bill',
    area: 'Registration',
    title: 'Register a patient and create a bill',
    screen: 'New Registration',
    keywords: ['register', 'registration', 'new bill', 'patient', 'walk-in', 'create bill'],
    body: 'Open New Registration. Search for an existing patient by name or phone, or fill in a new one (name, gender, age, phone). Add tests or packages to the bill, choose the referring doctor if any, then take payment and save. Saving creates the bill number and prints or opens the bill.',
  },
  {
    id: 'reg-discount',
    area: 'Registration',
    title: 'Give a discount on a bill',
    screen: 'New Registration',
    keywords: ['discount', 'concession', 'percent', 'waive', 'reason'],
    body: 'On the bill, use the discount field to enter an amount or a percentage. A reason is recorded with the discount and the staff member who gave it is saved. Who may give discounts, and up to what limit, is controlled by roles and lab settings.',
  },
  {
    id: 'reg-payment',
    area: 'Billing',
    title: 'Take payment, part payment and clear dues',
    screen: 'New Registration, Patient List',
    keywords: ['payment', 'cash', 'upi', 'card', 'part payment', 'due', 'clear due', 'balance', 'receipt'],
    body: 'Payment can be cash, UPI, card or another mode the lab has added. A bill can be paid in part; the unpaid amount stays as the bill due. To clear a due later, open the patient or bill in Patient List and add a payment. Each payment gets a receipt number.',
  },
  {
    id: 'bill-refund',
    area: 'Billing',
    title: 'Refund or cancel a test on a bill',
    screen: 'Patient List',
    keywords: ['refund', 'cancel test', 'void', 'return money', 'cancel bill'],
    body: 'Open the bill from Patient List and use the refund or cancel action on the test line. The refunded amount is recorded as a refund entry in the bill payments, with a refund number. Large refunds may need approval depending on the lab settings.',
  },
  {
    id: 'bill-edit',
    area: 'Billing',
    title: 'Edit or delete a bill',
    screen: 'Patient List',
    keywords: ['edit bill', 'delete bill', 'change', 'correct', 'mistake'],
    body: 'Bills are corrected from Patient List by opening the bill. Changes are kept in the audit trail. A bill that already has results approved is restricted, so ask a manager or lab admin if an action is greyed out.',
  },
  {
    id: 'reg-quotation',
    area: 'Registration',
    title: 'Quotations',
    screen: 'Quotations',
    keywords: ['quotation', 'estimate', 'quote', 'price list'],
    body: 'A quotation lists tests and prices for a patient or client without creating a bill. It can be converted to a bill when the patient decides to proceed.',
  },
  {
    id: 'reg-bulk',
    area: 'Registration',
    title: 'Bulk registration',
    screen: 'Bulk Registration',
    keywords: ['bulk', 'camp', 'many patients', 'import', 'csv', 'corporate camp'],
    body: 'Bulk registration lets you register many patients in one go, for example for a health camp or a corporate visit. Prepare the patient rows, review them on screen, then confirm to create the bills.',
  },
  {
    id: 'bookings-home',
    area: 'Bookings',
    title: 'Bookings and home collection',
    screen: 'Bookings',
    keywords: ['booking', 'home collection', 'appointment', 'schedule', 'phlebotomist', 'visit'],
    body: 'Bookings holds home-collection and visit requests. Create or confirm a booking, assign a phlebotomist and a time, and mark it collected. A booking can be turned into a bill so the patient details carry over.',
  },
  {
    id: 'patients-list',
    area: 'Patients',
    title: 'Find a patient or a bill',
    screen: 'Patient List',
    keywords: ['search', 'find patient', 'patient list', 'bill list', 'history', 'phone'],
    body: 'Patient List shows bills and patients. Search by name, phone, bill number or patient number and filter by date or status. Open a row to see results, payments, reports and history.',
  },
  {
    id: 'patients-merge',
    area: 'Patients',
    title: 'Merge duplicate patients',
    screen: 'Patient List',
    keywords: ['merge', 'duplicate', 'same patient', 'two records'],
    body: 'If one person has two patient records, a user with the merge permission can merge them from the patient details. The history of both is kept under the surviving record. Ask a lab admin if you do not see the option.',
  },

  // ---- Accession ----
  {
    id: 'acc-receive',
    area: 'Accession',
    title: 'Receive samples by barcode',
    screen: 'Accession',
    keywords: ['accession', 'barcode', 'scan', 'receive sample', 'sample', 'collected'],
    body: 'In Accession, scan or type the sample barcode to mark the sample as collected or received. The test then appears in the worklist for result entry. Received time is stored and is used for turnaround time.',
  },
  {
    id: 'acc-reject',
    area: 'Accession',
    title: 'Reject or recollect a sample',
    screen: 'Accession',
    keywords: ['reject', 'recollect', 'hemolysed', 'insufficient', 'wrong sample'],
    body: 'If a sample is unsuitable, reject it in Accession with a reason so it is tracked and the patient can be asked to give a fresh sample. The rejection is kept in the audit trail.',
  },
  {
    id: 'acc-manifest',
    area: 'Accession',
    title: 'Manifest for outside labs and centres',
    screen: 'Accession',
    keywords: ['manifest', 'dispatch samples', 'send samples', 'transfer', 'courier'],
    body: 'The manifest lists samples being sent to another lab or received from a collection centre. Create it, print it, and tick samples as received at the other end.',
  },

  // ---- Results ----
  {
    id: 'res-worklist',
    area: 'Results',
    title: 'Worklist: find tests to enter',
    screen: 'Enter & Verify > Pathology',
    keywords: ['worklist', 'pending results', 'enter results', 'pathology', 'queue'],
    body: 'Enter & Verify > Pathology lists tests waiting for results. Filter by department, status or date, and open a bill to enter values for its tests.',
  },
  {
    id: 'res-entry',
    area: 'Results',
    title: 'Enter results',
    screen: 'Enter & Verify > Pathology',
    keywords: ['result entry', 'enter values', 'parameter', 'flag', 'abnormal', 'critical', 'reference range'],
    body: 'Type values into each parameter. The reference range for the patient age and gender is shown and values outside it are flagged low or high; critical limits are marked. Calculated parameters fill in automatically. Save, then send for approval or approve if you are allowed.',
  },
  {
    id: 'res-approve',
    area: 'Results',
    title: 'Approve (verify) results',
    screen: 'Enter & Verify > Pathology',
    keywords: ['approve', 'verify', 'sign off', 'authorise', 'finalise', 'unapprove', 'amend'],
    body: 'A person with approval rights reviews the values and approves them, which makes the report final and ready to print or send. An approved result can be un-approved or amended by an authorised user; each change keeps the earlier value in the version history.',
  },
  {
    id: 'res-previous',
    area: 'Results',
    title: 'Previous results and delta check',
    screen: 'Enter & Verify > Pathology',
    keywords: ['previous', 'delta', 'history', 'trend', 'compare'],
    body: 'Result entry can show the same patient\'s earlier value for a parameter, and warns when the change from the previous result is large. To compare two reports side by side use the report compare view from the report.',
  },
  {
    id: 'res-hold-rerun',
    area: 'Results',
    title: 'Hold a result or ask for a re-run',
    screen: 'Enter & Verify > Pathology',
    keywords: ['hold', 're-run', 'rerun', 'repeat', 'send back'],
    body: 'If a value looks wrong, put the test on hold or mark it for re-run. The previous value stays in the version history. Once a new value is entered, it goes through approval again.',
  },
  {
    id: 'res-radiology',
    area: 'Results',
    title: 'Radiology reports',
    screen: 'Enter & Verify > Radiology',
    keywords: ['radiology', 'imaging', 'xray', 'ultrasound', 'impression', 'findings'],
    body: 'Radiology tests have their own worklist. Open a case, write the findings and impression using the report templates, then approve it. Dictation uses the browser speech feature where the browser supports it.',
  },
  {
    id: 'res-interpretation',
    area: 'Results',
    title: 'AI draft interpretation',
    screen: 'Enter & Verify > Pathology',
    keywords: ['interpretation', 'ai interpretation', 'draft', 'comment', 'summary'],
    body: 'When AI is enabled for the lab, a doctor or admin can ask for a draft interpretation of a test. It is a draft only, based on values, ranges and flags with no patient name or contact, and must be reviewed and accepted by a person.',
  },

  // ---- Reports and dispatch ----
  {
    id: 'rep-print',
    area: 'Reports',
    title: 'Print or download a report',
    screen: 'Patient List > Report',
    keywords: ['print', 'report', 'pdf', 'download', 'letterhead', 'preview'],
    body: 'Open the bill from Patient List and choose the report. You can preview, print, or save as PDF. Whether to use a letterhead and which template to use come from Lab Profile settings.',
  },
  {
    id: 'rep-smart',
    area: 'Reports',
    title: 'Smart Report',
    screen: 'Smart Report',
    keywords: ['smart report', 'trends', 'summary report', 'graph'],
    body: 'Smart Report builds a trend-style summary for a patient across their past results. It is available to users with the permission and helps explain changes over time.',
  },
  {
    id: 'disp-pending',
    area: 'Dispatch',
    title: 'Pending Dispatch: send reports',
    screen: 'Pending Dispatch',
    keywords: ['dispatch', 'send report', 'whatsapp', 'sms', 'email', 'deliver', 'pending dispatch'],
    body: 'Pending Dispatch lists approved reports that have not been sent yet. Choose a report and send it by WhatsApp, SMS or email, or print it for hand delivery. Due payment rules from the lab settings may hold a report until the bill is paid.',
  },
  {
    id: 'disp-portal',
    area: 'Dispatch',
    title: 'Report link and patient portal',
    screen: 'Pending Dispatch',
    keywords: ['link', 'portal', 'my reports', 'public report', 'otp', 'share'],
    body: 'Sent reports contain a secure link. Patients can also open My Reports, enter their details and a one-time code, and see their reports. The link can be revoked or expire according to the lab settings.',
  },

  // ---- Catalogue ----
  {
    id: 'cat-tests',
    area: 'Catalogue',
    title: 'Add or edit a test',
    screen: 'Tests > Test List',
    keywords: ['test', 'catalogue', 'add test', 'parameter', 'price', 'reference range', 'department', 'sample type'],
    body: 'Tests > Test List shows the catalogue. Open a test or add a new one to set its name, code, department, sample type, price, turnaround time and parameters with reference ranges. Changes apply to new bills and reports.',
  },
  {
    id: 'cat-packages',
    area: 'Catalogue',
    title: 'Packages',
    screen: 'Tests > Packages',
    keywords: ['package', 'profile', 'bundle', 'health checkup', 'package price'],
    body: 'A package bundles several tests under one name and price. Create it in Tests > Packages and pick its member tests. On a bill the members are performed individually while the package price is charged.',
  },
  {
    id: 'cat-import',
    area: 'Catalogue',
    title: 'Import the catalogue from a file',
    screen: 'Tests > Import Catalogue',
    keywords: ['import', 'upload', 'csv', 'excel', 'bulk tests', 'mass price'],
    body: 'Import Catalogue reads a spreadsheet of tests and shows a preview and any errors before anything is saved. Mass price changes are also available on the catalogue screens.',
  },
  {
    id: 'cat-outsource',
    area: 'Catalogue',
    title: 'Outsourced tests and processing labs',
    screen: 'Tests > Outsource, Lab Management > Processing Lab',
    keywords: ['outsource', 'referral lab', 'send out', 'processing lab', 'external'],
    body: 'Tests performed by another lab are tracked under Tests > Outsource. Processing labs are set up in Lab Management > Processing Lab with their rates. Samples are sent through the accession manifest.',
  },

  // ---- QC / NABL ----
  {
    id: 'qc-run',
    area: 'Quality Control',
    title: 'Run internal QC',
    screen: 'Quality Control > Run QC',
    keywords: ['qc', 'quality control', 'run qc', 'control', 'levey jennings', 'westgard', 'machine'],
    body: 'In Quality Control > Run QC choose the machine and control lot, enter the measured value, and save. The value is judged against the mean and standard deviation with Westgard-style rules and marked pass, warning or fail. The QC Dashboard shows results over time.',
  },
  {
    id: 'qc-setup',
    area: 'Quality Control',
    title: 'QC setup: machines, materials, limits',
    screen: 'Quality Control > QC Setup',
    keywords: ['qc setup', 'machine', 'material', 'lot', 'mean', 'sd', 'limits'],
    body: 'QC Setup holds machines, control materials and lots with their target mean and SD. Users need the QC setup permission to change it.',
  },
  {
    id: 'qc-eqas',
    area: 'Quality Control',
    title: 'EQAS and ILC',
    screen: 'Quality Control > EQAS, ILC',
    keywords: ['eqas', 'external quality', 'ilc', 'inter laboratory', 'proficiency', 'sdi'],
    body: 'EQAS records results from an external quality assessment programme and compares them with peers. ILC records comparisons between laboratories. Both can be reviewed during audits.',
  },
  {
    id: 'qc-validation',
    area: 'Quality Control',
    title: 'Equipment validation and sample discarding',
    screen: 'Quality Control > Equipment Validation, Sample Discarding',
    keywords: ['validation', 'calibration', 'equipment', 'discard', 'waste', 'dispose'],
    body: 'Equipment Validation records calibration and validation of instruments. Sample Discarding records when and how stored samples were disposed of, so the lab has proof of its retention policy.',
  },
  {
    id: 'nabl-audit',
    area: 'NABL',
    title: 'NABL Audit',
    screen: 'NABL Audit',
    keywords: ['nabl', 'audit', 'accreditation', 'logs', 'iso 15189', 'documents'],
    body: 'NABL Audit gathers audit logs and records the accreditation body may ask for, such as who changed what and when. Use it to review activity and prepare for an audit.',
  },

  // ---- Inventory ----
  {
    id: 'inv-stock',
    area: 'Inventory',
    title: 'Check current stock',
    screen: 'Inventory > Current Stock',
    keywords: ['inventory', 'stock', 'reagent', 'consumable', 'low stock', 'expiry'],
    body: 'Inventory > Current Stock shows the quantity of each item, low-stock warnings and expiry dates. The Inventory Dashboard summarises what needs attention.',
  },
  {
    id: 'inv-po',
    area: 'Inventory',
    title: 'Purchase orders and receiving stock',
    screen: 'Inventory > Purchase Order',
    keywords: ['purchase order', 'po', 'supplier', 'receive stock', 'grn', 'buy'],
    body: 'Create a purchase order for a supplier in Inventory > Purchase Order, then mark items received to add them to stock. Items and suppliers are managed in Items & Suppliers.',
  },
  {
    id: 'inv-map',
    area: 'Inventory',
    title: 'Stock mapping to tests',
    screen: 'Inventory > Stock Mapping',
    keywords: ['stock mapping', 'consumption', 'auto deduct', 'per test'],
    body: 'Stock Mapping links a test to the items it consumes, so stock reduces as tests are performed. Set the quantity used per test.',
  },

  // ---- Analysis / finance / TAT ----
  {
    id: 'ana-analysis',
    area: 'Analysis',
    title: 'Analysis reports',
    screen: 'Analysis',
    keywords: ['analysis', 'analytics', 'revenue report', 'reports', 'export', 'summary'],
    body: 'Analysis gives business reports such as revenue, referrers, tests and staff activity for a date range. Filter, then export where the screen offers it. Branch selection controls which branch the numbers cover.',
  },
  {
    id: 'fin-finance',
    area: 'Finance',
    title: 'Financial Analysis: collections, dues, refunds',
    screen: 'Financial Analysis',
    keywords: ['finance', 'collection', 'dues', 'refund', 'day end', 'cash', 'shift', 'statement'],
    body: 'Financial Analysis shows money received, outstanding dues, refunds and payment modes for a period. It also holds day-end and shift closing so cashiers can reconcile counted cash with recorded payments.',
  },
  {
    id: 'tat-analysis',
    area: 'Analysis',
    title: 'Turnaround time (TAT) analysis',
    screen: 'TAT Analysis',
    keywords: ['tat', 'turnaround', 'delay', 'late', 'within tat'],
    body: 'TAT Analysis compares how long reports took from sample receipt to report ready against each test\'s target time, so you can see which tests or departments run late.',
  },

  // ---- Partners ----
  {
    id: 'part-referrals',
    area: 'Partners',
    title: 'Referring doctors and commissions',
    screen: 'Lab Management > Referral List',
    keywords: ['referral', 'referrer', 'doctor', 'commission', 'incentive', 'referring'],
    body: 'Referral List holds referring doctors and hospitals. Set commission rules per referrer where the lab pays incentives. Bills record the referrer so reports can total business per referrer.',
  },
  {
    id: 'part-b2b',
    area: 'Partners',
    title: 'B2B clients, collection centres and corporate clients',
    screen: 'Lab Management > B2B, Collection Center, Corporate Client',
    keywords: ['b2b', 'collection centre', 'franchise', 'corporate', 'wallet', 'partner', 'credit', 'statement'],
    body: 'B2B centres, collection centres and corporate clients are partners with their own price lists, billing and statements. Some partners have a login to a restricted portal where they can see only their own patients and reports.',
  },
  {
    id: 'part-marketing',
    area: 'Partners',
    title: 'Marketing team',
    screen: 'Lab Management > Marketing Team',
    keywords: ['marketing', 'sales', 'field staff', 'target'],
    body: 'Marketing Team manages sales staff and their assigned referrers so you can follow business brought in by each person.',
  },

  // ---- Users, roles, settings ----
  {
    id: 'usr-users',
    area: 'Users and roles',
    title: 'Add a staff user',
    screen: 'Lab Management > Manage Users',
    keywords: ['user', 'staff', 'add user', 'password', 'deactivate', 'branch access'],
    body: 'Lab admins add staff in Manage Users with a name, email, role and the branches they may work in. A user can be deactivated without deleting their history.',
  },
  {
    id: 'usr-roles',
    area: 'Users and roles',
    title: 'Roles and permissions',
    screen: 'Lab Management > Roles & Permissions',
    keywords: ['role', 'permission', 'access', 'rights', 'cannot see', 'not allowed'],
    body: 'Roles & Permissions controls what each role can see and do. If a menu item or button is missing for you, your role probably lacks that permission; ask a lab admin.',
  },
  {
    id: 'usr-branches',
    area: 'Users and roles',
    title: 'Branches',
    screen: 'Lab Management > Branches',
    keywords: ['branch', 'location', 'multi branch', 'switch branch', 'all branches'],
    body: 'Each branch has its own bills, samples, results and stock, while the catalogue and patients are shared. Use the branch switcher at the top to change branch; admins may also view all branches in analytics.',
  },
  {
    id: 'set-profile',
    area: 'Settings',
    title: 'Lab Profile and settings',
    screen: 'Lab Profile',
    keywords: ['lab profile', 'settings', 'letterhead', 'logo', 'address', 'templates', 'bill prefix', 'message templates'],
    body: 'Lab Profile holds the lab name, address, logo, report and bill templates, numbering, messaging templates and feature switches. Only users with the lab profile permission can edit it.',
  },
  {
    id: 'set-credent',
    area: 'Settings',
    title: 'Credent (partner onboarding)',
    screen: 'Credent',
    keywords: ['credent', 'onboarding', 'home collection partner', 'documents', 'verification'],
    body: 'Credent is where partner onboarding and verification records are managed, for example documents collected from home-collection partners.',
  },

  // ---- AI ----
  {
    id: 'ai-analyst',
    area: 'AI',
    title: 'Ask the AI analyst',
    screen: 'Labby AI > Create',
    keywords: ['ai', 'analyst', 'ask question', 'labby', 'chat', 'data access'],
    body: 'Labby AI > Create answers questions about lab data with numbers drawn from your bills, collections, tests, TAT, QC and bookings. Answers stream in as they are written and each one has a How was this computed panel. Admins choose which datasets each role may use under Data access.',
  },
  {
    id: 'ai-dashboards',
    area: 'AI',
    title: 'AI Dashboards and AI Tables',
    screen: 'Labby AI > AI Dashboards, AI Tables',
    keywords: ['ai dashboard', 'ai table', 'share dashboard', 'pin', 'pivot', 'widget'],
    body: 'Ask the analyst to build a dashboard and it appears under AI Dashboards. Owners and admins can share it with roles, switch branch, edit it in chat and pivot tables. AI Tables lists grouped answers you can pin, extend with extra columns, refresh and export.',
  },
  {
    id: 'ai-mcp',
    area: 'AI',
    title: 'Connect an external AI app (MCP)',
    screen: 'Connect AI (MCP)',
    keywords: ['mcp', 'connect ai', 'claude', 'chatgpt', 'token', 'scopes', 'connector'],
    body: 'Connect AI lets a lab admin give an outside AI app read-only access. Choose scopes (analytics, finance, QC, catalogue, masked patients), tools, a row limit and optional IP addresses, then confirm with a one-time code. The link is shown once and can be revoked at any time.',
  },
  {
    id: 'ai-enable',
    area: 'AI',
    title: 'Turn AI on or off',
    screen: 'Lab Profile',
    keywords: ['enable ai', 'turn on ai', 'ai off', 'api key', 'ai not working', 'allowance'],
    body: 'AI features are off until a lab admin enables them in Lab Profile and the server has its AI key configured. Each lab has a monthly allowance and a per-minute limit for AI calls.',
  },
]

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'how', 'do', 'i', 'in', 'is', 'my', 'and', 'for', 'on', 'can', 'what', 'where', 'it', 'we', 'you', 'with', 'this', 'that', 'are', 'be', 'does', 'me'])

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))

// Keyword search used to pick topics for the model and as the answer when AI is unavailable.
export function searchTopics(query: string, limit = 5): HelpTopic[] {
  const q = tokens(query)
  if (!q.length) return []
  return HELP_TOPICS.map((t) => {
    const title = tokens(t.title)
    const kw = t.keywords.flatMap(tokens)
    const body = tokens(t.body)
    let score = 0
    for (const w of q) {
      if (title.includes(w)) score += 4
      if (kw.includes(w)) score += 3
      if (t.area.toLowerCase().includes(w)) score += 2
      if (body.includes(w)) score += 1
    }
    for (const k of t.keywords) if (query.toLowerCase().includes(k.toLowerCase())) score += 3
    return { t, score }
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t)
}
