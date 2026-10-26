import type { Timestamp } from 'firebase/firestore'

// All money values are stored in paise (integer minor units).
export type Paise = number

export type Role =
  | 'labAdmin'
  | 'admin'
  | 'manager'
  | 'reception'
  | 'technician'
  | 'doctor'
  | 'phlebotomist'
  // External partner roles (portal users): scoped to one partner document by `partnerId`.
  // 'referrer' is the referring doctor / hospital portal (the internal pathologist role is 'doctor').
  | 'b2b'
  | 'collectionCentre'
  | 'corporate'
  | 'referrer'

export interface UserProfile {
  uid: string
  name: string
  email: string
  role: Role
  labId: string
  active: boolean
  // Highest bill discount (%) this user may give without an admin.
  maxDiscountPct: number
  // Highest rupee discount (paise) per bill without a manager override; missing = the lab-wide cap, 0 = no cap.
  maxDiscountAmount?: Paise
  // Branch access. Missing (legacy profile) is treated as ['main']; [] means no branch.
  branchIds: string[]
  defaultBranchId: string
  allBranches: boolean // may use every branch, including future ones
  // Per-user overrides on top of the role's permissions.
  grants: string[]
  denies: string[]
  // Effective permissions (role + grants - denies). Computed client-side by
  // AuthProvider; never stored.
  permissions: string[]
  // Staff details (all optional; older profiles lack them)
  username?: string // login handle shown in lists; Firebase sign-in still uses the email
  phone?: string
  gender?: 'male' | 'female' | 'other' | ''
  signature?: string // doctors: typed signature line / designation for reports
  sessionTimeoutMin?: number // auto sign-out after this many idle minutes; 0 or missing = never
  maxLogins?: number // concurrent sign-ins allowed (0 / missing = no limit); enforced by features/settings/sessions.ts
  allowPasswordChange?: boolean // false: the user may not change their own password (missing = allowed)
  partnerId?: string // external roles: the b2bCentres / collectionCentres / corporateClients / referrers doc this user belongs to
  deleted?: boolean // soft-deleted: hidden from lists, cannot sign in (active is forced false)
  deletedAt?: Timestamp | null
  lastLoginAt?: Timestamp | null
  // Set by AuthProvider while a lab admin is viewing the app as this user (read-only, audited); never stored.
  viewOnly?: boolean
  viewedBy?: { uid: string; name: string }
}

// labs/{lab}/roles/{roleId}: the editable permissions matrix column of a role.
export interface RoleDoc {
  id: string
  name: string
  permissions: string[]
  builtIn: boolean
}

export interface CustomFieldDef {
  key: string
  label: string
  type?: 'text' | 'number' | 'date' | 'select'
  options?: string[]
  required?: boolean
}
// Front-desk configuration kept on the lab doc (edited from Registration > Front desk settings).
export interface FrontDeskSettings {
  fieldLabels?: Record<string, string> // registration field labels renamed by the lab
  customFields?: CustomFieldDef[] // add-on registration fields (stored on the patient as customFields)
  refundApprovalThreshold?: Paise // refunds above this need a manager or admin to approve (0/undefined = off)
  serviceablePincodes?: string[] // bookings outside these pincodes warn or block
  pincodePolicy?: 'warn' | 'block'
  bookingFields?: CustomFieldDef[] // typed custom (CRM) fields on a booking
  bookingReminderMinutes?: number // reminder lead time before a home collection (default 120)
  maxDiscountAmount?: Paise // lab-wide cap on a bill discount (rupees in paise) for non-admins; 0/undefined = no cap
  hiddenFields?: string[] // registration fields the lab hides (never a required one)
  showPreBookings?: boolean // extra (default off): a separate Pre Bookings view on the Bookings page
}

