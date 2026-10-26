import { useEffect, useRef, useState } from 'react'
import { App, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Switch, Table } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { query, updateDoc } from 'firebase/firestore'
import { col, docRef, paths } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import type { UserProfile } from '../../../types'
import { can, useAuth } from '../../../auth/AuthProvider'
import { Button } from '../../../design/Button'
import { Chip, Panel } from '../ui'
import { DEFAULT_QC_SETTINGS, QC, QC_LEVELS, WESTGARD_RULES, type QcFrequency, type QcMachine, type QcSchedule, type QcSettings, type QcShift } from '../types'
import { DEFAULT_SHIFTS, shiftsOf } from '../lib/occurrences'
import { saveQcSettings, useQcSettings } from '../lib/useQcSettings'
import { nextOccurrences, scheduleText, WEEKDAYS } from '../lib/schedule'
import { paramName, TestParamSelect, useMachines, useMaterials, type TestParam } from './shared'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { DEFAULT_SEVERITY } from '../lib/westgard'
import QcStandards from './QcStandards'
import { dialogWidth } from '../../../design/dialog'

const TOGGLES: [keyof QcSettings, string, string][] = [
  ['showMeasurementUncertainty', 'Show measurement uncertainty', 'Adds the uncertainty to QC results and reports.'],
  ['approvalEnabled', 'Enable QC approval', 'A second user approves a QC run before it counts.'],
  ['outlierNature', 'Nature of QC outlier', 'Ask whether an out-of-range value is random or systematic.'],
  ['investigationChecklist', 'Investigation checklist', 'Step through the standard checks after a failed run.'],
  ['remedialAction', 'Remedial action', 'Record what was done to fix the problem.'],
  ['patientResultManagement', 'Patient result management', 'Review patient results run since the last good QC.'],
  ['rootCauseAnalysis', 'Root cause analysis (RCA)', 'Capture the cause on a failed run.'],
  ['capa', 'Corrective and preventive action (CAPA)', 'Prompt for CAPA when a run fails.'],
  ['followUp', 'Follow-up steps', 'Schedule a re-check after corrective action.'],
]

