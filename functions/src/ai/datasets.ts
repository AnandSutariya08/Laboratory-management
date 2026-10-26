import { HttpsError } from 'firebase-functions/v2/https'
import { db } from './common'
import type { AnalyticsQuery, Metric } from './types'

// AI dataset permissions. The lab document carries `aiDatasetAccess: { [role]: string[] }`.
// A role missing from the map falls back to the defaults below. Enforced server-side by every
// analyst tool: a tool whose dataset the caller may not read is never offered to the model
// and is refused if called anyway.

export const DATASETS = ['bills', 'collections', 'tests', 'tat', 'qc', 'bookings', 'patients_masked'] as const
export type Dataset = (typeof DATASETS)[number]

export const DATASET_LABELS: Record<Dataset, string> = {
  bills: 'Bills (revenue, dues, discounts, counts)',
  collections: 'Collections and refunds',
  tests: 'Tests (volumes and catalogue)',
  tat: 'Turnaround time',
  qc: 'Quality control runs',
  bookings: 'Bookings',
  patients_masked: 'Patients (initials only, masked)',
}

export function defaultAccess(role: string): Dataset[] {
  if (role === 'labAdmin' || role === 'admin') return [...DATASETS]
  if (role === 'manager') return DATASETS.filter((d) => d !== 'patients_masked')
  return []
}

const isDataset = (x: unknown): x is Dataset => (DATASETS as readonly string[]).includes(String(x))

export function accessFromLab(lab: Record<string, unknown>, role: string): Set<Dataset> {
  const map = lab.aiDatasetAccess
  if (map && typeof map === 'object' && Array.isArray((map as Record<string, unknown>)[role])) {
    return new Set(((map as Record<string, unknown[]>)[role]).filter(isDataset))
  }
  return new Set(defaultAccess(role))
}

export async function loadDatasetAccess(labId: string, role: string): Promise<Set<Dataset>> {
  const lab = ((await db().doc(`labs/${labId}`).get()).data() ?? {}) as Record<string, unknown>
  return accessFromLab(lab, role)
}

export const ACCESS_ROLES = ['labAdmin', 'admin', 'manager'] as const

// Effective map for the editor (every role in ACCESS_ROLES present).
export async function loadAccessMap(labId: string): Promise<Record<string, Dataset[]>> {
  const lab = ((await db().doc(`labs/${labId}`).get()).data() ?? {}) as Record<string, unknown>
  const out: Record<string, Dataset[]> = {}
  for (const r of ACCESS_ROLES) out[r] = [...accessFromLab(lab, r)]
  return out
}

export function metricDataset(metric: Metric): Dataset {
  switch (metric) {
    case 'collections':
    case 'refunds':
      return 'collections'
    case 'tests':
      return 'tests'
    case 'tat':
      return 'tat'
    case 'bookings':
      return 'bookings'
    default:
      return 'bills'
  }
}

export function requireDataset(allowed: Set<Dataset>, dataset: Dataset): void {
  if (!allowed.has(dataset)) {
    throw new HttpsError('permission-denied', `Your role does not have access to the "${dataset}" dataset. A lab admin can change this under Data access.`)
  }
}

export function requireQueryAccess(allowed: Set<Dataset>, q: AnalyticsQuery): void {
  requireDataset(allowed, metricDataset(q.metric))
}
