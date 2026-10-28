import { REPORT_LANGS } from '../../features/report/i18n'
import { httpsCallable } from 'firebase/functions'
import { RichEditor } from '../../components/results/ParamInputs'
import '../../components/results/results.css'
import { functions, LAB_ID } from '../../firebase'
import { useLabSettings } from '../../hooks/useCatalogue'
import { auditPriceChange, auditRangeChange, rangeDigest } from '../../features/settings/audit'
import { sanitizeRich } from '../../lib/results'
import { CommentTemplatePicker } from './CommentTemplates'
import { TestPreview } from './TestPreview'
import { SPECIES, isRadiologyTest, parametersWithResults } from './behaviour'
import { htmlToPlain, plainToHtml } from './richText'
import { useRadConfig } from '../../features/radiology/config'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Alert, App, AutoComplete, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Switch, Table } from 'antd'
import {
  ArrowDownOutlined, ArrowUpOutlined, CommentOutlined, CopyOutlined, DeleteOutlined, EditOutlined,
  EyeOutlined, FileSearchOutlined, PlusOutlined, UndoOutlined,
} from '@ant-design/icons'
import { addDoc, setDoc } from 'firebase/firestore'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { useAuth, can } from '../../auth/AuthProvider'
import { col, docRef, paths } from '../../lib/db'
import { toPaise, toRupees } from '../../lib/money'
import { ageInDays, resolveRange } from '../../lib/results'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonCard } from '../../design/Skeletons'
import type { Test } from '../../types'
import { TEST_METHODS, TEST_TYPES, type ParameterExt, type TestExt } from './ext'
import { TatInput } from './shared'
import { rangeOverlaps } from './flags'
import { ParameterDrawer, checkFormula, cleanTranslations } from './ParameterDrawer'
import './catalogue.css'
import { dialogWidth } from '../../design/dialog'

interface TestForm {
  testType: TestExt['testType']
  code: string
  name: string
  departmentId: string
  sampleTypeId: string
  barcodeSuffix: string
  gender: Test['gender']
  price: number
  method: string
  modality: string
  tatMinutes: number | null
  urgentTatMinutes: number | null
  preAnalyticalTatMinutes: number | null
  catalogueCode: string
  machineCode: string
  machineReading: boolean
  lmpRequired: boolean
  idRequired: boolean
  consentForm: boolean
  consentText: string
  preCollectionGuidelines: string
  onlyMale: boolean
  onlyFemale: boolean
  onlyBilling: boolean
  startNextPage: boolean
  restricted: boolean
  pcpndt: boolean
  species: string
  reportTemplateId: string
  interpretation: string
  interpretationHtml: string
  interpretationEnabled: boolean
  translations?: Record<string, string>
  comments: string
  disabled: boolean
}

const DEFAULTS: TestForm = {
  testType: 'default', code: '', name: '', departmentId: '', sampleTypeId: '', barcodeSuffix: '', gender: 'both', price: 0,
  method: '', modality: '', tatMinutes: null, urgentTatMinutes: null, preAnalyticalTatMinutes: null, catalogueCode: '', machineCode: '', machineReading: false, lmpRequired: false, idRequired: false,
  consentForm: false, consentText: '', preCollectionGuidelines: '', onlyMale: false, onlyFemale: false, onlyBilling: false,
  startNextPage: false, restricted: false, pcpndt: false, species: 'Human', reportTemplateId: '', interpretation: '', interpretationHtml: '', interpretationEnabled: true, comments: '', disabled: false,
}

