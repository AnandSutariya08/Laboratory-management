import { useSyncExternalStore } from 'react'
import { onSnapshot } from 'firebase/firestore'
import { col, paths } from '../../lib/db'
import type { OutsourceEntry, TestExt } from '../../pages/catalogue/ext'

// Outsourcing data lives on the test doc (`outsourceLabs`) plus the shared
// `processingLabs` master. This module keeps one live cache of both so billing,
// the patient list and finance can call getOutsourceLab(testId) synchronously.

export interface OutsourceLab {
  testId: string
  labId: string
  labName: string
  cost: number // paise, what we pay the lab
  tatMinutes: number | null
  isDefault: boolean
}

export interface ProcessingLabLite {
  id: string
  name: string
  active?: boolean
}

interface State {
  tests: Map<string, TestExt>
  labs: Map<string, ProcessingLabLite>
}

let state: State = { tests: new Map(), labs: new Map() }
let version = 0
let started = false
const listeners = new Set<() => void>()

function emit() {
  version++
  state = { ...state }
  listeners.forEach((l) => l())
}

function start() {
  if (started) return
  started = true
  onSnapshot(col<TestExt>(paths.tests), (snap) => {
    state.tests = new Map(snap.docs.map((d) => [d.id, { ...d.data(), id: d.id } as TestExt]))
    emit()
  })
  onSnapshot(col<ProcessingLabLite>('processingLabs'), (snap) => {
    state.labs = new Map(snap.docs.map((d) => [d.id, { ...d.data(), id: d.id } as ProcessingLabLite]))
    emit()
  })
}

// Default lab first, else the cheapest active lab, else the first mapped one.
export function pickOutsource(entries: OutsourceEntry[] | undefined, labs: Map<string, ProcessingLabLite>) {
  const usable = (entries ?? []).filter((e) => labs.get(e.labId)?.active !== false && !(labs.get(e.labId) as { deleted?: boolean } | undefined)?.deleted && labs.has(e.labId))
  if (!usable.length) return null
  return usable.find((e) => e.isDefault) ?? [...usable].sort((a, b) => a.cost - b.cost)[0]
}

export function getOutsourceLab(testId: string): OutsourceLab | null {
  start()
  const t = state.tests.get(testId)
  const e = pickOutsource(t?.outsourceLabs, state.labs)
  if (!e) return null
  return { testId, labId: e.labId, labName: state.labs.get(e.labId)?.name ?? '', cost: e.cost, tatMinutes: e.tatMinutes, isDefault: e.isDefault }
}

// Billing-only tests (consultation, visit fee): no sample, no stock, no result.
export function isBillingOnly(testId: string): boolean {
  start()
  return state.tests.get(testId)?.onlyBilling === true
}
export const isOutsourced = (testId: string) => getOutsourceLab(testId) !== null

// ---- Per-bill lab choice + price snapshot ----------------------------------------

// Every active lab a test is mapped to (default first, then cheapest), for the billing selector.
export function outsourceOptions(testId: string): OutsourceLab[] {
  start()
  const t = state.tests.get(testId)
  const usable = (t?.outsourceLabs ?? []).filter((e) => state.labs.has(e.labId) && state.labs.get(e.labId)?.active !== false)
  return usable
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.cost - b.cost)
    .map((e) => ({ testId, labId: e.labId, labName: state.labs.get(e.labId)?.name ?? '', cost: e.cost, tatMinutes: e.tatMinutes, isDefault: e.isDefault }))
}

// What a bill line stores (OrderItem.outsource) so later catalogue edits do not rewrite old bills.
export interface OutsourceStamp {
  testId: string
  labId: string
  labName: string
  cost: number // paise we pay the lab, at billing time
  tatMinutes: number | null
}

// Snapshot for the tests on a line. `choice` maps testId -> labId picked at billing; tests
// with no choice (or an unknown lab) get the default lab. Tests that are not outsourced are omitted.
// Billing: item.outsource = outsourceSnapshot(item.testIds, choiceByTestId) (omit when empty).
export function outsourceSnapshot(testIds: string[], choice: Record<string, string> = {}): OutsourceStamp[] {
  const out: OutsourceStamp[] = []
  for (const testId of testIds) {
    const opts = outsourceOptions(testId)
    if (!opts.length) continue
    const pick = opts.find((o) => o.labId === choice[testId]) ?? getOutsourceLab(testId) ?? opts[0]
    out.push({ testId, labId: pick.labId, labName: pick.labName, cost: pick.cost, tatMinutes: pick.tatMinutes })
  }
  return out
}

// Readers (patient list Outsource tab, finance Outsource wise): the bill's stamp wins over the live catalogue.
export function outsourceForLine(item: { outsource?: OutsourceStamp[] }, testId: string): OutsourceLab | null {
  const st = item.outsource?.find((o) => o.testId === testId)
  if (st) return { testId, labId: st.labId, labName: st.labName, cost: st.cost, tatMinutes: st.tatMinutes, isDefault: false }
  return getOutsourceLab(testId)
}

function subscribe(cb: () => void) {
  start()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// Re-renders when tests or labs change; returns the same function as getOutsourceLab.
export function useOutsourceLookup(): (testId: string) => OutsourceLab | null {
  useSyncExternalStore(subscribe, () => version)
  return getOutsourceLab
}

export function useOutsourceData() {
  useSyncExternalStore(subscribe, () => version)
  return state
}
