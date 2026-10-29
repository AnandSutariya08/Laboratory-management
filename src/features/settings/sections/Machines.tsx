import { useState } from 'react'
import { App, Input, Modal, Select, Table } from 'antd'
import { addDoc, deleteDoc, getDocs, limit, query, serverTimestamp, updateDoc, where } from 'firebase/firestore'
import { can, useAuth } from '../../../auth/AuthProvider'
import { useBranchScope } from '../../../lib/branchScope'
import { ConnectAnalyserButton, ConnectorStatus } from '../../qc/components/ConnectAnalyser'
import { Button } from '../../../design/Button'
import { StatusChip } from '../../../design/StatusChip'
import { useDepartments, useTests } from '../../../hooks/useCatalogue'
import { branchStamp } from '../../../lib/activeBranch'
import { col, docRef } from '../../../lib/db'
import { useMachines } from '../../qc/components/shared'
import { QC, type QcMachine } from '../../qc/types'
import { dialogWidth } from '../../../design/dialog'
import { Field, Group, SectionCard, SwitchRow, useDraft } from '../ui'

type Machine = QcMachine & { model?: string; machineCode?: string; interfaceType?: 'none' | 'astm' | 'hl7' | 'file' | 'manual'; integrationStatus?: 'connected' | 'pending' | 'offline' | 'none'; ingestTokenHash?: string }

const IFACE = [
  { value: 'none', label: 'None (manual entry)' }, { value: 'astm', label: 'ASTM / serial' },
  { value: 'hl7', label: 'HL7 / network' }, { value: 'file', label: 'File import' },
]
const STATUS = [
  { value: 'none', label: 'Not integrated' }, { value: 'pending', label: 'Pending setup' },
  { value: 'connected', label: 'Connected' }, { value: 'offline', label: 'Offline' },
]
const BLANK: Partial<Machine> = { name: '', machineCode: '', model: '', serial: '', departmentId: '', testIds: [], interfaceType: 'none', integrationStatus: 'none', active: true }

