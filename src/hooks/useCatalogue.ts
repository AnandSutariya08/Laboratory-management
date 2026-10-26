import { useMemo } from 'react'
import { orderBy, query } from 'firebase/firestore'
import { col, labDoc, paths } from '../lib/db'
import type { Department, LabSettings, Package, SampleType, Test } from '../types'
import { setCommissionTrigger } from '../features/partners/lib/commission'
import { useLiveDoc, useLiveQuery } from './useLive'

export const DEFAULT_SETTINGS: LabSettings = {
  name: 'Health Care Labs',
  address: '',
  phone: '',
  email: '',
  billPrefix: 'HCL',
  finalRequiresPayment: true,
  allowEmptyApproval: false,
  allowSelfVerification: true,
  discountReasonRequired: false, // Flabs: the discount reason is optional (labs can switch it on)
  dispatchDefaults: ['email', 'hardcopy', 'sms', 'whatsapp', 'manualWhatsapp'],
  publicAppUrl: '',
  autoSendOnFinal: false,
  blockSendWhileDue: true,
  reportLinkDays: 30,
  templates: {
    reportReady:
      'Dear {patientName}, your report for bill {billNo} from {labName} is ready. View it here: {link}',
    bookingConfirmed:
      'Dear {patientName}, your home collection with {labName} is confirmed for {slot}. Booking ID {bookingId}.',
    collectorAssigned:
      'Dear {patientName}, {collectorName} from {labName} will collect your sample at {slot}. Booking ID {bookingId}.',
    waReportTemplate: 'report_ready',
    waBookingTemplate: 'booking_update',
  },
  aiEnabled: false,
  aiModel: 'claude-opus-5-5',
  qcBlocksApproval: false,
  profile: { city: '', website: '', dateFormat: 'DD/MM/YYYY', logoDataUrl: '', adminName: '', adminEmail: '', adminContact: '' },
  dailyReport: { enabled: false, email: '', whatsapp: '' },
  reportDetails: {
    useLetterhead: false,
    showHeader: true,
    showFooter: true,
    headerImage: '',
    footerText: '',
    marginTop: 10,
    marginBottom: 10,
    marginLeft: 10,
    marginRight: 10,
    pageSize: 'A4',
    showQr: true,
    showBarcode: true,
    showReferenceRanges: true,
    abnormalStyle: 'both',
    showFlagArrows: false,
    signaturePlacement: 'end',
    endOfReportText: '*** End of report ***',
    pageBreakPerDepartment: false,
    patientFields: ['name', 'ageGender', 'phone', 'referrer', 'patientId', 'billNo', 'registeredAt', 'receivedAt', 'collectedAt', 'reportedAt', 'status'],
  },
  billDetails: {
    header: '',
    footer: '',
    terms: '',
    showPaymentBreakup: true,
    showTestCode: true,
    showBarcode: true,
    showBilledBy: true,
    showReportDelivery: true,
    gstEnabled: false,
    gstin: '',
    gstPercent: 0,
    hsnCode: '',
    defaultPrint: 'a4',
    thermalEnabled: false,
    upiId: '',
  },
  quotation: { validityDays: 15, header: '', terms: '', prefix: 'QT' },
  signatories: [],
  b2bInvoice: {
    prefix: 'B2B',
    cycle: 'monthly',
    terms: '',
    bankName: '',
    bankAccountName: '',
    bankAccountNo: '',
    bankIfsc: '',
    upiId: '',
    detailedView: 'patient',
  },
  corporateInvoice: {
    prefix: 'CORP',
    cycle: 'monthly',
    terms: '',
    bankName: '',
    bankAccountName: '',
    bankAccountNo: '',
    bankIfsc: '',
    upiId: '',
    detailedView: 'patient',
  },
  docTemplates: { trfText: '', worksheetHeader: '', worksheetFooter: '' },
  registration: {
    requiredFields: [],
    uniqueContact: false,
    uhidMode: 'none',
    idDisplay: 'patientId',
    defaultAgeUnit: 'year',
    autoRateList: 'all',
    defaultDueBill: false,
    defaultDiscountedBy: 'none',
    salutations: ['Mr.', 'Mrs.', 'Ms.', 'Master', 'Miss', 'Dr.', 'Baby', 'B/O'],
    autoSalutationFromGender: true,
    dispatchDefaultsB2b: ['email', 'hardcopy', 'manualWhatsapp'],
    duplicateTestGuard: false,
    bulkDuplicatePolicy: 'skip',
  },
  reportEntry: {
    showPreviousResults: true,
    deltaCheckPercent: 0,
    defaultSignatoryId: '',
    criticalAckRequired: false,
    colourCodedBackground: true,
    abnormalAlertBeforeApproval: true,
    holdReasonModal: false,
    criticalWhatsappAlert: false,
    notifyOnRejection: true,
  },
  integration: { machineInterface: false },
  b2bLab: { creditLimitBehaviour: 'block', invoiceCycle: 'monthly', showDispatchedInUnit: true },
  accession: { enabled: true, mode: 'department', barcodePer: 'sample', labelSize: '50x25', autoGenerateBarcode: true },
  referrals: { commissionBasis: 'net', showCommissionOnBills: false, govPanelSendDueReport: false },
  nabl: { enabled: false, retentionDays: 7, rerunReasonModal: true, urgentRemarkModal: true, criticalRemarkModal: true, eqasMatchDays: 7 },
  tat: {
    clockStart: 'registration',
    nearbyThresholdPercent: 80,
    urgentTatPercent: 50,
    showInAccession: false,
    showInEnterVerify: false,
    showInBilling: false,
    showInPatientList: false,
  },
  patientList: {
    defaultRange: 'today',
    defaultTab: 'all',
    newestFirst: true,
    columns: ['patient', 'bill', 'referrer', 'status', 'amount', 'due'],
    voidReasonRequired: false,
  },
  features: {},
  inventory: { consumeOn: 'receipt' },
  strictPartnerPricing: false,
  extraTemplates: {
    smsReportReady: 'Dear {patientName}, your report {billNo} from {labName} is ready: {link}',
    emailSubject: 'Your report from {labName} ({billNo})',
    emailBody: 'Dear {patientName},\n\nYour report for bill {billNo} is ready. View it here: {link}\n\n{labName}',
    waReportFromB2b: 'Dear {patientName}, your report from {labName} is ready: {link}',
    waReportFromCentre: 'Dear {patientName}, your report from {labName} is ready: {link}',
    waReportToB2b: 'Report for {patientName} (bill {billNo}) is ready: {link}',
  },
}

