import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Alert, App, DatePicker, Drawer, Input, Select, Switch } from 'antd'
import { CheckOutlined, DiffOutlined, DownloadOutlined, FilePdfOutlined, PrinterOutlined, SendOutlined, SettingOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { increment, serverTimestamp, updateDoc } from 'firebase/firestore'
import { useAuth, can } from '../../auth/AuthProvider'
import SendReportModal from '../../components/messaging/SendReportModal'
import { docRef, paths, resultsCol } from '../../lib/db'
import { createReportShare } from '../../lib/messaging'
import { REPORT_LANGS } from '../../features/report/i18n'
import { downloadHtml, downloadSnapshotPdf, ensureSnapshot, loadSnapshotPayload, snapshotsCol, type ReportSnapshot } from '../../features/report/snapshots'
import { limit, orderBy, query } from 'firebase/firestore'
import { getDoc } from 'firebase/firestore'
import { useMarkDispatched } from '../../features/report/hardCopy'
import { clientFields } from '../../features/report/fields'
import { useReportLayout } from '../../features/report/layout'
import { payloadToModel, type ReportPayload } from '../../features/report/payload'
import { ensureBillPin } from '../../features/report/api'
import { effectiveSettings } from '../../features/settings/lib'
import { templateFor } from '../catalogue/behaviour'
import { interpretationHtml } from '../catalogue/richText'
import { col } from '../../lib/db'
import FormFAction from '../../features/pcpndt/FormFAction'
import { formFBlocked } from '../../features/pcpndt/lib'
import type { Patient } from '../../types'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { Button } from '../../design/Button'
import { FormSection, SettingRow } from '../../design/FormLayout'
import { Glass } from '../../design/Glass'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonCard } from '../../design/Skeletons'
import type { Department, PageSize, Test } from '../../types'
import { liveItems, tsToDate, fmtDateTime } from '../../components/results/common'
import { ageDaysAtCollection } from '../../lib/results'
import type { OrderExt, ResultExt } from '../../components/results/types'
import { usePreviousResults } from '../../components/results/usePrevious'
import SmartReportView from '../../features/smart-report/SmartReportView'
import ReportSheet from '../../features/report/ReportSheet'
import { qrDataUrl } from '../../features/report/qr'
import { removeReportFile, reportFileDoc, uploadReportFile, useReportFileData, type ReportFileDoc } from '../../features/report/files'
import { DISPATCH_STATUS_LABEL, deriveDispatchStatus } from '../../features/report/dispatch'
import type { PrevMap, ReportModel, ReportOpts, RResult } from '../../features/report/model'
import type { TestExt } from '../catalogue/ext'
import './report.css'
import '../../components/results/results.css'

const MODE_LABEL: Record<string, string> = { email: 'Email', hardcopy: 'Hard copy', sms: 'SMS', whatsapp: 'WhatsApp', manualWhatsapp: 'WhatsApp (manual)' }

