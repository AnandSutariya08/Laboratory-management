import { useEffect, useRef, useState } from 'react'
import { getDocs, query, where, type DocumentData } from 'firebase/firestore'
import { col, ledgerCol, paths } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { outsourceForLine } from '../outsource/lib'
import type { Order, UserProfile } from '../../types'
import type { Filters, PatientOrder } from './types'

// ---- Tabs ---------------------------------------------------------------------
export const isOutsourced = (o: PatientOrder) =>
  !!o.outsourced || !!o.processingLabId || o.items.some((i) => (i as { outsourced?: boolean }).outsourced || (i.status !== 'refunded' && i.testIds.some((t) => outsourceForLine(i, t))))
export const isGovPanel = (o: PatientOrder) => !!o.govPanelId || !!o.govPanelName

export interface TabDef {
  key: string
  label: string
  test: (o: PatientOrder) => boolean
}
// Pending Dispatch: some item is final and has not yet gone out through every selected mode.
// Dispatched: every final item has gone out. A bill dispatched before more tests were approved
// (dispatchedLineIds lacks them) is pending again. Bills dispatched before this field existed
// are treated as fully dispatched.
const finalLines = (o: PatientOrder) => o.items.filter((i) => i.status === 'approved')
// Flabs: a bill is ready to dispatch once every one of its tests is approved (Completed). A due does not stop that.
const testLines = (o: PatientOrder) => o.items.filter((i) => i.status !== 'refunded' && i.status !== 'rejected' && !i.isCharge && i.testIds.length > 0)
export const allApproved = (o: PatientOrder) => {
  const l = testLines(o)
  return l.length > 0 && l.every((i) => i.status === 'approved')
}
export const isFullyRefunded = (o: PatientOrder) => o.items.length > 0 && o.items.every((i) => i.status === 'refunded')
export const hasFinalItem = (o: PatientOrder) => o.reportStatus === 'final' || allApproved(o)
export const isDispatchPending = (o: PatientOrder) => {
  if (!hasFinalItem(o)) return false
  if (!o.dispatched) return true
  const done = o.dispatchedLineIds
  return !!done && finalLines(o).some((i) => !done.includes(i.lineId))
}
export const TABS: TabDef[] = [
  // A bill whose every line was refunded leaves All and lives only in the Refunded tab.
  { key: 'all', label: 'All', test: (o) => !isFullyRefunded(o) },
  { key: 'pendingDispatch', label: 'Pending Dispatch', test: isDispatchPending },
  { key: 'dispatched', label: 'Dispatched', test: (o) => hasFinalItem(o) && !isDispatchPending(o) && o.dispatched },
  { key: 'due', label: 'Due', test: (o) => o.due > 0 },
  { key: 'outsource', label: 'Outsource', test: isOutsourced },
  { key: 'refunded', label: 'Refunded', test: (o) => o.refunded > 0 },
  { key: 'discount', label: 'Discount', test: (o) => o.discount > 0 },
  { key: 'govPanel', label: 'Government Panel', test: isGovPanel },
  { key: 'pcpndt', label: 'PCPNDT', test: (o) => !!o.pcpndt || o.items.some((i) => i.pcpndt) },
]

// ---- Filters ------------------------------------------------------------------
export const EMPTY_FILTERS: Filters = { printed: 'any', billSort: 'desc' }

export function activeFilterCount(f: Filters): number {
  let n = 0
  for (const [k, v] of Object.entries(f)) {
    if (k === 'billSort') {
      if (v === 'asc') n++
    } else if (k === 'printed') {
      if (v === 'yes' || v === 'no') n++
    } else if (v) n++
  }
  return n
}

export interface FilterContext {
  testsOfDept: (deptId: string) => Set<string> // test ids in a department
  ledgerModes: Map<string, Set<string>>
}

