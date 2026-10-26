import { radHtml, radHasText } from '../radiology/richtext'
import { RadImg } from '../radiology/StorageImg'
import { Fragment, useMemo } from 'react'
import dayjs from 'dayjs'
import { ageInDays, flagLetter, sanitizeRich } from '../../lib/results'
import { printedRange } from '../../pages/catalogue/behaviour'
import { formatLabDate, labContactLine } from '../settings/lib'
import { showInterpretation, startsOnNewPage, testComment } from '../../pages/catalogue/flags'
import type { Parameter, ParamValue, ReportStatus } from '../../types'
import { ISSUE_LABEL } from '../../components/results/types'
import { code128Svg } from '../../pages/report/barcode'
import { reportCss } from '../../pages/report/reportCss'
import { nameIn, tr } from './i18n'
import { ageText, COLUMN_DEFAULT_WIDTH, COLUMN_LABEL, DEFAULT_LAYOUT, FIELD_LABELS, FONT_STACK } from './layout'
import type { ReportColumnKey } from '../../types'
import type { PrevMap, ReportModel, ReportOpts, RResult, RSig, RTest } from './model'

const STATUS_LABEL: Record<ReportStatus, string> = { pending: 'Pending', partial: 'Partial', provisional: 'Provisional', final: 'Final' }
const WATERMARK: Partial<Record<ReportStatus, string>> = { pending: 'DRAFT', partial: 'DRAFT', provisional: 'PROVISIONAL' }
export const PAGE_MM: Record<string, [number, number]> = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] }

export const FIELD_LABEL: Record<string, string> = {
  ...FIELD_LABELS,
  name: 'Name', ageGender: 'Age / Gender', patientId: 'Patient ID', uhid: 'UHID', billNo: 'Bill No', phone: 'Phone', referrer: 'Referred by',
  collectedAt: 'Collected', receivedAt: 'Received', registeredAt: 'Registered', reportedAt: 'Reported', sampleType: 'Sample type',
  barcode: 'Barcode', address: 'Address', status: 'Report status',
}

// Tiny trend line of the numeric values of a parameter (previous results, then this one).
function Spark({ pts, size }: { pts: number[]; size: 'small' | 'medium' | 'large' }) {
  const [w, h] = size === 'small' ? [56, 18] : size === 'large' ? [130, 38] : [90, 26]
  if (pts.length < 2) return null
  const lo = Math.min(...pts)
  const hi = Math.max(...pts)
  const span = hi - lo || 1
  const xy = pts.map((v, i) => `${(i / (pts.length - 1)) * (w - 4) + 2},${h - 3 - ((v - lo) / span) * (h - 6)}`)
  const last = xy[xy.length - 1].split(',')
  return (
    <svg width={w} height={h} role="img" aria-label="Trend">
      <polyline points={xy.join(' ')} fill="none" stroke="#0369A1" strokeWidth="1.5" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="#B91C1C" />
    </svg>
  )
}

function paramRows(test: RTest, result: RResult, ageDays: number, gender?: string, condition?: string) {
  const vis = test.parameters.filter((p) => !p.hideOnReport)
  const keys = new Set(test.parameters.map((p) => p.key))
  const rejected = result.rejectedParams ?? []
  const valueOf = (p: Parameter) => result.values?.[p.key]
  const hasVal = (p: Parameter) => (valueOf(p)?.value ?? '').trim() !== '' || rejected.includes(p.key)
  const out: { key: string; header?: string; p?: Parameter; indent?: boolean }[] = []
  for (const p of vis.filter((x) => !x.parentKey || !keys.has(x.parentKey))) {
    if (p.structure === 'group') {
      const members = vis.filter((m) => m.parentKey === p.key && hasVal(m))
      if (members.length) {
        out.push({ key: p.key, header: p.name })
        members.forEach((m) => out.push({ key: m.key, p: m, indent: true }))
      }
    } else if (hasVal(p)) out.push({ key: p.key, p })
  }
  return out.map((r) => ({ ...r, v: r.p ? valueOf(r.p) : undefined, range: r.p ? printedRange(r.p, valueOf(r.p), ageDays, gender, condition) : '' }))
}

