import type { DocumentData, Firestore, Timestamp } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

// Server-side report snapshot (RP-31, X-04). At issue time (provisional, final, amended) the server freezes a
// JSON "report payload": lab header, layout settings, signatories, patient block, approved results and the
// catalogue tests as they were at that moment. The web app and the public page render issued reports from
// that payload, never from the live catalogue; pdf.ts renders the same payload to a PDF file and the HTML
// below is a print-ready copy of it.

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const RICH = new Set(['b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'br', 'p', 'div', 'span'])
// Allow-list sanitiser: keeps only bare formatting tags, drops attributes and everything else.
export function safeRich(html: unknown): string {
  const s = String(html ?? '')
  if (!/<[a-z][\s\S]*>/i.test(s)) return esc(s).replace(/\n/g, '<br>')
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (m, tag: string) => {
      const t = tag.toLowerCase()
      if (!RICH.has(t)) return ''
      if (t === 'br') return '<br>'
      return m.startsWith('</') ? `</${t}>` : `<${t}>`
    })
}

// Rich text to plain text lines (PDF output). Paragraphs and list items become lines.
export function richToLines(html: unknown): string[] {
  const s = String(html ?? '')
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.split(/\n/).map((l) => l.trim()).filter(Boolean)
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|ul|ol|h\d)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split(/\n/).map((l) => l.trim()).filter(Boolean)
}

const ms = (t: unknown): number | null => (t as { toMillis?: () => number } | null | undefined)?.toMillis?.() ?? null
const iso = (t: unknown): string | null => {
  const d = t as { toDate?: () => Date } | null | undefined
  return d && typeof d.toDate === 'function' ? d.toDate().toISOString() : null
}

export const DEFAULT_LAYOUT = {
  fontFamily: 'sans', fontSize: 12, headingSize: 14,
  columnOrder: ['test', 'result', 'flag', 'reference', 'unit', 'method'] as string[],
  columnWidths: {} as Record<string, number>, columnLabels: {} as Record<string, string>,
  logoHeight: 56, logoAlign: 'left', ageFormat: 'long', headerFields: [] as string[], headerColumns: 2,
  showMadeWith: false, showTestMethod: false, showMic: false, showMachineName: false, showDeptName: true, showPackageName: false,
  showB2bCode: false, showLabPhone: true, listPendingTests: false, boldOnly: false, reportDateOnly: false,
  trendGraph: false, trendSize: 'medium', allergyRows: false, imageHeight: 220,
  letterheads: [] as DocumentData[], defaultLetterheadId: '', signatoryMode: 'fixed', maxSignatures: 3, showStamp: true,
  publicOtp: 'optional', publicBillPin: true, hardCopyPrompt: true,
}
export type ReportLayout = typeof DEFAULT_LAYOUT
export const mergeLayout = (raw: unknown): ReportLayout => ({ ...DEFAULT_LAYOUT, ...((raw && typeof raw === 'object' ? raw : {}) as object) }) as ReportLayout

export interface ReportPayload {
  mode: 'report'
  lab: { name: string; address: string; phone: string; email: string; website: string; city: string; logoDataUrl: string; dateFormat: string }
  settings: { reportDetails: Record<string, unknown>; layout: ReportLayout; templateLayouts?: Record<string, Record<string, unknown>>; idDisplay: string; signatories: DocumentData[]; defaultSignatoryId: string }
  order: Record<string, unknown>
  results: DocumentData[]
  tests: DocumentData[]
  departments: { id: string; name: string; order: number }[]
}

const MAX_INLINE_IMAGE = 450_000
async function inlineImage(bucket: ReturnType<ReturnType<typeof getStorage>['bucket']> | null, im: DocumentData): Promise<DocumentData> {
  const base = { id: String(im.id ?? ''), name: String(im.name ?? ''), caption: String(im.caption ?? '') }
  if (typeof im.dataUrl === 'string' && im.dataUrl) return { ...base, dataUrl: im.dataUrl }
  if (typeof im.path === 'string' && im.path && bucket) {
    try {
      const [buf] = await bucket.file(im.path).download()
      if (buf.length <= MAX_INLINE_IMAGE * 4) return { ...base, dataUrl: `data:${im.contentType || 'image/jpeg'};base64,${buf.toString('base64')}` }
    } catch {
      /* image missing: the report still issues */
    }
  }
  return { ...base, dataUrl: '' }
}

