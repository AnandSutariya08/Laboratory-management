import { commissionForOrder, type CommissionReferrer } from '../../../features/partners/lib/commission'
import { LEDGER_TYPE_LABEL } from '../../../lib/billing'
import { outsourceForLine } from '../../../features/outsource/lib'
import type { LedgerEntry, OrderItem, Patient, Test, TestResult, LabSettings } from '../../../types'
import { collectedOf, isMoneyIn, lineNet, modeBucket, rupees, tsDay, tsFull, tsMs, type MasterDoc, type ModeBucket, type OrderExt } from '../shared'

export type BaseTab = 'billing' | 'collection' | 'test' | 'outsource'
export const BASE_LABEL: Record<BaseTab, string> = { billing: 'Billing wise', collection: 'Collection wise', test: 'Test wise', outsource: 'Outsource wise' }

export interface Ctx {
  orders: OrderExt[]
  ledgers: Record<string, LedgerEntry[]>
  results: Record<string, TestResult[]>
  patients: Record<string, Patient | null>
  testById: Map<string, Test>
  deptName: (testId: string) => string
  userName: (uid: string) => string
  referrers: MasterDoc[]
  settings: LabSettings
}

export interface FRow {
  key: string
  o: OrderExt
  item?: OrderItem
  testId?: string
  test?: Test
  entry?: LedgerEntry
  frac: number // share of the bill this row carries (1 for bill rows)
  grp?: Record<string, string | number> // grouped rows (custom tab group-by): the aggregated value of each column
}

// Outsource info may live on the catalogue test or on the bill line (owned by the outsource module).
type OutExt = { outsourceLabName?: string; outsourceLabId?: string; outsourcePrice?: number; outsource?: { labName?: string; labId?: string; price?: number } }
export const outsourceOf = (r: FRow, labs: MasterDoc[]) => {
  // The bill's own stamp (lab and cost frozen at billing) wins over the live catalogue mapping.
  if (r.item && r.testId) {
    const o = outsourceForLine(r.item, r.testId)
    if (o) return { name: o.labName || labs.find((l) => l.id === o.labId)?.name || '', price: o.cost }
  }
  const src = { ...(r.test as unknown as OutExt), ...(r.item as unknown as OutExt) }
  const labId = src.outsourceLabId ?? src.outsource?.labId
  const name = src.outsourceLabName ?? src.outsource?.labName ?? (labId ? labs.find((l) => l.id === labId)?.name : '') ?? ''
  const price = src.outsourcePrice ?? src.outsource?.price
  return name || labId ? { name: name ?? '', price: price ?? 0 } : null
}

// Share of a bill line carried by one member test: by the member's catalogue price, equal split when prices are missing.
export function memberShare(i: OrderItem, tid: string, testById: Map<string, Test>): number {
  const n = i.testIds.length
  if (n <= 1) return 1
  const prices = i.testIds.map((id) => testById.get(id)?.price ?? 0)
  const total = prices.reduce((a, b) => a + b, 0)
  if (total <= 0) return 1 / n
  return (testById.get(tid)?.price ?? 0) / total
}

export function buildRows(base: BaseTab, ctx: Ctx, labs: MasterDoc[]): FRow[] {
  const out: FRow[] = []
  for (const o of ctx.orders) {
    if (base === 'billing') out.push({ key: o.id, o, frac: 1 })
    else if (base === 'collection') {
      for (const e of ctx.ledgers[o.id] ?? []) out.push({ key: `${o.id}:${e.id}`, o, entry: e, frac: 1 })
    } else {
      for (const i of o.items) {
        if (i.status === 'refunded') continue
        for (const tid of i.testIds) {
          const r: FRow = { key: `${o.id}:${i.lineId}:${tid}`, o, item: i, testId: tid, test: ctx.testById.get(tid), frac: o.net > 0 && i.testIds.length ? (lineNet(i) / o.net) * memberShare(i, tid, ctx.testById) : 0 }
          if (base === 'outsource' && !outsourceOf(r, labs)) continue
          out.push(r)
        }
      }
    }
  }
  return out
}

export function commissionOf(o: OrderExt, ctx: Ctx): number {
  return commissionForOrder(o, ctx.referrers as unknown as CommissionReferrer[], ctx.settings.referrals.commissionBasis)
}

export const payStatus = (o: OrderExt) => (o.due <= 0 ? 'Paid' : collectedOf(o) - o.refunded > 0 ? 'Partial' : 'Due')

const modeSum = (r: FRow, ctx: Ctx, b: ModeBucket) => {
  if (r.entry) return modeBucket(r.entry.mode) === b && isMoneyIn(r.entry) ? r.entry.amount : 0
  return (ctx.ledgers[r.o.id] ?? []).filter((e) => isMoneyIn(e) && modeBucket(e.mode) === b).reduce((s, e) => s + e.amount, 0) * r.frac
}

