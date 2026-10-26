import type { Role } from '../types'

// Permission keys, grouped by module. `can(profile, key)` checks these against
// profile.permissions (role permissions + per-user grants - per-user denies).
export interface PermissionDef {
  key: string
  label: string
  description: string
}
export interface PermissionGroup {
  module: string
  label: string
  permissions: PermissionDef[]
}

const p = (key: string, label: string, description: string): PermissionDef => ({ key, label, description })

export const PERMISSION_GROUPS = [
  {
    module: 'bookings',
    label: 'Bookings & home collection',
    permissions: [
      p('bookings.view', 'View bookings', 'Open the bookings list and calendar.'),
      p('bookings.create', 'Create / edit bookings', 'Create bookings and change their status.'),
      p('bookings.assign', 'Assign collectors', 'Assign a phlebotomist to a booking.'),
      p('bookings.manage', 'Manage bookings', 'Bulk status / owner / reschedule, reopen a closed booking and manage the collector master.'),
    ],
  },
  {
    module: 'registration',
    label: 'Registration',
    permissions: [
      p('registration.create', 'Register patients & bill', 'Register patients and create bills.'),
      p('quotation.manage', 'Manage quotations', 'Create, edit, send and convert quotations; set quotation print layout.'),
    ],
  },
  {
    module: 'billing',
    label: 'Billing',
    permissions: [
      p('payment.collect', 'Collect payments', 'Take money on a new bill, on a due balance and from payment history.'),
      p('billing.discount', 'Give discounts', 'Apply a bill discount (capped by the user\'s max discount %).'),
      p('billing.editPrice', 'Edit prices on a bill', 'Override a test price on a bill.'),
      p('billing.clearDue', 'Clear dues', 'Collect the outstanding balance on a bill.'),
      p('billing.refund', 'Refund', 'Refund paid lines.'),
      p('billing.edit', 'Edit saved bills', 'Add or remove items, re-price and change the referrer on a saved bill (kept in a revision trail).'),
      p('billing.void', 'Void bills', 'Void (cancel) a bill.'),
      p('billing.reverse', 'Reverse payments', 'Reverse a payment or due-clearance already posted on a bill.'),
      p('billing.backdate', 'Back-date bills and payments', 'Set a bill date or payment date before today.'),
    ],
  },
  {
    module: 'patients',
    label: 'Patients',
    permissions: [
      p('patients.view', 'View patients & bills', 'Open the patient / bill list and reports.'),
      p('patients.edit', 'Edit patients', 'Edit patient demographics.'),
      p('patients.export', 'Export patient data', 'Download patient / bill data as CSV.'),
      p('patients.merge', 'Merge patients', 'Merge duplicate patients and restore a merge.'),
    ],
  },
  {
    module: 'accession',
    label: 'Accession (samples)',
    permissions: [
      p('accession.view', 'View accession', 'Open the sample accession page.'),
      p('accession.collect', 'Collect samples', 'Mark samples as collected.'),
      p('accession.receive', 'Receive samples', 'Receive samples in the lab.'),
      p('accession.reject', 'Reject samples', 'Reject a sample with a reason.'),
    ],
  },
  {
    module: 'results',
    label: 'Results',
    permissions: [
      p('results.view', 'View worklist & results', 'Open the worklist and result entry.'),
      p('results.enter', 'Enter results', 'Enter and save result values.'),
      p('results.approve', 'Approve results', 'Approve (verify) results.'),
      p('results.unapprove', 'Un-approve results', 'Reopen an approved result.'),
      p('results.amend', 'Amend approved results', 'Amend a result after approval.'),
    ],
  },
  {
    module: 'reports',
    label: 'Reports',
    permissions: [
      p('reports.print', 'Print reports', 'Print / download patient reports.'),
      p('reports.send', 'Send reports', 'Send reports by WhatsApp, SMS or email.'),
      p('reports.sendDue', 'Send reports with dues', 'Send a report even while the bill has a balance due.'),
    ],
  },
  {
    module: 'catalogue',
    label: 'Catalogue',
    permissions: [
      p('catalogue.view', 'View catalogue', 'Open tests, packages and import.'),
      p('catalogue.edit', 'Edit catalogue', 'Create and edit tests, packages, departments.'),
      p('catalogue.price', 'Change prices', 'Change test and package prices.'),
      p('catalogue.delete', 'Delete catalogue items', 'Delete tests, packages, departments and sample types.'),
      p('catalogue.import', 'Import catalogue', 'Bulk-upload tests, packages and prices.'),
    ],
  },
  {
    module: 'partners',
    label: 'Partners, referrals & B2B',
    permissions: [
      p('referrals.view', 'View referrals', 'Open referring doctors, hospitals, TPAs and commission.'),
      p('referrals.manage', 'Manage referrals', 'Add and edit referrers, TPAs and government panels.'),
      p('marketing.manage', 'Marketing team', 'Manage PROs, targets and marketing commission.'),
      p('b2b.view', 'View B2B', 'Open B2B centres, ledger, wallet history and invoices.'),
      p('b2b.manage', 'Manage B2B', 'Edit B2B centres, add money, approve top-ups, credit/debit notes, invoices.'),
      p('centres.manage', 'Collection centres', 'Manage collection centres and settlements.'),
      p('corporate.manage', 'Corporate clients', 'Manage corporate clients, employees and invoices.'),
      p('ratelists.edit', 'Edit rate lists', 'Create and edit partner price lists.'),
      p('outsource.view', 'View outsourcing', 'Open outsourced tests and processing labs.'),
      p('outsource.edit', 'Manage outsourcing', 'Map tests to processing labs, set outsource prices.'),
      p('labmgmt.manage', 'Lab management', 'Manage lab feature flags and lab-wide masters.'),
    ],
  },
  {
    module: 'portal',
    label: 'Partner portal',
    permissions: [
      p('portal.clearDue', 'Portal: clear dues', 'A partner login can pay the balance on its bills online.'),
      p('portal.financials', 'Portal: financial analysis', 'A partner login can open its financial analysis (billing, collection, dues, commission).'),
      p('portal.dispatch', 'Portal: dispatch samples', 'A collection-centre login can pack samples into a dispatch manifest.'),
    ],
  },
  {
    module: 'qc',
    label: 'Quality control',
    permissions: [
      p('qc.view', 'View QC', 'Open the quality control module.'),
      p('qc.run', 'Run QC', 'Record QC runs, EQAS, ILC, discards.'),
      p('qc.setup', 'QC setup', 'Manage machines, materials, targets and studies.'),
      p('qc.approveCapa', 'Approve QC', 'Approve QC runs, ILC and validation studies; create, edit and close CAPAs.'),
      p('nabl.view', 'NABL documents', 'Open NABL documentation and registers.'),
    ],
  },
  {
    module: 'inventory',
    label: 'Inventory',
    permissions: [
      p('inventory.view', 'View inventory', 'Open stock, dashboards and purchase orders.'),
      p('inventory.manage', 'Manage items & POs', 'Manage items, suppliers, mappings and purchase orders.'),
      p('inventory.receive', 'Receive stock', 'Receive goods against purchase orders.'),
      p('inventory.adjust', 'Adjust stock', 'Adjust, consume and write off stock.'),
      p('inventory.items', 'Manage inventory items', 'Add and edit inventory items (units, tax, suppliers).'),
      p('inventory.suppliers', 'Manage suppliers', 'Add and edit suppliers.'),
      p('inventory.purchase', 'Purchase orders', 'Create, edit, order and cancel purchase orders.'),
      p('inventory.consume', 'Consume stock', 'Record manual consumption.'),
      p('inventory.mapping', 'Test-to-item mapping', 'Map tests to the inventory items they consume.'),
    ],
  },
  {
    module: 'analytics',
    label: 'Analytics & finance',
    permissions: [
      p('analytics.view', 'View analytics', 'Open the analysis dashboards.'),
      p('finance.view', 'View finance', 'Open the finance / collections report.'),
    ],
  },
  {
    module: 'ai',
    label: 'AI',
    permissions: [
      p('ai.use', 'Use AI analyst', 'Chat with the AI analyst and use dashboards.'),
      p('ai.interpret', 'AI result interpretation', 'Draft AI interpretations on results.'),
      p('mcp.manage', 'Manage AI connections', 'Create and revoke MCP connections.'),
    ],
  },
  {
    module: 'admin',
    label: 'Administration',
    permissions: [
      p('settings.manage', 'Lab settings', 'Edit lab settings (registration, report entry, referrals, features and so on).'),
      p('labprofile.edit', 'Lab profile', 'Edit the lab profile: details, report and bill layout, doctors, machines, templates.'),
      p('users.manage', 'Manage users', 'Add, edit, deactivate and delete staff; reset passwords; end sessions.'),
      p('roles.manage', 'Manage roles', 'Edit the permissions matrix.'),
      p('branches.manage', 'Manage branches', 'Create and edit branches.'),
      p('branches.allView', 'All-branches view', 'Switch to the combined "All branches" view for analytics.'),
    ],
  },
] as const satisfies readonly PermissionGroup[]

