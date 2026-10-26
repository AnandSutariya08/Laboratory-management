import { addDoc, arrayUnion, getDoc, getDocs, limit, query, serverTimestamp, Timestamp, updateDoc, where } from 'firebase/firestore'
import type {
  Booking,
  BookingEvent,
  BookingItem,
  BookingStatus,
  DispatchMode,
  LabSettings,
  OrderItem,
  Package,
  Patient,
  UserProfile,
} from '../types'
import { allocateDiscount } from './billing'
import { col, docRef, nextCounter, paths } from './db'
import { branchCounterName, branchStamp, getActiveBranch, MAIN_BRANCH_ID, setActiveBranch, branchOf } from './activeBranch'
import type { Branch } from '../branch/BranchProvider'
import { createOrder, createPatient } from './orders'

export const STATUS_LABEL: Record<BookingStatus, string> = {
  unmapped: 'Unmapped',
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  assigned: 'Phlebo Assigned',
  inProgress: 'In Progress',
  completed: 'Completed',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
}

export type BookingSource = 'googleAds' | 'metaAds' | 'labVisit' | 'referral' | 'phone' | 'hospitalApi' | 'website'
export const SOURCE_LABEL: Record<BookingSource, string> = {
  googleAds: 'Google Ads',
  metaAds: 'Meta Ads',
  labVisit: 'Lab Visit',
  referral: 'Referral',
  phone: 'Phone Inquiry',
  hospitalApi: 'Hospital API',
  website: 'Website',
}
export type BookingPriority = 'urgent' | 'high' | 'medium' | 'low'
export const PRIORITY_LABEL: Record<BookingPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}
// Phlebotomist progress while a booking is In Progress.
export type PhleboStage = 'started' | 'atLocation' | 'collected'
export const STAGE_LABEL: Record<PhleboStage, string> = {
  started: 'Started',
  atLocation: 'At Location',
  collected: 'Collected',
}

export interface BookingOtherCharge {
  id: string // master id, or 'custom'
  name: string
  price: number // paise
}

// Optional fields layered on top of Booking (shared type); legacy docs lack them.
export interface BookingExtras {
  source?: BookingSource
  priority?: BookingPriority
  crmId?: string
  otherCharges?: BookingOtherCharge[]
  rateListId?: string
  rateListName?: string
  hospitalName?: string
  corporateId?: string
  corporateName?: string
  companyName?: string
  location?: string // patient area / locality
  locationUrl?: string // shared map link
  specialInstructions?: string
  customFields?: { key: string; value: string }[]
  uhid?: string
  createdByName?: string
  ownerName?: string // "Assigned To": the staff member handling the lead
  phleboStage?: PhleboStage | ''
  paymentChannel?: 'online' | 'collection'
  paymentRef?: string
  paymentState?: 'pending' | 'paid'
  preBooking?: boolean // lightweight enquiry; converts into a booking
  preferredDate?: Timestamp | null
  convertedTo?: string // booking id created from this enquiry
  rescheduleCount?: number
  previousSchedule?: { at: Timestamp | null; slot: string }[] // earlier dates, oldest first
  reminderSentAt?: Timestamp | null
  pincodeOverride?: boolean // booked in a non-serviceable pincode with an override
  typedFields?: Record<string, string> // values of the lab's booking field definitions (settings.frontDesk.bookingFields)
}
export type BookingX = Booking & BookingExtras

// Firestore rejects undefined field values.
const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

export const bookingBranch = (b: { branchId?: string }) => branchOf(b)

export const paymentStatusOf = (b: Pick<BookingX, 'items' | 'collectionCharge' | 'discount' | 'prepaid' | 'otherCharges'>) => {
  const total = bookingTotal(b)
  if (b.prepaid <= 0) return 'Unpaid'
  return b.prepaid >= total && total > 0 ? 'Paid' : 'Partial'
}