// Lab Profile date format (when it looks like a date pattern), else the report's own default.
const dateSettings = (m: ReportModel) => ({ profile: { dateFormat: m.lab.dateFormat && /[DMY]/i.test(m.lab.dateFormat) ? m.lab.dateFormat : 'DD-MMM-YYYY' } })

export default function ReportSheet({ model, opts, prevs }: { model: ReportModel; opts: ReportOpts; prevs?: PrevMap }) {
  const { rd, order: o, lab } = model
  const modelLayout = model.layout ?? DEFAULT_LAYOUT
  const L = modelLayout
  const resultById = useMemo(() => new Map(model.results.map((r) => [r.testId, r])), [model.results])
  const bars = useMemo(() => code128Svg(o.barcode), [o.barcode])
  const dateSet = dateSettings(model)
  const d = (x: Date | null) => (x ? formatLabDate(dateSet, x, !L.reportDateOnly) : '-')
  const size = opts.pageSize
  const [pw, ph] = PAGE_MM[size]
  const useLH = opts.letterhead
  const lhead = L.letterheads.find((x) => x.id === (opts.letterheadId || L.defaultLetterheadId) && x.active !== false)
  const showHeader = !useLH && opts.header
  const showFooter = !useLH && opts.footer
  const ageDays = o.ageDays ?? ageInDays(o.ageValue, o.ageUnit)
  const status = o.reportStatus
  const lang = opts.lang
  const everySig = rd.signaturePlacement === 'everyPage'
  const hideSign = status === 'provisional' && rd.provisionalShowSign === false

  const picked = (t: RTest) => !opts.picked.length || opts.picked.includes(t.id)
  const groups = useMemo(() => {
    const out: { dept: { id: string; name: string }; tests: RTest[] }[] = []
    const depts = [...model.depts].sort((a, b) => a.order - b.order)
    const known = new Set(depts.map((x) => x.id))
    const all = [...depts, ...[...new Set(model.tests.map((t) => t.departmentId))].filter((id) => !known.has(id)).map((id) => ({ id, name: 'Other', order: 999 }))]
    for (const dept of all) {
      const tests = model.tests.filter((t) => t.departmentId === dept.id && picked(t)).sort((a, b) => a.order - b.order)
      if (tests.length) out.push({ dept, tests })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.depts, model.tests, opts.picked])

  const allVisible = groups.flatMap((g) => g.tests)

  const signers = model.signatories
  const signersFor = (tests: RTest[]): RSig[] => {
    const out: RSig[] = []
    const add = (s?: RSig | null) => {
      if (s && !out.some((x) => (x.id ?? x.name) === (s.id ?? s.name))) out.push(s)
    }
    for (const t of tests) {
      const r = resultById.get(t.id)
      if (r?.status !== 'approved') continue
      // The signatories frozen at approval win over today's settings.
      if (r.signatureSnapshots?.length) {
        r.signatureSnapshots.forEach((x) => add(x))
        continue
      }
      add(
        r.signatorySnapshot ??
          signers.find((s) => s.id === r.signatoryId) ??
          signers.find((s) => s.id === o.reportSignatoryId) ??
          signers.find((s) => (s.defaultForDepartmentIds ?? []).includes(t.departmentId)) ??
          signers.find((s) => s.id === model.defaultSignatoryId),
      )
    }
    if (!out.length) add(signers.find((s) => s.id === o.reportSignatoryId) ?? signers.find((s) => s.id === model.defaultSignatoryId))
    return out.slice(0, Math.max(1, L.maxSignatures || 3))
  }
  const approverNames = (tests: RTest[]) => [...new Set(tests.map((t) => resultById.get(t.id)).filter((r): r is RResult => r?.status === 'approved' && !!r.approvedByName).map((r) => r.approvedByName as string))]

  const sigBlock = (list: RSig[], fallback: string[]) => {
    if (hideSign) return null
    if (list.length)
      return list.map((s, i) => (
        <div className="sig" key={(s.id ?? s.name) + i} style={{ textAlign: (s.align as 'left' | 'center' | 'right') || 'center' }}>
          {s.signatureDataUrl && <img src={s.signatureDataUrl} alt={`Signature of ${s.name}`} style={s.signatureHeight ? { maxHeight: s.signatureHeight } : undefined} />}
          {L.showStamp && s.stampDataUrl && <img className="stamp" src={s.stampDataUrl} alt={`Stamp of ${s.name}`} />}
          {!s.hideNameInReport && <div><b>{s.name}</b></div>}
          {s.designation && <div>{s.designation}</div>}
          {s.qualification && <div>{s.qualification}</div>}
          {s.registrationNo && <div>Reg. no. {s.registrationNo}</div>}
        </div>
      ))
    return fallback.length ? <span>Approved by {fallback.join(', ')}</span> : null
  }

  const idValue = model.idDisplay === 'uhid' && o.uhid ? o.uhid : o.patientNo
  const reportDate = o.reportedAt
  const sampleTypes = [...new Set(allVisible.map((t) => t.sampleTypeName).filter(Boolean))].join(', ')
  const ex = o.fields ?? {}
  const genderText = o.gender ? o.gender.charAt(0).toUpperCase() + o.gender.slice(1) : ''
  const fieldValue = (k: string): string => {
    switch (k) {
      case 'name': return o.patientName
      case 'ageGender': return `${ageText(o.ageValue, o.ageUnit, L.ageFormat)} / ${genderText}`
      case 'age': return ageText(o.ageValue, o.ageUnit, L.ageFormat)
      case 'gender': return genderText || '-'
      case 'patientId': return idValue
      case 'uhid': return o.uhid || ex.uhid || '-'
      case 'billNo': return o.billNo
      case 'reportNo': return ex.reportNo || o.billNo
      case 'phone': return o.phone || ex.phone || '-'
      case 'address': return o.address || ex.address || '-'
      case 'referrer': return o.referrerName || 'Self'
      case 'b2bCentre': return L.showB2bCode && ex.b2bCode && ex.b2bCentre ? `${ex.b2bCentre} (${ex.b2bCode})` : ex.b2bCentre || '-'
      case 'collectedAt': return d(o.collectedAt)
      case 'receivedAt': return d(o.receivedAt)
      case 'registeredAt': return d(o.createdAt)
      case 'billDate': return d(o.billDate ?? o.createdAt)
      case 'reportedAt': return d(reportDate)
      case 'dob': return ex.dob ? formatLabDate(dateSet, new Date(`${ex.dob}T00:00:00`), false) : '-'
      case 'sampleType': return sampleTypes || '-'
      case 'barcode': return o.barcode
      case 'status': return STATUS_LABEL[status]
      default: return ex[k] || '-'
    }
  }
  const baseFields = L.headerFields.length ? L.headerFields : rd.patientFields?.length ? rd.patientFields : ['name', 'ageGender', 'patientId', 'billNo']
  const withCode = L.showB2bCode && ex.b2bCode && !baseFields.includes('b2bCode') && !baseFields.includes('b2bCentre') ? [...baseFields, 'b2bCode'] : baseFields
  const fields = withCode.filter((k) => FIELD_LABEL[k])

  // 'abnormal' = qualitative abnormal (option / text parameters): no direction, so it prints as "Abn".
  const flagText = (v?: Pick<ParamValue, 'abnormal' | 'critical' | 'criticalDir'>) => {
    const l = flagLetter(v)
    if (!l) return v?.critical ? 'Critical' : ''
    const arrow = rd.showFlagArrows ? (l.startsWith('H') ? '↑ ' : l.startsWith('L') ? '↓ ' : '') : ''
    return l === 'Abnormal' ? 'Abn' : arrow + l
  }
  const flagStyle = (v?: Pick<ParamValue, 'abnormal'>) =>
    L.boldOnly ? undefined : v?.abnormal === 'high' ? (rd.highColour ? { color: rd.highColour } : undefined)
      : v?.abnormal === 'low' ? (rd.lowColour ? { color: rd.lowColour } : undefined)
        : v?.abnormal === 'abnormal' ? (rd.highColour ? { color: rd.highColour } : undefined) : undefined

  // Rich text prints as a small safe tag set; image and PDF values are data URLs of the right type only.
  const isImageUrl = (s: string) => /^data:image\/(png|jpe?g|gif|webp);/i.test(s)
  const isPdfUrl = (s: string) => /^data:application\/pdf;/i.test(s)
  const bigValue = (p: Parameter, value: string) => {
    if (p.dataType === 'richText') return <div className="rich" dangerouslySetInnerHTML={{ __html: sanitizeRich(value) }} />
    if (p.dataType === 'image') return isImageUrl(value) ? <img className="pimg" src={value} alt={p.name} style={{ maxHeight: L.imageHeight }} /> : null
    if (p.dataType === 'pdf')
      return isPdfUrl(value) ? (
        <object className="ppdf" data={value} type="application/pdf" aria-label={p.name}>
          <a href={value} download={`${p.name}.pdf`}>Download {p.name}</a>
        </object>
      ) : null
    return null
  }
  const BIG = new Set(['richText', 'image', 'pdf'])

  const abnormalList = allVisible.flatMap((t) => {
    const r = resultById.get(t.id)
    if (r?.status !== 'approved') return []
    return t.parameters.filter((p) => r.values?.[p.key]?.abnormal || r.values?.[p.key]?.critical).map((p) => ({ t, p, v: r.values[p.key] }))
  })

  const renderTest = (t: RTest, first: boolean, prevTemplate?: string) => {
    // A report template (test's own, else its department's) may carry its own column / font layout.
    const L = t.templateId && model.templateLayouts?.[t.templateId] ? { ...modelLayout, ...model.templateLayouts[t.templateId] } : modelLayout
    const r = resultById.get(t.id)
    const approved = r?.status === 'approved'
    const rows = approved ? paramRows(t, r!, ageDays, o.gender, o.condition) : []
    const pv = prevs?.[t.id] ?? []
    const rad = r?.radiology
    // Print switch of the test (and text present) AND the result-level toggle, unless the viewer forces it.
    const showInterp = showInterpretation(t) && (opts.interpretation === null ? r?.showInterpretation !== false : opts.interpretation)
    const startNew = (startsOnNewPage(t) && !first) || (opts.perTest && !first) || (!first && prevTemplate !== undefined && (t.templateId ?? '') !== prevTemplate)
    const cols = (L.columnOrder as ReportColumnKey[]).filter((c) => (c !== 'reference' || rd.showReferenceRanges) && (c !== 'method' || L.showTestMethod))
    const hasPrev = opts.compare && pv.length > 0
    const showTrend = L.trendGraph && pv.length > 0
    const widthSum = cols.reduce((n, c) => n + (L.columnWidths[c] ?? COLUMN_DEFAULT_WIDTH[c]), 0) || 1
    const colWidth = (c: ReportColumnKey) => `${(((L.columnWidths[c] ?? COLUMN_DEFAULT_WIDTH[c]) / widthSum) * (hasPrev || showTrend ? 76 : 100)).toFixed(1)}%`
    const head = (c: ReportColumnKey) => L.columnLabels[c] || (c === 'method' ? COLUMN_LABEL.method : tr(lang, c))
    const deptName = model.depts.find((x) => x.id === t.departmentId)?.name ?? ''
    const allergy = L.allergyRows && /allerg/i.test(deptName)
    const valueRows = rows.filter((x) => x.p && !BIG.has(x.p.dataType))
    const cell = (c: ReportColumnKey, row: (typeof rows)[number], res?: RResult) => {
      const p = row.p!
      switch (c) {
        case 'test':
          return (
            <td key={c} style={{ paddingLeft: row.indent ? 16 : 4 }}>
              {nameIn(p, lang)}
              {res?.paramComments?.[row.key] && !res.paramCommentHidden?.[row.key] && <div className="note">{res.paramComments[row.key]}</div>}
              {L.showMic && (row.v as { mic?: string } | undefined)?.mic && <div className="note">MIC: {(row.v as { mic?: string }).mic}</div>}
            </td>
          )
        case 'result': return <td key={c} className="val" style={flagStyle(row.v)}>{(res?.rejectedParams ?? []).includes(row.key) ? 'Rejected' : row.v?.value}</td>
        case 'flag': return <td key={c} className="val" style={flagStyle(row.v)}>{flagText(row.v)}</td>
        case 'reference': return <td key={c}>{row.range}</td>
        case 'unit': return <td key={c}>{p.unit}</td>
        default: return <td key={c}>{p.method}</td>
      }
    }
    return (
      <div key={t.id} className={`block ${startNew ? 'pgbefore' : ''}`}>
        <h4 className="tname">{nameIn(t, lang)}</h4>
        {rd.showSampleTypePerTest !== false && t.sampleTypeName && <p className="smp">{tr(lang, 'sample')}: {t.sampleTypeName}{o.barcode ? ` (${o.barcode})` : ''}</p>}
        {L.showMachineName && r?.machineName && <p className="smp">Machine: {r.machineName}</p>}
        {r?.status === 'rejected' ? (
          <div className="rejected">Sample rejected{r.rejected?.reason ? `: ${r.rejected.reason}` : ''}. Please recollect.</div>
        ) : !approved ? (
          <div className="await">{tr(lang, 'awaited')}</div>
        ) : rad && (rad.findings || rad.impression) ? (
          <div className="rad">
            {radHasText(rad.technique) && (<><h5>Technique</h5><div dangerouslySetInnerHTML={{ __html: radHtml(rad.technique) }} /></>)}
            {radHasText(rad.findings) && (<><h5>Findings</h5><div dangerouslySetInnerHTML={{ __html: radHtml(rad.findings) }} /></>)}
            {radHasText(rad.impression) && (<><h5>Impression</h5><div dangerouslySetInnerHTML={{ __html: radHtml(rad.impression) }} /></>)}
            {rad.secondOpinion && (<><h5>Second opinion ({rad.secondOpinion.doctorName}{rad.secondOpinion.cosignedBy ? `, co-signed by ${rad.secondOpinion.cosignedBy}` : ''})</h5><p>{rad.secondOpinion.opinion}</p></>)}
            {!!rad.images?.length && <div className="imgs">{rad.images.map((im) => { const cap = (im as { caption?: string }).caption; return <figure key={im.id} style={{ margin: 0 }}><RadImg im={im} alt={cap || im.name} />{cap && <figcaption style={{ fontSize: 10 }}>{cap}</figcaption>}</figure> })}</div>}
          </div>
        ) : (
          <>
            {allergy ? (
              <table className="res">
                <thead><tr>{[0, 1].map((k) => <Fragment key={k}><th style={{ width: '28%' }}>{head('test')}</th><th style={{ width: '14%' }}>{head('result')}</th><th style={{ width: '8%' }}>{head('flag')}</th></Fragment>)}</tr></thead>
                <tbody>
                  {Array.from({ length: Math.ceil(valueRows.length / 2) }, (_, i) => valueRows.slice(i * 2, i * 2 + 2)).map((pair, i) => (
                    <tr key={i}>
                      {pair.map((row) => (
                        <Fragment key={row.key}>
                          <td>{nameIn(row.p!, lang)}</td>
                          <td className="val" style={flagStyle(row.v)}>{row.v?.value}</td>
                          <td className="val" style={flagStyle(row.v)}>{flagText(row.v)}</td>
                        </Fragment>
                      ))}
                      {pair.length === 1 && <td colSpan={3} />}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
            <table className="res">
              <thead>
                <tr>
                  {cols.map((c) => <th key={c} style={{ width: colWidth(c) }}>{head(c)}</th>)}
                  {hasPrev && <th>{tr(lang, 'previous')}</th>}
                  {showTrend && <th>Trend</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) =>
                  row.header ? (
                    <tr key={row.key} className="grp"><td colSpan={cols.length + (hasPrev ? 1 : 0) + (showTrend ? 1 : 0)}>{row.header}</td></tr>
                  ) : BIG.has(row.p!.dataType) ? (
                    <tr key={row.key}>
                      <td style={{ paddingLeft: row.indent ? 16 : 4 }}>{nameIn(row.p!, lang)}</td>
                      <td colSpan={cols.length - 1 + (hasPrev ? 1 : 0) + (showTrend ? 1 : 0)}>{bigValue(row.p!, row.v?.value ?? '')}</td>
                    </tr>
                  ) : (
                    <tr key={row.key} className={row.v?.abnormal || row.v?.critical ? `abn-${L.boldOnly && rd.abnormalStyle !== 'none' ? 'bold' : rd.abnormalStyle}` : ''}>
                      {cols.map((c) => cell(c, row, r))}
                      {hasPrev && (
                        <td>{pv.map((x) => (x.values[row.key] ? `${x.values[row.key].value} (${x.date ? dayjs(x.date).format('DD/MM/YY') : ''})` : '')).filter(Boolean).join('; ')}</td>
                      )}
                      {showTrend && (
                        <td><Spark size={L.trendSize} pts={[...pv].reverse().map((x) => Number.parseFloat(x.values[row.key]?.value ?? '')).concat(Number.parseFloat(row.v?.value ?? '')).filter((n) => Number.isFinite(n))} /></td>
                      )}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
            )}
            {showInterp && (<div className="note"><b>{tr(lang, 'interpretation')}: </b>{t.interpretationHtml || /<[a-z][\s\S]*>/i.test(t.interpretation) ? <div className="rich" dangerouslySetInnerHTML={{ __html: sanitizeRich(t.interpretationHtml || t.interpretation) }} /> : t.interpretation}</div>)}
            {testComment(t) && r?.commentOnReport !== false && (<div className="note">{testComment(t)}</div>)}
            {r?.comment && r.commentOnReport !== false && (<div className="note"><b>{tr(lang, 'comment')}: </b>{r.comment}</div>)}
          </>
        )}
        {(r?.issues ?? []).map((i, n) => (
          <div key={n} className="issue">Sample note: {ISSUE_LABEL[i.type as keyof typeof ISSUE_LABEL] ?? i.type}{i.note ? `. ${i.note}` : ''}</div>
        ))}
      </div>
    )
  }

  const sheetPad = `${rd.marginTop}mm ${rd.marginRight}mm ${rd.marginBottom}mm ${rd.marginLeft}mm`
  const wmText = opts.duplicate ? 'DUPLICATE' : WATERMARK[status]
  const sepDept = opts.perDept

  return (
    <>
      <style>{reportCss}{`@page { size: ${size === 'Letter' ? 'letter' : size}; }`}</style>
      <div className={`rpt ${everySig ? 'every-sig' : ''}`} style={{ width: `${pw}mm`, minHeight: `${ph}mm`, padding: sheetPad, fontFamily: FONT_STACK[L.fontFamily], fontSize: L.fontSize }}>
        {(wmText || lab.logoDataUrl) && (
          <div className="wm" aria-hidden="true">
            {wmText ? <span>{wmText}</span> : <img src={lab.logoDataUrl} alt="" />}
          </div>
        )}
        <div className="content">
          {everySig && !hideSign && <div className="sig-fixed">{sigBlock(signersFor(allVisible), approverNames(allVisible))}</div>}
          <div className="hdr" style={{ visibility: showHeader ? 'visible' : 'hidden', minHeight: 70 }}>
            {lhead?.headerDataUrl ? (
              <img className="hi" src={lhead.headerDataUrl} alt="" />
            ) : rd.headerImage ? (
              <img className="hi" src={rd.headerImage} alt="" />
            ) : (
              <div style={{ textAlign: L.logoAlign }}>
                {lab.logoDataUrl && <img className="logo" src={lab.logoDataUrl} alt="" style={{ maxHeight: L.logoHeight }} />}
                <div style={{ fontSize: 22, fontWeight: 700, color: '#0369A1' }}>{lab.name}</div>
                <div>{[lab.address, lab.city].filter(Boolean).join(', ')}</div>
                <div>{labContactLine({ phone: L.showLabPhone && lab.phone ? `Phone: ${lab.phone}` : '', email: lab.email, profile: { website: lab.website } })}</div>
              </div>
            )}
          </div>

          {wmText && status !== 'final' && (
            <div className="banner">
              {status === 'provisional' ? 'PROVISIONAL REPORT' : 'INTERIM REPORT: some results are awaited'}
              <small>{status === 'provisional' ? 'Results are approved; the report becomes final once the bill is settled.' : 'This is not the final report.'}</small>
            </div>
          )}
          {o.reportRevision > 0 && (
            <div className="banner amend">
              AMENDED REPORT: revision {o.reportRevision}
              {o.amendSummary && <small>{o.amendSummary}. Please discard earlier copies.</small>}
            </div>
          )}

          <div className="ids">
            <div className="pat" style={{ flex: 1, gridTemplateColumns: `repeat(${L.headerColumns || 2}, 1fr)` }}>
              {fields.map((k) => (
                <div key={k}><span className="k">{(lang && lang !== 'en' ? (tr(lang, k as Parameters<typeof tr>[1]) as string | undefined) : undefined) ?? FIELD_LABEL[k]}</span><b>{fieldValue(k)}</b></div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              {opts.qr && model.qrUrl && <img src={model.qrUrl} alt="Report QR code" />}
              {opts.barcode && bars && <span dangerouslySetInnerHTML={{ __html: bars }} />}
            </div>
          </div>

          {o.reportNote && <div className="note"><b>{tr(lang, 'note')}: </b>{o.reportNote}</div>}

          {model.reportFile?.dataUrl ? (
            <object className="filebox" data={model.reportFile.dataUrl} type="application/pdf" aria-label={model.reportFile.name}>
              <a href={model.reportFile.dataUrl} download={model.reportFile.name}>Download {model.reportFile.name}</a>
            </object>
          ) : (
            <>
              {opts.abnSummary && (
                <div className="summary block pgbreak">
                  <h3>{tr(lang, 'abnSummary')}</h3>
                  {abnormalList.length === 0 ? (
                    <p>No abnormal values in the approved results.</p>
                  ) : (
                    <table className="res">
                      <thead><tr><th>Test</th><th>Parameter</th><th>Result</th><th>Flag</th><th>Reference range</th></tr></thead>
                      <tbody>
                        {abnormalList.map(({ t, p, v }) => (
                          <tr key={t.id + p.key} className="abn-both">
                            <td>{t.name}</td><td>{p.name}</td><td className="val">{v.value} {p.unit}</td>
                            <td className="val">{v.critical ? `${flagText(v)} !!` : flagText(v)}</td><td>{printedRange(p, v, ageDays, o.gender, o.condition)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {groups.map(({ dept, tests }, gi) => (
                <div key={dept.id} className={sepDept && gi < groups.length - 1 ? 'pgbreak' : ''}>
                  {L.showDeptName && <h3 className="dept">{dept.name}</h3>}
                  {tests.map((t) => renderTest(t, t.id === allVisible[0]?.id, allVisible[allVisible.findIndex((x) => x.id === t.id) - 1]?.templateId ?? (allVisible.findIndex((x) => x.id === t.id) > 0 ? '' : undefined)))}
                  {!everySig && sepDept && <div className="appr">{sigBlock(signersFor(tests), approverNames(tests))}</div>}
                </div>
              ))}
              {!everySig && !sepDept && <div className="appr">{sigBlock(signersFor(allVisible), approverNames(allVisible))}</div>}
            </>
          )}

          {L.listPendingTests && !!o.pending?.length && <div className="note"><b>Results awaited: </b>{o.pending.join(', ')}</div>}
          {L.showPackageName && !!o.packages?.length && <div className="note"><b>Package: </b>{o.packages.join(', ')}</div>}
          {model.attachNote && <div className="note"><b>Attachment: </b>{model.attachNote}</div>}
          <div className="end">{rd.endOfReportText || tr(lang, 'endOfReport')}</div>
          <div className="ftr" style={{ visibility: showFooter ? 'visible' : 'hidden', minHeight: 24 }}>
            {lhead?.footerDataUrl ? <img src={lhead.footerDataUrl} alt="" style={{ maxWidth: '100%', maxHeight: 60 }} /> : rd.footerText || `${lab.name}${lab.address ? ` - ${lab.address}` : ''}`}
          </div>
          {L.showMadeWith && <div style={{ textAlign: 'center', fontSize: 9, color: '#888', marginTop: 2 }}>Made with Health Care Labs</div>}
        </div>
      </div>
    </>
  )
}
