import { useEffect, useMemo, useRef, useState } from 'react'
import { labContactLine } from '../settings/lib'
import { showInterpretation, testComment } from '../../pages/catalogue/flags'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { App, Checkbox, Input, Modal, Select, Switch } from 'antd'
import {
  AudioOutlined, CheckOutlined, HistoryOutlined, LeftOutlined, SendOutlined, LinkOutlined, PauseCircleOutlined, PictureOutlined, PrinterOutlined, RightOutlined, SaveOutlined, TeamOutlined, UndoOutlined,
} from '@ant-design/icons'
import { query, serverTimestamp, where } from 'firebase/firestore'
import { col, docRef, paths, resultsCol } from '../../lib/db'
import { recomputeOrder } from '../../lib/orders'
import { draftRadiologyImpression } from '../../lib/ai'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { can, useAuth } from '../../auth/AuthProvider'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { FieldGrid, FormSection } from '../../design/FormLayout'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonCard } from '../../design/Skeletons'
import { ageText, fmtDateTime, genderText, liveItems } from '../../components/results/common'
import { addVersion, approveEntries, syncItems, writeResult } from '../../components/results/resultOps'
import { ReasonModal } from '../../components/results/Dialogs'
import type { OrderExt, ResultExt } from '../../components/results/types'
import type { Test, UserProfile } from '../../types'
import { compressImage, dataUrlBytes, fillTokens, fillTokensHtml, MACROS, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TOTAL_BYTES, modalityOf, uploadKeyImages, validDicomUrl } from './lib'
import { buildViewerUrl, isUltrasound, useRadConfig } from './config'
import { DICTATION_LANGS, useDictation } from './dictation'
import HistoryModal from './History'
import { RadImg } from './StorageImg'
import { useMyMacros } from './userMacros'
import SendReportModal from '../../components/messaging/SendReportModal'
import FormFAction from '../pcpndt/FormFAction'
import { formFBlocked } from '../pcpndt/lib'
import { code128Svg } from '../../pages/report/barcode'
import { requestExternalOpinion } from './api'
import { useRadMacros, useRadTemplates } from './TemplatesModal'
import MacrosModal from './MacrosModal'
import RichText, { radHtml, radHasText, type RichHandle } from './richtext'
import { EMPTY_RAD, type RadiologyData, type SecondOpinion } from './types'
import { RAD_IDS_KEY } from './RadiologyPage'
import './radiology.css'
import dayjs from 'dayjs'

type Field = 'technique' | 'findings' | 'impression'