export interface LabSettings {
  name: string
  address: string
  phone: string
  email: string
  billPrefix: string
  // When true a report is "Final" only after the bill has no balance due.
  finalRequiresPayment: boolean
  // When false, approving a test with no entered values is blocked.
  allowEmptyApproval: boolean
  // When false, the user who entered a result cannot approve it.
  allowSelfVerification: boolean
  discountReasonRequired: boolean
  dispatchDefaults: DispatchMode[]
  // Messaging
  publicAppUrl: string // base URL used in report links, e.g. https://lab.example.com
  autoSendOnFinal: boolean // send the report automatically when it becomes Final
  blockSendWhileDue: boolean // do not send reports while a balance is due
  reportLinkDays: number // how long a shared report link stays valid
  templates: MessageTemplates
  // AI
  aiEnabled: boolean
  aiModel: string // Claude model id used by the AI features
  // Quality control
  qcBlocksApproval: boolean // when true, a failed QC run blocks approving that machine's tests
  // ---- Lab Profile / Lab Settings groups (defaults deep-merged in useLabSettings)
  profile: LabProfileSettings
  dailyReport: DailyReportSettings
  reportDetails: ReportDetailsSettings
  billDetails: BillDetailsSettings
  quotation: QuotationSettings
  signatories: Signatory[]
  b2bInvoice: PartnerInvoiceSettings
  corporateInvoice: PartnerInvoiceSettings
  docTemplates: DocTemplateSettings
  registration: RegistrationSettings
  reportEntry: ReportEntrySettings
  integration: IntegrationSettings
  b2bLab: B2bLabSettings
  accession: AccessionSettings
  referrals: ReferralSettings
  nabl: NablSettings
  tat: TatSettings
  patientList: PatientListSettings
  extraTemplates: ExtraTemplates
  // Optional groups, defaulted by readers in features/settings/lib.ts (not in DEFAULT_SETTINGS).
  features?: Partial<Record<FeatureKey, boolean>> // per-lab module switches; missing = on
  inventory?: InventorySettings
  frontDesk?: FrontDeskSettings // registration labels / custom fields, refund approval, serviceable pincodes, booking field definitions
  autoVerify?: AutoVerifyConfig // lab-level auto-verification rules (result entry / analyser)
  strictPartnerPricing?: boolean // block (instead of falling back to MRP) when a partner rate list lacks the item
  // Round 3 (defaults applied by readers in features/report/layout.ts, not in DEFAULT_SETTINGS).
  reportLayout?: Partial<ReportLayoutSettings>
  radiologyConfig?: Partial<RadiologyConfig>
  pcpndt?: Partial<PcpndtSettings>
  emailSender?: EmailSenderSettings
  // Round 3 catalogue / admin groups (readers default them; never in DEFAULT_SETTINGS).
  branchOverrides?: Record<string, BranchOverride> // per-branch report / bill setting overrides, keyed by branch id
  abdm?: AbdmSettings
  subscription?: SubscriptionInfo // written by the platform (super admin), read-only for the lab
  commentTemplates?: CommentTemplate[] // named comment templates for tests and results
  barcode?: { type: 'bill' | 'patient' | 'department' } // what one barcode stands for
  allowDispatchedDueAccess?: boolean // staff may open the report of a dispatched bill that still has a due
  b2bPriceListDisabled?: boolean // B2B centres are billed at MRP, rate lists switched off
}
export interface BranchOverride {
  reportDetails?: Partial<ReportDetailsSettings>
  billDetails?: Partial<BillDetailsSettings>
  profile?: Partial<LabProfileSettings>
  name?: string // branch lab name printed on reports and bills
  address?: string
  phone?: string
}
export interface AbdmSettings {
  hfrId: string // Health Facility Registry id
  hipId: string // Health Information Provider id
  abhaLinking: boolean // offer ABHA linking at registration
}
export interface SubscriptionInfo {
  plan: string // e.g. Starter, Standard, Enterprise
  edition?: string
  status: 'active' | 'trial' | 'expired' | 'suspended'
  renewsOn?: string // ISO date
  billLimit?: number // 0 = unlimited
  seats?: number
}
export interface CommentTemplate {
  id: string
  name: string
  text: string
}

export type ReportColumnKey = 'test' | 'result' | 'flag' | 'reference' | 'unit' | 'method'
export interface Letterhead {
  id: string
  name: string
  headerDataUrl: string
  footerDataUrl: string
  firstPageOnly?: boolean
  active: boolean
}
// Layout controls and extra toggles of the printed report (Lab profile > Report layout).
export interface ReportLayoutSettings {
  fontFamily: 'sans' | 'serif' | 'mono'
  fontSize: number // px, body text
  headingSize: number // px, test names
  columnOrder: ReportColumnKey[]
  columnWidths: Partial<Record<ReportColumnKey, number>> // percent
  columnLabels: Partial<Record<ReportColumnKey, string>> // customised headings
  logoHeight: number // px
  logoAlign: 'left' | 'center' | 'right'
  ageFormat: 'long' | 'short' | 'ymd'
  headerFields: string[] // ordered patient-block field keys (empty = use reportDetails.patientFields)
  headerColumns: 2 | 3 | 4
  showMadeWith: boolean
  showTestMethod: boolean
  showMic: boolean
  showMachineName: boolean
  showDeptName: boolean
  showPackageName: boolean
  showB2bCode: boolean
  showLabPhone: boolean
  listPendingTests: boolean
  boldOnly: boolean // abnormal values bold, never coloured
  reportDateOnly: boolean // print the report date without a time
  trendGraph: boolean
  trendSize: 'small' | 'medium' | 'large'
  allergyRows: boolean // allergy panels print two parameters per row
  imageHeight: number // px, image-type parameter values
  letterheads: Letterhead[]
  defaultLetterheadId: string
  signatoryMode: 'fixed' | 'byUser'
  maxSignatures: number
  showStamp: boolean
  publicOtp: 'off' | 'optional' | 'required' // OTP as the second factor on the public report
  publicBillPin: boolean // the bill PIN is accepted as a second factor
  hardCopyPrompt: boolean // ask for receiver name / tracking number when a hard copy is dispatched
  waDocTemplate?: string // approved WhatsApp template with a document header: the report PDF is attached to it
}
export interface RadiologyConfig {
  modalities: { code: string; label: string }[] // lab-configurable DICOM modality codes
  viewerBaseUrl: string // https base, the study UID is appended (no tokens)
  accessionBarcode: boolean // print the accession barcode on radiology reports and worklist labels
  autosaveSeconds: number // 0 = off
  externalReaders: { id: string; name: string; email: string; active: boolean }[]
}
export interface PcpndtSettings {
  blockReport: boolean // ultrasound report is blocked until Form F is complete
  clinicName: string
  registrationNo: string
}
export interface EmailSenderSettings {
  fromName: string
  fromEmail: string
  status?: 'unverified' | 'pending' | 'verified' // written by the server only
  verifiedEmail?: string // the address that passed verification
  verifiedAt?: unknown
  requestedAt?: unknown
}