export function QcSettingsTab() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const { settings, loading } = useQcSettings()
  const [draft, setDraft] = useState<QcSettings>(DEFAULT_QC_SETTINGS)
  const [saving, setSaving] = useState(false)
  const editable = can(profile, 'qc.setup')
  useEffect(() => setDraft(settings), [JSON.stringify(settings)]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof QcSettings>(k: K, v: QcSettings[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const save = async () => {
    setSaving(true)
    try {
      await saveQcSettings(draft)
      message.success('QC settings saved')
    } catch {
      message.error('Only a lab admin can save lab-wide QC settings.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="qc-stack">
      <Panel title="Control levels and rules" extra={<Button variant="primary" disabled={!editable || loading || saving} onClick={save}>Save settings</Button>}>
        <div className="field-row">
          <label>Control levels per run</label>
          <Radio.Group value={draft.levelCount} onChange={(e) => set('levelCount', e.target.value)} options={[{ value: 2, label: '2 levels' }, { value: 3, label: '3 levels' }]} />
        </div>
        <div className="field-row">
          <label>Westgard rules applied by default</label>
          <Checkbox.Group value={draft.rules} onChange={(v) => set('rules', v as QcSettings['rules'])} options={WESTGARD_RULES.map((r) => ({ value: r, label: r }))} />
        </div>
        <div className="field-row">
          <label>Rule severity (what each rule does when it fires)</label>
          <Space wrap>
            {WESTGARD_RULES.map((r) => (
              <Space key={r} size={4}>
                <span>{r}</span>
                <Select
                  size="small"
                  style={{ width: 110 }}
                  aria-label={`Severity of ${r}`}
                  value={draft.ruleSeverity?.[r] ?? DEFAULT_SEVERITY[r]}
                  onChange={(v) => set('ruleSeverity', { ...(draft.ruleSeverity ?? {}), [r]: v })}
                  options={[{ value: 'warning', label: 'Warning' }, { value: 'fail', label: 'Reject' }]}
                />
              </Space>
            ))}
          </Space>
        </div>
        <div className="field-row">
          <label htmlFor="qc-grace">Missed-QC grace period (minutes)</label>
          <InputNumber id="qc-grace" min={0} max={720} value={draft.graceMinutes ?? 30} onChange={(v) => set('graceMinutes', v ?? 30)} />
        </div>
        <div className="field-row">
          <label htmlFor="qc-window">Machine-reading match window (hours)</label>
          <InputNumber id="qc-window" min={1} max={168} value={draft.matchWindowHours} onChange={(v) => set('matchWindowHours', v ?? 24)} />
          <small className="qc-muted">A QC run within this many hours of a timed slot counts as that slot's run (and, for EQAS, is how far from a reading a machine value may sit).</small>
        </div>
        <ShiftsEditor shifts={shiftsOf(draft)} onChange={(v) => set('shifts', v)} />
      </Panel>
      <QcStandards draft={draft} set={set} />
      <IlcAcceptance draft={draft} set={set} />
      <Panel title="QC workflow">
        <ul className="howto">
          {TOGGLES.map(([k, label, hint]) => (
            <li key={k} style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>
                <strong>{label}</strong>
                <br />
                <small className="qc-muted">{hint}</small>
              </span>
              <Switch aria-label={label} checked={draft[k] as boolean} onChange={(v) => set(k, v as never)} />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}

// Lab shifts used by "once per shift" QC schedules. `end` before `start` crosses midnight.
function ShiftsEditor({ shifts, onChange }: { shifts: QcShift[]; onChange: (v: QcShift[]) => void }) {
  const upd = (i: number, patch: Partial<QcShift>) => onChange(shifts.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  return (
    <div className="field-row">
      <label>Shifts (for "once per shift" schedules)</label>
      <Space vertical size={6}>
        {shifts.map((sh, i) => (
          <Space key={sh.id} wrap>
            <Input aria-label="Shift name" style={{ width: 150 }} value={sh.name} onChange={(e) => upd(i, { name: e.target.value })} />
            <Input aria-label={`${sh.name} start`} type="time" style={{ width: 120 }} value={sh.start} onChange={(e) => upd(i, { start: e.target.value })} />
            <span>to</span>
            <Input aria-label={`${sh.name} end`} type="time" style={{ width: 120 }} value={sh.end} onChange={(e) => upd(i, { end: e.target.value })} />
            <Button aria-label={`Remove shift ${sh.name}`} icon={<DeleteOutlined />} onClick={() => onChange(shifts.filter((_, j) => j !== i))} />
          </Space>
        ))}
        <Space>
          <Button icon={<PlusOutlined />} onClick={() => onChange([...shifts, { id: newShiftId(), name: `Shift ${shifts.length + 1}`, start: '09:00', end: '17:00' }])}>Add shift</Button>
          <Button onClick={() => onChange(DEFAULT_SHIFTS)}>Reset to morning / evening / night</Button>
        </Space>
      </Space>
    </div>
  )
}
const newShiftId = () => `s${Math.random().toString(36).slice(2, 7)}`

// ILC acceptance limits: a lab-level master per test parameter (percent difference), with a default.
function IlcAcceptance({ draft, set }: { draft: QcSettings; set: <K extends keyof QcSettings>(k: K, v: QcSettings[K]) => void }) {
  const maps = useCatalogueMaps()
  const [tp, setTp] = useState<TestParam>({})
  const map = draft.ilcAcceptance ?? {}
  const add = () => {
    if (!tp.testId || !tp.paramKey) return
    set('ilcAcceptance', { ...map, [`${tp.testId}|${tp.paramKey}`]: map[`${tp.testId}|${tp.paramKey}`] ?? draft.ilcDefaultLimitPct ?? 10 })
  }
  return (
    <Panel title="ILC acceptance limits">
      <div className="field-row">
        <label htmlFor="ilc-default">Default limit (% difference)</label>
        <InputNumber id="ilc-default" min={0} value={draft.ilcDefaultLimitPct ?? 10} onChange={(v) => set('ilcDefaultLimitPct', v ?? 10)} />
      </div>
      <Space wrap style={{ marginBottom: 8 }}>
        <TestParamSelect tests={maps.tests} value={tp} onChange={setTp} />
        <Button onClick={add} disabled={!tp.testId || !tp.paramKey}>Add parameter limit</Button>
      </Space>
      <Table
        size="small"
        pagination={false}
        rowKey="k"
        locale={{ emptyText: 'No parameter-specific limits; the default applies.' }}
        dataSource={Object.entries(map).map(([k, v]) => ({ k, v }))}
        columns={[
          { title: 'Test / parameter', render: (_, r) => { const [t, p] = r.k.split('|'); return `${maps.testById.get(t)?.name ?? t} / ${paramName(maps.testById.get(t), p)}` } },
          { title: 'Limit %', render: (_, r) => <InputNumber min={0} value={r.v} onChange={(v) => set('ilcAcceptance', { ...map, [r.k]: v ?? 0 })} /> },
          { title: '', render: (_, r) => <Button aria-label="Remove limit" icon={<DeleteOutlined />} onClick={() => { const n = { ...map }; delete n[r.k]; set('ilcAcceptance', n) }} /> },
        ]}
      />
    </Panel>
  )
}

// ---------------------------------------------------------------- schedules

const newId = () => Math.random().toString(36).slice(2, 9)

export function SchedulesTab() {
  const { message } = App.useApp()
  const { data: machines, loading } = useMachines()
  const { data: materials } = useMaterials()
  const [machineId, setMachineId] = useState<string>()
  const [editing, setEditing] = useState<QcSchedule | null>(null)
  const [form] = Form.useForm()
  const freq = Form.useWatch('frequency', form) as QcFrequency | undefined
  const days = Form.useWatch('days', form) as number[] | undefined
  const times = Form.useWatch('times', form) as string[] | undefined
  const recurrence = (Form.useWatch('recurrence', form) as QcSchedule['recurrence']) ?? 'time'
  const shiftIds = Form.useWatch('shiftIds', form) as string[] | undefined
  const { settings: qcSettings } = useQcSettings()
  const users = useLiveQuery<UserProfile>(query(col(paths.users)), [])
  const preview = freq && (recurrence === 'perShift' || times?.length) && recurrence !== 'perNPatients' ? nextOccurrences({ id: '', materialId: '', frequency: freq, days: days ?? [], times: (times ?? []).map((t) => dayjs(t.trim(), 'H:mm').format('HH:mm')), level: 'all', active: true, recurrence, shiftIds }, 5, dayjs(), qcSettings) : []
  const rows = machines.flatMap((m) => (m.schedules ?? []).map((s) => ({ m, s })))
  const target = useRef<QcMachine | null>(null)

  const persist = async (m: QcMachine, schedules: QcSchedule[]) => {
    try {
      await updateDoc(docRef(QC.machines, m.id), { schedules })
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const open = (m: QcMachine | undefined, s?: QcSchedule) => {
    target.current = m ?? machines.find((x) => x.id === machineId) ?? null
    setEditing(s ?? { id: '', materialId: '', frequency: 'daily', days: [], times: ['09:00'], level: 'all', active: true })
    form.resetFields()
    form.setFieldsValue({ machineId: m?.id ?? machineId, recurrence: 'time', ...(s ?? { materialId: '', frequency: 'daily', days: [], level: 'all', active: true }), times: s?.times ?? ['09:00'] })
  }
  const save = async () => {
    const v = await form.validateFields()
    const m = machines.find((x) => x.id === v.machineId)
    if (!m) return
    const s: QcSchedule = {
      id: editing?.id || newId(),
      materialId: v.materialId ?? '',
      frequency: v.frequency,
      days: v.frequency === 'daily' ? [] : (v.days ?? []),
      times: v.recurrence && v.recurrence !== 'time' ? [] : [...new Set(((v.times ?? []) as string[]).map((t) => dayjs(t.trim(), 'H:mm').format('HH:mm')).filter((t) => t !== 'Invalid Date'))].sort(),
      recurrence: v.recurrence ?? 'time',
      ...(v.recurrence === 'perShift' ? { shiftIds: v.shiftIds ?? [] } : {}),
      ...(v.recurrence === 'perNPatients' ? { everyNPatients: Number(v.everyNPatients) } : {}),
      ...(v.assignedTo ? { assignedTo: v.assignedTo } : {}),
      level: v.level,
      active: !!v.active,
      ...(v.graceMinutes != null ? { graceMinutes: Number(v.graceMinutes) } : {}),
    }
    if (s.frequency !== 'daily' && !s.days.length) return void message.warning('Pick at least one day')
    if (s.recurrence === 'perNPatients' && !(s.everyNPatients && s.everyNPatients > 0)) return void message.warning('Enter after how many patients a run is due')
    if (s.recurrence === 'time' && !s.times.length) return void message.warning('Add at least one time')
    const rest = (m.schedules ?? []).filter((x) => x.id !== s.id)
    await persist(m, [...rest, s])
    setEditing(null)
  }

  return (
    <>
      <div className="qc-toolbar">
        <span className="qc-muted">Missed QC on the dashboard is worked out from these schedules.</span>
        <span className="qc-toolbar__spacer" />
        <Select style={{ width: 220 }} allowClear placeholder="Machine" value={machineId} onChange={setMachineId} options={machines.map((m) => ({ value: m.id, label: m.name }))} aria-label="Machine for new schedule" />
        <Button variant="primary" icon={<PlusOutlined />} onClick={() => open(undefined)} disabled={!machineId}>Add new schedule</Button>
      </div>
      <Table
        size="small"
        rowKey={(r) => `${r.m.id}${r.s.id}`}
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: 'No QC schedules yet. Choose a machine and add one.' }}
        columns={[
          { title: 'Machine', render: (_, r) => r.m.name },
          { title: 'Sample kit', render: (_, r) => materials.find((x) => x.id === r.s.materialId)?.name ?? 'Any kit' },
          { title: 'Frequency', render: (_, r) => scheduleText(r.s, qcSettings.shifts) },
          { title: 'Control level', render: (_, r) => (r.s.level === 'all' ? 'All levels' : r.s.level) },
          { title: 'Active', render: (_, r) => <Chip status={r.s.active ? 'active' : 'inactive'} /> },
          {
            title: '',
            render: (_, r) => (
              <Space>
                <Button aria-label="Edit schedule" icon={<EditOutlined />} onClick={() => open(r.m, r.s)} />
                <Popconfirm title="Delete this schedule?" onConfirm={() => persist(r.m, (r.m.schedules ?? []).filter((x) => x.id !== r.s.id))}>
                  <Button aria-label="Delete schedule" icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing?.id ? 'Edit schedule' : 'Add new schedule'} open={!!editing} onOk={save} onCancel={() => setEditing(null)} destroyOnHidden width={dialogWidth(520)}>
        <Form form={form} layout="vertical">
          <Form.Item name="machineId" label="Machine" rules={[{ required: true }]}>
            <Select options={machines.map((m) => ({ value: m.id, label: m.name }))} disabled={!!editing?.id} />
          </Form.Item>
          <Form.Item name="materialId" label="Sample kit">
            <Select allowClear options={materials.map((m) => ({ value: m.id, label: `${m.name} (${m.lotNo})` }))} placeholder="Any kit" />
          </Form.Item>
          <Form.Item name="frequency" label="Frequency" rules={[{ required: true }]}>
            <Radio.Group options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />
          </Form.Item>
          {freq === 'weekly' && (
            <Form.Item name="days" label="Days of the week">
              <Checkbox.Group options={WEEKDAYS.map((d, i) => ({ value: i, label: d }))} />
            </Form.Item>
          )}
          {freq === 'monthly' && (
            <Form.Item name="days" label="Days of the month">
              <Select mode="multiple" options={Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} />
            </Form.Item>
          )}
          <Form.Item name="recurrence" label="Runs">
            <Radio.Group options={[{ value: 'time', label: 'At set times' }, { value: 'perShift', label: 'Once per shift' }, { value: 'perNPatients', label: 'Every N patients' }]} />
          </Form.Item>
          {recurrence === 'time' && (
            <Form.Item name="times" label="Time(s)" rules={[{ required: true }]}>
              <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="Type a time such as 09:00 and press Enter" open={false} />
            </Form.Item>
          )}
          {recurrence === 'perShift' && (
            <Form.Item name="shiftIds" label="Shifts that need a run" extra="Empty means every shift. Shifts are defined under QC settings.">
              <Select mode="multiple" allowClear options={shiftsOf(qcSettings).map((x) => ({ value: x.id, label: `${x.name} (${x.start}-${x.end})` }))} />
            </Form.Item>
          )}
          {recurrence === 'perNPatients' && (
            <Form.Item name="everyNPatients" label="Run QC after every N patients on this machine" rules={[{ required: true }]}>
              <InputNumber min={1} max={10000} />
            </Form.Item>
          )}
          <Form.Item name="assignedTo" label="Assigned to (optional)">
            <Select allowClear showSearch optionFilterProp="label" options={users.data.filter((u) => u.active && !u.deleted).map((u) => ({ value: u.uid, label: u.name }))} />
          </Form.Item>
          <Form.Item name="level" label="Control level">
            <Select options={[{ value: 'all', label: 'All levels' }, ...QC_LEVELS.map((l) => ({ value: l, label: l }))]} />
          </Form.Item>
          <Form.Item name="graceMinutes" label="Grace period (minutes before a slot counts as missed)">
            <InputNumber min={0} max={720} placeholder="Lab default" />
          </Form.Item>
          <Form.Item name="active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
          {preview.length > 0 && <div className="qc-muted">Next runs: {preview.join(' | ')}</div>}
        </Form>
      </Modal>
    </>
  )
}
