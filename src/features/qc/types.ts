import type { Timestamp } from 'firebase/firestore'

// Firestore collection names (all live under labs/{lab}/).
export const QC = {
  machines: 'qcMachines',
  materials: 'qcMaterials',
  runs: 'qcRuns',
  capas: 'capas',
  eqas: 'eqasRounds',
  ilc: 'ilcStudies',
  validation: 'validationStudies',
  discards: 'sampleDiscards',
  iqcDownloads: 'iqcDownloads',
  occurrences: 'qcOccurrences',
} as const

export type QcLevel = 'L1' | 'L2' | 'L3'
export const QC_LEVELS: QcLevel[] = ['L1', 'L2', 'L3']

export type WestgardRule = '1-2s' | '1-3s' | '2-2s' | 'R-4s' | '4-1s' | '10x'
export const WESTGARD_RULES: WestgardRule[] = ['1-2s', '1-3s', '2-2s', 'R-4s', '4-1s', '10x']
export type QcStatus = 'pass' | 'warning' | 'fail'

export interface QcMachine {
  id: string
  name: string
  departmentId: string
  serial: string
  testIds: string[]
  active: boolean
  machineCode?: string // machine ID / short code
  model?: string
  schedules?: QcSchedule[]
  notApplicable?: QcNotApplicable[] // scheduled slots excused (e.g. machine down)
}

export type QcFrequency = 'daily' | 'weekly' | 'monthly'

// One QC schedule on a machine: which kit, how often and when. Stored on the machine document.
export interface QcSchedule {
  id: string
  materialId: string // '' = any kit
  frequency: QcFrequency
  days: number[] // weekly: 0 (Sun) to 6; monthly: day of month 1 to 31; ignored for daily
  times: string[] // HH:mm
  level: QcLevel | 'all'
  active: boolean
  graceMinutes?: number // a slot counts as missed only after this many minutes (default 30)
  // How slots are generated: 'time' = the fixed times above (default); 'perShift' = one run per
  // lab shift (QcSettings.shifts); 'perNPatients' = a run is due after every N patient samples on the machine.
  recurrence?: 'time' | 'perShift' | 'perNPatients'
  shiftIds?: string[] // perShift: which shifts need a run (empty = all)
  everyNPatients?: number // perNPatients
  assignedTo?: string // staff uid expected to run it (shown on the occurrence)
}

// A lab shift (QC runs per shift). `end` earlier than `start` means the shift crosses midnight.
export interface QcShift {
  id: string
  name: string
  start: string // HH:mm
  end: string // HH:mm
}

// Persisted scheduled slot (QC-23): SCHEDULED -> IN_PROGRESS -> SUBMITTED -> PASSED / WARNING / FAILED
// -> CAPA_OPEN / APPROVED, or MISSED / NOT_APPLICABLE. Written by lib/occurrences.ts syncOccurrences.
export type QcOccurrenceStatus = 'scheduled' | 'inProgress' | 'submitted' | 'passed' | 'warning' | 'failed' | 'capaOpen' | 'approved' | 'missed' | 'notApplicable'
export interface QcOccurrence {
  id: string // machineId__scheduleId__day__slotKey
  branchId?: string
  machineId: string
  machineName: string
  scheduleId: string
  materialId: string
  day: string // YYYY-MM-DD (day the slot starts)
  slotKey: string // HH:mm, or the shift id
  slotLabel: string // HH:mm, or the shift name
  dueAt: number // ms
  endAt: number // ms (shift end; = dueAt for timed slots)
  status: QcOccurrenceStatus
  runId?: string
  runNo?: string
  assignedTo?: string
  updatedAt?: Timestamp | null
}

// A reset of the multi-point rules (calibration, reagent / lot change). Runs before `at` are ignored by the rules.
export interface QcSeriesReset {
  id: string
  at: number
  reason: string
  machineId?: string // empty = every machine running the lot
  by: string
  byName: string
}

// A scheduled slot marked "not applicable" (e.g. machine down); excluded from the missed count.
export interface QcNotApplicable {
  id: string
  machineId: string
  scheduleId: string
  day: string // YYYY-MM-DD
  time: string // HH:mm
  reason: string
  by: string
  byName: string
  at: number
}

