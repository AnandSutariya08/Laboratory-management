import { useMemo } from 'react'
import { useLabSettings } from '../../hooks/useCatalogue'
import type { AgeUnit, ReportColumnKey, ReportLayoutSettings } from '../../types'

export const DEFAULT_LAYOUT: ReportLayoutSettings & { waDocTemplate: string } = {
  fontFamily: 'sans',
  fontSize: 12,
  headingSize: 14,
  columnOrder: ['test', 'result', 'flag', 'reference', 'unit', 'method'],
  columnWidths: {},
  columnLabels: {},
  logoHeight: 56,
  logoAlign: 'left',
  ageFormat: 'long',
  headerFields: [],
  headerColumns: 2,
  showMadeWith: false,
  showTestMethod: false,
  showMic: false,
  showMachineName: false,
  showDeptName: true,
  showPackageName: false,
  showB2bCode: false,
  showLabPhone: true,
  listPendingTests: false,
  boldOnly: false,
  reportDateOnly: false,
  trendGraph: false,
  trendSize: 'medium',
  allergyRows: false,
  imageHeight: 220,
  letterheads: [],
  defaultLetterheadId: '',
  signatoryMode: 'fixed',
  maxSignatures: 3,
  showStamp: true,
  publicOtp: 'optional',
  publicBillPin: true,
  hardCopyPrompt: true,
  waDocTemplate: '',
}
export type FullLayout = typeof DEFAULT_LAYOUT

export function mergeLayout(raw: Partial<ReportLayoutSettings> | undefined | null): FullLayout {
  return { ...DEFAULT_LAYOUT, ...(raw ?? {}) } as FullLayout
}

export function useReportLayout(): FullLayout {
  const s = useLabSettings()
  return useMemo(() => mergeLayout(s.reportLayout), [s.reportLayout])
}

export const FONT_STACK: Record<ReportLayoutSettings['fontFamily'], string> = {
  sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Courier New", Courier, monospace',
}

export const COLUMN_LABEL: Record<ReportColumnKey, string> = { test: 'Test', result: 'Result', flag: 'Flag', reference: 'Reference', unit: 'Unit', method: 'Method' }
export const COLUMN_DEFAULT_WIDTH: Record<ReportColumnKey, number> = { test: 32, result: 16, flag: 8, reference: 22, unit: 12, method: 14 }

// Every field the patient block can show (45), in the order they are offered in settings.
export const HEADER_FIELDS: { key: string; label: string; group: string }[] = [
  { key: 'name', label: 'Patient name', group: 'Patient' }, { key: 'ageGender', label: 'Age and gender', group: 'Patient' }, { key: 'age', label: 'Age', group: 'Patient' },
  { key: 'gender', label: 'Gender', group: 'Patient' }, { key: 'dob', label: 'Date of birth', group: 'Patient' }, { key: 'patientId', label: 'Patient ID', group: 'Patient' },
  { key: 'uhid', label: 'UHID', group: 'Patient' }, { key: 'phone', label: 'Phone', group: 'Patient' }, { key: 'altPhone', label: 'Alternate phone', group: 'Patient' },
  { key: 'email', label: 'Email', group: 'Patient' }, { key: 'address', label: 'Address', group: 'Patient' }, { key: 'abhaNo', label: 'ABHA number', group: 'Patient' },
  { key: 'idNumber', label: 'ID number', group: 'Patient' }, { key: 'insuranceNo', label: 'Insurance number', group: 'Patient' }, { key: 'weight', label: 'Weight', group: 'Patient' },
  { key: 'height', label: 'Height', group: 'Patient' }, { key: 'category', label: 'Category', group: 'Patient' }, { key: 'clinicalHistory', label: 'Clinical history', group: 'Patient' },
  { key: 'species', label: 'Species', group: 'Patient' }, { key: 'breed', label: 'Breed', group: 'Patient' }, { key: 'owner', label: 'Owner', group: 'Patient' },
  { key: 'billNo', label: 'Bill number', group: 'Bill' }, { key: 'reportNo', label: 'Report number', group: 'Bill' }, { key: 'billDate', label: 'Bill date', group: 'Bill' },
  { key: 'registeredAt', label: 'Registered at', group: 'Bill' }, { key: 'priority', label: 'Priority', group: 'Bill' }, { key: 'source', label: 'Source', group: 'Bill' },
  { key: 'bookingId', label: 'Booking ID', group: 'Bill' }, { key: 'branch', label: 'Branch', group: 'Bill' }, { key: 'status', label: 'Report status', group: 'Bill' },
  { key: 'referrer', label: 'Referred by', group: 'Referral' }, { key: 'secondReferrer', label: 'Second referrer', group: 'Referral' }, { key: 'hospital', label: 'Hospital', group: 'Referral' },
  { key: 'b2bCentre', label: 'B2B centre', group: 'Referral' }, { key: 'b2bCode', label: 'B2B code', group: 'Referral' }, { key: 'collectionCentre', label: 'Collection centre', group: 'Referral' },
  { key: 'corporate', label: 'Corporate', group: 'Referral' }, { key: 'corporateUser', label: 'Employee', group: 'Referral' }, { key: 'corporatePlan', label: 'Corporate plan', group: 'Referral' },
  { key: 'govPanel', label: 'Government panel', group: 'Referral' }, { key: 'tpa', label: 'TPA', group: 'Referral' },
  { key: 'collectionPlace', label: 'Collection place', group: 'Sample' }, { key: 'phlebotomist', label: 'Collected by', group: 'Sample' }, { key: 'collectedAt', label: 'Collected at', group: 'Sample' },
  { key: 'receivedAt', label: 'Received at', group: 'Sample' }, { key: 'reportedAt', label: 'Reported at', group: 'Sample' }, { key: 'sampleType', label: 'Sample type', group: 'Sample' },
  { key: 'barcode', label: 'Sample ID / barcode', group: 'Sample' },
]
export const FIELD_LABELS: Record<string, string> = Object.fromEntries(HEADER_FIELDS.map((f) => [f.key, f.label]))

export function ageText(value: number, unit: AgeUnit | string, format: ReportLayoutSettings['ageFormat']): string {
  const short: Record<string, string> = { year: 'Y', month: 'M', day: 'D' }
  if (format === 'short') return `${value}${short[unit] ?? ''}`
  if (format === 'ymd' && unit === 'year') return `${Math.floor(value)}Y ${Math.round((value % 1) * 12)}M`
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}
