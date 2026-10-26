import {
  collection,
  doc,
  runTransaction,
  type CollectionReference,
  type DocumentReference,
} from 'firebase/firestore'
import dayjs from 'dayjs'
import { db, LAB_ID } from '../firebase'
import { branchCounterName, getActiveBranch } from './activeBranch'

// Every lab document lives under labs/{LAB_ID}/...
export const labDoc = () => doc(db, 'labs', LAB_ID)
export const col = <T = unknown>(name: string) =>
  collection(db, 'labs', LAB_ID, name) as CollectionReference<T>
export const docRef = <T = unknown>(name: string, id: string) =>
  doc(db, 'labs', LAB_ID, name, id) as DocumentReference<T>

export const paths = {
  users: 'users',
  departments: 'departments',
  sampleTypes: 'sampleTypes',
  tests: 'tests',
  packages: 'packages',
  patients: 'patients',
  orders: 'orders',
  counters: 'counters',
  bookings: 'bookings',
  outbox: 'outbox',
} as const

// Sub-collections of an order.
export const ledgerCol = (orderId: string) =>
  collection(db, 'labs', LAB_ID, 'orders', orderId, 'ledger')
export const deliveriesCol = (orderId: string) =>
  collection(db, 'labs', LAB_ID, 'orders', orderId, 'deliveries')
export const resultsCol = (orderId: string) =>
  collection(db, 'labs', LAB_ID, 'orders', orderId, 'results')
export const resultDoc = (orderId: string, testId: string) =>
  doc(db, 'labs', LAB_ID, 'orders', orderId, 'results', testId)
export const versionsCol = (orderId: string, testId: string) =>
  collection(db, 'labs', LAB_ID, 'orders', orderId, 'results', testId, 'versions')

// Atomically take the next value of a named counter.
export async function nextCounter(name: string): Promise<number> {
  const ref = docRef<{ value: number }>(paths.counters, name)
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    const value = (snap.exists() ? snap.data().value : 0) + 1
    tx.set(ref, { value })
    return value
  })
}

// Patient number: YYMMDD + 3-digit daily sequence (resets each day).
export async function nextPatientNo(): Promise<string> {
  const day = dayjs().format('YYMMDD')
  const seq = await nextCounter(`patient-${day}`)
  return `${day}${String(seq).padStart(3, '0')}`
}

// Bill number: prefix + one lab-wide sequence shared by every branch (e.g. HCL1042).
// The branch still travels on the bill (branchId); only the counter is shared.
// A branch bill prefix, when set, replaces the lab prefix.
export async function nextBillNo(labPrefix: string): Promise<string> {
  const b = getActiveBranch()
  const prefix = b.billPrefix?.trim() || labPrefix
  return `${prefix}${await nextCounter('bill')}`
}

// One barcode per bill by default (6 digits, sequence per branch).
export async function nextBarcode(): Promise<string> {
  return String(await nextCounter(branchCounterName('barcode'))).padStart(6, '0')
}