export function bucketName(): string {
  try {
    const cfg = JSON.parse(process.env.FIREBASE_CONFIG ?? '{}') as { storageBucket?: string }
    if (cfg.storageBucket) return cfg.storageBucket
  } catch {
    /* fall through */
  }
  return process.env.STORAGE_BUCKET || `${process.env.GCLOUD_PROJECT || 'demo-health-care-labs'}.appspot.com`
}
export const getBucket = () => getStorage().bucket(bucketName())

const PRIORITY = (p: unknown) => (p === 'urgent' ? 'Urgent' : p ? 'Routine' : '')

// All patient-block field values that are plain strings (dates are rendered by the viewer from the ISO fields).
export function orderFields(order: DocumentData, patient: DocumentData, extra: { b2bCode?: string; branchName?: string } = {}): Record<string, string> {
  const s = (v: unknown) => (v === undefined || v === null ? '' : String(v))
  const full = [patient.firstName, patient.lastName].filter(Boolean).join(' ')
  return {
    phone: s(patient.phone), email: s(patient.email), address: [patient.address, patient.city, patient.pincode].filter(Boolean).join(', '),
    dob: s(patient.dob), altPhone: s(patient.altPhone), reportNo: s(order.billNoReport || order.billNo), uhid: s(order.uhid ?? patient.uhid),
    abhaNo: s(patient.abhaNo), idNumber: s(patient.idNumber), insuranceNo: s(patient.insuranceNo), fullName: full,
    secondReferrer: s(order.secondReferrerName), hospital: s(order.hospitalName), b2bCentre: s(order.b2bCentreName), b2bCode: s(extra.b2bCode),
    collectionCentre: s(order.collectionCentreName), corporate: s(order.corporateClientName), corporateUser: s(order.corporateUser ?? patient.corporateUser),
    corporatePlan: s(order.corporatePlan), govPanel: s(order.govPanelName), tpa: s(order.tpaName), priority: PRIORITY(order.priority),
    clinicalHistory: s(order.clinicalHistory ?? patient.clinicalHistory), weight: order.weight ?? patient.weight ? `${order.weight ?? patient.weight} kg` : '',
    height: order.height ?? patient.height ? `${order.height ?? patient.height} cm` : '', category: s(order.category ?? patient.category),
    source: s(order.source), collectionPlace: order.sampleCollectedAt === 'home' ? 'Home collection' : order.sampleCollectedAt === 'lab' ? 'At lab' : '',
    phlebotomist: s(order.phlebotomistName), species: s(patient.species), breed: s(patient.breed), owner: s(patient.ownerName ?? patient.owner),
    branch: s(extra.branchName), bookingId: s(order.bookingId), createdBy: s(order.createdByName), referrerId: s(order.referrerId),
  }
}

// Per-branch name / address / header / footer overrides laid over the lab settings (mirror of the web app's effectiveSettings).
export function effectiveSettings(settings: DocumentData, branchId?: unknown): DocumentData {
  const o = branchId ? (settings.branchOverrides as DocumentData | undefined)?.[String(branchId)] as DocumentData | undefined : undefined
  if (!o) return settings
  const clean = (x: unknown): DocumentData => Object.fromEntries(Object.entries((x ?? {}) as DocumentData).filter(([, v]) => v !== undefined && v !== ''))
  const txt = (v: unknown, fb: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : fb)
  return {
    ...settings,
    name: txt(o.name, settings.name), address: txt(o.address, settings.address), phone: txt(o.phone, settings.phone),
    profile: { ...(settings.profile as DocumentData), ...clean(o.profile) },
    reportDetails: { ...(settings.reportDetails as DocumentData), ...clean(o.reportDetails) },
    billDetails: { ...(settings.billDetails as DocumentData), ...clean(o.billDetails) },
  }
}

export interface BuildArgs {
  db: Firestore
  labId: string
  orderId: string
  order: DocumentData
  settings: DocumentData // loaded lab settings (index.ts Settings)
  withImages?: boolean
}

