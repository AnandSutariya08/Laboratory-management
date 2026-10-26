import type { LabSettings, OrderItem, SampleType } from '../../types'
import { barcodeGroupKey, barcodeType } from '../../features/settings/lib'
import type { SampleTypeExt, TestExt } from './ext'

// ---------------------------------------------------------------------------
// Readers for the catalogue test flags. Reports, accession, billing and the
// worklist call these instead of reading the raw fields, so the Test editor's
// switches have one meaning everywhere.
// ---------------------------------------------------------------------------


// ---- Report (reports agent) ------------------------------------------------

// Interpretation prints when the test switch is on (default: on when text exists) AND text exists.
// Call: ReportPage / PublicReportPage / smart & radiology reports before printing t.interpretation.
export const showInterpretation = (t: Partial<TestExt> | undefined): boolean =>
  !!t?.interpretation?.trim() && (t.interpretationEnabled ?? true)

// Test-level comment printed under the test's results (blank = none).
export const testComment = (t: Partial<TestExt> | undefined): string => t?.comments?.trim() ?? ''

// Test starts on a fresh page (editor saves startNextPage and startOnNewPage together).
export const startsOnNewPage = (t: Partial<TestExt> | undefined): boolean => !!(t?.startOnNewPage ?? t?.startNextPage)

// Sensitive test: never sent over WhatsApp / SMS.
export const isRestrictedTest = (t: Partial<TestExt> | undefined): boolean => !!t?.restricted

// ---- Billing / registration (front desk) -----------------------------------

export const needsLmp = (t: Partial<TestExt> | undefined) => !!t?.lmpRequired
export const needsIdProof = (t: Partial<TestExt> | undefined) => !!t?.idRequired
export const needsConsent = (t: Partial<TestExt> | undefined) => !!(t?.consentRequired || t?.consentForm)
export const consentText = (t: Partial<TestExt> | undefined) => t?.consentText?.trim() ?? ''

// Pre-collection guidelines of the given tests, de-duplicated, for the bill, quotation and booking message.
export function preCollectionGuidelines(tests: (Partial<TestExt> | undefined)[]): { name: string; text: string }[] {
  const seen = new Set<string>()
  const out: { name: string; text: string }[] = []
  for (const t of tests) {
    const text = t?.preCollectionGuidelines?.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push({ name: t?.name ?? '', text })
  }
  return out
}

