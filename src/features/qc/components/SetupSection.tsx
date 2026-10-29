import { useMemo, useRef, useState } from 'react'
import { App, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { addDoc, arrayUnion, deleteDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { col, docRef } from '../../../lib/db'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { DEFAULT_RULES, DEFAULT_SEVERITY } from '../lib/westgard'
import { QC, QC_LEVELS, WESTGARD_RULES, type QcLevel, type QcMachine, type QcMaterial, type QcTarget, type WestgardRule } from '../types'
import { lotStatus, LOT_LABEL, overlapping, SOURCE_LABEL } from '../lib/lot'
import { mean as meanOf, sd as sdOf } from '../lib/stats'
import type { LotLifecycle, TargetSource } from '../types'
import { isExpired, numericParams, paramName, useMachines, useMaterials, useRecentRuns } from './shared'
import { useQcSettings } from '../lib/useQcSettings'
import { stripUndefined } from '../lib/clean'
import { useAuth } from '../../../auth/AuthProvider'
import { branchStamp } from '../../../lib/activeBranch'
import { Segmented } from '../../../design/Segmented'
import { Button as DsButton } from '../../../design/Button'
import { Chip } from '../ui'
import { ConnectAnalyserButton, ConnectorStatus } from './ConnectAnalyser'
import { QcSettingsTab, SchedulesTab } from './SetupExtras'
import { downloadCsv } from '../../../components/billing/helpers'
import { dialogWidth } from '../../../design/dialog'
import { FieldGrid, FormSection, SettingRow } from '../../../design/FormLayout'

const { Text } = Typography

type SetupTab = 'settings' | 'machines' | 'materials' | 'schedules'

export default function SetupSection() {
  const [tab, setTab] = useState<SetupTab>('settings')
  return (
    <>
      <div className="qc-subnav">
        <Segmented
          aria-label="QC setup sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'settings', label: 'QC setting' },
            { value: 'machines', label: 'Machines' },
            { value: 'materials', label: 'Machine mapping and kits' },
            { value: 'schedules', label: 'QC scheduling' },
          ]}
        />
      </div>
      {tab === 'settings' && <QcSettingsTab />}
      {tab === 'machines' && <Machines />}
      {tab === 'materials' && <Materials />}
      {tab === 'schedules' && <SchedulesTab />}
    </>
  )
}

// ---------------------------------------------------------------- machines

