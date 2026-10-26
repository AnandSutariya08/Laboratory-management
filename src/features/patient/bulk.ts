import { deleteField, getDocs, serverTimestamp, updateDoc } from 'firebase/firestore'
import dayjs from 'dayjs'
import { docRef, ledgerCol, paths, resultsCol } from '../../lib/db'
import { downloadXls } from '../../lib/sheet'
import type { LedgerEntry } from '../../types'
import { downloadCsv, tsDate } from '../../components/billing/helpers'
import { formatINR } from '../../lib/money'
import type { LabSettings, Test, TestResult } from '../../types'
import { COLUMN_LABEL, expectedTatMinutes, tatText, type ColumnKey } from './lib'
import { esc, labHeader, printHtml, tableHtml } from './print'
import type { PatientOrder } from './types'

export interface CellCtx {
  userName: (uid: string) => string
  branchName: (id: string) => string
  urgentTatPercent?: number
}

export function cellText(o: PatientOrder, k: ColumnKey, c: CellCtx): string {
  const d = tsDate(o.createdAt)
  switch (k) {
    case 'date': return d ? dayjs(d).format('DD MMM YYYY HH:mm') : ''
    case 'billNo': return o.billNo
    case 'patient': return `${o.patientName} (${o.ageValue}${o.ageUnit[0].toUpperCase()}/${o.gender[0].toUpperCase()}) ${o.patientNo}`
    case 'uhid': return o.uhid ?? ''
    case 'referral': return o.referrerName
    case 'tests': return o.items.map((i) => `${i.name} [${i.status}]`).join('; ')
    case 'amount': return `${formatINR(o.net)}${o.due > 0 ? ` (due ${formatINR(o.due)})` : ''}`
    case 'status': return `${o.reportStatus}${o.dispatched ? ', dispatched' : ''}${o.printed ? ', printed' : ''}`
    case 'barcode': return o.barcode
    case 'createdBy': return o.createdByName || c.userName(o.createdBy)
    case 'branch': return c.branchName(o.branchId || 'main')
    case 'b2b': return o.b2bCentreName || o.corporateClientName || ''
    case 'collectionCentre': return o.collectionCentreName ?? ''
    case 'tat': return tatText(expectedTatMinutes(o, c.urgentTatPercent))
  }
}

export function exportCsv(orders: PatientOrder[], cols: ColumnKey[], c: CellCtx) {
  downloadCsv(`patient-list-${dayjs().format('YYYYMMDD-HHmm')}.csv`, [
    cols.map((k) => COLUMN_LABEL[k]),
    ...orders.map((o) => cols.map((k) => cellText(o, k, c))),
  ])
}

export function exportPdf(orders: PatientOrder[], cols: ColumnKey[], c: CellCtx, s: LabSettings) {
  return printHtml(
    'Patient list',
    labHeader(s, `Patient list (${orders.length})`) + tableHtml(cols.map((k) => COLUMN_LABEL[k]), orders.map((o) => cols.map((k) => cellText(o, k, c)))),
    'body{font-size:10px}',
  )
}

