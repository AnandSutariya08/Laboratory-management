import { useCallback } from 'react'
import dayjs from 'dayjs'
import { query, Timestamp, where } from 'firebase/firestore'
import { col } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import { QC, type QcMachine, type QcRun } from '../types'
import { useBranchScope } from '../../../lib/branchScope'
import { useQcSettings } from './useQcSettings'
import { qcStateForTest, type TestQc } from './qcGate'

export type { TestQc, TestQcState } from './qcGate'

// Today's QC status per test (see qcStateForTest). Honours "Enable QC approval".
export function useTodayQcStatus() {
  const scope = useBranchScope()
  const { settings } = useQcSettings()
  const { data: machines } = useLiveQuery<QcMachine>(query(col(QC.machines), ...scope.constraints), [scope.key])
  const start = dayjs().startOf('day')
  const { data: runs } = useLiveQuery<QcRun>(query(col(QC.runs), ...scope.constraints, where('runAt', '>=', Timestamp.fromDate(start.toDate()))), [start.valueOf(), scope.key])
  return useCallback((testId: string): TestQc => qcStateForTest(machines, runs, testId, settings), [machines, runs, settings])
}