// Role documents saved before the partners/B2B keys existed carry no marker. For those,
// a new key is implied by the old key that used to guard the same screen, so existing
// roles keep their access until an admin saves the matrix (which stamps the marker).
export const PERMISSIONS_V2 = '__v2'
export const IMPLIED_BY: Record<string, string> = {
  'referrals.view': 'patients.view',
  'referrals.manage': 'settings.manage',
  'marketing.manage': 'users.manage',
  'b2b.view': 'finance.view',
  'b2b.manage': 'finance.view',
  'centres.manage': 'finance.view',
  'corporate.manage': 'finance.view',
  'ratelists.edit': 'catalogue.edit',
  'outsource.view': 'catalogue.view',
  'outsource.edit': 'catalogue.edit',
  'catalogue.delete': 'catalogue.edit',
  'catalogue.import': 'catalogue.edit',
  'labmgmt.manage': 'settings.manage',
  'labprofile.edit': 'settings.manage',
  'billing.reverse': 'billing.void',
  'billing.backdate': 'billing.edit',
  'quotation.manage': 'registration.create',
  'patients.merge': 'patients.edit',
  'payment.collect': 'registration.create',
  'bookings.manage': 'bookings.create',
  'inventory.items': 'inventory.manage',
  'inventory.suppliers': 'inventory.manage',
  'inventory.purchase': 'inventory.manage',
  'inventory.mapping': 'inventory.manage',
  'inventory.consume': 'inventory.adjust',
}
// Add the implied keys to an un-versioned permission list; versioned lists pass through.
export function withImplied(perms: readonly string[]): string[] {
  if (perms.includes(PERMISSIONS_V2)) return [...perms]
  const set = new Set(perms)
  for (const [k, old] of Object.entries(IMPLIED_BY)) if (set.has(old)) set.add(k)
  return [...set]
}