// Species restriction ("Human" / blank = everyone; a comma separated list otherwise).
export function testAllowedForSpecies(t: Partial<TestExt> | undefined, species: string | undefined): boolean {
  const list = (t?.species ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  if (!list.length || list.includes('human') && !species) return true
  return list.includes((species || 'human').trim().toLowerCase())
}

// Billing-only: a service line with no sample, worklist entry, result or stock use.
export const isBillingOnlyTest = (t: Partial<TestExt> | undefined) => !!t?.onlyBilling
export const lineIsBillingOnly = (i: Pick<OrderItem, 'onlyBilling'>, tests: (Partial<TestExt> | undefined)[]) =>
  !!i.onlyBilling || (tests.length > 0 && tests.every(isBillingOnlyTest))

// ---- Barcode / label (accession agent) ---------------------------------------

export interface SampleLabel {
  key: string
  sampleTypeId: string
  sampleName: string
  barcode: string
  testIds: string[]
  testNames: string[]
}

// Barcode of one sample tube: sampleType prefix + bill barcode + suffix. The test's own
// "barcode suffix" wins over the sample type's, so tests that need a separate tube
// (e.g. fluoride vs EDTA) get distinct labels even when they share a sample type.
export function composeBarcode(billBarcode: string, sample: Partial<SampleTypeExt> | undefined, test?: Partial<TestExt>): string {
  const suffix = (test?.barcodeSuffix ?? '').trim() || (sample?.barcodeSuffix ?? '').trim()
  return `${(sample?.barcodePrefix ?? '').trim()}${billBarcode}${suffix}`
}

// The labels to print for a bill. accession.barcodePer: 'bill' = one label per distinct suffix
// (usually a single bill barcode); 'sample' = one label per sample type (+ suffix).
// Billing-only and outsourced-without-sample lines never need a tube.
export function sampleLabels(
  billBarcode: string,
  items: Pick<OrderItem, 'testIds' | 'status' | 'onlyBilling' | 'isCharge'>[],
  testById: Map<string, Partial<TestExt> & { name?: string }>,
  sampleTypeById: Map<string, Partial<SampleTypeExt> & Pick<SampleType, 'name'>>,
  settings: Pick<LabSettings, 'accession' | 'barcode'>,
  departmentName?: (departmentId: string) => string,
): SampleLabel[] {
  const per = settings.accession?.barcodePer ?? 'sample'
  const groups = new Map<string, SampleLabel>()
  for (const it of items) {
    if (it.isCharge || it.onlyBilling || it.status === 'refunded') continue
    for (const tid of it.testIds) {
      const t = testById.get(tid)
      if (!t || t.onlyBilling) continue
      const st = sampleTypeById.get(t.sampleTypeId ?? '')
      const barcode = composeBarcode(billBarcode, st, t)
      // Department-wise barcodes: one label per department (the barcode itself stays the bill's so a scan still resolves).
      const byDept = barcodeType(settings) === 'department'
      const dept = byDept ? barcodeGroupKey(settings, { orderId: '', departmentId: t.departmentId }) : ''
      const base = per === 'bill' ? barcode : `${t.sampleTypeId ?? ''}|${barcode}`
      const key = byDept ? `${dept}|${base}` : base
      const name = byDept ? departmentName?.(t.departmentId ?? '') || 'Department' : per === 'bill' ? 'Bill' : st?.name ?? ''
      const g = groups.get(key) ?? { key, sampleTypeId: t.sampleTypeId ?? '', sampleName: name, barcode, testIds: [], testNames: [] }
      if (!g.testIds.includes(tid)) {
        g.testIds.push(tid)
        g.testNames.push(t.name ?? '')
      }
      groups.set(key, g)
    }
  }
  return [...groups.values()]
}

// Barcode scan / search: which bill barcode does a scanned tube code belong to? Strips the
// sample prefix and the test or sample suffix configured in the catalogue.
export function billBarcodeFromScan(scan: string, tests: Partial<TestExt>[], sampleTypes: Partial<SampleTypeExt>[]): string {
  let code = scan.trim()
  const prefixes = sampleTypes.map((s) => (s.barcodePrefix ?? '').trim()).filter(Boolean).sort((a, b) => b.length - a.length)
  const suffixes = [...tests.map((t) => (t.barcodeSuffix ?? '').trim()), ...sampleTypes.map((s) => (s.barcodeSuffix ?? '').trim())].filter(Boolean).sort((a, b) => b.length - a.length)
  const p = prefixes.find((x) => code.startsWith(x))
  if (p) code = code.slice(p.length)
  const s = suffixes.find((x) => code.endsWith(x))
  if (s) code = code.slice(0, code.length - s.length)
  return code
}

// ---- Worklist ---------------------------------------------------------------

// Tests that appear in accession / result entry: not billing-only.
export const needsResultEntry = (t: Partial<TestExt> | undefined) => !t?.onlyBilling

// ---- Parameter range validation ------------------------------------------------

// Returns an error when two age bands of the same parameter overlap for the same sex.
export function rangeOverlaps(params: { key: string; ranges?: { fromDays: number; toDays: number; gender?: 'any' | 'male' | 'female' }[] }[]): string | null {
  for (const p of params) {
    const rs = p.ranges ?? []
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i]
        const b = rs[j]
        const sexClash = (a.gender ?? 'any') === 'any' || (b.gender ?? 'any') === 'any' || a.gender === b.gender
        if (sexClash && a.fromDays < b.toDays && b.fromDays < a.toDays) return `Parameter ${p.key}: two age ranges overlap (${a.fromDays}-${a.toDays} and ${b.fromDays}-${b.toDays} days)`
      }
    }
  }
  return null
}


/**
 * Member tests of a package that are disabled or no longer exist (PKG-06). Billing should warn and, after
 * the user confirms, leave these out of the line's testIds.
 */
export function inactivePackageMembers(pkg: { testIds: string[] }, testById: Map<string, { disabled?: boolean; name?: string }>): { id: string; name: string; missing: boolean }[] {
  return pkg.testIds.flatMap((id) => {
    const t = testById.get(id)
    return !t || t.disabled ? [{ id, name: t?.name ?? id, missing: !t }] : []
  })
}
