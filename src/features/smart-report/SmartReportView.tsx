import { useMemo, useState } from 'react'
import { App } from 'antd'
import { ArrowLeftOutlined, PrinterOutlined, RobotOutlined, SaveOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { setDoc, serverTimestamp } from 'firebase/firestore'
import { Alert } from 'antd'
import { docRef, labDoc } from '../../lib/db'
import { useLiveDoc } from '../../hooks/useLive'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { can, useAuth } from '../../auth/AuthProvider'
import { interpretResult } from '../../lib/ai'
import { ageDaysAtCollection, parseNumeric, resolveRange } from '../../lib/results'
import { printedRange, templateFor } from '../../pages/catalogue/behaviour'
import { interpretationHtml } from '../../pages/catalogue/richText'
import type { TestExt } from '../../pages/catalogue/ext'
import { effectiveSettings } from '../settings/lib'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import type { Parameter, Test } from '../../types'
import { ageText, fmtDateTime, genderText, tsToDate } from '../../components/results/common'
import type { OrderExt, ResultExt } from '../../components/results/types'
import { usePreviousResults } from '../../components/results/usePrevious'
import ReportSheet, { PAGE_MM } from '../report/ReportSheet'
import type { PrevMap, ReportModel, ReportOpts, RResult } from '../report/model'
import SmartPages, { type SmartModel } from './SmartPages'
import FertilityPage, { isFertilityItem } from './fertility'
import { plainNote } from './plain'
import { mergeSmart } from './types'
import { systemOf } from './visuals'
import './smartReport.css'

interface Item { t: Test; p: Parameter; value: string; abnormal: 'low' | 'high' | 'abnormal' | null; critical: boolean; range: string; low: number | null; high: number | null }

// A trailing unit written inside a stored value (e.g. "12 mg/dL") that differs from the parameter's unit.
const unitMismatch = (raw: string, unit: string) => {
  const m = raw.trim().match(/[a-zA-Zµ%/][\w%µ/.^*-]*\s*$/)
  return !!m && !!unit && m[0].trim().toLowerCase() !== unit.trim().toLowerCase()
}

export default function SmartReportView({ order, results, onBack }: { order: OrderExt; results: ResultExt[]; onBack: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settingsAll = useLabSettings()
  const lab = useMemo(() => effectiveSettings(settingsAll, order.branchId), [settingsAll, order.branchId])
  const maps = useCatalogueMaps()
  const { data: labDocData } = useLiveDoc<{ smartReport?: unknown }>(labDoc(), [])
  const s = useMemo(() => {
    const m = mergeSmart(labDocData?.smartReport)
    return { ...m, labName: m.labName || lab.name, labAddress: m.labAddress || lab.address, logoDataUrl: m.logoDataUrl || lab.profile.logoDataUrl, email: m.email || lab.email }
  }, [labDocData, lab])
  const history = usePreviousResults(order, 6, s.showHistoryGraph)
  const [aiBusy, setAiBusy] = useState(false)
  const [mode, setMode] = useState<'native' | 'convert'>('native')
  const [variant, setVariant] = useState<'standard' | 'fertility'>('standard')
  const [regen, setRegen] = useState(false)
  const [saving, setSaving] = useState(false)
  // Saved copy (SR-12): the smart report is stored per bill with the report revision it was made from.
  const { data: saved } = useLiveDoc<{ revision: number; variant: 'standard' | 'fertility'; model: SmartModel; staleSince?: unknown; savedAt?: { toDate(): Date } }>(docRef('smartReports', order.id), [order.id])
  const revision = order.reportRevision ?? 0
  const stale = !!saved && (saved.revision < revision || !!saved.staleSince)
  const rd = lab.reportDetails
  const [pw, ph] = PAGE_MM[rd.pageSize] ?? PAGE_MM.A4
  const ageDays = ageDaysAtCollection(order)

  const approved = results.filter((r) => r.status === 'approved')
  const items: Item[] = approved.flatMap((r) => {
    const t = maps.testById.get(r.testId)
    if (!t) return []
    return t.parameters
      .filter((p) => p.structure !== 'group' && (r.values?.[p.key]?.value ?? '').trim() !== '')
      .map((p) => {
        const band = resolveRange(p, ageDays, order.gender, order.patientCondition, r.values[p.key]?.rangeOverride)
        return { t, p, value: r.values[p.key].value, abnormal: r.values[p.key].abnormal, critical: r.values[p.key].critical, range: printedRange(p, r.values[p.key], ageDays, order.gender, order.patientCondition), low: band.low, high: band.high }
      })
  })
  const graphs = s.showHistoryGraph
    ? items
        // Numeric parameters only; descriptive / option tests never get a trend.
        .filter((i) => i.p.dataType === 'numeric' || i.p.dataType === 'numericUnbound')
        .map((i) => {
          const pts = [...(history[i.t.id] ?? [])]
            .reverse()
            .filter((h) => !unitMismatch(h.values[i.p.key]?.value ?? '', i.p.unit))
            .map((h) => ({ label: dayjs(tsToDate(h.date)).format('DD MMM YY'), v: parseNumeric(h.values[i.p.key]?.value ?? '') }))
            .filter((x) => x.v !== null)
          const cur = parseNumeric(i.value)
          if (cur === null || unitMismatch(i.value, i.p.unit) || pts.length < 1) return null
          return { item: i, data: [...pts, { label: 'This report', v: cur }] }
        })
        .filter((g): g is NonNullable<typeof g> => !!g)
    : []

  const aiSummaries = approved.filter((r) => r.aiInterpretation && r.aiInterpretation.status !== 'discarded')
  const aiOn = lab.aiEnabled && can(profile, 'ai.interpret')
  const generate = async () => {
    setAiBusy(true)
    try {
      for (const r of approved.filter((x) => !x.aiInterpretation || x.aiInterpretation.status === 'discarded').slice(0, 6)) {
        await interpretResult({ orderId: order.id, testId: r.testId })
      }
      message.success('AI summary generated. Review it before sharing.')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not generate the AI summary')
    } finally {
      setAiBusy(false)
    }
  }

  const model: ReportModel = useMemo(() => {
    const ids = new Set(results.map((r) => r.testId))
    const tests = maps.tests.filter((t) => ids.has(t.id)).sort((a, b) => (maps.departmentById.get(a.departmentId)?.order ?? 999) - (maps.departmentById.get(b.departmentId)?.order ?? 999) || a.order - b.order)
    const deptIds = [...new Set(tests.map((t) => t.departmentId))]
    return {
      lab: { name: lab.name, address: lab.address, phone: lab.phone, email: lab.email, website: lab.profile.website, city: lab.profile.city, logoDataUrl: lab.profile.logoDataUrl, dateFormat: lab.profile.dateFormat },
      rd,
      idDisplay: lab.registration.idDisplay,
      order: {
        billNo: order.billNo, patientName: order.patientName, patientNo: order.patientNo, uhid: order.uhid ?? '', phone: '', address: '',
        gender: order.gender, ageValue: order.ageValue, ageUnit: order.ageUnit, referrerName: order.referrerName, barcode: order.barcode,
        createdAt: tsToDate(order.createdAt), collectedAt: tsToDate(order.collectedAt), receivedAt: tsToDate(order.receivedAt),
        reportedAt: tsToDate(order.reportedAt) ?? new Date(),
        reportStatus: order.reportStatus, reportSignatoryId: order.reportSignatoryId ?? '', reportNote: order.reportNote ?? '',
        reportRevision: order.reportRevision ?? 0, amendSummary: order.amendSummary ?? '', disableLetterhead: order.disableLetterhead === true,
      },
      signatories: lab.signatories.filter((x) => x.active),
      defaultSignatoryId: lab.reportEntry.defaultSignatoryId,
      depts: deptIds.map((id) => { const d = maps.departmentById.get(id); return { id, name: d?.name ?? 'Other', order: d?.order ?? 999 } }),
      tests: tests.map((t) => ({ id: t.id, name: t.name, departmentId: t.departmentId, order: t.order, interpretation: t.interpretation, parameters: t.parameters, startOnNewPage: t.startOnNewPage, templateId: templateFor(t as TestExt, maps.departmentById), interpretationHtml: interpretationHtml(t as TestExt), sampleTypeName: maps.sampleTypeById.get(t.sampleTypeId)?.name ?? '' })),
      results: results as unknown as RResult[],
      qrUrl: '',
      reportFile: null,
      attachNote: '',
    }
  }, [order, results, lab, rd, maps])
  const origOpts: ReportOpts = {
    letterhead: order.disableLetterhead ? false : rd.useLetterhead, header: order.disableLetterhead ? false : rd.showHeader, footer: order.disableLetterhead ? false : rd.showFooter, perDept: rd.pageBreakPerDepartment, perTest: false, compare: false, abnSummary: false,
    qr: false, barcode: rd.showBarcode, pageSize: rd.pageSize, picked: [], interpretation: null, duplicate: false,
  }
  const noPrevs: PrevMap = {}
  const pageVars = { '--sr-w': `${pw}mm`, '--sr-h': `${ph}mm`, '--sr-mt': `${rd.marginTop}mm`, '--sr-mr': `${rd.marginRight}mm`, '--sr-mb': `${rd.marginBottom}mm`, '--sr-ml': `${rd.marginLeft}mm` } as React.CSSProperties

  const doctorNote = [order.reportNote, ...approved.filter((r) => r.commentOnReport !== false).map((r) => r.comment)].filter(Boolean).join('\n\n')
  const live: SmartModel = {
    cover: {
      name: order.patientName,
      ageGender: `${ageText(order)} / ${genderText(order.gender)}`,
      patientId: order.patientNo,
      billNo: order.billNo,
      referrer: order.referrerName || 'Self',
      date: fmtDateTime(order.reportedAt ?? order.createdAt).slice(0, 11),
    },
    firstName: order.patientName.replace(/^(mr|mrs|ms|miss|master|dr|baby|b\/o)\.?\s+/i, '').split(/\s+/)[0] ?? '',
    items: items.map((i) => {
      const flagged = i.abnormal || i.critical
      const note = i.p.explanation?.trim() || (flagged ? plainNote(i.p, { value: i.value, abnormal: i.abnormal, critical: i.critical, overridden: false }, i.range).text : 'Within the usual range.')
      return {
        key: i.t.id + ':' + i.p.key, testName: i.t.name, name: i.p.name, value: i.value, unit: i.p.unit, num: parseNumeric(i.value),
        flag: i.abnormal, critical: i.critical, range: i.range, low: i.low, high: i.high, note,
        system: systemOf(maps.departmentById.get(i.t.departmentId)?.name ?? '', i.t.name, i.p.name),
      }
    }),
    trends: graphs.map(({ item, data }) => ({ key: (item.t.id + item.p.key).replace(/[^\w-]/g, ''), name: item.p.name, unit: item.p.unit, low: resolveLow(item), high: resolveHigh(item), data: data.filter((d): d is { label: string; v: number } => d.v !== null) })),
    doctorNote,
    ai: aiSummaries.map((r) => ({ title: r.testName, text: r.aiInterpretation!.summary })),
  }

  // Fertility variant keeps only fertility-related results and titles the report accordingly.
  const fertility = (saved && !regen && !stale ? saved.variant : variant) === 'fertility'
  const liveShown: SmartModel = variant === 'fertility' ? { ...live, items: live.items.filter(isFertilityItem), trends: live.trends.filter((t) => isFertilityItem({ name: t.name, testName: '' })) } : live
  const useSaved = !!saved && !regen && !stale && !!saved.model
  const smart = useSaved ? saved!.model : liveShown
  const sForView = fertility ? { ...s, coverTitle: 'Your fertility report', coverSubtitle: 'A clear guide to your fertility test results' } : s
  const saveCopy = async () => {
    setSaving(true)
    try {
      const notes = liveShown.items.filter((i) => i.flag || i.critical).map((i) => ({ label: `${i.name} ${i.value} ${i.unit}`.trim(), text: i.note }))
      await setDoc(docRef('smartReports', order.id), { revision, variant, model: JSON.parse(JSON.stringify(liveShown)), notes, savedAt: serverTimestamp(), savedBy: profile?.uid ?? '', staleSince: null })
      setRegen(false)
      message.success('Smart report saved. Sends and the patient link use this copy.')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save the smart report')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 'var(--s-4)' }}>
      <style>{`@page { size: ${rd.pageSize === 'Letter' ? 'letter' : rd.pageSize}; margin: 0; }`}</style>
      <div className="sr-bar no-print">
        <Button icon={<ArrowLeftOutlined />} onClick={onBack}>Back to report</Button>
        <Button variant="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
        <Segmented<'native' | 'convert'> aria-label="Generation mode" value={mode} onChange={setMode} options={[{ value: 'native', label: 'Native' }, { value: 'convert', label: 'Convert from normal report' }]} />
        <Segmented<'standard' | 'fertility'> aria-label="Smart report type" value={useSaved ? saved!.variant : variant} onChange={(v) => { setVariant(v); setRegen(true) }} options={[{ value: 'standard', label: 'Standard' }, { value: 'fertility', label: 'Fertility' }]} />
        <Button icon={<SaveOutlined />} disabled={saving || !can(profile, 'reports.print')} onClick={saveCopy}>{saved ? 'Regenerate and save copy' : 'Save a copy'}</Button>
        {aiOn && <Button icon={<RobotOutlined />} disabled={aiBusy || !approved.length} onClick={generate}>{aiBusy ? 'Generating' : 'Generate AI summary'}</Button>}
      </div>

      {stale && <Alert className="no-print" type="warning" showIcon style={{ marginBottom: 12 }} message="Stale: this report was amended after the smart report was saved. The page below is rebuilt from the current results. Save it again to replace the old copy; the old copy cannot be sent." />}
      {useSaved && <Alert className="no-print" type="info" showIcon style={{ marginBottom: 12 }} message={`Showing the saved copy${saved?.savedAt ? ` of ${saved.savedAt.toDate().toLocaleString()}` : ''}.`} action={<Button variant="text" onClick={() => setRegen(true)}>Rebuild from current results</Button>} />}
      <div className={mode === 'convert' ? 'sr-compare' : undefined}>
        {mode === 'convert' && (
          <div className="sr-nonprint" aria-label="Original report">
            <h3 style={{ margin: '0 0 var(--s-2)' }}>Original report</h3>
            <ReportSheet model={model} opts={origOpts} prevs={noPrevs} />
          </div>
        )}
        <div aria-label="Smart report">
          {mode === 'convert' && <h3 className="no-print" style={{ margin: '0 0 var(--s-2)' }}>Smart report</h3>}
          <SmartPages s={sForView} model={smart} aiTag={s.showAiTag && aiSummaries.length > 0} pageStyle={pageVars} afterCover={fertility ? <FertilityPage items={smart.items} /> : undefined} />
        </div>
      </div>
      {s.includeOriginal && (
        <div className="sr-orig" aria-label="Original signed report">
          <ReportSheet model={model} opts={origOpts} prevs={noPrevs} />
        </div>
      )}
    </div>
  )

  function resolveLow(i: Item) {
    return i.p.ranges.find((r) => ageDays >= r.fromDays && ageDays <= r.toDays)?.low ?? i.p.low
  }
  function resolveHigh(i: Item) {
    return i.p.ranges.find((r) => ageDays >= r.fromDays && ageDays <= r.toDays)?.high ?? i.p.high
  }
}