export function matchesFilters(o: PatientOrder, f: Filters, ctx: FilterContext): boolean {
  if (f.referrer && o.referrerName !== f.referrer) return false
  if (f.hospital && (o.hospitalName ?? '') !== f.hospital) return false
  if (f.secondReferrer && (o.secondReferrerName ?? '') !== f.secondReferrer) return false
  if (f.b2b && o.b2bCentreId !== f.b2b) return false
  if (f.collectionCentre && o.collectionCentreId !== f.collectionCentre) return false
  if (f.corporate && o.corporateClientId !== f.corporate) return false
  if (f.pro && o.proId !== f.pro) return false
  if (f.phlebotomist && o.phlebotomistId !== f.phlebotomist) return false
  if (f.createdBy && o.createdBy !== f.createdBy) return false
  if (f.branch && (o.branchId || 'main') !== f.branch) return false
  if (f.reportStatus && o.reportStatus !== f.reportStatus) return false
  if (f.test && !o.items.some((i) => i.testIds.includes(f.test!))) return false
  if (f.pkg && !o.items.some((i) => i.kind === 'package' && i.refId === f.pkg)) return false
  if (f.department) {
    const ids = ctx.testsOfDept(f.department)
    if (!o.items.some((i) => i.testIds.some((t) => ids.has(t)))) return false
  }
  if (f.paymentMode && !ctx.ledgerModes.get(o.id)?.has(f.paymentMode)) return false
  if (f.urgent && !o.items.some((i) => i.urgent)) return false
  if (f.smartReport && !o.smartReport) return false
  if (f.selfWalking && o.referrerName && o.referrerName.toLowerCase() !== 'self') return false
  if (f.abhaLinked && !o.abhaLinked) return false
  if (f.printed === 'yes' && !o.printed) return false
  if (f.printed === 'no' && o.printed) return false
  return true
}

// Refund rows of the Refunded tab: date, who, amount and reason come from the bill's refund ledger entries.
export interface RefundInfo { at: Date | null; by: string; amount: number; reason: string; lineIds: string[] }
export function useRefundInfo(orders: Order[], enabled: boolean) {
  const cache = useRef(new Map<string, RefundInfo[]>())
  const [, bump] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const todo = orders.filter((o) => !cache.current.has(o.id)).slice(0, 300)
    if (!todo.length) return
    let dead = false
    Promise.all(
      todo.map(async (o) => {
        try {
          const snap = await getDocs(ledgerCol(o.id))
          cache.current.set(
            o.id,
            snap.docs
              .map((d) => d.data() as { type: string; amount: number; postedAt?: { toDate?: () => Date }; postedByName?: string; remark?: string; lineIds?: string[] })
              .filter((e) => e.type === 'refund')
              .map((e) => ({ at: e.postedAt?.toDate?.() ?? null, by: e.postedByName ?? '', amount: -e.amount, reason: e.remark ?? '', lineIds: e.lineIds ?? [] })),
          )
        } catch {
          cache.current.set(o.id, [])
        }
      }),
    ).then(() => !dead && bump((n) => n + 1))
    return () => {
      dead = true
    }
  }, [orders, enabled])
  return cache.current
}

// Payment modes live in the bill's ledger sub-collection, so they are loaded on
// demand, only while the payment-mode filter is in use.
export function useLedgerModes(orders: Order[], enabled: boolean) {
  const cache = useRef(new Map<string, Set<string>>())
  const [, bump] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const todo = orders.filter((o) => !cache.current.has(o.id)).slice(0, 400)
    if (!todo.length) return
    let dead = false
    Promise.all(
      todo.map(async (o) => {
        try {
          const snap = await getDocs(ledgerCol(o.id))
          cache.current.set(o.id, new Set(snap.docs.map((d) => (d.data() as { mode: string }).mode)))
        } catch {
          cache.current.set(o.id, new Set())
        }
      }),
    ).then(() => !dead && bump((n) => n + 1))
    return () => {
      dead = true
    }
  }, [orders, enabled])
  return cache.current
}

// ---- Master data (shared, read-only here) --------------------------------------
export interface Named {
  id: string
  name: string
  type?: string
  active?: boolean
}
export function useMaster(name: string) {
  return useLiveQuery<Named & DocumentData>(query(col<DocumentData>(name)), []).data.filter((x) => x.active !== false)
}

// ---- Visit history across branches the user may see -----------------------------
// Rules check each document's branch, so a query must name one branch (==) unless the
// user may use all branches.
export async function fetchPatientOrders(patientId: string, profile: UserProfile | null): Promise<PatientOrder[]> {
  if (!profile) return []
  const base = col<DocumentData>(paths.orders)
  const toOrders = (snaps: Awaited<ReturnType<typeof getDocs>>[]) => {
    const seen = new Map<string, PatientOrder>()
    for (const s of snaps) for (const d of s.docs) seen.set(d.id, { ...(d.data() as object), id: d.id } as PatientOrder)
    return [...seen.values()].filter((o) => !o.deleted)
  }
  if (profile.allBranches) return toOrders([await getDocs(query(base, where('patientId', '==', patientId)))])
  const ids = profile.branchIds?.length ? profile.branchIds : ['main']
  const snaps = await Promise.all(
    ids.map((b) => getDocs(query(base, where('branchId', '==', b), where('patientId', '==', patientId)))),
  )
  return toOrders(snaps)
}