export type PermissionKey = (typeof PERMISSION_GROUPS)[number]['permissions'][number]['key']

export const ALL_PERMISSIONS: PermissionKey[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((x) => x.key))
export const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((g) => g.permissions.map((x) => [x.key, x.label])),
)

// Old coarse names kept working so existing call sites (and src/layout) still compile.
export const LEGACY_PERMISSION = {
  qc: 'qc.view',
  inventory: 'inventory.view',
  ai: 'ai.use',
  aiInterpret: 'ai.interpret',
  bookings: 'bookings.view',
  sendReports: 'reports.send',
  registration: 'registration.create',
  patients: 'patients.view',
  accession: 'accession.view',
  results: 'results.view',
  approve: 'results.approve',
  refund: 'billing.refund',
  catalogue: 'catalogue.view',
  analysis: 'analytics.view',
  settings: 'settings.manage',
  users: 'users.manage',
  roles: 'roles.manage',
  branches: 'branches.manage',
} as const satisfies Record<string, PermissionKey>

export type LegacyPermission = keyof typeof LEGACY_PERMISSION
export type Permission = PermissionKey | LegacyPermission

export const resolvePermission = (p: Permission): PermissionKey =>
  (LEGACY_PERMISSION as Record<string, PermissionKey>)[p] ?? (p as PermissionKey)

export const ROLE_LABEL: Record<Role, string> = {
  labAdmin: 'Lab admin (owner)',
  admin: 'Admin',
  manager: 'Manager',
  reception: 'Reception',
  technician: 'Technician',
  doctor: 'Doctor / pathologist',
  phlebotomist: 'Phlebotomist',
  b2b: 'B2B centre (portal)',
  collectionCentre: 'Collection centre (portal)',
  corporate: 'Corporate client (portal)',
  referrer: 'Referring doctor / hospital (portal)',
}
// Staff roles (editable in the permissions matrix) vs partner portal roles (scoped by partnerId).
export const STAFF_ROLES: Role[] = ['labAdmin', 'admin', 'manager', 'reception', 'technician', 'doctor', 'phlebotomist']
export const PARTNER_ROLES: Role[] = ['b2b', 'collectionCentre', 'corporate', 'referrer']
export const isPartnerRole = (r: Role | undefined | null): boolean => !!r && PARTNER_ROLES.includes(r)
export const ROLES: Role[] = STAFF_ROLES
// Which order field links a bill to the partner of each portal role (mirrors firestore.rules).
export const PARTNER_ORDER_FIELD: Record<string, string> = {
  b2b: 'b2bCentreId',
  collectionCentre: 'collectionCentreId',
  corporate: 'corporateClientId',
  referrer: 'referrerId',
}
// The master collection holding the partner document of each portal role.
export const PARTNER_COLLECTION: Record<string, string> = {
  b2b: 'b2bCentres',
  collectionCentre: 'collectionCentres',
  corporate: 'corporateClients',
  referrer: 'referrers',
}

