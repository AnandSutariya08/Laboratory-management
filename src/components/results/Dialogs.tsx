import { useEffect, useMemo, useState } from 'react'
import { App, Checkbox, Input, InputNumber, Modal, Radio, Select, Table } from 'antd'
import { addDoc, query, serverTimestamp, where } from 'firebase/firestore'
import { col } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { can, useAuth } from '../../auth/AuthProvider'
import type { Parameter, Test } from '../../types'
import { ISSUE_LABEL, type MachineRun, type SampleIssue, type Values } from './types'
import { dialogWidth } from '../../design/dialog'
import { FieldGrid, FormSection } from '../../design/FormLayout'

interface ReasonDoc { id: string; kind: string; text: string }
interface TemplateDoc { id: string; kind: string; name: string; text?: string; body?: string; content?: string }

export const useReasons = (kind: string) =>
  useLiveQuery<ReasonDoc>(query(col('reasons'), where('kind', '==', kind)), [kind]).data
export const useTemplates = (kind: string) =>
  useLiveQuery<TemplateDoc>(query(col('reportTemplates'), where('kind', '==', kind)), [kind]).data

const tplText = (t: TemplateDoc) => t.text ?? t.body ?? t.content ?? ''

// Reason picked from the reasons master (kind) plus a free note.
export function ReasonModal(p: {
  open: boolean
  title: string
  kind: string
  required?: boolean
  okText?: string
  danger?: boolean
  extra?: React.ReactNode
  fixedReasons?: string[] // a fixed list that comes first (Flabs: re-run reasons)
  pickRequired?: boolean // a reason must be chosen from the list; the note stays optional
  noteLabel?: string
  onOk: (reason: string, parts?: { reason: string; note: string }) => Promise<void> | void
  onCancel: () => void
}) {
  const saved = useReasons(p.kind)
  const reasons = p.fixedReasons ? [...p.fixedReasons.map((text) => ({ text })), ...saved.filter((r) => !p.fixedReasons!.includes(r.text))] : saved
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (p.open) {
      setReason('')
      setNote('')
    }
  }, [p.open])
  const text = [reason, note.trim()].filter(Boolean).join(': ')
  return (
    <Modal
      open={p.open}
      title={p.title}
      okText={p.okText ?? 'Confirm'}
      okButtonProps={{ danger: p.danger, disabled: (!!p.required && !text) || (!!p.pickRequired && !reason), loading: busy }}
      onCancel={p.onCancel}
      onOk={async () => {
        setBusy(true)
        try {
          await p.onOk(text, { reason, note: note.trim() })
        } finally {
          setBusy(false)
        }
      }}
      destroyOnHidden
    >
      {p.extra}
      <div className="re-field">
        <label htmlFor="reason-sel">Reason{p.required || p.pickRequired ? ' (required)' : ''}</label>
        <Select id="reason-sel" allowClear value={reason || undefined} onChange={(v) => setReason(v ?? '')} placeholder={reasons.length ? 'Choose a reason' : 'No saved reasons; use the note'} options={reasons.map((r) => ({ value: r.text, label: r.text }))} />
      </div>
      <div className="re-field">
        <label htmlFor="reason-note">{p.noteLabel ?? 'Note'}</label>
        <Input.TextArea id="reason-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  )
}