// Lab-wide QC options, stored as `qcSettings` on the lab document.
export interface QcSettings {
  levelCount: 2 | 3
  showMeasurementUncertainty: boolean
  rules: WestgardRule[]
  approvalEnabled: boolean
  outlierNature: boolean
  investigationChecklist: boolean
  remedialAction: boolean
  patientResultManagement: boolean
  rootCauseAnalysis: boolean
  capa: boolean
  followUp: boolean
  matchWindowHours: number
  // Severity override per Westgard rule (default: 1-2s warning, others reject).
  ruleSeverity?: Partial<Record<WestgardRule, 'warning' | 'fail'>>
  // ILC acceptance limits per test|parameter (percent). Falls back to ilcDefaultLimitPct.
  ilcAcceptance?: Record<string, number>
  ilcDefaultLimitPct?: number
  graceMinutes?: number
  shifts?: QcShift[]
  // Westgard profile: evaluate the multi-point rules across levels and / or across runs (default both).
  westgard?: { acrossLevels: boolean; acrossRuns: boolean }
  // Per-parameter rule override, key testId|paramKey. Wins over the lot's rule list.
  paramRules?: Record<string, WestgardRule[]>
  // Allowable total error (TEa, percent) per testId|paramKey, with optional per-level key testId|paramKey|L1.
  tea?: Record<string, number>
  // Manufacturer-claimed CV (percent) per testId|paramKey, used for sigma and validation precision.
  claimCv?: Record<string, number>
  // EQAS evaluation limits.
  eqasMode?: 'sdi' | 'percent'
  eqasSdiWarn?: number // default 2
  eqasSdiFail?: number // default 3
  eqasPctLimit?: number // used when eqasMode is percent
}
export const DEFAULT_QC_SETTINGS: QcSettings = {
  levelCount: 2,
  showMeasurementUncertainty: false,
  rules: ['1-2s', '1-3s', '2-2s', 'R-4s', '4-1s', '10x'],
  approvalEnabled: false,
  outlierNature: true,
  investigationChecklist: true,
  remedialAction: true,
  patientResultManagement: true,
  rootCauseAnalysis: true,
  capa: true,
  followUp: false,
  matchWindowHours: 24,
  ruleSeverity: {},
  ilcAcceptance: {},
  ilcDefaultLimitPct: 10,
  graceMinutes: 30,
  westgard: { acrossLevels: true, acrossRuns: true },
  paramRules: {},
  tea: {},
  claimCv: {},
  eqasMode: 'sdi',
  eqasSdiWarn: 2,
  eqasSdiFail: 3,
  eqasPctLimit: 10,
}

// Control limits for one parameter at one level of a lot.
export interface QcTarget {
  testId: string
  paramKey: string
  level: QcLevel
  mean: number
  sd: number
  machineId?: string // '' / missing = applies to every machine that runs the kit
}

// One earlier version of a lot's targets (kept when mean / SD are edited after results exist).
export interface QcTargetVersion {
  version: number
  at: number
  byName: string
  reason: string
  targets: QcTarget[]
}

export interface QcMaterial {
  id: string
  name: string
  manufacturer: string
  lotNo: string
  expiry: string // YYYY-MM-DD
  levels: QcLevel[]
  targets: QcTarget[]
  rules: WestgardRule[] // enabled Westgard rules for this material
  active: boolean
  targetVersion?: number // 1 when missing; bumped when targets are edited
  targetHistory?: QcTargetVersion[]
  seriesResets?: QcSeriesReset[]
  // Lot lifecycle. Missing = derived from active / expiry. See lib/lot.ts lotStatus.
  lifecycle?: LotLifecycle
  startDate?: string // YYYY-MM-DD the lot goes into use (planned until then)
  openedDate?: string
  retiredAt?: number
  retiredReason?: string
  targetSource?: TargetSource
  establishedFromRuns?: number // N runs the targets were established from
}
export type LotLifecycle = 'planned' | 'active' | 'expired' | 'retired'
export type TargetSource = 'manufacturer' | 'established' | 'peer' | 'imported'

export interface QcViolation {
  rule: WestgardRule
  level: QcLevel | 'all'
  message: string
  severity: 'warning' | 'fail'
  testId: string
  paramKey: string
}

export interface QcRunResult {
  testId: string
  testName: string
  paramKey: string
  paramName: string
  level: QcLevel
  value: number
  z: number
  mean?: number // snapshot of the target used (so later target edits never change history)
  sd?: number
  targetVersion?: number
  outcome?: QcStatus
  excluded?: boolean
  excludeReason?: string
}

export type QcApproval = 'notRequired' | 'pending' | 'approved'

export interface QcRun {
  id: string
  machineId: string
  machineName: string
  departmentId: string
  materialId: string
  materialName: string
  lotNo: string
  results: QcRunResult[]
  status: QcStatus
  violations: QcViolation[]
  note: string
  runBy: string
  runByName: string
  runAt: Timestamp | null
  runNo?: string // QC-YYMMDD-nnn
  late?: boolean // back-dated entry
  lateReason?: string
  scheduleId?: string
  occurrenceId?: string // the scheduled slot this run satisfies
  targetVersion?: number
  approval?: QcApproval
  approvedBy?: string
  approvedByName?: string
  approvedAt?: Timestamp | null
  approveRemark?: string
  outlier?: { nature?: string; checklist?: string[]; remedial?: string; rca?: string; patientImpact?: string; followUp?: string }
  deleted?: boolean
  deleteReason?: string
  deletedByName?: string
  source?: 'analyser' // machine-fed run (written by the analyser ingest function)
  multiruleChecked?: boolean // machine-fed run re-evaluated with the Westgard multi-rules
  rescheduledFrom?: Timestamp | null
  rescheduleReason?: string
}

