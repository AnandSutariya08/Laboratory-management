import { useMemo, useState } from 'react'
import { App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { addDoc, doc as fsDoc, orderBy, query, serverTimestamp, Timestamp, updateDoc, writeBatch } from 'firebase/firestore'
import { col, docRef } from '../../../lib/db'
import { db } from '../../../firebase'
import { can } from '../../../auth/AuthProvider'
import { stripUndefined } from '../lib/clean'
import { useAuth } from '../../../auth/AuthProvider'
import { useCatalogueMaps, useLabSettings } from '../../../hooks/useCatalogue'
import { extractEqasReport, type EqasExtract } from '../../../lib/ai'
import { useLiveQuery } from '../../../hooks/useLive'
import { fmtDate } from '../../../components/results/common'
import { nameScore, EXTRACT_MIN_SCORE } from '../../../lib/fuzzy'
import { biasPct, fmt, sdi } from '../lib/stats'
import { QC, type Capa, type EqasOutcome, type EqasRound, type QcSettings } from '../types'
import { useQcSettings } from '../lib/useQcSettings'
import CapaModal from './CapaModal'
import EqasTrend from './EqasTrend'
import { numericParams, paramName, TestParamSelect, useCapas, useMachines, useRecentRuns, type TestParam } from './shared'
import { Button as DsButton } from '../../../design/Button'
import { Segmented } from '../../../design/Segmented'
import { Chip, Panel } from '../ui'
import { branchStamp } from '../../../lib/activeBranch'
import { useBranchScope } from '../../../lib/branchScope'
import { dialogWidth } from '../../../design/dialog'


// |SDI| <= 2 acceptable; 2 < |SDI| <= 3 warning; > 3 unacceptable.
// Limits come from QC settings: SDI warn / fail (default 2 / 3), or a fixed percent deviation from the assigned value.
export interface EqasLimits { mode?: 'sdi' | 'percent'; warn?: number; fail?: number; pct?: number }
export const eqasLimitsOf = (s: Partial<QcSettings>): EqasLimits => ({ mode: s.eqasMode, warn: s.eqasSdiWarn, fail: s.eqasSdiFail, pct: s.eqasPctLimit })
export function evalEqas(our: number, peerMean: number, peerSd: number, limits: EqasLimits = {}) {
  const s = sdi(our, peerMean, peerSd)
  const dev = biasPct(our, peerMean)
  const warn = limits.warn ?? 2
  const fail = limits.fail ?? 3
  let outcome: EqasOutcome = 'notEvaluated'
  if (limits.mode === 'percent' && Number.isFinite(dev)) {
    const lim = limits.pct ?? 10
    outcome = Math.abs(dev) <= lim ? 'acceptable' : Math.abs(dev) <= lim * 1.5 ? 'warning' : 'unacceptable'
  } else if (Number.isFinite(s)) outcome = Math.abs(s) <= warn ? 'acceptable' : Math.abs(s) <= fail ? 'warning' : 'unacceptable'
  return { sdi: Number.isFinite(s) ? s : null, devPct: Number.isFinite(dev) ? dev : null, outcome }
}

export const useEqas = () => {
  const scope = useBranchScope()
  return useLiveQuery<EqasRound>(query(col(QC.eqas), ...scope.constraints, orderBy('date', 'desc')), [scope.key])
}

interface ProgrammeVals {
  provider: string
  programmeId: string
  cycleStart: dayjs.Dayjs
  cycleEnd: dayjs.Dayjs
  frequency: string
  mappings: { machineId?: string; sampleType?: string; sampleName: string; startDate: dayjs.Dayjs; testIds: string[] }[]
}

const STEP: Record<string, number> = { monthly: 1, quarterly: 3, 'half-yearly': 6, yearly: 12 }

type EqasTab = 'list' | 'run' | 'missed' | 'completed' | 'verified' | 'notPerformed' | 'deleted'

interface FormVals {
  provider: string
  programmeId: string
  cycle: string
  frequency: string
  round: string
  sampleId: string
  machineId?: string
  sampleType?: string
  dueDate: dayjs.Dayjs
  tp: TestParam
  ourResult?: number
  peerMean?: number
  peerSd?: number
  date: dayjs.Dayjs
  notes: string
  reportUrl?: string
}

const today = () => dayjs().format('YYYY-MM-DD')
const isOpen = (r: EqasRound) => r.status === 'scheduled' || r.status === 'pending'
const isMissed = (r: EqasRound) => isOpen(r) && !!r.dueDate && r.dueDate < today()
const cycleOf = (r: EqasRound) => `${r.provider}${r.cycle ? ` · cycle ${r.cycle}` : r.round ? ` · ${r.round}` : ''}`

export { nameScore, EXTRACT_MIN_SCORE }

export default function EqasSection() {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const maps = useCatalogueMaps()
  const { data, loading } = useEqas()
  const { data: machines } = useMachines()
  const [tab, setTab] = useState<EqasTab>('list')
  const { settings: qcSettings } = useQcSettings()
  const limits = eqasLimitsOf(qcSettings)
  const { data: capas } = useCapas()
  const [capa, setCapa] = useState<Partial<Capa> | null>(null)
  const canVerify = can(profile, 'qc.approveCapa')
  const [editing, setEditing] = useState<Partial<EqasRound> | null>(null)
  const [programme, setProgramme] = useState(false)
  const labSettings = useLabSettings()
  const matchDays = labSettings.nabl?.eqasMatchDays ?? 7
  const { data: recentRuns } = useRecentRuns()
  const [extractOpen, setExtractOpen] = useState(false)
  const [extractText, setExtractText] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [extracted, setExtracted] = useState<EqasExtract | null>(null)
  const [pform] = Form.useForm<ProgrammeVals>()
  const [act, setAct] = useState<{ kind: 'reschedule' | 'delete' | 'notPerformed'; round: EqasRound } | null>(null)
  const [actReason, setActReason] = useState('')
  const [newDue, setNewDue] = useState<dayjs.Dayjs | null>(null)
  const [form] = Form.useForm<FormVals>()
  const w = Form.useWatch([], form)
  const live = w && w.ourResult != null && w.peerMean != null && w.peerSd != null ? evalEqas(w.ourResult, w.peerMean, w.peerSd, limits) : null

  const open = (r: Partial<EqasRound>) => {
    setEditing(r)
    form.resetFields()
    form.setFieldsValue({
      date: r.date ? dayjs(r.date.toDate()) : dayjs(),
      dueDate: r.dueDate ? dayjs(r.dueDate) : dayjs(),
      tp: { testId: r.testId, paramKey: r.paramKey },
      provider: r.provider,
      programmeId: r.programmeId,
      cycle: r.cycle ?? String(dayjs().year()),
      frequency: r.frequency ?? 'monthly',
      round: r.round,
      sampleId: r.sampleId,
      machineId: r.machineId,
      sampleType: r.sampleType,
      ourResult: r.status === 'scheduled' ? undefined : r.ourResult,
      peerMean: r.status === 'scheduled' ? undefined : r.peerMean,
      peerSd: r.status === 'scheduled' ? undefined : r.peerSd,
      notes: r.notes,
      reportUrl: r.reportUrl,
    } as FormVals)
  }

  // AI extraction from pasted report text (no PDF parsing): fills peer mean / SD / our result for the chosen parameter.
  const runExtract = async () => {
    setExtracting(true)
    try {
      setExtracted(await extractEqasReport({ text: extractText }))
    } catch (e) {
      message.error((e instanceof Error ? e.message : 'Extraction failed').replace(/\s*\[\d+\]\s*$/, ''))
    } finally {
      setExtracting(false)
    }
  }
  const applyExtract = (row: EqasExtract['results'][number]) => {
    form.setFieldsValue({
      ...(row.labValue != null ? { ourResult: row.labValue } : {}),
      ...(row.peerMean != null ? { peerMean: row.peerMean } : {}),
      ...(row.peerSd != null ? { peerSd: row.peerSd } : {}),
      ...(extracted?.provider && !form.getFieldValue('provider') ? { provider: extracted.provider } : {}),
      ...(extracted?.cycle && !form.getFieldValue('round') ? { round: extracted.cycle } : {}),
    } as Partial<FormVals>)
    setExtractOpen(false)
    message.success('Values filled in. Check them against the report before saving.')
  }
  const wantName = (() => {
    const tp = form.getFieldValue('tp') as { testId?: string; paramKey?: string } | undefined
    return tp?.paramKey ? paramName(maps.testById.get(tp.testId ?? ''), tp.paramKey) : ''
  })()
  // IQC performance on the round's machine within +/- eqasMatchDays of the result date.
  const iqcNear = (() => {
    const mid = w?.machineId as string | undefined
    const d = w?.date as dayjs.Dayjs | undefined
    if (!mid || !d) return null
    const from = d.subtract(matchDays, 'day').startOf('day').valueOf()
    const to = d.add(matchDays, 'day').endOf('day').valueOf()
    const rs = recentRuns.filter((r) => !r.deleted && r.machineId === mid && (r.runAt?.toMillis() ?? 0) >= from && (r.runAt?.toMillis() ?? 0) <= to)
    return { n: rs.length, fail: rs.filter((r) => r.status === 'fail').length, warn: rs.filter((r) => r.status === 'warning').length }
  })()

  const save = async () => {
    const v = await form.validateFields()
    if (!v.tp?.testId || !v.tp.paramKey) {
      message.warning('Choose a test and parameter')
      return
    }
    const test = maps.testById.get(v.tp.testId)
    const hasResult = v.ourResult != null && v.peerMean != null && v.peerSd != null
    const calc = hasResult ? evalEqas(v.ourResult!, v.peerMean!, v.peerSd!, limits) : { sdi: null, devPct: null, outcome: 'notEvaluated' as EqasOutcome }
    const doc = {
      provider: v.provider.trim(),
      programmeId: (v.programmeId ?? '').trim(),
      cycle: (v.cycle ?? '').trim(),
      frequency: v.frequency ?? '',
      round: (v.round ?? '').trim(),
      sampleId: (v.sampleId ?? '').trim(),
      machineId: v.machineId ?? '',
      machineName: machines.find((m) => m.id === v.machineId)?.name ?? '',
      sampleType: v.sampleType ?? '',
      dueDate: v.dueDate.format('YYYY-MM-DD'),
      testId: v.tp.testId,
      testName: test?.name ?? '',
      paramKey: v.tp.paramKey,
      paramName: paramName(test, v.tp.paramKey),
      ourResult: v.ourResult ?? 0,
      peerMean: v.peerMean ?? 0,
      peerSd: v.peerSd ?? 0,
      ...calc,
      status: (hasResult ? (editing?.status === 'verified' ? 'verified' : 'completed') : 'scheduled') as EqasRound['status'],
      notes: v.notes ?? '',
      reportUrl: (v.reportUrl ?? '').trim(),
      date: Timestamp.fromDate(v.date.toDate()),
    }
    try {
      if (editing?.id && editing.status === 'verified') return void setEditing(null)
      if (editing?.id) await updateDoc(docRef(QC.eqas, editing.id), doc)
      else await addDoc(col(QC.eqas), { ...doc, ...branchStamp(), createdBy: user?.uid ?? '', createdByName: profile?.name ?? '', createdAt: serverTimestamp() })
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const err = (e: Error) => message.error(e.message)
  const verify = (r: EqasRound) => updateDoc(docRef(QC.eqas, r.id), { status: 'verified', verifiedByName: profile?.name ?? '', verifiedAt: serverTimestamp() }).catch(err)
  const restore = (r: EqasRound) => updateDoc(docRef(QC.eqas, r.id), { status: r.ourResult === 0 && r.peerSd === 0 ? 'scheduled' : 'completed', deleteReason: '', notPerformedReason: '' }).catch(err)
  const confirmAct = async () => {
    if (!act) return
    const reason = actReason.trim()
    if (!reason) return void message.warning('A reason is needed')
    try {
      if (act.kind === 'notPerformed') {
        await updateDoc(docRef(QC.eqas, act.round.id), { status: 'notPerformed', notPerformedReason: reason, notPerformedBy: profile?.name ?? '' })
      } else if (act.kind === 'delete') {
        await updateDoc(docRef(QC.eqas, act.round.id), { status: 'deleted', deleteReason: reason })
      } else {
        if (!newDue) return void message.warning('Pick the new date')
        const from = act.round.dueDate ?? ''
        await updateDoc(docRef(QC.eqas, act.round.id), {
          dueDate: newDue.format('YYYY-MM-DD'),
          rescheduledFrom: act.round.rescheduledFrom ?? from,
          rescheduleReason: reason,
          rescheduleHistory: [...(act.round.rescheduleHistory ?? []), { from, to: newDue.format('YYYY-MM-DD'), reason, byName: profile?.name ?? '', at: Date.now() }],
        })
      }
      setAct(null)
      setActReason('')
      setNewDue(null)
    } catch (e) {
      err(e as Error)
    }
  }

  // Programme: provider + cycle + mappings (machine, sample type, sample name, start date, tests). Generates one
  // scheduled round per parameter for every occurrence between the start date and the end of the cycle.
  const saveProgramme = async () => {
    const v = await pform.validateFields()
    const step = STEP[v.frequency] ?? 1
    const batch = writeBatch(db)
    let n = 0
    for (const m of v.mappings ?? []) {
      let d = m.startDate
      let round = 1
      while (!d.isAfter(v.cycleEnd, 'day') && round <= 60) {
        for (const tid of m.testIds ?? []) {
          const test = maps.testById.get(tid)
          for (const p of numericParams(test)) {
            const ref = fsDoc(col(QC.eqas))
            batch.set(ref, stripUndefined({
              ...branchStamp(),
              provider: v.provider.trim(),
              programmeId: (v.programmeId ?? '').trim(),
              cycle: `${v.cycleStart.format('YYYY')}${v.cycleStart.year() !== v.cycleEnd.year() ? `-${v.cycleEnd.format('YY')}` : ''}`,
              cycleStart: v.cycleStart.format('YYYY-MM-DD'),
              cycleEnd: v.cycleEnd.format('YYYY-MM-DD'),
              frequency: v.frequency,
              round: `R${round}`,
              sampleId: m.sampleName,
              machineId: m.machineId ?? '',
              machineName: machines.find((x) => x.id === m.machineId)?.name ?? '',
              sampleType: m.sampleType ?? '',
              dueDate: d.format('YYYY-MM-DD'),
              testId: tid,
              testName: test?.name ?? '',
              paramKey: p.key,
              paramName: p.name,
              ourResult: 0,
              peerMean: 0,
              peerSd: 0,
              sdi: null,
              devPct: null,
              outcome: 'notEvaluated',
              status: 'scheduled',
              notes: '',
              date: Timestamp.fromDate(d.toDate()),
              createdBy: user?.uid ?? '',
              createdByName: profile?.name ?? '',
              createdAt: serverTimestamp(),
            }))
            n++
          }
        }
        d = d.add(step, 'month')
        round++
      }
    }
    if (!n) return void message.warning('Add at least one mapping with tests that have numeric parameters')
    if (n > 450) return void message.warning('That would create too many rounds at once; split the programme')
    try {
      await batch.commit()
      message.success(`${n} EQAS round(s) scheduled`)
      setProgramme(false)
    } catch (e) {
      err(e as Error)
    }
  }

  const live_ = data.filter((r) => r.status !== 'deleted' && r.status !== 'notPerformed')
  const filtered: Record<EqasTab, EqasRound[]> = {
    list: live_,
    run: live_.filter(isOpen),
    missed: live_.filter(isMissed),
    completed: live_.filter((r) => r.status === 'completed'),
    verified: live_.filter((r) => r.status === 'verified'),
    notPerformed: data.filter((r) => r.status === 'notPerformed'),
    deleted: data.filter((r) => r.status === 'deleted'),
  }
  const rows = filtered[tab]
  const groups = useMemo(() => {
    const m = new Map<string, EqasRound[]>()
    for (const r of rows) m.set(cycleOf(r), [...(m.get(cycleOf(r)) ?? []), r])
    return [...m.entries()]
  }, [rows])

  const columns = [
    { title: 'Due / date', render: (_: unknown, r: EqasRound) => (r.dueDate ? dayjs(r.dueDate).format('DD MMM YYYY') : fmtDate(r.date)) },
    { title: 'EQAS ID', dataIndex: 'programmeId' },
    { title: 'Round', dataIndex: 'round' },
    { title: 'Machine', dataIndex: 'machineName' },
    { title: 'Sample', dataIndex: 'sampleId' },
    { title: 'Test / parameter', render: (_: unknown, r: EqasRound) => `${r.testName} / ${r.paramName}` },
    { title: 'Our result', render: (_: unknown, r: EqasRound) => (isOpen(r) ? '-' : r.ourResult) },
    { title: 'Peer mean ± SD', render: (_: unknown, r: EqasRound) => (isOpen(r) ? '-' : `${r.peerMean} ± ${r.peerSd}`) },
    { title: 'SDI / z', render: (_: unknown, r: EqasRound) => fmt(r.sdi) },
    { title: 'Outcome', render: (_: unknown, r: EqasRound) => <Chip status={r.outcome} /> },
    { title: 'Status', render: (_: unknown, r: EqasRound) => (isMissed(r) ? <Chip status="missed">Missed</Chip> : <Chip status={r.status} />) },
    { title: 'Remark', render: (_: unknown, r: EqasRound) => (r.status === 'notPerformed' ? `Not performed: ${r.notPerformedReason ?? ''}` : r.status === 'deleted' ? `Deleted: ${r.deleteReason ?? ''}` : r.rescheduledFrom ? `Rescheduled from ${dayjs(r.rescheduledFrom).format('DD MMM')}: ${r.rescheduleReason ?? ''}` : r.verifiedByName ? `Verified by ${r.verifiedByName}` : '') },
    {
      title: 'Report',
      render: (_: unknown, r: EqasRound) => (r.reportUrl ? <a href={r.reportUrl} target="_blank" rel="noreferrer">Open</a> : '-'),
    },
    {
      title: '',
      render: (_: unknown, r: EqasRound) => {
        const locked = r.status === 'verified' // verified rounds are immutable
        return (
          <Space wrap>
            {r.status !== 'deleted' && r.status !== 'notPerformed' && !locked && <Button size="small" onClick={() => open(r)}>{isOpen(r) ? 'Enter result' : 'Edit'}</Button>}
            {isOpen(r) && <Button size="small" onClick={() => setAct({ kind: 'notPerformed', round: r })}>Not performed</Button>}
            {(r.outcome === 'unacceptable' || r.outcome === 'warning') && !isOpen(r) && r.status !== 'deleted' && !capas.some((c) => c.sourceId === r.id) && (
              <Button size="small" onClick={() => setCapa({ sourceType: 'eqas', sourceId: r.id, machineId: r.machineId, machineName: r.machineName, cause: `EQAS ${r.provider} ${r.round}: ${r.testName} / ${r.paramName} SDI ${fmt(r.sdi)}` })}>Raise CAPA</Button>
            )}
            {capas.some((c) => c.sourceId === r.id) && <Chip status="open">CAPA raised</Chip>}
            {r.status !== 'deleted' && locked && <Button size="small" onClick={() => open(r)}>View</Button>}
            {isOpen(r) && <Button size="small" onClick={() => { setAct({ kind: 'reschedule', round: r }); setNewDue(r.dueDate ? dayjs(r.dueDate) : dayjs()) }}>Reschedule</Button>}
            {r.status === 'completed' && canVerify && <Button size="small" onClick={() => verify(r)}>Verify</Button>}
            {r.status === 'deleted' || r.status === 'notPerformed' ? <Button size="small" onClick={() => restore(r)}>Restore</Button> : !locked && <Button size="small" danger onClick={() => setAct({ kind: 'delete', round: r })}>Delete</Button>}
          </Space>
        )
      },
    },
  ]

  return (
    <>
      <div className="qc-toolbar">
        <Segmented
          aria-label="EQAS views"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'list', label: 'EQAS list', count: filtered.list.length },
            { value: 'run', label: 'Run EQAS', count: filtered.run.length },
            { value: 'missed', label: 'Missed EQAS', count: filtered.missed.length },
            { value: 'completed', label: 'Completed EQAS', count: filtered.completed.length },
            { value: 'verified', label: 'Verified EQAS', count: filtered.verified.length },
            { value: 'notPerformed', label: 'Not performed', count: filtered.notPerformed.length },
            { value: 'deleted', label: 'Deleted EQAS', count: filtered.deleted.length },
          ]}
        />
        <span className="qc-toolbar__spacer" />
        <DsButton icon={<PlusOutlined />} onClick={() => open({})}>Add single round</DsButton>
        <DsButton variant="primary" icon={<PlusOutlined />} onClick={() => { pform.resetFields(); pform.setFieldsValue({ frequency: 'monthly', cycleStart: dayjs().startOf('year'), cycleEnd: dayjs().endOf('year'), mappings: [{ startDate: dayjs() }] } as never); setProgramme(true) }}>Add EQAS programme</DsButton>
      </div>
      <EqasTrend rounds={data.filter((r) => r.status === 'completed' || r.status === 'verified')} limits={limits} />
      {loading ? null : groups.length === 0 ? (
        <Panel>
          <p className="qc-muted" style={{ margin: 0 }}>Nothing here yet.</p>
        </Panel>
      ) : (
        <div className="qc-stack">
          {groups.map(([name, list]) => (
            <Panel key={name} title={name}>
              <Table<EqasRound> size="small" rowKey="id" dataSource={list} pagination={false} scroll={{ x: 'max-content' }} columns={columns} />
            </Panel>
          ))}
        </div>
      )}
      <Modal title={editing?.id ? 'Edit EQAS round' : 'Add EQAS round'} open={!!editing} onOk={save} okButtonProps={{ disabled: editing?.status === 'verified' }} onCancel={() => setEditing(null)} destroyOnHidden width={dialogWidth(720)}>
        <Form form={form} layout="vertical" disabled={editing?.status === 'verified'}>
          <Space wrap size="middle">
            <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
              <Input style={{ width: 200 }} placeholder="e.g. CMC Vellore" />
            </Form.Item>
            <Form.Item name="programmeId" label="EQAS ID">
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="cycle" label="Cycle (year)" rules={[{ required: true }]}>
              <Input style={{ width: 100 }} />
            </Form.Item>
            <Form.Item name="frequency" label="Frequency">
              <Select style={{ width: 140 }} options={['monthly', 'quarterly', 'half-yearly', 'yearly'].map((x) => ({ value: x, label: x }))} />
            </Form.Item>
          </Space>
          <Space wrap size="middle">
            <Form.Item name="round" label="Round" rules={[{ required: true }]}>
              <Input style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="sampleId" label="Sample ID" rules={[{ required: true }]}>
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="machineId" label="Machine">
              <Select allowClear style={{ width: 200 }} options={machines.map((m) => ({ value: m.id, label: m.name }))} />
            </Form.Item>
            <Form.Item name="sampleType" label="Sample type">
              <Select allowClear style={{ width: 160 }} options={maps.sampleTypes.map((t) => ({ value: t.name, label: t.name }))} />
            </Form.Item>
            <Form.Item name="dueDate" label="Run by" rules={[{ required: true }]}>
              <DatePicker />
            </Form.Item>
          </Space>
          <Form.Item name="tp" label="Test and parameter" rules={[{ required: true }]}>
            <TestParamSelect tests={maps.tests} />
          </Form.Item>
          <Space wrap style={{ marginBottom: 8 }}>
            <Button onClick={() => { setExtracted(null); setExtractText(''); setExtractOpen(true) }} disabled={editing?.status === 'verified'}>Read values from report text (AI)</Button>
            {iqcNear && <Typography.Text type="secondary">IQC on this machine within {matchDays} days of the result date: {iqcNear.n} runs, {iqcNear.fail} failed, {iqcNear.warn} warning</Typography.Text>}
          </Space>
          <br />
          <Typography.Text type="secondary">Leave the results empty to schedule the round; it appears under Run EQAS until you enter them.</Typography.Text>
          <Space wrap size="middle" style={{ marginTop: 8, display: 'flex' }}>
            <Form.Item name="ourResult" label="Our result">
              <InputNumber style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="peerMean" label="Peer mean">
              <InputNumber style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="peerSd" label="Peer SD">
              <InputNumber style={{ width: 140 }} min={0} />
            </Form.Item>
            <Form.Item name="date" label="Result date">
              <DatePicker />
            </Form.Item>
          </Space>
          {live && (
            <div style={{ marginBottom: 12 }}>
              SDI {fmt(live.sdi)} | deviation {fmt(live.devPct)}% | <Chip status={live.outcome} />
            </div>
          )}
          <Form.Item name="reportUrl" label="Provider report link">
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
      <CapaModal open={!!capa} initial={capa} onClose={() => setCapa(null)} />
      <Modal title="Read values from the provider report" open={extractOpen} onCancel={() => setExtractOpen(false)} footer={null} destroyOnHidden width={dialogWidth(720)}>
        <Typography.Paragraph type="secondary">Paste the text (or CSV) of the provider's report. The AI reads the values; nothing is saved until you check and save the round. PDF files are not read directly: copy their text.</Typography.Paragraph>
        <Input.TextArea rows={7} aria-label="Report text" value={extractText} onChange={(e) => setExtractText(e.target.value)} />
        <Space style={{ margin: '12px 0' }}>
          <Button type="primary" loading={extracting} disabled={!extractText.trim()} onClick={() => void runExtract()}>Extract</Button>
        </Space>
        {extracted && (
          <Table<EqasExtract['results'][number] & { score: number }>
            size="small"
            rowKey={(r) => r.parameter}
            pagination={false}
            dataSource={extracted.results.map((r) => ({ ...r, score: nameScore(r.parameter, wantName) })).sort((a, b) => b.score - a.score)}
            columns={[
              { title: 'Analyte', dataIndex: 'parameter' },
              { title: 'Match', render: (_: unknown, r) => (wantName ? (r.score >= EXTRACT_MIN_SCORE ? `${r.score}` : `${r.score} (weak)`) : '-') },
              { title: 'Lab', dataIndex: 'labValue' },
              { title: 'Peer mean', dataIndex: 'peerMean' },
              { title: 'Peer SD', dataIndex: 'peerSd' },
              { title: 'Provider SDI', dataIndex: 'providerSdi' },
              { title: '', render: (_: unknown, r) => <Button size="small" onClick={() => applyExtract(r)} aria-label={`Use ${r.parameter}`}>Use</Button> },
            ]}
          />
        )}
      </Modal>
      <Modal title="Add EQAS programme" open={programme} onOk={saveProgramme} onCancel={() => setProgramme(false)} destroyOnHidden width={dialogWidth(820)} okText="Schedule rounds">
        <Form form={pform} layout="vertical">
          <Space wrap size="middle">
            <Form.Item name="provider" label="Provider" rules={[{ required: true }]}><Input style={{ width: 200 }} placeholder="e.g. CMC Vellore" /></Form.Item>
            <Form.Item name="programmeId" label="EQAS ID"><Input style={{ width: 140 }} /></Form.Item>
            <Form.Item name="cycleStart" label="Cycle start" rules={[{ required: true }]}><DatePicker /></Form.Item>
            <Form.Item name="cycleEnd" label="Cycle end" rules={[{ required: true }]}><DatePicker /></Form.Item>
            <Form.Item name="frequency" label="Frequency" rules={[{ required: true }]}>
              <Select style={{ width: 140 }} options={['monthly', 'quarterly', 'half-yearly', 'yearly'].map((x) => ({ value: x, label: x }))} />
            </Form.Item>
          </Space>
          <Typography.Text strong>Mappings</Typography.Text>
          <Form.List name="mappings">
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} wrap align="start" style={{ display: 'flex', marginTop: 8 }}>
                    <Form.Item name={[f.name, 'machineId']} label="Machine"><Select allowClear style={{ width: 170 }} options={machines.map((m) => ({ value: m.id, label: m.name }))} /></Form.Item>
                    <Form.Item name={[f.name, 'sampleType']} label="Sample type"><Select allowClear style={{ width: 140 }} options={maps.sampleTypes.map((t) => ({ value: t.name, label: t.name }))} /></Form.Item>
                    <Form.Item name={[f.name, 'sampleName']} label="Sample name" rules={[{ required: true }]}><Input style={{ width: 130 }} /></Form.Item>
                    <Form.Item name={[f.name, 'startDate']} label="First round" rules={[{ required: true }]}><DatePicker /></Form.Item>
                    <Form.Item name={[f.name, 'testIds']} label="Tests (all numeric parameters)" rules={[{ required: true }]}>
                      <Select mode="multiple" optionFilterProp="label" style={{ width: 260 }} options={maps.tests.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))} />
                    </Form.Item>
                    <Button onClick={() => remove(f.name)} aria-label="Remove mapping">Remove</Button>
                  </Space>
                ))}
                <Button onClick={() => add({ startDate: dayjs() })}>Add mapping</Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
      <Modal
        title={act?.kind === 'delete' ? 'Delete EQAS round' : act?.kind === 'notPerformed' ? 'Mark EQAS round not performed' : 'Reschedule EQAS round'}
        open={!!act}
        onOk={confirmAct}
        onCancel={() => { setAct(null); setActReason(''); setNewDue(null) }}
        okText={act?.kind === 'delete' ? 'Delete' : act?.kind === 'notPerformed' ? 'Mark not performed' : 'Reschedule'}
        okButtonProps={{ danger: act?.kind === 'delete' }}
        destroyOnHidden
      >
        <Space vertical style={{ width: '100%' }}>
          {act?.kind === 'reschedule' && <DatePicker value={newDue} onChange={setNewDue} aria-label="New due date" />}
          <Input.TextArea rows={3} aria-label="Reason" placeholder="Reason (required)" value={actReason} onChange={(e) => setActReason(e.target.value)} />
        </Space>
      </Modal>
    </>
  )
}