export interface ColDef {
  key: string
  title: string
  money?: boolean // paise, summed in the totals row
  needs?: 'patient' | 'results'
  get: (r: FRow, c: Ctx) => string | number
}

const pat = (r: FRow, c: Ctx) => c.patients[r.o.patientId]
const resFor = (r: FRow, c: Ctx) => (c.results[r.o.id] ?? []).find((x) => x.testId === r.testId)
const age = (r: FRow) => `${r.o.ageValue}${{ year: 'Y', month: 'M', day: 'D' }[r.o.ageUnit]}`
const share = (r: FRow, v: number, direct?: number) => (r.testId ? (direct ?? v * r.frac) : v)

export const COLUMNS: ColDef[] = [
  { key: 'billDate', title: 'Bill date', get: (r) => tsDay(r.o.createdAt) },
  { key: 'createdAt', title: 'Created at', get: (r) => tsFull(r.o.createdAt) },
  { key: 'collectionDate', title: 'Collection date', get: (r) => tsFull(r.entry?.postedAt ?? r.o.collectedAt) },
  { key: 'billId', title: 'Bill ID', get: (r) => r.o.billNo },
  { key: 'patientId', title: 'Patient ID', get: (r) => r.o.patientNo },
  { key: 'uhid', title: 'UHID', needs: 'patient', get: (r, c) => ((pat(r, c) as unknown as { uhid?: string })?.uhid ?? r.o.patientNo) },
  { key: 'patientInfo', title: 'Patient info', get: (r) => `${r.o.patientName} (${age(r)}/${r.o.gender[0].toUpperCase()})` },
  { key: 'patientName', title: 'Patient name', get: (r) => r.o.patientName },
  { key: 'age', title: 'Age', get: (r) => age(r) },
  { key: 'gender', title: 'Gender', get: (r) => r.o.gender },
  { key: 'contact', title: 'Contact', needs: 'patient', get: (r, c) => pat(r, c)?.phone ?? '' },
  { key: 'email', title: 'Email', needs: 'patient', get: (r, c) => pat(r, c)?.email ?? '' },
  { key: 'tests', title: 'Tests / packages', get: (r) => (r.test ? r.test.name : r.o.items.filter((i) => i.status !== 'refunded').map((i) => i.name).join(', ')) },
  { key: 'testName', title: 'Test', get: (r) => r.test?.name ?? r.item?.name ?? '' },
  { key: 'department', title: 'Department', get: (r, c) => (r.testId ? c.deptName(r.testId) : '') },
  { key: 'referral', title: 'Referral doctor', get: (r) => r.o.referrerName },
  { key: 'hospitalName', title: 'Referral hospital', get: (r) => r.o.hospitalName ?? '' },
  { key: 'secondReferral', title: 'Second referral', get: (r) => r.o.secondReferral ?? '' },
  { key: 'pro', title: 'PRO', get: (r) => r.o.proName ?? '' },
  { key: 'tpa', title: 'TPA', get: (r) => r.o.tpaName ?? '' },
  { key: 'b2b', title: 'B2B centre', get: (r) => r.o.b2bCentreName ?? '' },
  { key: 'corporate', title: 'Corporate client', get: (r) => r.o.corporateClientName ?? '' },
  { key: 'corporatePlan', title: 'Corporate plan', get: (r) => r.o.corporatePlan ?? '' },
  { key: 'govPanel', title: 'Government panel', get: (r) => r.o.govPanelName ?? '' },
  { key: 'collectionCentre', title: 'Collection centre', get: (r) => r.o.collectionCentreName ?? '' },
  { key: 'rateList', title: 'Rate list', get: (r) => r.o.rateListName ?? '' },
  { key: 'amount', title: 'Amount', money: true, get: (r, c) => (r.item && r.testId ? r.item.price * memberShare(r.item, r.testId, c.testById) : r.o.gross) },
  { key: 'discount', title: 'Discount', money: true, get: (r, c) => (r.item && r.testId ? r.item.discount * memberShare(r.item, r.testId, c.testById) : r.o.discount) },
  { key: 'net', title: 'Net amount', money: true, get: (r, c) => (r.item && r.testId ? lineNet(r.item) * memberShare(r.item, r.testId, c.testById) : r.o.net) },
  { key: 'paid', title: 'Paid', money: true, get: (r) => (r.entry ? r.entry.amount : share(r, collectedOf(r.o) - r.o.refunded)) },
  { key: 'due', title: 'Due', money: true, get: (r) => (r.entry ? r.o.due : share(r, r.o.due)) },
  { key: 'refunded', title: 'Refunded', money: true, get: (r) => share(r, r.o.refunded) },
  { key: 'cash', title: 'Cash', money: true, get: (r, c) => modeSum(r, c, 'cash') },
  { key: 'card', title: 'Card', money: true, get: (r, c) => modeSum(r, c, 'card') },
  { key: 'upi', title: 'UPI', money: true, get: (r, c) => modeSum(r, c, 'upi') },
  { key: 'wallet', title: 'Wallet', money: true, get: (r, c) => modeSum(r, c, 'wallet') },
  { key: 'otherMode', title: 'Other mode', money: true, get: (r, c) => modeSum(r, c, 'other') },
  { key: 'transactionId', title: 'Transaction ID', get: (r, c) => r.entry?.reference ?? (c.ledgers[r.o.id] ?? []).map((e) => e.reference).filter(Boolean).join(', ') },
  { key: 'entryType', title: 'Entry type', get: (r) => (r.entry ? LEDGER_TYPE_LABEL[r.entry.type] : '') },
  { key: 'collectedBy', title: 'Collected by', get: (r, c) => (r.entry ? c.userName(r.entry.postedBy) : (r.o.collectedByName ?? '')) },
  { key: 'paymentStatus', title: 'Payment status', get: (r) => payStatus(r.o) },
  { key: 'commission', title: 'Referral commission', money: true, get: (r, c) => share(r, commissionOf(r.o, c)) },
  { key: 'discountBy', title: 'Discount by', get: (r) => r.o.discountedBy },
  { key: 'discountReason', title: 'Discount reason', get: (r) => r.o.discountReason },
  { key: 'billedBy', title: 'Billed by', get: (r, c) => c.userName(r.o.createdBy) },
  { key: 'collectedAt', title: 'Collected at', get: (r) => tsFull(r.o.collectedAt) },
  { key: 'receivedAt', title: 'Received at', get: (r) => tsFull(r.o.receivedAt) },
  { key: 'reportedAt', title: 'Reported at', get: (r) => tsFull(r.o.reportedAt) },
  { key: 'level1', title: 'Level 1 approval', needs: 'results', get: (r, c) => { const x = resFor(r, c); return x?.enteredBy ? c.userName(x.enteredBy) : '' } },
  { key: 'level2', title: 'Level 2 approval', needs: 'results', get: (r, c) => { const x = resFor(r, c); return x?.status === 'approved' ? (x.approvedByName || c.userName(x.approvedBy)) : '' } },
  { key: 'areaManager', title: 'Area manager', get: (r) => r.o.areaManager ?? '' },
  { key: 'districtManager', title: 'District manager', get: (r) => r.o.districtManager ?? '' },
  { key: 'stateManager', title: 'State manager', get: (r) => r.o.stateManager ?? '' },
  { key: 'zoneHead', title: 'Zone head', get: (r) => r.o.zoneHead ?? '' },
  { key: 'cmo', title: 'CMO', get: (r) => r.o.cmo ?? '' },
]
export const COL_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]))