function Machines() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const { data: machines, loading } = useMachines()
  const maps = useCatalogueMaps()
  const [editing, setEditing] = useState<Partial<QcMachine> | null>(null)
  const [form] = Form.useForm<QcMachine>()
  const fileRef = useRef<HTMLInputElement>(null)

  const downloadMapping = () =>
    downloadCsv('qc-machine-mapping.csv', [
      ['Machine', 'Test code'],
      ...machines.flatMap((m) => (m.testIds ?? []).map((id) => [m.name, maps.testById.get(id)?.code ?? id])),
    ])
  const uploadMapping = async (file: File) => {
    const lines = (await file.text()).split(/\r?\n/).slice(1).filter(Boolean)
    const byMachine = new Map<string, Set<string>>()
    for (const line of lines) {
      const [mn, code] = line.split(',').map((x) => x.replace(/^"|"$/g, '').trim())
      const t = maps.tests.find((x) => x.code.toLowerCase() === (code ?? '').toLowerCase())
      if (!mn || !t) continue
      byMachine.set(mn.toLowerCase(), (byMachine.get(mn.toLowerCase()) ?? new Set()).add(t.id))
    }
    let n = 0
    for (const m of machines) {
      const ids = byMachine.get(m.name.toLowerCase())
      if (!ids) continue
      await updateDoc(docRef(QC.machines, m.id), { testIds: [...ids] }).catch((e) => message.error(e.message))
      n++
    }
    message.success(`Mapping updated for ${n} machine(s)`)
  }

  const open = (m: Partial<QcMachine>) => {
    setEditing(m)
    form.resetFields()
    form.setFieldsValue({ active: true, testIds: [], ...m })
  }
  const save = async () => {
    const v = await form.validateFields()
    const data = { name: v.name.trim(), departmentId: v.departmentId ?? '', serial: (v.serial ?? '').trim(), machineCode: (v.machineCode ?? '').trim(), model: (v.model ?? '').trim(), testIds: v.testIds ?? [], active: v.active }
    try {
      if (editing?.id) await updateDoc(docRef(QC.machines, editing.id), data)
      else await addDoc(col(QC.machines), { ...data, ...branchStamp(), createdAt: serverTimestamp() })
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <div className="qc-toolbar">
        <span className="qc-muted">Map each machine to the tests it runs. Download the mapping, edit it in a spreadsheet and upload it back.</span>
        <span className="qc-toolbar__spacer" />
        <DsButton onClick={downloadMapping}>Download mapping (CSV)</DsButton>
        <DsButton onClick={() => fileRef.current?.click()}>Upload mapping</DsButton>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden aria-label="Upload mapping CSV" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadMapping(f) }} />
        <DsButton variant="primary" icon={<PlusOutlined />} onClick={() => open({})}>Add machine</DsButton>
      </div>
      <Table<QcMachine>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={machines}
        pagination={false}
        columns={[
          { title: 'Machine', dataIndex: 'name' },
          { title: 'Department', render: (_, m) => maps.departmentById.get(m.departmentId)?.name ?? '-' },
          { title: 'Machine ID', dataIndex: 'machineCode' },
          { title: 'Model', dataIndex: 'model' },
          { title: 'Serial no', dataIndex: 'serial' },
          {
            title: 'Tests run',
            render: (_, m) => (
              <Space size={[0, 4]} wrap>
                {(m.testIds ?? []).slice(0, 6).map((id) => (
                  <Chip key={id} status="neutral">{maps.testById.get(id)?.code ?? id}</Chip>
                ))}
                {(m.testIds ?? []).length > 6 && <Text type="secondary">+{m.testIds.length - 6} more</Text>}
              </Space>
            ),
          },
          { title: 'Active', width: 80, render: (_, m) => <Chip status={m.active ? 'active' : 'inactive'} /> },
          { title: 'Connection', width: 170, render: (_, m) => <ConnectorStatus machine={m} /> },
          {
            title: '',
            width: 220,
            render: (_, m) => (
              <Space>
                <ConnectAnalyserButton machine={m} who={profile?.name ?? ''} />
                <Button size="small" icon={<EditOutlined />} aria-label={`Edit ${m.name}`} onClick={() => open(m)} />
                {(m.testIds ?? []).length > 0 ? (
                  <Button size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${m.name}`}
                    onClick={() => message.warning('Remove the mapped tests from this machine before deleting it.')} />
                ) : (
                  <Popconfirm title="Delete this machine?" onConfirm={() => deleteDoc(docRef(QC.machines, m.id)).catch((e) => message.error(e.message))}>
                    <Button size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${m.name}`} />
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing?.id ? 'Edit machine' : 'Add machine'} open={!!editing} onOk={save} onCancel={() => setEditing(null)} destroyOnHidden width={dialogWidth(680)}>
        <Form form={form} layout="vertical">
          <FormSection title="Machine details">
            <FieldGrid min={220}>
              <Form.Item name="name" label="Machine name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="departmentId" label="Department">
                <Select allowClear options={maps.departments.map((d) => ({ value: d.id, label: d.name }))} />
              </Form.Item>
              <Form.Item name="model" label="Model">
                <Input />
              </Form.Item>
              <Form.Item name="serial" label="Serial number">
                <Input />
              </Form.Item>
              <Form.Item name="machineCode" label="Machine ID">
                <Input />
              </Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Tests and status">
            <Form.Item name="testIds" label="Tests this machine runs" extra="Used to link QC status to result approval.">
              <Select mode="multiple" optionFilterProp="label" options={maps.tests.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))} />
            </Form.Item>
            <SettingRow label="Active" help="Inactive machines are hidden from QC entry.">
              <Form.Item name="active" valuePropName="checked" noStyle>
                <Switch aria-label="Active" />
              </Form.Item>
            </SettingRow>
          </FormSection>
        </Form>
      </Modal>
    </>
  )
}

// ---------------------------------------------------------------- materials

interface TargetRow {
  machineId: string // '' = every machine
  testId: string
  paramKey: string
  byLevel: Partial<Record<QcLevel, { mean: number | null; sd: number | null }>>
}

