import type { Timestamp } from 'firebase/firestore'
import type { AiInterpretation, Order, ParamValue, TestResult } from '../../types'

// Extra fields this module keeps on result / order docs (read defensively; all optional).
export type ResultStatus = TestResult['status'] | 'rejected'

export interface MachineRun {
  id: string
  label: string
  at?: number
  values: Record<string, string>
  mic?: Record<string, string> // MIC sent by the machine, by parameter key
}

export interface SampleIssue {
  type: 'haemolysed' | 'lipaemic' | 'clotted' | 'insufficient' | 'other'
  note: string
  by: string
  byName: string
  at: number
}

export interface Ack {
  by: string
  byName: string
  at: number
  note?: string
  // Critical value reporting: who was told, how, and whether they read the value back.
  notifiedTo?: string
  mode?: 'phone' | 'inPerson' | 'whatsapp' | 'other'
  readBack?: boolean
}

export interface SentBack {
  reason: string
  by: string
  byName: string
  at: number
}

export interface ResultExt extends Omit<TestResult, 'status'> {
  status: ResultStatus
  rerun?: boolean
  rerunCount?: number
  rerunReason?: string
  holdReason?: string
  issues?: SampleIssue[]
  machineValues?: unknown
  paramComments?: Record<string, string>
  rejected?: { reason: string; by: string; byName: string; at: number; params?: string[] }
  rejectedParams?: string[]
  criticalAck?: Ack | null
  criticalAlerts?: (Ack & { params: string })[] // alert log, newest last
  releaseType?: 'final' | 'provisional'
  sentBack?: SentBack | null
  amendments?: { reason: string; by: string; byName: string; at: number }[]
  heldBy?: string
  heldAt?: number
  showInterpretation?: boolean
  signatoryId?: string // per-test signatory chosen at result entry (the report honours it)
  verification?: { requestedBy: string; requestedByName: string; at: number } | null
  aiInterpretation?: AiInterpretation
  radiology?: { findings?: string; impression?: string }
  // Round 3 additions (all optional so older results keep working)
  draft?: DraftSave | null // autosaved, unsaved edits (never reported)
  holdTotalMs?: number // total time the test spent on hold (TAT call site may subtract it)
  holdLog?: { by: string; byName: string; from: number; to: number; ms: number; reason: string }[]
  rangeEditLog?: RangeEdit[] // every reference-range edit made on this result
  commentOnReport?: boolean // false hides the test comment on the report (default shown)
  paramCommentHidden?: Record<string, boolean> // parameter comments hidden on the report
  rejectedValues?: Record<string, ParamValue> // values of rejected parameters, kept but struck out
  autoVerified?: boolean // approved by the auto-verification rules, not by a person
  autoVerifiedAt?: unknown
  autoVerifyRuleVersion?: number
  autoVerifyCheck?: { at: number; passed: boolean; reasons: string[]; ruleVersion: number } // why the last machine result was or was not auto-verified
  signatureSnapshots?: SignatureSnapshot[] // up to 3 signatories frozen when approved
  machineId?: string
  machineName?: string // analyser that sent the machine values
}

export interface DraftSave {
  values: Values
  comment: string
  paramComments: Record<string, string>
  by: string
  byName: string
  at: number
}
export interface RangeEdit {
  param: string
  paramName: string
  from: string
  to: string
  reason: string
  by: string
  byName: string
  at: number
}
export interface SignatureSnapshot {
  id: string
  name: string
  qualification: string
  registrationNo: string
  signatureDataUrl: string
  designation: string
  hideNameInReport: boolean
}

export interface OrderExt extends Order {
  reportNote?: string
  reportSignatoryId?: string
  reportAttachmentNote?: string
  rerunTests?: string[]
  collectionPhotos?: string[]
  collectionPhotoFiles?: import('../../lib/accession').PhotoMeta[]
  patientCondition?: string // condition picked at result entry (pregnancy etc.): selects condition-specific ranges
  reportSignatoryIds?: string[] // up to 3 signatories chosen for the report
  assignedToId?: string // technician the bill is assigned to (worklist)
  assignedToName?: string
  b2bCentreId?: string
  b2bCentreName?: string
  collectionCentreId?: string
  collectionCentreName?: string
  collectionType?: string
  hasMachineValue?: boolean
}

export type Values = Record<string, ParamValue>
export type { Timestamp }

export const ISSUE_LABEL: Record<SampleIssue['type'], string> = {
  haemolysed: 'Haemolysed sample',
  lipaemic: 'Lipaemic sample',
  clotted: 'Clotted sample',
  insufficient: 'Insufficient sample',
  other: 'Other',
}

function micOf(o: unknown): Record<string, string> | undefined {
  const src = o && typeof o === 'object' && 'values' in (o as object) ? (o as { values: unknown }).values : undefined
  const out: Record<string, string> = {}
  if (src && typeof src === 'object') for (const [k, v] of Object.entries(src as object)) if (v && typeof v === 'object' && (v as { mic?: unknown }).mic) out[k] = String((v as { mic: unknown }).mic)
  return Object.keys(out).length ? out : undefined
}

// Normalises result.machineValues: either a flat { paramKey: value } map or a list of runs.
export function machineRuns(raw: unknown): MachineRun[] {
  if (!raw || typeof raw !== 'object') return []
  const val = (x: unknown): string => {
    if (x && typeof x === 'object' && 'value' in x) return String((x as { value: unknown }).value ?? '')
    return x === null || x === undefined ? '' : String(x)
  }
  const toValues = (o: unknown): Record<string, string> => {
    const src = o && typeof o === 'object' && 'values' in (o as object) ? (o as { values: unknown }).values : o
    const out: Record<string, string> = {}
    if (src && typeof src === 'object') for (const [k, v] of Object.entries(src as object)) out[k] = val(v)
    return out
  }
  if (Array.isArray(raw)) {
    return raw.map((r, i) => {
      const at = r && typeof r === 'object' ? (r as { at?: unknown }).at : undefined
      const ms = at && typeof (at as Timestamp).toMillis === 'function' ? (at as Timestamp).toMillis() : typeof at === 'number' ? at : undefined
      const name = r && typeof r === 'object' ? ((r as { machine?: string; label?: string }).machine || (r as { label?: string }).label) : ''
      return { id: String(i), label: name || `Run ${i + 1}`, at: ms, values: toValues(r), mic: micOf(r) }
    })
  }
  const values = toValues(raw)
  return Object.keys(values).length ? [{ id: '0', label: 'Analyser value', values }] : []
}