// Freezes everything a viewer needs to render the report. Approved results only.
export async function buildReportPayload(a: BuildArgs): Promise<ReportPayload> {
  const { db, labId, orderId, order } = a
  const settings = effectiveSettings(a.settings, order.branchId)
  const patient = order.patientId ? (await db.doc(`labs/${labId}/patients/${order.patientId}`).get()).data() ?? {} : {}
  const testIds = new Set<string>()
  for (const item of (order.items ?? []) as DocumentData[]) {
    if (item.status === 'refunded') continue
    for (const t of item.testIds ?? []) testIds.add(t)
  }
  const [resSnaps, deptSnaps, sampleSnaps, templateSnaps] = await Promise.all([
    db.collection(`labs/${labId}/orders/${orderId}/results`).get(),
    db.collection(`labs/${labId}/departments`).get(),
    db.collection(`labs/${labId}/sampleTypes`).get(),
    db.collection(`labs/${labId}/reportTemplates`).get(),
  ])
  const testSnaps = await Promise.all([...testIds].map((id) => db.doc(`labs/${labId}/tests/${id}`).get()))
  const b2b = order.b2bCentreId ? (await db.doc(`labs/${labId}/b2bCentres/${order.b2bCentreId}`).get()).data() : undefined
  const branch = order.branchId ? (await db.doc(`labs/${labId}/branches/${order.branchId}`).get()).data() : undefined
  const bucket = a.withImages === false ? null : (() => { try { return getBucket() } catch { return null } })()

  const approved = resSnaps.docs.map((d) => ({ id: d.id, ...d.data() }) as DocumentData & { id: string }).filter((r) => r.status === 'approved')
  const results: DocumentData[] = []
  for (const r of approved) {
    const rad = r.radiology as DocumentData | undefined
    let radiology: DocumentData | null = null
    if (rad) {
      const images = await Promise.all(((rad.images ?? []) as DocumentData[]).slice(0, 6).map((im) => inlineImage(bucket, im)))
      radiology = {
        technique: rad.technique ?? '', findings: rad.findings ?? '', impression: rad.impression ?? '', images: images.filter((i) => i.dataUrl),
        modality: rad.modality ?? '', bodyPart: rad.bodyPart ?? '', contrastNote: rad.contrastNote ?? '',
        secondOpinion: rad.secondOpinion?.status === 'given' || rad.secondOpinion?.status === 'cosigned'
          ? { doctorName: rad.secondOpinion.doctorName, opinion: rad.secondOpinion.opinion, external: !!rad.secondOpinion.external, cosignedBy: rad.secondOpinion.cosignedByName ?? '' }
          : null,
      }
    }
    results.push({
      testId: r.testId ?? r.id, testName: r.testName ?? '', status: 'approved', values: r.values ?? {}, comment: r.comment ?? '',
      paramComments: r.paramComments ?? {}, showInterpretation: r.showInterpretation, approvedByName: r.approvedByName ?? '',
      signatoryId: r.signatoryId ?? '', signatorySnapshot: r.signatorySnapshot ?? null, signatureSnapshots: r.signatureSnapshots ?? [],
      commentOnReport: r.commentOnReport !== false, paramCommentHidden: r.paramCommentHidden ?? {}, machineName: r.machineName ?? '', radiology,
      updatedAt: iso(r.updatedAt),
    })
  }
  const sampleName = new Map(sampleSnaps.docs.map((d) => [d.id, String(d.data().name ?? '')]))
  const deptTemplate = new Map(deptSnaps.docs.map((d) => [d.id, String(d.data().reportTemplateId ?? '')]))
  const templateLayouts: Record<string, Record<string, unknown>> = {}
  for (const d of templateSnaps.docs) if (d.data().layout && typeof d.data().layout === 'object') templateLayouts[d.id] = d.data().layout as Record<string, unknown>
  const tests = testSnaps.filter((s) => s.exists).map((s) => {
    const t = s.data() as DocumentData
    return {
      id: s.id, name: t.name ?? '', departmentId: t.departmentId ?? '', order: t.order ?? 0, interpretation: t.interpretationHtml ? safeRich(t.interpretationHtml) : t.interpretation ?? '',
      templateId: String(t.reportTemplateId || deptTemplate.get(String(t.departmentId ?? '')) || ''),
      parameters: t.parameters ?? [], startOnNewPage: t.startOnNewPage === true, startNextPage: t.startNextPage === true,
      interpretationEnabled: t.interpretationEnabled, comments: t.comments ?? '', sampleTypeName: sampleName.get(t.sampleTypeId) ?? '',
      translations: t.translations ?? {},
    }
  })
  const departments = deptSnaps.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? ''), order: Number(d.data().order ?? 0) }))
  const approvedIds = new Set(results.map((r) => r.testId))
  const pending = tests.filter((t) => !approvedIds.has(t.id)).map((t) => String(t.name))
  const packages = ((order.items ?? []) as DocumentData[]).filter((i) => i.kind === 'package' && i.status !== 'refunded').map((i) => String(i.name ?? ''))
  const layout = mergeLayout(settings.reportLayout)
  const p = settings.profile as DocumentData
  return {
    mode: 'report',
    lab: { name: settings.name, address: settings.address, phone: settings.phone, email: settings.email, website: p.website ?? '', city: p.city ?? '', logoDataUrl: p.logoDataUrl ?? '', dateFormat: p.dateFormat ?? '' },
    settings: {
      reportDetails: settings.reportDetails as Record<string, unknown>,
      layout,
      idDisplay: (settings.registration as DocumentData).idDisplay,
      signatories: ((settings.signatories ?? []) as DocumentData[]).filter((s) => s.active !== false),
      defaultSignatoryId: (settings.reportEntry as DocumentData).defaultSignatoryId,
      templateLayouts,
    },
    order: {
      billNo: order.billNo ?? '', patientName: order.patientName ?? '', patientNo: order.patientNo ?? '', uhid: order.uhid ?? patient.uhid ?? '',
      phone: patient.phone ?? '', address: patient.address ?? '', gender: order.gender ?? '', ageValue: order.ageValue ?? 0, ageUnit: order.ageUnit ?? 'year',
      referrerName: order.referrerName ?? '', barcode: order.barcode ?? '', createdAt: iso(order.createdAt), billDate: iso(order.billDate), collectedAt: iso(order.collectedAt),
      receivedAt: iso(order.receivedAt), reportedAt: iso(order.firstApprovedAt) ?? iso(order.reportedAt), reportDateOverride: iso(order.reportDateOverride),
      reportStatus: order.reportStatus ?? 'pending', reportSignatoryId: order.reportSignatoryId ?? '', reportNote: order.reportNote ?? '',
      reportRevision: order.reportRevision ?? 0, amendSummary: order.amendSummary ?? '',
      ageDays: ageDaysAtCollection(order, patient.dob), condition: order.patientCondition ?? '',
      fields: orderFields(order, patient, { b2bCode: b2b?.code, branchName: branch?.name }), pending, packages,
      formFStatus: order.formFStatus ?? '', disableLetterhead: order.disableLetterhead === true,
    },
    results, tests, departments,
  }
}

