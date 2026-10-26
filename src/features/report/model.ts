import type { Parameter, ParamValue, ReportDetailsSettings, ReportStatus } from '../../types'
import type { FullLayout } from './layout'

// Everything the report renderer needs, independent of where it came from
// (staff preview reads Firestore, the public page reads the getPublicReport payload).
export interface RSig {
  id?: string
  name: string
  qualification?: string
  registrationNo?: string
  signatureDataUrl?: string
  hideNameInReport?: boolean
  designation?: string
  signatureHeight?: number | null
  align?: string
  defaultForDepartmentIds?: string[]
  stampDataUrl?: string
}

export interface RTest {
  id: string
  name: string
  departmentId: string
  order: number
  interpretation: string
  parameters: Parameter[]
  startOnNewPage?: boolean
  translations?: Record<string, string>
  startNextPage?: boolean // editor writes this together with startOnNewPage
  interpretationEnabled?: boolean // per-test switch for printing the interpretation (default on)
  comments?: string // test-level comment printed under the results
  sampleTypeName?: string
  templateId?: string // report template that applies (test's own, else its department's)
  interpretationHtml?: string // formatted interpretation (sanitised); falls back to `interpretation`
}

export interface RRadiology {
  findings?: string
  impression?: string
  technique?: string
  images?: { id: string; name: string; dataUrl?: string; path?: string; caption?: string }[]
  modality?: string
  secondOpinion?: { doctorName: string; opinion: string; external?: boolean; cosignedBy?: string } | null
  bodyPart?: string
  contrastNote?: string
}

export interface RResult {
  testId: string
  status: string
  values: Record<string, ParamValue>
  comment?: string
  paramComments?: Record<string, string>
  rejectedParams?: string[]
  rejected?: { reason?: string }
  issues?: { type: string; note: string }[]
  showInterpretation?: boolean
  approvedByName?: string
  signatoryId?: string
  signatorySnapshot?: RSig | null
  signatureSnapshots?: RSig[] // up to 3 signatories frozen at approval (preferred)
  commentOnReport?: boolean // false hides the test comment
  paramCommentHidden?: Record<string, boolean>
  radiology?: RRadiology | null
  machineName?: string
}

export interface ROrder {
  billNo: string
  patientName: string
  patientNo: string
  uhid: string
  phone: string
  address: string
  gender: string
  ageValue: number
  ageUnit: 'year' | 'month' | 'day'
  referrerName: string
  barcode: string
  createdAt: Date | null
  collectedAt: Date | null
  receivedAt: Date | null
  reportedAt: Date | null
  reportStatus: ReportStatus
  reportSignatoryId: string
  reportNote: string
  reportRevision: number
  amendSummary: string
  billDate?: Date | null
  ageDays?: number // age in days at collection (range lookup)
  condition?: string // patient condition picked at result entry
  fields?: Record<string, string> // pre-resolved patient block values (partner names, email, dob, ...)
  pending?: string[] // names of tests still awaited
  packages?: string[]
  disableLetterhead?: boolean // corporate client flag: print without letterhead / header / footer
}

export interface ReportModel {
  lab: { name: string; address: string; phone: string; email: string; website: string; city: string; logoDataUrl: string; dateFormat: string }
  rd: ReportDetailsSettings
  layout?: FullLayout
  templateLayouts?: Record<string, Partial<FullLayout>> // layout overrides carried by report templates, by template id
  idDisplay: string
  order: ROrder
  signatories: RSig[]
  defaultSignatoryId: string
  depts: { id: string; name: string; order: number }[]
  tests: RTest[] // already in display order (department, then test order)
  results: RResult[]
  qrUrl: string
  reportFile?: { name: string; dataUrl: string } | null
  attachNote?: string
}

export interface ReportOpts {
  letterhead: boolean
  header: boolean
  footer: boolean
  perDept: boolean
  perTest: boolean
  compare: boolean
  abnSummary: boolean
  qr: boolean
  barcode: boolean
  pageSize: 'A4' | 'A5' | 'Letter'
  picked: string[]
  interpretation: boolean | null // null = per-test setting
  duplicate: boolean
  lang?: string // report language code; undefined = English
  letterheadId?: string // letterhead from the library (header / footer images)
}

export type PrevMap = Record<string, { date: Date | null; values: Record<string, ParamValue> }[]>