// Payment breakdown by mode per bill (payments and due clearances less reversals; refunds apart).
const PAY_BUCKETS = ['cash', 'upi', 'card', 'wallet'] as const
async function paymentBreakdown(orders: PatientOrder[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>()
  const queue = [...orders]
  const worker = async () => {
    for (let o = queue.shift(); o; o = queue.shift()) {
      const by: Record<string, number> = { cash: 0, upi: 0, card: 0, wallet: 0, other: 0, refunded: 0 }
      try {
        const snap = await getDocs(ledgerCol(o.id))
        for (const d of snap.docs) {
          const e = d.data() as LedgerEntry
          if (e.type === 'refund') by.refunded += -e.amount
          else by[(PAY_BUCKETS as readonly string[]).includes(e.mode) ? e.mode : 'other'] += e.amount
        }
      } catch { /* keep zeros */ }
      out.set(o.id, by)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  return out
}

// Export with the payment breakdown by mode appended. xls = SpreadsheetML (opens in Excel).
export async function exportWithPayments(orders: PatientOrder[], cols: ColumnKey[], c: CellCtx, format: 'csv' | 'xls') {
  const pay = await paymentBreakdown(orders)
  const head = [...cols.map((k) => COLUMN_LABEL[k]), 'Gross', 'Discount', 'Net', 'Paid (cash)', 'Paid (UPI)', 'Paid (card)', 'Paid (wallet)', 'Paid (other)', 'Refunded', 'Due']
  const body = orders.map((o) => {
    const p = pay.get(o.id) ?? {}
    const r = (n: number) => Math.round(n) / 100
    return [...cols.map((k) => cellText(o, k, c)), r(o.gross), r(o.discount), r(o.net), r(p.cash ?? 0), r(p.upi ?? 0), r(p.card ?? 0), r(p.wallet ?? 0), r(p.other ?? 0), r(p.refunded ?? 0), r(o.due)]
  })
  const name = `patient-list-${dayjs().format('YYYYMMDD-HHmm')}`
  if (format === 'xls') downloadXls(name, [head, ...body], 'Patient list')
  else downloadCsv(`${name}.csv`, [head, ...body])
}

// Bulk flags from the Patient List.
export async function markPcpndt(orders: PatientOrder[], on: boolean) {
  for (const o of orders) await updateDoc(docRef(paths.orders, o.id), { pcpndt: on })
}
export async function markGovPanel(orders: PatientOrder[], panel: { id: string; name: string } | null) {
  for (const o of orders) {
    await updateDoc(docRef(paths.orders, o.id), panel ? { govPanelId: panel.id, govPanelName: panel.name } : { govPanelId: deleteField(), govPanelName: deleteField() })
  }
}

async function loadResults(orders: PatientOrder[]) {
  const out: { o: PatientOrder; r: TestResult }[] = []
  for (const o of orders) {
    const s = await getDocs(resultsCol(o.id))
    s.docs.forEach((d) => out.push({ o, r: d.data() as TestResult }))
  }
  return out
}

function paramName(t: Test | undefined, key: string) {
  const p = t?.parameters.find((x) => x.key === key)
  return { name: p?.name ?? key, unit: p?.unit ?? '' }
}

export async function bulkResultsCsv(orders: PatientOrder[], testById: Map<string, Test>) {
  const rows: (string | number)[][] = [['Bill', 'Patient', 'Test', 'Parameter', 'Value', 'Unit', 'Flag', 'Status']]
  for (const { o, r } of await loadResults(orders)) {
    for (const [k, v] of Object.entries(r.values ?? {})) {
      const p = paramName(testById.get(r.testId), k)
      rows.push([o.billNo, o.patientName, r.testName, p.name, v.value, p.unit, v.abnormal ?? '', r.status])
    }
  }
  downloadCsv(`results-${dayjs().format('YYYYMMDD-HHmm')}.csv`, rows)
}

// One sheet per patient with every selected bill's results side by side.
export async function consolidatedReport(orders: PatientOrder[], testById: Map<string, Test>, s: LabSettings) {
  const all = await loadResults(orders)
  const byPatient = new Map<string, typeof all>()
  all.forEach((x) => byPatient.set(x.o.patientId, [...(byPatient.get(x.o.patientId) ?? []), x]))
  const sections = [...byPatient.values()].map((list) => {
    const o0 = list[0].o
    const bills = [...new Map(list.map((x) => [x.o.id, x.o])).values()].sort((a, b) => (tsDate(a.createdAt)?.getTime() ?? 0) - (tsDate(b.createdAt)?.getTime() ?? 0))
    const params = new Map<string, string>()
    list.forEach(({ r }) => Object.keys(r.values ?? {}).forEach((k) => params.set(`${r.testName}|${k}`, `${r.testName}: ${paramName(testById.get(r.testId), k).name}`)))
    const rows = [...params.entries()].map(([id, label]) => [
      label,
      ...bills.map((b) => {
        const [tn, pk] = id.split('|')
        const hit = list.find((x) => x.o.id === b.id && x.r.testName === tn)
        const v = hit?.r.values?.[pk]
        return v ? `${v.value}${v.abnormal ? (v.abnormal === 'high' ? ' (H)' : ' (L)') : ''}` : ''
      }),
    ])
    return `<h2>${esc(o0.patientName)} <span class="muted">${esc(o0.patientNo)}</span></h2>` + tableHtml(['Parameter', ...bills.map((b) => `${b.billNo} ${dayjs(tsDate(b.createdAt)).format('DD MMM YY')}`)], rows)
  })
  return printHtml('Consolidated report', labHeader(s, 'Consolidated report') + (sections.join('') || '<p>No results entered yet.</p>'))
}

export async function markPrinted(orders: PatientOrder[], uid: string) {
  for (const o of orders) await updateDoc(docRef(paths.orders, o.id), { printed: true, printedAt: serverTimestamp(), printedBy: uid })
}

// Stamps the delivery time on bills whose hard copy was just marked delivered (the hand-over itself goes through useMarkDispatchedMany).
export async function stampHardCopyDelivered(orders: PatientOrder[]) {
  for (const o of orders) await updateDoc(docRef(paths.orders, o.id), { hardCopyDeliveredAt: serverTimestamp() })
}
