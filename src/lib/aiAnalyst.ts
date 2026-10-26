import { httpsCallable } from 'firebase/functions'
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import { Timestamp } from 'firebase/firestore'
import { db, functions, LAB_ID } from '../firebase'
import { branchParam } from './activeBranch'
import type { AiChatStep, AnalyticsQuery, AnalyticsResult, Dashboard, DashboardWidget } from '../types'

// Callables and live listeners for the AI analyst page: streamed chat, dataset access,
// dashboard sharing / branch view, and pinned tables.

// `branchId` in the input wins over the active branch (used by the dashboard branch selector).
const call = <I extends object, O>(name: string) => async (input: I & { branchId?: string }) =>
  (await httpsCallable<object, O>(functions, name, { timeout: 300_000 })({ branchId: branchParam(), ...input, labId: LAB_ID })).data

// ---- Streamed chat ------------------------------------------------------------------

export interface ChatTurnResult {
  chatId: string
  text: string
  results: AnalyticsResult[]
  steps: AiChatStep[]
  dashboardId?: string
  stopped?: boolean
}

// chatId must be a client-made id (8-40 chars of A-Z a-z 0-9 _ -) for a new chat, so the page can
// listen to labs/{lab}/aiChats/{chatId}/stream/current before the call returns.
export const analystChatStream = call<{ chatId: string; message: string; turnId: string; editDashboardId?: string }, ChatTurnResult>('analystChatStream')

export const newChatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export interface StreamDoc {
  userId: string
  turnId: string
  status: 'running' | 'done' | 'error'
  text: string
  steps: { tool: string; summary: string }[]
  cancel?: boolean
}

const streamRef = (chatId: string) => doc(db, 'labs', LAB_ID, 'aiChats', chatId, 'stream', 'current')

export function listenStream(chatId: string, cb: (s: StreamDoc | null) => void): () => void {
  return onSnapshot(
    streamRef(chatId),
    (s) => cb(s.exists() ? (s.data() as StreamDoc) : null),
    () => cb(null),
  )
}

// Ask the server to stop the turn in progress; it checks the flag between chunks.
export const cancelStream = (chatId: string) => updateDoc(streamRef(chatId), { cancel: true })

// ---- Dataset access ---------------------------------------------------------------------

export interface DatasetAccessInfo {
  datasets: { value: string; label: string }[]
  roles: string[]
  access: Record<string, string[]>
  mine: string[]
  canEdit: boolean
}
export const getAiDatasetAccess = call<object, DatasetAccessInfo>('getAiDatasetAccess')
export const setAiDatasetAccess = call<{ access: Record<string, string[]> }, { ok: true; access: Record<string, string[]> }>('setAiDatasetAccess')

// ---- Dashboards ----------------------------------------------------------------------------

type DashRow = Omit<Dashboard, 'createdAt' | 'updatedAt' | 'sharedWithRoles'> & { sharedWithRoles: string[] | null; updatedAtMs: number; canEdit: boolean }
export interface DashboardEntry extends Dashboard {
  canEdit: boolean
}
const listRaw = call<object, { dashboards: DashRow[] }>('listAiDashboards')
// Dashboards visible to the signed-in user: their own, those shared with their role, and (admins) all.
export async function listAiDashboards(): Promise<DashboardEntry[]> {
  const res = await listRaw({})
  return res.dashboards.map((d) => {
    const { updatedAtMs, sharedWithRoles, ...rest } = d
    const ts = Timestamp.fromMillis(updatedAtMs || Date.now())
    return { ...rest, ...(sharedWithRoles ? { sharedWithRoles } : {}), createdAt: ts, updatedAt: ts }
  })
}
export const shareAiDashboard = call<{ dashboardId: string; roles: string[] }, { ok: true }>('shareAiDashboard')

export type WidgetResult = DashboardWidget & { result: AnalyticsResult | null; error?: string }
export const runDashboardIn = call<{ dashboardId: string }, { widgets: WidgetResult[] }>('runDashboard')
export const runAnalyticsIn = call<{ query: AnalyticsQuery }, AnalyticsResult>('runAnalytics')

// ---- Pinned tables -----------------------------------------------------------------------------

export type ColumnKind = 'shareOfTotal' | 'rank' | 'cumulative' | 'metric'
export interface ExtraColumn {
  id: string
  label: string
  kind: ColumnKind
  // kind 'metric': another metric joined on the row label (same groupBy and range).
  metric?: AnalyticsQuery['metric']
}
export interface PinnedTable {
  title: string
  query: AnalyticsQuery
  columns: ExtraColumn[]
  pinnedAt: number
}
export interface PinsDoc {
  tables: Record<string, PinnedTable> // key: chatId:messageIndex:resultIndex
  migratedLocal?: boolean
}

const pinsRef = (uid: string) => doc(db, 'labs', LAB_ID, 'aiTablePins', uid)
const PIN_KEY = 'hcl.ai.pinnedTables'

export async function loadPins(uid: string): Promise<PinsDoc> {
  const snap = await getDoc(pinsRef(uid))
  return (snap.exists() ? (snap.data() as PinsDoc) : { tables: {} }) as PinsDoc
}
export const savePins = (uid: string, d: PinsDoc) => setDoc(pinsRef(uid), JSON.parse(JSON.stringify(d)))

// Keys pinned in this browser before pins moved to Firestore (read once, then migrated and cleared).
export function takeLocalPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}
export function clearLocalPins() {
  try {
    localStorage.removeItem(PIN_KEY)
  } catch {
    /* ignore */
  }
}
