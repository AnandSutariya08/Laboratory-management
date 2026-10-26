import { collectionGroup, getDocs, limit, query, where } from 'firebase/firestore'
import { db } from '../../firebase'
import { resolveRange } from '../../lib/results'
import type { Department, Parameter, ParamValue } from '../../types'
import type { PackageExt, TestExt } from './ext'

// ---------------------------------------------------------------------------
// Catalogue behaviour helpers. The editor, billing, results and report call these so that
// one switch in the catalogue means the same thing everywhere. Call sites other areas must wire
// are listed in the round 3 hand-over.
// ---------------------------------------------------------------------------

// ---- Test type (CAT-22) -----------------------------------------------------

/** Radiology test: testType 'radiology', or (older data) a modality is set. Routes to the Radiology worklist. */
export const isRadiologyTest = (t: Partial<TestExt> | undefined): boolean => t?.testType === 'radiology' || !!t?.modality

/** Radiology tests have no parameter grid: the report is findings / impression. */
export const hasParameterGrid = (t: Partial<TestExt> | undefined): boolean => !isRadiologyTest(t)

/** Where the worklist sends a test: result entry or radiology reporting. */
export const worklistFor = (t: Partial<TestExt> | undefined): 'radiology' | 'results' => (isRadiologyTest(t) ? 'radiology' : 'results')

// ---- Report template per test / department (CAT-39) ---------------------------

/**
 * The report template id that applies to a test: the test's own choice, else its department's, else '' (lab default).
 * The report page picks the template/layout with this. `departments` may be a Map or a list.
 */
export function templateFor(
  test: Partial<TestExt> | undefined,
  departments?: Map<string, Partial<Department>> | Partial<Department>[],
): string {
  if (!test) return ''
  if (test.reportTemplateId) return test.reportTemplateId
  const list = departments instanceof Map ? departments.get(test.departmentId ?? '') : departments?.find((d) => d.id === test.departmentId)
  return list?.reportTemplateId ?? ''
}

/** Distinct templates used by a set of tests, in first-seen order ('' = lab default). */
export function templatesFor(tests: Partial<TestExt>[], departments?: Map<string, Partial<Department>> | Partial<Department>[]): string[] {
  return [...new Set(tests.map((t) => templateFor(t, departments)))]
}

// ---- Species restriction (CAT-30) -------------------------------------------

export const SPECIES = ['Human', 'Canine', 'Feline', 'Bovine', 'Equine', 'Avian', 'Other']

/** Tests the patient's species may be billed for (blank species = Human). */
export function testsForSpecies<T extends Partial<TestExt>>(tests: T[], species: string | undefined): T[] {
  const sp = (species || 'Human').trim().toLowerCase()
  return tests.filter((t) => {
    const list = (t.species ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    return !list.length || list.includes(sp)
  })
}
export const speciesAllowed = (t: Partial<TestExt> | undefined, species: string | undefined): boolean => testsForSpecies([t ?? {}], species).length === 1

// ---- Packages (PKG-05) -------------------------------------------------------

/** Package applies to this patient's gender ('both' / missing = everyone). */
export const packageAppliesTo = (p: Partial<PackageExt> | undefined, gender: string | undefined): boolean =>
  !p?.gender || p.gender === 'both' || !gender || gender === 'other' || p.gender === gender

/** Print the member tests under the package on the bill (default yes). */
export const showPackageTestsOnBill = (p: Partial<PackageExt> | undefined): boolean => p?.showTestsOnBill !== false

/** Package pre-collection guidelines, to be printed with the test guidelines. */
export const packageGuidelines = (packages: (Partial<PackageExt> | undefined)[]): { name: string; text: string }[] =>
  packages.flatMap((p) => (p?.preCollectionGuidelines?.trim() ? [{ name: p.name ?? '', text: p.preCollectionGuidelines.trim() }] : []))

// ---- Branch availability (CAT-04) -------------------------------------------

/** A test / package is offered in a branch when it names no branches (all) or lists that branch. */
export const availableInBranch = (item: { branchIds?: string[] } | undefined, branchId: string | undefined): boolean =>
  !item?.branchIds?.length || !branchId || item.branchIds.includes(branchId)

// ---- Soft delete (X-02) -------------------------------------------------------

export const isDeleted = (x: { deleted?: boolean } | undefined): boolean => !!x?.deleted
export const notDeleted = <T extends { deleted?: boolean }>(xs: T[]): T[] => xs.filter((x) => !x.deleted)
/** Departments marked inactive stay on old tests but are not offered for new ones. */
export const activeDepartments = <T extends { deleted?: boolean; active?: boolean }>(xs: T[]): T[] => xs.filter((x) => !x.deleted && x.active !== false)

// ---- Range snapshot (PAR-10) --------------------------------------------------

export interface RangeSnap { low: number | null; high: number | null; text: string; at: number }

/** Range as it stands now for this patient; store it on ParamValue.rangeSnapshot when the value is entered. */
export function snapshotRange(p: Parameter, ageDays: number, gender?: string, condition?: string, now = Date.now()): RangeSnap {
  const r = resolveRange(p, ageDays, gender, condition)
  return { low: r.low, high: r.high, text: r.text, at: now }
}

/** Add the snapshot to a value the first time it gets text (keeps an existing snapshot). */
export function withRangeSnapshot(p: Parameter, v: ParamValue, ageDays: number, gender?: string, condition?: string): ParamValue {
  if (v.rangeSnapshot || !v.value.trim()) return v
  return { ...v, rangeSnapshot: snapshotRange(p, ageDays, gender, condition) }
}

/** Printed range text: the edited one, else the one snapshotted at entry, else the live catalogue range. */
export function printedRange(p: Parameter, v: ParamValue | undefined, ageDays: number, gender?: string, condition?: string): string {
  if (v?.rangeOverride) return resolveRange(p, ageDays, gender, condition, v.rangeOverride).text
  if (v?.rangeSnapshot) return v.rangeSnapshot.text
  return resolveRange(p, ageDays, gender, condition).text
}

// ---- Guard removing a parameter that has results (CAT-40) -----------------------

/**
 * Parameter keys (of the given ones) that already hold a value in some entered result of this test.
 * Used before saving a test that no longer lists those parameters.
 */
export async function parametersWithResults(testId: string, keys: string[]): Promise<{ keys: string[]; results: number }> {
  if (!testId || !keys.length) return { keys: [], results: 0 }
  const snap = await getDocs(query(collectionGroup(db, 'results'), where('testId', '==', testId), limit(400)))
  const hit = new Set<string>()
  let results = 0
  snap.forEach((d) => {
    const values = (d.data().values ?? {}) as Record<string, { value?: string }>
    let any = false
    for (const k of keys) {
      if (String(values[k]?.value ?? '').trim()) {
        hit.add(k)
        any = true
      }
    }
    if (any) results++
  })
  return { keys: [...hit], results }
}