// Comment or report note: free text plus saved canned comments (reportTemplates kind 'comment').
export function TextTemplateModal(p: {
  open: boolean
  title: string
  initial: string
  mode: 'append' | 'replace'
  onOk: (text: string) => Promise<void> | void
  onCancel: () => void
}) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const templates = useTemplates('comment')
  const [text, setText] = useState('')
  const [save, setSave] = useState(false)
  const [name, setName] = useState('')
  useEffect(() => {
    if (p.open) {
      setText(p.mode === 'replace' ? p.initial : '')
      setSave(false)
      setName('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open])
  const canSave = can(profile, 'catalogue.edit')
  return (
    <Modal
      open={p.open}
      title={p.title}
      okText="Apply"
      okButtonProps={{ disabled: !text.trim() }}
      onCancel={p.onCancel}
      destroyOnHidden
      onOk={async () => {
        if (save && canSave && name.trim()) {
          try {
            await addDoc(col('reportTemplates'), { kind: 'comment', name: name.trim(), text: text.trim(), active: true, createdAt: serverTimestamp() })
          } catch {
            message.warning('Could not save the canned comment')
          }
        }
        await p.onOk(text.trim())
      }}
    >
      <div className="re-field">
        <label htmlFor="tpl-sel">Saved comment</label>
        <Select
          id="tpl-sel"
          showSearch
          optionFilterProp="label"
          placeholder={templates.length ? 'Insert a saved comment' : 'No saved comments yet'}
          value={undefined}
          onChange={(id) => {
            const t = templates.find((x) => x.id === id)
            if (t) setText((cur) => (cur.trim() ? `${cur.trim()}\n${tplText(t)}` : tplText(t)))
          }}
          options={templates.map((t) => ({ value: t.id, label: t.name }))}
        />
      </div>
      <div className="re-field">
        <label htmlFor="tpl-text">Text</label>
        <Input.TextArea id="tpl-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {canSave && (
        <div className="re-field">
          <Checkbox checked={save} onChange={(e) => setSave(e.target.checked)}>Save as a canned comment</Checkbox>
          {save && <Input aria-label="Canned comment name" placeholder="Name for this comment" value={name} onChange={(e) => setName(e.target.value)} />}
        </div>
      )}
    </Modal>
  )
}

export function IssueModal(p: { open: boolean; testName: string; onOk: (i: Pick<SampleIssue, 'type' | 'note'>) => Promise<void> | void; onCancel: () => void }) {
  const [type, setType] = useState<SampleIssue['type']>('haemolysed')
  const [note, setNote] = useState('')
  useEffect(() => {
    if (p.open) {
      setType('haemolysed')
      setNote('')
    }
  }, [p.open])
  return (
    <Modal open={p.open} title={`Add issue: ${p.testName}`} okText="Add issue" onCancel={p.onCancel} onOk={() => p.onOk({ type, note: note.trim() })} destroyOnHidden>
      <p className="wl-muted">The issue is shown to the technician and printed as a sample note on the report.</p>
      <div className="re-field">
        <label htmlFor="issue-type">Issue</label>
        <Select id="issue-type" value={type} onChange={setType} options={(Object.keys(ISSUE_LABEL) as SampleIssue['type'][]).map((k) => ({ value: k, label: ISSUE_LABEL[k] }))} />
      </div>
      <div className="re-field">
        <label htmlFor="issue-note">Note</label>
        <Input.TextArea id="issue-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  )
}

export function RejectModal(p: {
  open: boolean
  test: Test | null
  preselected: string[]
  onOk: (reason: string, params: string[] | null) => Promise<void>
  onCancel: () => void
}) {
  const [scope, setScope] = useState<'test' | 'params'>('test')
  const [params, setParams] = useState<string[]>([])
  useEffect(() => {
    if (p.open) {
      setParams(p.preselected)
      setScope(p.preselected.length ? 'params' : 'test')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open])
  const list: Parameter[] = p.test?.parameters.filter((x) => x.structure !== 'group') ?? []
  return (
    <ReasonModal
      open={p.open}
      title={`Reject: ${p.test?.name ?? ''}`}
      kind="reject"
      required
      danger
      okText="Reject"
      onCancel={p.onCancel}
      onOk={(reason) => p.onOk(reason, scope === 'test' ? null : params)}
      extra={
        <div className="re-field">
          <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
            <Radio value="test">Whole test</Radio>
            <Radio value="params" disabled={!list.length}>Selected parameters</Radio>
          </Radio.Group>
          {scope === 'params' && (
            <Checkbox.Group value={params} onChange={(v) => setParams(v as string[])} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--s-2) var(--s-4)', marginTop: 'var(--s-3)' }} options={list.map((x) => ({ value: x.key, label: x.name }))} />
          )}
        </div>
      }
    />
  )
}

// Pick values from an analyser run into the draft.
export function MachineValueModal(p: {
  open: boolean
  test: Test | null
  runs: MachineRun[]
  current: Values
  onApply: (picked: Record<string, string>, mic?: Record<string, string>) => void
  onCancel: () => void
}) {
  const [runId, setRunId] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const run = p.runs.find((r) => r.id === runId) ?? p.runs[0]
  useEffect(() => {
    if (p.open && p.runs[0]) {
      setRunId(p.runs[0].id)
      setPicked(Object.keys(p.runs[0].values))
    }
  }, [p.open, p.runs])
  const rows = useMemo(
    () =>
      Object.entries(run?.values ?? {}).map(([k, v]) => {
        const prm = p.test?.parameters.find((x) => x.key === k || x.name.toLowerCase() === k.toLowerCase())
        return { k, key: prm?.key ?? k, name: prm?.name ?? k, value: v, cur: p.current[prm?.key ?? k]?.value ?? '' }
      }),
    [run, p.test, p.current],
  )
  return (
    <Modal
      open={p.open}
      title={`Machine value: ${p.test?.name ?? ''}`}
      width={dialogWidth(560)}
      okText="Use selected values"
      okButtonProps={{ disabled: !picked.length }}
      onCancel={p.onCancel}
      onOk={() => {
        const sel = rows.filter((r) => picked.includes(r.k))
        const mic = Object.fromEntries(sel.filter((r) => run?.mic?.[r.k]).map((r) => [r.key, run!.mic![r.k]]))
        p.onApply(Object.fromEntries(sel.map((r) => [r.key, r.value])), mic)
      }}
      destroyOnHidden
    >
      {p.runs.length > 1 && (
        <div className="re-field">
          <label htmlFor="mv-run">Analyser run</label>
          <Select id="mv-run" value={run?.id} onChange={(v) => { setRunId(v); setPicked(Object.keys(p.runs.find((r) => r.id === v)?.values ?? {})) }} options={p.runs.map((r) => ({ value: r.id, label: r.label }))} />
        </div>
      )}
      <Table
        size="small"
        pagination={false}
        rowKey="k"
        dataSource={rows}
        rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as string[]) }}
        columns={[
          { title: 'Parameter', dataIndex: 'name' },
          { title: 'Machine value', dataIndex: 'value' },
          { title: 'Entered now', dataIndex: 'cur' },
        ]}
      />
    </Modal>
  )
}

