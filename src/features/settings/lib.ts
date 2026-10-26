import dayjs from 'dayjs'
import { useMemo } from 'react'
import { useLabSettings } from '../../hooks/useCatalogue'
import type { FeatureKey, LabSettings } from '../../types'

// ---------------------------------------------------------------------------
// Helpers that make Lab Settings / Lab Profile values take effect elsewhere.
// Everything here is a pure function of LabSettings so any page (or a Cloud
// Function) can call it. Call sites that other owners must wire are listed in
// the hand-over notes of the parity-fix reply.
// ---------------------------------------------------------------------------

// ---- Per-lab module flags ---------------------------------------------------

export const FEATURE_LABELS: { key: FeatureKey; label: string; description: string }[] = [
  { key: 'bookings', label: 'Bookings & home collection', description: 'Bookings calendar and collector assignment.' },
  { key: 'accession', label: 'Accession', description: 'Sample collection / receipt screen.' },
  { key: 'quotations', label: 'Quotations', description: 'Quotations and estimates.' },
  { key: 'inventory', label: 'Inventory', description: 'Stock, purchase orders and consumption.' },
  { key: 'qc', label: 'Quality control', description: 'QC runs, EQAS, ILC, validation.' },
  { key: 'nabl', label: 'NABL audit', description: 'NABL registers and documentation.' },
  { key: 'outsource', label: 'Outsourcing', description: 'Outsourced tests and processing labs.' },
  { key: 'b2b', label: 'B2B centres', description: 'B2B wallets, ledger and invoices.' },
  { key: 'collectionCentres', label: 'Collection centres', description: 'Franchise / collection centre management.' },
  { key: 'corporate', label: 'Corporate clients', description: 'Corporate clients, employees, invoices.' },
  { key: 'marketing', label: 'Marketing team', description: 'PROs, targets and marketing commission.' },
  { key: 'radiology', label: 'Radiology', description: 'Radiology reporting worklist.' },
  { key: 'tat', label: 'TAT analysis', description: 'Turnaround time analysis.' },
  { key: 'ai', label: 'AI (Labby)', description: 'AI analyst and interpretation. Also governed by the AI setting.' },
  { key: 'machineReading', label: 'Machine reading', description: 'Analyser result integration.' },
]

// Modules default ON, except NABL and machine reading which are opt-in.
const DEFAULT_OFF: FeatureKey[] = ['nabl', 'machineReading']

export function featureEnabled(settings: Pick<LabSettings, 'features'> & Partial<LabSettings>, key: FeatureKey): boolean {
  const v = settings.features?.[key]
  if (typeof v === 'boolean') return v
  // Legacy toggles that predate `features`.
  if (key === 'nabl') return settings.nabl?.enabled === true
  if (key === 'accession') return settings.accession?.enabled !== false
  if (key === 'ai') return settings.aiEnabled !== false
  if (key === 'tat') return settings.tat?.enabled !== false
  if (key === 'machineReading') return settings.integration?.machineInterface === true
  return !DEFAULT_OFF.includes(key)
}

// A feature set explicitly to false in `features`, or switched off by its legacy toggle, hides the module.
export function useFeature(key: FeatureKey): boolean {
  const s = useLabSettings()
  return featureEnabled(s, key)
}

export function useFeatureFlags(): Record<FeatureKey, boolean> {
  const s = useLabSettings()
  return useMemo(() => Object.fromEntries(FEATURE_LABELS.map((f) => [f.key, featureEnabled(s, f.key)])) as Record<FeatureKey, boolean>, [s])
}

// ---- Dates / display --------------------------------------------------------

// Lab Profile > Lab details > date format (dayjs pattern, default DD/MM/YYYY).
export function labDateFormat(settings: { profile?: { dateFormat?: string } }): string {
  return settings.profile?.dateFormat?.trim() || 'DD/MM/YYYY'
}
export function formatLabDate(settings: { profile?: { dateFormat?: string } }, d: Date | number | string | null | undefined, withTime = false): string {
  if (d == null || d === '') return ''
  const x = dayjs(d)
  if (!x.isValid()) return ''
  return x.format(labDateFormat(settings) + (withTime ? ' HH:mm' : ''))
}