// Plain objects merge recursively; arrays and primitives from `over` replace.
function mergeDeep<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k]
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? mergeDeep(b, v) : v === undefined ? b : v
  }
  return out as T
}

export function mergeSettings(data: Partial<LabSettings> | null | undefined): LabSettings {
  return mergeDeep(DEFAULT_SETTINGS, data ?? {})
}

export function useLabSettings(): LabSettings {
  const { data } = useLiveDoc<Partial<LabSettings>>(labDoc(), [])
  const merged = useMemo(() => mergeSettings(data), [data])
  // The shared commission calculation reads the lab's trigger (billing / report final / fully paid).
  setCommissionTrigger(merged.referrals?.commissionTrigger)
  return merged
}

// Soft-deleted rows (X-02) are hidden here; the catalogue's Deleted items view reads them with useDeletedCatalogue.
function hideDeleted<T>(r: { data: T[]; loading: boolean; error: Error | null }) {
  const data = useMemo(() => r.data.filter((x) => !(x as { deleted?: boolean }).deleted), [r.data])
  return { ...r, data }
}

export function useDepartments() {
  return hideDeleted(useLiveQuery<Department>(query(col(paths.departments), orderBy('order')), []))
}

export function useSampleTypes() {
  return hideDeleted(useLiveQuery<SampleType>(query(col(paths.sampleTypes), orderBy('name')), []))
}

export function useTests() {
  return useLiveQuery<Test>(query(col(paths.tests), orderBy('name')), [])
}

export function usePackages() {
  return hideDeleted(useLiveQuery<Package>(query(col(paths.packages), orderBy('name')), []))
}

// Soft-deleted departments, samples and packages (for the restore view).
export function useDeletedCatalogue() {
  const d = useLiveQuery<Department>(col(paths.departments), [])
  const s = useLiveQuery<SampleType>(col(paths.sampleTypes), [])
  const p = useLiveQuery<Package>(col(paths.packages), [])
  return useMemo(
    () => ({
      departments: d.data.filter((x) => x.deleted),
      sampleTypes: s.data.filter((x) => x.deleted),
      packages: p.data.filter((x) => x.deleted),
    }),
    [d.data, s.data, p.data],
  )
}

// Lookup maps so pages can resolve ids to names cheaply.
export function useCatalogueMaps() {
  const tests = useTests().data
  const departments = useDepartments().data
  const sampleTypes = useSampleTypes().data
  const packages = usePackages().data
  return useMemo(
    () => ({
      tests,
      packages,
      departments,
      sampleTypes,
      testById: new Map(tests.map((t) => [t.id, t])),
      departmentById: new Map(departments.map((d) => [d.id, d])),
      sampleTypeById: new Map(sampleTypes.map((s) => [s.id, s])),
      packageById: new Map(packages.map((p) => [p.id, p])),
    }),
    [tests, departments, sampleTypes, packages],
  )
}