// ---- Print-ready HTML copy ----------------------------------------------------------------------------

const AGE_UNIT: Record<string, string> = { year: 'Y', month: 'M', day: 'D' }
const fmt = (isoStr: unknown, withTime = true) => {
  const t = typeof isoStr === 'string' && isoStr ? Date.parse(isoStr) : NaN
  return Number.isNaN(t)
    ? ''
    : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}), timeZone: 'Asia/Kolkata' }).format(new Date(t))
}

export interface Range { low: number | null; high: number | null; text: string }
export function rangeFor(p: DocumentData, ageDays: number, gender: string, condition = '', override?: DocumentData, value?: DocumentData): Range {
  // The range written when the value was entered is what prints (unless it was edited since).
  if (!override && value?.rangeSnapshot && typeof value.rangeSnapshot === 'object') {
    const s = value.rangeSnapshot as DocumentData
    return { low: s.low ?? null, high: s.high ?? null, text: String(s.text ?? '') }
  }
  const ranges = (p.ranges ?? []) as DocumentData[]
  const sexOf = (r: DocumentData) => r.gender ?? 'any'
  const fits = ranges.filter((r) => ageDays >= r.fromDays && ageDays < r.toDays && (!r.condition || (!!condition && r.condition === condition)) && (sexOf(r) === 'any' || sexOf(r) === gender))
  // Condition match, then sex match, then the narrowest age window.
  const score = (r: DocumentData) => (r.condition ? 2 : 0) + (sexOf(r) !== 'any' ? 1 : 0)
  const band = [...fits].sort((x, y) => score(y) - score(x) || (x.toDays - x.fromDays) - (y.toDays - y.fromDays))[0]
  const low = override ? override.low ?? null : band ? band.low ?? null : p.low ?? null
  const high = override ? override.high ?? null : band ? band.high ?? null : p.high ?? null
  if (override?.text) return { low, high, text: String(override.text) }
  const text = band?.displayText || p.displayRange || (low !== null && high !== null ? `${low} - ${high}` : low !== null ? `> ${low}` : high !== null ? `< ${high}` : '')
  return { low, high, text }
}
export const ageDaysOf = (v: number, unit: string) => (unit === 'year' ? Math.round((v ?? 0) * 365.25) : unit === 'month' ? Math.round((v ?? 0) * 30.4375) : v ?? 0)

