# Design progress

Design system: see `DESIGN.md`. Profile: Productivity, Tier A glass with Tier B fallback, WCAG 2.2 AA.

## DONE

- DONE 2026-10-16: `src/pages/admin/SettingsPage.tsx` (Lab Settings + Lab Profile, `?tab=`) and `src/features/settings/*`.

Building blocks (DESIGN.md §10)
- Tokens: `src/design/tokens.css` (light, dark, high contrast, radii, spacing, type, motion, z-index), `src/design/palette.ts`, `src/theme.ts` (Ant Design theme from the same roles, dark/high-contrast aware)
- Motion: `src/design/motion.css` (CSS `linear()` springs, press, materialize, fade-through, cascade, shake), `src/design/motion.ts`
- Glass: `src/design/glass.css`, `src/design/Glass.tsx` (small / large / tinted, `CapsuleGroup`), identity fallback, `@supports` Tier A; Ant Design Modal, Drawer, Dropdown, Select dropdown, Popover, Message, Notification, Tooltip themed as glass
- `src/design/concentric.ts`, `src/design/readable.ts` (WCAG contrast helpers)
- `src/design/Segmented.tsx` + `SelectionPill.tsx` (one sliding pill, arrow keys, optional counts)
- `src/design/StatusChip.tsx`, `Card.tsx`, `PageHeader.tsx`, `Button.tsx`, `Skeletons.tsx`, `ScrollEdge.tsx`, `EmptyState.tsx`
- `src/design/DisplaySettings.tsx` (theme, reduce motion, reduce transparency, increase contrast; persisted; sets `data-*` on `<html>`), `DesignProvider.tsx`

App shell
- `src/layout/AppLayout.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `nav.ts`, `useAlerts.ts`, `releaseNotes.ts`, `shell.css`
- Ambient sky wash, floating glass sidebar and top bar, compact drawer, skip link, live region, shortcuts
- Placeholder `src/pages/placeholder/ComingSoon.tsx` and routes for modules without pages

- DONE (partners): `src/features/partners/*` Referral List, Marketing Team, Processing Labs, B2B Labs, Collection Centres, Corporate Clients, RateListEditor migrated (PageHeader, Card, Segmented, StatusChip, EmptyState, Skeletons, glass drawers/modals, tokens only)

- DONE (P12-P14 pass): `LoginPage`, `PublicReportPage` (tokens, plain white print), `UsersPage`, `RolesPage`, `BranchesPage` (SettingsPage is owned elsewhere), `AiAnalystPage` (+ AI Tables), `ConnectAiPage` (wizard), `components/ai/*`, QC (`QcPage`, `NablPage`, all sections: Segmented tabs, StatusChip, Panel, tokens), Inventory (`InventoryPage` and all components), shell search/scan/help/news/profile/notifications/support/install

## IN PROGRESS

- Verification of the shell against the live Firebase emulator (shell was checked in a mocked harness only)

## TODO: pages to migrate to the design system

One line per page: replace ad-hoc headers with `PageHeader`, wrap panels in `Card`, status tags with `StatusChip`, tabs/filters with `Segmented`, first-load spinners with `Skeletons`, remove hard-coded colours.

- DONE `src/pages/bookings/BookingsPage.tsx`: status tabs as `Segmented` with counts, StatusChip, PageHeader (booking drawer/wizard still antd Drawer/Modal)
- DONE `src/pages/registration/RegistrationPage.tsx`: forms in cards, one primary action, billing modal
- DONE `src/pages/patients/PatientListPage.tsx` and `PatientDetailsPage.tsx` (Segmented status tabs with counts, StatusChip, PageHeader, Card)
- DONE `src/pages/accession/AccessionPage.tsx`: `?scan=` handling, scan dialog, Segmented tabs with counts, status chips
- DONE `src/pages/results/WorklistPage.tsx`: status tabs as `Segmented`, live updates cross-fade only
- DONE `src/pages/results/ResultEntryPage.tsx`: dense form, flag chips, approval actions
- DONE `src/pages/report/ReportPage.tsx`: print layout only, keep plain white
- DONE `src/pages/analysis/AnalysisPage.tsx`: KPI cards, charts on tokens
- DONE `src/pages/analysis/FinancePage.tsx`: KPI cards, tables
- DONE: `src/pages/catalogue/TestListPage.tsx`, `TestEditorPage.tsx`, `PackagesPage.tsx`, `CatalogueImportPage.tsx` (PageHeader, Card, Segmented tabs, StatusChip, tokens in `catalogue.css`)
- `src/pages/ai/AiAnalystPage.tsx`, `ConnectAiPage.tsx`; `src/components/ai/*` (DONE: InterpretationDrawer)
- DONE (billing/*: BillingModal, BillReceipt, EditBillModal, ClearDue, Refund, PaymentHistory, PartnerFields) `src/components/billing/*`; TODO `bookings/*`, `messaging/*`, `results/*`: modals and drawers (large glass), chips
- DONE Quotations (`src/features/quotations`), Bulk Registration (`src/features/bulk`). DONE `src/features/radiology/*` (Radiology), `src/features/smart-report/*` (Smart Report), `src/components/results/*`. New pages replacing `ComingSoon`: TAT Analysis, Outsource (DONE), Referral List, Marketing Team, Processing Labs, B2B Labs, Collection Centres, Corporate Clients
- Audit: replace hard-coded colours/radii/durations in all pages with tokens; add `aria-label` to icon-only buttons; check 4.5:1 with `readable.ts`

## Log

- 2026-10-16: Added design tokens, motion, glass, selection pill, segmented control, chips, cards, skeletons, scroll edge, display settings, themed Ant Design. Built the new floating shell (sidebar with command search, top bar with search/scan/branch/alerts/help/what's new/settings/user menu), placeholder routes, accessibility paths (skip link, live region, focus rings, reduce motion/transparency, increase contrast). `tsc -b` and `vite build` pass.
- 2026-10-16: Analysis, Financial analysis and TAT analysis built on the design system (P8).
