import { useState } from 'react'
import { App, Input, Modal, Table } from 'antd'
import { addDoc, deleteDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { col, docRef } from '../../lib/db'
import { useAuth } from '../../auth/AuthProvider'
import { Segmented } from '../../design/Segmented'
import { USER_MACROS, useMyMacros } from './userMacros'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { useRadMacros } from './TemplatesModal'
import type { RadMacro } from './types'
import './radiology.css'
import { dialogWidth } from '../../design/dialog'

const BLANK = { label: '', text: '', active: true }

// Lab macros live in `reportTemplates` with kind 'radMacro'. Tokens: {{patientName}} {{age}} {{gender}} {{date}}.
export default function MacrosModal({ open, onClose, canEdit }: { open: boolean; onClose: () => void; canEdit: boolean }) {
  const { message, modal } = App.useApp()
  const { user, profile } = useAuth()
  const uid = user?.uid ?? profile?.uid ?? ''
  const [scope, setScope] = useState<'mine' | 'lab'>('mine')
  const labMacros = useRadMacros()
  const myMacros = useMyMacros()
  const macros = scope === 'mine' ? myMacros : labMacros
  // Personal macros: anyone may keep their own; lab macros need the catalogue permission.
  const mayEdit = scope === 'mine' || canEdit
  const collName = scope === 'mine' ? USER_MACROS : 'reportTemplates'
  const [editing, setEditing] = useState<(Partial<RadMacro> & typeof BLANK) | null>(null)

  const save = async () => {
    if (!editing) return
    if (!editing.label.trim() || !editing.text.trim()) return message.error('Give the macro a label and text')
    const { id, ...rest } = editing as RadMacro
    try {
      if (id) await updateDoc(docRef(collName, id), { ...rest, kind: 'radMacro' })
      else await addDoc(col(collName), { ...rest, kind: 'radMacro', ...(scope === 'mine' ? { ownerUid: uid } : {}), createdAt: serverTimestamp() })
      setEditing(null)
      message.success('Macro saved')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save the macro (managers and admins only)')
    }
  }
  const remove = (m: RadMacro) =>
    modal.confirm({
      title: `Delete macro "${m.label}"?`,
      okButtonProps: { danger: true },
      okText: 'Delete',
      onOk: async () => {
        try {
          await deleteDoc(docRef(collName, m.id))
        } catch (e) {
          message.error(e instanceof Error ? e.message : 'Could not delete')
        }
      },
    })

  return (
    <>
      <Modal open={open} onCancel={onClose} footer={null} width={dialogWidth(680)} title="Radiology macros" destroyOnHidden>
        <div style={{ marginBottom: 'var(--s-3)' }}>
          <Segmented<'mine' | 'lab'> aria-label="Whose macros" value={scope} onChange={setScope} options={[{ value: 'mine', label: 'My macros' }, { value: 'lab', label: 'Lab macros' }]} />
        </div>
        <p className="rd-muted">{scope === 'mine' ? 'Only you see these.' : 'Everyone in the lab sees these.'} Built-in macros are always available. Add your own snippets here; tokens like {'{{patientName}}'}, {'{{age}}'}, {'{{gender}}'} and {'{{date}}'} are filled when inserted.</p>
        {mayEdit && <div style={{ marginBottom: 'var(--s-3)' }}><Button variant="primary" onClick={() => setEditing({ ...BLANK })}>New macro</Button></div>}
        {macros.length === 0 ? (
          <EmptyState title={scope === 'mine' ? 'No personal macros yet' : 'No lab macros yet'} description="Macros appear in the Macros dropdown of the report editor." />
        ) : (
          <Table<RadMacro>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={macros}
            columns={[
              { title: 'Label', dataIndex: 'label', width: 180 },
              { title: 'Text', dataIndex: 'text', ellipsis: true },
              { title: 'Status', width: 90, render: (_, m) => <StatusChip variant={m.active === false ? 'neutral' : 'success'}>{m.active === false ? 'Inactive' : 'Active'}</StatusChip> },
              ...(mayEdit
                ? [{ title: '', width: 150, render: (_: unknown, m: RadMacro) => (
                    <span className="rd-actions">
                      <Button onClick={() => setEditing({ ...BLANK, ...m })}>Edit</Button>
                      <Button onClick={() => remove(m)} aria-label={`Delete ${m.label}`}>Delete</Button>
                    </span>
                  ) }]
                : []),
            ]}
          />
        )}
      </Modal>
      <Modal open={!!editing} onCancel={() => setEditing(null)} title={editing?.id ? 'Edit macro' : 'New macro'} okText="Save" onOk={save} destroyOnHidden>
        {editing && (
          <>
            <div className="rd-field"><label htmlFor="mc-label">Label</label><Input id="mc-label" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} /></div>
            <div className="rd-field"><label htmlFor="mc-text">Text</label><Input.TextArea id="mc-text" rows={4} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} /></div>
            <label><input type="checkbox" checked={editing.active !== false} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>
          </>
        )}
      </Modal>
    </>
  )
}
