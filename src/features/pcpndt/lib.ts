import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { db, LAB_ID } from '../../firebase'
import { docRef, paths } from '../../lib/db'
import type { LabSettings, Order } from '../../types'

// PCPNDT Form F: one record per bill at labs/{lab}/formF/{orderId}.
export type FormFStatus = 'draft' | 'awaitingSignature' | 'complete'

export interface FormFFields {
  patientName: string
  age: string
  guardianName: string // husband / father
  address: string
  lmp: string
  childrenSons: string
  childrenDaughters: string
  lastChildAge: string
  previousProcedures: string
  geneticHistory: string
  indication: string
  procedure: string
  referrerName: string
  referrerAddress: string
  performedBy: string
  declaration: boolean
}

export interface FormFDoc {
  orderId: string
  billNo: string
  patientName: string
  status: FormFStatus
  fields: Partial<FormFFields>
  signatureDataUrl?: string
  signerName?: string
  signedAt?: unknown
  signedVia?: 'link' | 'inPerson'
  manual?: boolean // marked filled from a paper form
  manualNote?: string
  signToken?: string
}

export const INDICATIONS = [
  'Dating of pregnancy and growth monitoring',
  'Suspected foetal abnormality',
  'Bleeding or pain in early pregnancy',
  'Follow-up of a previous abnormal scan',
  'Assessment of foetal wellbeing in late pregnancy',
  'Other (write below)',
]

export const formFDoc = (orderId: string) => doc(db, 'labs', LAB_ID, 'formF', orderId)

export const FORM_F_REQUIRED: (keyof FormFFields)[] = ['patientName', 'age', 'guardianName', 'address', 'lmp', 'indication', 'procedure', 'referrerName', 'performedBy']

export function missingFormF(f: Partial<FormFFields>): string[] {
  return FORM_F_REQUIRED.filter((k) => !String(f[k] ?? '').trim()).map((k) => k)
}

// Is the ultrasound report held back by an incomplete Form F?
export function formFBlocked(order: Pick<Order, 'pcpndt' | 'formFStatus'> | null | undefined, settings: Pick<LabSettings, 'pcpndt'>): boolean {
  if (!order?.pcpndt) return false
  if (settings.pcpndt?.blockReport === false) return false
  return order.formFStatus !== 'complete'
}

export async function saveFormF(order: Pick<Order, 'id' | 'billNo' | 'patientName'>, fields: Partial<FormFFields>, by: string) {
  await setDoc(
    formFDoc(order.id),
    { orderId: order.id, billNo: order.billNo, patientName: order.patientName, fields, status: 'draft', updatedBy: by, updatedAt: serverTimestamp() },
    { merge: true },
  )
  await updateDoc(docRef(paths.orders, order.id), { formFStatus: 'pending' })
}

// Staff capture the patient's signature on the screen.
export async function completeFormFInPerson(order: Pick<Order, 'id' | 'billNo' | 'patientName'>, fields: Partial<FormFFields>, signatureDataUrl: string, signerName: string, by: string) {
  await setDoc(
    formFDoc(order.id),
    { orderId: order.id, billNo: order.billNo, patientName: order.patientName, fields, status: 'complete', signatureDataUrl, signerName, signedAt: serverTimestamp(), signedVia: 'inPerson', updatedBy: by, updatedAt: serverTimestamp() },
    { merge: true },
  )
  await updateDoc(docRef(paths.orders, order.id), { formFStatus: 'complete' })
}

// "Form F filled" mark: a paper form is on file. The note says where.
export async function markFormFFilled(order: Pick<Order, 'id' | 'billNo' | 'patientName'>, filled: boolean, note: string, by: string) {
  await setDoc(
    formFDoc(order.id),
    { orderId: order.id, billNo: order.billNo, patientName: order.patientName, status: filled ? 'complete' : 'draft', manual: filled, manualNote: note, updatedBy: by, updatedAt: serverTimestamp() },
    { merge: true },
  )
  await updateDoc(docRef(paths.orders, order.id), { formFStatus: filled ? 'complete' : 'none' })
}
