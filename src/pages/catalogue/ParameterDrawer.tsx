import { REPORT_LANGS } from '../../features/report/i18n'
import { useEffect, useMemo, useState } from 'react'
import { AutoComplete, Button as AButton, Drawer, Form, Input, InputNumber, Select, Space, Switch } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { ageInDays, evaluateFormula, resolveRange } from '../../lib/results'
import { StatusChip } from '../../design/StatusChip'
import { FieldGrid, FormSection, SettingRow } from '../../design/FormLayout'
import type { AgeRange, AgeUnit, ParamDataType } from '../../types'
import { FIELD_TYPES, SEX_OPTIONS, TEST_METHODS, type FieldType, type ParameterExt } from './ext'

interface RangeRow {
  fromValue: number | null
  fromUnit: AgeUnit
  toValue: number | null
  toUnit: AgeUnit
  gender: 'any' | 'male' | 'female'
  low: number | null
  high: number | null
  displayText: string
}

interface ParamForm {
  key: string
  name: string
  fieldType: FieldType
  parentKey: string | null
  dataType: ParamDataType
  options: string[]
  optionFlags?: Record<string, 'normal' | 'abnormal' | 'critical'>
  defaultText?: string
  explanation?: string
  translations?: Record<string, string>
  unit: string
  low: number | null
  high: number | null
  criticalLow: number | null
  criticalHigh: number | null
  displayRange: string
  formula: string
  required: boolean
  hideOnReport: boolean
  omitFromTotal: boolean
  method: string
  machineCode: string
  decimals?: number | null
  deltaLimitPct?: number | null
  deltaLimitAbs?: number | null
  ranges: RangeRow[]
}

const UNIT_OPTIONS = [
  { value: 'year', label: 'Years' },
  { value: 'month', label: 'Months' },
  { value: 'day', label: 'Days' },
]

function daysToAge(days: number): { value: number; unit: AgeUnit } {
  const y = Math.round(days / 365.25)
  if (days > 0 && ageInDays(y, 'year') === days) return { value: y, unit: 'year' }
  const m = Math.round(days / 30.4375)
  if (days > 0 && ageInDays(m, 'month') === days) return { value: m, unit: 'month' }
  return { value: days, unit: 'day' }
}

const emptyParam = (): ParamForm => ({
  key: '', name: '', fieldType: 'single', parentKey: null, dataType: 'numeric', options: [], unit: '',
  low: null, high: null, criticalLow: null, criticalHigh: null, displayRange: '', formula: '',
  required: false, hideOnReport: false, omitFromTotal: false, method: '', machineCode: '', ranges: [],
})

const fieldTypeOf = (p: ParameterExt): FieldType => p.fieldType ?? (p.structure === 'group' ? 'multiple' : 'single')

function toForm(p: ParameterExt): ParamForm {
  return {
    ...emptyParam(),
    ...p,
    fieldType: fieldTypeOf(p),
    omitFromTotal: !!p.omitFromTotal,
    machineCode: p.machineCode ?? '',
    ranges: (p.ranges ?? []).map((r) => {
      const f = daysToAge(r.fromDays)
      const t = daysToAge(r.toDays)
      return {
        fromValue: f.value, fromUnit: f.unit, toValue: t.value, toUnit: t.unit,
        gender: ((r as AgeRange & { gender?: RangeRow['gender'] }).gender ?? 'any'),
        low: r.low, high: r.high, displayText: r.displayText,
      }
    }),
  }
}