export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    let t = String(v ?? '')
    if (/^[=+\-@]/.test(t)) t = `'${t}` // keep spreadsheets from evaluating cell text
    return `"${t.replace(/"/g, '""')}"`
  }
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export const STATUS_COLOR: Record<BookingStatus, string> = {
  unmapped: 'orange',
  scheduled: 'blue',
  confirmed: 'cyan',
  assigned: 'geekblue',
  inProgress: 'purple',
  completed: 'green',
  rescheduled: 'gold',
  cancelled: 'red',
}

export const ALLOWED_MOVES: Record<BookingStatus, BookingStatus[]> = {
  unmapped: ['scheduled', 'cancelled'],
  scheduled: ['confirmed', 'assigned', 'rescheduled', 'cancelled'],
  confirmed: ['assigned', 'rescheduled', 'cancelled'],
  assigned: ['inProgress', 'rescheduled', 'cancelled'],
  inProgress: ['completed', 'cancelled'],
  rescheduled: ['scheduled'], // a rescheduled booking goes back to Scheduled first; it cannot jump straight to Cancelled
  completed: [],
  cancelled: [],
}

export const canMove = (from: BookingStatus, to: BookingStatus) => ALLOWED_MOVES[from].includes(to)
export const isClosed = (s: BookingStatus) => s === 'completed' || s === 'cancelled'

// 30-minute slots from 07:00 to 20:00, grouped Morning / Afternoon / Evening.
const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
export const SLOTS = Array.from({ length: 26 }, (_, i) => {
  const start = 7 * 60 + i * 30
  return `${hhmm(start)}-${hhmm(start + 30)}`
})
export const SLOT_GROUPS: { label: string; slots: string[] }[] = [
  { label: 'Morning', slots: SLOTS.filter((s) => Number(s.slice(0, 2)) < 12) },
  { label: 'Afternoon', slots: SLOTS.filter((s) => Number(s.slice(0, 2)) >= 12 && Number(s.slice(0, 2)) < 17) },
  { label: 'Evening', slots: SLOTS.filter((s) => Number(s.slice(0, 2)) >= 17) },
]

// Status to chip variant (design system StatusChip).
export const STATUS_VARIANT: Record<BookingStatus, 'neutral' | 'info' | 'success' | 'caution' | 'urgent'> = {
  unmapped: 'caution',
  scheduled: 'info',
  confirmed: 'info',
  assigned: 'info',
  inProgress: 'caution',
  completed: 'success',
  rescheduled: 'caution',
  cancelled: 'urgent',
}

export const bookingName = (b: Pick<Booking, 'firstName' | 'lastName'>) =>
  `${b.firstName} ${b.lastName}`.trim()

export const otherChargesTotal = (b: Pick<BookingExtras, 'otherCharges'>) =>
  (b.otherCharges ?? []).reduce((s, c) => s + c.price, 0)

export const bookingTotal = (b: Pick<Booking, 'items' | 'collectionCharge' | 'discount'> & Pick<BookingExtras, 'otherCharges'>) =>
  Math.max(0, b.items.reduce((s, i) => s + i.price, 0) + b.collectionCharge + otherChargesTotal(b) - b.discount)

export type NewBooking = Omit<
  Booking,
  'id' | 'bookingNo' | 'status' | 'events' | 'createdAt' | 'createdBy' | 'cancelReason' | 'orderId' | 'assignedTo' | 'assignedToName'
> &
  Partial<Pick<Booking, 'assignedTo' | 'assignedToName' | 'patientId'>> &
  BookingExtras

const mkEvent = (user: UserProfile, action: string, note = ''): BookingEvent => ({
  at: Timestamp.now(),
  by: user.uid,
  byName: user.name,
  action,
  note,
})

// Free-text tests with no mapped items stay "unmapped" until mapped.
export const initialStatus = (b: Pick<Booking, 'items' | 'freeTextTests'>): BookingStatus =>
  b.items.length === 0 && b.freeTextTests.trim() ? 'unmapped' : 'scheduled'

