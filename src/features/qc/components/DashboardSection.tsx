import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from "react-router-dom"
import { App, Button, DatePicker, Input, Modal, Select, Space, Table, Typography } from 'antd'
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { orderBy, query, updateDoc, serverTimestamp, Timestamp, where } from 'firebase/firestore'
import { col, docRef, paths } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import { useBranchScope } from '../../../lib/branchScope'
import { downloadCsv } from '../../../components/billing/helpers'
import { fmtDateTime } from '../../../components/results/common'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { biasPct, cv, fmt, mean, sd } from '../lib/stats'
import { QC, type Capa, type QcLevel, type QcOccurrence, type QcRun, type QcStatus, type QcMachine, type QcNotApplicable } from '../types'
import CapaModal from './CapaModal'
import { MultiLevelChart, type LjPoint } from './LeveyJennings'
import MachineSummary from './MachineSummary'
import { sigmaMetric, teaFor } from '../lib/sigma'
import { evaluateRun, type Entry } from '../lib/runEval'
import { WESTGARD_RULES } from '../types'
import { monthRange, paramName, runTime, StatusTag, useCapas, useMachines, useMaterials, useRuns } from './shared'
import { can, useAuth } from '../../../auth/AuthProvider'
import { Panel, StatTile, TileGrid, Toolbar, Chip } from '../ui'
import { Button as DsButton } from '../../../design/Button'
import { Segmented } from '../../../design/Segmented'
import { targetFor } from '../lib/runEval'
import { missedInRange, naKey, scheduleText } from '../lib/schedule'
import { OCC_LABEL, patientsDue, slotViews, useOccurrenceSync } from '../lib/occurrences'
import { useQcSettings } from '../lib/useQcSettings'
import IqcSheet from './IqcSheet'
import { CAPA_STATUS, ROOT_CAUSE_CATEGORIES } from '../lib/capaOptions'

const { Text } = Typography

interface ParamRow {
  key: string
  testId: string
  paramKey: string
  machineId: string
  machineName: string
  materialId: string
  lotNo: string
  level: QcLevel
  points: LjPoint[]
  tMean: number
  tSd: number
  n: number
  mean: number
  sd: number
  cv: number
  bias: number
  violations: number
  last: QcStatus
  ruleCounts: Record<string, number>
  tea: number | null
  sigma: number | null
}

