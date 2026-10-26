import type { Package, Parameter, SampleType, Test } from '../../types'

// Catalogue extensions stored on the same Firestore docs as the base types.
// They are optional so older documents keep working.

export type TestType = 'default' | 'microbiology' | 'allergy' | 'radiology'
export const TEST_TYPES: { value: TestType; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'microbiology', label: 'Microbiology' },
  { value: 'allergy', label: 'Allergy' },
  { value: 'radiology', label: 'Radiology' },
]

export type FieldType = 'single' | 'multiple' | 'textEditor' | 'images' | 'pdf'
export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'single', label: 'Single field' },
  { value: 'multiple', label: 'Multiple field (heading with members)' },
  { value: 'textEditor', label: 'Text editor' },
  { value: 'images', label: 'Images' },
  { value: 'pdf', label: 'PDF' },
]

export interface OutsourceEntry {
  labId: string
  cost: number // paise
  tatMinutes: number | null
  isDefault: boolean
}

export interface TestExt extends Test {
  testType?: TestType
  method?: string
  barcodeSuffix?: string
  lmpRequired?: boolean
  idRequired?: boolean
  consentForm?: boolean
  consentText?: string
  preCollectionGuidelines?: string
  catalogueCode?: string
  machineCode?: string // LIS / analyser code(s), comma separated
  machineReading?: boolean // results for this test arrive from an analyser (machine values), CAT-35
  onlyMale?: boolean
  onlyFemale?: boolean
  onlyBilling?: boolean
  startNextPage?: boolean
  species?: string
  reportTemplateId?: string
  comments?: string
  interpretationEnabled?: boolean
  interpretationHtml?: string // rich copy of the interpretation (the plain `interpretation` is kept in step)
  preAnalyticalTatMinutes?: number | null
  deleted?: boolean // soft-deleted: hidden from the catalogue and billing, kept for history
  startOnNewPage?: boolean // same switch as startNextPage, under the name the report reads
  restricted?: boolean
  consentRequired?: boolean
  outsourceLabs?: OutsourceEntry[]
  createdByAi?: boolean // created by 'Create test with AI'
  aiDraft?: boolean // AI draft not yet reviewed in the editor
}

export interface ParameterExt extends Parameter {
  fieldType?: FieldType
  omitFromTotal?: boolean
  machineCode?: string
  catalogueCode?: string
}

export interface SampleTypeExt extends SampleType {
  container?: string
  volume?: string
  barcodePrefix?: string
  barcodeSuffix?: string
  active?: boolean
}

export type PackageCategory = 'general' | 'annual' | 'preEmployment' | 'preInsurance'
export const PACKAGE_CATEGORY_LABEL: Record<PackageCategory, string> = { general: 'General', annual: 'Annual health check', preEmployment: 'Pre-employment', preInsurance: 'Pre-insurance' }
export interface PackageExt extends Package {
  description?: string
  category?: PackageCategory // corporate plans pick packages by category
  gender?: 'both' | 'male' | 'female' // who the package applies to
  showTestsOnBill?: boolean // print the member tests under the package on the bill (default true)
  preCollectionGuidelines?: string // fasting / preparation shown at registration
}

export const TEST_METHODS = [
  'Automated analyser', 'Colorimetric', 'Spectrophotometry', 'Photometry', 'Turbidimetry', 'Nephelometry',
  'Immunoturbidimetry', 'Enzymatic', 'Enzymatic colorimetric', 'Kinetic', 'Jaffe kinetic', 'GOD-POD',
  'CHOD-PAP', 'Ion selective electrode', 'Flame photometry', 'HPLC', 'Electrophoresis', 'Capillary electrophoresis',
  'Electrical impedance', 'Flow cytometry', 'Microscopy', 'Manual', 'Dipstick', 'Reflectance photometry',
  'ELISA', 'CLIA', 'ECLIA', 'CMIA', 'FIA', 'Immunochromatography', 'Latex agglutination', 'Slide agglutination',
  'Tube agglutination', 'PCR', 'Real-time PCR', 'Culture', 'Gram stain', 'Westergren', 'Coagulometry', 'Calculated',
]

export const SEX_OPTIONS = [
  { value: 'any', label: 'Any sex' },
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
]

// ---- TAT helpers (minutes <-> days/hours/minutes) -----------------------
export function splitTat(min: number | null | undefined): { d: number; h: number; m: number } {
  const t = Math.max(0, Math.round(min ?? 0))
  return { d: Math.floor(t / 1440), h: Math.floor((t % 1440) / 60), m: t % 60 }
}
export const joinTat = (d: number | null, h: number | null, m: number | null): number | null => {
  const t = (d ?? 0) * 1440 + (h ?? 0) * 60 + (m ?? 0)
  return t > 0 ? t : null
}
export function fmtTat(min: number | null | undefined): string {
  if (!min) return '-'
  const { d, h, m } = splitTat(min)
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ')
}