export async function createBooking(input: NewBooking, user: UserProfile): Promise<Booking> {
  const b = getActiveBranch()
  const seq = await nextCounter(branchCounterName('booking', b.id))
  const bookingNo = b.id === MAIN_BRANCH_ID ? `BK${seq}` : `BK-${b.code}-${seq}`
  const crmId = input.crmId || `CRM${String(await nextCounter('crm')).padStart(6, '0')}`
  const status = initialStatus(input)
  const data = {
    assignedTo: '',
    assignedToName: '',
    ...input,
    ...branchStamp(),
    patientId: input.patientId ?? '',
    source: input.source ?? 'phone',
    priority: input.priority ?? 'medium',
    createdByName: user.name,
    ownerName: user.name,
    bookingNo,
    crmId,
    status,
    cancelReason: '',
    orderId: '',
    events: [mkEvent(user, 'created', `Status: ${status}`)],
    createdAt: serverTimestamp(),
    createdBy: user.uid,
  }
  const ref = await addDoc(col(paths.bookings), clean(data))
  return { ...data, id: ref.id } as unknown as Booking
}

// Every change appends an event to the audit timeline.
export async function updateBooking(
  id: string,
  patch: Partial<Omit<Booking, 'id' | 'events'>>,
  action: string,
  note: string,
  user: UserProfile,
): Promise<void> {
  await updateDoc(docRef(paths.bookings, id), { ...clean(patch), events: arrayUnion(mkEvent(user, action, note)) })
}

export async function transitionBooking(
  booking: Booking,
  to: BookingStatus,
  user: UserProfile,
  extra: Partial<Omit<Booking, 'id' | 'events'>> = {},
  note = '',
): Promise<void> {
  if (!canMove(booking.status, to)) {
    throw new Error(`Cannot move a ${booking.status} booking to ${to}`)
  }
  await updateBooking(booking.id, { ...extra, status: to }, `status: ${to}`, note, user)
}

// Another open lead from the same phone in the last 24 hours (duplicate-lead warning).
export async function findRecentLeads(phone: string, hours = 24): Promise<BookingX[]> {
  const p = phone.replace(/\D/g, '')
  if (p.length < 10) return []
  const snap = await getDocs(query(col(paths.bookings), where('phone', '==', p), limit(20)))
  const since = Date.now() - hours * 3600_000
  return snap.docs
    .map((d) => ({ ...(d.data() as Booking), id: d.id }) as BookingX)
    .filter((b) => !b.preBooking && !isClosed(b.status) && (b.createdAt?.toMillis?.() ?? 0) >= since)
}

// Manager reopen: a cancelled booking (or a completed one that never got a bill) goes back to Scheduled.
export async function reopenBooking(booking: Booking, user: UserProfile, reason: string): Promise<void> {
  if (!['labAdmin', 'admin', 'manager'].includes(user.role)) throw new Error('Only a manager or admin can reopen a booking.')
  if (booking.status === 'completed' && booking.orderId) throw new Error('This booking already has a bill. Edit the bill instead.')
  if (!isClosed(booking.status)) throw new Error('Only a closed booking can be reopened.')
  if (!reason.trim()) throw new Error('Enter a reason to reopen.')
  await updateBooking(booking.id, { status: 'scheduled', cancelReason: '' } as Partial<Booking>, 'status: scheduled', `Reopened: ${reason.trim()}`, user)
}

// Reschedule follows the spec state machine: Scheduled / Confirmed / Phlebo Assigned -> Rescheduled
// (a reason and a new date + slot are required, the active collector assignment is cancelled, the
// reschedule counter goes up and the old slot is kept). Rescheduled -> Scheduled once the new slot
// is confirmed (confirmReschedule). A Rescheduled booking is not rescheduled again: confirm it first.
export async function rescheduleBooking(
  booking: BookingX,
  input: { scheduledAt: Timestamp; slot: string; reason: string },
  user: UserProfile,
): Promise<void> {
  if (!input.reason.trim()) throw new Error('A reason is required to reschedule.')
  if (!input.slot.trim()) throw new Error('Pick the new time slot.')
  if (!canMove(booking.status, 'rescheduled')) throw new Error(`A ${STATUS_LABEL[booking.status]} booking cannot be rescheduled.`)
  const hadAssignee = !!booking.assignedTo
  await updateDoc(docRef(paths.bookings, booking.id), {
    ...clean({
      status: 'rescheduled',
      scheduledAt: input.scheduledAt,
      slot: input.slot,
      assignedTo: '',
      assignedToName: '',
      phleboStage: '',
      rescheduleCount: (booking.rescheduleCount ?? 0) + 1,
      reminderSentAt: null,
    }),
    previousSchedule: arrayUnion({ at: booking.scheduledAt ?? null, slot: booking.slot ?? '' }),
    events: arrayUnion(
      mkEvent(user, 'status: rescheduled', `${input.reason.trim()}${hadAssignee ? ` (assignment to ${booking.assignedToName} cancelled)` : ''}`),
    ),
  })
}

