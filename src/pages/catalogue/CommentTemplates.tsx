import { useState } from 'react'
import { App, Input, Modal, Select } from 'antd'
import { setDoc } from 'firebase/firestore'
import { useLabSettings } from '../../hooks/useCatalogue'
import { labDoc } from '../../lib/db'
import { Button } from '../../design/Button'
import type { CommentTemplate } from '../../types'

// Named comment templates (CAT-36): saved on the lab document, picked in the test editor (and result entry)
// to fill a comment in one click. Several templates can be switched between; the text stays editable.

export const useCommentTemplates = (): CommentTemplate[] => useLabSettings().commentTemplates ?? []

const save = (list: CommentTemplate[]) => setDoc(labDoc(), { commentTemplates: list }, { merge: true })

export function CommentTemplatePicker({ onPick, disabled }: { onPick: (text: string) => void; disabled?: boolean }) {
  const list = useCommentTemplates()
  const [manage, setManage] = useState(false)
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Select
        style={{ width: 240 }}
        aria-label="Comment template"
        placeholder={list.length ? 'Use a comment template' : 'No templates yet'}
        value={null as unknown as string}
        disabled={disabled || !list.length}
        options={list.map((t) => ({ value: t.id, label: t.name }))}
        onChange={(id) => { const t = list.find((x) => x.id === id); if (t) onPick(t.text) }}
      />
      <Button variant="text" disabled={disabled} onClick={() => setManage(true)}>Manage templates</Button>
      <ManageCommentTemplates open={manage} onClose={() => setManage(false)} />
    </span>
  )
}

export function ManageCommentTemplates({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message, modal } = App.useApp()
  const list = useCommentTemplates()
  const [editing, setEditing] = useState<CommentTemplate | null>(null)

  const commit = async () => {
    if (!editing) return
    if (!editing.name.trim() || !editing.text.trim()) return message.error('Give the template a name and a text')
    const next = list.some((t) => t.id === editing.id) ? list.map((t) => (t.id === editing.id ? editing : t)) : [...list, editing]
    try {
      await save(next.map((t) => ({ ...t, name: t.name.trim() })))
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const del = (t: CommentTemplate) =>
    modal.confirm({ title: `Delete template "${t.name}"?`, okButtonProps: { danger: true }, onOk: () => save(list.filter((x) => x.id !== t.id)) })

  return (
    <Modal title="Comment templates" open={open} onCancel={onClose} footer={null} destroyOnHidden>
      {editing ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <Input aria-label="Template name" placeholder="Template name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <Input.TextArea aria-label="Template text" rows={5} placeholder="Comment text" value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void commit()}>Save template</Button>
          </div>
        </div>
      ) : (
        <>
          <Button onClick={() => setEditing({ id: `ct-${Date.now().toString(36)}`, name: '', text: '' })}>New template</Button>
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {list.length === 0 && <li style={{ opacity: 0.7 }}>No templates yet.</li>}
            {list.map((t) => (
              <li key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ flex: 1 }}><b>{t.name}</b><br /><span style={{ opacity: 0.7 }}>{t.text.slice(0, 80)}</span></span>
                <Button variant="text" onClick={() => setEditing(t)}>Edit</Button>
                <Button variant="text" onClick={() => del(t)}>Delete</Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}