// Audit trail: one shared helper (layout/activity.ts).
export { logActivity } from '../../layout/activity'

// ---- Columns -----------------------------------------------------------------
export const COLUMN_KEYS = [
  'date', 'billNo', 'patient', 'uhid', 'referral', 'tests', 'amount', 'status',
  'barcode', 'createdBy', 'branch', 'b2b', 'collectionCentre', 'tat',
] as const
export type ColumnKey = (typeof COLUMN_KEYS)[number]
export const COLUMN_LABEL: Record<ColumnKey, string> = {
  date: 'Bill date',
  billNo: 'Bill no',
  patient: 'Patient info',
  uhid: 'UHID',
  referral: 'Referral',
  tests: 'Tests',
  amount: 'Amount',
  status: 'Status',
  barcode: 'Barcode',
  createdBy: 'Created by',
  branch: 'Branch',
  b2b: 'B2B / corporate',
  collectionCentre: 'Collection centre',
  tat: 'TAT',
}
export const DEFAULT_COLUMNS: ColumnKey[] = ['date', 'billNo', 'patient', 'referral', 'tests', 'amount', 'status', 'barcode']

// Expected turnaround of a bill in minutes: the slowest test on it (urgent lines take urgentPct % of it).
export function expectedTatMinutes(o: Pick<Order, 'items'>, urgentPct = 100): number {
  return Math.max(0, ...o.items.filter((i) => i.status !== 'refunded' && !i.isCharge).map((i) => Math.round(((i.tatMinutes ?? 0) * (i.urgent ? urgentPct : 100)) / 100)))
}
export function tatText(mins: number): string {
  if (mins <= 0) return ''
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`
}

// "Due by" of a bill's slowest test, counted from the bill time. overdue = past that and still not final.
export function tatDue(o: Pick<Order, 'items' | 'createdAt' | 'reportStatus'>, urgentPct = 100, now = Date.now()): { text: string; overdue: boolean } | null {
  const mins = expectedTatMinutes(o, urgentPct)
  const start = o.createdAt?.toMillis?.()
  if (!mins || !start) return null
  const due = start + mins * 60000
  const d = new Date(due)
  return { text: `${tatText(mins)} · by ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, overdue: o.reportStatus !== 'final' && now > due }
}

// Settings > Patient list > columns (their own keys) -> the list's column keys.
const SETTING_COLUMN: Record<string, ColumnKey> = {
  patient: 'patient', bill: 'billNo', date: 'date', referrer: 'referral', status: 'status',
  amount: 'amount', paid: 'amount', due: 'amount', dispatch: 'status', tat: 'tat', branch: 'branch',
}
export function columnsFromSettings(keys: string[]): ColumnKey[] {
  const set = new Set(keys.map((k) => SETTING_COLUMN[k]).filter(Boolean))
  const ordered = COLUMN_KEYS.filter((k) => set.has(k))
  return ordered.length ? [...ordered] : DEFAULT_COLUMNS
}

const lsKey = (uid: string) => `hcl.patientList.columns.${uid}`
// A user's own choice wins; otherwise `fallback` (the lab's default columns).
export function loadColumns(uid: string | undefined, fallback: ColumnKey[] = DEFAULT_COLUMNS): ColumnKey[] {
  try {
    const raw = uid ? localStorage.getItem(lsKey(uid)) : null
    const arr = raw ? (JSON.parse(raw) as string[]) : null
    const ok = arr?.filter((k): k is ColumnKey => (COLUMN_KEYS as readonly string[]).includes(k))
    if (ok && ok.length) return ok
  } catch {
    /* ignore */
  }
  return fallback
}
export function saveColumns(uid: string | undefined, cols: ColumnKey[]) {
  try {
    if (uid) localStorage.setItem(lsKey(uid), JSON.stringify(cols))
  } catch {
    /* ignore */
  }
}