export function fromForm(v: ParamForm): ParameterExt {
  const ft = v.fieldType ?? 'single'
  const isGroup = ft === 'multiple'
  const plain = ft === 'single'
  const ranges = (v.ranges ?? []).map((r) => ({
    fromDays: ageInDays(r.fromValue ?? 0, r.fromUnit),
    toDays: ageInDays(r.toValue ?? 0, r.toUnit),
    low: r.low ?? null,
    high: r.high ?? null,
    displayText: r.displayText ?? '',
    gender: r.gender ?? 'any',
  }))
  return {
    key: (v.key ?? '').trim().toUpperCase(),
    name: (v.name ?? '').trim(),
    structure: isGroup ? 'group' : 'single',
    fieldType: ft,
    parentKey: isGroup ? null : v.parentKey ?? null,
    dataType: plain ? v.dataType : 'text',
    unit: plain ? v.unit ?? '' : '',
    options: plain && v.dataType === 'options' ? v.options ?? [] : [],
    optionFlags: plain && v.dataType === 'options' ? Object.fromEntries(Object.entries(v.optionFlags ?? {}).filter(([k, f]) => (v.options ?? []).includes(k) && f && f !== 'normal')) as ParamForm['optionFlags'] : undefined,
    defaultText: plain && ['text', 'richText', 'options'].includes(v.dataType) ? (v.defaultText ?? '').trim() || undefined : undefined,
    low: plain ? v.low ?? null : null,
    high: plain ? v.high ?? null : null,
    ranges: plain ? ranges : [],
    criticalLow: plain ? v.criticalLow ?? null : null,
    criticalHigh: plain ? v.criticalHigh ?? null : null,
    displayRange: plain ? v.displayRange ?? '' : '',
    formula: plain ? (v.formula ?? '').trim() : '',
    required: !!v.required,
    hideOnReport: !!v.hideOnReport,
    omitFromTotal: !!v.omitFromTotal,
    method: v.method ?? '',
    machineCode: v.machineCode ?? '',
    ...(plain && v.decimals != null ? { decimals: v.decimals } : {}),
    ...(plain && v.deltaLimitPct != null ? { deltaLimitPct: v.deltaLimitPct } : {}),
    ...(plain && v.deltaLimitAbs != null ? { deltaLimitAbs: v.deltaLimitAbs } : {}),
    explanation: (v.explanation ?? '').trim() || undefined,
    translations: cleanTranslations(v.translations),
  }
}

// Keep only non-empty names per report language.
export function cleanTranslations(t?: Record<string, string>): Record<string, string> | undefined {
  const e = Object.entries(t ?? {}).map(([k, x]) => [k, (x ?? '').trim()] as const).filter(([, x]) => x)
  return e.length ? Object.fromEntries(e) : undefined
}

export function checkFormula(formula: string, selfKey: string, keys: string[]): string | null {
  const f = formula.trim()
  if (!f) return null
  let depth = 0
  for (const c of f) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (depth < 0) break
  }
  if (depth !== 0) return 'Unbalanced parentheses'
  const ids = f.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  const known = new Set(keys.filter((k) => k !== selfKey))
  const unknown = ids.find((i) => !known.has(i))
  if (unknown) return `Unknown parameter "${unknown}" (keys are case-sensitive and must belong to this test)`
  const vars: Record<string, number | null> = {}
  for (const k of known) vars[k] = 1
  try {
    if (evaluateFormula(f, vars) === null) return 'Formula could not be evaluated'
  } catch (e) {
    return (e as Error).message
  }
  return null
}