// Rescheduled -> Scheduled: the new slot is confirmed (it must have a date and a slot).
export async function confirmReschedule(booking: BookingX, user: UserProfile): Promise<void> {
  if (booking.status !== 'rescheduled') throw new Error('Only a rescheduled booking needs its new slot confirmed.')
  if (!booking.scheduledAt || !booking.slot) throw new Error('Set the new date and slot first.')
  await transitionBooking(booking, 'scheduled', user, {}, `New slot confirmed: ${booking.slot}`)
}

// Home collections are billed once the collector has finished (In Progress -> Completed).
// Lab visits need no collector. A manager or admin may bill earlier with an explicit override.
export function billingBlockedReason(b: Pick<BookingX, 'type' | 'status'>, user: Pick<UserProfile, 'role'>): string | null {
  if (b.type !== 'homeCollection' || b.status === 'inProgress') return null
  if (['labAdmin', 'admin', 'manager'].includes(user.role)) return null
  return 'The bill is created once the collector has started the visit. Mark the booking In Progress first.'
}

// ---- Collectors (phlebotomist master: zones, pincodes, hours, capacity) -------

export interface Collector {
  id: string // = user uid
  name: string
  pincodes: string[]
  zone: string
  startHour: number // 0-23
  endHour: number
  capacity: number // bookings per day
  active: boolean
}

export interface Suggestion { collector: { uid: string; name: string }; score: number; load: number; reasons: string[] }

const slotHour = (slot: string) => Number(slot.slice(0, 2)) || 0

// Rank collectors for a booking: pincode / zone match first, then inside working hours, then the
// lightest load that day; a collector at capacity is dropped from the top of the list.
export function suggestCollectors(
  booking: Pick<BookingX, 'pincode' | 'slot' | 'scheduledAt' | 'id'>,
  phlebos: { uid: string; name: string }[],
  collectors: Collector[],
  allBookings: Pick<BookingX, 'id' | 'assignedTo' | 'scheduledAt' | 'status'>[],
): Suggestion[] {
  const day = booking.scheduledAt ? new Date(booking.scheduledAt.toMillis()).toDateString() : ''
  const hour = booking.slot ? slotHour(booking.slot) : null
  return phlebos
    .map((p) => {
      const c = collectors.find((x) => x.id === p.uid)
      if (c && c.active === false) return null
      const load = allBookings.filter(
        (b) => b.id !== booking.id && b.assignedTo === p.uid && !isClosed(b.status) && day && b.scheduledAt && new Date(b.scheduledAt.toMillis()).toDateString() === day,
      ).length
      const reasons: string[] = []
      let score = 50 - load * 5
      if (c?.pincodes?.includes(booking.pincode)) { score += 100; reasons.push('serves this pincode') }
      else if (c && c.pincodes?.length) score -= 20
      if (c && hour !== null) {
        if (hour >= c.startHour && hour < c.endHour) { score += 20; reasons.push('on shift') } else { score -= 40; reasons.push('outside hours') }
      }
      if (c && c.capacity > 0 && load >= c.capacity) { score -= 200; reasons.push('at capacity') }
      reasons.push(`${load} booking${load === 1 ? '' : 's'} that day`)
      return { collector: p, score, load, reasons }
    })
    .filter((x): x is Suggestion => !!x)
    .sort((a, b) => b.score - a.score)
}

