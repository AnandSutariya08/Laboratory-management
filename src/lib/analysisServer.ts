import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../firebase'
import { branchParam } from './activeBranch'

// Server side range aggregation (functions/src/exports.ts). Used by Analysis when the dates span more than
// 31 days or the period has more than 500 bills, where reading every bill in the browser is too slow.
export interface AggSeg { name: string; bills: number; amount: number; discount: number; net: number; paid: number; due: number }
export interface AggKpi { reg: number; tests: number; billing: number; paid: number; due: number; cleared: number }
export interface AggUser { uid: string; name: string; bills: number; tests: number; modes: Record<string, number>; paid: number; due: number; discount: number; total: number }
export interface AggResult {
  from: string
  to: string
  bills: number
  asOf: number
  registrations: number
  kpi: { all: AggKpi; by: { b2b: AggKpi; referral: AggKpi; self: AggKpi } }
  testStatus: Record<string, number>
  patientStatus: Record<string, number>
  segments: { referral: AggSeg[]; department: AggSeg[]; b2b: AggSeg[]; package: AggSeg[] }
  topTests: { name: string; freq: number; amount: number }[]
  users: { billing: AggUser[]; collection: AggUser[] }
  byDay: { date: string; bills: number; tests: number; net: number; paid: number; due: number; registrations: number }[]
  byMonth: { month: string; bills: number; tests: number; net: number; registrations: number }[]
  ledgerByDay: { date: string; collected: number; cleared: number; refunded: number }[]
  ledgerByMode: Record<string, number>
}
export type AggScope = 'all' | 'pathology' | 'radiology'

export const aggregateRange = async (from: string, to: string, scope: AggScope = 'all', dept = ''): Promise<AggResult> =>
  (await httpsCallable<Record<string, unknown>, AggResult>(functions, 'aggregateRange', { timeout: 540_000 })({ labId: LAB_ID, branchId: branchParam(), from, to, scope, dept })).data

// ---- Background export jobs (labs/{lab}/exportJobs) ----------------------------------------------------------
export type ExportKind = 'billing' | 'collection' | 'test' | 'outsource' | 'fullLedger' | 'custom'
export interface ExportJob {
  id: string
  kind: ExportKind
  name: string
  from: number
  to: number
  branchId: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  requestedBy: string
  requestedByName: string
  requestedAt?: { toMillis: () => number }
  completedAt?: { toMillis: () => number }
  rows?: number
  bytes?: number
  tookMs?: number
  error?: string
  storagePath?: string
}