export function Machines() {
  const { message } = App.useApp()
  const { canEdit } = useDraft()
  const { profile } = useAuth()
  const { modal } = App.useApp()
  const { constraints } = useBranchScope()
  const canDelete = can(profile, 'catalogue.delete') || can(profile, 'qc.setup')
  const machines = useMachines().data as Machine[]
  const departments = useDepartments().data
  const tests = useTests().data
  const [editing, setEditing] = useState<Partial<Machine> | null>(null)

  const save = async () => {
    if (!editing?.name?.trim()) return message.error('Machine name is required')
    const { id, ...rest } = editing
    const data = { ...BLANK, ...rest, name: editing.name.trim() }
    try {
      if (id) await updateDoc(docRef(QC.machines, id), data)
      else await addDoc(col(QC.machines), { ...data, ...branchStamp(), createdAt: serverTimestamp() })
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  // PRO-09: a machine cannot be deleted while tests are mapped to it or it holds QC runs; make it inactive instead.
  const remove = async (m: Machine) => {
    try {
      const runs = await getDocs(query(col(QC.runs), ...constraints, where('machineId', '==', m.id), limit(1)))
      const why = (m.testIds?.length ?? 0) > 0 ? `${m.testIds.length} test(s) are mapped to it` : !runs.empty ? 'it holds QC runs' : ''
      if (why) {
        modal.warning({ title: `Cannot delete "${m.name}"`, content: `${why[0].toUpperCase()}${why.slice(1)}. Remove the mapping or mark the machine inactive instead.` })
        return
      }
      modal.confirm({ title: `Delete machine "${m.name}"?`, okButtonProps: { danger: true }, onOk: () => deleteDoc(docRef(QC.machines, m.id)).catch((e) => message.error(e.message)) })
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const set = (patch: Partial<Machine>) => setEditing((m) => ({ ...m, ...patch }))
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? '-'
  return (
    <SectionCard
      title="Machine list"
      description="Analysers in this branch. The same list is used by Quality Control."
      extra={canEdit && <Button variant="primary" onClick={() => setEditing({ ...BLANK })}>Add machine</Button>}
    >
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={machines}
        scroll={{ x: true }}
        columns={[
          { title: 'Machine', dataIndex: 'name' },
          { title: 'ID', dataIndex: 'machineCode', render: (v) => v || '-' },
          { title: 'Model', dataIndex: 'model', render: (v) => v || '-' },
          { title: 'Department', dataIndex: 'departmentId', render: deptName },
          { title: 'Tests', dataIndex: 'testIds', render: (v: string[]) => v?.length ?? 0 },
          { title: 'Interface', dataIndex: 'interfaceType', render: (v) => IFACE.find((o) => o.value === v)?.label ?? 'None (manual entry)' },
          {
            title: 'Integration',
            dataIndex: 'integrationStatus',
            // Live from the connector once a token exists; otherwise the status set by hand.
            render: (v: Machine['integrationStatus'], m) =>
              m.ingestTokenHash ? (
                <ConnectorStatus machine={m} />
              ) : (
                <StatusChip variant={v === 'connected' ? 'success' : v === 'offline' ? 'urgent' : v === 'pending' ? 'caution' : 'neutral'}>
                  {STATUS.find((o) => o.value === (v ?? 'none'))?.label}
                </StatusChip>
              ),
          },
          {
            title: '',
            render: (_, m) =>
              canEdit && (
                <div className="st-actions">
                  <Button variant="text" onClick={() => setEditing(m)}>Edit</Button>
                  <ConnectAnalyserButton machine={m} who={profile?.name ?? ''} disabled={!canEdit} />
                  <Button variant="text" disabled={!canDelete} onClick={() => void remove(m)}>Delete</Button>
                </div>
              ),
          },
        ]}
      />
      <Modal open={!!editing} title={editing?.id ? 'Edit machine' : 'Add machine'} onCancel={() => setEditing(null)} onOk={save} okText="Save" destroyOnHidden width={dialogWidth(680)}>
        {editing && (
          <>
            <Group title="Machine">
              <div className="st-grid" style={{ ['--st-min' as string]: '200px' }}>
                <Field label="Machine name"><Input value={editing.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="Machine ID"><Input value={editing.machineCode} onChange={(e) => set({ machineCode: e.target.value })} /></Field>
                <Field label="Model"><Input value={editing.model} onChange={(e) => set({ model: e.target.value })} /></Field>
                <Field label="Serial number"><Input value={editing.serial} onChange={(e) => set({ serial: e.target.value })} /></Field>
              </div>
            </Group>
            <Group title="Department and tests">
              <div className="st-grid" style={{ ['--st-min' as string]: '200px' }}>
                <Field label="Department">
                  <Select value={editing.departmentId || undefined} onChange={(v) => set({ departmentId: v })} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
                </Field>
                <Field label="Test mapping" wide>
                  <Select mode="multiple" optionFilterProp="label" value={editing.testIds} onChange={(v) => set({ testIds: v })} options={tests.map((t) => ({ value: t.id, label: t.name }))} />
                </Field>
              </div>
            </Group>
            <Group title="Interface">
              <div className="st-grid" style={{ ['--st-min' as string]: '200px' }}>
                <Field label="Interface type"><Select value={editing.interfaceType} options={IFACE} onChange={(v) => set({ interfaceType: v })} /></Field>
                <Field label="Integration status"><Select value={editing.integrationStatus} options={STATUS} onChange={(v) => set({ integrationStatus: v })} /></Field>
              </div>
              <SwitchRow title="Active" description="Inactive machines are hidden from QC and result entry." checked={editing.active !== false} onChange={(v) => set({ active: v })} />
            </Group>
          </>
        )}
      </Modal>
    </SectionCard>
  )
}
