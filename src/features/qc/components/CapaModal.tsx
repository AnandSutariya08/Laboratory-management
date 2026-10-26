import { useEffect, useMemo } from 'react'
import { App, Checkbox, DatePicker, Form, Input, Modal, Select, Switch } from 'antd'
import dayjs from 'dayjs'
import { addDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { col, docRef } from '../../../lib/db'
import { useAuth } from '../../../auth/AuthProvider'
import { QC, type Capa } from '../types'
import { branchStamp } from '../../../lib/activeBranch'
import { useQcSettings } from '../lib/useQcSettings'
import { CAPA_STATUS, INVESTIGATION_CHECKLIST, OUTLIER_NATURE, ROOT_CAUSE_CATEGORIES } from '../lib/capaOptions'
import { stripUndefined } from '../lib/clean'
import { useCapas, useRecentRuns } from './shared'
import { dialogWidth } from '../../../design/dialog'

type FormVals = Omit<Capa, 'dueDate'> & { dueDate: dayjs.Dayjs }

// Create or edit a corrective / preventive action record. Sections follow the QC settings
// (outlier nature, investigation checklist, remedial action, RCA, follow-up).
export default function CapaModal({ open, initial, onClose }: { open: boolean; initial: Partial<Capa> | null; onClose: () => void }) {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const { settings } = useQcSettings()
  const [form] = Form.useForm<FormVals>()
  const { data: runs } = useRecentRuns(200)
  const { data: capas } = useCapas()
  const status = Form.useWatch('status', form) as Capa['status'] | undefined

  const repeatRuns = useMemo(() => runs.filter((r) => !r.deleted && r.status === 'pass' && (!initial?.machineId || r.machineId === initial.machineId)), [runs, initial?.machineId])

  useEffect(() => {
    if (open) {
      form.resetFields()
      form.setFieldsValue({ status: 'open', owner: profile?.name ?? '', ...initial, dueDate: initial?.dueDate ? dayjs(initial.dueDate) : dayjs().add(3, 'day') } as FormVals)
    }
  }, [open, initial, form, profile?.name])

  const save = async () => {
    const v = await form.validateFields()
    if ((v.status === 'verified' || v.status === 'closed') && !v.repeatRunId) {
      message.warning('Pick the passing repeat run that verifies the fix before verifying or closing')
      return
    }
    const closing = v.status === 'closed'
    const data = stripUndefined({ ...v, dueDate: v.dueDate.format('YYYY-MM-DD'), patientImpactAssessed: !!v.patientImpactAssessed })
    try {
      if (initial?.id) {
        await updateDoc(docRef(QC.capas, initial.id), { ...data, closedAt: closing ? serverTimestamp() : null })
      } else {
        const year = dayjs().year()
        const n = capas.filter((c) => (c.capaNo ?? '').startsWith(`CAPA-${year}-`)).length + 1
        await addDoc(col(QC.capas), {
          ...data,
          ...branchStamp(),
          capaNo: `CAPA-${year}-${String(n).padStart(4, '0')}`,
          sourceType: initial?.sourceType ?? (initial?.runId ? 'iqc' : 'manual'),
          sourceId: initial?.sourceId ?? initial?.runId ?? '',
          runId: initial?.runId ?? '',
          machineId: initial?.machineId ?? '',
          machineName: initial?.machineName ?? '',
          createdBy: user?.uid ?? '',
          createdAt: serverTimestamp(),
          closedAt: closing ? serverTimestamp() : null,
        })
      }
      message.success('CAPA saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Modal title={initial?.id ? `Edit CAPA ${initial.capaNo ?? ''}` : 'New CAPA'} open={open} onOk={save} onCancel={onClose} destroyOnHidden okText="Save CAPA" width={dialogWidth(640)}>
      <Form form={form} layout="vertical">
        {settings.outlierNature && (
          <Form.Item name="outlierNature" label="Nature of QC outlier">
            <Select allowClear options={OUTLIER_NATURE} />
          </Form.Item>
        )}
        {settings.investigationChecklist && (
          <Form.Item name="investigation" label="Investigation checklist (tick what was checked)">
            <Checkbox.Group style={{ display: 'grid', gap: 4 }} options={INVESTIGATION_CHECKLIST} />
          </Form.Item>
        )}
        <Form.Item name="cause" label="Cause (root cause)" rules={[{ required: settings.rootCauseAnalysis }]}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="rootCauseCategory" label="Root cause category">
          <Select allowClear options={ROOT_CAUSE_CATEGORIES} />
        </Form.Item>
        <Form.Item name="correctiveAction" label="Corrective action" rules={[{ required: true }]}>
          <Input.TextArea rows={2} />
        </Form.Item>
        {settings.remedialAction && (
          <Form.Item name="remedialAction" label="Remedial action taken">
            <Input.TextArea rows={2} />
          </Form.Item>
        )}
        <Form.Item name="preventiveAction" label="Preventive action">
          <Input.TextArea rows={2} />
        </Form.Item>
        {settings.patientResultManagement && (
          <Form.Item name="patientImpactAssessed" label="Patient results since the last good QC reviewed" valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
        {settings.followUp && (
          <Form.Item name="followUp" label="Follow-up steps">
            <Input.TextArea rows={2} />
          </Form.Item>
        )}
        <Form.Item name="owner" label="Owner" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="dueDate" label="Due date">
          <DatePicker />
        </Form.Item>
        <Form.Item name="status" label="Status">
          <Select options={CAPA_STATUS} />
        </Form.Item>
        {(status === 'verified' || status === 'closed') && (
          <>
            <Form.Item name="repeatRunId" label="Passing repeat run" rules={[{ required: true }]} extra="Closing needs a QC run that passed after the corrective action.">
              <Select
                showSearch
                optionFilterProp="label"
                options={repeatRuns.map((r) => ({ value: r.id, label: `${r.runNo ?? r.id.slice(0, 6)} - ${r.machineName} - ${r.runAt ? dayjs(r.runAt.toMillis()).format('DD MMM HH:mm') : ''}` }))}
              />
            </Form.Item>
            <Form.Item name="closeRemark" label="Closing remark">
              <Input.TextArea rows={2} />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  )
}
