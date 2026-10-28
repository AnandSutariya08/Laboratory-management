import { useState } from 'react'
import { App, Modal } from 'antd'
import { addDoc, serverTimestamp } from 'firebase/firestore'
import { useAuth } from '../auth/AuthProvider'
import { branchStamp } from '../lib/activeBranch'
import { col } from '../lib/db'
import { dialogWidth } from '../design/dialog'
import { FormSection } from '../design/FormLayout'

export type TicketType = 'ticket' | 'idea' | 'feedback'

/** Writes a supportTickets document (type ticket / idea / feedback). */
export async function createTicket(t: { subject: string; description: string; priority?: 'low' | 'normal' | 'high'; type?: TicketType; uid: string; name: string }) {
  await addDoc(col('supportTickets'), {
    subject: t.subject.trim(),
    description: t.description.trim(),
    priority: t.priority ?? 'normal',
    status: 'open',
    type: t.type ?? 'ticket',
    ...branchStamp(),
    createdBy: t.uid,
    createdByName: t.name,
    createdAt: serverTimestamp(),
  })
}

export default function SupportTicketModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      await createTicket({ subject, description, priority, uid: user?.uid ?? '', name: profile?.name ?? '' })
      message.success('Ticket sent. The lab admin will follow up.')
      setSubject('')
      setDescription('')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Support ticket" open={open} onCancel={onClose} onOk={submit} okText="Send ticket" confirmLoading={busy} okButtonProps={{ disabled: !subject.trim() || !description.trim() }} destroyOnHidden width={dialogWidth(560)}>
      <FormSection title="Tell us what happened" description="The lab admin sees this ticket and follows up.">
      <div className="field-row">
        <label htmlFor="tk-subject">Subject</label>
        <input id="tk-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
      </div>
      <div className="field-row">
        <label htmlFor="tk-desc">What happened?</label>
        <textarea id="tk-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field-row">
        <label htmlFor="tk-prio">Priority</label>
        <select id="tk-prio" value={priority} onChange={(e) => setPriority(e.target.value as 'low' | 'normal' | 'high')}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High, work is blocked</option>
        </select>
      </div>
      </FormSection>
    </Modal>
  )
}