const pick = (...keys: PermissionKey[]) => keys
const byModule = (...mods: string[]): PermissionKey[] =>
  PERMISSION_GROUPS.filter((g) => mods.includes(g.module)).flatMap((g) => g.permissions.map((x) => x.key as PermissionKey))

const everything: PermissionKey[] = [...ALL_PERMISSIONS]

// Matches the pre-matrix behaviour of the static ACCESS map.
const DEFAULTS_V1: Record<Role, PermissionKey[]> = {
  labAdmin: everything,
  admin: everything,
  manager: [
    ...byModule('bookings', 'registration', 'billing', 'accession', 'catalogue', 'inventory', 'analytics', 'qc', 'partners'),
    ...pick('patients.view', 'patients.edit', 'patients.export', 'patients.merge', 'results.view', 'results.enter', 'reports.print', 'reports.send', 'reports.sendDue', 'ai.use'),
  ],
  reception: pick(
    'bookings.view', 'bookings.create', 'bookings.assign', 'bookings.manage',
    'registration.create', 'quotation.manage', 'billing.discount', 'billing.clearDue', 'payment.collect',
    'patients.view', 'patients.edit',
    'accession.view', 'accession.collect', 'accession.receive', 'accession.reject',
    'reports.print', 'reports.send',
    'referrals.view',
  ),
  technician: pick(
    'patients.view',
    'accession.view', 'accession.collect', 'accession.receive', 'accession.reject',
    'results.view', 'results.enter',
    'reports.print',
    'qc.view', 'qc.run', 'nabl.view',
    'inventory.view', 'inventory.manage', 'inventory.receive', 'inventory.adjust', 'inventory.items', 'inventory.suppliers', 'inventory.purchase', 'inventory.consume', 'inventory.mapping',
    'outsource.view',
  ),
  doctor: pick(
    'patients.view',
    'results.view', 'results.enter', 'results.approve', 'results.unapprove', 'results.amend',
    'reports.print', 'reports.send',
    'qc.view', 'qc.run', 'qc.setup', 'qc.approveCapa', 'nabl.view',
    'ai.interpret',
  ),
  phlebotomist: pick('bookings.view', 'bookings.create', 'bookings.assign', 'accession.collect'),
  // Portal roles: reduced shell, only their own partner's documents (enforced by firestore.rules).
  b2b: pick('patients.view', 'reports.print', 'registration.create', 'portal.clearDue', 'portal.financials'),
  collectionCentre: pick('patients.view', 'reports.print', 'registration.create', 'portal.clearDue', 'portal.financials', 'portal.dispatch'),
  corporate: pick('patients.view', 'reports.print', 'registration.create', 'portal.clearDue', 'portal.financials'),
  referrer: pick('patients.view', 'reports.print', 'portal.financials'),
}
// Every built-in default carries the version marker.
export const DEFAULT_ROLE_PERMISSIONS = Object.fromEntries(
  Object.entries(DEFAULTS_V1).map(([r, v]) => [r, [...v, PERMISSIONS_V2]]),
) as unknown as Record<Role, PermissionKey[]>
// Effective permission list: role permissions + grants - denies. labAdmin has everything.
export function effectivePermissions(
  role: Role,
  rolePerms: readonly string[] | undefined,
  grants: readonly string[] = [],
  denies: readonly string[] = [],
): string[] {
  if (role === 'labAdmin') return [...ALL_PERMISSIONS]
  const set = new Set<string>(withImplied(rolePerms ?? DEFAULT_ROLE_PERMISSIONS[role] ?? []))
  set.delete(PERMISSIONS_V2)
  grants.forEach((k) => set.add(k))
  denies.forEach((k) => set.delete(k))
  return [...set]
}