export type FeatureKey =
  | 'accession'
  | 'bookings'
  | 'inventory'
  | 'corporate'
  | 'b2b'
  | 'collectionCentres'
  | 'marketing'
  | 'outsource'
  | 'nabl'
  | 'qc'
  | 'radiology'
  | 'quotations'
  | 'ai'
  | 'tat'
  | 'machineReading'
export interface InventorySettings {
  consumeOn: 'billing' | 'receipt' // when mapped consumables are deducted (default 'receipt')
}

export interface LabProfileSettings {
  city: string
  website: string
  dateFormat: string // dayjs format, e.g. DD/MM/YYYY
  logoDataUrl: string // base64 data URL, <= 200 KB
  adminName: string
  adminEmail: string
  adminContact: string
}
export interface DailyReportSettings {
  enabled: boolean
  email: string
  whatsapp: string
}
export type PageSize = 'A4' | 'A5' | 'Letter'
export interface ReportDetailsSettings {
  useLetterhead: boolean // print on pre-printed letterhead (hide header/footer)
  showHeader: boolean
  showFooter: boolean
  headerImage: string // data URL
  footerText: string
  marginTop: number // mm
  marginBottom: number
  marginLeft: number
  marginRight: number
  pageSize: PageSize
  showQr: boolean
  showBarcode: boolean
  showReferenceRanges: boolean
  abnormalStyle: 'bold' | 'colour' | 'both' | 'none'
  showFlagArrows: boolean
  signaturePlacement: 'end' | 'everyPage'
  endOfReportText: string
  pageBreakPerDepartment: boolean
  patientFields: string[] // keys shown in the report patient block
  // Optional extras (defaults applied by readers when absent)
  provisionalShowSign?: boolean // print the signature on provisional reports
  reportBlockPartial?: boolean // block printing/sending while any test is still pending
  allowProvisionalSend?: boolean // default true
  showSampleTypePerTest?: boolean
  duplicateWatermark?: boolean // DUPLICATE watermark after the first print
  radiologyRequireImage?: boolean // sign-off needs an attached image
  radiologyRequireImpression?: boolean // sign-off needs an impression
  lowColour?: string
  highColour?: string
}
export interface BillDetailsSettings {
  header: string
  footer: string
  terms: string
  showPaymentBreakup: boolean
  showTestCode: boolean
  showBarcode: boolean
  showBilledBy: boolean
  showReportDelivery: boolean
  gstEnabled: boolean
  gstin: string
  gstPercent: number
  hsnCode: string
  defaultPrint: 'a4' | 'thermal'
  thermalEnabled: boolean
  upiId: string
  showLineDiscount?: boolean // extra (default off): print each line's discount and net. Flabs prints gross line amounts only.
}
export interface QuotationSettings {
  validityDays: number
  header: string
  terms: string
  prefix: string
  // Print layout
  footer?: string
  marginMm?: number
  showPackageContents?: boolean
  showTestCode?: boolean
  showSampleColumn?: boolean
  showSignature?: boolean
  signatureName?: string
  template?: 'standard' | 'compact'
}
export interface Signatory {
  id: string
  name: string
  qualification: string
  registrationNo: string
  signatureDataUrl: string
  hideNameInReport: boolean
  defaultForDepartmentIds: string[]
  active: boolean
  designation?: string
  signatureHeight?: number // px
  align?: 'left' | 'center' | 'right'
  userId?: string // staff user this signatory belongs to (the "by user" signing rule)
  autoSign?: boolean // signs automatically when no other rule picks a signatory
  stampDataUrl?: string // rubber stamp image printed next to the signature
}
export interface PartnerInvoiceSettings {
  prefix: string
  cycle: 'perBill' | 'weekly' | 'fortnightly' | 'monthly'
  terms: string
  bankName: string
  bankAccountName: string
  bankAccountNo: string
  bankIfsc: string
  upiId: string
  detailedView: 'test' | 'patient'
}
export interface DocTemplateSettings {
  trfText: string
  worksheetHeader: string
  worksheetFooter: string
}
export interface RegistrationSettings {
  requiredFields: string[]
  uniqueContact: boolean
  // Flabs: UHID is not generated and not on the form by default ('none'); 'manual' shows an entry field, 'auto' generates one.
  uhidMode: 'auto' | 'manual' | 'none'
  idDisplay: 'patientId' | 'uhid' | 'daywise'
  defaultAgeUnit: 'year' | 'month' | 'day'
  // Which partner rate lists apply by themselves. Flabs: referring doctor, hospital, second referral and corporate client all on ('all').
  autoRateList: 'none' | 'referrer' | 'hospital' | 'corporate' | 'all'
  defaultDueBill: boolean
  defaultDiscountedBy: 'none' | 'staff'
  salutations: string[]
  autoSalutationFromGender: boolean
  dispatchDefaultsB2b: DispatchMode[]
  // Block a same-day repeat of a test for the same patient (otherwise only warn).
  duplicateTestGuard?: boolean
  // Extra (not in Flabs, default off): confirm before registering a new patient with the same phone, name and a similar age.
  strongDuplicateGuard?: boolean
  // Bulk registration: what to do when a row matches an existing patient.
  bulkDuplicatePolicy?: 'skip' | 'attach' | 'create'
}
export interface ReportEntrySettings {
  showPreviousResults: boolean
  deltaCheckPercent: number // 0 = off
  defaultSignatoryId: string
  criticalAckRequired: boolean
  colourCodedBackground: boolean
  abnormalAlertBeforeApproval: boolean
  holdReasonModal: boolean
  criticalWhatsappAlert?: boolean // message the patient / centre when a critical value is entered (dev outbox without provider)
  notifyOnRejection?: boolean // message the patient / centre when a sample is rejected (default on)
  formulaDecimals?: number // decimals kept on calculated values (default 2)
  deltaAbsoluteLimit?: number // delta check: absolute change that raises a flag (0 = off)
  deltaLookbackDays?: number // delta check: only compare with results this recent (0 = any age)
}