// Critical value call-out: who was told, how, and that they read the value back.
export function CriticalAckModal(p: {
  open: boolean
  testName: string
  summary: string
  noteRequired?: boolean // NABL critical remark prompt
  onOk: (a: { notifiedTo: string; mode: 'phone' | 'inPerson' | 'whatsapp' | 'other'; readBack: boolean; note: string }) => Promise<void> | void
  onCancel: () => void
}) {
  const [who, setWho] = useState('')
  const [mode, setMode] = useState<'phone' | 'inPerson' | 'whatsapp' | 'other'>('phone')
  const [readBack, setReadBack] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (p.open) {
      setWho('')
      setMode('phone')
      setReadBack(false)
      setNote('')
    }
  }, [p.open])
  return (
    <Modal
      open={p.open}
      title={`Critical value: ${p.testName}`}
      okText="Record notification"
      okButtonProps={{ disabled: !who.trim() || !readBack || (!!p.noteRequired && !note.trim()), loading: busy }}
      onCancel={p.onCancel}
      onOk={async () => {
        setBusy(true)
        try {
          await p.onOk({ notifiedTo: who.trim(), mode, readBack, note: note.trim() })
        } finally {
          setBusy(false)
        }
      }}
      destroyOnHidden
    >
      <div className="re-notice re-notice--crit" role="alert"><b>{p.summary}</b></div>
      <FormSection title="Who was told" description="Record the person and how they were reached.">
        <FieldGrid min={240}>
          <div className="re-field">
            <label htmlFor="crit-who">Person notified (name and role)</label>
            <Input id="crit-who" value={who} onChange={(e) => setWho(e.target.value)} placeholder="e.g. Dr Rao, ward nurse" />
          </div>
          <div className="re-field">
            <label htmlFor="crit-channel">How were they told</label>
            <Select id="crit-channel" value={mode} onChange={setMode} options={[{ value: 'phone', label: 'Phone call' }, { value: 'inPerson', label: 'In person' }, { value: 'whatsapp', label: 'WhatsApp / message' }, { value: 'other', label: 'Other' }]} />
          </div>
        </FieldGrid>
        <Checkbox checked={readBack} onChange={(e) => setReadBack(e.target.checked)}>The person read the value back to me</Checkbox>
      </FormSection>
      <FormSection title="Remarks">
        <div className="re-field">
          <label htmlFor="crit-note">Note{p.noteRequired ? " (required)" : ""}</label>
          <Input.TextArea id="crit-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </FormSection>
    </Modal>
  )
}