function toFormValues(t: TestExt): TestForm {
  return {
    ...DEFAULTS,
    testType: isRadiologyTest(t) ? 'radiology' : t.testType ?? 'default',
    code: t.code, name: t.name, departmentId: t.departmentId, sampleTypeId: t.sampleTypeId,
    barcodeSuffix: t.barcodeSuffix ?? '', gender: t.gender, price: toRupees(t.price), method: t.method ?? '', modality: t.modality ?? '',
    tatMinutes: t.tatMinutes, urgentTatMinutes: t.urgentTatMinutes, preAnalyticalTatMinutes: t.preAnalyticalTatMinutes ?? null, catalogueCode: t.catalogueCode ?? '', machineCode: t.machineCode ?? '', machineReading: !!t.machineReading,
    lmpRequired: !!t.lmpRequired, idRequired: !!t.idRequired, consentForm: !!t.consentForm, consentText: t.consentText ?? '',
    preCollectionGuidelines: t.preCollectionGuidelines ?? '', onlyMale: !!t.onlyMale, onlyFemale: !!t.onlyFemale,
    onlyBilling: !!t.onlyBilling, startNextPage: !!(t.startNextPage ?? t.startOnNewPage), restricted: !!t.restricted, pcpndt: !!t.pcpndt, species: t.species || 'Human', reportTemplateId: t.reportTemplateId ?? '',
    interpretation: t.interpretation ?? '', interpretationHtml: t.interpretationHtml ?? plainToHtml(t.interpretation ?? ''), interpretationEnabled: t.interpretationEnabled ?? !!t.interpretation,
    comments: t.comments ?? '', disabled: !!t.disabled, translations: t.translations ?? {},
  }
}

function RichBox({ value, onChange, disabled, label }: { value?: string; onChange?: (v: string) => void; disabled: boolean; label: string }) {
  return <RichEditor label={label} value={value ?? ''} disabled={disabled} onChange={(h) => onChange?.(h)} />
}

