// Key image. New images live in Firebase Storage (`path`); older reports keep a `dataUrl` inside the report.
export interface RadImage {
  id: string
  name: string
  dataUrl?: string
  path?: string
  contentType?: string
  caption?: string
  size?: number
}

export interface SecondOpinion {
  doctorId: string
  doctorName: string
  note: string
  requestedBy: string
  requestedByName: string
  requestedAt: number
  status: 'requested' | 'given' | 'declined'
  opinion: string
  external?: boolean // asked of an outside consultant by email
  externalEmail?: string
  externalRegNo?: string
  cosigned?: boolean // the second reader co-signs the report; both names print
  cosignedByName?: string
  givenAt?: number
  declineReason?: string
}

export interface RadiologyData {
  modality: string
  templateId: string
  technique: string
  findings: string
  impression: string
  images: RadImage[]
  dicomUrl: string
  dicomStudyUid?: string
  bodyPart?: string
  contrastNote?: string
  amended?: boolean
  signatoryId: string
  holdReason: string
  secondOpinion: SecondOpinion | null
}

export interface RadTemplate {
  id: string
  kind: 'radiology'
  name: string
  modality: string
  technique: string
  findings: string
  impression: string
  variant?: 'normal' | 'abnormal'
  active: boolean
}

export interface RadMacro {
  id: string
  kind: 'radMacro'
  label: string
  text: string
  active: boolean
  ownerUid?: string // set on per-user macros (labs/{lab}/userMacros)
}

export const EMPTY_RAD: RadiologyData = {
  modality: '',
  templateId: '',
  technique: '',
  findings: '',
  impression: '',
  images: [],
  dicomUrl: '',
  dicomStudyUid: '',
  bodyPart: '',
  contrastNote: '',
  signatoryId: '',
  holdReason: '',
  secondOpinion: null,
}

export type RadStatus = 'pending' | 'hold' | 'second' | 'completed' | 'delivered'
