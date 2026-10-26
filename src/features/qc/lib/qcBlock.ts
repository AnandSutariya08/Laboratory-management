import { useCallback } from 'react'
import dayjs from 'dayjs'
import { query, Timestamp, where } from 'firebase/firestore'
import { col } from '../../../lib/db'
import { useLabSettings } from '../../../hooks/useCatalogue'
import { useLiveQuery } from '../../../hooks/useLive'
import { useBranchScope } from '../../../lib/branchScope'
import { QC, type QcMachine, type QcRun } from '../types'
import { qcStateForTest } from './qcGate'
import { useQcSettings } from './useQcSettings'

/**
 * Hook for result entry / worklist: returns `qcBlocksApproval(testId, machineId?)`, which gives the
 * reason approval is blocked, or null when approval may go ahead.
 *
 * Blocks only when QC approval is enabled (QC settings > "Enable QC approval", off by default, as in Flabs) or the lab's own
 * qcBlocksApproval extra is on, and today's QC for the test (on the given
 * machine, or the best machine that runs it) FAILED, was NOT RUN, or is waiting for QC approval
 * (when "Enable QC approval" is on). Tests no machine is mapped to are never blocked.
 */
export function useQcApprovalBlock() {
  const lab = useLabSettings()
  const { settings } = useQcSettings()
  const scope = useBranchScope()
  const { data: machines } = useLiveQuery<QcMachine>(query(col(QC.machines), ...scope.constraints), [scope.key])
  const start = dayjs().startOf('day')
  const { data: runs } = useLiveQuery<QcRun>(query(col(QC.runs), ...scope.constraints, where('runAt', '>=', Timestamp.fromDate(start.toDate()))), [start.valueOf(), scope.key])

  return useCallback(
    (testId: string, machineId?: string): string | null => {
      if (!settings.approvalEnabled && !lab.qcBlocksApproval) return null
      const ms = machineId ? machines.filter((m) => m.id === machineId) : machines
      const q = qcStateForTest(ms, runs, testId, settings)
      if (q.state === 'fail') return `QC failed today on ${q.machineName}`
      if (q.state === 'none') return q.pendingApproval ? `QC run on ${q.machineName} is waiting for QC approval` : `QC not run today on ${q.machineName}`
      return null
    },
    [lab.qcBlocksApproval, settings, machines, runs],
  )
}