// Lab-level auto-verification rules (stored as `autoVerify` on the lab document).
export interface AutoVerifyConfig {
  enabled: boolean
  samplingPct: number // share of eligible results sent to a person for review anyway (default 5)
  blockAbnormal: boolean // abnormal (not critical) results need a person (default on)
  useDeltaCheck: boolean // a large change from the previous result needs a person (default on)
  requireQcInControl: boolean // a failed latest QC run on the analyser blocks auto-verification (default on)
  excludedTestIds: string[] // tests that always need a person
  signatureMode: 'none' | 'defaultSignatory'
  version: number // bumped on each save; stored on each auto-verified result
  updatedByName?: string
}
export interface IntegrationSettings {
  machineInterface: boolean
}
export interface B2bLabSettings {
  creditLimitBehaviour: 'block' | 'warn'
  invoiceCycle: 'perBill' | 'weekly' | 'fortnightly' | 'monthly'
  showDispatchedInUnit: boolean
}
export interface AccessionSettings {
  enabled: boolean
  mode: 'patient' | 'sample' | 'department'
  barcodePer: 'bill' | 'sample'
  labelSize: '50x25' | '38x25' | '75x38'
  autoGenerateBarcode: boolean
  notReceivedAfterHours?: number // pending samples older than this are marked Not Received automatically (default off = 0)
}
export interface ReferralSettings {
  commissionBasis: 'gross' | 'net' | 'paid'
  commissionTrigger?: 'billing' | 'reportFinal' | 'fullyPaid' // when a bill starts earning commission (default: billing)
  showCommissionOnBills: boolean
  govPanelSendDueReport: boolean
}
export interface NablSettings {
  enabled: boolean
  retentionDays: number
  rerunReasonModal: boolean
  urgentRemarkModal: boolean
  criticalRemarkModal: boolean
  eqasMatchDays: number
}
export interface TatSettings {
  enabled?: boolean // module flag; undefined = on
  clockStart: 'registration' | 'collection' | 'receipt'
  nearbyThresholdPercent: number
  urgentTatPercent: number // urgent tests get this % of the normal TAT
  showInAccession: boolean
  showInEnterVerify: boolean
  showInBilling: boolean
  showInPatientList: boolean
}
export interface PatientListSettings {
  defaultRange: 'today' | '7d' | '30d' | 'month'
  defaultTab: 'all' | 'pending' | 'final' | 'due'
  newestFirst: boolean
  columns: string[]
  voidReasonRequired: boolean
}
export interface ExtraTemplates {
  smsReportReady: string
  emailSubject: string
  emailBody: string
  waReportFromB2b: string
  waReportFromCentre: string
  waReportToB2b: string
}

// Message bodies with {placeholders}: patientName, labName, billNo, link,
// bookingId, slot, collectorName, amount.
export interface MessageTemplates {
  reportReady: string
  bookingConfirmed: string
  collectorAssigned: string
  // Name of the approved WhatsApp Business template for each event (Meta requires
  // pre-approved templates for business-initiated messages).
  waReportTemplate: string
  waBookingTemplate: string
}

export type Gender = 'male' | 'female' | 'other'
export type AgeUnit = 'year' | 'month' | 'day'

export interface Department {
  id: string
  name: string
  order: number
  active?: boolean // false: hidden from new tests and billing filters (missing = active)
  deleted?: boolean // soft-deleted, restorable from the catalogue
  reportTemplateId?: string // report template used for every test of this department unless the test names its own
}

export interface SampleType {
  id: string
  name: string
  tubeColor: string
  discardDays?: number // QC > Sample Discarding setup: keep the sample this many days before discard
  discardHours?: number
  discardMinutes?: number
  deleted?: boolean // soft-deleted, restorable
}

// richText stores sanitised HTML, image a small compressed data URL, pdf a small data URL.
export type ParamDataType = 'numeric' | 'text' | 'numericUnbound' | 'options' | 'richText' | 'image' | 'pdf'
export type ParamStructure = 'single' | 'group'