// Report / bill header lines built from Lab Profile > Lab details (city, website).
export function labContactLine(s: { phone?: string; email?: string; profile?: { website?: string } }): string {
  return [s.phone, s.email, s.profile?.website].filter(Boolean).join('  |  ')
}

// ---- Patient list / TAT / NABL / report-entry toggles -----------------------

export type TatPlace = 'accession' | 'enterVerify' | 'billing' | 'patientList'
export function showTatIn(settings: Pick<LabSettings, 'tat'>, place: TatPlace): boolean {
  const t = settings.tat
  if (!t || t.enabled === false) return false
  return place === 'accession' ? t.showInAccession !== false
    : place === 'enterVerify' ? t.showInEnterVerify !== false
      : place === 'billing' ? t.showInBilling === true
        : t.showInPatientList !== false
}

export function patientListDefaults(settings: Pick<LabSettings, 'patientList'>) {
  const p = settings.patientList
  return {
    range: p?.defaultRange ?? 'today',
    tab: p?.defaultTab ?? 'all',
    newestFirst: p?.newestFirst !== false,
    columns: p?.columns ?? [],
    voidReasonRequired: p?.voidReasonRequired !== false,
  }
}

// Which prompts the NABL settings turn on (re-run reason, urgent remark, critical remark).
export function nablPrompts(settings: Pick<LabSettings, 'nabl'>) {
  // Flabs: these three prompts are plain toggles (all on by default) and do not depend on the NABL module being on.
  const n = settings.nabl
  return { rerunReason: n?.rerunReasonModal !== false, urgentRemark: n?.urgentRemarkModal !== false, criticalRemark: n?.criticalRemarkModal !== false, eqasMatchDays: n?.eqasMatchDays ?? 7 }
}

export const showPreviousResults = (settings: Pick<LabSettings, 'reportEntry'>) => settings.reportEntry?.showPreviousResults !== false

// ---- Bill / UPI -------------------------------------------------------------

// upi://pay deep link for the QR printed on a bill; empty when the lab has no UPI id.
export function upiPayLink(settings: Pick<LabSettings, 'billDetails' | 'name'>, amountPaise: number, note: string): string {
  const id = settings.billDetails?.upiId?.trim()
  if (!id) return ''
  const q = new URLSearchParams({ pa: id, pn: settings.name || 'Lab', cu: 'INR', tn: note })
  if (amountPaise > 0) q.set('am', (amountPaise / 100).toFixed(2))
  return `upi://pay?${q.toString()}`
}

// GST split of an inclusive amount using Lab Profile > Bill details (gstEnabled, gstPercent).
export function billTax(settings: Pick<LabSettings, 'billDetails'>, amountPaise: number) {
  const b = settings.billDetails
  if (!b?.gstEnabled || !(b.gstPercent > 0)) return { taxable: amountPaise, tax: 0, percent: 0 }
  const taxable = Math.round((amountPaise * 100) / (100 + b.gstPercent))
  return { taxable, tax: amountPaise - taxable, percent: b.gstPercent }
}

// Worksheet print header / footer (Lab Profile > Document templates), with fallbacks.
export function worksheetText(settings: Pick<LabSettings, 'docTemplates'>, fallbackHeader = '', fallbackFooter = '') {
  return {
    header: settings.docTemplates?.worksheetHeader?.trim() || fallbackHeader,
    footer: settings.docTemplates?.worksheetFooter?.trim() || fallbackFooter,
  }
}

// ---- Partner pricing --------------------------------------------------------

// Lab Settings > strictPartnerPricing: billing should refuse an item missing from a partner's list.
export const strictPartnerPricing = (settings: Pick<LabSettings, 'strictPartnerPricing'>) => settings.strictPartnerPricing === true

// ---- Referral display -------------------------------------------------------

export const showCommissionOnBills = (settings: Pick<LabSettings, 'referrals'>) => settings.referrals?.showCommissionOnBills === true
export const govPanelSendsDueReport = (settings: Pick<LabSettings, 'referrals'>) => settings.referrals?.govPanelSendDueReport === true