export default function DashboardSection() {
  const { profile, user } = useAuth()
  const { message } = App.useApp()
  const { settings } = useQcSettings()
  const canCapa = can(profile, 'qc.approveCapa')
  const canApprove = can(profile, 'qc.approveCapa')
  const isAdmin = profile?.role === 'labAdmin' || profile?.role === 'admin'
  const [sheetOpen, setSheetOpen] = useState(false)
  const [deptFilter, setDeptFilter] = useState<string>()
  const [paramFilter, setParamFilter] = useState<string>()
  const [capaStatus, setCapaStatus] = useState<string>()
  const [capaCause, setCapaCause] = useState<string>()
  const [action, setAction] = useState<{ kind: 'approve' | 'reschedule' | 'delete' | 'na'; run?: QcRun; miss?: { machine: QcMachine; scheduleId: string; day: string; time: string } } | null>(null)
  const [remark, setRemark] = useState('')
  const [newTime, setNewTime] = useState<Dayjs | null>(null)
  const navigate = useNavigate()
  const [range, setRange] = useState<[Dayjs, Dayjs]>(monthRange())
  const [machineFilter, setMachineFilter] = useState<string>()
  const [statusFilter, setStatusFilter] = useState<QcStatus | 'missed'>()
  const [kitFilter, setKitFilter] = useState<string>()
  const [view, setView] = useState<'machine' | 'param' | 'capa'>('machine')
  const [machineView, setMachineView] = useState<'runs' | 'summary'>('runs')
  const { data: allRuns, loading } = useRuns(range[0], range[1])
  const { data: machines } = useMachines()
  const { data: materials } = useMaterials()
  const { data: capas } = useCapas()
  const maps = useCatalogueMaps()
  const [selected, setSelected] = useState<string>()
  const [capa, setCapa] = useState<Partial<Capa> | null>(null)

  const live = useMemo(() => allRuns.filter((r) => !r.deleted), [allRuns])
  const matchesBase = (r: QcRun) =>
    (!machineFilter || r.machineId === machineFilter) &&
    (!kitFilter || r.materialId === kitFilter) &&
    (!deptFilter || r.departmentId === deptFilter) &&
    (!paramFilter || r.results.some((x) => `${x.testId}|${x.paramKey}` === paramFilter))
  const base = live.filter(matchesBase)
  const runs = useMemo(() => (statusFilter === 'missed' ? [] : base.filter((r) => !statusFilter || r.status === statusFilter)), [base, statusFilter]) // eslint-disable-line react-hooks/exhaustive-deps
  const count = (s: QcStatus) => base.filter((r) => r.status === s).length
  // Missed QC: scheduled slots in the range whose time plus grace has passed with no run; excused slots are left out.
  const missedList = useMemo(
    () => missedInRange(machines.filter((m) => !machineFilter || m.id === machineFilter), live, range[0], range[1], settings.graceMinutes ?? 30, dayjs(), settings),
    [machines, live, range, machineFilter, settings],
  )
  const scheduled = machines.some((m) => (m.schedules ?? []).length)
  // Persisted occurrences (QC-23): the slot state machine, kept in step with runs and CAPAs.
  const scope = useBranchScope()
  const dayFrom = range[0].format('YYYY-MM-DD')
  const dayTo = range[1].format('YYYY-MM-DD')
  const occ = useLiveQuery<QcOccurrence>(scheduled ? query(col(QC.occurrences), ...scope.constraints, where('day', '>=', dayFrom), where('day', '<=', dayTo), orderBy('day', 'desc')) : null, [scheduled, scope.key, dayFrom, dayTo])
  const existing = useMemo(() => new Map(occ.data.map((o) => [o.id, o])), [occ.data])
  const views = useMemo(
    () => (scheduled ? slotViews(machines.filter((m) => !machineFilter || m.id === machineFilter), live, capas, range[0], range[1], { graceMinutes: settings.graceMinutes ?? 30, shifts: settings.shifts, matchWindowHours: settings.matchWindowHours ?? 24 }, Date.now(), existing) : []),
    [scheduled, machines, machineFilter, live, capas, range, settings, existing],
  )
  useOccurrenceSync(scheduled && can(profile, 'qc.run') && !occ.loading, views, existing, scope.branchId)
  // Per-N-patient schedules: samples run since the last QC run on the machine.
  const wantsPatients = machines.some((m) => (m.schedules ?? []).some((x) => x.active && x.recurrence === 'perNPatients'))
  const recentOrders = useLiveQuery<{ createdAt: Timestamp; items: { testIds: string[]; status: string; isCharge?: boolean }[]; deleted: boolean }>(
    wantsPatients ? query(col(paths.orders), ...scope.constraints, where('deleted', '==', false), where('createdAt', '>=', Timestamp.fromMillis(Date.now() - 14 * 86_400_000)), orderBy('createdAt', 'desc')) : null,
    [wantsPatients, scope.key],
  )
  const patientDue = useMemo(() => patientsDue(machines, live, recentOrders.data), [machines, live, recentOrders.data])
  const missed = missedList.reduce((n, m) => n + m.count, 0)
  const passRate = base.length ? `${Math.round((count('pass') / base.length) * 100)}% pass rate` : undefined
  const paramOptions = useMemo(() => {
    const k = new Set<string>()
    allRuns.forEach((r) => r.results.forEach((x) => k.add(`${x.testId}|${x.paramKey}`)))
    return [...k].map((v) => { const [t, p] = v.split('|'); return { value: v, label: `${maps.testById.get(t)?.name ?? t} / ${paramName(maps.testById.get(t), p)}` } })
  }, [allRuns, maps.testById])

  // ---- run actions: approve, reschedule, soft delete, mark a missed slot not applicable
  const hasCapa = (r: QcRun) => capas.some((c) => c.runId === r.id)
  const needsApproval = (r: QcRun) => settings.approvalEnabled && r.approval === 'pending'
  const approveBlock = (r: QcRun) => (r.status === 'fail' && !hasCapa(r) ? 'A failed run needs a CAPA before it can be approved' : null)
  const submitAction = async () => {
    if (!action) return
    const reason = remark.trim()
    try {
      if (action.kind === 'approve' && action.run) {
        await updateDoc(docRef(QC.runs, action.run.id), { approval: 'approved', approvedBy: user?.uid ?? '', approvedByName: profile?.name ?? '', approvedAt: serverTimestamp(), approveRemark: reason })
        message.success('QC run approved')
      } else if (action.kind === 'reschedule' && action.run) {
        if (!newTime || !reason) return void message.warning('Pick the new date and time and give a reason')
        if (newTime.isAfter(dayjs())) return void message.warning('The new time cannot be in the future')
        await updateDoc(docRef(QC.runs, action.run.id), { rescheduledFrom: action.run.runAt, rescheduleReason: reason, runAt: Timestamp.fromDate(newTime.toDate()), late: true, lateReason: reason })
        message.success('QC run rescheduled; the original time is kept on the record')
      } else if (action.kind === 'delete' && action.run) {
        if (!reason) return void message.warning('A reason is needed to delete a QC run')
        await updateDoc(docRef(QC.runs, action.run.id), { deleted: true, deleteReason: reason, deletedByName: profile?.name ?? '', deletedBy: user?.uid ?? '', deletedAt: serverTimestamp() })
        message.success('QC run deleted (kept for audit)')
      } else if (action.kind === 'na' && action.miss) {
        if (!reason) return void message.warning('Give a reason, such as machine down')
        const m = action.miss
        const entry: QcNotApplicable = { id: naKey(m.machine.id, m.scheduleId, m.day, m.time), machineId: m.machine.id, scheduleId: m.scheduleId, day: m.day, time: m.time, reason, by: user?.uid ?? '', byName: profile?.name ?? '', at: Date.now() }
        await updateDoc(docRef(QC.machines, m.machine.id), { notApplicable: [...(m.machine.notApplicable ?? []), entry] })
        message.success('Marked not applicable')
      }
      setAction(null)
      setRemark('')
      setNewTime(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const toggleExclude = async (r: QcRun, x: QcRun['results'][number]) => {
    let why = ''
    if (!x.excluded) {
      why = window.prompt('Reason for excluding this point from the statistics and rules?') ?? ''
      if (!why.trim()) return
    }
    const results = r.results.map((y) => (y === x ? { ...y, excluded: !x.excluded, excludeReason: x.excluded ? '' : why.trim() } : y))
    await updateDoc(docRef(QC.runs, r.id), { results }).catch((e) => message.error(e.message))
  }
  const canTouch = (r: QcRun) => r.approval !== 'approved' || isAdmin // approved runs are immutable except for admins (delete)

  // One row per machine / lot / test / parameter / level, with stats against the target.
  const paramRows: ParamRow[] = useMemo(() => {
    const groups = new Map<string, ParamRow>()
    const ordered = [...base].sort((a, b) => runTime(a) - runTime(b))
    for (const r of ordered) {
      const mat = materials.find((m) => m.id === r.materialId)
      for (const res of r.results) {
        // the target in force when the value was recorded (snapshot), else the lot's current target for this machine
        const cur = mat ? targetFor(mat, r.machineId, res.testId, res.paramKey, res.level) : undefined
        const t = res.mean != null && res.sd != null ? { mean: res.mean, sd: res.sd } : cur
        if (!t) continue
        const key = `${r.machineId}|${r.materialId}|${res.testId}|${res.paramKey}|${res.level}`
        const vs = r.violations.filter((v) => v.testId === res.testId && v.paramKey === res.paramKey && (v.level === res.level || v.level === 'all'))
        const st: QcStatus = vs.some((v) => v.severity === 'fail') ? 'fail' : vs.length ? 'warning' : 'pass'
        const g =
          groups.get(key) ??
          ({ key, testId: res.testId, paramKey: res.paramKey, machineId: r.machineId, machineName: r.machineName, materialId: r.materialId, lotNo: r.lotNo, level: res.level, points: [], tMean: t.mean, tSd: t.sd, n: 0, mean: 0, sd: 0, cv: 0, bias: 0, violations: 0, last: 'pass', ruleCounts: {}, tea: null, sigma: null } as ParamRow)
        g.points.push({ at: runTime(r), value: res.value, z: res.z, status: st, by: r.runByName, rules: [...new Set(vs.map((v) => v.rule))] })
        for (const v of vs) g.ruleCounts[v.rule] = (g.ruleCounts[v.rule] ?? 0) + 1
        g.violations += vs.length
        g.last = st
        groups.set(key, g)
      }
    }
    return [...groups.values()].map((g) => {
      const xs = g.points.map((p) => p.value)
      const bias = biasPct(mean(xs), g.tMean)
      const tea = teaFor(settings, g.testId, g.paramKey, g.level)
      return { ...g, n: xs.length, mean: mean(xs), sd: sd(xs), cv: cv(xs), bias, tea, sigma: xs.length >= 2 ? sigmaMetric(tea, bias, cv(xs)) : null }
    })
  }, [base, materials, settings])

  // Machine-fed runs arrive with only the single-point checks. Re-evaluate them once with the Westgard
  // multi-rules (across levels and runs, per-parameter overrides) so they behave like manual runs.
  const [reeval, setReeval] = useState(false)
  useEffect(() => {
    if (reeval || !can(profile, 'qc.run')) return
    const todo = live.filter((r) => r.source === 'analyser' && !r.multiruleChecked)
    if (!todo.length || !materials.length) return
    setReeval(true)
    void (async () => {
      for (const r of todo.slice(0, 20)) {
        const mat = materials.find((m) => m.id === r.materialId)
        if (!mat) continue
        const entries: Entry[] = r.results.map((x) => ({ testId: x.testId, paramKey: x.paramKey, level: x.level, value: x.value }))
        const at = runTime(r)
        const ev = evaluateRun(mat, live.filter((x) => x.id !== r.id), entries, at, { machineId: r.machineId, settings })
        try {
          await updateDoc(docRef(QC.runs, r.id), { status: ev.status, violations: ev.violations, multiruleChecked: true })
        } catch {
          /* rules may block; leave the run as received */
        }
      }
      setReeval(false)
    })()
  }, [live, materials, settings, profile]) // eslint-disable-line react-hooks/exhaustive-deps
  const capaAge = (c: Capa) => Math.max(0, dayjs(c.closedAt ? c.closedAt.toMillis() : Date.now()).diff(c.createdAt ? c.createdAt.toMillis() : Date.now(), 'day'))
  const shownCapas = capas.filter((c) => (!capaStatus || c.status === capaStatus) && (!capaCause || c.rootCauseCategory === capaCause))
  const sel = paramRows.find((r) => r.key === selected)
  // every level of the selected machine / lot / parameter, for the multi-level charts
  const levelSeries = sel
    ? paramRows.filter((r) => r.machineId === sel.machineId && r.materialId === sel.materialId && r.testId === sel.testId && r.paramKey === sel.paramKey).sort((a, b) => a.level.localeCompare(b.level)).map((r) => ({ level: r.level, mean: r.tMean, sd: r.tSd, points: r.points }))
    : []

  const exportSheet = () => {
    const rows: (string | number)[][] = [['Date', 'Machine', 'Material', 'Lot', 'Test', 'Parameter', 'Level', 'Value', 'Z-score', 'Run status', 'Run by', 'Remarks']]
    for (const r of [...runs].reverse())
      for (const res of r.results)
        rows.push([fmtDateTime(r.runAt), r.machineName, r.materialName, r.lotNo, res.testName, res.paramName, res.level, res.value, res.z, r.status, r.runByName, r.note ?? ''])
    downloadCsv(`iqc-data-sheet-${range[0].format('YYYYMMDD')}-${range[1].format('YYYYMMDD')}.csv`, rows)
  }

  const tile = (label: string, value: number, tone: 'info' | 'success' | 'urgent' | 'caution' | undefined, status?: QcStatus) => (
    <StatTile key={label} label={label} value={value} tone={value || tone === 'info' ? tone : undefined} selected={!!status && statusFilter === status} onClick={status ? () => setStatusFilter(statusFilter === status ? undefined : status) : undefined} />
  )

  return (
    <>
      <Toolbar>
        <DatePicker.RangePicker allowClear={false} value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} aria-label="Date range" />
        <Select allowClear placeholder="All machines" style={{ width: 190 }} value={machineFilter} onChange={setMachineFilter} options={machines.map((m) => ({ value: m.id, label: m.name }))} aria-label="Machine" />
        <Select allowClear placeholder="All sample kits" style={{ width: 200 }} value={kitFilter} onChange={setKitFilter} options={materials.map((m) => ({ value: m.id, label: `${m.name} (${m.lotNo})` }))} aria-label="Sample kit" />
        <Select allowClear placeholder="All departments" style={{ width: 170 }} value={deptFilter} onChange={setDeptFilter} options={maps.departments.map((d) => ({ value: d.id, label: d.name }))} aria-label="Department" />
        <Select allowClear showSearch optionFilterProp="label" placeholder="All parameters" style={{ width: 200 }} value={paramFilter} onChange={setParamFilter} options={paramOptions} aria-label="Parameter" />
        <Select allowClear placeholder="All statuses" style={{ width: 150 }} value={statusFilter} onChange={setStatusFilter} options={[{ value: 'pass', label: 'Pass' }, { value: 'warning', label: 'Warning' }, { value: 'fail', label: 'Fail' }, { value: 'missed', label: 'Missed' }]} aria-label="Status" />
        <span className="qc-toolbar__spacer" />
        <DsButton icon={<DownloadOutlined />} onClick={exportSheet}>Export runs (CSV)</DsButton>
        <DsButton onClick={() => setSheetOpen(true)}>IQC data sheet</DsButton>
        <DsButton variant="primary" icon={<PlusOutlined />} onClick={() => navigate('/qc/run')}>Run new QC</DsButton>
      </Toolbar>

      <TileGrid>
        <StatTile key="total" label="Total QC performed" value={base.length} tone="info" hint={passRate} />
        {tile('QC passed', count('pass'), 'success', 'pass')}
        {tile('QC failed', count('fail'), 'urgent', 'fail')}
        {tile('QC warning', count('warning'), 'caution', 'warning')}
        <StatTile key="missed" label="QC missed" value={missed} tone={missed ? 'urgent' : 'success'} selected={statusFilter === 'missed'} onClick={() => setStatusFilter(statusFilter === 'missed' ? undefined : 'missed')} />
      </TileGrid>
      {scheduled && missedList.length > 0 && (statusFilter === 'missed' || statusFilter === undefined) && (
        <Panel title="Missed QC" style={{ marginBottom: 'var(--s-4)' }}>
          <Table
            size="small"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            rowKey={(m) => `${m.machine.id}${m.schedule.id}${m.day}`}
            dataSource={missedList}
            columns={[
              { title: 'Day', render: (_, m) => dayjs(m.day).format('DD MMM YYYY') },
              { title: 'Machine', render: (_, m) => m.machine.name },
              { title: 'Kit', render: (_, m) => materials.find((x) => x.id === m.schedule.materialId)?.name ?? 'Any kit' },
              { title: 'Missed slots', render: (_, m) => <><Chip status="missed">Missed</Chip> {m.labels.join(', ')}</> },
              {
                title: '',
                render: (_, m) => (
                  <Space>
                    <Button size="small" onClick={() => navigate('/qc/run')}>Run late</Button>
                    <Button size="small" disabled={!canApprove} onClick={() => setAction({ kind: 'na', miss: { machine: m.machine, scheduleId: m.schedule.id, day: m.day, time: m.times[0] } })}>Not applicable</Button>
                  </Space>
                ),
              },
            ]}
          />
        </Panel>
      )}

      {patientDue.length > 0 && (
        <Panel title="Due by patient count" style={{ marginBottom: 'var(--s-4)' }}>
          <Table
            size="small"
            pagination={false}
            rowKey={(r) => `${r.machine.id}${r.schedule.id}`}
            dataSource={patientDue}
            columns={[
              { title: 'Machine', render: (_, r) => r.machine.name },
              { title: 'Rule', render: (_, r) => scheduleText(r.schedule, settings.shifts) },
              { title: 'Samples since last QC', render: (_, r) => `${r.count} of ${r.every}` },
              { title: 'Status', render: (_, r) => (r.due ? <Chip status="missed">Run QC now</Chip> : <Chip status="scheduled">Not yet due</Chip>) },
            ]}
          />
        </Panel>
      )}
      {scheduled && views.length > 0 && statusFilter === undefined && (
        <Panel title="Scheduled QC" style={{ marginBottom: 'var(--s-4)' }}>
          <Table
            size="small"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            rowKey={(v) => v.slot.id}
            dataSource={[...views].sort((a, b) => b.slot.dueAt - a.slot.dueAt)}
            columns={[
              { title: 'Day', render: (_, v) => dayjs(v.slot.day).format('DD MMM YYYY') },
              { title: 'Slot', render: (_, v) => v.slot.slotLabel },
              { title: 'Machine', render: (_, v) => v.slot.machine.name },
              { title: 'Status', render: (_, v) => <Chip status={v.status === 'passed' || v.status === 'approved' ? 'pass' : v.status === 'failed' || v.status === 'capaOpen' ? 'fail' : v.status === 'warning' ? 'warning' : v.status === 'missed' ? 'missed' : v.status === 'notApplicable' ? 'inactive' : 'scheduled'}>{OCC_LABEL[v.status]}</Chip> },
              { title: 'Run', render: (_, v) => v.run?.runNo ?? '' },
            ]}
          />
        </Panel>
      )}

      <div className="qc-subnav">
        <Segmented
          aria-label="QC dashboard views"
          value={view}
          onChange={setView}
          options={[
            { value: 'machine', label: 'Machine wise' },
            { value: 'param', label: 'Parameter wise' },
            { value: 'capa', label: 'CAPA report', count: capas.filter((c) => c.status !== 'closed').length },
          ]}
        />
      </div>
      {view === 'machine' && (
        <div className="qc-subnav">
          <Segmented aria-label="Machine wise views" size="small" value={machineView} onChange={setMachineView} options={[{ value: 'runs', label: 'Runs' }, { value: 'summary', label: 'Summary report' }]} />
        </div>
      )}
      {view === 'machine' && machineView === 'summary' && <MachineSummary machines={machines.filter((m) => !machineFilter || m.id === machineFilter)} runs={base} views={views} capas={capas} materials={materials} />}
      {view === 'machine' && machineView === 'runs' && (
              <Table<QcRun>
                size="small"
                rowKey="id"
                loading={loading}
                dataSource={runs}
                pagination={{ pageSize: 15 }}
                expandable={{
                  expandedRowRender: (r) => (
                    <Table
                      size="small"
                      pagination={false}
                      rowKey={(x) => `${x.testId}${x.paramKey}${x.level}`}
                      dataSource={r.results}
                      columns={[
                        { title: 'Test', dataIndex: 'testName' },
                        { title: 'Parameter', dataIndex: 'paramName' },
                        { title: 'Level', dataIndex: 'level' },
                        { title: 'Value', dataIndex: 'value' },
                        { title: 'Target', render: (_, x) => (x.mean != null ? `${x.mean} ± ${x.sd}${x.targetVersion && x.targetVersion > 1 ? ` (v${x.targetVersion})` : ''}` : '-') },
                        { title: 'z', render: (_, x) => fmt(x.z) },
                        {
                          title: 'Excluded',
                          render: (_, x) => (
                            <Button size="small" disabled={!canApprove || r.approval === 'approved'} onClick={() => toggleExclude(r, x)}>
                              {x.excluded ? `Include again${x.excludeReason ? ` (${x.excludeReason})` : ''}` : 'Exclude'}
                            </Button>
                          ),
                        },
                      ]}
                    />
                  ),
                }}
                columns={[
                  { title: 'Date and time', render: (_, r) => fmtDateTime(r.runAt) },
                  { title: 'Machine', render: (_, r) => <>{r.machineName} {r.source === 'analyser' && <Chip status="scheduled">Machine-fed</Chip>}</> },
                  { title: 'Department', render: (_, r) => maps.departmentById.get(r.departmentId)?.name ?? '-' },
                  { title: 'Sample kit / lot', render: (_, r) => `${r.materialName} (${r.lotNo})` },
                  { title: 'Levels', render: (_, r) => [...new Set(r.results.map((x) => x.level))].join(', ') },
                  { title: 'Status', render: (_, r) => <StatusTag status={r.status} /> },
                  { title: 'Violations', render: (_, r) => [...new Set(r.violations.map((v) => v.rule))].join(' ') || '-' },
                  { title: 'Run by', dataIndex: 'runByName' },
                  {
                    title: 'Approval',
                    render: (_, r) => (r.approval === 'approved' ? <Chip status="verified">Approved</Chip> : needsApproval(r) ? <Chip status="pending">Awaiting approval</Chip> : <Text type="secondary">-</Text>),
                  },
                  {
                    title: '',
                    render: (_, r) => (
                      <Space wrap>
                        {r.late && <Chip status="warning">Late</Chip>}
                        {needsApproval(r) && canApprove && (
                          <Button size="small" title={approveBlock(r) ?? undefined} disabled={!!approveBlock(r)} onClick={() => setAction({ kind: 'approve', run: r })}>
                            Approve
                          </Button>
                        )}
                        {r.status === 'fail' && !hasCapa(r) && (
                          <Button size="small" onClick={() => setCapa({ runId: r.id, machineId: r.machineId, machineName: r.machineName, sourceType: 'iqc', sourceId: r.id })}>
                            Raise CAPA
                          </Button>
                        )}
                        {r.approval !== 'approved' && (
                          <Button size="small" onClick={() => { setAction({ kind: 'reschedule', run: r }); setNewTime(dayjs(runTime(r))) }}>
                            Reschedule
                          </Button>
                        )}
                        {canTouch(r) && (
                          <Button size="small" danger onClick={() => setAction({ kind: 'delete', run: r })}>
                            Delete
                          </Button>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
      )}
      {view === 'param' && (
              <>
                <Table<ParamRow>
                  size="small"
                  rowKey="key"
                  dataSource={paramRows}
                  pagination={{ pageSize: 10 }}
                  onRow={(r) => ({ onClick: () => setSelected(r.key), style: { cursor: 'pointer', background: r.key === selected ? 'var(--c-primary-container)' : undefined } })}
                  columns={[
                    { title: 'Machine', dataIndex: 'machineName' },
                    { title: 'Lot', dataIndex: 'lotNo' },
                    { title: 'Test', render: (_, r) => maps.testById.get(r.testId)?.name },
                    { title: 'Parameter', render: (_, r) => paramName(maps.testById.get(r.testId), r.paramKey) },
                    { title: 'Level', dataIndex: 'level' },
                    { title: 'n', dataIndex: 'n' },
                    { title: 'Target', render: (_, r) => `${r.tMean} ± ${r.tSd}` },
                    { title: 'Mean', render: (_, r) => fmt(r.mean) },
                    { title: 'SD', render: (_, r) => fmt(r.sd) },
                    { title: 'CV %', render: (_, r) => fmt(r.cv) },
                    { title: 'Bias %', render: (_, r) => fmt(r.bias) },
                    { title: 'TEa %', render: (_, r) => (r.tea != null ? r.tea : '-') },
                    { title: 'Sigma', render: (_, r) => (r.sigma != null ? <Chip status={r.sigma >= 4 ? 'pass' : r.sigma >= 3 ? 'warning' : 'fail'}>{r.sigma.toFixed(1)}</Chip> : '-') },
                    { title: 'Violations', dataIndex: 'violations' },
                    ...WESTGARD_RULES.map((rule) => ({ title: rule, render: (_: unknown, r: ParamRow) => r.ruleCounts[rule] ?? 0 })),
                    { title: 'Last', render: (_, r) => <StatusTag status={r.last} /> },
                  ]}
                />
                <Panel size="small" style={{ marginTop: 12 }} title={sel ? `Levey-Jennings: ${paramName(maps.testById.get(sel.testId), sel.paramKey)}, ${sel.machineName}, lot ${sel.lotNo}` : 'Levey-Jennings chart'}>
                  {sel ? (
                    <Space vertical style={{ width: '100%' }} size={16}>
                      <MultiLevelChart mode="lj" title={`Levey-Jennings ${sel.lotNo}`} series={levelSeries} />
                      <div>
                        <Text strong>Z-score chart</Text>
                        <MultiLevelChart mode="z" title={`Z-score ${paramName(maps.testById.get(sel.testId), sel.paramKey)} ${sel.machineName} lot ${sel.lotNo}`} series={levelSeries} />
                      </div>
                    </Space>
                  ) : (
                    <Text type="secondary">Select a row to plot its values against mean and ±1, 2, 3 SD.</Text>
                  )}
                </Panel>
              </>
      )}
      {view === 'capa' && (
        <>
          <Toolbar>
            <Select allowClear placeholder="All statuses" style={{ width: 170 }} value={capaStatus} onChange={setCapaStatus} options={CAPA_STATUS} aria-label="CAPA status" />
            <Select allowClear placeholder="All root causes" style={{ width: 190 }} value={capaCause} onChange={setCapaCause} options={ROOT_CAUSE_CATEGORIES} aria-label="Root cause category" />
            <span className="qc-toolbar__spacer" />
            <DsButton
              icon={<DownloadOutlined />}
              onClick={() =>
                downloadCsv('capa-report.csv', [
                  ['CAPA no', 'Raised', 'Machine', 'Source', 'Root cause category', 'Cause', 'Corrective action', 'Preventive action', 'Owner', 'Due', 'Status', 'Age (days)'],
                  ...shownCapas.map((c) => [c.capaNo ?? '', fmtDateTime(c.createdAt), c.machineName, c.sourceType ?? '', c.rootCauseCategory ?? '', c.cause, c.correctiveAction, c.preventiveAction, c.owner, c.dueDate ?? '', c.status, capaAge(c)]),
                ])
              }
            >
              Export CSV
            </DsButton>
            <DsButton variant="primary" icon={<PlusOutlined />} onClick={() => setCapa({})}>
              New CAPA
            </DsButton>
          </Toolbar>
          <TileGrid>
            {CAPA_STATUS.map((st) => (
              <StatTile key={st.value} label={st.label} value={capas.filter((c) => c.status === st.value).length} tone={st.value === 'open' ? 'caution' : st.value === 'closed' ? 'success' : undefined} />
            ))}
          </TileGrid>
          <Table<Capa>
            size="small"
            rowKey="id"
            dataSource={shownCapas}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: 'CAPA no', dataIndex: 'capaNo' },
              { title: 'Raised', render: (_, c) => fmtDateTime(c.createdAt) },
              { title: 'Machine', dataIndex: 'machineName' },
              { title: 'Root cause', render: (_, c) => ROOT_CAUSE_CATEGORIES.find((x) => x.value === c.rootCauseCategory)?.label ?? c.cause },
              { title: 'Corrective action', dataIndex: 'correctiveAction' },
              { title: 'Owner', dataIndex: 'owner' },
              { title: 'Due', dataIndex: 'dueDate' },
              { title: 'Age', render: (_, c) => `${capaAge(c)} d` },
              { title: 'Status', render: (_, c) => <Chip status={c.status}>{CAPA_STATUS.find((x) => x.value === c.status)?.label ?? c.status}</Chip> },
              {
                title: '',
                render: (_, c) => (
                  <Button size="small" disabled={!canCapa} onClick={() => setCapa(c)}>
                    {c.status === 'closed' ? 'View' : 'Update'}
                  </Button>
                ),
              },
            ]}
          />
        </>
      )}
      <CapaModal open={!!capa} initial={capa} onClose={() => setCapa(null)} />
      <IqcSheet open={sheetOpen} onClose={() => setSheetOpen(false)} runs={allRuns} />
      <Modal
        open={!!action}
        title={action?.kind === 'approve' ? 'Approve QC run' : action?.kind === 'reschedule' ? 'Reschedule QC run' : action?.kind === 'delete' ? 'Delete QC run' : 'Mark slot not applicable'}
        okText={action?.kind === 'approve' ? 'Approve' : action?.kind === 'delete' ? 'Delete run' : 'Save'}
        okButtonProps={{ danger: action?.kind === 'delete' }}
        onOk={submitAction}
        onCancel={() => { setAction(null); setRemark(''); setNewTime(null) }}
        destroyOnHidden
      >
        <Space vertical style={{ width: '100%' }}>
          {action?.kind === 'reschedule' && <DatePicker showTime style={{ width: '100%' }} value={newTime} onChange={setNewTime} aria-label="New date and time" disabledDate={(d) => d.isAfter(dayjs(), 'day')} />}
          <Input.TextArea
            rows={3}
            aria-label="Reason or remark"
            placeholder={action?.kind === 'approve' ? 'Approval remark (optional)' : action?.kind === 'na' ? 'Reason, for example machine down' : 'Reason (required)'}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
          {action?.kind === 'delete' && <Text type="secondary">The run is hidden from the dashboard and left out of statistics, but stays on record.</Text>}
        </Space>
      </Modal>
    </>
  )
}
