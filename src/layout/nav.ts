import type { ComponentType } from 'react'
import { canSeeDashboard } from '../lib/dashboard'
import {
  ApiOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  BarcodeOutlined,
  CalendarOutlined,
  CarOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  FileDoneOutlined,
  FileSearchOutlined,
  InboxOutlined,
  ProfileOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
  SettingOutlined,
  TeamOutlined,
  UserAddOutlined,
} from '@ant-design/icons'
import { can, type Permission } from '../auth/AuthProvider'
import type { UserProfile } from '../types'

/** Per-lab module flags that hide menu entries (undefined = on). */
export type NavFeature = 'nabl' | 'accession' | 'ai' | 'tat' | 'inventory' | 'outsource' | 'corporate' | 'b2b' | 'collectionCentres' | 'marketing' | 'qc' | 'radiology' | 'quotations' | 'bookings'
export type NavFlags = Partial<Record<NavFeature, boolean>>

export type IconType = ComponentType<{ className?: string }>

// Single place that maps navigation to permission keys. The roles work may
// rename keys: change them here only (every entry reads from PERM).
export const PERM = {
  bookings: 'bookings.view',
  registration: 'registration.create',
  ai: 'ai.use',
  accession: 'accession.view',
  patients: 'patients.view',
  results: 'results.view',
  analysis: 'analytics.view',
  finance: 'finance.view',
  catalogue: 'catalogue.view',
  smartReport: 'results.view',
  qc: 'qc.view',
  nabl: 'nabl.view',
  admin: 'settings.manage',
  users: 'users.manage',
  roles: 'roles.manage',
  branches: 'branches.manage',
  referrals: 'referrals.view',
  inventory: 'inventory.view',
  connectAi: 'mcp.manage',
  labProfile: 'labprofile.edit',
} as const satisfies Record<string, Permission>

export interface NavLeaf {
  key: string
  label: string
  path: string // may include a query, e.g. /ai?tab=dashboards
  permission: Permission
  also?: string[] // other path prefixes that highlight this entry (e.g. /results/:id)
  keywords?: string
  feature?: NavFeature // hidden when this lab module flag is off
}

export interface NavNode {
  key: string
  label: string
  icon: IconType
  permission: Permission
  path?: string // leaf nodes only
  also?: string[]
  keywords?: string
  feature?: NavFeature
  children?: NavLeaf[]
  adminOnly?: boolean // only the lab admin and admin roles (the dashboard)
}

const leaf = (key: string, label: string, path: string, permission: Permission, extra: Partial<NavLeaf> = {}): NavLeaf => ({
  key, label, path, permission, ...extra,
})

