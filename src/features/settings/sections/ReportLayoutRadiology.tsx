import { Input, InputNumber } from 'antd'
import { Button } from '../../../design/Button'
import { mergeRadConfig, DEFAULT_MODALITIES } from '../../radiology/config'
import type { PcpndtSettings, RadiologyConfig } from '../../../types'
import { Field, SectionCard, SwitchRow, useDraft } from '../ui'

// Radiology settings: modality (DICOM) codes, viewer base URL, accession barcode, autosave, outside readers.
export function ReportLayoutRadiology() {
  const { draft, set, canEdit } = useDraft()
  const c = mergeRadConfig(draft.radiologyConfig)
  const put = (patch: Partial<RadiologyConfig>) => set(['radiologyConfig'], { ...(draft.radiologyConfig ?? {}), ...patch })
  const mods = c.modalities
  const readers = c.externalReaders
  const viewerBad = !!c.viewerBaseUrl && !/^https:\/\/[^\s@]+$/.test(c.viewerBaseUrl)
  return (
    <>
      <SectionCard title="Radiology modalities" description="DICOM modality code and the name shown on the worklist. Link a test to a modality in the test editor.">
        <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
          {mods.map((m, i) => (
            <div key={i} className="st-actions">
              <Input style={{ width: 90 }} aria-label="Modality code" placeholder="Code" maxLength={8} value={m.code} disabled={!canEdit} onChange={(e) => put({ modalities: mods.map((x, k) => (k === i ? { ...x, code: e.target.value.toUpperCase() } : x)) })} />
              <Input style={{ width: 220 }} aria-label="Modality name" placeholder="Name" value={m.label} disabled={!canEdit} onChange={(e) => put({ modalities: mods.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
              {canEdit && <Button onClick={() => put({ modalities: mods.filter((_, k) => k !== i) })}>Remove</Button>}
            </div>
          ))}
        </div>
        {canEdit && (
          <div className="st-actions" style={{ marginTop: 'var(--s-3)' }}>
            <Button onClick={() => put({ modalities: [...mods, { code: '', label: '' }] })}>Add modality</Button>
            <Button onClick={() => put({ modalities: DEFAULT_MODALITIES })}>Restore the standard list</Button>
          </div>
        )}
      </SectionCard>
      <SectionCard title="Viewer, barcode and autosave">
        <div className="st-grid">
          <Field label="DICOM viewer base URL" hint="https only, no tokens. The study UID is added at the end, or put {studyUid} where it belongs." wide>
            <Input status={viewerBad ? 'error' : undefined} disabled={!canEdit} value={c.viewerBaseUrl} placeholder="https://viewer.yourlab.com/study/{studyUid}" onChange={(e) => put({ viewerBaseUrl: e.target.value })} />
          </Field>
          <Field label="Autosave every (seconds)" hint="0 turns autosave off."><InputNumber min={0} max={600} style={{ width: '100%' }} disabled={!canEdit} value={c.autosaveSeconds} onChange={(v) => put({ autosaveSeconds: v ?? 0 })} /></Field>
        </div>
        <SwitchRow title="Print the accession barcode on radiology reports" description="Also shows the accession number on the worklist." checked={c.accessionBarcode} onChange={(v) => put({ accessionBarcode: v })} />
      </SectionCard>
      <SectionCard title="Outside consultants" description="Saved names and emails offered when asking for an external second opinion.">
        <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
          {readers.map((r, i) => (
            <div key={r.id} className="st-actions">
              <Input style={{ width: 200 }} aria-label="Consultant name" placeholder="Name" value={r.name} disabled={!canEdit} onChange={(e) => put({ externalReaders: readers.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
              <Input style={{ width: 240 }} aria-label="Consultant email" type="email" placeholder="Email" value={r.email} disabled={!canEdit} onChange={(e) => put({ externalReaders: readers.map((x, k) => (k === i ? { ...x, email: e.target.value } : x)) })} />
              {canEdit && <Button onClick={() => put({ externalReaders: readers.filter((_, k) => k !== i) })}>Remove</Button>}
            </div>
          ))}
        </div>
        {canEdit && <div className="st-actions" style={{ marginTop: 'var(--s-3)' }}><Button onClick={() => put({ externalReaders: [...readers, { id: `er${Date.now().toString(36)}`, name: '', email: '', active: true }] })}>Add consultant</Button></div>}
      </SectionCard>
    </>
  )
}

export function ReportLayoutPcpndt() {
  const { draft, set, canEdit } = useDraft()
  const c: PcpndtSettings = { blockReport: true, clinicName: '', registrationNo: '', ...(draft.pcpndt ?? {}) }
  const put = (patch: Partial<PcpndtSettings>) => set(['pcpndt'], { ...(draft.pcpndt ?? {}), ...patch })
  return (
    <SectionCard title="PCPNDT (Form F)" description="Bills with a PCPNDT test need a completed Form F before the ultrasound report is released.">
      <SwitchRow title="Block the ultrasound report until Form F is complete" description="Printing, sending and radiology sign-off all wait. Turn off only if your authority allows it." checked={c.blockReport !== false} onChange={(v) => put({ blockReport: v })} />
      <div className="st-grid" style={{ marginTop: 'var(--s-3)' }}>
        <Field label="Clinic name on Form F"><Input disabled={!canEdit} value={c.clinicName ?? ''} onChange={(e) => put({ clinicName: e.target.value })} /></Field>
        <Field label="Registration number"><Input disabled={!canEdit} value={c.registrationNo ?? ''} onChange={(e) => put({ registrationNo: e.target.value })} /></Field>
      </div>
    </SectionCard>
  )
}