// Edit the reference range of ONE result (e.g. a lab-specific limit for this patient). Needs a reason; the change is
// kept in the result's range audit trail. Clearing returns to the catalogue range.
export function RangeEditModal(p: {
  open: boolean
  paramName: string
  unit: string
  current: { low: number | null; high: number | null; text: string }
  edited: boolean
  onOk: (r: { low: number | null; high: number | null; text: string; reason: string } | null) => void
  onCancel: () => void
}) {
  const [low, setLow] = useState<number | null>(null)
  const [high, setHigh] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (p.open) {
      setLow(p.current.low)
      setHigh(p.current.high)
      setText(p.current.text)
      setReason('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open])
  const bad = low !== null && high !== null && low > high
  return (
    <Modal
      open={p.open}
      title={`Edit reference range: ${p.paramName}`}
      okText="Apply to this result"
      okButtonProps={{ disabled: !reason.trim() || bad || (low === null && high === null && !text.trim()) }}
      onCancel={p.onCancel}
      onOk={() => p.onOk({ low, high, text: text.trim(), reason: reason.trim() })}
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          {p.edited && <button type="button" className="dbtn press dbtn--text" onClick={() => p.onOk(null)}><span>Use catalogue range</span></button>}
          <CancelBtn />
          <OkBtn />
        </>
      )}
      destroyOnHidden
    >
      <p className="wl-muted" style={{ marginTop: 0 }}>This changes the range for this one result only. The catalogue stays as it is.</p>
      <FormSection title="Allowed range">
        <FieldGrid min={180}>
          <div className="re-field">
            <label htmlFor="rg-low">Low</label>
            <InputNumber id="rg-low" style={{ width: '100%' }} value={low} onChange={setLow} addonAfter={p.unit || undefined} />
          </div>
          <div className="re-field">
            <label htmlFor="rg-high">High</label>
            <InputNumber id="rg-high" style={{ width: '100%' }} value={high} onChange={setHigh} addonAfter={p.unit || undefined} />
          </div>
        </FieldGrid>
        {bad && <div className="re-notice re-notice--crit" role="alert">Low must not be above high.</div>}
        <div className="re-field">
          <label htmlFor="rg-text">Text shown on the report (optional)</label>
          <Input id="rg-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave blank to show low - high" />
        </div>
      </FormSection>
      <FormSection title="Why">
        <div className="re-field">
          <label htmlFor="rg-reason">Reason (required)</label>
          <Input.TextArea id="rg-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </FormSection>
    </Modal>
  )
}