export const NAV: NavNode[] = [
  { key: 'dashboard', label: 'Dashboard', icon: DashboardOutlined, permission: PERM.analysis, path: '/dashboard', adminOnly: true, keywords: 'overview insights summary kpi branches' },
  { key: 'bookings', label: 'Bookings', icon: CalendarOutlined, permission: PERM.bookings, feature: 'bookings', path: '/bookings', keywords: 'home collection appointments' },
  { key: 'registration', label: 'New Registration', icon: UserAddOutlined, permission: PERM.registration, path: '/registration', keywords: 'bill patient register' },
  {
    key: 'ai', label: 'Labby AI', icon: RobotOutlined, permission: PERM.ai, feature: 'ai', keywords: 'claude assistant',
    children: [
      leaf('ai-chat', 'Create', '/ai', PERM.ai, { keywords: 'analyst chat ask questions' }),
      leaf('ai-dash', 'AI Dashboards', '/ai?tab=dashboards', PERM.ai, { keywords: 'charts widgets' }),
      leaf('ai-tables', 'AI Tables', '/ai?tab=tables', PERM.ai, { keywords: 'saved tables export' }),
    ],
  },
  { key: 'accession', label: 'Accession', icon: BarcodeOutlined, permission: PERM.accession, feature: 'accession', path: '/accession', keywords: 'sample barcode receive scan' },
  { key: 'credent', label: 'Credent', icon: CarOutlined, permission: PERM.admin, path: '/credent', keywords: 'home collection partner onboarding' },
  { key: 'analysis', label: 'Analysis', icon: BarChartOutlined, permission: PERM.analysis, path: '/analysis', keywords: 'analytics reports revenue' },
  { key: 'patients', label: 'Patient List', icon: TeamOutlined, permission: PERM.patients, path: '/patients', keywords: 'bills search reports' },
  { key: 'dispatch', label: 'Pending Dispatch', icon: SendOutlined, permission: 'reports.send', path: '/dispatch', keywords: 'send reports whatsapp sms email delivery' },
  {
    key: 'enter', label: 'Enter & Verify', icon: FileDoneOutlined, permission: PERM.results, keywords: 'results approve',
    children: [
      leaf('worklist', 'Pathology', '/worklist', PERM.results, { also: ['/results'], keywords: 'worklist results enter verify' }),
      leaf('radiology', 'Radiology', '/radiology', PERM.results, { feature: 'radiology', keywords: 'imaging scan xray' }),
    ],
  },
  { key: 'finance', label: 'Financial Analysis', icon: AuditOutlined, permission: PERM.finance, path: '/finance', keywords: 'money due refunds collection' },
  { key: 'tat', label: 'TAT Analysis', icon: ClockCircleOutlined, permission: PERM.analysis, feature: 'tat', path: '/tat', keywords: 'turnaround time' },
  {
    key: 'tests', label: 'Tests', icon: ExperimentOutlined, permission: PERM.catalogue, keywords: 'catalogue',
    children: [
      leaf('test-list', 'Test List', '/tests', PERM.catalogue),
      leaf('packages', 'Packages', '/packages', PERM.catalogue, { keywords: 'profiles' }),
      leaf('outsource', 'Outsource', '/outsource', 'outsource.view', { feature: 'outsource', keywords: 'referral lab send out' }),
      leaf('cat-import', 'Import Catalogue', '/catalogue-import', PERM.catalogue, { keywords: 'upload csv' }),
    ],
  },
  { key: 'smart', label: 'Smart Report', icon: ProfileOutlined, permission: PERM.smartReport, path: '/smart-report', keywords: 'trends interpretation' },
  {
    key: 'qc', label: 'Quality Control', icon: SafetyCertificateOutlined, permission: PERM.qc, feature: 'qc', keywords: 'westgard levey jennings',
    children: [
      leaf('qc-dash', 'QC Dashboard', '/qc', PERM.qc),
      leaf('qc-run', 'Run QC', '/qc/run', PERM.qc),
      leaf('qc-setup', 'QC Setup', '/qc/setup', 'qc.setup'),
      leaf('qc-eqas', 'EQAS', '/qc/eqas', PERM.qc, { keywords: 'external quality' }),
      leaf('qc-discard', 'Sample Discarding', '/qc/discard', PERM.qc, { keywords: 'dispose waste' }),
      leaf('qc-val', 'Equipment Validation', '/qc/validation', 'qc.setup', { keywords: 'calibration instrument' }),
      leaf('qc-ilc', 'ILC', '/qc/ilc', PERM.qc, { keywords: 'inter laboratory comparison' }),
    ],
  },
  { key: 'nabl', label: 'NABL Audit', icon: FileSearchOutlined, permission: PERM.nabl, feature: 'nabl', path: '/nabl', keywords: 'accreditation audit logs' },
  {
    key: 'lab', label: 'Lab Management', icon: AppstoreOutlined, permission: PERM.admin, keywords: 'admin staff',
    children: [
      leaf('referrals', 'Referral List', '/referrals', PERM.referrals, { keywords: 'doctors referrers' }),
      leaf('users', 'Manage Users', '/users', PERM.users, { keywords: 'staff accounts' }),
      leaf('marketing', 'Marketing Team', '/marketing', 'marketing.manage', { feature: 'marketing', keywords: 'sales' }),
      leaf('proc-labs', 'Processing Lab', '/processing-labs', 'outsource.view', { feature: 'outsource' }),
      leaf('b2b', 'B2B', '/b2b', 'b2b.view', { feature: 'b2b', keywords: 'partner' }),
      leaf('collection', 'Collection Center', '/collection-centres', 'centres.manage', { feature: 'collectionCentres', keywords: 'franchise' }),
      leaf('corporate', 'Corporate Client', '/corporate', 'corporate.manage', { feature: 'corporate', keywords: 'company' }),
      leaf('roles', 'Roles & Permissions', '/roles', PERM.roles, { keywords: 'access rights' }),
      leaf('branches', 'Branches', '/branches', PERM.branches, { keywords: 'locations centres' }),
    ],
  },
  {
    key: 'inventory', label: 'Inventory', icon: InboxOutlined, permission: PERM.inventory, feature: 'inventory', keywords: 'stock reagents',
    children: [
      leaf('inv-dash', 'Dashboard', '/inventory', PERM.inventory),
      leaf('inv-stock', 'Current Stock', '/inventory/stock', PERM.inventory),
      leaf('inv-po', 'Purchase Order', '/inventory/purchase-orders', PERM.inventory, { keywords: 'po buy' }),
      leaf('inv-items', 'Items & Suppliers', '/inventory/items', PERM.inventory, { keywords: 'vendors' }),
      leaf('inv-map', 'Stock Mapping', '/inventory/mapping', PERM.inventory, { keywords: 'consumption test' }),
    ],
  },
  { key: 'connect', label: 'Connect AI (MCP)', icon: ApiOutlined, permission: PERM.connectAi, path: '/connect-ai', keywords: 'mcp integration' },
  { key: 'profile', label: 'Lab Profile', icon: SettingOutlined, permission: PERM.labProfile, path: '/settings', keywords: 'settings lab name address templates' },
]