// Age band in days so year/month/day inputs compare on one scale.
export interface AgeRange {
  fromDays: number
  toDays: number
  low: number | null
  high: number | null
  displayText: string
  gender?: 'any' | 'male' | 'female' // missing = any
  condition?: string // patient condition this band is for (e.g. "Pregnant - 2nd trimester"); missing = applies to everyone
}

export interface Parameter {
  key: string // stable id used in formulas, e.g. "HB"
  name: string
  structure: ParamStructure
  parentKey: string | null // set for members of a group
  dataType: ParamDataType
  unit: string
  options: string[] // for dataType "options"
  low: number | null
  high: number | null
  ranges: AgeRange[] // age bands override low/high when they match
  criticalLow: number | null
  criticalHigh: number | null
  displayRange: string // free text shown on the report instead of low-high
  formula: string // empty when entered manually, e.g. "HB / RBC * 10"
  required: boolean
  hideOnReport: boolean
  method: string
  // Options / text parameters: which entries are abnormal or critical (value -> flag).
  optionFlags?: Record<string, 'normal' | 'abnormal' | 'critical'>
  defaultText?: string // descriptive parameters: prefilled text
  explanation?: string // plain-language explanation shown on the smart report (catalogue editor can wire it)
  translations?: Record<string, string> // name per report language code (hi, mr, gu, bn, ta)
  decimals?: number // decimals kept for a calculated value (missing = lab default)
  deltaLimitPct?: number // delta check limit for this parameter, percent (missing = lab limit)
  deltaLimitAbs?: number // delta check limit for this parameter, absolute units
}

export type TestGender = 'both' | 'male' | 'female'

export interface Test {
  id: string
  translations?: Record<string, string> // name per report language code (hi, mr, gu, bn, ta)
  modality?: string // radiology tests only (X-Ray, USG, CT...)
  startOnNewPage?: boolean // report prints this test on a fresh page
  restricted?: boolean // sensitive test: never sent over WhatsApp / SMS
  pcpndt?: boolean // PCPNDT-regulated test (Form F): drives the Patient List PCPNDT tab and billing prompts
  code: string
  name: string
  departmentId: string
  sampleTypeId: string
  price: Paise
  gender: TestGender
  // Billing prompts: collected per line when the test is added to a bill.
  lmpRequired?: boolean
  idRequired?: boolean
  consentRequired?: boolean
  // Billed only: no sample, no result (a service, e.g. a consultation).
  onlyBilling?: boolean
  tatMinutes: number | null
  urgentTatMinutes: number | null
  parameters: Parameter[]
  interpretation: string
  disabled: boolean
  order: number
  branchIds?: string[] // branches this test is offered in (missing / empty = every branch)
}

export interface Package {
  id: string
  code: string
  name: string
  price: Paise
  testIds: string[]
  disabled: boolean
  deleted?: boolean // soft-deleted, restorable
}

export type DispatchMode = 'email' | 'hardcopy' | 'sms' | 'whatsapp' | 'manualWhatsapp'

export interface Patient {
  id: string
  patientNo: string // YYMMDD + 3-digit daily sequence
  salutation: string
  firstName: string
  lastName: string
  gender: Gender
  ageValue: number
  ageUnit: AgeUnit
  phone: string
  email: string
  dispatchModes: DispatchMode[]
  referrerName: string
  createdAt: Timestamp
  createdBranchId?: string
  partnerId?: string // created by a partner portal user: the partner whose staff may read it
  // Registration extras (all optional; older patients lack them)
  uhid?: string
  barcode?: string // shared accession barcode when the lab uses patient-wise barcodes
  abhaNo?: string
  dob?: string // YYYY-MM-DD
  countryCode?: string // e.g. +91
  altPhone?: string
  address?: string
  city?: string
  pincode?: string
  idType?: string
  idNumber?: string
  referrerId?: string
  hospitalId?: string
  secondReferrerId?: string
  insuranceNo?: string
  district?: string
  dayNo?: number // daily sequence (the last 3 digits of patientNo)
  // Registration fields driven by registration.requiredFields (all optional)
  weight?: number // kg
  height?: number // cm
  town?: string
  clinicalHistory?: string
  category?: string
  corporateUser?: string // employee name / id under the corporate client
  corporatePlanId?: string // plan package of the corporate client
  species?: string // veterinary
  breed?: string
  ownerName?: string
  customFields?: Record<string, string> // add-on registration fields (FrontDeskSettings.customFields)
}

export type ItemStatus =
  | 'pending'
  | 'collected'
  | 'received'
  | 'rejected'
  | 'entered'
  | 'approved'
  | 'hold'
  | 'refunded'

