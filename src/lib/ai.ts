import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../firebase'
import { branchParam } from './activeBranch'
import type { AiInterpretation, AnalyticsQuery, AnalyticsResult, DashboardWidget } from '../types'

// Contract between the web app and the AI Cloud Functions in /functions/src/ai.
// The Anthropic API key lives only on the server (Secret Manager: ANTHROPIC_API_KEY).

// Every call carries the caller's branch (a branch id, or 'all' in the All-branches
// view); the server checks it against the caller's profile.
const call = <I, O>(name: string) => async (input: I) =>
  (await httpsCallable<I & { labId: string; branchId: string }, O>(functions, name, { timeout: 300_000 })({
    ...input,
    labId: LAB_ID,
    branchId: branchParam(),
  })).data

// Analyst chat: one user message per call. Omit chatId to start a new chat.
// The server runs the tool loop over read-only analytics and may save a dashboard.
export const analystChat = call<
  { chatId?: string; message: string },
  { chatId: string; text: string; results: AnalyticsResult[]; dashboardId?: string }
>('analystChat')

// Run one analytics query directly (dashboards and inline charts use this).
export const runAnalytics = call<{ query: AnalyticsQuery }, AnalyticsResult>('runAnalytics')

// Refresh every widget of a saved dashboard in one round trip.
export const runDashboard = call<
  { dashboardId: string },
  { widgets: (DashboardWidget & { result: AnalyticsResult | null; error?: string })[] }
>('runDashboard')

// Draft an interpretation for one test on a bill. The server sends only age,
// gender and the test's values/ranges/flags to the model - never names or contacts.
// The draft is stored on the result doc as `aiInterpretation` (status 'draft').
export const interpretResult = call<{ orderId: string; testId: string; speed?: 'fast' | 'balanced' | 'thorough' }, AiInterpretation>(
  'interpretResult',
)

// MCP connections for Claude / other MCP clients (admins only). The token is
// returned once at creation; afterwards only its last 4 characters are kept visible.
// Two steps: create (with consent) issues a one-time code; confirm with the code activates it.
export const MCP_SCOPES = [
  { value: 'ANALYTICS_READ', label: 'Analytics (bills, patients, tests, TAT, bookings counts)' },
  { value: 'FINANCE_READ', label: 'Finance (revenue, collections, dues, refunds, discounts)' },
  { value: 'QC_READ', label: 'Quality control (aggregated QC runs)' },
  { value: 'CATALOGUE_READ', label: 'Catalogue (departments, tests, prices)' },
  { value: 'PATIENT_READ_MASKED', label: 'Patients, masked (initials, age, gender and last 4 digits of the phone only; never names, phone numbers or emails)' },
] as const
// Scopes switched on for a new connection. The masked-patient scope is opt-in.
export const DEFAULT_MCP_SCOPES: string[] = ['ANALYTICS_READ', 'FINANCE_READ', 'QC_READ', 'CATALOGUE_READ']
export const MCP_TOOLS = [
  { value: 'lab_info', label: 'lab_info: lab name and contact' },
  { value: 'get_kpis', label: 'get_kpis: headline figures' },
  { value: 'run_analytics', label: 'run_analytics: metric by group' },
  { value: 'list_departments', label: 'list_departments' },
  { value: 'list_tests', label: 'list_tests' },
  { value: 'get_qc_summary', label: 'get_qc_summary' },
  { value: 'get_bill', label: 'get_bill: one bill by number (needs Finance)' },
  { value: 'list_bills', label: 'list_bills: bills in a date range (needs Finance)' },
  { value: 'list_dues', label: 'list_dues: outstanding balances (needs Finance)' },
  { value: 'top_tests', label: 'top_tests: most billed tests' },
  { value: 'bill_payments', label: 'bill_payments: payments on one bill (needs Finance)' },
  { value: 'list_patients_masked', label: 'list_patients_masked: recent patients, masked (needs the masked-patient scope)' },
] as const
export interface McpGrants { scopes: string[]; tools: string[]; rowLimit: number; ipAllowlist: string[] }
export const createMcpConnection = call<
  { label: string; days: number; consent: boolean } & Partial<McpGrants>,
  { id: string; otpRequired: true; sentTo: string; expiresInMinutes: number; devOtp?: string }
>('createMcpConnection')
export const confirmMcpConnection = call<{ id: string; otp: string }, { id: string; url: string; token: string; expiresAt: string }>('confirmMcpConnection')

export const revokeMcpConnection = call<{ id: string }, { ok: true }>('revokeMcpConnection')

// Edit what an existing connection may do (scopes, tools, row cap, IP allowlist).
export const updateMcpConnection = call<{ id: string } & Partial<McpGrants>, { ok: true }>('updateMcpConnection')

// Review-first AI drafts built from pasted text (no PDF parsing): nothing is saved by these calls.
export interface EqasExtract {
  provider: string
  cycle: string
  results: { parameter: string; unit: string; labValue: number | null; peerMean: number | null; peerSd: number | null; providerSdi: number | null }[]
}
export const extractEqasReport = call<{ text: string }, EqasExtract>('extractEqasReport')
export interface TestDraft {
  name: string
  code: string
  departmentHint: string
  sampleHint: string
  parameters: { name: string; unit: string; low: number | null; high: number | null; displayRange: string; method: string }[]
}
export const draftTestFromText = call<{ text: string; mode: 'name' | 'text' }, TestDraft>('draftTestFromText')

// Draft a radiology impression from the saved findings text (modality + findings only; no patient identifiers).
// The caller shows it as an editable draft; nothing is saved by this call.
export const draftRadiologyImpression = call<{ orderId: string; testId: string }, { impression: string; draft: true }>('draftRadiologyImpression')
