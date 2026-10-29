import type { DispatchMode } from '../../types'

export const DISPATCH_MODES: { value: DispatchMode; label: string }[] = [
  { value: 'hardcopy', label: 'Hard copy' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'manualWhatsapp', label: 'Manual WhatsApp' },
]
export const B2B_DISPATCH_MODES = DISPATCH_MODES.filter((m) => ['email', 'hardcopy', 'manualWhatsapp'].includes(m.value))

export const REGISTRATION_FIELDS = [
  ['lastName', 'Last name'], ['phone', 'Phone'], ['email', 'Email'], ['address', 'Address'], ['aadhaar', 'Aadhaar'],
  ['uhid', 'UHID'], ['insuranceNo', 'Insurance no.'], ['phlebotomist', 'Phlebotomist'], ['referrer', 'Referring doctor'],
  ['collectedAt', 'Collected at'], ['hospital', 'Hospital'], ['pro', 'PRO'], ['secondReferrer', 'Second referrer'],
  ['govPanel', 'Government panel'], ['rateList', 'Rate list'], ['tpa', 'TPA'], ['collectionDateTime', 'Collection date and time'],
  ['dispatch', 'Dispatch methods'], ['b2bCentre', 'B2B centre'], ['company', 'Company'], ['category', 'Category'],
  ['payment', 'Payment'], ['weight', 'Weight'], ['height', 'Height'], ['corporateUser', 'Corporate user'],
  ['corporatePlan', 'Corporate plan'], ['pincode', 'Pincode'], ['district', 'District'], ['town', 'Town'],
  ['collectionCentre', 'Collection centre'], ['clinicalHistory', 'Clinical history'],
  ['species', 'Species (animal patient)'], ['breed', 'Breed (animal patient)'], ['owner', 'Owner name (animal patient)'],
].map(([value, label]) => ({ value, label }))

export const PATIENT_BLOCK_FIELDS = [
  ['name', 'Patient name'], ['ageGender', 'Age and gender'], ['patientId', 'Patient ID'], ['uhid', 'UHID'], ['billNo', 'Bill number'],
  ['phone', 'Phone'], ['referrer', 'Referred by'], ['collectedAt', 'Collected at'], ['receivedAt', 'Received at'],
  ['reportedAt', 'Reported at'], ['sampleType', 'Sample type'], ['barcode', 'Sample ID / barcode'], ['address', 'Address'],
].map(([value, label]) => ({ value, label }))

export const PATIENT_LIST_COLUMNS = [
  ['patient', 'Patient'], ['bill', 'Bill no.'], ['date', 'Date'], ['referrer', 'Referrer'], ['status', 'Status'],
  ['amount', 'Amount'], ['paid', 'Paid'], ['due', 'Due'], ['dispatch', 'Dispatch'], ['tat', 'TAT'], ['branch', 'Branch'],
].map(([value, label]) => ({ value, label }))

export const CYCLES = [
  { value: 'perBill', label: 'Per bill' }, { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' },
]

export const PREVIEW_VARS: Record<string, string> = {
  patientName: 'Asha Verma', labName: 'Healthcare Labs', billNo: 'HCL1042', link: 'https://lab.example.com/r/AbC123',
  bookingId: 'BK1007', slot: '15 Oct 2026, 07:00-08:00', collectorName: 'Ravi', amount: '₹850',
}
