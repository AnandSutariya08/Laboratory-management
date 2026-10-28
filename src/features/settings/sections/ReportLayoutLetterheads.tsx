import { Input, Select } from 'antd'
import { Button } from '../../../design/Button'
import { Card } from '../../../design/Card'
import { EmptyState } from '../../../design/EmptyState'
import type { Letterhead } from '../../../types'
import { Field, Group, ImagePicker, SectionCard, SwitchRow } from '../ui'
import { useLayoutDraft } from './ReportLayout'

// Letterhead library (RP-06): named header and footer images. A letterhead can be picked when printing,
// when sending, or set as the default for every report.
export function ReportLayoutLetterheads() {
  const { L, put, canEdit } = useLayoutDraft()
  const list = L.letterheads as Letterhead[]
  const update = (id: string, patch: Partial<Letterhead>) => put('letterheads', list.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  const add = () => put('letterheads', [...list, { id: `lh${Date.now().toString(36)}`, name: `Letterhead ${list.length + 1}`, headerDataUrl: '', footerDataUrl: '', firstPageOnly: false, active: true }])
  return (
    <SectionCard
      title="Letterhead library"
      description="Header and footer images for reports. Choose one while printing or sending, or make one the default."
      extra={canEdit && <Button variant="primary" onClick={add}>New letterhead</Button>}
    >
      {list.length === 0 ? (
        <EmptyState title="No letterheads yet" description="Without one, reports use the lab header image or the lab name and address." />
      ) : (
        <>
          <div className="st-grid" style={{ marginBottom: 'var(--s-5)' }}>
            <Field label="Default letterhead" hint="Applied to every report unless another is chosen.">
              <Select allowClear value={L.defaultLetterheadId || undefined} onChange={(v) => put('defaultLetterheadId', v ?? '')} placeholder="None"
                options={list.filter((l) => l.active !== false).map((l) => ({ value: l.id, label: l.name }))} />
            </Field>
          </div>
          <div className="st-sublist">
            {list.map((l) => (
              <Card key={l.id} padding="var(--s-5)">
                <Group title={l.name || 'Letterhead'}>
                  <div className="st-grid">
                    <Field label="Name"><Input value={l.name} onChange={(e) => update(l.id, { name: e.target.value })} /></Field>
                  </div>
                  <div className="st-grid" style={{ ['--st-min' as string]: '320px' }}>
                    <Field label="Header image"><ImagePicker label="header" value={l.headerDataUrl} onChange={(v) => update(l.id, { headerDataUrl: v })} /></Field>
                    <Field label="Footer image"><ImagePicker label="footer" value={l.footerDataUrl} onChange={(v) => update(l.id, { footerDataUrl: v })} /></Field>
                  </div>
                  <SwitchRow title="Active" description="Inactive letterheads are not offered when printing or sending." checked={l.active !== false} onChange={(v) => update(l.id, { active: v })} />
                </Group>
                {canEdit && (
                  <div className="st-item__foot" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
                    <Button onClick={() => { put('letterheads', list.filter((x) => x.id !== l.id)); if (L.defaultLetterheadId === l.id) put('defaultLetterheadId', '') }}>Delete letterhead</Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  )
}