// Bulk confirm: assign each booking its top suggestion (loads are counted as we go).
export async function bulkAssignSuggested(
  bookings: BookingX[],
  phlebos: { uid: string; name: string }[],
  collectors: Collector[],
  all: BookingX[],
  user: UserProfile,
): Promise<{ done: number; skipped: { booking: BookingX; why: string }[] }> {
  let done = 0
  const skipped: { booking: BookingX; why: string }[] = []
  const live = all.map((b) => ({ ...b }))
  for (const b of bookings) {
    try {
      if (!canMove(b.status, 'assigned')) throw new Error(`A ${STATUS_LABEL[b.status]} booking cannot be assigned.`)
      const best = suggestCollectors(b, phlebos, collectors, live).find((s) => s.score > -100)
      if (!best) throw new Error('No collector available.')
      await transitionBooking(b, 'assigned', user, { assignedTo: best.collector.uid, assignedToName: best.collector.name }, `Auto-assigned to ${best.collector.name} (${best.reasons.join(', ')})`)
      const idx = live.findIndex((x) => x.id === b.id)
      if (idx >= 0) live[idx] = { ...live[idx], assignedTo: best.collector.uid, status: 'assigned' }
      done++
    } catch (e) {
      skipped.push({ booking: b, why: (e as Error).message })
    }
  }
  return { done, skipped }
}

// Reminder lead time before a home collection (settings.frontDesk.bookingReminderMinutes, default 120).
export function reminderDue(b: Pick<BookingX, 'status' | 'scheduledAt' | 'slot' | 'reminderSentAt'>, leadMinutes = 120, now = Date.now()): boolean {
  if (!['confirmed', 'assigned', 'scheduled'].includes(b.status) || b.reminderSentAt || !b.scheduledAt) return false
  const start = b.scheduledAt.toMillis() // already includes the slot start
  const left = start - now
  return left > 0 && left <= leadMinutes * 60_000
}

// Bulk actions: status change (only where the move is allowed), owner, reschedule. Returns the
// number changed and the bookings that were skipped with the reason.
export async function bulkUpdateBookings(
  bookings: BookingX[],
  action:
    | { kind: 'status'; to: BookingStatus; reason?: string }
    | { kind: 'owner'; ownerName: string; ownerId?: string }
    | { kind: 'reschedule'; scheduledAt: Timestamp; slot: string; reason: string },
  user: UserProfile,
): Promise<{ done: number; skipped: { booking: BookingX; why: string }[] }> {
  let done = 0
  const skipped: { booking: BookingX; why: string }[] = []
  for (const b of bookings) {
    try {
      if (action.kind === 'status') {
        if (action.to === 'cancelled' && !action.reason?.trim()) throw new Error('A reason is required to cancel.')
        if (action.to === 'completed') throw new Error('Completing needs a bill: use Create bill.')
        await transitionBooking(b, action.to, user, action.to === 'cancelled' ? { cancelReason: action.reason } : {}, action.reason ?? '')
      } else if (action.kind === 'owner') {
        if (isClosed(b.status)) throw new Error('Booking is closed.')
        await updateBooking(b.id, { ownerName: action.ownerName } as Partial<Booking>, 'owner changed', action.ownerName, user)
      } else {
        if (isClosed(b.status)) throw new Error('Booking is closed.')
        if (!action.reason.trim()) throw new Error('A reason is required to reschedule.')
        await rescheduleBooking(b, { scheduledAt: action.scheduledAt, slot: action.slot, reason: action.reason }, user)
      }
      done++
    } catch (e) {
      skipped.push({ booking: b, why: (e as Error).message })
    }
  }
  return { done, skipped }
}

// Map free-text tests to catalogue items; the booking leaves "unmapped".
export async function mapBookingItems(booking: Booking, items: BookingItem[], user: UserProfile) {
  const patch: Partial<Booking> = { items }
  if (booking.status === 'unmapped' && items.length > 0) patch.status = 'scheduled'
  await updateBooking(booking.id, patch, 'tests mapped', items.map((i) => i.name).join(', '), user)
}

const salutation = (b: Booking) => (b.gender === 'male' ? 'Mr' : b.gender === 'female' ? 'Ms' : '')

