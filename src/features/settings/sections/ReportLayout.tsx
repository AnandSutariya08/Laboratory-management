import { App, Input, InputNumber, Select } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined } from '@ant-design/icons'
import { Button } from '../../../design/Button'
import { COLUMN_DEFAULT_WIDTH, COLUMN_LABEL, DEFAULT_LAYOUT, FIELD_LABELS, HEADER_FIELDS, mergeLayout, type FullLayout } from '../../report/layout'
import { PreviewButton } from '../Preview'
import { Field, Group, SectionCard, SwitchRow, useDraft } from '../ui'
import type { ReportColumnKey } from '../../../types'

// Lab profile > Report layout: fonts, column order and widths, logo size, age format, patient block field
// ordering (about 45 fields), the extra report toggles and Reset to default. Stored in `reportLayout` on the lab doc.
export function useLayoutDraft() {
  const { draft, set, canEdit } = useDraft()
  const L = mergeLayout(draft.reportLayout)
  const putMany = (patch: Partial<FullLayout>) => set(['reportLayout'], { ...(draft.reportLayout ?? {}), ...patch })
  const put = <K extends keyof FullLayout>(k: K, v: FullLayout[K]) => putMany({ [k]: v } as Partial<FullLayout>)
  return { draft, L, put, putMany, canEdit, set }
}

const move = <T,>(list: T[], i: number, d: -1 | 1): T[] => {
  const j = i + d
  if (j < 0 || j >= list.length) return list
  const out = [...list]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

const LAYOUT_KEYS: (keyof FullLayout)[] = [
  'fontFamily', 'fontSize', 'headingSize', 'columnOrder', 'columnWidths', 'columnLabels', 'logoHeight', 'logoAlign', 'ageFormat', 'headerFields', 'headerColumns', 'showMadeWith',
  'showTestMethod', 'showMic', 'showMachineName', 'showDeptName', 'showPackageName', 'showB2bCode', 'showLabPhone', 'listPendingTests', 'boldOnly', 'reportDateOnly',
  'trendGraph', 'trendSize', 'allergyRows', 'imageHeight',
]

export function ReportLayout() {
  const { modal } = App.useApp()
  const { L, put, putMany, canEdit } = useLayoutDraft()
  const order = L.columnOrder as ReportColumnKey[]
  const reset = () =>
    modal.confirm({
      title: 'Reset the report layout to default?',
      content: 'Fonts, columns, logo size, age format, patient block and the extra toggles go back to their defaults. Letterheads and signing rules are kept. Save to apply.',
      okText: 'Reset',
      onOk: () => {
        const defaults: Partial<FullLayout> = {}
        for (const k of LAYOUT_KEYS) (defaults as Record<string, unknown>)[k] = DEFAULT_LAYOUT[k]
        defaults.columnWidths = { ...COLUMN_DEFAULT_WIDTH }
        defaults.columnLabels = { test: '', result: '', flag: '', reference: '', unit: '', method: '' }
        putMany(defaults)
      },
    })
  return (
    <>
      <SectionCard
        title="Report layout"
        description="How the printed and PDF report looks. Reports already issued keep the layout they were released with unless you re-render them from the report options."
        extra={<span className="st-actions"><PreviewButton kind="report" />{canEdit && <Button onClick={reset}>Reset to default</Button>}</span>}
      >
        <Group title="Text">
          <div className="st-grid">
            <Field label="Font"><Select value={L.fontFamily} onChange={(v) => put('fontFamily', v)} options={[{ value: 'sans', label: 'Sans serif (Arial)' }, { value: 'serif', label: 'Serif (Georgia)' }, { value: 'mono', label: 'Typewriter (Courier)' }]} /></Field>
            <Field label="Body text size"><InputNumber min={9} max={16} style={{ width: '100%' }} addonAfter="px" value={L.fontSize} onChange={(v) => put('fontSize', v ?? 12)} /></Field>
            <Field label="Test heading size"><InputNumber min={10} max={22} style={{ width: '100%' }} addonAfter="px" value={L.headingSize} onChange={(v) => put('headingSize', v ?? 14)} /></Field>
          </div>
        </Group>
        <Group title="Logo">
          <div className="st-grid">
            <Field label="Logo height"><InputNumber min={20} max={140} style={{ width: '100%' }} addonAfter="px" value={L.logoHeight} onChange={(v) => put('logoHeight', v ?? 56)} /></Field>
            <Field label="Logo position"><Select value={L.logoAlign} onChange={(v) => put('logoAlign', v)} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} /></Field>
          </div>
          <SwitchRow title='Show "Made with Health Care Labs" under the footer' description="A small credit line at the very bottom of the report." checked={L.showMadeWith} onChange={(v) => put('showMadeWith', v)} />
        </Group>
        <Group title="Patient block">
          <div className="st-grid">
            <Field label="Age format" hint="Long: 34 years. Short: 34Y. Years and months: 34Y 2M."><Select value={L.ageFormat} onChange={(v) => put('ageFormat', v)} options={[{ value: 'long', label: '34 years' }, { value: 'short', label: '34Y' }, { value: 'ymd', label: '34Y 2M' }]} /></Field>
            <Field label="Patient block columns"><Select value={L.headerColumns} onChange={(v) => put('headerColumns', v)} options={[2, 3, 4].map((n) => ({ value: n, label: `${n} columns` }))} /></Field>
          </div>
        </Group>
      </SectionCard>

      <SectionCard title="Result table columns" description="Order, width (percent) and heading of each column. Leave a heading empty for the standard one. The Method column prints only when its toggle below is on.">
        <div className="st-colrows">
          {order.map((c, i) => (
            <div key={c} className="st-colrow">
              <span className="st-colrow__name">{COLUMN_LABEL[c]}</span>
              <span className="st-colrow__move">
                <Button aria-label={`Move ${COLUMN_LABEL[c]} up`} icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => put('columnOrder', move(order, i, -1))} />
                <Button aria-label={`Move ${COLUMN_LABEL[c]} down`} icon={<ArrowDownOutlined />} disabled={i === order.length - 1} onClick={() => put('columnOrder', move(order, i, 1))} />
              </span>
              <Field label="Width"><InputNumber style={{ width: '100%' }} min={4} max={70} addonAfter="%" value={L.columnWidths[c] ?? COLUMN_DEFAULT_WIDTH[c]} onChange={(v) => put('columnWidths', { ...L.columnWidths, [c]: v ?? COLUMN_DEFAULT_WIDTH[c] })} /></Field>
              <Field label="Heading"><Input placeholder={COLUMN_LABEL[c]} value={L.columnLabels[c] ?? ''} onChange={(e) => put('columnLabels', { ...L.columnLabels, [c]: e.target.value })} /></Field>
            </div>
          ))}
        </div>
      </SectionCard>
    </>
  )
}