export function ParameterDrawer({
  open, initial, siblings, onClose, onSave,
}: {
  open: boolean
  initial: ParameterExt | null
  siblings: ParameterExt[]
  onClose: () => void
  onSave: (p: ParameterExt) => void
}) {
  const [form] = Form.useForm<ParamForm>()
  const [previewAge, setPreviewAge] = useState<number>(30)
  const [previewUnit, setPreviewUnit] = useState<AgeUnit>('year')

  useEffect(() => {
    if (open) form.setFieldsValue(initial ? toForm(initial) : emptyParam())
  }, [open, initial, form])

  const fieldType = Form.useWatch('fieldType', form) ?? 'single'
  const dataType = Form.useWatch('dataType', form)
  const watched = Form.useWatch([], form)
  const isGroup = fieldType === 'multiple'
  const plain = fieldType === 'single'
  const numeric = dataType === 'numeric' || dataType === 'numericUnbound'
  const siblingKeys = siblings.map((s) => s.key)

  const preview = useMemo(() => {
    if (!watched || !plain) return null
    try {
      return resolveRange(fromForm({ ...emptyParam(), ...watched }), ageInDays(previewAge, previewUnit))
    } catch {
      return null
    }
  }, [watched, plain, previewAge, previewUnit])

  const submit = async () => {
    const v = await form.validateFields()
    onSave(fromForm({ ...emptyParam(), ...form.getFieldsValue(true), ...v }))
  }

  return (
    <Drawer
      title={initial ? `Edit parameter ${initial.key}` : 'Add parameter'}
      open={open}
      onClose={onClose}
      size={760}
      destroyOnHidden
      extra={
        <Space>
          <AButton onClick={onClose}>Cancel</AButton>
          <AButton type="primary" onClick={submit}>Apply</AButton>
        </Space>
      }
    >
      <Form form={form} layout="vertical" initialValues={emptyParam()}>
        <FormSection title="Parameter" description="What this result line is called and what kind of value it holds.">
          <FieldGrid min={220}>
            <Form.Item name="fieldType" label="Field type">
              <Select options={FIELD_TYPES} />
            </Form.Item>
            <Form.Item
              name="key"
              label="Key"
              tooltip="Unique UPPERCASE id used in formulas, e.g. HB"
              normalize={(v: string) => (v ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '')}
              rules={[
                { required: true, message: 'Required' },
                { pattern: /^[A-Z][A-Z0-9_]*$/, message: 'Start with a letter; A-Z, 0-9, _ only' },
                { validator: (_, v: string) => (v && siblingKeys.includes(v) ? Promise.reject(new Error('Key already used')) : Promise.resolve()) },
              ]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            {!isGroup && (
              <Form.Item name="parentKey" label="Parent group (multiple field)">
                <Select allowClear placeholder="None" options={siblings.filter((s) => s.structure === 'group').map((s) => ({ value: s.key, label: `${s.name} (${s.key})` }))} />
              </Form.Item>
            )}
            {!isGroup && plain && (
              <Form.Item name="dataType" label="Field">
                <Select options={[
                  { value: 'numeric', label: 'Numeric' },
                  { value: 'text', label: 'Text' },
                  { value: 'numericUnbound', label: 'Numeric unbound (no range)' },
                  { value: 'options', label: 'Options (custom list)' },
                  { value: 'richText', label: 'Rich text (formatted)' },
                  { value: 'image', label: 'Image' },
                  { value: 'pdf', label: 'PDF' },
                ]} />
              </Form.Item>
            )}
            <Form.Item name="machineCode" label="Machine / LIS code"><Input /></Form.Item>
          </FieldGrid>
        </FormSection>

        {plain && (
          <FormSection title="Result entry" description="Unit, method and any pre-filled or fixed values for the technician.">
            <FieldGrid min={220}>
              <Form.Item name="unit" label="Unit"><Input /></Form.Item>
              <Form.Item name="method" label="Test method">
                <AutoComplete allowClear placeholder="Pick or type a method" options={TEST_METHODS.map((m) => ({ value: m }))} filterOption={(i, o) => (o?.value ?? '').toLowerCase().includes(i.toLowerCase())} />
              </Form.Item>
            </FieldGrid>
            {dataType === 'options' && (
              <Form.Item name="options" label="Options" rules={[{ required: true, message: 'Add at least one option' }]}>
                <Select mode="tags" tokenSeparators={[',']} placeholder="Type an option and press Enter" />
              </Form.Item>
            )}
            {dataType === 'options' && (
              <Form.Item noStyle shouldUpdate={(a, b) => a.options !== b.options}>
                {({ getFieldValue }) => {
                  const opts = (getFieldValue('options') as string[] | undefined) ?? []
                  return opts.length > 0 ? (
                    <FieldGrid min={220}>
                      {opts.map((o) => (
                        <Form.Item key={o} name={['optionFlags', o]} label={`"${o}" is`} initialValue="normal">
                          <Select options={[{ value: 'normal', label: 'Normal' }, { value: 'abnormal', label: 'Abnormal' }, { value: 'critical', label: 'Critical' }]} />
                        </Form.Item>
                      ))}
                    </FieldGrid>
                  ) : null
                }}
              </Form.Item>
            )}
            {(dataType === 'text' || dataType === 'richText' || dataType === 'options') && (
              <Form.Item name="defaultText" label="Default text" tooltip="Pre-filled in result entry; the technician can edit it.">
                <Input.TextArea rows={2} />
              </Form.Item>
            )}
            {numeric && (
              <FieldGrid min={170}>
                <Form.Item name="decimals" label="Decimals" tooltip="Decimals kept on a calculated value. Blank = the lab setting (Report entry)."><InputNumber min={0} max={6} style={{ width: '100%' }} /></Form.Item>
                <Form.Item name="deltaLimitPct" label="Delta limit" tooltip="Overrides the lab delta-check percent for this parameter"><InputNumber min={0} addonAfter="%" style={{ width: '100%' }} /></Form.Item>
                <Form.Item name="deltaLimitAbs" label="Delta limit (absolute)" tooltip="Absolute change that raises a delta flag"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
              </FieldGrid>
            )}
          </FormSection>
        )}

        {plain && (numeric || dataType === 'text' || dataType === 'richText' || dataType === 'options' || dataType === 'image' || dataType === 'pdf') && (
          <FormSection title="Reference range" description="The normal and critical limits used to flag results.">
            {numeric && dataType === 'numeric' && (
              <FieldGrid min={150}>
                <Form.Item name="low" label="Range from"><InputNumber style={{ width: '100%' }} /></Form.Item>
                <Form.Item name="high" label="Range to"><InputNumber style={{ width: '100%' }} /></Form.Item>
                <Form.Item name="criticalLow" label="Critical below"><InputNumber style={{ width: '100%' }} /></Form.Item>
                <Form.Item name="criticalHigh" label="Critical above"><InputNumber style={{ width: '100%' }} /></Form.Item>
              </FieldGrid>
            )}
            <Form.Item name="displayRange" label="Result range to show in report" tooltip="Shown on the report instead of from - to">
              <Input placeholder="e.g. Negative, or 12.0 - 17.0" />
            </Form.Item>
            {numeric && (
              <Form.Item
                name="formula"
                label="Formula"
                tooltip="Calculated from other parameter keys, e.g. HB / RBC * 10. Supports + - * / and brackets."
                rules={[{ validator: (_, v: string) => { const err = checkFormula(v ?? '', form.getFieldValue('key') ?? '', siblingKeys); return err ? Promise.reject(new Error(err)) : Promise.resolve() } }]}
              >
                <Input placeholder="Leave empty for manual entry" />
              </Form.Item>
            )}
          </FormSection>
        )}

        {plain && numeric && dataType === 'numeric' && (
          <FormSection title="Age ranges" description="A band that contains the patient's age overrides the default range above. Pick a sex where the band applies to one sex only.">
            <Form.List name="ranges">
              {(fields, { add, remove }) => (
                <>
                  {fields.map(({ key, name }) => (
                    <div key={key} className="cat-agerange">
                      <FieldGrid min={150}>
                        <Form.Item label="From" required>
                          <Space.Compact block>
                            <Form.Item name={[name, 'fromValue']} noStyle rules={[{ required: true, message: 'Required' }]}><InputNumber min={0} aria-label="From age" style={{ width: '50%' }} /></Form.Item>
                            <Form.Item name={[name, 'fromUnit']} noStyle><Select aria-label="From age unit" options={UNIT_OPTIONS} style={{ width: '50%' }} /></Form.Item>
                          </Space.Compact>
                        </Form.Item>
                        <Form.Item label="To" required>
                          <Space.Compact block>
                            <Form.Item name={[name, 'toValue']} noStyle rules={[{ required: true, message: 'Required' }]}><InputNumber min={0} aria-label="To age" style={{ width: '50%' }} /></Form.Item>
                            <Form.Item name={[name, 'toUnit']} noStyle><Select aria-label="To age unit" options={UNIT_OPTIONS} style={{ width: '50%' }} /></Form.Item>
                          </Space.Compact>
                        </Form.Item>
                        <Form.Item name={[name, 'gender']} label="Sex"><Select options={SEX_OPTIONS} /></Form.Item>
                        <Form.Item name={[name, 'low']} label="Low"><InputNumber style={{ width: '100%' }} /></Form.Item>
                        <Form.Item name={[name, 'high']} label="High"><InputNumber style={{ width: '100%' }} /></Form.Item>
                        <Form.Item name={[name, 'displayText']} label="Display text"><Input /></Form.Item>
                      </FieldGrid>
                      <AButton type="text" danger aria-label="Remove age range" icon={<MinusCircleOutlined />} onClick={() => remove(name)}>Remove</AButton>
                    </div>
                  ))}
                  <AButton icon={<PlusOutlined />} onClick={() => add({ fromValue: 0, fromUnit: 'year', toValue: 12, toUnit: 'year', gender: 'any', low: null, high: null, displayText: '' })}>
                    Add age range
                  </AButton>
                </>
              )}
            </Form.List>
            <div className="cat-agepreview">
              <span>Range preview: patient age</span>
              <InputNumber aria-label="Preview age" min={0} value={previewAge} onChange={(v) => setPreviewAge(v ?? 0)} style={{ width: 90 }} />
              <Select aria-label="Preview age unit" value={previewUnit} onChange={setPreviewUnit} options={UNIT_OPTIONS} style={{ width: 110 }} />
              <span>reports as</span>
              <StatusChip variant="info">{preview?.text || '(no range)'}</StatusChip>
            </div>
          </FormSection>
        )}

        <FormSection title="Report display" description="How this parameter appears on the printed and smart report.">
          {plain && (
            <Form.Item name="explanation" label="Plain-language explanation" tooltip="Shown under this parameter on the smart report.">
              <Input.TextArea rows={2} />
            </Form.Item>
          )}
          <SettingRow label="Required" help="Result entry cannot be finished without a value." htmlFor="pd-required"><Form.Item name="required" valuePropName="checked" noStyle><Switch id="pd-required" /></Form.Item></SettingRow>
          <SettingRow label="Do not show in report" help="Keep the value internal; it will not print." htmlFor="pd-hide"><Form.Item name="hideOnReport" valuePropName="checked" noStyle><Switch id="pd-hide" /></Form.Item></SettingRow>
          <SettingRow label="Omit from DLC total" help="Leave this value out of the differential count total." htmlFor="pd-omit"><Form.Item name="omitFromTotal" valuePropName="checked" noStyle><Switch id="pd-omit" /></Form.Item></SettingRow>
          {plain && (
            <>
              <div style={{ marginTop: 'var(--s-4)', fontWeight: 600 }}>Name in other report languages</div>
              <div className="cat-muted" style={{ fontSize: 'var(--fs-dense)', marginBottom: 'var(--s-3)' }}>Used when the report is printed in that language; falls back to the English name.</div>
              <FieldGrid min={160}>
                {REPORT_LANGS.filter((l) => l.value !== 'en').map((l) => (
                  <Form.Item key={l.value} name={['translations', l.value]} label={l.label}><Input /></Form.Item>
                ))}
              </FieldGrid>
            </>
          )}
        </FormSection>
      </Form>
    </Drawer>
  )
}
