import dayjs from 'dayjs'
import type { QcMachine, QcRun, QcSettings } from '../types'

export type TestQcState = 'pass' | 'warning' | 'fail' | 'none' | 'unmapped'
export interface TestQc {
  state: TestQcState
  machineName: string
  pendingApproval?: boolean // a run exists but is waiting for QC approval
}

// A run counts for result approval when it is live and, if QC approval is enabled, approved.
export const runCounts = (r: QcRun, approvalEnabled: boolean) => !r.deleted && (!approvalEnabled || r.approval !== 'pending')

/**
 * QC state of one test today, via the machines that run it. With several machines the best one wins.
 * A machine's state is that of its latest counting run today that covers the test.
 *
 * Result entry / worklist call this (through useTodayQcStatus) to block approval:
 *   'fail' and 'none' block when lab setting qcBlocksApproval is on; 'none' also covers
 *   "only runs waiting for QC approval" (pendingApproval = true) when QC approval is enabled.
 */
export function qcStateForTest(machines: QcMachine[], runs: QcRun[], testId: string, settings: Pick<QcSettings, 'approvalEnabled'>): TestQc {
  const ms = machines.filter((m) => m.active !== false && (m.testIds ?? []).includes(testId))
  if (!ms.length) return { state: 'unmapped', machineName: '' }
  const rank = { pass: 0, warning: 1, none: 2, fail: 3 } as const
  let best: TestQc | null = null
  for (const m of ms) {
    const covering = runs.filter((r) => !r.deleted && r.machineId === m.id && r.results.some((x) => x.testId === testId))
    const counted = covering.filter((r) => runCounts(r, settings.approvalEnabled))
    const latest = counted.sort((a, b) => (b.runAt?.toMillis() ?? Date.now()) - (a.runAt?.toMillis() ?? Date.now()))[0]
    const cand: TestQc = { state: latest ? latest.status : 'none', machineName: m.name, pendingApproval: !latest && covering.length > 0 }
    if (!best || rank[cand.state as keyof typeof rank] < rank[best.state as keyof typeof rank]) best = cand
  }
  return best!
}

export const startOfToday = () => dayjs().startOf('day')
