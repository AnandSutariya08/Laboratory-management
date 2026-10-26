import type { Timestamp } from 'firebase/firestore'
import type { Order, Paise } from '../../types'

export type CommissionType = 'percent' | 'flat' | 'none'

export interface RateList {
  id: string
  name: string
  kind: 'doctor' | 'hospital' | 'b2b' | 'corporate' | 'govPanel' | 'collectionCentre' | 'custom' | 'shared'
  // test or package id -> list price in paise
  entries: Record<string, Paise>
  active: boolean
  // An item this list does not price is looked up in the parent list (and its parents) before the MRP.
  parentId?: string
  // What happens to an item neither this list nor its parents price: 'mrp' (default) or 'block' (cannot be billed).
  missingPolicy?: 'mrp' | 'block'
  // A shared list is applied to many partners at once (bulk apply); partners point at it with rateListId.
  shared?: boolean
}

// Commission override for one test, package or department; the most specific rule wins.
export interface CommissionRule {
  scope: 'test' | 'package' | 'department'
  refId: string
  refName?: string
  type: CommissionType
  value: number // percent, or paise per line when flat
}

export interface Referrer {
  id: string
  name: string
  type: 'doctor' | 'hospital' | 'second'
  degree?: string
  phone: string
  countryCode?: string // dialling code of phone (default +91)
  email: string
  address: string
  speciality: string
  commissionType: CommissionType
  commissionValue: number // percent, or paise when flat
  // 'standard' = the type/value above (plus any per-test rules); 'rateListDiff' = the lab bills MRP and the
  // referrer keeps the gap above the price in commissionListId (a cost list), per line.
  commissionMode?: 'standard' | 'rateListDiff'
  commissionListId?: string
  commissionRules?: CommissionRule[]
  rateListId: string
  proManagerId: string
  temporary: boolean
  active: boolean
  b2b?: boolean
  autoSendReports?: boolean // send paid reports to this doctor automatically
  discountBearer?: 'lab' | 'referrer' | 'split' // who bears a bill discount when computing commission
  discountSplitReferrerPct?: number // referrer's share (0-100) when discountBearer is 'split'
  loginAccess?: boolean
  mergedInto?: string
}

export interface Tpa {
  id: string
  name: string
  phone: string
  email: string
  commissionType: CommissionType
  commissionValue: number
  rateListId: string
  active: boolean
}

export interface GovPanel {
  id: string
  name: string
  recipientAddress: string
  panelType: 'central' | 'state' | 'municipal' | 'other'
  rateListId: string
  active: boolean
}

export type MarketingRole = 'pro' | 'area' | 'district' | 'state' | 'zone' | 'cmo'

export interface MarketingMember {
  id: string
  name: string
  parentId?: string // the manager this member reports to (hierarchy); '' / missing = top of the tree
  role: MarketingRole
  phone: string
  email: string
  area: string
  referrerIds: string[]
  targetBills: number
  targetRevenue: Paise
  commissionType: CommissionType
  commissionValue: number
  rateListId: string
  active: boolean
}

export interface ProcessingLab {
  id: string
  name: string
  contact: string
  email: string
  address: string
  turnaroundHours: number
  rateListId: string // price to us per test
  active: boolean
}

export interface B2BSettings {
  disableDashboard: boolean
  disablePriceList: boolean
  bookingLock: boolean
  printingLock: boolean
  noEditAfterApproval: boolean
  registrationBelowLimitAtMain: boolean
  registrationBelowLimitAtB2B: boolean
  reportDownloadBelowLimit: boolean
  disableCustomization: boolean
  disableMrpEdit: boolean
  hidePriceColumn: boolean
  barcodeEdit: boolean
  hideB2BRate: boolean
  patientWiseDueClearance: boolean
  allowAddReferral: boolean
  manualWhatsapp: boolean
  autoSendReport: boolean
  showTatColumn: boolean
}

export interface B2BCentre {
  id: string
  name: string
  code: string
  city: string
  phone: string
  email: string // portal login email
  address: string
  active: boolean
  creditType: 'prepaid' | 'rollingAdvance' | 'creditLimit'
  securityAmount: Paise
  creditLimit: Paise
  lowBalanceAlert: Paise
  paymentTerms: string
  paymentMethod: 'manual' | 'online'
  gstin?: string
  invoiceCycle?: 'perBill' | 'weekly' | 'fortnightly' | 'monthly'
  rateListId: string
  bank: { bank: string; account: string; ifsc: string; pan: string }
  settings: Partial<B2BSettings>
}