// Outsource columns need the lab master, so they are added by the table with a context closure.
export const outsourceCols = (labs: MasterDoc[]): ColDef[] => [
  { key: 'toLab', title: 'Lab name', get: (r) => outsourceOf(r, labs)?.name ?? '' },
  { key: 'mrp', title: 'MRP', money: true, get: (r) => (r.item && r.testId ? r.item.price * memberShare(r.item, r.testId, new Map()) : 0) },
  { key: 'outsourcePrice', title: 'Outsource lab price', money: true, get: (r) => outsourceOf(r, labs)?.price ?? 0 },
]

export const PRESETS: Record<BaseTab, string[]> = {
  billing: ['patientId', 'billDate', 'billId', 'patientInfo', 'tests', 'referral', 'amount', 'discount', 'paid', 'due', 'net', 'contact', 'commission'],
  collection: ['collectionDate', 'billId', 'patientInfo', 'tests', 'referral', 'amount', 'discount', 'paymentStatus', 'paid', 'due', 'net', 'age', 'areaManager', 'districtManager', 'stateManager', 'zoneHead', 'cmo'],
  test: ['billDate', 'billId', 'patientInfo', 'tests', 'department', 'referral', 'amount', 'discount', 'net', 'areaManager', 'districtManager', 'stateManager', 'zoneHead', 'cmo', 'collectedAt', 'level1', 'level2'],
  outsource: ['billDate', 'billId', 'patientInfo', 'testName', 'toLab', 'mrp', 'outsourcePrice'],
}

export const cellText = (c: ColDef, r: FRow, ctx: Ctx): string | number => {
  const v = c.get(r, ctx)
  return v
}
export const csvVal = (c: ColDef, v: string | number) => (c.money ? rupees(Number(v)) : v)
export { tsMs }