export default function ReportPage() {
  const { orderId = '' } = useParams()
  const [sp, setSp] = useSearchParams()
  const { message, modal } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const maps = useCatalogueMaps()
  const { data: order, loading } = useLiveDoc<OrderExt>(orderId ? docRef(paths.orders, orderId) : null, [orderId])
  const eff = useMemo(() => effectiveSettings(settings, order?.branchId), [settings, order?.branchId])
  const rd = eff.reportDetails
  const { data: results } = useLiveQuery<ResultExt>(orderId ? resultsCol(orderId) : null, [orderId])
  const { data: reportFileRaw } = useLiveDoc<ReportFileDoc>(orderId && order?.hasReportFile ? reportFileDoc(orderId) : null, [orderId, order?.hasReportFile])
  const reportFile = useReportFileData(reportFileRaw)
  const layout = useReportLayout()
  const { data: templateDocs } = useLiveQuery<{ id: string; layout?: Record<string, unknown> }>(col('reportTemplates'), [])
  const templateLayouts = useMemo(() => Object.fromEntries(templateDocs.filter((t) => t.layout && typeof t.layout === 'object').map((t) => [t.id, t.layout])) as ReportModel['templateLayouts'], [templateDocs])
  const markDispatchedPrompt = useMarkDispatched()
  const [patient, setPatient] = useState<Patient | null>(null)
  const [b2bCode, setB2bCode] = useState('')
  const [issued, setIssued] = useState<ReportPayload | null>(null)
  const [useLive, setUseLive] = useState(false)
  const [freshLayout, setFreshLayout] = useState(false)
  const [lhId, setLhId] = useState<string | null>(null)
  const [pin, setPin] = useState('')

  const [sendOpen, setSendOpen] = useState(false)
  const [optOpen, setOptOpen] = useState(false)
  const [letterhead, setLetterhead] = useState<boolean | null>(null)
  const [header, setHeader] = useState<boolean | null>(null)
  const [footer, setFooter] = useState<boolean | null>(null)
  const [perDept, setPerDept] = useState<boolean | null>(null)
  const [perTest, setPerTest] = useState(false)
  const [compare, setCompare] = useState(false)
  const [abnSummary, setAbnSummary] = useState(false)
  const [showQr, setShowQr] = useState<boolean | null>(null)
  const [showBarcode, setShowBarcode] = useState<boolean | null>(null)
  const [pageSize, setPageSize] = useState<PageSize | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [interp, setInterp] = useState<'test' | 'show' | 'hide'>('test')
  const [lang, setLang] = useState('en')
  const [snapBusy, setSnapBusy] = useState(false)
  const [attachNote, setAttachNote] = useState<string | null>(null)
  const [qrToken, setQrToken] = useState('')
  const printedOnce = useRef(false)

  // The patient record fills phone, address and the other patient-block fields.
  useEffect(() => {
    if (!order?.patientId) return
    let dead = false
    getDoc(docRef<Patient>(paths.patients, order.patientId)).then((p) => !dead && setPatient(p.exists() ? ({ ...p.data(), id: p.id } as Patient) : null)).catch(() => undefined)
    if (order.b2bCentreId)
      getDoc(docRef<{ code?: string }>('b2bCentres', order.b2bCentreId)).then((c) => !dead && setB2bCode(String(c.data()?.code ?? ''))).catch(() => undefined)
    return () => {
      dead = true
    }
  }, [order?.patientId, order?.b2bCentreId])

  const { data: snaps } = useLiveQuery<ReportSnapshot>(orderId ? query(snapshotsCol(orderId), orderBy('createdAt', 'desc'), limit(5)) : null, [orderId])
  const smart = sp.get('smart') === '1'
  // Issued (provisional / final) reports render from the version frozen when they were released (X-04).
  const latestSnap = snaps[0]
  const issuedKey = order && (order.reportStatus === 'final' || order.reportStatus === 'provisional') && latestSnap?.modelPath && latestSnap.revision === (order.reportRevision ?? 0) && latestSnap.status === order.reportStatus ? latestSnap.id : ''
  useEffect(() => {
    let dead = false
    setIssued(null)
    if (!issuedKey || !latestSnap) return
    loadSnapshotPayload(latestSnap).then((p) => !dead && setIssued(p)).catch(() => !dead && setIssued(null))
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuedKey])
  const history = usePreviousResults(order, 3, (compare || layout.trendGraph) && !!order)

  // QR code points at the secure status page of this bill (token created server-side on demand).
  const canQr = can(profile, 'reports.print') || can(profile, 'reports.send')
  useEffect(() => {
    if (!orderId || !canQr) return
    let dead = false
    createReportShare(orderId).then((t) => !dead && setQrToken(t)).catch(() => undefined)
    return () => {
      dead = true
    }
  }, [orderId, canQr])

  const resultById = useMemo(() => new Map(results.map((r) => [r.testId, r])), [results])

  const groups = useMemo(() => {
    if (!order) return []
    const seen = new Set<string>()
    const byDept = new Map<string, Test[]>()
    liveItems(order).forEach((i) =>
      i.testIds.forEach((tid) => {
        const t = maps.testById.get(tid)
        if (!t || seen.has(tid)) return
        const r = resultById.get(tid)
        if (i.status === 'rejected' && r?.status !== 'rejected') return
        seen.add(tid)
        byDept.set(t.departmentId, [...(byDept.get(t.departmentId) ?? []), t])
      }),
    )
    const depts: Department[] = [...byDept.keys()].map((id) => maps.departmentById.get(id) ?? { id, name: 'Other', order: 999 })
    depts.sort((a, b) => a.order - b.order)
    return depts.map((d) => ({ dept: d, tests: (byDept.get(d.id) ?? []).sort((a, b) => a.order - b.order) }))
  }, [order, maps.testById, maps.departmentById, resultById])
  const allTests = groups.flatMap((g) => g.tests)

  const attach = attachNote ?? order?.reportAttachmentNote ?? ''
  const publicBase = (settings.publicAppUrl || window.location.origin).replace(/\/+$/, '')

  const model: ReportModel | null = useMemo(() => {
    if (!order) return null
    const sampleName = (id: string) => maps.sampleTypeById.get(id)?.name ?? ''
    const override = tsToDate(order.reportDateOverride)
    return {
      lab: {
        name: eff.name, address: eff.address, phone: eff.phone, email: eff.email,
        website: eff.profile.website, city: eff.profile.city, logoDataUrl: eff.profile.logoDataUrl, dateFormat: eff.profile.dateFormat,
      },
      rd,
      layout,
      templateLayouts,
      idDisplay: settings.registration.idDisplay,
      order: {
        billNo: order.billNo, patientName: order.patientName, patientNo: order.patientNo, uhid: order.uhid ?? patient?.uhid ?? '', phone: patient?.phone ?? '', address: patient?.address ?? '',
        gender: order.gender, ageValue: order.ageValue, ageUnit: order.ageUnit, referrerName: order.referrerName, barcode: order.barcode,
        createdAt: tsToDate(order.createdAt), collectedAt: tsToDate(order.collectedAt), receivedAt: tsToDate(order.receivedAt),
        reportedAt: override ?? tsToDate(order.firstApprovedAt) ?? tsToDate(order.reportedAt) ?? new Date(),
        reportStatus: order.reportStatus, reportSignatoryId: order.reportSignatoryId ?? '', reportNote: order.reportNote ?? '',
        reportRevision: order.reportRevision ?? 0, amendSummary: order.amendSummary ?? '',
        billDate: tsToDate(order.billDate),
        ageDays: ageDaysAtCollection(order, patient?.dob),
        condition: order.patientCondition,
        fields: clientFields(order as never, patient as never, { b2bCode }),
        pending: allTests.filter((t) => resultById.get(t.id)?.status !== 'approved').map((t) => t.name),
        packages: order.items.filter((i) => i.kind === 'package' && i.status !== 'refunded').map((i) => i.name),
        disableLetterhead: order.disableLetterhead === true,
      },
      signatories: settings.signatories.filter((s) => s.active),
      defaultSignatoryId: settings.reportEntry.defaultSignatoryId,
      depts: groups.map((g) => ({ id: g.dept.id, name: g.dept.name, order: g.dept.order })),
      tests: allTests.map((t) => ({
        id: t.id, name: t.name, translations: t.translations, departmentId: t.departmentId, order: t.order, interpretation: t.interpretation, parameters: t.parameters,
        startOnNewPage: t.startOnNewPage, startNextPage: (t as TestExt).startNextPage, interpretationEnabled: (t as TestExt).interpretationEnabled, comments: (t as TestExt).comments, sampleTypeName: sampleName(t.sampleTypeId),
        templateId: templateFor(t as TestExt, maps.departmentById), interpretationHtml: interpretationHtml(t as TestExt),
      })),
      results: results as unknown as RResult[],
      qrUrl: qrToken ? qrDataUrl(`${publicBase}/r/${qrToken}`) : '',
      reportFile: reportFile ?? null,
      attachNote: attach,
    }
  }, [order, settings, eff, rd, layout, templateLayouts, groups, allTests, results, qrToken, publicBase, reportFile, attach, maps, patient, b2bCode, resultById])

  // What is shown: the frozen issued version when there is one (unless the viewer asks for live data), else the live data.
  const frozen = issued && !useLive && model ? payloadToModel(issued, model.qrUrl) : null
  const shown: ReportModel | null = frozen && model
    ? {
        ...frozen,
        ...(freshLayout ? { rd, layout } : {}),
        order: { ...frozen.order, reportedAt: model.order.reportedAt, reportNote: model.order.reportNote },
        reportFile: model.reportFile,
        attachNote: model.attachNote,
      }
    : model
  // A corporate client flagged "disable letterhead": no letterhead, header or footer on its reports.
  const noLH = order?.disableLetterhead === true
  const useLH = noLH ? false : letterhead ?? rd.useLetterhead
  const opts: ReportOpts = {
    letterhead: useLH,
    letterheadId: noLH ? undefined : lhId ?? undefined,
    header: noLH ? false : header ?? rd.showHeader,
    footer: noLH ? false : footer ?? rd.showFooter,
    perDept: perDept ?? rd.pageBreakPerDepartment,
    perTest,
    compare,
    abnSummary,
    qr: showQr ?? rd.showQr,
    barcode: showBarcode ?? rd.showBarcode,
    pageSize: pageSize ?? rd.pageSize,
    picked,
    interpretation: interp === 'test' ? null : interp === 'show',
    duplicate: !!rd.duplicateWatermark && (order?.reportPrintCount ?? 0) >= 1,
    lang,
  }

  const prevs: PrevMap = useMemo(() => {
    const out: PrevMap = {}
    for (const [k, v] of Object.entries(history)) out[k] = v.map((x) => ({ date: tsToDate(x.date), values: x.values }))
    return out
  }, [history])

  // PCPNDT: printing or sending a report that contains a PCPNDT test waits for Form F.
  const pcTests = (order?.items ?? []).filter((i) => i.pcpndt && i.status !== 'refunded').flatMap((i) => i.testIds)
  const formBlocked = formFBlocked(order, settings) && (picked.length === 0 || picked.some((t) => pcTests.includes(t)))
  const blockedPartial = (!!rd.reportBlockPartial && order?.reportStatus === 'partial') || formBlocked

  const recordPrint = async () => {
    if (!order || !profile) return
    try {
      await updateDoc(docRef(paths.orders, order.id), {
        printed: true, printedAt: serverTimestamp(), printedBy: profile.uid, reportPrintCount: increment(1),
      })
    } catch {
      /* the print itself must not fail because the counter could not be written */
    }
  }
  const doPrint = async () => {
    await recordPrint()
    window.print()
  }
  const download = () =>
    modal.info({
      title: 'Download as PDF',
      content: 'In the print dialog choose "Save as PDF" as the destination.',
      okText: 'Open print dialog',
      onOk: doPrint,
    })
  const markPrintedOnly = async () => {
    await recordPrint()
    message.success('Marked as printed')
  }

  // ?print=1 opens the print dialog once the report has loaded.
  useEffect(() => {
    if (sp.get('print') === '1' && order && !printedOnce.current && maps.tests.length && !blockedPartial) {
      printedOnce.current = true
      setTimeout(() => void doPrint(), 400)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, order, maps.tests.length])

  useEffect(() => {
    if (!order) return
    const handler = () => {
      const pending = order.dispatch.filter((d) => d.mode === 'hardcopy' && !d.delivered)
      if (pending.length)
        modal.confirm({
          title: 'Mark hard copy as delivered?',
          content: 'The report was printed. Record the hard copy as handed over.',
          okText: 'Mark delivered',
          onOk: () => markDispatchedPrompt(order, 'hardcopy').then(() => undefined),
        })
    }
    window.addEventListener('afterprint', handler)
    return () => window.removeEventListener('afterprint', handler)
  }, [order, modal, markDispatchedPrompt])

  if (loading)
    return (
      <div style={{ padding: 'var(--s-5)' }}>
        <SkeletonCard lines={6} />
      </div>
    )
  if (!order || !model) return <EmptyState title="Order not found" description="The bill may have been voided or the link is wrong." />

  if (smart)
    return <SmartReportView order={order} results={results} onBack={() => setSp((p) => { p.delete('smart'); return p })} />

  const deliver = async (mode: OrderExt['dispatch'][number]['mode']) => {
    if (await markDispatchedPrompt(order, mode)) message.success('Marked delivered')
  }
  // Issued reports download the stored PDF file; drafts and interim reports use the browser's print dialog.
  const downloadPdf = async () => {
    const sn = snaps[0]
    if (frozen && sn?.pdfPath) {
      try {
        await downloadSnapshotPdf(order.billNo, sn)
        await recordPrint()
        return
      } catch (e) {
        message.error((e as Error).message)
      }
    }
    download()
  }
  const dstatus = deriveDispatchStatus(order)
  const Toggle = ({ label, help, value, onChange }: { label: string; help?: string; value: boolean; onChange: (v: boolean) => void }) => (
    <SettingRow label={<span id={`t-${label}`}>{label}</span>} help={help}><Switch aria-labelledby={`t-${label}`} checked={value} onChange={onChange} /></SettingRow>
  )
  const reportDate = tsToDate(order.reportDateOverride) ?? tsToDate(order.firstApprovedAt) ?? tsToDate(order.reportedAt)

  return (
    <div style={{ padding: 'var(--s-4) var(--s-3)' }}>
      <Glass className="rp-bar no-print" radius="var(--r-panel)">
        <Button variant="primary" icon={<PrinterOutlined />} disabled={!can(profile, 'reports.print') || blockedPartial} onClick={() => void doPrint()}>Print</Button>
        <Button icon={<DownloadOutlined />} disabled={!can(profile, 'reports.print') || blockedPartial} onClick={() => void downloadPdf()}>Download PDF</Button>
        <Button icon={<CheckOutlined />} disabled={!can(profile, 'reports.print')} onClick={() => void markPrintedOnly()}>
          Mark printed{order.reportPrintCount ? ` (${order.reportPrintCount})` : ''}
        </Button>
        {can(profile, 'reports.send') && <Button icon={<SendOutlined />} disabled={blockedPartial} onClick={() => setSendOpen(true)}>Send</Button>}
        <Button icon={<FilePdfOutlined />} onClick={() => setSp((p) => { p.set('smart', '1'); return p })}>Smart report</Button>
        <Button icon={<DiffOutlined />} onClick={() => window.open(`/report-compare/${order.id}`, '_blank', 'noopener')}>Compare reports</Button>
        <Button icon={<SettingOutlined />} onClick={() => setOptOpen(true)}>Options</Button>
        <FormFAction order={order} />
        <span className="rp-bar__spacer" />
        <StatusChip variant={dstatus === 'dispatched' ? 'success' : dstatus === 'partial' ? 'caution' : 'neutral'}>{DISPATCH_STATUS_LABEL[dstatus]}</StatusChip>
        {order.dispatch.map((d) => (
          <span key={d.mode} style={{ display: 'inline-flex', gap: 'var(--s-1)', alignItems: 'center' }}>
            <StatusChip variant={d.delivered ? 'success' : 'neutral'}>{MODE_LABEL[d.mode] ?? d.mode}{d.delivered ? `: delivered ${fmtDateTime(d.deliveredAt)}` : ''}</StatusChip>
            {!d.delivered && <Button variant="text" icon={<CheckOutlined />} onClick={() => deliver(d.mode)}>{d.mode === 'hardcopy' ? 'Mark printed and delivered' : 'Mark delivered'}</Button>}
          </span>
        ))}
      </Glass>

      {formBlocked ? (
        <Alert className="no-print" type="error" showIcon style={{ maxWidth: '230mm', margin: '0 auto var(--s-3)' }}
          message="This PCPNDT bill has no completed Form F. The report cannot be printed or sent until it is complete."
          action={<FormFAction order={order} label="Open Form F" />} />
      ) : blockedPartial ? (
        <Alert className="no-print" type="warning" showIcon style={{ maxWidth: '230mm', margin: '0 auto var(--s-3)' }}
          message="Some results are still pending. Printing and sending are blocked until every test is reported." />
      ) : null}
      {frozen && (
        <Alert className="no-print" type="info" showIcon style={{ maxWidth: '230mm', margin: '0 auto var(--s-3)' }}
          message={`Showing the issued version (revision ${order.reportRevision ?? 0}), exactly as released. Later catalogue edits do not change it.`}
          action={<Button variant="text" onClick={() => setUseLive(true)}>Show live data</Button>} />
      )}
      {issued && useLive && (
        <Alert className="no-print" type="warning" showIcon style={{ maxWidth: '230mm', margin: '0 auto var(--s-3)' }}
          message="Showing live data from the current catalogue, not the issued version."
          action={<Button variant="text" onClick={() => setUseLive(false)}>Show issued version</Button>} />
      )}

      {can(profile, 'reports.send') && (
        <SendReportModal
          order={order}
          open={sendOpen}
          onClose={() => setSendOpen(false)}
          tests={allTests.map((t) => ({ id: t.id, name: t.name }))}
          defaultTestIds={picked}
          letterheadDefault={useLH}
        />
      )}

      <Drawer open={optOpen} onClose={() => setOptOpen(false)} title="Report options" width="min(460px, 100vw)" destroyOnHidden>
        <div className="rp-opt">
          <FormSection title="Layout" description="What appears on each printed page.">
          <Toggle label="Print on letterhead" help="Hides the lab header and footer, for pre-printed stationery." value={useLH} onChange={setLetterhead} />
          <Toggle label="Header" value={opts.header && !useLH} onChange={(v) => { setHeader(v); if (v) setLetterhead(false) }} />
          <Toggle label="Footer" value={opts.footer && !useLH} onChange={(v) => { setFooter(v); if (v) setLetterhead(false) }} />
          <Toggle label="New page for each department" value={opts.perDept} onChange={setPerDept} />
          <Toggle label="New page for each test" value={perTest} onChange={setPerTest} />
          <Toggle label="QR code" value={opts.qr} onChange={setShowQr} />
          <Toggle label="Barcode" value={opts.barcode} onChange={setShowBarcode} />
          <div className="re-field">
            <label htmlFor="rp-size">Page size</label>
            <Select id="rp-size" value={opts.pageSize} onChange={setPageSize} options={['A4', 'A5', 'Letter'].map((v) => ({ value: v, label: v }))} />
          </div>
          {layout.letterheads.some((l) => l.active !== false) && (
            <div className="re-field">
              <label htmlFor="rp-lh">Letterhead</label>
              <Select id="rp-lh" allowClear value={lhId ?? (layout.defaultLetterheadId || undefined)} placeholder="Lab default header" onChange={(v) => setLhId(v ?? '')}
                options={layout.letterheads.filter((l) => l.active !== false).map((l) => ({ value: l.id, label: l.name }))} />
            </div>
          )}
          {frozen && <Toggle label="Use today's layout settings for this issued report" value={freshLayout} onChange={setFreshLayout} />}
          </FormSection>
          <FormSection title="Content" description="What the report says and which tests it covers.">
          <div className="re-field">
            <label htmlFor="rp-lang">Report language</label>
            <Select id="rp-lang" value={lang} onChange={setLang} options={REPORT_LANGS} />
            <small className="wl-muted">Labels are translated; test names use the translation saved on the test, else English.</small>
          </div>
          <Toggle label="Compare with previous results" value={compare} onChange={setCompare} />
          <Toggle label="Abnormal summary page" value={abnSummary} onChange={setAbnSummary} />
          <div className="re-field">
            <label htmlFor="rp-interp">Report interpretation</label>
            <Select id="rp-interp" value={interp} onChange={setInterp} options={[{ value: 'test', label: 'As set on each test' }, { value: 'show', label: 'Show on all tests' }, { value: 'hide', label: 'Hide on all tests' }]} />
          </div>
          <div className="re-field">
            <label htmlFor="rp-tests">Tests to include</label>
            <Select id="rp-tests" mode="multiple" allowClear placeholder="All tests" value={picked} onChange={setPicked} maxTagCount="responsive" options={allTests.map((t) => ({ value: t.id, label: t.name }))} />
            <Button variant="text" onClick={() => setPicked(allTests.map((t) => t.id))}>Select all</Button>
          </div>
          <div className="re-field">
            <label htmlFor="rp-date">Report date</label>
            <DatePicker
              id="rp-date" showTime format="DD-MMM-YYYY hh:mm A" allowClear={!!order.reportDateOverride}
              value={reportDate ? dayjs(reportDate) : null}
              disabled={!can(profile, 'reports.print')}
              onChange={async (v) => {
                await updateDoc(docRef(paths.orders, orderId), { reportDateOverride: v ? v.toDate() : null })
                message.success('Report date updated')
              }}
            />
          </div>
          </FormSection>
          <FormSection title="Stored copy" description="A hashed PDF and print-ready copy are stored each time the report is released or amended. Issued reports are shown and sent from that stored version.">
          <div className="re-field">
            {snaps.map((sn) => (
              <div key={sn.id} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Rev {sn.revision} ({sn.status}) {sn.createdAt ? dayjs(sn.createdAt.toDate()).format('DD-MMM HH:mm') : ''} <code>{sn.sha256.slice(0, 10)}</code></span>
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  {sn.pdfPath && <Button variant="text" icon={<FilePdfOutlined />} onClick={() => downloadSnapshotPdf(order.billNo, sn).catch((e) => message.error((e as Error).message))}>PDF</Button>}
                  <Button variant="text" icon={<DownloadOutlined />} onClick={() => downloadHtml(`report-${order.billNo}-r${sn.revision}.html`, sn.html)}>HTML</Button>
                </span>
              </div>
            ))}
            <Button disabled={snapBusy || !can(profile, 'reports.print')} onClick={async () => {
              setSnapBusy(true)
              try { const r = await ensureSnapshot(order.id); message.success(r.sha256 ? 'Stored copy is up to date' : 'Stored') } catch (e) { message.error((e as Error).message) } finally { setSnapBusy(false) }
            }}>Create stored copy now</Button>
          </div>
          </FormSection>
          <FormSection title="Bill PIN" description="The patient can type this PIN to open the online report instead of waiting for a code.">
          <div className="re-field">
            {pin ? <b style={{ fontSize: 20, letterSpacing: 4 }}>{pin}</b> : <Button disabled={!canQr} onClick={() => ensureBillPin(order.id).then(setPin).catch((e) => message.error((e as Error).message))}>Show bill PIN</Button>}
          </div>
          </FormSection>
          <FormSection title="Attached report" description="Replace the generated report with your own PDF, and add a note that explains it.">
          <div className="re-field">
            <label htmlFor="rp-file">Upload a PDF (up to 15 MB, kept in file storage)</label>
            <input id="rp-file" type="file" accept="application/pdf" disabled={!can(profile, 'reports.print')} onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f || !profile) return
              try { await uploadReportFile(orderId, f, profile.uid); message.success('PDF attached') } catch (err) { message.error((err as Error).message) }
            }} />
            {order.hasReportFile && <Button variant="text" onClick={async () => { await removeReportFile(orderId); message.success('Attachment removed') }}>Remove attached PDF</Button>}
          </div>
          <div className="re-field">
            <label htmlFor="rp-attach">Note for an attached or re-uploaded PDF</label>
            <Input.TextArea id="rp-attach" rows={2} placeholder="e.g. Original report from partner lab attached" value={attach} onChange={(e) => setAttachNote(e.target.value)} />
            <Button disabled={attachNote === null} onClick={async () => { await updateDoc(docRef(paths.orders, orderId), { reportAttachmentNote: attachNote ?? '' }); message.success('Saved'); setAttachNote(null) }}>Save note</Button>
          </div>
          </FormSection>
        </div>
      </Drawer>

      <div className="rp-sheet-wrap">
        <ReportSheet model={shown ?? model} opts={opts} prevs={prevs} />
      </div>
    </div>
  )
}