export function ReportLayoutFields() {
  const { draft, L, put } = useLayoutDraft()
  const effective = L.headerFields.length ? L.headerFields : draft.reportDetails.patientFields
  const rest = HEADER_FIELDS.filter((f) => !effective.includes(f.key))
  return (
    <SectionCard title="Patient block fields and order" description={`Choose and order the fields printed above the results. ${HEADER_FIELDS.length} fields are available; the first appears top left.`}>
      <ol className="st-orderlist">
        {effective.map((k, i) => (
          <li key={k} className="st-orderrow">
            <span className="st-orderrow__n">{i + 1}.</span>
            <span className="st-orderrow__name">{FIELD_LABELS[k] ?? k}</span>
            <Button aria-label={`Move ${FIELD_LABELS[k] ?? k} up`} icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => put('headerFields', move(effective, i, -1))} />
            <Button aria-label={`Move ${FIELD_LABELS[k] ?? k} down`} icon={<ArrowDownOutlined />} disabled={i === effective.length - 1} onClick={() => put('headerFields', move(effective, i, 1))} />
            <Button aria-label={`Remove ${FIELD_LABELS[k] ?? k}`} icon={<CloseOutlined />} onClick={() => put('headerFields', effective.filter((x) => x !== k))} />
          </li>
        ))}
      </ol>
      <div className="st-grid">
        <Field label="Add a field">
          <Select showSearch optionFilterProp="label" value={null as unknown as string} placeholder={`${rest.length} more fields`} onChange={(v: string) => put('headerFields', [...effective, v])}
            options={rest.map((f) => ({ value: f.key, label: `${f.label} (${f.group})` }))} />
        </Field>
      </div>
      <div className="st-actions" style={{ marginTop: 'var(--s-3)' }}>
        <Button onClick={() => put('headerFields', HEADER_FIELDS.map((f) => f.key))}>Add all fields</Button>
        <Button onClick={() => put('headerFields', [])}>Back to the basic list</Button>
      </div>
    </SectionCard>
  )
}

export function ReportLayoutToggles() {
  const { L, put } = useLayoutDraft()
  const T = (f: keyof FullLayout, title: string, description?: string) => <SwitchRow title={title} description={description} checked={!!L[f]} onChange={(v) => put(f, v as never)} />
  return (
    <SectionCard title="More report options">
      <Group title="Result table">
        {T('showTestMethod', 'Show the test method', 'Adds a Method column with the method saved on each parameter.')}
        {T('showMic', 'Show MIC values', 'Prints the MIC under a culture result when one was entered.')}
        {T('showMachineName', 'Show the machine name', 'Prints the analyser that produced the result under the test name.')}
        {T('showDeptName', 'Show department headings')}
        {T('showPackageName', 'Show the package name', 'Lists the packages on the bill under the results.')}
        {T('boldOnly', 'Bold only for abnormal values', 'Never colour abnormal values, even when the colour style is on.')}
        {T('allergyRows', 'Allergy panels: two results per row', 'Applies to tests in a department with "allergy" in its name.')}
      </Group>
      <Group title="Header and dates">
        {T('showB2bCode', 'Show the B2B centre code next to its name')}
        {T('showLabPhone', 'Show the lab phone in the header')}
        {T('reportDateOnly', 'Print dates without the time')}
        {T('listPendingTests', 'List pending tests on a partial report', 'Names the tests still awaited.')}
      </Group>
      <Group title="Trend graph and images">
        {T('trendGraph', 'Trend graph beside numeric results', 'Needs earlier results of the same patient.')}
        <div className="st-grid">
          <Field label="Trend graph size"><Select value={L.trendSize} onChange={(v) => put('trendSize', v)} options={[{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }]} /></Field>
          <Field label="Image result height"><InputNumber min={60} max={600} style={{ width: '100%' }} addonAfter="px" value={L.imageHeight} onChange={(v) => put('imageHeight', v ?? 220)} /></Field>
        </div>
      </Group>
    </SectionCard>
  )
}
