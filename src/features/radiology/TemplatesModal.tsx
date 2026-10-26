import { useState } from 'react'
import { App, Input, Modal, Select, Table } from 'antd'
import { addDoc, deleteDoc, query, serverTimestamp, updateDoc, where } from 'firebase/firestore'
import { col, docRef } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { MODALITIES } from './lib'
import RichText from './richtext'
import type { RadMacro, RadTemplate } from './types'
import './radiology.css'
import { dialogWidth } from '../../design/dialog'

export const useRadTemplates = () =>
  useLiveQuery<RadTemplate>(query(col<RadTemplate>('reportTemplates'), where('kind', '==', 'radiology')), []).data

export const useRadMacros = () =>
  useLiveQuery<RadMacro>(query(col<RadMacro>('reportTemplates'), where('kind', '==', 'radMacro')), []).data

const BLANK = { name: '', modality: 'X-Ray', variant: 'normal' as 'normal' | 'abnormal', technique: '', findings: '', impression: '', active: true }

export default function TemplatesModal({ open, onClose, canEdit }: { open: boolean; onClose: () => void; canEdit: boolean }) {
  const { message, modal } = App.useApp()
  const templates = useRadTemplates()
  const [editing, setEditing] = useState<(Partial<RadTemplate> & typeof BLANK) | null>(null)

  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) return message.error('Give the template a name')
    const { id, ...rest } = editing as RadTemplate
    try {
      if (id) await updateDoc(docRef('reportTemplates', id), { ...rest, kind: 'radiology' })
      else await addDoc(col('reportTemplates'), { ...rest, kind: 'radiology', createdAt: serverTimestamp() })
      setEditing(null)
      message.success('Template saved')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save the template (managers and admins only)')
    }
  }
  const remove = (t: RadTemplate) =>
    modal.confirm({
      title: `Delete template "${t.name}"?`,
      okButtonProps: { danger: true },
      okText: 'Delete',
      onOk: async () => {
        try {
          await deleteDoc(docRef('reportTemplates', t.id))
        } catch (e) {
          message.error(e instanceof Error ? e.message : 'Could not delete')
        }
      },
    })

  return (
    <>
      <Modal open={open} onCancel={onClose} footer={null} width={dialogWidth(760)} title="Radiology report templates" destroyOnHidden>
        {canEdit && <div style={{ marginBottom: 'var(--s-3)' }}><Button variant="primary" onClick={() => setEditing({ ...BLANK })}>New template</Button></div>}
        {templates.length === 0 ? (
          <EmptyState title="No templates yet" description="Templates pre-fill the technique, findings and impression of a report." />
        ) : (
          <Table<RadTemplate>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={templates}
            columns={[
              { title: 'Name', dataIndex: 'name' },
              { title: 'Modality', dataIndex: 'modality', width: 120 },
              { title: 'Variant', width: 100, render: (_: unknown, t: RadTemplate) => (t.variant === 'abnormal' ? 'Abnormal' : 'Normal') },
              { title: 'Status', width: 100, render: (_, t) => <StatusChip variant={t.active === false ? 'neutral' : 'success'}>{t.active === false ? 'Inactive' : 'Active'}</StatusChip> },
              ...(canEdit
                ? [{ title: '', width: 150, render: (_: unknown, t: RadTemplate) => (
                    <span className="rd-actions">
                      <Button onClick={() => setEditing({ ...BLANK, ...t })}>Edit</Button>
                      <Button onClick={() => remove(t)} aria-label={`Delete ${t.name}`}>Delete</Button>
                    </span>
                  ) }]
                : []),
            ]}
          />
        )}
      </Modal>
      <Modal open={!!editing} onCancel={() => setEditing(null)} title={editing?.id ? 'Edit template' : 'New template'} okText="Save" onOk={save} width={dialogWidth(640)} destroyOnHidden>
        {editing && (
          <>
            <div className="rd-field"><label htmlFor="tp-name">Name</label><Input id="tp-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
            <div className="rd-field"><label htmlFor="tp-mod">Modality</label><Select id="tp-mod" value={editing.modality} onChange={(v) => setEditing({ ...editing, modality: v })} options={MODALITIES.map((m) => ({ value: m, label: m }))} /></div>
            <div className="rd-field"><label htmlFor="tp-var">Variant</label><Select id="tp-var" value={editing.variant ?? 'normal'} onChange={(v) => setEditing({ ...editing, variant: v })} options={[{ value: 'normal', label: 'Normal' }, { value: 'abnormal', label: 'Abnormal' }]} /></div>
            <RichText id="tp-tech" label="Technique" minHeight={50} value={editing.technique} onChange={(v) => setEditing({ ...editing, technique: v })} />
            <RichText id="tp-find" label="Findings" minHeight={120} value={editing.findings} onChange={(v) => setEditing({ ...editing, findings: v })} />
            <RichText id="tp-imp" label="Impression" minHeight={70} value={editing.impression} onChange={(v) => setEditing({ ...editing, impression: v })} />
            <label><input type="checkbox" checked={editing.active !== false} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>
          </>
        )}
      </Modal>
    </>
  )
}