export default function RadiologyReportPage() {
  const { orderId = '' } = useParams()
  const [sp, setSp] = useSearchParams()
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const { user, profile } = useAuth()
  const settings = useLabSettings()
  const maps = useCatalogueMaps()
  const templates = useRadTemplates()
  const labMacros = useRadMacros()
  const myMacros = useMyMacros()
  const radCfg = useRadConfig()
  const { data: order, loading } = useLiveDoc<OrderExt>(orderId ? docRef(paths.orders, orderId) : null, [orderId])
  const { data: results, loading: resLoading } = useLiveQuery<ResultExt>(orderId ? resultsCol(orderId) : null, [orderId])
  const { data: doctorUsers } = useLiveQuery<UserProfile>(query(col<UserProfile>(paths.users), where('role', '==', 'doctor')), [])

  const radTests = useMemo(() => {
    if (!order) return []
    const seen = new Set<string>()
    const out: Test[] = []
    liveItems(order).forEach((i) =>
      i.testIds.forEach((tid) => {
        const t = maps.testById.get(tid)
        if (t && !seen.has(tid) && modalityOf(t, maps.departmentById.get(t.departmentId)?.name ?? '', radCfg.modalities)) {
          seen.add(tid)
          out.push(t)
        }
      }),
    )
    return out
  }, [order, maps.testById, maps.departmentById, radCfg.modalities])

  const testId = sp.get('test') && radTests.some((t) => t.id === sp.get('test')) ? sp.get('test')! : radTests[0]?.id ?? ''
  const test = radTests.find((t) => t.id === testId)
  const result = results.find((r) => r.testId === testId)
  const saved: RadiologyData = useMemo(() => ({ ...EMPTY_RAD, ...((result?.radiology as Partial<RadiologyData>) ?? {}) }), [result])
  const [draft, setDraft] = useState<RadiologyData | null>(null)
  const [busy, setBusy] = useState(false)
  const [holdOpen, setHoldOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [soOpen, setSoOpen] = useState(false)
  const [soDoctor, setSoDoctor] = useState('')
  const [soNote, setSoNote] = useState('')
  const [opinion, setOpinion] = useState('')
  const [letterhead, setLetterhead] = useState<boolean | null>(null)
  const active = useRef<RichHandle | null>(null)
  const [macrosOpen, setMacrosOpen] = useState(false)
  const [variantSel, setVariantSel] = useState<'all' | 'normal' | 'abnormal'>('all')
  const doneParams = useRef('')
  const [histOpen, setHistOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [extOpen, setExtOpen] = useState(false)
  const [extName, setExtName] = useState('')
  const [extEmail, setExtEmail] = useState('')
  const [cosign, setCosign] = useState(false)
  const [dictLang, setDictLang] = useState('en-IN')
  const autosaving = useRef(false)

  // Load the saved report into the editor whenever the test (or the stored doc) changes and nothing is being edited.
  useEffect(() => {
    setDraft(null)
  }, [testId, orderId])
  const d = draft ?? saved
  const dirty = !!draft
  const locked = result?.status === 'approved'
  const canEnter = can(profile, 'results.enter')
  const canApprove = can(profile, 'results.approve')
  const canUnapprove = can(profile, 'results.unapprove') || can(profile, 'results.amend')
  const uid = user?.uid ?? profile?.uid ?? ''
  const who = { uid, name: profile?.name ?? '' }
  // Autosave (RAD-11): an unsaved draft is stored every N seconds (Lab settings, Radiology) and adds a revision.
  const autosaveRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!dirty || locked || !canEnter || !radCfg.autosaveSeconds) return
    const t = setInterval(() => autosaveRef.current(), radCfg.autosaveSeconds * 1000)
    return () => clearInterval(t)
  }, [dirty, locked, canEnter, radCfg.autosaveSeconds])
  const dictation = useDictation((text) => active.current?.insertText(text), dictLang)

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // Row actions from the worklist: ?print=1 opens the print dialog, ?view=images scrolls to the images.
  useEffect(() => {
    if (loading || resLoading || !order || !testId) return
    const key = `${orderId}|${testId}|${sp.get('print')}|${sp.get('view')}`
    if (doneParams.current === key) return
    doneParams.current = key
    if (sp.get('view') === 'images') document.getElementById('rd-images-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (sp.get('print') === '1') setTimeout(() => window.print(), 600)
  }, [loading, resLoading, order, testId, orderId, sp])

  if (loading) return <SkeletonCard lines={6} />
  if (!order) return <EmptyState title="Order not found" />
  if (!test) return <EmptyState title="No radiology test on this bill" description="Open a bill that includes an imaging study." />

  const modality = d.modality || modalityOf(test, maps.departmentById.get(test.departmentId)?.name ?? '')
  const patch = (p: Partial<RadiologyData>) => setDraft({ ...d, ...p })
  const aiOn = settings.aiEnabled && can(profile, 'ai.interpret')
  // The server drafts from the SAVED findings, so unsaved edits must be saved first. The draft is only placed in the editor; nothing is saved.
  const draftImpression = async () => {
    if (dirty) return message.info('Save the draft first: the AI works from the saved findings')
    if (!d.findings.trim()) return message.error('Write and save the findings first')
    const run = async () => {
      setAiBusy(true)
      try {
        const r = await draftRadiologyImpression({ orderId, testId })
        const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const html = r.impression.split(/\n+/).filter((l) => l.trim()).map((l) => `<p>${esc(l.trim())}</p>`).join('')
        setDraft({ ...d, impression: html })
        message.success('AI draft inserted into Impression. Review and edit it, then save.')
      } catch (e) {
        message.error((e as Error).message || 'Could not draft the impression')
      } finally {
        setAiBusy(false)
      }
    }
    if (radHasText(d.impression)) modal.confirm({ title: 'Replace the current impression?', content: 'The AI draft will replace the text in Impression. It is not saved until you save.', okText: 'Replace', onOk: run })
    else await run()
  }
  const tokens = { patientName: order.patientName, age: ageText(order), gender: genderText(order.gender), date: dayjs().format('DD MMM YYYY') }
  const signers = settings.signatories.filter((s) => s.active)
  const signerId = d.signatoryId || settings.reportEntry.defaultSignatoryId
  const signer = signers.find((s) => s.id === signerId)
  const doctors = [
    ...signers.map((s) => ({ value: `sig:${s.id}`, label: s.name })),
    ...doctorUsers.filter((u) => u.active).map((u) => ({ value: `usr:${u.uid}`, label: u.name })),
  ]
  const imgBytes = d.images.reduce((s, i) => s + (i.size ?? (i.dataUrl ? dataUrlBytes(i.dataUrl) : 0)), 0)
  const useLH = letterhead ?? settings.reportDetails.useLetterhead

  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id)
    if (!t) return
    const run = () =>
      patch({
        templateId: t.id,
        modality: t.modality || d.modality,
        technique: fillTokensHtml(t.technique ?? '', tokens),
        findings: fillTokensHtml(t.findings ?? '', tokens),
        impression: fillTokensHtml(t.impression ?? '', tokens),
      })
    if (radHasText(d.findings) || radHasText(d.impression)) modal.confirm({ title: 'Replace the current text?', content: 'Applying a template overwrites technique, findings and impression.', okText: 'Replace', onOk: run })
    else run()
  }

  const insertMacro = (text: string) => {
    if (!active.current) return message.info('Click into Technique, Findings or Impression first')
    active.current.insertText(fillTokens(text, tokens))
  }
  const macroOptions = [
    ...MACROS.map((m) => ({ value: `b:${m.label}`, label: m.label, text: m.text })),
    ...myMacros.filter((m) => m.active !== false).map((m) => ({ value: `u:${m.id}`, label: `${m.label} (mine)`, text: m.text })),
    ...labMacros.filter((m) => m.active !== false).map((m) => ({ value: `l:${m.id}`, label: `${m.label} (lab)`, text: m.text })),
  ]

  const addImages = async (files: FileList | null) => {
    if (!files) return
    let imgs = [...d.images]
    for (const f of Array.from(files)) {
      if (imgs.length >= MAX_IMAGES) return message.warning(`At most ${MAX_IMAGES} images per report`)
      try {
        const dataUrl = await compressImage(f)
        const total = imgs.reduce((s, i) => s + (i.size ?? (i.dataUrl ? dataUrlBytes(i.dataUrl) : 0)), 0) + dataUrlBytes(dataUrl)
        if (total > MAX_TOTAL_BYTES) {
          message.warning(`${f.name} would exceed the combined size budget of ${Math.round(MAX_TOTAL_BYTES / 1024)} KB`)
          continue
        }
        imgs = [...imgs, { id: crypto.randomUUID(), name: f.name, dataUrl, caption: '', size: dataUrlBytes(dataUrl) }]
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Could not add the image')
      }
    }
    patch({ images: imgs })
  }

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) message.success(ok)
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }
  const base = () => (result ? {} : { id: test.id, orderId, testId: test.id, testName: test.name, values: {}, comment: '', enteredBy: '', approvedBy: '', approvedByName: '' })
  const statusOf = (over: Record<string, string>) => (tid: string) => over[tid] ?? results.find((r) => r.testId === tid)?.status
  const snapshot = (r: RadiologyData) => ({ ...r, images: undefined, imageCount: r.images.length })

  const persist = async (data: RadiologyData, status: ResultExt['status'], extra: Record<string, unknown> = {}): Promise<RadiologyData> => {
    // Key images go to Storage here; the report keeps only their paths.
    const images = await uploadKeyImages(orderId, test.id, data.images)
    const full: RadiologyData = { ...data, images, modality }
    await writeResult(orderId, test.id, {
      ...base(),
      radiology: full,
      status,
      enteredBy: result?.enteredBy || uid,
      approvedBy: '',
      approvedByName: '',
      updatedAt: serverTimestamp(),
      ...extra,
    })
    await addVersion(orderId, test.id, 'saved', {}, who, { radiology: snapshot(full) })
    await syncItems(order, statusOf({ [test.id]: status }))
    setDraft(null)
    return full
  }

  autosaveRef.current = () => {
    if (autosaving.current || busy || !draft) return
    autosaving.current = true
    persist(d, result?.status === 'hold' ? 'hold' : 'entered', { enteredBy: uid })
      .then(() => message.info('Draft autosaved', 1.5))
      .catch(() => undefined)
      .finally(() => { autosaving.current = false })
  }
  const save = () => run(async () => { await persist(d, result?.status === 'hold' ? 'hold' : 'entered', { enteredBy: uid }) }, 'Report saved')

  const approve = () => {
    const rdSet = settings.reportDetails
    // PCPNDT: an ultrasound on a PCPNDT bill is not signed off until Form F is complete.
    if (formFBlocked(order, settings) && isUltrasound(modality, radCfg.modalities)) return message.error('Form F is not complete for this PCPNDT bill. Complete it before signing off the ultrasound.')
    if (rdSet.radiologyRequireImpression) {
      if (!d.impression.trim()) return message.error('Write the impression before signing off')
    } else if (!d.findings.trim() && !d.impression.trim()) return message.error('Write the findings or impression first')
    if (!settings.allowSelfVerification && (dirty ? uid : result?.enteredBy) === uid) return message.error('Entered by you, needs another approver')
    const needImage = rdSet.radiologyRequireImage !== false && d.images.length === 0 && !d.dicomUrl.trim()
    if (needImage && !can(profile, 'results.amend')) return message.error('Attach an image or a viewer link before signing off')
    modal.confirm({
      title: 'Approve this radiology report?',
      content: needImage ? 'No image or viewer link is attached. Signing off without one is an override.' : undefined,
      okText: needImage ? 'Approve without image' : 'Approve',
      onOk: () =>
        run(async () => {
          const rad = dirty ? await persist(d, 'entered', { enteredBy: uid }) : d
          if (result?.verification) await writeResult(orderId, test.id, { verification: null })
          await approveEntries(order, [{ test, values: {}, comment: '', result: { ...(result as ResultExt), radiology: rad }, hadDraft: false }], statusOf({}), who, settings)
        }, 'Report approved'),
    })
  }
  const unapprove = () =>
    modal.confirm({
      title: 'Un-approve this report?',
      okText: 'Un-approve',
      okButtonProps: { danger: true },
      onOk: () =>
        run(async () => {
          await writeResult(orderId, test.id, { status: 'entered', approvedBy: '', approvedByName: '', radiology: { ...saved, amended: true }, updatedAt: serverTimestamp() })
          await addVersion(orderId, test.id, 'unapproved', {}, who, { radiology: snapshot(saved) })
          await syncItems(order, statusOf({ [test.id]: 'entered' }))
          await recomputeOrder(orderId, settings)
        }, 'Un-approved'),
    })

  const hold = (reason: string) =>
    run(async () => {
      await persist({ ...d, holdReason: reason }, 'hold')
      setHoldOpen(false)
    }, 'Report put on hold')
  const release = () => run(async () => { await persist({ ...d, holdReason: '' }, 'entered') }, 'Released')

  const requestOpinion = () => {
    const o = doctors.find((x) => x.value === soDoctor)
    if (!o) return message.error('Choose a doctor')
    if (soDoctor === `usr:${uid}` || soDoctor === `usr:${result?.enteredBy}`) return message.error('The second reader must be a different doctor from the report author')
    const so: SecondOpinion = { doctorId: soDoctor, doctorName: o.label, note: soNote.trim(), requestedBy: uid, requestedByName: who.name, requestedAt: Date.now(), status: 'requested', opinion: '' }
    run(async () => {
      await persist({ ...d, secondOpinion: so }, result?.status === 'hold' ? 'hold' : 'entered', { enteredBy: result?.enteredBy || uid })
      setSoOpen(false)
      setSoNote('')
    }, 'Second opinion requested')
  }
  const requestExternal = () => {
    const known = radCfg.externalReaders.find((r) => r.name === extName)
    const email = (extEmail || known?.email || '').trim()
    run(async () => {
      if (dirty) await persist(d, result?.status === 'hold' ? 'hold' : 'entered', { enteredBy: uid })
      await requestExternalOpinion({ orderId, testId: test.id, name: extName.trim(), email, note: soNote.trim() })
      setExtOpen(false)
      setSoNote('')
    }, 'Request sent by email')
  }
  const sendForVerification = () =>
    run(async () => {
      await persist(d, result?.status === 'hold' ? 'hold' : 'entered', { enteredBy: result?.enteredBy || uid, verification: { requestedBy: uid, requestedByName: who.name, at: Date.now() } })
    }, 'Sent for verification')
  const declineOpinion = () =>
    run(async () => {
      if (!saved.secondOpinion) return
      await writeResult(orderId, test.id, { radiology: { ...saved, secondOpinion: { ...saved.secondOpinion, status: 'declined', declineReason: opinion.trim(), givenAt: Date.now() } }, updatedAt: serverTimestamp() })
      setOpinion('')
    }, 'Request declined')
  const giveOpinion = () =>
    run(async () => {
      if (!saved.secondOpinion) return
      if (uid && uid === result?.enteredBy) {
        message.error('The author of the report cannot give the second opinion')
        return
      }
      await writeResult(orderId, test.id, { radiology: { ...saved, secondOpinion: { ...saved.secondOpinion, status: 'given', opinion: opinion.trim(), givenAt: Date.now(), cosigned: cosign, cosignedByName: cosign ? who.name : '' } }, updatedAt: serverTimestamp() })
      setOpinion('')
    }, 'Opinion recorded')

  const openDicom = () => {
    try {
      const v = validDicomUrl(d.dicomUrl)
      if (!v.ok || !v.url) throw new Error('bad')
      window.open(v.url, '_blank', 'noopener,noreferrer')
    } catch {
      message.error('Enter a valid https viewer link')
    }
  }

  // Previous / Next within the radiology worklist.
  let list: string[] = []
  try {
    list = JSON.parse(sessionStorage.getItem(RAD_IDS_KEY) ?? '[]')
  } catch {
    list = []
  }
  const idx = list.indexOf(`${orderId}|${testId}`)
  const go = (key: string | undefined) => {
    if (!key) return
    const [o, t] = key.split('|')
    const jump = () => navigate(`/radiology/${o}?test=${t}`)
    if (dirty) modal.confirm({ title: 'Discard unsaved changes?', okText: 'Discard and move', onOk: jump })
    else jump()
  }

  const statusChip = locked && saved.amended ? <StatusChip variant="info">Approved (Amended)</StatusChip> : locked ? <StatusChip variant="success">Approved</StatusChip> : result?.status === 'hold' ? <StatusChip variant="caution">On hold</StatusChip> : <StatusChip variant="neutral">{result ? 'Draft' : 'Pending'}</StatusChip>
  const ta = (field: Field, label: string, minHeight: number) => (
    <RichText id={`rd-${field}`} label={label} minHeight={minHeight} disabled={locked || !canEnter} value={d[field]} onChange={(v) => patch({ [field]: v } as Partial<RadiologyData>)} onActive={(h) => (active.current = h)} />
  )
  const dv = validDicomUrl(d.dicomUrl)
  const viewerFromUid = buildViewerUrl(radCfg.viewerBaseUrl, d.dicomStudyUid ?? '')
  const blockedByFormF = formFBlocked(order, settings) && isUltrasound(modality, radCfg.modalities)
  const dicomBad = !!d.dicomUrl.trim() && !dv.ok

  return (
    <div>
      <PageHeader
        title={order.patientName}
        subtitle={`${ageText(order)} / ${genderText(order.gender)} / ${order.patientNo}`}
        actions={
          <div className="rd-actions">
            <Button variant="text" onClick={() => navigate('/radiology')}>Back to list</Button>
            <Button icon={<LeftOutlined />} aria-label="Previous study" disabled={idx <= 0} onClick={() => go(list[idx - 1])} />
            <Button icon={<RightOutlined />} aria-label="Next study" disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1])} />
            <Button icon={<HistoryOutlined />} onClick={() => setHistOpen(true)}>History</Button>
            {locked && can(profile, 'reports.send') && <Button icon={<SendOutlined />} onClick={() => setSendOpen(true)}>Send</Button>}
            <FormFAction order={order} />
            <Button icon={<PrinterOutlined />} disabled={blockedByFormF} onClick={() => window.print()}>Print</Button>
            <Button variant="primary" icon={<SaveOutlined />} disabled={!canEnter || locked || !dirty || busy} onClick={save}>Save draft</Button>
          </div>
        }
      />
      <Card padding="var(--s-4)">
        <div className="rd-actions">
          {statusChip}
          <span>Bill <b>{order.billNo}</b></span>
          <span>Accession / barcode <b>{order.barcode}</b></span>
          <span>Referred by <b>{order.referrerName || 'Self'}</b></span>
          <span className="rd-muted">{fmtDateTime(order.createdAt)}</span>
          <StatusChip variant="info">{modality}</StatusChip>
          {saved.amended && <StatusChip variant="info">Amended</StatusChip>}
          {dirty && <StatusChip variant="caution">Unsaved</StatusChip>}
        </div>
        {radTests.length > 1 && (
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Segmented aria-label="Study" value={testId} onChange={(v) => setSp({ test: v })} options={radTests.map((t) => ({ value: t.id, label: t.name }))} />
          </div>
        )}
      </Card>

      <div className="rd-grid" style={{ marginTop: 'var(--s-4)' }}>
        <Card as="section" aria-label="Report editor">
          <h2 style={{ marginTop: 0, fontSize: 'var(--fs-title)' }}>{test.name}</h2>
          {result?.status === 'hold' && saved.holdReason && <div className="re-notice re-notice--warn" role="status">On hold: {saved.holdReason}</div>}
          <FormSection title="Start from" description="Apply a saved template, insert macros, or dictate into the report.">
          <div className="rd-field">
            <label htmlFor="rd-tpl">Template</label>
            <Select id="rd-tpl" allowClear showSearch optionFilterProp="label" disabled={locked || !canEnter} placeholder={templates.length ? 'Apply a template' : 'No templates yet'} value={d.templateId || undefined} onChange={(v) => v && applyTemplate(v)}
              options={templates.filter((t) => t.active !== false && (!t.modality || t.modality === modality) && (variantSel === 'all' || (t.variant ?? 'normal') === variantSel)).map((t) => ({ value: t.id, label: `${t.name}${t.modality ? ` (${t.modality})` : ''} - ${t.variant === 'abnormal' ? 'abnormal' : 'normal'}` }))} />
            <div className="rd-actions"><span className="rd-muted">Show</span>
              <Segmented aria-label="Template variant" value={variantSel} onChange={setVariantSel} options={[{ value: 'all', label: 'All' }, { value: 'normal', label: 'Normal' }, { value: 'abnormal', label: 'Abnormal' }]} /></div>
          </div>
          <div className="rd-actions" style={{ marginBottom: 'var(--s-3)' }}>
            <Select aria-label="Insert macro" style={{ minWidth: 200 }} disabled={locked || !canEnter} placeholder="Insert macro at cursor" value={null as unknown as string} showSearch optionFilterProp="label"
              onChange={(v: string) => { const m = macroOptions.find((x) => x.value === v); if (m) insertMacro(m.text) }}
              options={macroOptions.map((m) => ({ value: m.value, label: m.label }))} />
            <Button onClick={() => setMacrosOpen(true)}>Manage macros</Button>
            {dictation.supported ? (
              <>
                <Button icon={<AudioOutlined />} disabled={locked || !canEnter} onClick={dictation.listening ? dictation.stop : dictation.start} aria-pressed={dictation.listening}>{dictation.listening ? 'Stop dictation' : 'Dictate'}</Button>
                <Select aria-label="Dictation language" style={{ minWidth: 150 }} value={dictLang} onChange={setDictLang} options={DICTATION_LANGS} disabled={dictation.listening} />
              </>
            ) : (
              <span className="rd-muted" role="status">Dictation is not supported in this browser. Use Chrome, Edge or Safari.</span>
            )}
            {aiOn && <Button disabled={locked || !canEnter || aiBusy} onClick={draftImpression}>{aiBusy ? 'Drafting...' : 'Draft impression with AI'}</Button>}
          </div>
          </FormSection>
          <FormSection title="Study details">
            <FieldGrid min={240}>
              <div className="rd-field"><label htmlFor="rd-body">Body part</label><Input id="rd-body" disabled={locked || !canEnter} value={d.bodyPart ?? ''} onChange={(e) => patch({ bodyPart: e.target.value })} /></div>
              <div className="rd-field"><label htmlFor="rd-contrast">Contrast / allergy note</label><Input id="rd-contrast" disabled={locked || !canEnter} placeholder="e.g. IV contrast given; no known allergy" value={d.contrastNote ?? ''} onChange={(e) => patch({ contrastNote: e.target.value })} /></div>
            </FieldGrid>
          </FormSection>
          <FormSection title="Report">
          {ta('technique', 'Technique', 50)}
          {ta('findings', 'Findings', 220)}
          {ta('impression', 'Impression', 90)}
          </FormSection>

          <FormSection title="Viewer and images">
          <div className="rd-field">
            <label htmlFor="rd-dicom">DICOM viewer link</label>
            <div className="rd-actions">
              <Input id="rd-dicom" style={{ flex: 1, minWidth: 220 }} status={dicomBad ? 'error' : undefined} placeholder="https://viewer.example.com/study/..." disabled={locked || !canEnter} value={d.dicomUrl} onChange={(e) => patch({ dicomUrl: e.target.value })} />
              <Button icon={<LinkOutlined />} disabled={!dv.ok} onClick={openDicom}>Open viewer</Button>
              {!d.dicomUrl.trim() && viewerFromUid && !locked && canEnter && <Button onClick={() => patch({ dicomUrl: viewerFromUid })}>Use the lab viewer link for this study UID</Button>}
            </div>
            <Input aria-label="Study UID" placeholder="Study UID (optional)" disabled={locked || !canEnter} value={d.dicomStudyUid ?? ''} onChange={(e) => patch({ dicomStudyUid: e.target.value })} />
            <span className="rd-muted">{dicomBad ? 'Only https links are accepted. ' : ''}{dv.warn ?? 'Do not put access tokens or passwords in the link query; use a viewer that signs users in itself.'}</span>
          </div>

          <div className="rd-field">
            <label htmlFor="rd-img">Images ({d.images.length} of {MAX_IMAGES}; {Math.round(imgBytes / 1024)} of {Math.round(MAX_TOTAL_BYTES / 1024)} KB used, {Math.max(0, Math.round((MAX_TOTAL_BYTES - imgBytes) / 1024))} KB left)</label>
            <input id="rd-img" type="file" accept="image/*" multiple disabled={locked || !canEnter || d.images.length >= MAX_IMAGES} onChange={(e) => { addImages(e.target.files); e.target.value = '' }} />
            <span className="rd-muted">Limits: up to {MAX_IMAGES} images, {Math.round(MAX_IMAGE_BYTES / 1024)} KB each after resizing, {Math.round(MAX_TOTAL_BYTES / 1024)} KB in total. Images are stored in secure file storage and open with the report.</span>
            {d.images.length > 0 && (
              <div className="rd-thumbs">
                {d.images.map((im) => (
                  <div className="rd-thumb" key={im.id}>
                    <RadImg im={im} />
                    <Input className="rd-cap" size="small" aria-label={`Caption for ${im.name}`} placeholder="Caption" disabled={locked || !canEnter} value={im.caption ?? ''} onChange={(e) => patch({ images: d.images.map((x) => (x.id === im.id ? { ...x, caption: e.target.value } : x)) })} />
                    {!locked && <Button icon={<UndoOutlined />} aria-label={`Remove ${im.name}`} onClick={() => patch({ images: d.images.filter((x) => x.id !== im.id) })} />}
                  </div>
                ))}
              </div>
            )}
          </div>
          </FormSection>
        </Card>

        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Card as="section" aria-label="Sign off">
            <div className="rd-field">
              <label htmlFor="rd-sig">Reporting doctor (signature)</label>
              <Select id="rd-sig" allowClear disabled={locked || !canEnter} value={signerId || undefined} onChange={(v) => patch({ signatoryId: v ?? '' })} options={signers.map((s) => ({ value: s.id, label: `${s.name}${s.qualification ? `, ${s.qualification}` : ''}` }))} />
            </div>
            <div className="rd-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              {canApprove && !locked && <Button variant="primary" icon={<CheckOutlined />} disabled={busy} onClick={approve}>Approve</Button>}
              {canUnapprove && locked && <Button icon={<UndoOutlined />} onClick={unapprove}>Un-approve</Button>}
              {canEnter && !locked && (result?.status === 'hold' ? <Button icon={<PauseCircleOutlined />} onClick={release}>Release hold</Button> : <Button icon={<PauseCircleOutlined />} onClick={() => setHoldOpen(true)}>Put on hold</Button>)}
              {canEnter && !locked && <Button icon={<TeamOutlined />} onClick={() => setSoOpen(true)}>Request second opinion</Button>}
              {canEnter && !locked && <Button icon={<TeamOutlined />} onClick={() => setExtOpen(true)}>Ask an outside consultant</Button>}
              {canEnter && !locked && !result?.verification && <Button icon={<CheckOutlined />} disabled={busy || !d.findings.trim()} onClick={sendForVerification}>Send for verification</Button>}
              {result?.verification && !locked && <div className="rd-muted">Awaiting verification (sent by {result.verification.requestedByName}).</div>}
            </div>
            <div className="rd-field" style={{ marginTop: 'var(--s-3)' }}>
              <span id="rd-lh">Print on letterhead</span>
              <Switch aria-labelledby="rd-lh" checked={useLH} onChange={setLetterhead} />
            </div>
          </Card>
          {saved.secondOpinion && (
            <Card as="section" aria-label="Second opinion">
              <div className="rd-actions"><b>Second opinion</b><StatusChip variant={saved.secondOpinion.status === 'given' ? 'success' : saved.secondOpinion.status === 'declined' ? 'neutral' : 'info'}>{saved.secondOpinion.status === 'given' ? 'Given' : saved.secondOpinion.status === 'declined' ? 'Declined' : 'Requested'}</StatusChip></div>
              <p>Requested from <b>{saved.secondOpinion.doctorName}</b> by {saved.secondOpinion.requestedByName}.</p>
              {saved.secondOpinion.note && <p className="rd-muted">{saved.secondOpinion.note}</p>}
              {saved.secondOpinion.status === 'given' ? (
                <p><b>Opinion:</b> {saved.secondOpinion.opinion}</p>
              ) : saved.secondOpinion.status === 'declined' ? (
                <p><b>Declined:</b> {saved.secondOpinion.declineReason || 'No reason given'}</p>
              ) : (
                canEnter && (
                  <>
                    <Input.TextArea aria-label="Second opinion" rows={4} value={opinion} onChange={(e) => setOpinion(e.target.value)} />
                    <Checkbox checked={cosign} onChange={(e) => setCosign(e.target.checked)}>Co-sign this report (both names print)</Checkbox>
                    <div style={{ marginTop: 'var(--s-2)' }}><Button disabled={!opinion.trim() || busy} onClick={giveOpinion}>Record opinion</Button>{' '}<Button disabled={busy} onClick={declineOpinion}>Decline (reason in box)</Button></div>
                  </>
                )
              )}
            </Card>
          )}
          <Card as="section" aria-label="Images" id="rd-images-card">
            <div className="rd-muted"><PictureOutlined /> DICOM studies open in your own viewer. Attached images print with the report.</div>
          </Card>
        </div>
      </div>

      <MacrosModal open={macrosOpen} onClose={() => setMacrosOpen(false)} canEdit={can(profile, 'catalogue.edit')} />
      <ReasonModal open={holdOpen} title="Put report on hold" kind="hold" required okText="Hold" onCancel={() => setHoldOpen(false)} onOk={hold} />
      <HistoryModal open={histOpen} onClose={() => setHistOpen(false)} orderId={orderId} testId={testId} current={{ technique: d.technique, findings: d.findings, impression: d.impression }} />
      {sendOpen && <SendReportModal order={order} open onClose={() => setSendOpen(false)} tests={[{ id: test.id, name: test.name }]} defaultTestIds={[test.id]} />}
      <Modal open={extOpen} title="Ask an outside consultant" okText="Send by email" onOk={requestExternal} onCancel={() => setExtOpen(false)} destroyOnHidden>
        <p className="rd-muted">The consultant gets a private link (valid 7 days) showing this study with initials, age and sex only. They can reply and co-sign.</p>
        <FieldGrid min={220}>
        <div className="rd-field"><label htmlFor="ex-name">Consultant name</label><Input id="ex-name" value={extName} onChange={(e) => setExtName(e.target.value)} list="ex-readers" /></div>
        <datalist id="ex-readers">{radCfg.externalReaders.filter((r) => r.active !== false).map((r) => <option key={r.id} value={r.name} />)}</datalist>
        <div className="rd-field"><label htmlFor="ex-mail">Email</label><Input id="ex-mail" type="email" value={extEmail} onChange={(e) => setExtEmail(e.target.value)} /></div>
        </FieldGrid>
        <div className="rd-field"><label htmlFor="ex-note">Note</label><Input.TextArea id="ex-note" rows={3} value={soNote} onChange={(e) => setSoNote(e.target.value)} /></div>
      </Modal>
      <Modal open={soOpen} title="Request second opinion" okText="Send request" onOk={requestOpinion} onCancel={() => setSoOpen(false)} destroyOnHidden>
        <div className="rd-field"><label htmlFor="so-doc">Doctor</label><Select id="so-doc" showSearch optionFilterProp="label" value={soDoctor || undefined} onChange={setSoDoctor} options={doctors} placeholder={doctors.length ? 'Choose a doctor' : 'Add doctors in Settings first'} /></div>
        <div className="rd-field"><label htmlFor="so-note">Note</label><Input.TextArea id="so-note" rows={3} value={soNote} onChange={(e) => setSoNote(e.target.value)} /></div>
      </Modal>

      <div className="rr-print" aria-hidden="true">
        <div style={{ padding: `${settings.reportDetails.marginTop}mm ${settings.reportDetails.marginRight}mm ${settings.reportDetails.marginBottom}mm ${settings.reportDetails.marginLeft}mm` }}>
          <div className="hdr" style={{ visibility: useLH ? 'hidden' : 'visible', minHeight: 70 }}>
            {settings.reportDetails.headerImage ? <img src={settings.reportDetails.headerImage} alt="" style={{ maxWidth: '100%', maxHeight: 90 }} /> : (
              <>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#0369A1' }}>{settings.name}</div>
                <div>{settings.address}</div>
                <div>{labContactLine(settings)}</div>
              </>
            )}
          </div>
          <div className="pat">
            <div><b>Name:</b> {order.patientName}</div><div><b>Patient ID:</b> {order.patientNo}</div>
            <div><b>Age / Gender:</b> {ageText(order)} / {genderText(order.gender)}</div><div><b>Bill no:</b> {order.billNo}</div>
            <div><b>Referred by:</b> {order.referrerName || 'Self'}</div><div><b>Study date:</b> {fmtDateTime(order.createdAt)}</div>
            <div><b>Accession / barcode:</b> {order.barcode}{radCfg.accessionBarcode && order.barcode && <span dangerouslySetInnerHTML={{ __html: code128Svg(order.barcode) }} />}</div>{d.bodyPart ? <div><b>Body part:</b> {d.bodyPart}</div> : <div />}
            {d.contrastNote && <div style={{ gridColumn: '1 / -1' }}><b>Contrast / allergy:</b> {d.contrastNote}</div>}
          </div>
          <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 15 }}>{modality}: {test.name}</div>
          {radHasText(d.technique) && (<><h2>Technique</h2><div className="rt" dangerouslySetInnerHTML={{ __html: radHtml(d.technique) }} /></>)}
          {radHasText(d.findings) && (<><h2>Findings</h2><div className="rt" dangerouslySetInnerHTML={{ __html: radHtml(d.findings) }} /></>)}
          {radHasText(d.impression) && (<><h2>Impression</h2><div className="rt" dangerouslySetInnerHTML={{ __html: radHtml(d.impression) }} /></>)}
          {saved.secondOpinion?.status === 'given' && (<><h2>Second opinion ({saved.secondOpinion.doctorName}{saved.secondOpinion.cosigned ? ', co-signed' : ''})</h2><p>{saved.secondOpinion.opinion}</p></>)}
          {showInterpretation(test) && (<><h2>Interpretation</h2><p>{test.interpretation}</p></>)}
          {testComment(test) && <p>{testComment(test)}</p>}
          {d.images.length > 0 && <div className="imgs">{d.images.map((im) => <figure key={im.id}><RadImg im={im} />{im.caption && <figcaption>{im.caption}</figcaption>}</figure>)}</div>}
          {d.dicomUrl && <p style={{ marginTop: 8, fontSize: 10 }}>DICOM study: {d.dicomUrl}{d.dicomStudyUid ? ` (UID ${d.dicomStudyUid})` : ''}</p>}
          <div className="sig">
            {signer?.signatureDataUrl && <img src={signer.signatureDataUrl} alt="" />}
            {signer ? <div>{!signer.hideNameInReport && <b>{signer.name}</b>}<div>{signer.qualification}</div>{signer.registrationNo && <div>Reg. no. {signer.registrationNo}</div>}</div> : result?.approvedByName ? <div>Approved by {result.approvedByName}</div> : null}
          </div>
          <div className="ftr" style={{ visibility: useLH ? 'hidden' : 'visible' }}>{settings.reportDetails.footerText || settings.name}</div>
        </div>
      </div>
    </div>
  )
}
