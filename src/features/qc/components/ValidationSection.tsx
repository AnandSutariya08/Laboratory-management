import { useMemo, useState } from 'react'
import { Alert, App, Button, DatePicker, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Table } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { addDoc, orderBy, query, serverTimestamp, Timestamp, updateDoc } from 'firebase/firestore'
import { col, docRef } from '../../../lib/db'
import { can, useAuth } from '../../../auth/AuthProvider'
import { ApproveModal, DeleteReasonModal } from './StudyActions'
import CapaModal from './CapaModal'
import { useCapas } from './shared'
import { stripUndefined } from '../lib/clean'
import type { Capa } from '../types'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { useLiveQuery } from '../../../hooks/useLive'
import { fmtDate } from '../../../components/results/common'
import { fmt } from '../lib/stats'
import { computeValidation, CRITERIA_LABEL, DEFAULT_CRITERIA, parseRows, ROW_HELP, rowsToText, VALIDATION_LABEL } from '../lib/validation'
import { QC, type ValidationStudy, type ValidationType } from '../types'
import { LinearityChart, StructuredRows } from './ValidationEntry'
import { useQcSettings } from '../lib/useQcSettings'
import { teaFor } from '../lib/sigma'
import { paramName, TestParamSelect, useMachines, type TestParam } from './shared'
import { Segmented } from '../../../design/Segmented'
import { Button as DsButton } from '../../../design/Button'
import { Chip } from '../ui'
import { branchStamp } from '../../../lib/activeBranch'
import { useBranchScope } from '../../../lib/branchScope'
import { dialogWidth } from '../../../design/dialog'

export const useValidation = () => {
  const scope = useBranchScope()
  return useLiveQuery<ValidationStudy>(query(col(QC.validation), ...scope.constraints, orderBy('date', 'desc')), [scope.key])
}

interface FormVals {
  type: ValidationType
  machineId: string
  machineBId?: string
  tp: TestParam
  date: dayjs.Dayjs
  text: string
  criteria: Record<string, number>
  notes: string
}

