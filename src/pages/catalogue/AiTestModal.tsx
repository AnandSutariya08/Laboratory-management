import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, App, Input, Modal, Radio, Table } from 'antd'
import { addDoc, serverTimestamp } from 'firebase/firestore'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { col, paths } from '../../lib/db'
import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../../firebase'
import { draftTestFromText, type TestDraft } from '../../lib/ai'
import { EXTRACT_MIN_SCORE, nameScore } from '../../lib/fuzzy'
import type { Parameter } from '../../types'
import type { TestExt } from './ext'
import { dialogWidth } from '../../design/dialog'

// "Create test with AI / from text" (CAT-15). Two inputs: just a test name, or pasted text / CSV rows
// describing the test (or attach a PDF). The catalogue is searched
// first (fuzzy score >= 45) so a duplicate is not created. The result is saved as a DISABLED draft flagged
// createdByAi and opened in the editor; it only becomes billable after a person reviews and enables it.
export default function AiTestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const nav = useNavigate()
  const maps = useCatalogueMaps()
  const [mode, setMode] = useState<'name' | 'text' | 'pdf'>('name')
  const [pdf, setPdf] = useState<{ name: string; data: string } | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<TestDraft | null>(null)

  const similar = useMemo(() => {
    const q = (draft?.name || (mode === 'name' ? text : '')).trim()
    if (!q) return []
    return (maps.tests as TestExt[]).filter((t) => !t.deleted).map((t) => ({ t, score: Math.max(nameScore(t.name, q), nameScore(t.code, q)) })).filter((x) => x.score >= EXTRACT_MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, 5)
  }, [maps.tests, draft?.name, text, mode])

  const run = async () => {
    setBusy(true)
    try {
      if (mode === 'pdf') {
        if (!pdf) return
        const r = await httpsCallable<unknown, TestDraft>(functions, 'draftTestFromPdf')({ labId: LAB_ID, pdfBase64: pdf.data })
        setDraft(r.data)
      } else setDraft(await draftTestFromText({ text, mode }))
    } catch (e) {
      message.error((e instanceof Error ? e.message : 'The AI could not draft this test').replace(/\s*\[\d+\]\s*$/, ''))
    } finally {
      setBusy(false)
    }
  }

  const pick = (hint: string, list: { id: string; name: string }[]) => list.map((x) => ({ id: x.id, s: nameScore(x.name, hint) })).sort((a, b) => b.s - a.s)[0]
  const create = async () => {
    if (!draft) return
    const used = new Set<string>()
    const parameters: Parameter[] = draft.parameters.map((p, i) => {
      let key = (p.name.replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 8) || `P${i + 1}`)
      while (used.has(key)) key = `${key}${i}`
      used.add(key)
      const numeric = p.low != null || p.high != null
      return { key, name: p.name, structure: 'single', parentKey: null, dataType: numeric ? 'numeric' : 'text', unit: p.unit, options: [], low: p.low, high: p.high, ranges: [], criticalLow: null, criticalHigh: null, displayRange: p.displayRange, formula: '', required: false, hideOnReport: false, method: p.method }
    })
    const dept = draft.departmentHint ? pick(draft.departmentHint, maps.departments) : undefined
    const sample = draft.sampleHint ? pick(draft.sampleHint, maps.sampleTypes) : undefined
    let code = (draft.code || draft.name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 10) || 'AI'
    const codes = new Set(maps.tests.map((t) => t.code.toUpperCase()))
    for (let n = 2; codes.has(code); n++) code = `${code.slice(0, 8)}${n}`
    const data: Omit<TestExt, 'id'> & { createdByAi: boolean; aiDraft: boolean; createdAt: unknown } = {
      code, name: draft.name, departmentId: (dept && dept.s >= EXTRACT_MIN_SCORE ? dept.id : maps.departments[0]?.id) ?? '', sampleTypeId: (sample && sample.s >= EXTRACT_MIN_SCORE ? sample.id : maps.sampleTypes[0]?.id) ?? '',
      price: 0, gender: 'both', tatMinutes: null, urgentTatMinutes: null, parameters, interpretation: '', disabled: true, order: Math.max(0, ...maps.tests.map((t) => t.order ?? 0)) + 1,
      createdByAi: true, aiDraft: true, createdAt: serverTimestamp(),
    }
    try {
      const ref = await addDoc(col(paths.tests), data)
      message.success('Draft created (disabled). Review it, set the price, then enable it.')
      onClose()
      nav(`/tests/${ref.id}`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Modal title="Create test with AI" open={open} onCancel={onClose} width={dialogWidth(720)} destroyOnHidden okText="Create draft test" onOk={create} okButtonProps={{ disabled: !draft }}>
      <Radio.Group optionType="button" value={mode} onChange={(e) => { setMode(e.target.value); setDraft(null) }} options={[{ value: 'name', label: 'From a test name' }, { value: 'text', label: 'From pasted text or CSV' }, { value: 'pdf', label: 'From a PDF' }]} style={{ marginBottom: 12 }} />
      {mode === 'pdf' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <input type="file" accept="application/pdf" aria-label="PDF file" onChange={(e) => {
            const f = e.target.files?.[0]
            setDraft(null)
            if (!f) return setPdf(null)
            if (f.size > 5 * 1024 * 1024) { setPdf(null); return void message.error('The PDF must be 5 MB or smaller') }
            const r = new FileReader()
            r.onload = () => setPdf({ name: f.name, data: String(r.result) })
            r.readAsDataURL(f)
          }} />
          {pdf && <span className="cat-muted">{pdf.name} ready</span>}
        </div>
      ) : (
      <Input.TextArea rows={mode === 'name' ? 1 : 7} aria-label={mode === 'name' ? 'Test name' : 'Test text'} placeholder={mode === 'name' ? 'e.g. Lipid profile' : 'Paste the text or CSV rows of the test (PDF files are not read: copy their text)'} value={text} onChange={(e) => { setText(e.target.value); setDraft(null) }} />
      )}
      <p style={{ margin: '12px 0' }}>
        <button type="button" className="dbtn press dbtn--default" onClick={() => void run()} disabled={busy || (mode === 'pdf' ? !pdf : !text.trim())}><span>{busy ? 'Reading...' : 'Draft with AI'}</span></button>
      </p>
      {similar.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Similar tests already exist" description={similar.map((x) => `${x.t.name} (${x.t.code}, ${x.score})`).join(' | ')} />}
      {draft && (
        <>
          <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`${draft.name} (${draft.code || 'no code'})`} description="AI draft: check every parameter, unit and range before enabling. It is created disabled and marked as AI-created." />
          <Table size="small" rowKey="name" pagination={false} dataSource={draft.parameters} columns={[
            { title: 'Parameter', dataIndex: 'name' }, { title: 'Unit', dataIndex: 'unit' },
            { title: 'Range', render: (_: unknown, p: TestDraft['parameters'][number]) => p.displayRange || (p.low != null || p.high != null ? `${p.low ?? ''} - ${p.high ?? ''}` : '') },
          ]} />
        </>
      )}
    </Modal>
  )
}
