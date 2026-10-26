import type { Timestamp } from 'firebase/firestore'
import type { Order, Patient } from '../../types'

// Optional order fields written by registration / partner / outsource work.
// Everything is optional: the list reads them defensively so older bills still work.
export interface OrderExtra {
  uhid?: string
  referrerId?: string
  referrerType?: 'doctor' | 'hospital'
  hospitalName?: string
  secondReferrerName?: string
  b2bCentreId?: string
  b2bCentreName?: string
  collectionCentreId?: string
  collectionCentreName?: string
  corporateClientId?: string
  corporateClientName?: string
  govPanelId?: string
  govPanelName?: string
  proId?: string
  proName?: string
  phlebotomistId?: string
  phlebotomistName?: string
  outsourced?: boolean
  processingLabId?: string
  smartReport?: boolean
  abhaLinked?: boolean
  printed?: boolean
  printedAt?: Timestamp
  printedBy?: string
  hardCopyDeliveredAt?: Timestamp
  createdByName?: string
  voidReason?: string
}

export type PatientOrder = Order & OrderExtra

// Optional patient fields added by the Edit Patient / UHID work.
export interface PatientExtra {
  uhid?: string
  aadhaar?: string
  abhaNumber?: string
  abhaAddress?: string
  referrerHospital?: string
  merged?: boolean
  mergedInto?: string
  mergedFrom?: string[]
  mergedAt?: Timestamp
  mergeMoved?: { orders: string[]; quotations: string[]; bookings: string[] } // what the merge re-pointed, so it can be restored
}
export type PatientDoc = Patient & PatientExtra

export interface PatientDocument {
  id: string
  name: string
  mime: string
  size: number
  note: string
  dataUrl: string // base64 data URL, at most 500 KB of file content
  uploadedBy: string
  uploadedByName: string
  uploadedAt: Timestamp
}

export interface Filters {
  referrer?: string
  hospital?: string
  secondReferrer?: string
  b2b?: string
  collectionCentre?: string
  corporate?: string
  pro?: string
  phlebotomist?: string
  department?: string
  test?: string
  pkg?: string
  paymentMode?: string
  reportStatus?: string
  createdBy?: string
  branch?: string
  urgent?: boolean
  smartReport?: boolean
  selfWalking?: boolean
  abhaLinked?: boolean
  printed?: 'any' | 'yes' | 'no'
  billSort?: 'desc' | 'asc'
}