export interface VisibleNode extends Omit<NavNode, 'children'> {
  children?: NavLeaf[]
}

/** Nav tree the user may see: items without access are removed; empty groups vanish. */
export function visibleNav(profile: UserProfile | null, flags: NavFlags = {}): VisibleNode[] {
  return NAV.flatMap((n) => {
    if (n.feature && flags[n.feature] === false) return []
    if (n.adminOnly && !canSeeDashboard(profile)) return []
    if (!n.children) return can(profile, n.permission) ? [n] : []
    const kids = n.children.filter((c) => can(profile, c.permission) && !(c.feature && flags[c.feature] === false))
    return kids.length ? [{ ...n, children: kids }] : []
  })
}

export interface FlatEntry {
  key: string
  label: string
  path: string
  group?: string
  keywords: string
  icon: IconType
}

export function flatten(nodes: VisibleNode[]): FlatEntry[] {
  return nodes.flatMap((n) =>
    n.children
      ? n.children.map((c) => ({ key: c.key, label: c.label, path: c.path, group: n.label, keywords: `${n.label} ${n.keywords ?? ''} ${c.keywords ?? ''}`, icon: n.icon }))
      : [{ key: n.key, label: n.label, path: n.path!, keywords: n.keywords ?? '', icon: n.icon }],
  )
}

const split = (p: string) => {
  const [path, qs = ''] = p.split('?')
  return { path, qs: new URLSearchParams(qs) }
}

/** Key of the nav leaf that matches the location: longest path prefix, query-specific entries first. */
export function activeKey(nodes: VisibleNode[], pathname: string, search: string): string | null {
  const q = new URLSearchParams(search)
  let best: { key: string; score: number } | null = null
  const consider = (key: string, path: string, also: string[] = []) => {
    const { path: base, qs } = split(path)
    for (const candidate of [base, ...also]) {
      const hit = pathname === candidate || pathname.startsWith(candidate + '/')
      if (!hit) continue
      let score = candidate.length * 10
      if (candidate === base && [...qs.keys()].length) {
        const ok = [...qs.entries()].every(([k, v]) => q.get(k) === v)
        if (!ok) continue
        score += 5
      }
      if (!best || score > best.score) best = { key, score }
    }
  }
  for (const n of nodes) {
    if (n.children) n.children.forEach((c) => consider(c.key, c.path, c.also))
    else if (n.path) consider(n.key, n.path, n.also)
  }
  return (best as { key: string } | null)?.key ?? null
}

const EXTRA_TITLES: [string, string][] = [
  ['/results/', 'Enter results'],
  ['/ai/', 'Labby AI'],
  ['/tests/', 'Test editor'],
  ['/quotations', 'Quotations'],
  ['/bulk-registration', 'Bulk Registration'],
]

/** Page title shown beside the top bar (plain text). */
export function titleFor(pathname: string, search: string, nodes: VisibleNode[] = NAV as VisibleNode[]): string {
  const key = activeKey(nodes, pathname, search)
  const exact = EXTRA_TITLES.find(([p]) => pathname.startsWith(p))
  if (exact) return exact[1]
  if (key) {
    const e = flatten(nodes).find((f) => f.key === key)
    if (e) return e.label
  }
  return 'Health Care Labs'
}

/** Group key containing the active leaf (so it starts expanded). */
export function groupOf(nodes: VisibleNode[], key: string | null): string | null {
  if (!key) return null
  return nodes.find((n) => n.children?.some((c) => c.key === key))?.key ?? null
}