export default function TestEditorPage() {
  const { testId } = useParams()
  const [search] = useSearchParams()
  const nav = useNavigate()
  const { message } = App.useApp()
  const { profile } = useAuth()
  const canEdit = can(profile, 'catalogue.edit')
  const isNew = testId === 'new'
  const maps = useCatalogueMaps()
  const { departments, sampleTypes, testById } = maps
  const tests = maps.tests as TestExt[]
  const templates = useLiveQuery<{ id: string; name: string }>(col('reportTemplates'), []).data
  const radCfg = useRadConfig()
  const [form] = Form.useForm<TestForm>()
  const [params, setParams] = useState<ParameterExt[]>([])
  const [loaded, setLoaded] = useState(isNew)
  const [saving, setSaving] = useState(false)
  const [drawer, setDrawer] = useState<{ open: boolean; index: number | null }>({ open: false, index: null })
  const [modal, setModal] = useState<'preview' | 'copy' | 'interp' | 'comments' | null>(null)
  const [copyId, setCopyId] = useState<string | undefined>()
  const settings = useLabSettings()
  const [aiBusy, setAiBusy] = useState(false)
  const [aiDraft, setAiDraft] = useState<string | null>(null)
  const testType = Form.useWatch('testType', form)
  const radiology = testType === 'radiology'

  const existing = !isNew && testId ? (testById.get(testId) as TestExt | undefined) : undefined
  const sampleTypeId = Form.useWatch('sampleTypeId', form)
  const sampleColor = sampleTypes.find((s) => s.id === sampleTypeId)?.tubeColor

  useEffect(() => {
    if (isNew) form.setFieldsValue(DEFAULTS)
  }, [isNew, form])

  useEffect(() => {
    if (loaded || !existing) return
    form.setFieldsValue(toFormValues(existing))
    setParams((existing.parameters ?? []) as ParameterExt[])
    setLoaded(true)
  }, [existing, loaded, form])

  // /tests/new?copy=<id> (Clone from the list) pre-fills from that test once the catalogue has loaded.
  const cloneId = search.get('copy')
  const cloned = useRef(false)
  useEffect(() => {
    if (!isNew || !cloneId || cloned.current) return
    const src = testById.get(cloneId) as TestExt | undefined
    if (!src) return
    cloned.current = true
    form.setFieldsValue({ ...toFormValues(src), code: '', name: '', catalogueCode: '', machineCode: '' })
    setParams(((src.parameters ?? []) as ParameterExt[]).map((p) => ({ ...p })))
  }, [isNew, cloneId, testById, form])

  const reset = () => {
    form.setFieldsValue(existing ? toFormValues(existing) : DEFAULTS)
    setParams(existing ? ((existing.parameters ?? []) as ParameterExt[]) : [])
    message.info('Test reset')
  }

  const copyFrom = () => {
    const src = copyId ? (testById.get(copyId) as TestExt | undefined) : undefined
    if (!src) return
    form.setFieldsValue({ ...toFormValues(src), code: '', name: '', catalogueCode: '', machineCode: '' })
    setParams(((src.parameters ?? []) as ParameterExt[]).map((p) => ({ ...p })))
    setModal(null)
    message.success(`Copied from ${src.name}. Enter a new code and name.`)
  }

  const move = (i: number, d: -1 | 1) =>
    setParams((ps) => {
      const j = i + d
      if (j < 0 || j >= ps.length) return ps
      const next = [...ps]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const removeParam = (i: number) =>
    setParams((ps) => {
      const gone = ps[i]
      return ps.filter((_, idx) => idx !== i).map((p) => (gone.structure === 'group' && p.parentKey === gone.key ? { ...p, parentKey: null } : p))
    })

  const applyParam = (p: ParameterExt) => {
    setParams((ps) => {
      if (drawer.index === null) return [...ps, p]
      const old = ps[drawer.index]
      return ps.map((x, idx) => (idx === drawer.index ? p : old.key !== p.key && x.parentKey === old.key ? { ...x, parentKey: p.key } : x))
    })
    setDrawer({ open: false, index: null })
  }

  const save = async (asNew = false) => {
    const v = await form.validateFields()
    const code = v.code.trim().toUpperCase()
    if (tests.some((t) => t.code.toUpperCase() === code && (asNew || t.id !== testId))) {
      message.error(`Test code ${code} already exists${asNew ? '. Change the code to save as a new test.' : ''}`)
      return
    }
    if (v.tatMinutes != null && v.urgentTatMinutes != null && v.urgentTatMinutes > v.tatMinutes) {
      message.error('Urgent TAT cannot be longer than the total TAT')
      return
    }
    const gaps = rangeOverlaps(params)
    if (gaps) {
      message.error(gaps)
      return
    }
    const keys = params.map((p) => p.key)
    for (const p of params) {
      const err = checkFormula(p.formula, p.key, keys)
      if (err) {
        message.error(`Parameter ${p.key}: ${err}`)
        return
      }
    }
    // CAT-40: a parameter that already holds results cannot be removed from the test.
    if (existing && !asNew) {
      const removed = ((existing.parameters ?? []) as ParameterExt[]).filter((p) => !keys.includes(p.key)).map((p) => p.key)
      if (removed.length) {
        try {
          const used = await parametersWithResults(testId!, removed)
          if (used.keys.length) {
            message.error(`Cannot remove parameter ${used.keys.join(', ')}: it already has results on ${used.results} report(s). Hide it on the report instead.`)
            return
          }
        } catch (e) {
          message.warning(`Could not check existing results (${(e as Error).message}); the removal was not blocked.`)
        }
      }
    }
    const isRad = v.testType === 'radiology'
    const richHtml = sanitizeRich(v.interpretationHtml ?? '')
    const data: Omit<TestExt, 'id'> = {
      testType: v.testType ?? 'default',
      code,
      name: v.name.trim(),
      departmentId: v.departmentId,
      sampleTypeId: v.sampleTypeId,
      barcodeSuffix: v.barcodeSuffix ?? '',
      price: toPaise(v.price ?? 0),
      gender: v.onlyMale ? 'male' : v.onlyFemale ? 'female' : v.gender,
      method: v.method ?? '',
      modality: isRad ? v.modality || 'Other' : '', // radiology tests route to the Radiology worklist by modality
      tatMinutes: v.tatMinutes ?? null,
      urgentTatMinutes: v.urgentTatMinutes ?? null,
      preAnalyticalTatMinutes: v.preAnalyticalTatMinutes ?? null,
      catalogueCode: (v.catalogueCode ?? '').trim(),
      machineCode: (v.machineCode ?? '').trim(),
      machineReading: !!v.machineReading,
      lmpRequired: !!v.lmpRequired,
      idRequired: !!v.idRequired,
      consentForm: !!v.consentForm,
      consentText: v.consentText ?? '',
      preCollectionGuidelines: v.preCollectionGuidelines ?? '',
      onlyMale: !!v.onlyMale,
      onlyFemale: !!v.onlyFemale,
      onlyBilling: !!v.onlyBilling,
      startNextPage: !!v.startNextPage,
      startOnNewPage: !!v.startNextPage, // name read by the report
      restricted: !!v.restricted,
      pcpndt: !!v.pcpndt,
      consentRequired: !!v.consentForm,
      species: v.species ?? 'Human',
      reportTemplateId: v.reportTemplateId ?? '',
      parameters: isRad ? [] : params,
      interpretation: richHtml ? htmlToPlain(richHtml) : '',
      interpretationHtml: richHtml,
      interpretationEnabled: !!v.interpretationEnabled,
      translations: cleanTranslations(v.translations),
      comments: v.comments ?? '',
      disabled: !!v.disabled,
      ...(existing && (existing as TestExt).aiDraft ? { aiDraft: false } : {}),
      order: existing?.order ?? Math.max(0, ...tests.map((t) => t.order ?? 0)) + 1,
    }
    setSaving(true)
    try {
      if (isNew || asNew) await addDoc(col(paths.tests), asNew ? { ...data, order: Math.max(0, ...tests.map((t) => t.order ?? 0)) + 1 } : data)
      else {
        await setDoc(docRef(paths.tests, testId!), data, { merge: true })
        // X-03: price and reference-range edits are audited.
        if (existing && existing.price !== data.price) void auditPriceChange('test', `${code} ${data.name}`, `tests/${testId}`, existing.price, data.price)
        const before = JSON.stringify(rangeDigest((existing?.parameters ?? []) as ParameterExt[]))
        const after = JSON.stringify(rangeDigest(data.parameters as ParameterExt[]))
        if (before !== after) void auditRangeChange(code, `tests/${testId}`, JSON.parse(before), JSON.parse(after))
      }
      message.success('Test saved')
      nav('/tests')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const draftWithAi = async () => {
    const v = form.getFieldsValue(true) as TestForm
    if (!v.name?.trim()) return message.warning('Enter the test name first')
    setAiBusy(true)
    try {
      const r = await httpsCallable<unknown, { interpretation: string }>(functions, 'draftTestInterpretation')({
        labId: LAB_ID, name: v.name, method: v.method, existing: htmlToPlain(v.interpretationHtml ?? ''),
        parameters: params.filter((p) => p.structure !== 'group').map((p) => ({ name: p.name, unit: p.unit, range: resolveRange(p, ageInDays(30, 'year')).text })),
      })
      setAiDraft(r.data.interpretation)
    } catch (e) {
      message.error((e as Error).message || 'AI draft failed')
    } finally {
      setAiBusy(false)
    }
  }

  if (!isNew && !loaded) {
    return tests.length > 0 && existing === undefined ? <Alert type="error" title="Test not found" /> : <SkeletonCard lines={5} />
  }

  const editingParam = drawer.index === null ? null : params[drawer.index]
  const values = form.getFieldsValue(true) as TestForm

  return (
    <div className="cat-stack">
      <PageHeader
        title={isNew ? 'New test' : `Edit test${existing ? ` - ${existing.code}` : ''}`}
        subtitle="Define the test, its parameters and what prints on the report."
        actions={
          <>
            <Button icon={<CopyOutlined />} disabled={!canEdit} onClick={() => setModal('copy')}>Copy from existing test</Button>
            <Button icon={<UndoOutlined />} disabled={!canEdit} onClick={reset}>Reset test</Button>
            <Button icon={<CommentOutlined />} onClick={() => setModal('comments')}>View comment</Button>
            <Button icon={<FileSearchOutlined />} onClick={() => setModal('interp')}>View interpretation</Button>
            <Button icon={<EyeOutlined />} onClick={() => setModal('preview')}>Preview report</Button>
            <Button onClick={() => nav('/tests')}>Cancel</Button>
            {!isNew && <Button disabled={!canEdit || saving} onClick={() => void save(true)}>Save as new</Button>}
            <Button variant="primary" disabled={!canEdit || saving} onClick={() => void save()}>{saving ? 'Saving' : 'Save test'}</Button>
          </>
        }
      />
      <Form form={form} layout="vertical" initialValues={DEFAULTS} disabled={!canEdit}>
        <div className="cat-stack">
          <Card>
            <h2 className="cat-section-title">Test details</h2>
            <Row gutter={16}>
              <Col xs={24} md={6}><Form.Item name="testType" label="Test type" tooltip="Radiology tests go to the Radiology worklist and have no parameter grid">
                <Select options={TEST_TYPES} onChange={(t) => form.setFieldsValue({ modality: t === 'radiology' ? form.getFieldValue('modality') || 'Other' : '' })} />
              </Form.Item></Col>
              <Col xs={24} md={6}><Form.Item name="code" label="Test code" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col xs={24} md={12}><Form.Item name="name" label="Test name" rules={[{ required: true }]}><Input /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="departmentId" label="Department" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={departments.map((d) => ({ value: d.id, label: d.name }))} /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="sampleTypeId" label="Sample" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={sampleTypes.map((s) => ({ value: s.id, label: s.name }))} /></Form.Item></Col>
              <Col xs={24} md={4}>
                <Form.Item label="Sample colour">
                  <span className="cat-toolbar" style={{ margin: 0 }}>
                    <span className="cat-dot" style={{ background: sampleColor ?? 'transparent' }} aria-hidden="true" />
                    <span className="cat-muted">{sampleColor ?? 'Pick a sample'}</span>
                  </span>
                </Form.Item>
              </Col>
              <Col xs={24} md={4}><Form.Item name="barcodeSuffix" label="Barcode suffix"><Input /></Form.Item></Col>
              <Col xs={24} md={6}><Form.Item name="price" label="Price (₹)" rules={[{ required: true }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} disabled={!isNew && !can(profile, 'catalogue.price')} /></Form.Item></Col>
              <Col xs={24} md={6}>
                <Form.Item name="gender" label="Gender">
                  <Select options={[{ value: 'both', label: 'Both' }, { value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }]} />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="method" label="Test method">
                  <AutoComplete allowClear placeholder="Pick or type a method" options={TEST_METHODS.map((m) => ({ value: m }))} filterOption={(i, o) => (o?.value ?? '').toLowerCase().includes(i.toLowerCase())} />
                </Form.Item>
              </Col>
              {radiology && (
                <Col xs={24} md={12}>
                  <Form.Item name="modality" label="Radiology modality" tooltip="Imaging tests go to the Radiology worklist instead of Enter & Verify">
                    <Select options={[...new Set([...radCfg.modalities.map((m) => m.label), 'Other', ...(form.getFieldValue('modality') ? [form.getFieldValue('modality')] : [])])].map((m) => ({ value: m, label: m }))} />
                  </Form.Item>
                </Col>
              )}
              <Col xs={24} md={8}><Form.Item name="tatMinutes" label="Total TAT"><TatInput label="TAT" /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="urgentTatMinutes" label="Urgent TAT"><TatInput label="Urgent TAT" /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="preAnalyticalTatMinutes" label="Pre-analytical TAT" tooltip="Time from collection to the lab receiving the sample"><TatInput label="Pre-analytical TAT" /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="species" label="Species" tooltip="Only these species can be billed for this test. Human only is the default."
                getValueProps={(v: string) => ({ value: (v ?? '').split(',').map((x) => x.trim()).filter(Boolean) })} normalize={(v: string[]) => (v ?? []).join(',')}>
                <Select mode="multiple" options={SPECIES.map((x) => ({ value: x, label: x }))} />
              </Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="catalogueCode" label="Catalogue code" tooltip="Global code that identifies this test across labs"><Input /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="machineCode" label="Machine / LIS code"><Input /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="machineReading" label="Read from analyser" tooltip="Results arrive from a connected analyser (machine values on result entry)" valuePropName="checked"><Switch /></Form.Item></Col>
              <Col xs={24} md={8}>
                <Form.Item name="reportTemplateId" label="Report template">
                  <Select allowClear placeholder={`Department default${departments.find((d) => d.id === values.departmentId)?.reportTemplateId ? '' : ' (lab default)'}`} options={templates.map((t) => ({ value: t.id, label: t.name }))} />
                </Form.Item>
              </Col>
            </Row>
          </Card>

          <Card>
            <h2 className="cat-section-title">Collection and billing rules</h2>
            <Space size="large" wrap align="start">
              <Form.Item name="lmpRequired" label="LMP required" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="idRequired" label="ID required" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="consentForm" label="Consent form" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="onlyMale" label="Only male" valuePropName="checked"><Switch onChange={(on) => on && form.setFieldsValue({ onlyFemale: false, gender: 'male' })} /></Form.Item>
              <Form.Item name="onlyFemale" label="Only female" valuePropName="checked"><Switch onChange={(on) => on && form.setFieldsValue({ onlyMale: false, gender: 'female' })} /></Form.Item>
              <Form.Item name="onlyBilling" label="Only billing" tooltip="Billable only, no result entry" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="startNextPage" label="Start from next page" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="pcpndt" label="PCPNDT regulated (Form F, shown in the Patient List PCPNDT tab)" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="restricted" label="Restricted (never sent by WhatsApp or SMS)" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="disabled" label="Disabled" tooltip="Hidden from new bills" valuePropName="checked"><Switch /></Form.Item>
            </Space>
            <Form.Item noStyle shouldUpdate={(a, b) => a.consentForm !== b.consentForm}>
              {({ getFieldValue }) =>
                getFieldValue('consentForm') ? <Form.Item name="consentText" label="Consent form text"><Input.TextArea rows={3} /></Form.Item> : null
              }
            </Form.Item>
            <Form.Item name="preCollectionGuidelines" label="Pre-collection guidelines" tooltip="Shown to reception and on the booking confirmation">
              <Input.TextArea rows={2} placeholder="e.g. Fasting for 10 to 12 hours" />
            </Form.Item>
          </Card>

          <Card>
            <h2 className="cat-section-title">Test name in other report languages</h2>
            <Space wrap>
              {REPORT_LANGS.filter((l) => l.value !== 'en').map((l) => (
                <Form.Item key={l.value} name={['translations', l.value]} label={l.label}><Input style={{ width: 200 }} /></Form.Item>
              ))}
            </Space>
          </Card>

          <Card>
            <h2 className="cat-section-title">Interpretation and comments</h2>
            <Form.Item name="interpretationEnabled" label="Print interpretation on report" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item label="Interpretation" extra="Rich text. Draft with AI writes a general note from the test definition for you to review.">
              <div className="cat-rich">
                <Form.Item name="interpretationHtml" noStyle>
                  <RichBox label="Interpretation" disabled={!canEdit} />
                </Form.Item>
              </div>
              <div className="cat-toolbar" style={{ marginTop: 8 }}>
                <Button disabled={!canEdit || aiBusy || settings.aiEnabled === false} onClick={() => void draftWithAi()}>{aiBusy ? 'Drafting' : 'Draft with AI'}</Button>
                {settings.aiEnabled === false && <span className="cat-muted">AI is off in Lab settings.</span>}
              </div>
            </Form.Item>
            <Form.Item label="Comments (printed under the results)">
              <div className="cat-toolbar"><CommentTemplatePicker disabled={!canEdit} onPick={(t) => form.setFieldsValue({ comments: t })} /></div>
              <Form.Item name="comments" noStyle><Input.TextArea rows={3} /></Form.Item>
            </Form.Item>
          </Card>
        </div>
      </Form>

      {radiology ? (
        <Card><p className="cat-muted" style={{ margin: 0 }}>Radiology tests are reported as findings and impression in the Radiology worklist, so there is no parameter grid.</p></Card>
      ) : (
      <Card>
        <div className="cat-toolbar">
          <h2 className="cat-section-title" style={{ margin: 0 }}>Parameters ({params.length})</h2>
          <span className="cat-toolbar__grow" />
          <Button icon={<PlusOutlined />} disabled={!canEdit} onClick={() => setDrawer({ open: true, index: null })}>Add parameter</Button>
        </div>
        <Table<ParameterExt & { idx: number }>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={params.map((p, idx) => ({ ...p, idx }))}
          locale={{ emptyText: <EmptyState title="No parameters yet" description="Add the parameters that make up this test." /> }}
          columns={[
            {
              title: 'Move', width: 100,
              render: (_, p) => (
                <Space size={0}>
                  <Button variant="text" aria-label={`Move ${p.key} up`} icon={<ArrowUpOutlined />} disabled={!canEdit || p.idx === 0} onClick={() => move(p.idx, -1)} />
                  <Button variant="text" aria-label={`Move ${p.key} down`} icon={<ArrowDownOutlined />} disabled={!canEdit || p.idx === params.length - 1} onClick={() => move(p.idx, 1)} />
                </Space>
              ),
            },
            { title: 'Key', dataIndex: 'key', width: 100, render: (k: string) => <span className="cat-code">{k}</span> },
            { title: 'Name', render: (_, p) => <span style={{ paddingLeft: p.parentKey ? 20 : 0, fontWeight: p.structure === 'group' ? 600 : 400 }}>{p.name}</span> },
            { title: 'Field', width: 140, render: (_, p) => (p.fieldType ?? (p.structure === 'group' ? 'multiple' : 'single')) !== 'single' ? p.fieldType ?? 'multiple' : p.dataType },
            { title: 'Unit', dataIndex: 'unit', width: 90 },
            { title: 'Range', render: (_, p) => (p.structure === 'group' ? '' : resolveRange(p, ageInDays(30, 'year')).text) },
            { title: 'Formula', dataIndex: 'formula', render: (f: string) => (f ? <span className="cat-code">{f}</span> : '') },
            {
              title: 'Flags', width: 150,
              render: (_, p) => (
                <Space size={4} wrap>
                  {p.required && <StatusChip variant="info">Required</StatusChip>}
                  {p.hideOnReport && <StatusChip>Hidden</StatusChip>}
                  {p.omitFromTotal && <StatusChip variant="caution">Not in total</StatusChip>}
                </Space>
              ),
            },
            {
              title: 'Delete', width: 110,
              render: (_, p) => (
                <Space size={0}>
                  <Button variant="text" aria-label={`Edit ${p.key}`} icon={<EditOutlined />} disabled={!canEdit} onClick={() => setDrawer({ open: true, index: p.idx })} />
                  <Button variant="text" aria-label={`Delete ${p.key}`} icon={<DeleteOutlined />} disabled={!canEdit} onClick={() => removeParam(p.idx)} />
                </Space>
              ),
            },
          ]}
        />
      </Card>
      )}

      <ParameterDrawer
        open={drawer.open}
        initial={editingParam}
        siblings={params.filter((_, i) => i !== drawer.index)}
        onClose={() => setDrawer({ open: false, index: null })}
        onSave={applyParam}
      />

      <Modal title="Copy from existing test" open={modal === 'copy'} onCancel={() => setModal(null)} onOk={copyFrom} okText="Copy" okButtonProps={{ disabled: !copyId }} destroyOnHidden>
        <p className="cat-muted">Copies every field and parameter. Enter a new code and name afterwards. Nothing is saved until you press Save test.</p>
        <Select showSearch optionFilterProp="label" style={{ width: '100%' }} aria-label="Source test" placeholder="Search a test" value={copyId} onChange={setCopyId}
          options={tests.filter((t) => t.id !== testId).map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` }))} />
      </Modal>
      <Modal title="Interpretation" open={modal === 'interp'} onCancel={() => setModal(null)} footer={null} destroyOnHidden>
        <div className="cat-preview" dangerouslySetInnerHTML={{ __html: sanitizeRich(values.interpretationHtml ?? '') || 'No interpretation entered.' }} />
      </Modal>
      <Modal title="Comments" open={modal === 'comments'} onCancel={() => setModal(null)} footer={null} destroyOnHidden>
        <pre className="cat-preview" style={{ whiteSpace: 'pre-wrap' }}>{values.comments || 'No comments entered.'}</pre>
      </Modal>
      <Modal title="Report preview" open={modal === 'preview'} onCancel={() => setModal(null)} footer={null} width={dialogWidth(900)} destroyOnHidden>
        <TestPreview
          test={{
            name: values.name || 'Test name', departmentId: values.departmentId, interpretation: htmlToPlain(values.interpretationHtml ?? ''),
            parameters: radiology ? [] : params, startOnNewPage: false, translations: values.translations, interpretationEnabled: values.interpretationEnabled,
            comments: values.comments, sampleTypeName: sampleTypes.find((x) => x.id === values.sampleTypeId)?.name,
          }}
        />
      </Modal>
      <Modal
        title="AI draft interpretation" open={aiDraft !== null} onCancel={() => setAiDraft(null)} okText="Use this draft"
        onOk={() => { form.setFieldsValue({ interpretationHtml: plainToHtml(aiDraft ?? '') }); setAiDraft(null); message.success('Draft inserted. Review it before saving.') }}
        destroyOnHidden
      >
        <p className="cat-muted">Written from the test definition only, no patient data. Review and edit before saving; it replaces the current text.</p>
        <pre className="cat-preview" style={{ whiteSpace: 'pre-wrap' }}>{aiDraft}</pre>
      </Modal>
    </div>
  )
}