export default function ValidationSection() {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const maps = useCatalogueMaps()
  const { data: machines } = useMachines()
  const { data, loading } = useValidation()
  const { data: capas } = useCapas()
  const { settings: qcSettings } = useQcSettings()
  const canApprove = can(profile, 'qc.approveCapa')
  const [editing, setEditing] = useState<Partial<ValidationStudy> | null>(null)
  const [approving, setApproving] = useState<ValidationStudy | null>(null)
  const [deleting, setDeleting] = useState<ValidationStudy | null>(null)
  const [capa, setCapa] = useState<Partial<Capa> | null>(null)
  const locked = editing?.status === 'approved'
  const [group, setGroup] = useState<'all' | 'comparison' | 'precision' | 'accuracy' | 'linearity' | 'carry' | 'reference'>('all')
  const [form] = Form.useForm<FormVals>()
  const w = Form.useWatch([], form)
  const type: ValidationType = w?.type ?? 'linearity'
  const comp = useMemo(() => computeValidation(type, parseRows(w?.text ?? ''), w?.criteria ?? {}), [type, w?.text, w?.criteria])

  const open = (s: Partial<ValidationStudy>) => {
    setEditing(s)
    form.resetFields()
    const t = s.type ?? 'linearity'
    form.setFieldsValue({
      type: t,
      machineId: s.machineId,
      machineBId: s.machineBId,
      tp: { testId: s.testId, paramKey: s.paramKey },
      date: s.date ? dayjs(s.date.toDate()) : dayjs(),
      text: s.rows ? rowsToText(s.rows) : '',
      criteria: { ...DEFAULT_CRITERIA[t], ...(s.criteria ?? {}) },
      notes: s.notes ?? '',
    })
  }

  const save = async () => {
    const v = await form.validateFields()
    const rows = parseRows(v.text)
    if (!rows.length) {
      message.warning('Enter the study data')
      return
    }
    if (v.type === 'interEquipment' && (!v.machineBId || v.machineBId === v.machineId)) {
      message.warning('Pick two different machines')
      return
    }
    const mA = machines.find((m) => m.id === v.machineId)
    const mB = machines.find((m) => m.id === v.machineBId)
    const test = maps.testById.get(v.tp?.testId ?? '')
    const c = computeValidation(v.type, rows, v.criteria)
    const doc = {
      type: v.type,
      machineId: v.machineId,
      machineName: mA?.name ?? '',
      machineBId: v.machineBId ?? '',
      machineBName: mB?.name ?? '',
      testId: v.tp?.testId ?? '',
      testName: test?.name ?? '',
      paramKey: v.tp?.paramKey ?? '',
      paramName: v.tp?.paramKey ? paramName(test, v.tp.paramKey) : '',
      rows: rows.map((r) => ({ v: r })),
      criteria: { ...DEFAULT_CRITERIA[v.type], ...v.criteria },
      computed: c.computed,
      checks: c.checks,
      outcome: c.outcome,
      status: (editing?.status === 'approved' ? 'approved' : 'completed') as ValidationStudy['status'],
      notes: v.notes ?? '',
      date: Timestamp.fromDate(v.date.toDate()),
    }
    try {
      if (locked) return void setEditing(null) // approved studies are immutable
      if (editing?.id) await updateDoc(docRef(QC.validation, editing.id), doc)
      else await addDoc(col(QC.validation), { ...doc, ...branchStamp(), performedBy: user?.uid ?? '', performedByName: profile?.name ?? '', createdAt: serverTimestamp() })
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const GROUPS: Record<string, ValidationType[]> = { comparison: ['interEquipment'], precision: ['intraAssay', 'interAssay'], linearity: ['linearity'], carry: ['carryOver'], accuracy: ['accuracy'], reference: ['referenceInterval'] }
  const rows = data.filter((s) => !s.deleted).filter((s) => group === 'all' || GROUPS[group].includes(s.type))

  return (
    <>
      <div className="qc-toolbar">
        <Segmented
          aria-label="Validation study types"
          value={group}
          onChange={setGroup}
          options={[
            { value: 'all', label: 'All studies' },
            { value: 'comparison', label: 'Comparison' },
            { value: 'precision', label: 'Precision' },
            { value: 'accuracy', label: 'Accuracy' },
            { value: 'linearity', label: 'Linearity' },
            { value: 'reference', label: 'Reference interval' },
            { value: 'carry', label: 'Carry over' },
          ]}
        />
        <span className="qc-toolbar__spacer" />
        <DsButton variant="primary" icon={<PlusOutlined />} onClick={() => open({})}>New study</DsButton>
      </div>
      <Table<ValidationStudy>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        expandable={{
          expandedRowRender: (s) => (
            <Space vertical style={{ width: '100%' }}>
              {s.type === 'linearity' && <LinearityChart rows={(s.rows ?? []).map((r) => r.v)} />}
              <Descriptions size="small" bordered column={4} items={Object.entries(s.computed ?? {}).map(([k, v]) => ({ key: k, label: k, children: fmt(v, 4) }))} />
              {(s.checks ?? []).map((c) => (
                <Chip key={c.label} status={c.pass ? 'pass' : 'fail'}>
                  {c.label}: {c.detail}
                </Chip>
              ))}
            </Space>
          ),
        }}
        columns={[
          { title: 'Date', render: (_, s) => fmtDate(s.date) },
          { title: 'Study', render: (_, s) => VALIDATION_LABEL[s.type] },
          { title: 'Machine', render: (_, s) => (s.machineBName ? `${s.machineName} vs ${s.machineBName}` : s.machineName) },
          { title: 'Parameter', render: (_, s) => (s.testName ? `${s.testName} / ${s.paramName}` : '-') },
          { title: 'Operator', dataIndex: 'performedByName' },
          { title: 'Outcome', render: (_, s) => <Chip status={s.outcome} /> },
          { title: 'Status', render: (_, s) => <Chip status={s.status === 'approved' ? 'verified' : 'pending'}>{s.status === 'approved' ? `Approved by ${s.approval?.approverName ?? ''}` : 'Awaiting approval'}</Chip> },
          {
            title: '',
            render: (_, s) => {
              const hasCapa = capas.some((c) => c.sourceId === s.id)
              const block = s.outcome === 'fail' && !hasCapa ? 'A failed study needs a CAPA before approval' : undefined
              return (
                <Space wrap>
                  <Button size="small" icon={<EditOutlined />} onClick={() => open(s)} aria-label={s.status === 'approved' ? 'View study' : 'Edit study'} />
                  {s.outcome === 'fail' && !hasCapa && <Button size="small" onClick={() => setCapa({ sourceType: 'validation', sourceId: s.id, machineId: s.machineId, machineName: s.machineName })}>Raise CAPA</Button>}
                  {s.status !== 'approved' && canApprove && <Button size="small" title={block} disabled={!!block} onClick={() => setApproving(s)}>Approve</Button>}
                  {s.status !== 'approved' && <Button size="small" danger icon={<DeleteOutlined />} aria-label="Delete study" onClick={() => setDeleting(s)} />}
                </Space>
              )
            },
          },
        ]}
      />
      <Modal title={editing?.id ? 'Edit validation study' : 'New validation study'} open={!!editing} onOk={save} okButtonProps={{ disabled: locked }} onCancel={() => setEditing(null)} destroyOnHidden width={dialogWidth(760)}>
        <Form form={form} layout="vertical" disabled={locked}>
          <Space wrap size="middle">
            <Form.Item name="type" label="Study type" rules={[{ required: true }]}>
              <Select
                style={{ width: 240 }}
                disabled={!!editing?.id}
                options={Object.entries(VALIDATION_LABEL).map(([k, l]) => ({ value: k, label: l }))}
                onChange={(t: ValidationType) => form.setFieldValue('criteria', { ...DEFAULT_CRITERIA[t] })}
              />
            </Form.Item>
            <Form.Item name="machineId" label={type === 'interEquipment' ? 'Machine A (reference)' : 'Machine'} rules={[{ required: true }]}>
              <Select style={{ width: 220 }} options={machines.map((m) => ({ value: m.id, label: m.name }))} />
            </Form.Item>
            {type === 'interEquipment' && (
              <Form.Item name="machineBId" label="Machine B (comparator)" rules={[{ required: true }]}>
                <Select style={{ width: 220 }} options={machines.map((m) => ({ value: m.id, label: m.name }))} />
              </Form.Item>
            )}
            <Form.Item name="date" label="Date" rules={[{ required: true }]}>
              <DatePicker />
            </Form.Item>
          </Space>
          <Form.Item name="tp" label="Test and parameter">
            <TestParamSelect tests={maps.tests} onChange={(tp) => { form.setFieldValue('tp', tp); if (!tp.testId || !tp.paramKey) return; const tea = teaFor(qcSettings, tp.testId, tp.paramKey); const claim = qcSettings.claimCv?.[`${tp.testId}|${tp.paramKey}`]; const cur = form.getFieldValue('criteria') ?? {}; form.setFieldValue('criteria', { ...cur, ...(tea && 'teaPct' in cur ? { teaPct: tea } : {}), ...(tea && 'maxBiasPct' in cur ? { maxBiasPct: tea / 2 } : {}), ...(claim && 'claimCv' in cur ? { claimCv: claim } : {}) }) }} />
          </Form.Item>
          <Form.Item name="text" label="Study data" extra={ROW_HELP[type]} rules={[{ required: true }]}>
            <StructuredRows type={type} disabled={locked} />
          </Form.Item>
          {type === 'linearity' && <LinearityChart rows={parseRows(w?.text ?? '')} />}
          <Space wrap size="middle">
            {Object.keys(DEFAULT_CRITERIA[type]).map((k) => (
              <Form.Item key={k} name={['criteria', k]} label={CRITERIA_LABEL[k] ?? k}>
                <InputNumber style={{ width: 130 }} step={k === 'minR2' ? 0.001 : 1} />
              </Form.Item>
            ))}
          </Space>
          <Alert
            type={comp.outcome === 'pass' ? 'success' : comp.outcome === 'fail' ? 'error' : 'info'}
            showIcon
            style={{ marginBottom: 12 }}
            message={`Result: ${comp.outcome}`}
            description={
              comp.outcome === 'inconclusive' ? (
                'Not enough valid data yet (or an invalid design, e.g. carry-over needs H3 above L3).'
              ) : (
                <div>
                  <div>
                    {Object.entries(comp.computed)
                      .map(([k, v]) => `${k} ${fmt(v, 3)}`)
                      .join(' | ')}
                  </div>
                  {comp.checks.map((c) => (
                    <div key={c.label}>
                      <Chip status={c.pass ? 'pass' : 'fail'} />
                      {c.label}: {c.detail}
                    </div>
                  ))}
                </div>
              )
            }
          />
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
      <ApproveModal
        open={!!approving}
        title="Approve validation study"
        defaultName={profile?.name ?? ''}
        onCancel={() => setApproving(null)}
        onOk={async (r) => {
          await updateDoc(docRef(QC.validation, approving!.id), { status: 'approved', approval: { ...r, by: user?.uid ?? '', at: Date.now() } }).catch((e) => message.error(e.message))
          setApproving(null)
        }}
      />
      <DeleteReasonModal
        open={!!deleting}
        title="Delete validation study"
        onCancel={() => setDeleting(null)}
        onOk={async (reason) => {
          await updateDoc(docRef(QC.validation, deleting!.id), stripUndefined({ deleted: true, deleteReason: reason })).catch((e) => message.error(e.message))
          setDeleting(null)
        }}
      />
      <CapaModal open={!!capa} initial={capa} onClose={() => setCapa(null)} />
    </>
  )
}
