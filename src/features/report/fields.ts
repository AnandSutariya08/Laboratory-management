import type { Order, Patient } from '../../types'

// Patient-block values that are plain strings (dates are formatted by the sheet). Mirrors orderFields() in
// functions/src/snapshot.ts, which freezes the same values into issued reports.
export function clientFields(order: Order & Record<string, unknown>, patient: Partial<Patient> & Record<string, unknown> | null, extra: { b2bCode?: string; branchName?: string } = {}): Record<string, string> {
  const p = (patient ?? {}) as Record<string, unknown>
  const o = order as Record<string, unknown>
  const s = (v: unknown) => (v === undefined || v === null ? '' : String(v))
  const w = o.weight ?? p.weight
  const h = o.height ?? p.height
  return {
    phone: s(p.phone), email: s(p.email), address: [p.address, p.city, p.pincode].filter(Boolean).join(', '), dob: s(p.dob), altPhone: s(p.altPhone),
    reportNo: s(o.billNoReport || o.billNo), uhid: s(o.uhid ?? p.uhid), abhaNo: s(p.abhaNo), idNumber: s(p.idNumber), insuranceNo: s(p.insuranceNo),
    secondReferrer: s(o.secondReferrerName), hospital: s(o.hospitalName), b2bCentre: s(o.b2bCentreName), b2bCode: s(extra.b2bCode),
    collectionCentre: s(o.collectionCentreName), corporate: s(o.corporateClientName), corporateUser: s(o.corporateUser ?? p.corporateUser),
    corporatePlan: s(o.corporatePlan), govPanel: s(o.govPanelName), tpa: s(o.tpaName), priority: o.priority === 'urgent' ? 'Urgent' : o.priority ? 'Routine' : '',
    clinicalHistory: s(o.clinicalHistory ?? p.clinicalHistory), weight: w ? `${w} kg` : '', height: h ? `${h} cm` : '', category: s(o.category ?? p.category),
    source: s(o.source), collectionPlace: o.sampleCollectedAt === 'home' ? 'Home collection' : o.sampleCollectedAt === 'lab' ? 'At lab' : '',
    phlebotomist: s(o.phlebotomistName), species: s(p.species), breed: s(p.breed), owner: s(p.ownerName ?? p.owner), branch: s(extra.branchName), bookingId: s(o.bookingId),
  }
}
