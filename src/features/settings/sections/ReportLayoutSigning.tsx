import { InputNumber, Select } from 'antd'
import { col, paths } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import { Card } from '../../../design/Card'
import { EmptyState } from '../../../design/EmptyState'
import type { Signatory, UserProfile } from '../../../types'
import { Field, Group, ImagePicker, SectionCard, SwitchRow, useDraft } from '../ui'
import { useLayoutDraft } from './ReportLayout'

// Signatory rules (SET-14, PRO-08): fixed vs "by user" signing, the user behind each signatory, auto-sign,
// the stamp image and the most signatures printed on one report.
export function ReportLayoutSigning() {
  const { draft, set } = useDraft()
  const { L, put, canEdit } = useLayoutDraft()
  const users = useLiveQuery<UserProfile>(col<UserProfile>(paths.users), []).data.filter((u) => u.active)
  const list: Signatory[] = draft.signatories
  const update = (id: string, patch: Partial<Signatory>) => set(['signatories'], list.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  return (
    <>
      <SectionCard title="Signing rules" description="Who signs an approved test. Add the doctors under Doctor details first.">
        <div className="st-grid">
          <Field label="Signing mode" hint="Fixed: the signatory chosen on the test, bill or department default. By user: the signatory linked to the person who approves.">
            <Select disabled={!canEdit} value={L.signatoryMode} onChange={(v) => put('signatoryMode', v)} options={[{ value: 'fixed', label: 'Fixed signatory' }, { value: 'byUser', label: 'By user (the approver signs)' }]} />
          </Field>
          <Field label="Most signatures on one report"><InputNumber min={1} max={6} style={{ width: '100%' }} value={L.maxSignatures} onChange={(v) => put('maxSignatures', v ?? 3)} /></Field>
        </div>
        <SwitchRow title="Print the stamp image beside the signature" description="Uses the stamp uploaded for each doctor below." checked={L.showStamp} onChange={(v) => put('showStamp', v)} />
      </SectionCard>
      <SectionCard title="Signatory users, auto-sign and stamp">
        {list.length === 0 ? (
          <EmptyState title="No signing doctors yet" description="Add them under Lab profile, Doctor details." />
        ) : (
          <div className="st-sublist">
            {list.map((s) => (
              <Card key={s.id} padding="var(--s-5)">
                <Group title={s.name || 'Unnamed doctor'}>
                <div className="st-grid">
                  <Field label="Linked user" hint="Used by the by-user rule.">
                    <Select allowClear showSearch optionFilterProp="label" disabled={!canEdit} value={s.userId || undefined} onChange={(v) => update(s.id, { userId: v ?? '' })}
                      options={users.map((u) => ({ value: u.uid, label: `${u.name} (${u.role})` }))} placeholder="No linked user" />
                  </Field>
                  <Field label="Stamp" wide><ImagePicker label="stamp" value={s.stampDataUrl ?? ''} onChange={(v) => update(s.id, { stampDataUrl: v })} /></Field>
                </div>
                <SwitchRow title="Auto-sign" description="Signs when no other rule picks a signatory." disabled={!canEdit} checked={!!s.autoSign} onChange={(v) => set(['signatories'], list.map((x) => ({ ...x, autoSign: x.id === s.id ? v : v ? false : x.autoSign })))} />
                </Group>
              </Card>
            ))}
          </div>
        )}
      </SectionCard>
    </>
  )
}