export interface Capa {
  id: string
  runId: string
  machineName: string
  cause: string
  correctiveAction: string
  preventiveAction: string
  owner: string
  status: 'open' | 'actionTaken' | 'verified' | 'closed'
  machineId?: string
  capaNo?: string // CAPA-YYYY-nnnn
  sourceType?: 'iqc' | 'eqas' | 'ilc' | 'validation' | 'manual'
  sourceId?: string
  rootCauseCategory?: string
  dueDate?: string // YYYY-MM-DD (default 3 days)
  patientImpactAssessed?: boolean
  outlierNature?: string
  investigation?: string[]
  remedialAction?: string
  followUp?: string
  repeatRunId?: string // passing repeat run that verified the fix
  closeRemark?: string
  createdBy: string
  createdAt: Timestamp | null
  closedAt: Timestamp | null
}

export type EqasOutcome = 'acceptable' | 'warning' | 'unacceptable' | 'notEvaluated'

export interface EqasRound {
  id: string
  provider: string
  round: string
  sampleId: string
  testId: string
  testName: string
  paramKey: string
  paramName: string
  ourResult: number
  peerMean: number
  peerSd: number
  sdi: number | null
  devPct: number | null
  outcome: EqasOutcome
  status: 'scheduled' | 'pending' | 'completed' | 'verified' | 'deleted' | 'notPerformed'
  notPerformedReason?: string
  notPerformedBy?: string
  reportUrl?: string
  verifiedByName?: string
  verifiedAt?: Timestamp | null
  deleteReason?: string
  rescheduledFrom?: string // original due date
  rescheduleReason?: string
  rescheduleHistory?: { from: string; to: string; reason: string; byName: string; at: number }[]
  cycle?: string // programme cycle label, e.g. "2026"
  cycleStart?: string // YYYY-MM-DD
  cycleEnd?: string
  frequency?: string // e.g. monthly, quarterly
  programmeId?: string // EQAS ID given by the provider
  machineId?: string
  machineName?: string
  sampleType?: string
  dueDate?: string // YYYY-MM-DD, when the round must be run
  notes: string
  date: Timestamp
  createdBy: string
  createdByName: string
  createdAt: Timestamp | null
}

export interface ApprovalRecord {
  approverName: string
  designation: string
  remarks: string
  by: string
  at: number
}

// One parameter of a multi-parameter ILC study.
export interface IlcParam {
  testId: string
  testName: string
  paramKey: string
  paramName: string
  ourResult: number
  theirResult: number
  peerSd?: number // SD used for the SDI
  diffPct: number | null
  sdi: number | null
  limitPct: number
  outcome: 'acceptable' | 'unacceptable' | 'notEvaluated'
}

export interface IlcStudy {
  params?: IlcParam[] // all parameters; the top-level fields mirror the first one
  id: string
  partnerLab: string
  partnerLabId?: string
  machineId?: string
  machineName?: string
  sampleType?: string
  sampleId: string
  testId: string
  testName: string
  paramKey: string
  paramName: string
  ourResult: number
  theirResult: number
  diffPct: number | null
  limitPct: number
  outcome: 'acceptable' | 'unacceptable' | 'notEvaluated'
  status?: 'draft' | 'approved' | 'rejected' // missing = draft
  approval?: ApprovalRecord
  capaId?: string
  deleted?: boolean
  deleteReason?: string
  notes: string
  date: Timestamp
  createdBy: string
  createdByName: string
  createdAt: Timestamp | null
}

export type ValidationType = 'carryOver' | 'linearity' | 'intraAssay' | 'interAssay' | 'interEquipment' | 'accuracy' | 'referenceInterval'

export interface ValidationCriteria {
  [k: string]: number
}

export interface ValidationStudy {
  id: string
  type: ValidationType
  machineId: string
  machineName: string
  machineBId: string
  machineBName: string
  testId: string
  testName: string
  paramKey: string
  paramName: string
  // Firestore forbids arrays directly inside arrays, so each row is wrapped.
  rows: { v: number[] }[]
  criteria: ValidationCriteria
  computed: Record<string, number | null>
  checks: { label: string; pass: boolean; detail: string }[]
  outcome: 'pass' | 'fail' | 'inconclusive'
  status?: 'draft' | 'completed' | 'approved' // missing = draft
  approval?: ApprovalRecord
  capaId?: string
  deleted?: boolean
  deleteReason?: string
  notes: string
  date: Timestamp
  performedBy: string
  performedByName: string
  createdAt: Timestamp | null
}

export interface SampleDiscard {
  id: string
  orderIds: string[]
  items: { orderId: string; billNo: string; barcode: string; receivedAt: Timestamp | null }[]
  count: number
  method: string
  retentionDays: number
  discardedBy: string
  discardedByName: string
  verifiedBy: string // '' while waiting for verification
  verifiedByName: string
  verifiedAt?: Timestamp | null
  discardedAt: Timestamp
  createdAt: Timestamp | null
}
