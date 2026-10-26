import { Select, Space } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { limit, orderBy, query, Timestamp, where } from 'firebase/firestore'
import { col } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import type { Test } from '../../../types'
import { QC, type Capa, type EqasOutcome, type QcMachine, type QcMaterial, type QcRun, type QcStatus } from '../types'
import { useBranchScope } from '../../../lib/branchScope'
import { Chip } from '../ui'

export const useMachines = () => {
  const scope = useBranchScope()
  return useLiveQuery<QcMachine>(query(col(QC.machines), ...scope.constraints, orderBy('name')), [scope.key])
}
export const useMaterials = () => useLiveQuery<QcMaterial>(query(col(QC.materials), orderBy('name')), [])
export const useCapas = () => {
  const scope = useBranchScope()
  return useLiveQuery<Capa>(query(col(QC.capas), ...scope.constraints, orderBy('createdAt', 'desc')), [scope.key])
}

// Runs inside [from, to] (days), newest first.
export const useRuns = (from: Dayjs, to: Dayjs) => {
  const scope = useBranchScope()
  return useLiveQuery<QcRun>(
    query(
      col(QC.runs),
      ...scope.constraints,
      where('runAt', '>=', Timestamp.fromDate(from.startOf('day').toDate())),
      where('runAt', '<=', Timestamp.fromDate(to.endOf('day').toDate())),
      orderBy('runAt', 'desc'),
    ),
    [from.valueOf(), to.valueOf(), scope.key],
  )
}

// Most recent runs regardless of date, used as Westgard history.
export const useRecentRuns = (n = 600) => {
  const scope = useBranchScope()
  return useLiveQuery<QcRun>(query(col(QC.runs), ...scope.constraints, orderBy('runAt', 'desc'), limit(n)), [n, scope.key])
}

export const runTime = (r: QcRun): number => (r.runAt ? r.runAt.toMillis() : Date.now())

export const STATUS_COLOR: Record<QcStatus, string> = { pass: 'green', warning: 'gold', fail: 'red' }
export const STATUS_LABEL: Record<QcStatus, string> = { pass: 'Pass', warning: 'Warning', fail: 'Fail' }
export const StatusTag = ({ status }: { status: QcStatus }) => <Chip status={status} />

export const OUTCOME_COLOR: Record<EqasOutcome | 'pass' | 'fail' | 'inconclusive', string> = {
  acceptable: 'green',
  warning: 'gold',
  unacceptable: 'red',
  notEvaluated: 'default',
  pass: 'green',
  fail: 'red',
  inconclusive: 'default',
}

export const dayRange = (days: number): [Dayjs, Dayjs] => [dayjs().subtract(days, 'day').startOf('day'), dayjs().endOf('day')]
export const monthRange = (): [Dayjs, Dayjs] => [dayjs().startOf('month'), dayjs().endOf('day')]

export const tsMs = (t: { toMillis?: () => number } | null | undefined) => (t && typeof t.toMillis === 'function' ? t.toMillis() : Date.now())

// Parameters that can carry a numeric value (single or group members, not group headers).
export const numericParams = (t: Test | undefined) =>
  (t?.parameters ?? []).filter((p) => p.structure !== 'group' && p.dataType !== 'text' && p.dataType !== 'options')

export interface TestParam {
  testId?: string
  paramKey?: string
}

// Test then parameter pickers.
export function TestParamSelect({
  tests,
  value,
  onChange,
  restrictTestIds,
}: {
  tests: Test[]
  value?: TestParam
  onChange?: (v: TestParam) => void
  restrictTestIds?: string[]
}) {
  const list = restrictTestIds?.length ? tests.filter((t) => restrictTestIds.includes(t.id)) : tests
  const test = tests.find((t) => t.id === value?.testId)
  return (
    <Space wrap>
      <Select
        showSearch
        style={{ width: 240 }}
        placeholder="Test"
        optionFilterProp="label"
        value={value?.testId}
        options={list.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))}
        onChange={(testId) => onChange?.({ testId, paramKey: numericParams(tests.find((t) => t.id === testId))[0]?.key })}
      />
      <Select
        showSearch
        style={{ width: 220 }}
        placeholder="Parameter"
        optionFilterProp="label"
        value={value?.paramKey}
        options={numericParams(test).map((p) => ({ value: p.key, label: `${p.name}${p.unit ? ` (${p.unit})` : ''}` }))}
        onChange={(paramKey) => onChange?.({ testId: value?.testId, paramKey })}
      />
    </Space>
  )
}

export const paramName = (t: Test | undefined, key: string) => t?.parameters.find((p) => p.key === key)?.name ?? key
export const paramUnit = (t: Test | undefined, key: string) => t?.parameters.find((p) => p.key === key)?.unit ?? ''
export const isExpired = (expiry: string) => !!expiry && dayjs(expiry).endOf('day').isBefore(dayjs())
