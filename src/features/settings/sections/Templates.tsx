import { Input } from 'antd'
import { fillTemplate } from '../../../lib/messaging'
import { PREVIEW_VARS } from '../constants'
import { Field, SectionCard, useDraft } from '../ui'

const MAIN = [
  { name: 'reportReady', label: 'Report to patient (WhatsApp / SMS)', vars: ['patientName', 'labName', 'billNo', 'link'] },
  { name: 'bookingConfirmed', label: 'Booking confirmed', vars: ['patientName', 'labName', 'bookingId', 'slot'] },
  { name: 'collectorAssigned', label: 'Collector assigned', vars: ['patientName', 'labName', 'bookingId', 'slot', 'collectorName'] },
] as const
const EXTRA = [
  { name: 'smsReportReady', label: 'SMS: report ready', vars: ['patientName', 'labName', 'billNo', 'link'] },
  { name: 'emailSubject', label: 'Email subject', vars: ['labName', 'billNo'], single: true },
  { name: 'emailBody', label: 'Email body', vars: ['patientName', 'labName', 'billNo', 'link'] },
  { name: 'waReportFromB2b', label: 'WhatsApp: report from B2B centre', vars: ['patientName', 'labName', 'link'] },
  { name: 'waReportFromCentre', label: 'WhatsApp: report from collection centre', vars: ['patientName', 'labName', 'link'] },
  { name: 'waReportToB2b', label: 'WhatsApp: report to B2B centre', vars: ['patientName', 'billNo', 'link'] },
] as const

function Preview({ text }: { text: string }) {
  return <div className="st-preview"><strong>Preview: </strong>{fillTemplate(text ?? '', PREVIEW_VARS)}</div>
}

export function Templates() {
  const { draft, set } = useDraft()
  const chips = (vars: readonly string[]) => (
    <span className="st-field__hint">Variables: {vars.map((v) => `{${v}}`).join(' ')}</span>
  )
  return (
    <>
      <SectionCard title="WhatsApp business templates" description="Names of the templates approved in WhatsApp Manager (Meta requires these for business-initiated messages).">
        <div className="st-grid">
          <Field label="Report template name"><Input value={draft.templates.waReportTemplate} onChange={(e) => set(['templates', 'waReportTemplate'], e.target.value)} /></Field>
          <Field label="Booking template name"><Input value={draft.templates.waBookingTemplate} onChange={(e) => set(['templates', 'waBookingTemplate'], e.target.value)} /></Field>
        </div>
      </SectionCard>
      <SectionCard title="Messages" description="Message bodies with {placeholders}. The preview uses sample data.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          {MAIN.map((t) => (
            <Field key={t.name} label={t.label} hint={undefined}>
              <Input.TextArea rows={2} value={draft.templates[t.name]} onChange={(e) => set(['templates', t.name], e.target.value)} />
              {chips(t.vars)}
              <Preview text={draft.templates[t.name]} />
            </Field>
          ))}
          {EXTRA.map((t) => (
            <Field key={t.name} label={t.label}>
              {'single' in t ? (
                <Input value={draft.extraTemplates[t.name]} onChange={(e) => set(['extraTemplates', t.name], e.target.value)} />
              ) : (
                <Input.TextArea rows={3} value={draft.extraTemplates[t.name]} onChange={(e) => set(['extraTemplates', t.name], e.target.value)} />
              )}
              {chips(t.vars)}
              <Preview text={draft.extraTemplates[t.name]} />
            </Field>
          ))}
        </div>
      </SectionCard>
    </>
  )
}