export function flagOf(v: DocumentData | undefined): string {
  if (!v) return ''
  if (v.critical && v.criticalDir) return v.criticalDir === 'low' ? 'LL' : 'HH'
  return v.critical ? 'Critical' : v.abnormal === 'low' ? 'L' : v.abnormal === 'high' ? 'H' : v.abnormal ? 'Abn' : ''
}

// Age in days on the collection day (exact with a date of birth), as the web app works it out.
export function ageDaysAtCollection(order: DocumentData, dob?: string): number {
  const bill = ms(order.billDate) ?? ms(order.createdAt) ?? Date.now()
  const at = ms(order.collectedAt) ?? bill
  if (dob) {
    const b = new Date(dob).getTime()
    if (Number.isFinite(b) && b <= at) return Math.floor((at - b) / 86_400_000)
  }
  return ageDaysOf(Number(order.ageValue ?? 0), String(order.ageUnit ?? 'year')) + Math.max(0, Math.floor((at - bill) / 86_400_000))
}

export function buildReportHtml(pl: ReportPayload, snap: { revision: number; generatedAt: number }): string {
  const o = pl.order
  const ageDays = Number(o.ageDays ?? ageDaysOf(Number(o.ageValue), String(o.ageUnit)))
  const testById = new Map(pl.tests.map((t) => [String(t.id), t]))
  const deptById = new Map(pl.departments.map((d) => [d.id, d]))
  const ordered = [...pl.results].sort((a, b) => {
    const ta = testById.get(a.testId)
    const tb = testById.get(b.testId)
    return (deptById.get(ta?.departmentId)?.order ?? 0) - (deptById.get(tb?.departmentId)?.order ?? 0) || (ta?.order ?? 0) - (tb?.order ?? 0)
  })
  const sections = ordered
    .map((r) => {
      const t = testById.get(r.testId) ?? {}
      const dept = deptById.get(t.departmentId)?.name ?? ''
      let body = ''
      if (r.radiology) {
        const rad = r.radiology as DocumentData
        body = `<div class="rad">${rad.technique ? `<h4>Technique</h4>${safeRich(rad.technique)}` : ''}${rad.findings ? `<h4>Findings</h4>${safeRich(rad.findings)}` : ''}${rad.impression ? `<h4>Impression</h4>${safeRich(rad.impression)}` : ''}${(rad.images ?? []).map((im: DocumentData) => `<img src="${esc(im.dataUrl)}" alt="${esc(im.caption)}" style="max-width:48%;max-height:240px;margin:4px">`).join('')}</div>`
      } else {
        const params = ((t.parameters ?? []) as DocumentData[]).filter((p) => !p.hideOnReport)
        const rows = params
          .map((p) => {
            if (p.structure === 'group') return `<tr class="grp"><td colspan="4">${esc(p.name)}</td></tr>`
            const v = (r.values ?? {})[p.key] as DocumentData | undefined
            if (!v || String(v.value ?? '').trim() === '') return ''
            const rg = rangeFor(p, ageDays, String(o.gender ?? ''), String(o.condition ?? ''), v?.rangeOverride, v)
            const flag = flagOf(v)
            const val = p.dataType === 'richText' ? safeRich(v.value) : p.dataType === 'image' || p.dataType === 'pdf' ? '(attachment)' : esc(v.value)
            return `<tr class="${flag ? 'abn' : ''}"><td>${esc(p.name)}</td><td class="v">${val} <b>${esc(flag)}</b></td><td>${esc(p.unit)}</td><td>${esc(rg.text)}</td></tr>`
          })
          .join('')
        body = `<table><thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead><tbody>${rows}</tbody></table>`
        if (r.comment && r.commentOnReport !== false) body += `<p class="note"><b>Comment:</b> ${esc(r.comment)}</p>`
        if (t.interpretation && r.showInterpretation !== false && t.interpretationEnabled !== false) body += `<div class="interp"><b>Interpretation</b>${safeRich(t.interpretation)}</div>`
      }
      const sig = r.signatorySnapshot as DocumentData | null | undefined
      const sigHtml = sig ? `<p class="sig"><b>${esc(sig.name)}</b>${sig.qualification ? `<br>${esc(sig.qualification)}` : ''}${sig.registrationNo ? `<br>Reg. ${esc(sig.registrationNo)}` : ''}</p>` : ''
      return `<section${t.startOnNewPage ? ' class="np"' : ''}><h3>${esc(r.testName ?? t.name ?? '')}${dept ? ` <small>${esc(dept)}</small>` : ''}</h3>${body}${sigHtml}</section>`
    })
    .join('')
  const banner = o.reportStatus === 'provisional' ? '<div class="prov">PROVISIONAL REPORT</div>' : ''
  const amended = snap.revision > 0 ? `<div class="prov">AMENDED REPORT (revision ${snap.revision})</div>` : ''
  const lab = pl.lab
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report ${esc(o.billNo)}</title>
<style>@page{size:A4;margin:14mm}body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:0}
header{border-bottom:2px solid #333;padding-bottom:6px;margin-bottom:8px}header h1{margin:0;font-size:20px}header p{margin:2px 0;color:#444}
.pt{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;margin:8px 0;padding:6px 0;border-bottom:1px solid #999}
table{width:100%;border-collapse:collapse;margin:6px 0}th,td{text-align:left;padding:3px 4px;border-bottom:1px solid #ddd;vertical-align:top}th{background:#f3f3f3}
tr.abn td.v{font-weight:700}tr.grp td{font-weight:700;background:#fafafa}h3{margin:14px 0 4px;font-size:14px}h3 small{color:#666;font-weight:400}
h4{margin:8px 0 2px}.np{break-before:page}.sig{margin-top:12px}.prov{border:2px solid #b45309;color:#b45309;text-align:center;font-weight:700;padding:3px;margin:6px 0}
footer{margin-top:18px;border-top:1px solid #999;padding-top:4px;color:#555;font-size:10px}</style></head><body>
<header><h1>${esc(lab.name)}</h1><p>${esc(lab.address)}</p><p>${[lab.phone, lab.email].filter(Boolean).map(esc).join(' | ')}</p></header>
${banner}${amended}
<div class="pt"><div><b>Name:</b> ${esc(o.patientName)}</div><div><b>Bill no:</b> ${esc(o.billNo)}</div>
<div><b>Age / Gender:</b> ${esc(o.ageValue)}${AGE_UNIT[String(o.ageUnit)] ?? ''} / ${esc(o.gender)}</div><div><b>Patient ID:</b> ${esc(o.patientNo)}</div>
<div><b>Referred by:</b> ${esc(o.referrerName)}</div><div><b>Registered:</b> ${esc(fmt(o.createdAt))}</div>
<div><b>Collected:</b> ${esc(fmt(o.collectedAt))}</div><div><b>Reported:</b> ${esc(fmt(o.reportedAt))}</div></div>
${sections || '<p>No approved results.</p>'}
<footer>Report revision ${snap.revision}. Generated ${esc(fmt(new Date(snap.generatedAt).toISOString()))}. This is a computer-generated snapshot of the approved results.</footer></body></html>`
}

export type { Timestamp }
export { ms }