// Create the patient (or reuse the linked one) and the bill, then close the booking.
export async function convertToBill(
  booking: BookingX,
  settings: LabSettings,
  user: UserProfile,
  packages: Package[],
  branches: Branch[],
): Promise<string> {
  if (booking.items.length === 0) throw new Error('Map the requested tests to the catalogue first.')

  // The bill belongs to the booking's branch, not whichever branch the user is viewing.
  const targetId = bookingBranch(booking)
  const target = branches.find((b) => b.id === targetId)
  if (!target) {
    throw new Error(
      `This booking belongs to another branch (${targetId}) that you do not have access to. Ask an admin or switch to a user with access to that branch.`,
    )
  }
  const previous = getActiveBranch()
  const switched = previous.id !== target.id
  if (switched) setActiveBranch(target)
  try {
    return await convertInBranch(booking, settings, user, packages)
  } finally {
    if (switched) setActiveBranch(previous)
  }
}

async function convertInBranch(
  booking: BookingX,
  settings: LabSettings,
  user: UserProfile,
  packages: Package[],
): Promise<string> {
  let patient: Patient | null = null
  if (booking.patientId) {
    const snap = await getDoc(docRef<Patient>(paths.patients, booking.patientId))
    if (snap.exists()) patient = { ...snap.data(), id: snap.id }
  }
  if (!patient) {
    const dispatchModes: DispatchMode[] = [...settings.dispatchDefaults]
    if (booking.phone && !dispatchModes.includes('whatsapp')) dispatchModes.push('whatsapp')
    patient = await createPatient({
      salutation: salutation(booking),
      firstName: booking.firstName,
      lastName: booking.lastName,
      gender: booking.gender,
      ageValue: booking.ageValue,
      ageUnit: booking.ageUnit,
      phone: booking.phone,
      email: booking.email,
      dispatchModes,
      referrerName: booking.referrerName,
    })
  }

  // Referrer / hospital are stored by name on a booking: resolve the ids so the bill carries them
  // (and the referrer's PRO).
  const byName = async (coll: string, name?: string) => {
    if (!name?.trim()) return undefined
    try {
      const r = await getDocs(query(col(coll), where('name', '==', name.trim()), limit(1)))
      return r.docs[0]?.id
    } catch {
      return undefined
    }
  }
  const referrerId = patient.referrerId || (await byName('referrers', booking.referrerName))
  const hospitalId = patient.hospitalId || (await byName('referrers', booking.hospitalName))

  const pkgById = new Map(packages.map((p) => [p.id, p]))
  const lines: OrderItem[] = booking.items.map((i) => ({
    lineId: crypto.randomUUID(),
    kind: i.kind,
    refId: i.refId,
    code: i.code,
    name: i.name,
    price: i.price,
    discount: 0,
    urgent: false,
    testIds: i.kind === 'test' ? [i.refId] : (pkgById.get(i.refId)?.testIds ?? []),
    status: 'pending',
  }))
  if (booking.collectionCharge > 0) {
    lines.push({
      lineId: crypto.randomUUID(),
      kind: 'package',
      refId: 'collection-charge',
      code: 'HC',
      name: 'Home collection charge',
      price: booking.collectionCharge,
      discount: 0,
      urgent: false,
      testIds: [],
      isCharge: true,
      status: 'pending',
    })
  }
  for (const c of booking.otherCharges ?? []) {
    if (c.price <= 0) continue
    lines.push({
      lineId: crypto.randomUUID(),
      kind: 'package',
      refId: `other-charge-${c.id}`,
      code: 'OC',
      name: c.name,
      price: c.price,
      discount: 0,
      urgent: false,
      testIds: [],
      isCharge: true,
      status: 'pending',
    })
  }
  const shares = allocateDiscount(lines, booking.discount)
  const items = lines.map((l, i) => ({ ...l, discount: shares[i] }))
  const net = items.reduce((s, i) => s + i.price - i.discount, 0)
  const prepaid = Math.min(booking.prepaid, net)

  const orderId = await createOrder({
    patient,
    items,
    discountReason: booking.discount > 0 ? 'Booking discount' : '',
    discountedBy: booking.discount > 0 ? user.uid : '',
    note: `From booking ${booking.bookingNo}${booking.specialInstructions ? ` - ${booking.specialInstructions}` : ''}`,
    payments:
      prepaid > 0 ? [{ mode: booking.prepaidMode ?? 'cash', amount: prepaid, reference: booking.bookingNo }] : [],
    settings,
    user,
    bookingId: booking.id,
    context: {
      referrerId,
      hospitalId,
      rateListIds: booking.rateListId ? [booking.rateListId] : undefined,
      referrerName: booking.referrerName,
      hospitalName: booking.hospitalName,
      corporateClientId: booking.corporateId,
      corporateClientName: booking.corporateName,
      priority: booking.priority === 'urgent' ? 'urgent' : 'routine',
      sampleCollectedAt: 'home',
      uhid: booking.uhid,
    },
  })
  await updateBooking(
    booking.id,
    { orderId, patientId: patient.id, uhid: patient.patientNo, status: 'completed' } as Partial<Booking>,
    'status: completed',
    `Bill created`,
    user,
  )
  return orderId
}

