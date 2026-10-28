import { Input, InputNumber, Select } from 'antd'
import { Button } from '../../../design/Button'
import { Card } from '../../../design/Card'
import { EmptyState } from '../../../design/EmptyState'
import { StatusChip } from '../../../design/StatusChip'
import { useDepartments } from '../../../hooks/useCatalogue'
import type { Signatory } from '../../../types'
import { Field, Group, ImagePicker, SectionCard, SwitchRow, useDraft } from '../ui'

export function Doctors() {
  const { draft, set, canEdit } = useDraft()
  const departments = useDepartments().data
  const list = draft.signatories
  const update = (id: string, patch: Partial<Signatory>) => set(['signatories'], list.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const add = () =>
    set(['signatories'], [
      ...list,
      { id: crypto.randomUUID(), name: '', qualification: '', registrationNo: '', signatureDataUrl: '', hideNameInReport: false, defaultForDepartmentIds: [], active: true },
    ])
  return (
    <SectionCard
      title="Doctor details"
      description="Doctors and pathologists who sign reports. A signatory can be the default for one or more departments."
      extra={canEdit && <Button variant="primary" onClick={add}>Add doctor</Button>}
    >
      {list.length === 0 ? (
        <EmptyState title="No signing doctors yet" description="Add the pathologists whose name and signature appear on reports." />
      ) : (
        <div className="st-sublist">
          {list.map((s) => (
            <Card key={s.id} padding="var(--s-5)">
              <Group
                title={s.name || 'New doctor'}
                extra={<StatusChip variant={s.active ? 'success' : 'neutral'}>{s.active ? 'Active' : 'Inactive'}</StatusChip>}
              >
                <div className="st-grid">
                  <Field label="Name">
                    <Input value={s.name} onChange={(e) => update(s.id, { name: e.target.value })} />
                  </Field>
                  <Field label="Qualification">
                    <Input value={s.qualification} onChange={(e) => update(s.id, { qualification: e.target.value })} placeholder="MD Pathology" />
                  </Field>
                  <Field label="Registration no.">
                    <Input value={s.registrationNo} onChange={(e) => update(s.id, { registrationNo: e.target.value })} />
                  </Field>
                  <Field label="Designation">
                    <Input value={s.designation ?? ''} onChange={(e) => update(s.id, { designation: e.target.value })} placeholder="Consultant Pathologist" />
                  </Field>
                  <Field label="Default signatory for departments" wide hint="Reports from these departments are signed by this doctor unless another is chosen.">
                    <Select
                      mode="multiple"
                      value={s.defaultForDepartmentIds}
                      onChange={(v) => update(s.id, { defaultForDepartmentIds: v })}
                      options={departments.map((d) => ({ value: d.id, label: d.name }))}
                    />
                  </Field>
                </div>
              </Group>
              <Group title="Signature on the report">
                <div className="st-grid">
                  <Field label="Signature height">
                    <InputNumber min={20} max={200} style={{ width: '100%' }} addonAfter="px" value={s.signatureHeight ?? 48} onChange={(v) => update(s.id, { signatureHeight: v ?? 48 })} />
                  </Field>
                  <Field label="Alignment">
                    <Select value={s.align ?? 'left'} onChange={(v) => update(s.id, { align: v })} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} />
                  </Field>
                  <Field label="Signature image" wide>
                    <ImagePicker label="signature" value={s.signatureDataUrl} onChange={(v) => update(s.id, { signatureDataUrl: v })} />
                  </Field>
                </div>
                <SwitchRow title="Hide name in report" description="Print only the signature image, without the name underneath." checked={s.hideNameInReport} onChange={(v) => update(s.id, { hideNameInReport: v })} />
                <SwitchRow title="Active" description="Inactive doctors cannot be chosen to sign new reports." checked={s.active} onChange={(v) => update(s.id, { active: v })} />
              </Group>
              {canEdit && (
                <div className="st-item__foot" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
                  <Button variant="text" onClick={() => set(['signatories'], list.filter((x) => x.id !== s.id))}>Remove doctor</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </SectionCard>
  )
}
