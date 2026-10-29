import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../firebase'
import type { UserProfile } from '../types'

// Admin dashboard data (functions/src/dashboard.ts). Money is in paise.
export const DASHBOARD_ROLES = ['labAdmin', 'admin']
export const canSeeDashboard = (p: UserProfile | null | undefined) => !!p && DASHBOARD_ROLES.includes(p.role)

export interface DashMoney {
  billed: number
  gross: number
  discount: number
  bills: number
  patients: number
  tests: number
  dueOnBills: number
  final: number
  delivered: number
  rejected: number
  collected: number
  refunds: number
  avgBill: number
}
export interface DashAlert {
  key: string
  level: 'urgent' | 'caution' | 'info'
  title: string
  count: number
  detail: string
  link: string
  items?: { label: string; link: string }[]
}
export interface DashBranch extends DashMoney {
  id: string
  name: string
  outstanding: number
  openBills: number
  lateTests: number
  trend: number[]
}
export interface DashboardData {
  range: { from: string; to: string; prevFrom: string; prevTo: string; days: number }
  asOf: number
  scope: string[]
  branchesAvailable: { id: string; name: string; active: boolean }[]
  kpi: { cur: DashMoney; prev: DashMoney; outstanding: { amount: number; bills: number } }
  modes: Record<string, number>
  trend: { date: string; billed: number; collected: number; prevBilled: number; prevCollected: number }[]
  branches: DashBranch[]
  pipeline: { toCollect: number; collected: number; inLab: number; waitingApproval: number; hold: number; readyToSend: number; accessionOn: boolean; lateTests: number; nearlyLate: number }
  home: { total: number; done: number; pending: number; missed: number; cancelled: number }
  alerts: DashAlert[]
}

export const loadDashboard = async (from: string, to: string, branchIds: string[]): Promise<DashboardData> =>
  (await httpsCallable<Record<string, unknown>, DashboardData>(functions, 'dashboardSummary', { timeout: 300_000 })({ labId: LAB_ID, from, to, branchIds })).data