export interface OrderItem {
  lineId: string
  kind: 'test' | 'package'
  refId: string // test or package id
  code: string
  name: string
  price: Paise
  discount: Paise // this line's share of all discounts
  urgent: boolean
  testIds: string[] // tests to perform (one for a test, members for a package)
  status: ItemStatus
  provisional?: boolean // an approved test released as Provisional (set by result entry)
  isCharge?: boolean // an "other charge" line (home collection, urgent fee...), no tests to run
  showOnBill?: boolean // charge lines: false hides the charge on the printed bill
  onlyBilling?: boolean // billed service: no sample and no result
  listPrice?: Paise // rate-list price at billing time (price may be edited)
  lmp?: string // last menstrual period (YYYY-MM-DD) when the test needs it
  idRef?: string // ID proof reference when the test needs it
  consent?: boolean // patient consent recorded when the test needs it
  tatMinutes?: number | null
  pcpndt?: boolean // the test is PCPNDT-regulated (copied from the catalogue test's pcpndt flag)
  qty?: number // repeat samples: price is per unit, the line price already includes qty
  departmentId?: string // catalogue department of the test (stamped at billing; used by per-department commission rules)
  commissionCost?: Paise // rate-list-difference commission: the referrer's cost-list price for this line (qty included)
  // Outsourced tests on this line: lab and cost frozen at billing (features/outsource/lib outsourceSnapshot).
  outsource?: { testId: string; labId: string; labName: string; cost: Paise; tatMinutes: number | null }[]
}

export type LedgerType = 'payment' | 'clearDue' | 'refund' | 'reversal'
// 'cash' | 'upi' | 'card' built in; custom modes come from the paymentModes master; 'wallet' = B2B centre wallet.
export type PaymentMode = string

export interface LedgerEntry {
  id: string
  type: LedgerType
  mode: PaymentMode
  amount: Paise // positive = money in, negative = money out
  reference: string
  remark: string
  lineIds: string[] // refunded lines
  reversesId?: string // reversal entries: the ledger entry this undoes
  refundPending?: boolean // refund owed but not yet paid out (void of a paid bill)
  backdatedTo?: Timestamp // payment dated earlier than it was posted
  receiptNo?: string // one receipt number per payment event (R + FY + sequence)
  refundNo?: string // refund entries: RF + FY + sequence
  status?: 'requested' | 'approved' | 'paid' | 'rejected' // refund approval state (above the threshold)
  shift?: string // day-end shift label
  postedBy: string
  postedByName: string
  postedAt: Timestamp
}

// labs/{lab}/shiftCloses/{id}: a cashier's day-end count for one shift (append-only).
export interface ShiftClose {
  id: string
  branchId?: string
  date: string // yyyy-MM-dd
  shift: string // Morning | Evening | Night
  expected: Record<string, Paise> // net money per payment mode from the ledger (payments minus refunds / reversals)
  counted: Record<string, Paise> // what was physically counted / matched per mode
  difference: Paise // counted minus expected, all modes
  entries: number // ledger rows covered
  onlyMine: boolean // true: only the closing user's collections were counted
  closedBy: string
  closedByName: string
  closedAt: Timestamp
  note: string
}

export type ReportStatus = 'pending' | 'partial' | 'provisional' | 'final'

export interface DispatchState {
  mode: DispatchMode
  delivered: boolean
  deliveredAt: Timestamp | null
  receiverName?: string
  trackingNo?: string
}