const toRows = (targets: QcTarget[]): TargetRow[] => {
  const map = new Map<string, TargetRow>()
  for (const t of targets) {
    const k = `${t.machineId ?? ''}|${t.testId}|${t.paramKey}`
    const r = map.get(k) ?? { machineId: t.machineId ?? '', testId: t.testId, paramKey: t.paramKey, byLevel: {} }
    r.byLevel[t.level] = { mean: t.mean, sd: t.sd }
    map.set(k, r)
  }
  return [...map.values()]
}

function Materials() {
  const { message } = App.useApp()
  const { data: materials, loading } = useMaterials()
  const maps = useCatalogueMaps()
  const { data: machines } = useMachines()
  const { data: recentRuns } = useRecentRuns()
  const { settings } = useQcSettings()
  const { profile } = useAuth()
  const [addMachine, setAddMachine] = useState('')
  const [reset, setReset] = useState<QcMaterial | null>(null)
  const [resetReason, setResetReason] = useState('')
  const [resetMachine, setResetMachine] = useState('')
  const machineList = machines
  const [editing, setEditing] = useState<Partial<QcMaterial> | null>(null)
  const [rows, setRows] = useState<TargetRow[]>([])
  const [form] = Form.useForm()
  const levels: QcLevel[] = Form.useWatch('levels', form) ?? ['L1', 'L2']

  const open = (m: Partial<QcMaterial>) => {
    setEditing(m)
    setRows(toRows(m.targets ?? []))
    form.resetFields()
    form.setFieldsValue({
      targetSource: 'manufacturer',
      levels: settings.levelCount === 3 ? ['L1', 'L2', 'L3'] : ['L1', 'L2'],
      rules: settings.rules?.length ? settings.rules : DEFAULT_RULES,
      ...m,
      expiry: m.expiry ? dayjs(m.expiry) : null,
      startDate: m.startDate ? dayjs(m.startDate) : null,
      openedDate: m.openedDate ? dayjs(m.openedDate) : null,
      lifecycle: m.lifecycle ?? (m.id ? lotStatus(m) === 'planned' ? 'planned' : lotStatus(m) === 'retired' ? 'retired' : 'active' : 'active'),
    })
  }

  const addTest = (testId: string) => {
    const t = maps.testById.get(testId)
    const fresh = numericParams(t)
      .filter((p) => !rows.some((r) => r.machineId === addMachine && r.testId === testId && r.paramKey === p.key))
      .map((p): TargetRow => ({ machineId: addMachine, testId, paramKey: p.key, byLevel: {} }))
    setRows([...rows, ...fresh])
  }
  const setCell = (i: number, lv: QcLevel, field: 'mean' | 'sd', v: number | null) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, byLevel: { ...r.byLevel, [lv]: { mean: null, sd: null, ...r.byLevel[lv], [field]: v } } } : r)))

  const save = async () => {
    const v = await form.validateFields()
    const lv: QcLevel[] = v.levels
    const targets: QcTarget[] = []
    const bad: string[] = []
    for (const r of rows)
      for (const l of lv) {
        const c = r.byLevel[l]
        if (!c || (c.mean == null && c.sd == null)) continue
        if (c.mean == null || c.sd == null || !(c.sd > 0)) {
          bad.push(`${maps.testById.get(r.testId)?.name ?? r.testId} / ${paramName(maps.testById.get(r.testId), r.paramKey)} ${l}`)
          continue
        }
        targets.push({ testId: r.testId, paramKey: r.paramKey, level: l, mean: c.mean, sd: c.sd, ...(r.machineId ? { machineId: r.machineId } : {}) })
      }
    if (bad.length) {
      message.error(`Mean and an SD above zero are both needed: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? '...' : ''}`)
      return
    }
    if (!targets.length) {
      message.warning('Add at least one parameter target (mean and SD > 0)')
      return
    }
    // Editing mean / SD once results exist makes a new target version (reason required); old results keep their snapshot.
    const norm = (ts: QcTarget[]) => JSON.stringify([...ts].map((t) => [t.machineId ?? '', t.testId, t.paramKey, t.level, t.mean, t.sd]).sort())
    const hasRuns = !!editing?.id && recentRuns.some((r) => r.materialId === editing.id && !r.deleted)
    const changed = !!editing?.id && norm(targets) !== norm(editing.targets ?? [])
    const versioning = hasRuns && changed
    if (versioning && !String(v.changeReason ?? '').trim()) {
      message.warning('Results already exist for this lot: give a reason for changing the targets')
      return
    }
    const version = versioning ? (editing?.targetVersion ?? 1) + 1 : (editing?.targetVersion ?? 1)
    const history = versioning
      ? [...(editing?.targetHistory ?? []), { version: editing?.targetVersion ?? 1, at: Date.now(), byName: profile?.name ?? '', reason: String(v.changeReason).trim(), targets: editing?.targets ?? [] }]
      : (editing?.targetHistory ?? [])
    const data = stripUndefined({
      name: v.name.trim(),
      manufacturer: (v.manufacturer ?? '').trim(),
      lotNo: v.lotNo.trim(),
      expiry: (v.expiry as dayjs.Dayjs).format('YYYY-MM-DD'),
      levels: lv,
      targets,
      rules: v.rules as WestgardRule[],
      active: (v.lifecycle as LotLifecycle) !== 'retired',
      lifecycle: (v.lifecycle === 'expired' ? 'active' : v.lifecycle) as LotLifecycle,
      startDate: v.startDate ? (v.startDate as dayjs.Dayjs).format('YYYY-MM-DD') : '',
      openedDate: v.openedDate ? (v.openedDate as dayjs.Dayjs).format('YYYY-MM-DD') : '',
      targetSource: (v.targetSource ?? 'manufacturer') as TargetSource,
      ...(editing?.establishedFromRuns && v.targetSource === 'established' ? { establishedFromRuns: editing.establishedFromRuns } : {}),
      targetVersion: version,
      targetHistory: history,
    })
    try {
      if (editing?.id) await updateDoc(docRef(QC.materials, editing.id), data)
      else await addDoc(col(QC.materials), { ...data, targetVersion: 1, targetHistory: [], createdAt: serverTimestamp() })
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // Establish targets from our own data: mean / SD of the last N live runs per parameter and level.
  const [estimateN, setEstimateN] = useState(20)
  const csvRef = useRef<HTMLInputElement>(null)
  const establish = () => {
    if (!editing?.id) return void message.warning('Save the lot and run QC first; targets are established from its runs')
    const lotRuns = recentRuns.filter((r) => r.materialId === editing.id && !r.deleted).sort((a, b) => (a.runAt?.toMillis() ?? 0) - (b.runAt?.toMillis() ?? 0))
    let filled = 0
    let thin = 0
    const next = rows.map((r) => {
      const byLevel = { ...r.byLevel }
      for (const lv of QC_LEVELS) {
        const xs = lotRuns
          .filter((run) => !r.machineId || run.machineId === r.machineId)
          .flatMap((run) => run.results.filter((x) => x.testId === r.testId && x.paramKey === r.paramKey && x.level === lv && !x.excluded).map((x) => x.value))
          .slice(-estimateN)
        if (xs.length < 2) continue
        if (xs.length < 20) thin++
        byLevel[lv] = { mean: Math.round(meanOf(xs) * 10000) / 10000, sd: Math.round(sdOf(xs) * 10000) / 10000 }
        filled++
      }
      return { ...r, byLevel }
    })
    if (!filled) return void message.warning('Not enough runs yet (at least 2 per level)')
    setRows(next)
    form.setFieldValue('targetSource', 'established')
    setEditing({ ...editing, establishedFromRuns: estimateN })
    message.success(`Targets filled from up to ${estimateN} runs for ${filled} level(s)${thin ? '; some have fewer than 20 points, so treat them as provisional' : ''}. Save to apply.`)
  }
  // CSV: machine (blank = all), test code, parameter key or name, level, mean, SD.
  const importCsv = async (file: File) => {
    const lines = (await file.text()).split(/\r?\n/).slice(1).filter(Boolean)
    const next = [...rows]
    let n = 0
    for (const line of lines) {
      const [mn, code, pn, lv, mean, sdv] = line.split(',').map((x) => x.replace(/^"|"$/g, '').trim())
      const t = maps.tests.find((x) => x.code.toLowerCase() === (code ?? '').toLowerCase())
      const p = t && numericParams(t).find((x) => x.key === pn || x.name.toLowerCase() === (pn ?? '').toLowerCase())
      const level = (lv ?? '').toUpperCase() as QcLevel
      const m = mn ? machines.find((x) => x.name.toLowerCase() === mn.toLowerCase()) : undefined
      if (!t || !p || !QC_LEVELS.includes(level) || (mn && !m) || !(Number(sdv) > 0) || !Number.isFinite(Number(mean))) continue
      let row = next.find((r) => r.machineId === (m?.id ?? '') && r.testId === t.id && r.paramKey === p.key)
      if (!row) {
        row = { machineId: m?.id ?? '', testId: t.id, paramKey: p.key, byLevel: {} }
        next.push(row)
      }
      row.byLevel = { ...row.byLevel, [level]: { mean: Number(mean), sd: Number(sdv) } }
      n++
    }
    setRows(next)
    form.setFieldValue('targetSource', 'imported')
    message.success(`${n} target value(s) read from the file. Check them, then save.`)
  }
  const copyRowTo = (r: TargetRow, machineId: string) => {
    if (rows.some((x) => x.machineId === machineId && x.testId === r.testId && x.paramKey === r.paramKey)) return void message.info('That machine already has this parameter')
    setRows([...rows, { ...r, machineId, byLevel: { ...r.byLevel } }])
  }
  const retire = async (m: QcMaterial) => {
    const why = window.prompt('Reason for retiring this lot?') ?? ''
    if (!why.trim()) return
    await updateDoc(docRef(QC.materials, m.id), { lifecycle: 'retired', active: false, retiredAt: Date.now(), retiredReason: why.trim() }).catch((e) => message.error(e.message))
  }
  const usedTestIds = useMemo(() => [...new Set(rows.map((r) => r.testId))], [rows])

  return (
    <>
      <div className="qc-toolbar">
        <span className="qc-toolbar__spacer" />
        <DsButton variant="primary" icon={<PlusOutlined />} onClick={() => open({})}>Add new kit</DsButton>
      </div>
      <Table<QcMaterial>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={materials}
        pagination={false}
        columns={[
          { title: 'Material', dataIndex: 'name' },
          { title: 'Manufacturer', dataIndex: 'manufacturer' },
          { title: 'Lot no', dataIndex: 'lotNo' },
          {
            title: 'Status',
            render: (_, m) => {
              const st = lotStatus(m)
              const ov = overlapping(m, materials)
              return (
                <Space size={4} wrap>
                  <Chip status={st === 'active' ? 'active' : st === 'planned' ? 'scheduled' : st === 'expired' ? 'fail' : 'inactive'}>{LOT_LABEL[st]}</Chip>
                  {ov.length > 0 && st !== 'retired' && <Chip status="warning">Overlaps {ov.map((o) => o.lotNo).join(', ')}</Chip>}
                </Space>
              )
            },
          },
          {
            title: 'Expiry',
            render: (_, m) => {
              const exp = isExpired(m.expiry)
              const soon = !exp && dayjs(m.expiry).diff(dayjs(), 'day') <= 30
              return <Chip status={exp ? 'fail' : soon ? 'warning' : 'neutral'}>{dayjs(m.expiry).format('DD MMM YYYY')}{exp ? ' (expired)' : soon ? ' (soon)' : ''}</Chip>
            },
          },
          { title: 'Levels', render: (_, m) => m.levels.join(', ') },
          { title: 'Parameters', render: (_, m) => new Set((m.targets ?? []).map((t) => `${t.testId}|${t.paramKey}`)).size },
          { title: 'Targets', render: (_, m) => `v${m.targetVersion ?? 1}${m.targetSource ? ` (${SOURCE_LABEL[m.targetSource]}${m.targetSource === 'established' && m.establishedFromRuns ? `, ${m.establishedFromRuns} runs` : ''})` : ''}` },
          { title: 'Rules', render: (_, m) => (m.rules ?? []).join(' ') },
          {
            title: '',
            width: 100,
            render: (_, m) => (
              <Space>
                <Button size="small" onClick={() => setReset(m)} aria-label={`Reset series for ${m.name}`}>Reset series</Button>
                {lotStatus(m) !== 'retired' && <Button size="small" onClick={() => void retire(m)} aria-label={`Retire ${m.name}`}>Retire</Button>}
                <Button size="small" icon={<EditOutlined />} aria-label={`Edit ${m.name}`} onClick={() => open(m)} />
                <Popconfirm title="Delete this material?" onConfirm={() => deleteDoc(docRef(QC.materials, m.id)).catch((e) => message.error(e.message))}>
                  <Button size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${m.name}`} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={`Reset series: ${reset?.name ?? ''}`}
        open={!!reset}
        okText="Reset series"
        onCancel={() => setReset(null)}
        onOk={async () => {
          if (!reset) return
          if (!resetReason.trim()) return void message.warning('Give the reason (calibration, reagent or lot change)')
          const entry = stripUndefined({ id: Math.random().toString(36).slice(2, 9), at: Date.now(), reason: resetReason.trim(), machineId: resetMachine || undefined, by: profile?.uid ?? '', byName: profile?.name ?? '' })
          try {
            await updateDoc(docRef(QC.materials, reset.id), { seriesResets: arrayUnion(entry) })
            message.success('Series reset: the multi-point rules start afresh from now. The earlier runs stay on record.')
            setReset(null)
            setResetReason('')
            setResetMachine('')
          } catch (e) {
            message.error((e as Error).message)
          }
        }}
        destroyOnHidden
      >
        <p className="qc-note">Runs recorded before the reset are ignored by the 2-2s, 4-1s and 10x rules (they stay in the history). The reset is recorded with your name and reason.</p>
        <FormSection title="Reset details">
          <SettingRow label="Machine" help="Leave empty to reset every machine running this lot." align="start">
            <Select style={{ width: 260, maxWidth: '100%' }} allowClear placeholder="All machines running this lot" value={resetMachine || undefined} onChange={(v) => setResetMachine(v ?? '')} options={machineList.map((m) => ({ value: m.id, label: m.name }))} aria-label="Machine to reset" />
          </SettingRow>
          <SettingRow label="Reason" help="Calibration, reagent or lot change. Required." htmlFor="qc-reset-reason" align="start">
            <Input.TextArea id="qc-reset-reason" rows={2} style={{ width: 320, maxWidth: '100%' }} placeholder="Reason (required)" value={resetReason} onChange={(e) => setResetReason(e.target.value)} />
          </SettingRow>
        </FormSection>
        {(reset?.seriesResets ?? []).length > 0 && <ul style={{ marginTop: 12 }}>{(reset?.seriesResets ?? []).map((r) => <li key={r.id}>{dayjs(r.at).format('DD MMM YYYY HH:mm')}: {r.reason} ({r.byName})</li>)}</ul>}
      </Modal>
      <Modal
        title={editing?.id ? 'Edit QC material' : 'Add QC material / lot'}
        open={!!editing}
        onOk={save}
        onCancel={() => setEditing(null)}
        destroyOnHidden
        width={dialogWidth(920)}
      >
        <Form form={form} layout="vertical">
          <FormSection title="Material and lot">
            <FieldGrid min={200}>
              <Form.Item name="name" label="Material name" rules={[{ required: true }]}>
                <Input placeholder="e.g. Bio-Rad Multiqual" />
              </Form.Item>
              <Form.Item name="manufacturer" label="Manufacturer">
                <Input />
              </Form.Item>
              <Form.Item name="lotNo" label="Lot no" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="lifecycle" label="Lot status" tooltip="Expired is automatic from the expiry date">
                <Select options={[{ value: 'planned', label: 'Planned' }, { value: 'active', label: 'Active' }, { value: 'retired', label: 'Retired' }]} />
              </Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Dates">
            <FieldGrid min={200}>
              <Form.Item name="expiry" label="Expiry" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="startDate" label="In use from" tooltip="Before this date the lot is Planned and cannot be used for QC">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="openedDate" label="Opened on">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Levels and rules">
            <FieldGrid min={240}>
              <Form.Item name="levels" label="Levels" rules={[{ required: true }]}>
                <Checkbox.Group className="qc-checkgrid" options={QC_LEVELS} />
              </Form.Item>
              <Form.Item name="targetSource" label="Target source">
                <Select options={(Object.keys(SOURCE_LABEL) as TargetSource[]).map((k) => ({ value: k, label: SOURCE_LABEL[k] }))} />
              </Form.Item>
            </FieldGrid>
            <Form.Item
              name="rules"
              label="Westgard rules enabled"
              extra="1-2s is a warning only; the others reject the run."
            >
              <Checkbox.Group
                className="qc-checkgrid"
                options={WESTGARD_RULES.map((r) => ({ value: r, label: `${r}${DEFAULT_SEVERITY[r] === 'warning' ? ' (warning)' : ''}` }))}
              />
            </Form.Item>
            {!!editing?.id && (
              <Form.Item name="changeReason" label="Reason for changing targets" extra="Needed once QC results exist for this lot.">
                <Input placeholder="e.g. new lab-established mean after 20 runs" />
              </Form.Item>
            )}
          </FormSection>
        </Form>

        <FormSection title="Target mean and SD per parameter" description="Enter the lot's assigned mean and SD for each level, or fill them from your own data or a CSV file.">
        <div className="qc-addbar">
          <InputNumber min={2} max={200} value={estimateN} onChange={(v) => setEstimateN(v ?? 20)} aria-label="Runs to establish targets from" addonAfter="runs" style={{ width: 140 }} />
          <Button onClick={establish} disabled={!editing?.id}>Establish targets from data</Button>
          <Button onClick={() => csvRef.current?.click()}>Import targets (CSV)</Button>
          <input ref={csvRef} type="file" accept=".csv,text/csv" hidden aria-label="Targets CSV" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importCsv(f) }} />
        </div>
        <div className="qc-addbar">
          <Select
            style={{ width: 220 }}
            aria-label="Machine for the targets"
            value={addMachine}
            onChange={setAddMachine}
            options={[{ value: '', label: 'All machines' }, ...machines.map((m) => ({ value: m.id, label: m.name }))]}
          />
          <Select
            showSearch
            style={{ width: 340, maxWidth: '100%' }}
            aria-label="Add all parameters of a test"
            placeholder="Add all parameters of a test..."
            optionFilterProp="label"
            value={null}
            options={maps.tests.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))}
            onChange={addTest}
          />
        </div>
        <Table<TargetRow>
          size="small"
          pagination={false}
          rowKey={(r) => `${r.machineId}|${r.testId}|${r.paramKey}`}
          dataSource={rows}
          scroll={{ x: true }}
          columns={[
            { title: 'Machine', width: 150, render: (_, r) => (r.machineId ? (machines.find((m) => m.id === r.machineId)?.name ?? r.machineId) : 'All machines') },
            { title: 'Test', width: 160, render: (_, r) => maps.testById.get(r.testId)?.name ?? r.testId },
            { title: 'Parameter', width: 160, render: (_, r) => paramName(maps.testById.get(r.testId), r.paramKey) },
            ...levels.map((lv) => ({
              title: lv,
              width: 230,
              render: (_: unknown, r: TargetRow) => {
                const i = rows.indexOf(r)
                return (
                  <Space size={4}>
                    <InputNumber size="small" style={{ width: 100 }} aria-label={`${lv} mean`} placeholder="mean" value={r.byLevel[lv]?.mean ?? null} onChange={(v) => setCell(i, lv, 'mean', v)} />
                    <InputNumber size="small" style={{ width: 90 }} aria-label={`${lv} SD`} placeholder="SD" min={0} value={r.byLevel[lv]?.sd ?? null} onChange={(v) => setCell(i, lv, 'sd', v)} />
                  </Space>
                )
              },
            })),
            {
              title: 'Copy to machine',
              width: 150,
              render: (_, r) => <Select size="small" placeholder="Copy to..." style={{ width: 140 }} value={null} aria-label="Copy row to machine" options={machines.filter((m) => m.id !== r.machineId).map((m) => ({ value: m.id, label: m.name }))} onChange={(id) => id && copyRowTo(r, String(id))} />,
            },
            {
              title: '',
              width: 40,
              render: (_, r) => <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="Remove row" onClick={() => setRows(rows.filter((x) => x !== r))} />,
            },
          ]}
        />
        {usedTestIds.length === 0 && <Text type="secondary">Pick a test to add its parameters, then enter the lot's assigned mean and SD for each level.</Text>}
        </FormSection>
      </Modal>
    </>
  )
}