export interface CollectionCentre {
  id: string
  name: string
  code: string
  city: string
  phone: string
  email: string
  address: string
  active: boolean
  loginEmail: string
  rateListId: string
  settlementType: 'sharePercent' | 'flatPerBill' | 'none'
  settlementValue: number // percent of net, or paise per bill
  settlementDays: number
  dueReportView: boolean
  allowBillDelete: boolean
  referrals: 'all' | 'selected'
  referrerIds?: string[] // with referrals 'selected': the only referrers this centre may pick at billing
  upiId: string
  qrWidth: number
  qrHeight: number
}

export interface CorporateEmployee {
  empId: string
  name: string
  gender: string
  age: string
  phone: string
  email: string
  department: string
}

// A corporate plan: a named package of tests with a per-employee price and a validity window.
export interface CorporatePlan {
  id: string
  name: string
  packageIds: string[]
  price: Paise // per employee; 0 = priced from the package list / rate list
  validFrom?: string // yyyy-MM-dd
  validTo?: string
  active?: boolean
}

export interface CorporateClient {
  id: string
  name: string
  phone: string
  email: string
  type: 'insurance' | 'company' | 'tpa'
  address: string
  contactPerson: string
  active: boolean
  planPackageIds: string[]
  plans?: CorporatePlan[]
  creditDays: number
  creditLimit: Paise
  creditTerms: string
  rateListId: string
  employeeIdRequired: boolean
  disableLetterhead: boolean
  hidePlan: boolean
  loginEmail: string
  companies: string[]
  employees: CorporateEmployee[]
}

// An order may carry partner links (written by the billing screen).
export type PartnerOrder = Order & {
  referrerId?: string
  hospitalId?: string
  b2bCentreId?: string
  collectionCentreId?: string
  corporateClientId?: string
  govPanelId?: string
  discountBearer?: 'lab' | 'referrer' | 'split'
  discountSplitReferrerPct?: number
}

export type WalletMode = 'cash' | 'upi' | 'card' | 'bank' | 'cheque' | 'online'

// walletTxns (branch scoped, append-only). Amount is signed paise: positive adds to the
// centre's wallet. kind 'approval' rows decide a pending manual top-up (rules do not allow
// updating a txn, so approval is a new row referencing it).
export interface WalletTxn {
  id: string
  branchId?: string
  centreId: string
  centreName: string
  kind: 'topup' | 'debit' | 'adjustment' | 'discount' | 'approval'
  mode?: WalletMode
  reference: string
  amount: Paise
  status: 'pending' | 'approved' | 'declined'
  refTxnId?: string
  orderId?: string
  remark: string
  by: string
  byName: string
  at: Timestamp | null
}

export interface CreditNote {
  id: string
  branchId?: string
  centreId: string
  centreName: string
  kind: 'credit' | 'debit'
  amount: Paise
  reason: string
  remark: string
  by: string
  byName: string
  at: Timestamp | null
}

export interface PartnerInvoice {
  id: string
  branchId?: string
  kind: 'b2b' | 'corporate'
  partyId: string
  partyName: string
  partyCode: string
  number: string
  periodFrom: string // yyyy-MM-dd
  periodTo: string
  dueDate: string
  amount: Paise
  paid: Paise
  status: 'draft' | 'sent' | 'paid'
  dispatched: boolean
  orderIds: string[]
  lines: { orderId: string; billNo: string; patientName: string; date: string; amount: Paise; items?: string }[]
  createdAt: Timestamp | null
}


// commissionSettlements (branch stamped, append-only): one row per payout (or reversal of a payout) to a
// referrer or marketing member. Accrual is derived from bills; the balance is accrued minus these rows.
export interface CommissionSettlement {
  id: string
  branchId?: string
  partnerKind: 'referrer' | 'marketing'
  partnerId: string
  partnerName: string
  kind: 'payout' | 'reversal'
  periodFrom: string // yyyy-MM-dd
  periodTo: string
  accrued: Paise // accrued commission for the period when the payout was recorded
  amount: Paise // payout positive, reversal negative
  mode: string
  reference: string
  note: string
  reversesId?: string
  by: string
  byName: string
  at: Timestamp | null
}