export interface Order {
  id: string
  branchId?: string // missing on legacy docs = 'main'
  billNo: string
  barcode: string
  patientId: string
  patientNo: string
  patientName: string
  gender: Gender
  ageValue: number
  ageUnit: AgeUnit
  referrerName: string
  items: OrderItem[]
  gross: Paise
  discount: Paise
  net: Paise
  paid: Paise // sum of ledger (refunds negative)
  refunded: Paise
  due: Paise
  discountReason: string
  discountedBy: string
  note: string
  reportStatus: ReportStatus
  dispatch: DispatchState[]
  dispatched: boolean
  collectedAt: Timestamp | null
  receivedAt: Timestamp | null
  reportedAt: Timestamp | null
  dueRemark?: string // remark of the last due clearance, shown on the Due list until the bill is cleared
  firstApprovedAt?: Timestamp | null // time of the first approval on the bill: the printed Report Date (Flabs)
  createdAt: Timestamp
  createdBy: string
  deleted: boolean
  // Registration / partner context (all optional on legacy bills)
  referrerId?: string
  hospitalId?: string
  b2bCentreId?: string
  collectionCentreId?: string
  corporateClientId?: string
  govPanelId?: string
  tpaId?: string
  // Partner display names, stored alongside the ids at billing time.
  hospitalName?: string
  b2bCentreName?: string
  collectionCentreName?: string
  corporateClientName?: string
  govPanelName?: string
  tpaName?: string
  createdByName?: string
  uhid?: string
  priority?: 'routine' | 'urgent'
  sampleCollectedAt?: 'lab' | 'home'
  billDate?: Timestamp // editable billing date/time; createdAt stays the audit time
  // Share of the bill a TPA / government panel pays; excluded from the patient's due.
  payer?: { kind: 'tpa' | 'govPanel'; id: string; name: string; amount: Paise }
  billedTo?: 'patient' | 'b2b'
  quotationId?: string
  bookingId?: string
  source?: 'walkin' | 'home' | 'b2b' | 'corporate' | 'quotation' | 'booking'
  secondReferrerId?: string
  secondReferrerName?: string
  discountBearer?: 'lab' | 'referrer' | 'split' // who bears the discount for commission (defaults to the referrer's setting)
  discountSplitReferrerPct?: number // referrer share 0-100 when 'split'
  urgentMarkedBy?: string // uid of the user who marked the bill urgent
  urgentMarkedByName?: string
  urgentRemark?: string // why the bill / test is urgent (NABL urgent remark prompt)
  proId?: string // PRO (marketing manager) of the referrer, stamped at billing
  proName?: string
  rateListIds?: string[] // rate lists that priced the bill, in priority order
  billPrints?: number // number of times the bill receipt was printed
  voidRefundPending?: Paise // money owed back after voiding a paid bill
  voidedBranchId?: string
  // Append-only edit trail (see lib/orders.ts editOrder)
  revisions?: OrderRevision[]
  // Report / dispatch extras
  reportDateOverride?: Timestamp | null
  reportPrintCount?: number
  printed?: boolean
  printedAt?: Timestamp | null
  printedBy?: string
  qrShareToken?: string
  reportRevision?: number // number of amendments after first approval
  amendedAt?: Timestamp | null
  amendSummary?: string
  dispatchStatus?: 'notReady' | 'pending' | 'partial' | 'dispatched'
  hasReportFile?: boolean
  // Round-two front-desk fields
  collectionDateTime?: Timestamp // when the sample was / will be collected (registration)
  phlebotomistId?: string
  phlebotomistName?: string
  corporateUser?: string
  corporatePlan?: string
  corporatePlanId?: string // the corporate plan entity (price + validity) this bill was registered under
  disableLetterhead?: boolean // corporate client flag frozen on the bill: print its reports without the letterhead (report sheet must read this)
  hidePlan?: boolean // corporate client flag frozen on the bill: do not print the plan name
  clinicalHistory?: string
  weight?: number
  height?: number
  category?: string
  pcpndt?: boolean // a PCPNDT-regulated test is on the bill
  formFStatus?: 'none' | 'pending' | 'complete' // PCPNDT Form F state (see features/pcpndt)
  commissionSnapshot?: { type: string; value: number; basis: 'gross' | 'net'; bearer: 'lab' | 'referrer' | 'split' } // referrer commission terms frozen at billing
  rev?: number // edit counter for optimistic locking
  billNoReport?: string // report number, defaults to the bill number
  dispatchedLineIds?: string[] // approved lines covered when every mode was last marked delivered
  version?: number
  writeOffs?: { amount: Paise; reason: string; by: string; byName: string; at: Timestamp }[] // dues written off as a discount adjustment
  refundPendingApproval?: { amount: Paise; lineIds: string[]; mode: string; reason: string; requestedBy: string; requestedByName: string; requestedAt: Timestamp }
  discountApprovedBy?: string // manager / admin uid who approved a discount above the user's cap
  discountApprovedByName?: string
  voidedBarcode?: string // the barcode that was voided (kept for audit)
  barcodeVoided?: boolean // the bill was deleted: its barcode no longer resolves to a live sample
  commissionReversed?: boolean // the bill was deleted: commission on it is zero from then on
  commissionReversedAt?: Timestamp
}

export interface OrderRevision {
  at: Timestamp
  by: string
  byName: string
  summary: string
  before: { gross: Paise; discount: Paise; net: Paise; items: number }
  after: { gross: Paise; discount: Paise; net: Paise; items: number }
}

export interface ParamValue {
  value: string
  // 'abnormal' = qualitative abnormal (option / text parameters), no direction.
  abnormal: 'low' | 'high' | 'abnormal' | null
  critical: boolean
  overridden: boolean // a calculated value typed over by the user
  overrideOfCalculated?: string // the system value that was typed over
  mic?: string // MIC for a culture / sensitivity result (from the analyser or typed)
  criticalDir?: 'low' | 'high' // which critical limit was crossed (shown as LL / HH)
  // Reference range edited for this one result (kept with who changed it and why).
  // Reference range as it stood when the value was entered; printed instead of the live catalogue range.
  rangeSnapshot?: { low: number | null; high: number | null; text: string; at: number }
  rangeOverride?: { low: number | null; high: number | null; text: string; reason: string; by: string; byName: string; at: number }
}

export interface TestResult {
  id: string // = testId
  orderId: string
  testId: string
  testName: string
  values: Record<string, ParamValue>
  comment: string
  status: 'pending' | 'entered' | 'approved' | 'hold'
  enteredBy: string
  approvedBy: string
  approvedByName: string
  approvedAt?: Timestamp // stamped by result entry when the test is approved (TAT stop time)
  updatedAt: Timestamp
}

export interface ResultVersion {
  id: string
  event: 'saved' | 'approved' | 'unapproved' | 'amended' | 'rerun' | 'hold' | 'sentBack' | 'restored'
  values: Record<string, ParamValue>
  by: string
  byName: string
  at: Timestamp
}

// ---- Bookings / home collection -------------------------------------------

export type BookingStatus =
  | 'unmapped' // tests given as free text, not yet mapped to the catalogue
  | 'scheduled'
  | 'confirmed'
  | 'assigned' // phlebotomist assigned
  | 'inProgress'
  | 'completed' // sample collected and bill created
  | 'rescheduled'
  | 'cancelled'

