import { DEFAULT_SETTINGS } from '../../hooks/useCatalogue'
import type { ReportDetailsSettings, ReportStatus } from '../../types'
import { mergeLayout } from './layout'
import type { ReportModel, RResult, RSig, RTest } from './model'

// The frozen report written by the server at issue time (functions/src/snapshot.ts ReportPayload), also what the
// public report page receives. Issued reports render from this, never from the live catalogue.
export interface ReportPayload {
  mode: 'report'
  lab: ReportModel['lab']
  settings: { reportDetails: Partial<ReportDetailsSettings>; layout?: Record<string, unknown>; idDisplay: string; signatories: RSig[]; defaultSignatoryId: string; templateLayouts?: Record<string, Record<string, unknown>> }
  order: Record<string, unknown> & { ageValue: number; ageUnit: 'year' | 'month' | 'day'; reportRevision: number }
  results: RResult[]
  tests: RTest[]
  departments: { id: string; name: string; order: number }[]
  reportFile?: { name: string; dataUrl: string } | null
  verification?: { revision: number; sha256: string; at: string | null } | null
  smart?: { revision: number; stale: boolean; variant: string; notes: { label: string; text: string }[] } | null
}

const toDate = (v: unknown) => (typeof v === 'string' && v ? new Date(v) : null)

export function payloadToModel(p: ReportPayload, qrUrl: string): ReportModel {
  const rd: ReportDetailsSettings = { ...DEFAULT_SETTINGS.reportDetails, ...(p.settings.reportDetails ?? {}) }
  const o = p.order
  return {
    lab: p.lab,
    rd,
    layout: mergeLayout(p.settings.layout as never),
    templateLayouts: p.settings.templateLayouts as never,
    idDisplay: p.settings.idDisplay,
    order: {
      billNo: String(o.billNo ?? ''), patientName: String(o.patientName ?? ''), patientNo: String(o.patientNo ?? ''), uhid: String(o.uhid ?? ''),
      phone: String(o.phone ?? ''), address: String(o.address ?? ''), gender: String(o.gender ?? ''), ageValue: o.ageValue, ageUnit: o.ageUnit,
      referrerName: String(o.referrerName ?? ''), barcode: String(o.barcode ?? ''),
      createdAt: toDate(o.createdAt), collectedAt: toDate(o.collectedAt), receivedAt: toDate(o.receivedAt), billDate: toDate(o.billDate),
      ageDays: typeof o.ageDays === 'number' ? o.ageDays : undefined, condition: o.condition ? String(o.condition) : undefined,
      reportedAt: toDate(o.reportDateOverride) ?? toDate(o.firstApprovedAt) ?? toDate(o.reportedAt),
      reportStatus: o.reportStatus as ReportStatus, reportSignatoryId: String(o.reportSignatoryId ?? ''), reportNote: String(o.reportNote ?? ''),
      reportRevision: o.reportRevision ?? 0, amendSummary: String(o.amendSummary ?? ''),
      disableLetterhead: o.disableLetterhead === true, fields: (o.fields as Record<string, string> | undefined) ?? {}, pending: (o.pending as string[] | undefined) ?? [], packages: (o.packages as string[] | undefined) ?? [],
    },
    signatories: p.settings.signatories,
    defaultSignatoryId: p.settings.defaultSignatoryId,
    depts: p.departments,
    tests: p.tests,
    results: p.results,
    qrUrl,
    reportFile: p.reportFile ?? null,
  }
}
