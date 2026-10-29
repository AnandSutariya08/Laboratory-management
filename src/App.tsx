import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { App as AntApp, Result, Spin } from 'antd'
import { AuthProvider, can, useAuth, type Permission } from './auth/AuthProvider'
import { isPartnerRole } from './auth/permissions'
import { BranchProvider } from './branch/BranchProvider'
import AppLayout from './layout/AppLayout'
import LoginPage from './pages/LoginPage'
import { DesignProvider } from './design/DesignProvider'
import { useFeatureFlags } from './features/settings/lib'
import { SessionGuard } from './features/settings/sessions'
import type { FeatureKey } from './types'
import { canSeeDashboard } from './lib/dashboard'
import './design/index.css'

const AiAnalystPage = lazy(() => import('./pages/ai/AiAnalystPage'))
const ConnectAiPage = lazy(() => import('./pages/ai/ConnectAiPage'))
const QcPage = lazy(() => import('./features/qc/QcPage'))
const NablPage = lazy(() => import('./features/qc/NablPage'))
const InventoryPage = lazy(() => import('./features/inventory/InventoryPage'))
const BookingsPage = lazy(() => import('./pages/bookings/BookingsPage'))
const PublicReportPage = lazy(() => import('./pages/public/PublicReportPage'))
const PatientPortalPage = lazy(() => import('./pages/public/PatientPortalPage'))
const FormFSignPage = lazy(() => import('./features/pcpndt/FormFSignPage'))
const ExternalOpinionPage = lazy(() => import('./features/radiology/ExternalOpinionPage'))
const RegistrationPage = lazy(() => import('./pages/registration/RegistrationPage'))
const PatientListPage = lazy(() => import('./pages/patients/PatientListPage'))
const AccessionPage = lazy(() => import('./pages/accession/AccessionPage'))
const WorklistPage = lazy(() => import('./pages/results/WorklistPage'))
const ResultEntryPage = lazy(() => import('./pages/results/ResultEntryPage'))
const ReportPage = lazy(() => import('./pages/report/ReportPage'))
const ReportComparePage = lazy(() => import('./pages/report/ReportComparePage'))
const PendingDispatchPage = lazy(() => import('./pages/report/PendingDispatchPage'))
const AnalysisPage = lazy(() => import('./pages/analysis/AnalysisPage'))
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'))
const FinancePage = lazy(() => import('./pages/analysis/FinancePage'))
const AnalysisDrillPage = lazy(() => import('./pages/analysis/DrillPage'))
const TestListPage = lazy(() => import('./pages/catalogue/TestListPage'))
const TestEditorPage = lazy(() => import('./pages/catalogue/TestEditorPage'))
const PackagesPage = lazy(() => import('./pages/catalogue/PackagesPage'))
const CatalogueImportPage = lazy(() => import('./pages/catalogue/CatalogueImportPage'))
const UsersPage = lazy(() => import('./pages/admin/UsersPage'))
const RolesPage = lazy(() => import('./pages/admin/RolesPage'))
const BranchesPage = lazy(() => import('./pages/admin/BranchesPage'))
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage'))
// Placeholder for modules whose pages are not built yet (src/pages/placeholder).
const QuotationsPage = lazy(() => import('./features/quotations/QuotationsPage'))
const BulkRegistrationPage = lazy(() => import('./features/bulk/BulkRegistrationPage'))
const RadiologyPage = lazy(() => import('./features/radiology/RadiologyPage'))
const RadiologyReportPage = lazy(() => import('./features/radiology/RadiologyReportPage'))
const TatAnalysisPage = lazy(() => import('./features/tat/TatAnalysisPage'))
const OutsourcePage = lazy(() => import('./features/outsource/OutsourcePage'))
const SmartReportPage = lazy(() => import('./features/smart-report/SmartReportPage'))
const ReferralsPage = lazy(() => import('./features/partners/ReferralsPage'))
const MarketingTeamPage = lazy(() => import('./features/partners/MarketingTeamPage'))
const ProcessingLabsPage = lazy(() => import('./features/partners/ProcessingLabsPage'))
const B2BPage = lazy(() => import('./features/partners/B2BPage'))
const CollectionCentresPage = lazy(() => import('./features/partners/CollectionCentresPage'))
const CorporateClientsPage = lazy(() => import('./features/partners/CorporateClientsPage'))
const CredentPage = lazy(() => import('./pages/admin/CredentPage'))
const PortalApp = lazy(() => import('./features/portal/PortalApp'))
const PatientDetailsPage = lazy(() => import('./pages/patients/PatientDetailsPage'))