// ---- Pre bookings: lightweight enquiries that convert into a booking ----------

export interface NewPreBooking {
  firstName: string
  lastName: string
  phone: string
  tests: string
  source: BookingSource
  preferredDate: Timestamp | null
  notes: string
}

export async function createPreBooking(input: NewPreBooking, user: UserProfile): Promise<string> {
  const b = getActiveBranch()
  const seq = await nextCounter(branchCounterName('preBooking', b.id))
  const bookingNo = b.id === MAIN_BRANCH_ID ? `PB${seq}` : `PB-${b.code}-${seq}`
  const data = {
    ...branchStamp(),
    bookingNo,
    preBooking: true,
    type: 'homeCollection',
    status: 'unmapped',
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    email: '',
    ageValue: 0,
    ageUnit: 'year',
    gender: 'other',
    address: '',
    pincode: '',
    landmark: '',
    referrerName: '',
    items: [],
    freeTextTests: input.tests,
    scheduledAt: null,
    preferredDate: input.preferredDate,
    slot: '',
    assignedTo: '',
    assignedToName: '',
    collectionCharge: 0,
    discount: 0,
    prepaid: 0,
    prepaidMode: null,
    notes: input.notes,
    cancelReason: '',
    patientId: '',
    orderId: '',
    source: input.source,
    priority: 'medium',
    createdByName: user.name,
    events: [mkEvent(user, 'enquiry created')],
    createdAt: serverTimestamp(),
    createdBy: user.uid,
  }
  const ref = await addDoc(col(paths.bookings), data)
  return ref.id
}

export async function markPreBookingConverted(preId: string, bookingId: string, user: UserProfile) {
  await updateBooking(preId, { convertedTo: bookingId } as Partial<Booking>, 'converted', `Booking ${bookingId}`, user)
}

export async function duplicateBooking(b: BookingX, user: UserProfile): Promise<Booking> {
  return createBooking(
    {
      type: b.type,
      firstName: b.firstName,
      lastName: b.lastName,
      phone: b.phone,
      email: b.email,
      ageValue: b.ageValue,
      ageUnit: b.ageUnit,
      gender: b.gender,
      address: b.address,
      pincode: b.pincode,
      landmark: b.landmark,
      referrerName: b.referrerName,
      items: b.items,
      freeTextTests: b.freeTextTests,
      scheduledAt: null,
      slot: '',
      collectionCharge: b.collectionCharge,
      discount: b.discount,
      prepaid: 0,
      prepaidMode: null,
      notes: b.notes,
      patientId: b.patientId,
      source: b.source,
      priority: b.priority,
      otherCharges: b.otherCharges,
      rateListId: b.rateListId,
      rateListName: b.rateListName,
      hospitalName: b.hospitalName,
      corporateId: b.corporateId,
      corporateName: b.corporateName,
      companyName: b.companyName,
      location: b.location,
      locationUrl: b.locationUrl,
      specialInstructions: b.specialInstructions,
      customFields: b.customFields,
      uhid: b.uhid,
    },
    user,
  )
}
