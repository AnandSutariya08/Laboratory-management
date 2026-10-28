import { useState } from 'react'
import { App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { addDoc, orderBy, query, serverTimestamp, Timestamp, updateDoc } from 'firebase/firestore'
import { col, docRef } from '../../../lib/db'
import { can, useAuth } from '../../../auth/AuthProvider'
import { ApproveModal, DeleteReasonModal } from './StudyActions'
import CapaModal from './CapaModal'
import { FieldGrid, FormSection } from '../../../design/FormLayout'
import { useCapas } from './shared'
import { useQcSettings } from '../lib/useQcSettings'
import type { Capa, IlcParam } from '../types'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { useLiveQuery } from '../../../hooks/useLive'
import { fmtDate } from '../../../components/results/common'
import { fmt } from '../lib/stats'
import { QC, type IlcStudy } from '../types'
import { paramName, TestParamSelect, useMachines, type TestParam } from './shared'
import { Button as DsButton } from '../../../design/Button'
import { Chip } from '../ui'
import { branchStamp } from '../../../lib/activeBranch'
import { useBranchScope } from '../../../lib/branchScope'
import { dialogWidth } from '../../../design/dialog'

const { Text } = Typography

// % difference = (ours - partner) / partner x 100; acceptable when |%diff| <= limit.
// SDI = (ours - partner) / SD when the partner's SD (or the group SD) is given.
export function evalIlc(our: number, theirs: number, limitPct: number, peerSd?: number | null) {
  const d = theirs !== 0 ? ((our - theirs) / theirs) * 100 : NaN
  const sdiV = peerSd && peerSd > 0 ? (our - theirs) / peerSd : null
  return {
    sdi: sdiV,
    diffPct: Number.isFinite(d) ? d : null,
    outcome: (Number.isFinite(d) ? (Math.abs(d) <= limitPct ? 'acceptable' : 'unacceptable') : 'notEvaluated') as IlcStudy['outcome'],
  }
}

// All parameters of a study (older single-parameter studies have none stored).
export const ilcParams = (r: Partial<IlcStudy>): IlcParam[] =>
  r.params?.length ? r.params : r.testId && r.paramKey ? [{ testId: r.testId, testName: r.testName ?? '', paramKey: r.paramKey, paramName: r.paramName ?? '', ourResult: r.ourResult ?? 0, theirResult: r.theirResult ?? 0, diffPct: r.diffPct ?? null, sdi: null, limitPct: r.limitPct ?? 10, outcome: r.outcome ?? 'notEvaluated' }] : []

export const useIlc = () => {
  const scope = useBranchScope()
  return useLiveQuery<IlcStudy>(query(col(QC.ilc), ...scope.constraints, orderBy('date', 'desc')), [scope.key])
}

interface FormVals {
  partnerLab: string
  partnerLabId?: string
  machineId?: string
  sampleType?: string
  sampleId: string
  params: { tp: TestParam; ourResult?: number; theirResult?: number; peerSd?: number; limitPct?: number }[]
  date: dayjs.Dayjs
  notes: string
}

export default function IlcSection() {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const maps = useCatalogueMaps()
  const { data, loading } = useIlc()
  const { data: machines } = useMachines()
  const { data: capas } = useCapas()
  const { settings } = useQcSettings()
  const canApprove = can(profile, 'qc.approveCapa')
  const [editing, setEditing] = useState<Partial<IlcStudy> | null>(null)
  const [approving, setApproving] = useState<IlcStudy | null>(null)
  const [deleting, setDeleting] = useState<IlcStudy | null>(null)
  const [capa, setCapa] = useState<Partial<Capa> | null>(null)
  const locked = editing?.status === 'approved' || editing?.status === 'rejected'
  // Acceptance limit: lab master per parameter, then the lab default.
  const limitFor = (testId?: string, paramKey?: string) => settings.ilcAcceptance?.[`${testId}|${paramKey}`] ?? settings.ilcDefaultLimitPct ?? 10
  const [form] = Form.useForm<FormVals>()
  const w = Form.useWatch([], form)

  const open = (r: Partial<IlcStudy>) => {
    setEditing(r)
    form.resetFields()
    form.setFieldsValue({
      params: ilcParams(r).length ? ilcParams(r).map((p) => ({ tp: { testId: p.testId, paramKey: p.paramKey }, ourResult: p.ourResult, theirResult: p.theirResult, peerSd: p.peerSd, limitPct: p.limitPct })) : [{ limitPct: limitFor() }],
      date: r.date ? dayjs(r.date.toDate()) : dayjs(),
      partnerLab: r.partnerLab,
      partnerLabId: r.partnerLabId,
      machineId: r.machineId,
      sampleType: r.sampleType,
      sampleId: r.sampleId,
      notes: r.notes,
    } as FormVals)
  }

  const save = async () => {
    const v = await form.validateFields()
    const params: IlcParam[] = []
    for (const p of v.params ?? []) {
      if (!p?.tp?.testId || !p.tp.paramKey || p.ourResult == null || p.theirResult == null) return void message.warning('Every parameter needs a test, parameter and both results')
      const test = maps.testById.get(p.tp.testId)
      const limit = p.limitPct ?? limitFor(p.tp.testId, p.tp.paramKey)
      const e = evalIlc(p.ourResult, p.theirResult, limit, p.peerSd)
      params.push({ testId: p.tp.testId, testName: test?.name ?? '', paramKey: p.tp.paramKey, paramName: paramName(test, p.tp.paramKey), ourResult: p.ourResult, theirResult: p.theirResult, ...(p.peerSd ? { peerSd: p.peerSd } : {}), diffPct: e.diffPct, sdi: e.sdi, limitPct: limit, outcome: e.outcome })
    }
    if (!params.length) return void message.warning('Add at least one parameter')
    const first = params[0]
    const outcome: IlcStudy['outcome'] = params.some((p) => p.outcome === 'unacceptable') ? 'unacceptable' : params.every((p) => p.outcome === 'notEvaluated') ? 'notEvaluated' : 'acceptable'
    const doc = {
      partnerLab: v.partnerLab.trim(),
      partnerLabId: (v.partnerLabId ?? '').trim(),
      machineId: v.machineId ?? '',
      machineName: machines.find((m) => m.id === v.machineId)?.name ?? '',
      sampleType: v.sampleType ?? '',
      sampleId: v.sampleId.trim(),
      params,
      testId: first.testId,
      testName: first.testName,
      paramKey: first.paramKey,
      paramName: first.paramName,
      ourResult: first.ourResult,
      theirResult: first.theirResult,
      limitPct: first.limitPct,
      diffPct: first.diffPct,
      outcome,
      status: editing?.status ?? 'draft',
      notes: v.notes ?? '',
      date: Timestamp.fromDate(v.date.toDate()),
    }
    try {
      if (locked) return void setEditing(null)
      if (editing?.id) await updateDoc(docRef(QC.ilc, editing.id), doc)
      else await addDoc(col(QC.ilc), { ...doc, ...branchStamp(), createdBy: user?.uid ?? '', createdByName: profile?.name ?? '', createdAt: serverTimestamp() })
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <div className="qc-toolbar"><span className="qc-toolbar__spacer" /><DsButton variant="primary" icon={<PlusOutlined />} onClick={() => open({})}>Add ILC study</DsButton></div>
      <Table<IlcStudy>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={data.filter((r) => !r.deleted)}
        expandable={{
          expandedRowRender: (r) => (
            <Table<IlcParam>
              size="small"
              pagination={false}
              rowKey={(p) => `${p.testId}${p.paramKey}`}
              dataSource={ilcParams(r)}
              columns={[
                { title: 'Test / parameter', render: (_, p) => `${p.testName} / ${p.paramName}` },
                { title: 'Our result', dataIndex: 'ourResult' },
                { title: 'Partner result', dataIndex: 'theirResult' },
                { title: '% difference', render: (_, p) => fmt(p.diffPct) },
                { title: 'SDI', render: (_, p) => fmt(p.sdi) },
                { title: 'Limit %', dataIndex: 'limitPct' },
                { title: 'Outcome', render: (_, p) => <Chip status={p.outcome} /> },
              ]}
            />
          ),
        }}
        columns={[
          { title: 'Date', render: (_, r) => fmtDate(r.date) },
          { title: 'Partner lab', render: (_, r) => (r.partnerLabId ? `${r.partnerLab} (${r.partnerLabId})` : r.partnerLab) },
          { title: 'Machine', dataIndex: 'machineName' },
          { title: 'Sample type', dataIndex: 'sampleType' },
          { title: 'Sample', dataIndex: 'sampleId' },
          { title: 'Parameters', render: (_, r) => (ilcParams(r).length > 1 ? `${ilcParams(r).length} parameters` : `${r.testName} / ${r.paramName}`) },
          { title: 'Outcome', render: (_, r) => <Chip status={r.outcome} /> },
          { title: 'Status', render: (_, r) => <Chip status={r.status === 'approved' ? 'verified' : r.status === 'rejected' ? 'fail' : 'pending'}>{r.status === 'approved' ? `Approved by ${r.approval?.approverName ?? ''}` : r.status === 'rejected' ? 'Rejected' : 'Draft'}</Chip> },
          {
            title: '',
            render: (_, r) => {
              const hasCapa = capas.some((c) => c.sourceId === r.id)
              const block = r.outcome === 'unacceptable' && !hasCapa ? 'An unacceptable result needs a CAPA before approval' : undefined
              return (
                <Space wrap>
                  <Button size="small" icon={<EditOutlined />} onClick={() => open(r)} aria-label={r.status === 'approved' ? 'View study' : 'Edit study'} />
                  {r.outcome === 'unacceptable' && !hasCapa && <Button size="small" onClick={() => setCapa({ sourceType: 'ilc', sourceId: r.id })}>Raise CAPA</Button>}
                  {(r.status ?? 'draft') === 'draft' && canApprove && <Button size="small" title={block} disabled={!!block} onClick={() => setApproving(r)}>Approve</Button>}
                  {(r.status ?? 'draft') === 'draft' && <Button size="small" danger icon={<DeleteOutlined />} aria-label="Delete study" onClick={() => setDeleting(r)} />}
                </Space>
              )
            },
          },
        ]}
      />
      <Modal title={editing?.id ? 'Edit ILC study' : 'Add ILC study'} open={!!editing} onOk={save} okButtonProps={{ disabled: locked }} onCancel={() => setEditing(null)} destroyOnHidden width={dialogWidth(900)}>
        <Form form={form} layout="vertical" disabled={locked}>
          <FormSection title="Study details" description="The partner lab and the sample that was compared.">
            <FieldGrid min={200}>
              <Form.Item name="partnerLab" label="Partner lab" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="partnerLabId" label="Partner lab ID">
                <Input />
              </Form.Item>
              <Form.Item name="machineId" label="Machine">
                <Select allowClear options={machines.map((m) => ({ value: m.id, label: m.name }))} />
              </Form.Item>
              <Form.Item name="sampleType" label="Sample type">
                <Select allowClear options={maps.sampleTypes.map((t) => ({ value: t.name, label: t.name }))} />
              </Form.Item>
              <Form.Item name="sampleId" label="Sample ID" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="date" label="Date" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Parameters compared" description="Enter our result and the partner's result for each parameter.">
          <Form.List name="params">
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => {
                  const p = w?.params?.[f.name]
                  const e = p && p.ourResult != null && p.theirResult != null ? evalIlc(p.ourResult, p.theirResult, p.limitPct ?? limitFor(p.tp?.testId, p.tp?.paramKey), p.peerSd) : null
                  return (
                    <div key={f.key} className="qc-subcard">
                      <Form.Item name={[f.name, 'tp']} label="Test and parameter" rules={[{ required: true }]}>
                        <TestParamSelect tests={maps.tests} restrictTestIds={machines.find((m) => m.id === w?.machineId)?.testIds} onChange={(tp) => form.setFieldValue(['params', f.name, 'limitPct'], limitFor(tp.testId, tp.paramKey))} />
                      </Form.Item>
                      <FieldGrid min={140}>
                        <Form.Item name={[f.name, 'ourResult']} label="Our result" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
                        <Form.Item name={[f.name, 'theirResult']} label="Partner result" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
                        <Form.Item name={[f.name, 'peerSd']} label="Group SD (for SDI)"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item>
                        <Form.Item name={[f.name, 'limitPct']} label="Limit"><InputNumber style={{ width: '100%' }} min={0} addonAfter="%" /></Form.Item>
                      </FieldGrid>
                      {e && <div><Text>Difference {fmt(e.diffPct)}% | SDI {fmt(e.sdi)} | <Chip status={e.outcome} /></Text></div>}
                      {fields.length > 1 && !locked && <Button onClick={() => remove(f.name)} aria-label="Remove parameter" style={{ marginTop: 8 }}>Remove</Button>}
                    </div>
                  )
                })}
                {!locked && <Button onClick={() => add({ limitPct: limitFor() })}>Add parameter</Button>}
              </>
            )}
          </Form.List>
          </FormSection>
          <FormSection title="Notes">
            <Form.Item name="notes" label="Notes">
              <Input.TextArea rows={2} />
            </Form.Item>
          </FormSection>
        </Form>
      </Modal>
      <ApproveModal
        open={!!approving}
        title="Approve ILC study"
        defaultName={profile?.name ?? ''}
        onCancel={() => setApproving(null)}
        onOk={async (r) => {
          await updateDoc(docRef(QC.ilc, approving!.id), { status: 'approved', approval: { ...r, by: user?.uid ?? '', at: Date.now() } }).catch((e) => message.error(e.message))
          setApproving(null)
        }}
      />
      <DeleteReasonModal
        open={!!deleting}
        title="Delete ILC study"
        onCancel={() => setDeleting(null)}
        onOk={async (reason) => {
          await updateDoc(docRef(QC.ilc, deleting!.id), { deleted: true, deleteReason: reason }).catch((e) => message.error(e.message))
          setDeleting(null)
        }}
      />
      <CapaModal open={!!capa} initial={capa} onClose={() => setCapa(null)} />
    </>
  )
}