const Loading = () => (
  <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>
    <Spin size="large" />
  </div>
)

// Per-lab module flags (Lab settings > Lab features) also block the routes, not just the menu.
const ROUTE_FEATURE: [string, FeatureKey][] = [
  ['/inventory', 'inventory'], ['/outsource', 'outsource'], ['/processing-labs', 'outsource'], ['/b2b', 'b2b'],
  ['/collection-centres', 'collectionCentres'], ['/corporate', 'corporate'], ['/marketing', 'marketing'],
  ['/qc', 'qc'], ['/nabl', 'nabl'], ['/radiology', 'radiology'], ['/quotations', 'quotations'],
  ['/bookings', 'bookings'], ['/accession', 'accession'], ['/tat', 'tat'],
]

function Guard({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { profile } = useAuth()
  const flags = useFeatureFlags()
  const { pathname } = useLocation()
  const hit = ROUTE_FEATURE.find(([p]) => pathname === p || pathname.startsWith(p + '/'))
  if (hit && flags[hit[1]] === false) {
    return <Result status="404" title="Module not enabled" subTitle="This module is switched off for this lab (Lab settings > Lab features)." />
  }
  if (!can(profile, permission)) {
    return <Result status="403" title="No access" subTitle="Ask a lab admin to grant this module." />
  }
  return <>{children}</>
}

function Shell() {
  const { user, profile, loading } = useAuth()
  // Router location (not window.location) so in-app links to these public pages re-render the shell.
  const { pathname } = useLocation()
  if (/^\/(r|formf|my-reports|rad-opinion)(\/|$)/.test(pathname)) {
    return (
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/r/:token" element={<PublicReportPage />} />
          <Route path="/formf/:token" element={<FormFSignPage />} />
          <Route path="/my-reports" element={<PatientPortalPage />} />
          <Route path="/rad-opinion/:token" element={<ExternalOpinionPage />} />
        </Routes>
      </Suspense>
    )
  }
  if (loading) return <Loading />
  if (!user) return <LoginPage />
  if (!profile || !profile.active) {
    return (
      <Result
        status="warning"
        title="Account not set up"
        subTitle="Your login works, but no active staff profile exists for it. Ask the lab admin to add you."
      />
    )
  }

  // External partner roles (B2B, collection centre, corporate, referrer) get a reduced portal shell.
  if (isPartnerRole(profile.role)) {
    return (
      <Suspense fallback={<Loading />}>
        <PortalApp />
      </Suspense>
    )
  }

  const g = (permission: Permission, el: ReactNode) => <Guard permission={permission}>{el}</Guard>

  return (
    <Suspense fallback={<Loading />}>
      <SessionGuard />
      <Routes>
        {/* Printable report opens without the app chrome. */}
        <Route path="/report/:orderId" element={g('patients.view', <ReportPage />)} />
        <Route path="/report-compare/:orderId" element={g('patients.view', <ReportComparePage />)} />
        <Route element={<AppLayout />}>
          {/* Admins land on their dashboard; everyone else on New Registration. */}
          <Route path="/" element={<Navigate to={canSeeDashboard(profile) ? '/dashboard' : '/registration'} replace />} />
          <Route path="/dashboard" element={canSeeDashboard(profile) ? <DashboardPage /> : <Result status="403" title="No access" subTitle="The dashboard is for the lab admin." />} />
          <Route path="/ai" element={g('ai.use', <AiAnalystPage />)} />
          <Route path="/ai/:chatId" element={g('ai.use', <AiAnalystPage />)} />
          <Route path="/connect-ai" element={g('mcp.manage', <ConnectAiPage />)} />
          <Route path="/qc" element={g('qc.view', <QcPage />)} />
          <Route path="/qc/:section" element={g('qc.view', <QcPage />)} />
          <Route path="/nabl" element={g('nabl.view', <NablPage />)} />
          <Route path="/inventory" element={g('inventory.view', <InventoryPage />)} />
          <Route path="/inventory/:section" element={g('inventory.view', <InventoryPage />)} />
          <Route path="/bookings" element={g('bookings.view', <BookingsPage />)} />
          <Route path="/registration" element={g('registration.create', <RegistrationPage />)} />
          <Route path="/patients" element={g('patients.view', <PatientListPage />)} />
          <Route path="/dispatch" element={g('reports.send', <PendingDispatchPage />)} />
          <Route path="/accession" element={g('accession.view', <AccessionPage />)} />
          <Route path="/worklist" element={g('results.view', <WorklistPage />)} />
          <Route path="/results/:orderId" element={g('results.view', <ResultEntryPage />)} />
          <Route path="/analysis" element={g('analytics.view', <AnalysisPage />)} />
          <Route path="/analysis/:kind" element={g('analytics.view', <AnalysisDrillPage />)} />
          <Route path="/finance" element={g('finance.view', <FinancePage />)} />
          <Route path="/tests" element={g('catalogue.view', <TestListPage />)} />
          <Route path="/tests/:testId" element={g('catalogue.view', <TestEditorPage />)} />
          <Route path="/packages" element={g('catalogue.view', <PackagesPage />)} />
          <Route path="/catalogue-import" element={g('catalogue.import', <CatalogueImportPage />)} />
          <Route path="/users" element={g('users.manage', <UsersPage />)} />
          <Route path="/roles" element={g('roles.manage', <RolesPage />)} />
          <Route path="/branches" element={g('branches.manage', <BranchesPage />)} />
          <Route path="/credent" element={g('settings.manage', <CredentPage />)} />
          <Route path="/settings" element={g(can(profile, 'labprofile.edit') ? 'labprofile.edit' : 'settings.manage', <SettingsPage />)} />
          <Route path="/quotations" element={g('registration.create', <QuotationsPage />)} />
          <Route path="/bulk-registration" element={g('registration.create', <BulkRegistrationPage />)} />
          <Route path="/radiology" element={g('results.view', <RadiologyPage />)} />
          <Route path="/radiology/:orderId" element={g('results.view', <RadiologyReportPage />)} />
          <Route path="/tat" element={g('analytics.view', <TatAnalysisPage />)} />
          <Route path="/outsource" element={g('outsource.view', <OutsourcePage />)} />
          <Route path="/smart-report" element={g('settings.manage', <SmartReportPage />)} />
          <Route path="/referrals" element={g('referrals.view', <ReferralsPage />)} />
          <Route path="/marketing" element={g('marketing.manage', <MarketingTeamPage />)} />
          <Route path="/processing-labs" element={g('outsource.view', <ProcessingLabsPage />)} />
          <Route path="/b2b" element={g('b2b.view', <B2BPage />)} />
          <Route path="/collection-centres" element={g('centres.manage', <CollectionCentresPage />)} />
          <Route path="/corporate" element={g('corporate.manage', <CorporateClientsPage />)} />
          <Route path="/patients/:patientId" element={g('patients.view', <PatientDetailsPage />)} />
          {/* Staff who land on a partner-portal address (e.g. after switching accounts) go home. */}
          <Route path="/portal/*" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Result status="404" title="Page not found" />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <DesignProvider>
      <AntApp>
        <AuthProvider>
          <BranchProvider>
            <BrowserRouter>
              <Shell />
            </BrowserRouter>
          </BranchProvider>
        </AuthProvider>
      </AntApp>
    </DesignProvider>
  )
}
