import { useState } from 'react'
import { App, Input, Select } from 'antd'
import { Button } from '../../../design/Button'
import { StatusChip } from '../../../design/StatusChip'
import { confirmEmailSender, requestEmailSenderVerification } from '../../report/api'
import { useLabSettings } from '../../../hooks/useCatalogue'
import { Field, SectionCard, SwitchRow, useDraft } from '../ui'
import { useLayoutDraft } from './ReportLayout'

// Public report access (OTP, bill PIN), hard copy prompts, the WhatsApp PDF template and the email sender.
export function ReportLayoutAccess() {
  const { message } = App.useApp()
  const { draft, set, canEdit } = useDraft()
  const { L, put } = useLayoutDraft()
  const live = useLabSettings().emailSender
  const sender = { fromName: draft.emailSender?.fromName ?? '', fromEmail: draft.emailSender?.fromEmail ?? '' }
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  // Verification status is written by the server; it counts only while the address is the one that was verified.
  const status = live?.status === 'verified' && live.verifiedEmail === sender.fromEmail ? 'verified' : live?.status === 'pending' ? 'pending' : 'unverified'
  const edit = (patch: Partial<typeof sender>) => set(['emailSender'], { ...sender, ...patch })
  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      message.success(await fn())
    } catch (e) {
      message.error(((e as { message?: string }).message ?? 'Failed').replace(/\s*\[\d+\]\s*$/, ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <SectionCard title="Online report access" description="What a patient must provide to open the report link. The code is sent by WhatsApp or SMS through the same sending path as reports.">
        <div className="st-grid">
          <Field label="One-time code">
            <Select disabled={!canEdit} value={L.publicOtp} onChange={(v) => put('publicOtp', v)}
              options={[{ value: 'optional', label: 'Offered, other details still accepted' }, { value: 'required', label: 'Required (the only way in)' }, { value: 'off', label: 'Off' }]} />
          </Field>
        </div>
        <SwitchRow title="Accept the PIN printed on the bill" description="Staff can read the PIN to the patient from the report options." checked={L.publicBillPin} onChange={(v) => put('publicBillPin', v)} />
      </SectionCard>
      <SectionCard title="Dispatch">
        <SwitchRow title="Ask who received a hard copy" description="Receiver name (and an optional courier tracking number) is recorded when a hard copy is marked delivered." checked={L.hardCopyPrompt} onChange={(v) => put('hardCopyPrompt', v)} />
        <div className="st-grid" style={{ marginTop: 'var(--s-3)' }}>
          <Field label="WhatsApp template with a PDF header" hint="Name of an approved template that has a document header. When set, the report PDF is attached to WhatsApp sends. Email always carries the PDF.">
            <Input value={L.waDocTemplate} onChange={(e) => put('waDocTemplate', e.target.value)} placeholder="report_ready_pdf" />
          </Field>
        </div>
      </SectionCard>
      <SectionCard title="Email sender" description="Reports go out from the lab's shared mail address. A verified sender shows your lab name and receives the replies.">
        <div className="st-actions" style={{ marginBottom: 'var(--s-3)' }}>
          <StatusChip variant={status === 'verified' ? 'success' : status === 'pending' ? 'caution' : 'neutral'}>{status === 'verified' ? 'Verified' : status === 'pending' ? 'Verification pending' : 'Not verified'}</StatusChip>
        </div>
        <div className="st-grid">
          <Field label="Sender name"><Input disabled={!canEdit} value={sender.fromName ?? ''} onChange={(e) => edit({ fromName: e.target.value })} placeholder={draft.name} /></Field>
          <Field label="Sender email"><Input disabled={!canEdit} type="email" value={sender.fromEmail ?? ''} onChange={(e) => edit({ fromEmail: e.target.value })} placeholder="reports@yourlab.com" /></Field>
        </div>
        {canEdit && (
          <div className="st-actions" style={{ marginTop: 'var(--s-3)' }}>
            <Button disabled={busy || !(sender.fromEmail ?? '').includes('@')} onClick={() => run(async () => { const r = await requestEmailSenderVerification(sender.fromName ?? '', sender.fromEmail ?? ''); return `Code sent to ${r.to}` })}>Send verification code</Button>
            <Input style={{ width: 140 }} aria-label="Verification code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button variant="primary" disabled={busy || code.trim().length !== 6} onClick={() => run(async () => { await confirmEmailSender(code.trim()); setCode(''); return 'Sender verified' })}>Verify</Button>
          </div>
        )}
        <span className="st-field__hint">Save settings first if you changed the address, then request the code. Status updates once the code is confirmed.</span>
      </SectionCard>
    </>
  )
}
