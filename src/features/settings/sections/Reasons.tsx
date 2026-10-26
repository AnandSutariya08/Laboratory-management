import { useState } from 'react'
import { App, Input, Select } from 'antd'
import { addDoc, deleteDoc, updateDoc } from 'firebase/firestore'
import { Button } from '../../../design/Button'
import { useLiveQuery } from '../../../hooks/useLive'
import { col, docRef } from '../../../lib/db'
import type { ReasonDoc } from '../../../lib/masters'
import { SectionCard, useDraft } from '../ui'

// Picklists offered by the delete, discount, reject, hold, re-run, amend, send-back and out-of-TAT dialogs.
const KINDS = [
  { value: 'void', label: 'Delete / cancel bill' },
  { value: 'discount', label: 'Discount' },
  { value: 'reject', label: 'Sample or test rejection' },
  { value: 'hold', label: 'Result on hold' },
  { value: 'rerun', label: 'Re-run' },
  { value: 'amend', label: 'Amend approved result' },
  { value: 'sendback', label: 'Send back to technician' },
  { value: 'outOfTat', label: 'Out of TAT' },
]

export function Reasons() {
  const { message } = App.useApp()
  const { canEdit } = useDraft()
  const { data } = useLiveQuery<ReasonDoc>(col('reasons'), [])
  const [kind, setKind] = useState('void')
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const run = (p: Promise<unknown>) => p.catch((e: Error) => message.error(e.message))
  const list = data.filter((r) => r.kind === kind).sort((a, b) => a.text.localeCompare(b.text))

  const add = async () => {
    const t = text.trim()
    if (!t) return
    if (list.some((r) => r.text.toLowerCase() === t.toLowerCase())) return message.error('That reason already exists')
    await run(addDoc(col('reasons'), { kind, text: t }))
    setText('')
  }
  const save = async () => {
    if (!editing) return
    const t = editing.text.trim()
    if (!t) return message.error('Reason cannot be empty')
    await run(updateDoc(docRef('reasons', editing.id), { text: t }))
    setEditing(null)
  }

  return (
    <SectionCard title="Reasons" description="Reasons staff pick from when they delete a bill, give a discount, reject a sample, hold, re-run or amend a result. Staff can still type their own.">
      <div className="st-actions" style={{ marginBottom: 'var(--s-4)' }}>
        <Select aria-label="Reason type" style={{ width: 260 }} value={kind} onChange={(v) => { setKind(v); setEditing(null) }} options={KINDS} />
        <span className="st-field__hint">{list.length} reason{list.length === 1 ? '' : 's'}</span>
      </div>
      {list.map((r) => (
        <div className="st-row" key={r.id}>
          {editing?.id === r.id ? (
            <Input style={{ maxWidth: 360 }} value={editing.text} autoFocus aria-label="Edit reason"
              onChange={(e) => setEditing({ id: r.id, text: e.target.value })} onPressEnter={save} />
          ) : (
            <div className="st-row__title">{r.text}</div>
          )}
          {canEdit && (
            <div className="st-actions">
              {editing?.id === r.id ? (
                <>
                  <Button onClick={save}>Save</Button>
                  <Button variant="text" onClick={() => setEditing(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <Button variant="text" onClick={() => setEditing({ id: r.id, text: r.text })}>Edit</Button>
                  <Button variant="text" onClick={() => run(deleteDoc(docRef('reasons', r.id)))}>Delete</Button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {canEdit && (
        <div className="st-actions" style={{ marginTop: 'var(--s-4)' }}>
          <Input style={{ maxWidth: 360 }} value={text} onChange={(e) => setText(e.target.value)} onPressEnter={add} placeholder="New reason" aria-label="New reason" />
          <Button onClick={add}>Add reason</Button>
        </div>
      )}
    </SectionCard>
  )
}