// ---- Password policy --------------------------------------------------------

// User.allowPasswordChange === false stops a user changing their own password.
export const canChangeOwnPassword = (u: { allowPasswordChange?: boolean } | null | undefined) => u?.allowPasswordChange !== false

// ---- Round 3 helpers (catalogue / admin) --------------------------------------------------------------

// Per-branch report and bill overrides (USR-17): the lab settings with that branch's overrides laid over them.
// Call: report, bill and quotation renderers use effectiveSettings(settings, order.branchId) for header, footer, name, address.
export function effectiveSettings(settings: LabSettings, branchId?: string): LabSettings {
  const o = branchId ? settings.branchOverrides?.[branchId] : undefined
  if (!o) return settings
  const clean = <T extends object>(x: T | undefined): Partial<T> => Object.fromEntries(Object.entries(x ?? {}).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>
  return {
    ...settings,
    name: o.name?.trim() || settings.name,
    address: o.address?.trim() || settings.address,
    phone: o.phone?.trim() || settings.phone,
    profile: { ...settings.profile, ...clean(o.profile) },
    reportDetails: { ...settings.reportDetails, ...clean(o.reportDetails) },
    billDetails: { ...settings.billDetails, ...clean(o.billDetails) },
  }
}

// Staff may open the report of a bill that was dispatched but still has a balance due (SET-22).
export const allowDispatchedDueAccess = (settings: Pick<LabSettings, 'allowDispatchedDueAccess'>) => settings.allowDispatchedDueAccess === true

// B2B centres are billed at MRP: their rate lists are not applied (SET-14). Billing: skip the partner rate list when true.
export const b2bPriceListDisabled = (settings: Pick<LabSettings, 'b2bPriceListDisabled'>) => settings.b2bPriceListDisabled === true

// Barcode type (SET-13): one barcode per bill (default), per patient (every bill of the patient shares it) or per department.
export type BarcodeType = 'bill' | 'patient' | 'department'
export const barcodeType = (settings: Pick<LabSettings, 'barcode'>): BarcodeType => settings.barcode?.type ?? 'bill'
// The grouping key a barcode stands for: accession / label printing give every line with the same key one barcode.
export function barcodeGroupKey(settings: Pick<LabSettings, 'barcode'>, o: { orderId: string; patientId?: string; departmentId?: string }): string {
  const t = barcodeType(settings)
  return t === 'patient' ? `patient:${o.patientId ?? o.orderId}` : t === 'department' ? `${o.orderId}:dept:${o.departmentId ?? ''}` : o.orderId
}

// Formula rounding (PAR-12): decimals kept on calculated values unless the parameter sets its own. Default 2.
export const formulaDecimals = (settings: Pick<LabSettings, 'reportEntry'>): number => Math.max(0, Math.min(6, settings.reportEntry?.formulaDecimals ?? 2))

// Registration field rename + show/hide (SET-02). Registration reads these instead of its own literals.
export const registrationFieldLabel = (settings: Pick<LabSettings, 'frontDesk'>, key: string, fallback: string): string => settings.frontDesk?.fieldLabels?.[key]?.trim() || fallback
export const isRegistrationFieldHidden = (settings: Pick<LabSettings, 'frontDesk' | 'registration'>, key: string): boolean =>
  !!settings.frontDesk?.hiddenFields?.includes(key) && !settings.registration?.requiredFields?.includes(key)

// ABDM / ABHA (PRO-03).
export const abhaLinkingEnabled = (settings: Pick<LabSettings, 'abdm'>) => settings.abdm?.abhaLinking === true && !!settings.abdm?.hfrId?.trim()

// Plan / edition (SH-04).
export function planLabel(settings: Pick<LabSettings, 'subscription'>): { label: string; status: string; tone: 'success' | 'caution' | 'urgent' | 'neutral' } {
  const s = settings.subscription
  if (!s) return { label: 'Self-hosted', status: 'active', tone: 'neutral' }
  return { label: s.edition ? `${s.plan} ${s.edition}` : s.plan, status: s.status, tone: s.status === 'active' ? 'success' : s.status === 'trial' ? 'caution' : 'urgent' }
}