export type BookingType = 'homeCollection' | 'labVisit'

export interface BookingItem {
  kind: 'test' | 'package'
  refId: string
  code: string
  name: string
  price: Paise
}

export interface BookingEvent {
  at: Timestamp
  by: string
  byName: string
  action: string // e.g. "status: confirmed", "assigned to Ravi", "note"
  note: string
}

export interface Booking {
  id: string
  branchId?: string // missing on legacy docs = 'main'
  bookingNo: string // BK + sequence
  type: BookingType
  status: BookingStatus
  firstName: string
  lastName: string
  phone: string
  email: string
  ageValue: number
  ageUnit: AgeUnit
  gender: Gender
  address: string
  pincode: string
  landmark: string
  referrerName: string
  items: BookingItem[]
  freeTextTests: string // what the patient asked for when not mapped yet
  scheduledAt: Timestamp | null
  slot: string // e.g. "07:00-08:00"
  assignedTo: string // phlebotomist uid
  assignedToName: string
  collectionCharge: Paise
  discount: Paise
  prepaid: Paise
  prepaidMode: PaymentMode | null
  notes: string
  cancelReason: string
  patientId: string // set when converted
  orderId: string // set when converted to a bill
  events: BookingEvent[]
  createdAt: Timestamp
  createdBy: string
}

// ---- Messaging ---------------------------------------------------------------

export type Channel = 'whatsapp' | 'sms' | 'email'

export interface Delivery {
  id: string
  channel: Channel | 'manualWhatsapp' | 'hardcopy'
  to: string
  kind: 'report' | 'booking' | 'bill' | 'alert'
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled' | 'logged' // logged = no provider configured (dev); delivered/read come from provider webhooks
  providerId: string
  error: string
  link: string
  sentBy: string
  sentByName: string
  at: Timestamp
  // Extras written by the sendReport function
  recipient?: 'patient' | 'doctor' | 'b2b' | 'centre' | 'corporate'
  deliveredAt?: Timestamp
  readAt?: Timestamp
  statusAt?: Timestamp
  attempts?: number
  retryAt?: Timestamp | null
  smart?: boolean
  attachment?: string // PDF file name attached to this send
  revision?: number
}

// ---- AI ----------------------------------------------------------------------

export type WidgetKind = 'kpi' | 'bar' | 'line' | 'pie' | 'table'

// A dashboard widget stores the analytics query, not the data, so it stays live.
export interface DashboardWidget {
  id: string
  title: string
  kind: WidgetKind
  query: AnalyticsQuery
}

// The same read-only analytics queries back the analyst's tools, dashboards and MCP.
export interface AnalyticsQuery {
  metric:
    | 'revenue' // net billed
    | 'collections' // money received (incl. due clearance), net of refunds
    | 'dues'
    | 'refunds'
    | 'discounts'
    | 'bills'
    | 'patients'
    | 'tests' // test count
    | 'tat' // average turnaround minutes, % within TAT
    | 'bookings'
  groupBy: 'none' | 'day' | 'week' | 'month' | 'referrer' | 'department' | 'test' | 'paymentMode' | 'status' | 'user'
  range: { preset: 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'last90' | 'thisYear' } | { from: string; to: string }
  limit?: number
}

export interface AnalyticsResult {
  query: AnalyticsQuery
  rows: { label: string; value: number; extra?: Record<string, number | string> }[]
  total: number
  unit: 'INR' | 'count' | 'minutes' | 'percent'
  from: string
  to: string
}

export interface Dashboard {
  id: string
  title: string
  description: string
  widgets: DashboardWidget[]
  createdBy: string
  createdByName: string
  // Roles that may open it besides the owner and lab admins; missing = shared with every AI user (legacy).
  sharedWithRoles?: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AiChat {
  id: string
  title: string
  userId: string
  userName: string
  // Display transcript; the server keeps the full API transcript separately.
  messages: AiChatMessage[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AiChatMessage {
  role: 'user' | 'assistant'
  text: string
  // Results of analytics tool calls made while answering, for inline charts/tables.
  results?: AnalyticsResult[]
  // Every tool call behind the answer (the "How was this computed" panel).
  steps?: AiChatStep[]
  dashboardId?: string
  at: Timestamp
}

export interface AiChatStep {
  tool: string
  summary: string
  dataset?: string
  spec?: unknown
  rowCount?: number
  ok: boolean
}

export interface AiInterpretation {
  summary: string
  findings: { parameter: string; note: string }[]
  suggestions: string
  model: string
  generatedAt: Timestamp
  generatedBy: string
  status: 'draft' | 'accepted' | 'discarded'
}

export interface McpConnection {
  id: string
  label: string
  createdBy: string
  createdByName: string
  createdAt: Timestamp
  expiresAt: Timestamp
  revoked: boolean
  lastUsedAt: Timestamp | null
  tokenHint: string // last 4 chars only; the token itself is shown once
  scopes?: string[] // ANALYTICS_READ | FINANCE_READ | QC_READ | CATALOGUE_READ (missing = all, legacy)
  tools?: string[] // allowed tool names (missing = all)
  rowLimit?: number
  ipAllowlist?: string[]
  revokedReason?: string
}
