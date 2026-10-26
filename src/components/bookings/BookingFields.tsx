import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Col, DatePicker, Descriptions, Input, InputNumber, Radio, Row, Select, Space, Tag, TimePicker, Typography } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { getDocs, query, Timestamp, where } from 'firebase/firestore'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { pincodeUnserviceable } from '../../lib/frontDesk'
import type { FrontDeskSettings } from '../../types'
import { col, paths } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import {
  findRecentLeads,
  PRIORITY_LABEL,
  SLOT_GROUPS,
  SOURCE_LABEL,
  type BookingOtherCharge,
  type BookingPriority,
  type BookingSource,
  type BookingX,
  type NewBooking,
} from '../../lib/bookings'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import type { AgeUnit, Booking, BookingItem, BookingType, Gender, Patient, PaymentMode } from '../../types'

// Form state for a booking; money is held in rupees for the inputs.
export interface BookingDraft {
  firstName: string
  lastName: string
  phone: string
  email: string
  ageValue: number | null
  ageUnit: AgeUnit
  gender: Gender | undefined
  address: string
  pincode: string
  landmark: string
  referrerName: string
  items: BookingItem[]
  freeTextTests: string
  type: BookingType
  date: Dayjs | null
  slot: string
  collectionCharge: number
  discount: number
  prepaid: number
  prepaidMode: PaymentMode
  notes: string
  patientId: string
  uhid: string
  // referrer and pricing
  hospitalName: string
  corporateId: string
  corporateName: string
  companyName: string
  rateListId: string
  rateListName: string
  // charges
  otherCharges: BookingOtherCharge[]
  // schedule extras
  location: string
  locationUrl: string
  specialInstructions: string
  // additional
  source: BookingSource
  priority: BookingPriority
  crmId: string
  customFields: { key: string; value: string }[]
  // payment
  paymentChannel: 'online' | 'collection'
  paymentRef: string
  pincodeOverride: boolean
  typedFields: Record<string, string>
}

// ---- master data used by the form (shared across branches) ----------------------
export interface Referrer { id: string; name: string; type: 'doctor' | 'hospital'; rateListId?: string; active?: boolean }
export interface RateList { id: string; name: string; entries: Record<string, number>; active?: boolean }
interface Named { id: string; name: string; rateListId?: string; active?: boolean }
interface OtherChargeMaster { id: string; name: string; price: number; active?: boolean }

// Soft-deleted masters (X-02) are hidden from pickers; these readers bypass useMaster so they filter here.
const gone = (r: unknown) => !!(r as { deleted?: boolean }).deleted

export function useBookingMasters() {
  const { data: referrers } = useLiveQuery<Referrer>(col<Referrer>('referrers'), [])
  const { data: rateLists } = useLiveQuery<RateList>(col<RateList>('rateLists'), [])
  const { data: corporates } = useLiveQuery<Named>(col<Named>('corporateClients'), [])
  const { data: charges } = useLiveQuery<OtherChargeMaster>(col<OtherChargeMaster>('otherCharges'), [])
  return {
    doctors: referrers.filter((r) => r.type === 'doctor' && r.active !== false && !gone(r)),
    hospitals: referrers.filter((r) => r.type === 'hospital' && r.active !== false && !gone(r)),
    rateLists: rateLists.filter((r) => r.active !== false && !gone(r)),
    corporates: corporates.filter((r) => r.active !== false && !gone(r)),
    charges: charges.filter((r) => r.active !== false && !gone(r)),
  }
}

// Which rate list applies: the referring doctor's list, else the hospital's, else the
// corporate client's; with none of them set the catalogue (main) price is used.
export function resolveRateList(
  m: ReturnType<typeof useBookingMasters>,
  v: Pick<BookingDraft, 'referrerName' | 'hospitalName' | 'corporateId'>,
): RateList | null {
  const byId = (id?: string) => (id ? (m.rateLists.find((r) => r.id === id) ?? null) : null)
  return (
    byId(m.doctors.find((d) => d.name === v.referrerName)?.rateListId) ??
    byId(m.hospitals.find((d) => d.name === v.hospitalName)?.rateListId) ??
    byId(m.corporates.find((c) => c.id === v.corporateId)?.rateListId)
  )
}

export const emptyDraft = (): BookingDraft => ({
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  ageValue: null,
  ageUnit: 'year',
  gender: undefined,
  address: '',
  pincode: '',
  landmark: '',
  referrerName: '',
  items: [],
  freeTextTests: '',
  type: 'homeCollection',
  date: null,
  slot: '',
  collectionCharge: 0,
  discount: 0,
  prepaid: 0,
  prepaidMode: 'cash',
  notes: '',
  patientId: '',
  uhid: '',
  hospitalName: '',
  corporateId: '',
  corporateName: '',
  companyName: '',
  rateListId: '',
  rateListName: '',
  otherCharges: [],
  location: '',
  locationUrl: '',
  specialInstructions: '',
  source: 'phone',
  priority: 'medium',
  crmId: '',
  customFields: [],
  paymentChannel: 'collection',
  paymentRef: '',
  pincodeOverride: false,
  typedFields: {},
})

export const draftFromBooking = (bk: Booking): BookingDraft => {
  const b = bk as BookingX
  return {
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
  type: b.type,
  date: b.scheduledAt ? dayjs(b.scheduledAt.toDate()) : null,
  slot: b.slot,
  collectionCharge: toRupees(b.collectionCharge),
  discount: toRupees(b.discount),
  prepaid: toRupees(b.prepaid),
  prepaidMode: b.prepaidMode ?? 'cash',
  notes: b.notes,
  patientId: b.patientId,
  uhid: b.uhid ?? '',
  hospitalName: b.hospitalName ?? '',
  corporateId: b.corporateId ?? '',
  corporateName: b.corporateName ?? '',
  companyName: b.companyName ?? '',
  rateListId: b.rateListId ?? '',
  rateListName: b.rateListName ?? '',
  otherCharges: b.otherCharges ?? [],
  location: b.location ?? '',
  locationUrl: b.locationUrl ?? '',
  specialInstructions: b.specialInstructions ?? '',
  source: b.source ?? 'phone',
  priority: b.priority ?? 'medium',
  crmId: b.crmId ?? '',
  customFields: b.customFields ?? [],
  paymentChannel: b.paymentChannel ?? 'collection',
  paymentRef: b.paymentRef ?? '',
  pincodeOverride: b.pincodeOverride ?? false,
  typedFields: b.typedFields ?? {},
  }
}

// Scheduled time is the slot start on the chosen day (or midnight when no slot).
export function scheduledTimestamp(date: Dayjs | null, slot: string): Timestamp | null {
  if (!date) return null
  const m = /^(\d{2}):(\d{2})/.exec(slot)
  const t = m ? date.startOf('day').hour(Number(m[1])).minute(Number(m[2])) : date.startOf('day')
  return Timestamp.fromDate(t.toDate())
}

export const draftToBooking = (d: BookingDraft): NewBooking => ({
  type: d.type,
  firstName: d.firstName.trim(),
  lastName: d.lastName.trim(),
  phone: d.phone.trim(),
  email: d.email.trim(),
  ageValue: d.ageValue ?? 0,
  ageUnit: d.ageUnit,
  gender: d.gender ?? 'other',
  address: d.address.trim(),
  pincode: d.pincode.trim(),
  landmark: d.landmark.trim(),
  referrerName: d.referrerName.trim(),
  items: d.items,
  freeTextTests: d.freeTextTests.trim(),
  scheduledAt: scheduledTimestamp(d.date, d.slot),
  slot: d.slot,
  collectionCharge: toPaise(d.collectionCharge || 0),
  discount: toPaise(d.discount || 0),
  prepaid: toPaise(d.prepaid || 0),
  prepaidMode: d.prepaid > 0 ? d.prepaidMode : null,
  notes: d.notes.trim(),
  patientId: d.patientId,
  uhid: d.uhid,
  hospitalName: d.hospitalName.trim(),
  corporateId: d.corporateId,
  corporateName: d.corporateName,
  companyName: d.companyName.trim(),
  rateListId: d.rateListId,
  rateListName: d.rateListName,
  otherCharges: d.otherCharges,
  location: d.location.trim(),
  locationUrl: d.locationUrl.trim(),
  specialInstructions: d.specialInstructions.trim(),
  source: d.source,
  priority: d.priority,
  crmId: d.crmId.trim(),
  customFields: d.customFields.filter((f) => f.key.trim()),
  paymentChannel: d.paymentChannel,
  paymentRef: d.paymentRef.trim(),
  pincodeOverride: d.pincodeOverride || undefined,
  typedFields: Object.keys(d.typedFields).length ? d.typedFields : undefined,
  ...(d.paymentChannel === 'online' && d.prepaid > 0
    ? { paymentState: (d.paymentRef.trim() ? 'paid' : 'pending') as 'paid' | 'pending' }
    : {}),
})

export const draftTotals = (d: BookingDraft) => {
  const tests = d.items.reduce((s, i) => s + i.price, 0)
  const charge = toPaise(d.collectionCharge || 0)
  const discount = toPaise(d.discount || 0)
  const other = d.otherCharges.reduce((s, c) => s + c.price, 0)
  const total = tests + charge + other
  const net = Math.max(0, total - discount)
  const prepaid = toPaise(d.prepaid || 0)
  return { tests, charge, other, discount, total, net, prepaid, balance: Math.max(0, net - prepaid) }
}

// Returns an error message for a step, or null.
export function validateSection(d: BookingDraft, section: 'patient' | 'tests' | 'extra' | 'payment', fd?: FrontDeskSettings): string | null {
  if (section === 'patient') {
    if (!d.firstName.trim()) return 'First name is required.'
    if (!/^\d{10}$/.test(d.phone.trim())) return 'Phone must be 10 digits.'
    if (d.email.trim() && !/^\S+@\S+\.\S+$/.test(d.email.trim())) return 'Enter a valid email.'
    if (!d.ageValue || d.ageValue <= 0) return 'Age is required.'
    if (!d.gender) return 'Gender is required.'
    // Address and pincode matter for a home visit only; a lab visit does not need them.
    if (d.type === 'homeCollection') {
      if (!d.address.trim()) return 'Address is required for a home collection.'
      if (!/^\d{6}$/.test(d.pincode.trim())) return 'Pincode must be 6 digits.'
    } else if (d.pincode.trim() && !/^\d{6}$/.test(d.pincode.trim())) return 'Pincode must be 6 digits.'
    if (d.type === 'homeCollection' && fd?.pincodePolicy === 'block' && pincodeUnserviceable(d.pincode, fd.serviceablePincodes)) {
      return 'This pincode is outside the serviceable area.'
    }
    if (d.type === 'homeCollection' && pincodeUnserviceable(d.pincode, fd?.serviceablePincodes) && !d.pincodeOverride) {
      return 'This pincode is not serviceable. Tick "Book anyway" to override.'
    }
  }
  if (section === 'tests' && d.items.length === 0 && !d.freeTextTests.trim()) {
    return 'Add tests from the catalogue or describe the tests requested.'
  }
  if (section === 'extra') {
    const t = draftTotals(d)
    if (t.discount > t.total) return 'Discount cannot exceed the total.'
    for (const f of fd?.bookingFields ?? []) if (f.required && !(d.typedFields[f.key] ?? '').trim()) return `${f.label} is required.`
  }
  if (section === 'payment') {
    const t = draftTotals(d)
    if (t.prepaid > t.net && d.items.length > 0) return 'Prepaid amount is more than the net amount.'
  }
  return null
}

interface SectionProps {
  value: BookingDraft
  onChange: (patch: Partial<BookingDraft>) => void
}

const Field = ({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 2 }}>
      {label}
      {required && <span style={{ color: '#ef4444' }}> *</span>}
    </div>
    {children}
  </div>
)

export function PatientFields({ value: v, onChange }: SectionProps) {
  const fd = useLabSettings().frontDesk
  const unserviceable = v.type === 'homeCollection' && pincodeUnserviceable(v.pincode, fd?.serviceablePincodes)
  const [matches, setMatches] = useState<Patient[]>([])
  const [leads, setLeads] = useState<BookingX[]>([])

  // Another open lead from this phone in the last 24 hours: warn before creating a second one.
  useEffect(() => {
    if (!/^\d{10}$/.test(v.phone)) {
      setLeads([])
      return
    }
    let cancelled = false
    findRecentLeads(v.phone)
      .then((l) => !cancelled && setLeads(l))
      .catch(() => !cancelled && setLeads([]))
    return () => {
      cancelled = true
    }
  }, [v.phone])

  useEffect(() => {
    if (!/^\d{10}$/.test(v.phone)) {
      setMatches([])
      return
    }
    let cancelled = false
    getDocs(query(col<Patient>(paths.patients), where('phone', '==', v.phone)))
      .then((s) => !cancelled && setMatches(s.docs.map((d) => ({ ...d.data(), id: d.id }))))
      .catch(() => !cancelled && setMatches([]))
    return () => {
      cancelled = true
    }
  }, [v.phone])

  const prefill = (p: Patient) =>
    onChange({
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      ageValue: p.ageValue,
      ageUnit: p.ageUnit,
      gender: p.gender,
      referrerName: v.referrerName || (p.referrerName === 'Self' ? '' : p.referrerName),
      patientId: p.id,
      uhid: p.patientNo,
    })

  return (
    <>
      <Row gutter={12}>
        <Col xs={24} md={12}>
          <Field label="Phone" required>
            <Input
              maxLength={10}
              inputMode="numeric"
              value={v.phone}
              onChange={(e) => onChange({ phone: e.target.value.replace(/\D/g, ''), patientId: '' })}
              placeholder="10-digit mobile number"
            />
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Email">
            <Input value={v.email} onChange={(e) => onChange({ email: e.target.value })} />
          </Field>
        </Col>
      </Row>
      {leads.length > 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message="Possible duplicate lead"
          description={leads.map((l) => `${l.bookingNo} (${l.firstName} ${l.lastName}) was created in the last 24 hours and is still open.`).join(' ')}
        />
      )}
      {matches.length > 0 && !v.patientId && (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="Existing patients with this phone"
          description={
            <Space wrap>
              {matches.map((p) => (
                <Button key={p.id} size="small" onClick={() => prefill(p)}>
                  {p.patientNo} · {`${p.firstName} ${p.lastName}`.trim()}
                </Button>
              ))}
            </Space>
          }
        />
      )}
      {v.patientId && <Tag color="blue" style={{ marginBottom: 12 }}>Linked to existing patient</Tag>}
      <Row gutter={12}>
        <Col xs={24} md={12}>
          <Field label="First name" required>
            <Input value={v.firstName} onChange={(e) => onChange({ firstName: e.target.value })} />
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Last name">
            <Input value={v.lastName} onChange={(e) => onChange({ lastName: e.target.value })} />
          </Field>
        </Col>
        <Col xs={12} md={8}>
          <Field label="Age" required>
            <InputNumber min={0} style={{ width: '100%' }} value={v.ageValue} onChange={(n) => onChange({ ageValue: n })} />
          </Field>
        </Col>
        <Col xs={12} md={8}>
          <Field label="Unit">
            <Select
              style={{ width: '100%' }}
              value={v.ageUnit}
              onChange={(ageUnit) => onChange({ ageUnit })}
              options={[
                { value: 'year', label: 'Years' },
                { value: 'month', label: 'Months' },
                { value: 'day', label: 'Days' },
              ]}
            />
          </Field>
        </Col>
        <Col xs={24} md={8}>
          <Field label="Gender" required>
            <Select
              style={{ width: '100%' }}
              value={v.gender}
              onChange={(gender) => onChange({ gender })}
              placeholder="Select"
              options={[
                { value: 'male', label: 'Male' },
                { value: 'female', label: 'Female' },
                { value: 'other', label: 'Other' },
              ]}
            />
          </Field>
        </Col>
        <Col xs={24}>
          <Field label="Address" required={v.type === 'homeCollection'}>
            <Input.TextArea rows={2} value={v.address} onChange={(e) => onChange({ address: e.target.value })} />
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Pincode" required={v.type === 'homeCollection'}>
            <Input maxLength={6} value={v.pincode} onChange={(e) => onChange({ pincode: e.target.value.replace(/\D/g, ''), pincodeOverride: false })} />
            {unserviceable && v.pincode.length === 6 && (
              <Alert style={{ marginTop: 4 }} type={fd?.pincodePolicy === 'block' ? 'error' : 'warning'} showIcon
                message="Pincode is not in the serviceable list"
                description={fd?.pincodePolicy === 'block' ? 'Bookings outside the service area are blocked.' : (
                  <label><input type="checkbox" checked={v.pincodeOverride} onChange={(e) => onChange({ pincodeOverride: e.target.checked })} /> Book anyway (extra charge may apply)</label>
                )} />
            )}
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Landmark">
            <Input value={v.landmark} onChange={(e) => onChange({ landmark: e.target.value })} />
          </Field>
        </Col>
      </Row>
    </>
  )
}

export function ReferrerFields({ value: v, onChange }: SectionProps) {
  const m = useBookingMasters()
  const rl = resolveRateList(m, v)
  const apply = (p: Partial<BookingDraft>) => {
    const next = { ...v, ...p }
    const list = resolveRateList(m, next)
    // reprice already-chosen items against the resolved list (catalogue price when none)
    onChange({ ...p, rateListId: list?.id ?? '', rateListName: list?.name ?? '' })
  }
  return (
    <>
      <Row gutter={12}>
        <Col xs={24} md={12}>
          <Field label="Referring doctor">
            <Select
              showSearch
              allowClear
              style={{ width: '100%' }}
              value={v.referrerName || undefined}
              placeholder="Self"
              onChange={(x) => apply({ referrerName: x ?? '' })}
              options={m.doctors.map((d) => ({ value: d.name, label: d.name }))}
              filterOption={(i, o) => String(o?.label ?? '').toLowerCase().includes(i.toLowerCase())}
              notFoundContent="No doctors in the referral master"
            />
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Referring hospital">
            <Select
              showSearch
              allowClear
              style={{ width: '100%' }}
              value={v.hospitalName || undefined}
              placeholder="None"
              onChange={(x) => apply({ hospitalName: x ?? '' })}
              options={m.hospitals.map((d) => ({ value: d.name, label: d.name }))}
              filterOption={(i, o) => String(o?.label ?? '').toLowerCase().includes(i.toLowerCase())}
            />
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Corporate client">
            <Select
              showSearch
              allowClear
              style={{ width: '100%' }}
              value={v.corporateId || undefined}
              placeholder="None"
              onChange={(id) => {
                const c = m.corporates.find((x) => x.id === id)
                apply({ corporateId: id ?? '', corporateName: c?.name ?? '', companyName: c?.name ?? v.companyName })
              }}
              options={m.corporates.map((c) => ({ value: c.id, label: c.name }))}
              filterOption={(i, o) => String(o?.label ?? '').toLowerCase().includes(i.toLowerCase())}
            />
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Company name">
            <Input value={v.companyName} onChange={(e) => onChange({ companyName: e.target.value })} />
          </Field>
        </Col>
        <Col xs={24}>
          <Field label="Rate list">
            <Select
              allowClear
              style={{ width: '100%' }}
              value={v.rateListId || undefined}
              placeholder="Resolved from referrer, otherwise catalogue price"
              onChange={(id) => onChange({ rateListId: id ?? '', rateListName: m.rateLists.find((r) => r.id === id)?.name ?? '' })}
              options={m.rateLists.map((r) => ({ value: r.id, label: r.name }))}
            />
          </Field>
        </Col>
      </Row>
      <Typography.Text type="secondary">
        {rl
          ? `Rate list from the referrer chain: ${rl.name}. You can override it above.`
          : 'Rate list precedence: doctor, then hospital, then corporate client, then catalogue price.'}
      </Typography.Text>
    </>
  )
}

export function TestsFields({ value: v, onChange }: SectionProps) {
  const cat = useCatalogueMaps()
  const m = useBookingMasters()
  const list = m.rateLists.find((r) => r.id === v.rateListId)
  const priceOf = (id: string, base: number) => list?.entries?.[id] ?? base

  // Reprice when the rate list changes.
  useEffect(() => {
    if (v.items.length === 0) return
    const next = v.items.map((i) => {
      const base = i.kind === 'test' ? cat.testById.get(i.refId)?.price : cat.packageById.get(i.refId)?.price
      return base === undefined ? i : { ...i, price: priceOf(i.refId, base) }
    })
    if (next.some((i, k) => i.price !== v.items[k].price)) onChange({ items: next })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.rateListId, list])

  const options = useMemo(
    () => [
      {
        label: 'Tests',
        options: cat.tests
          .filter((t) => !t.disabled)
          .map((t) => ({ value: `test:${t.id}`, label: `${t.code} · ${t.name} · ${formatINR(priceOf(t.id, t.price))}` })),
      },
      {
        label: 'Packages',
        options: cat.packages
          .filter((p) => !p.disabled)
          .map((p) => ({ value: `package:${p.id}`, label: `${p.code} · ${p.name} · ${formatINR(priceOf(p.id, p.price))}` })),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cat.tests, cat.packages, list],
  )

  const add = (val: string) => {
    const [kind, id] = val.split(':')
    let item: BookingItem | null = null
    if (kind === 'test') {
      const t = cat.testById.get(id)
      if (t) item = { kind: 'test', refId: t.id, code: t.code, name: t.name, price: priceOf(t.id, t.price) }
    } else {
      const p = cat.packageById.get(id)
      if (p) item = { kind: 'package', refId: p.id, code: p.code, name: p.name, price: priceOf(p.id, p.price) }
    }
    if (item && !v.items.some((i) => i.kind === item!.kind && i.refId === item!.refId)) {
      onChange({ items: [...v.items, item] })
    }
  }

  const [newName, setNewName] = useState('')
  const [newPrice, setNewPrice] = useState<number | null>(null)

  return (
    <>
      {list && <Tag color="blue" style={{ marginBottom: 8 }}>Rate list: {list.name}</Tag>}
      <Field label="Search tests / packages">
        <Select
          showSearch
          value={null}
          placeholder="Type a test or package name or code"
          style={{ width: '100%' }}
          options={options}
          filterOption={(input, opt) => String(opt?.label ?? '').toLowerCase().includes(input.toLowerCase())}
          onSelect={(val) => add(String(val))}
        />
      </Field>
      {v.items.map((i) => (
        <div
          key={`${i.kind}:${i.refId}`}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--c-outline-variant)' }}
        >
          <Tag color={i.kind === 'package' ? 'purple' : 'blue'}>{i.kind}</Tag>
          <span style={{ flex: 1 }}>{i.code} · {i.name}</span>
          <span>{formatINR(i.price)}</span>
          <Button
            type="text"
            danger
            aria-label={`Remove ${i.name}`}
            icon={<DeleteOutlined />}
            onClick={() => onChange({ items: v.items.filter((x) => x !== i) })}
          />
        </div>
      ))}
      {v.items.length > 0 && (
        <div style={{ textAlign: 'right', fontWeight: 600, marginTop: 8 }}>Tests total: {formatINR(draftTotals(v).tests)}</div>
      )}
      <Field label="Or free-text tests requested (booking stays Unmapped until mapped)">
        <Input.TextArea
          rows={2}
          value={v.freeTextTests}
          onChange={(e) => onChange({ freeTextTests: e.target.value })}
          placeholder="e.g. Sugar fasting, thyroid profile"
        />
      </Field>

      <Field label="Other charges">
        <Select
          value={null}
          placeholder="Add a charge from the master"
          style={{ width: '100%' }}
          options={m.charges.map((c) => ({ value: c.id, label: `${c.name} · ${formatINR(c.price)}` }))}
          onSelect={(id) => {
            const c = m.charges.find((x) => x.id === id)
            if (c && !v.otherCharges.some((x) => x.id === c.id)) {
              onChange({ otherCharges: [...v.otherCharges, { id: c.id, name: c.name, price: c.price }] })
            }
          }}
        />
      </Field>
      <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
        <Input placeholder="New charge name" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New charge name" />
        <InputNumber min={0} placeholder="Amount (₹)" value={newPrice} onChange={setNewPrice} aria-label="New charge amount" style={{ width: 140 }} />
        <Button
          disabled={!newName.trim() || !newPrice}
          onClick={() => {
            onChange({ otherCharges: [...v.otherCharges, { id: 'custom', name: newName.trim(), price: toPaise(newPrice ?? 0) }] })
            setNewName('')
            setNewPrice(null)
          }}
        >
          Add charge
        </Button>
      </Space.Compact>
      {v.otherCharges.map((c, k) => (
        <div key={`${c.id}-${k}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
          <span style={{ flex: 1 }}>{c.name}</span>
          <span>{formatINR(c.price)}</span>
          <Button
            type="text"
            danger
            aria-label={`Remove ${c.name}`}
            icon={<DeleteOutlined />}
            onClick={() => onChange({ otherCharges: v.otherCharges.filter((_, j) => j !== k) })}
          />
        </div>
      ))}
    </>
  )
}

export function ScheduleFields({ value: v, onChange }: SectionProps) {
  const custom = v.slot !== '' && !SLOT_GROUPS.some((g) => g.slots.includes(v.slot))
  return (
    <>
      <Field label="Type">
        <Radio.Group
          value={v.type}
          onChange={(e) => onChange({ type: e.target.value })}
          options={[
            { value: 'homeCollection', label: 'Home collection' },
            { value: 'labVisit', label: 'Lab visit' },
          ]}
        />
      </Field>
      <Row gutter={12}>
        <Col xs={24} md={12}>
          <Field label="Date">
            <DatePicker
              style={{ width: '100%' }}
              value={v.date}
              onChange={(date) => onChange({ date })}
              disabledDate={(d) => d.isBefore(dayjs().startOf('day'))}
            />
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Custom time">
            <TimePicker
              style={{ width: '100%' }}
              format="HH:mm"
              minuteStep={5}
              value={custom ? dayjs(v.slot, 'HH:mm') : null}
              onChange={(t) => onChange({ slot: t ? t.format('HH:mm') : '' })}
            />
          </Field>
        </Col>
      </Row>
      <Field label="Time slot">
        {SLOT_GROUPS.map((g) => (
          <div key={g.label} style={{ marginBottom: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{g.label}</Typography.Text>
            <div role="radiogroup" aria-label={`${g.label} slots`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {g.slots.map((s) => (
                <Button
                  key={s}
                  size="small"
                  role="radio"
                  aria-checked={v.slot === s}
                  type={v.slot === s ? 'primary' : 'default'}
                  onClick={() => onChange({ slot: v.slot === s ? '' : s })}
                >
                  {dayjs(s.slice(0, 5), 'HH:mm').format('h:mm A')}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </Field>
      <Row gutter={12}>
        <Col xs={24} md={12}>
          <Field label="Locality / area">
            <Input value={v.location} onChange={(e) => onChange({ location: e.target.value })} />
          </Field>
        </Col>
        <Col xs={24} md={12}>
          <Field label="Share location (map link)">
            <Space.Compact style={{ width: '100%' }}>
              <Input value={v.locationUrl} onChange={(e) => onChange({ locationUrl: e.target.value })} placeholder="https://maps..." />
              <Button
                onClick={() =>
                  navigator.geolocation?.getCurrentPosition((p) =>
                    onChange({ locationUrl: `https://www.google.com/maps?q=${p.coords.latitude},${p.coords.longitude}` }),
                  )
                }
              >
                Use mine
              </Button>
            </Space.Compact>
          </Field>
        </Col>
        <Col xs={24}>
          <Field label="Special instructions">
            <Input.TextArea rows={2} value={v.specialInstructions} onChange={(e) => onChange({ specialInstructions: e.target.value })} placeholder="Fasting, gate code, floor..." />
          </Field>
        </Col>
      </Row>
      <Typography.Text type="secondary">Scheduling is optional; unscheduled bookings stay in the list.</Typography.Text>
    </>
  )
}

export function ExtraFields({ value: v, onChange }: SectionProps) {
  const defs = useLabSettings().frontDesk?.bookingFields ?? []
  const setTyped = (k: string, val: string) => onChange({ typedFields: { ...v.typedFields, [k]: val } })
  return (
    <Row gutter={12}>
      {defs.map((f) => (
        <Col xs={24} md={12} key={f.key}>
          <Field label={f.label} required={f.required}>
            {f.type === 'select' ? (
              <Select allowClear style={{ width: '100%' }} value={v.typedFields[f.key] || undefined} onChange={(x) => setTyped(f.key, x ?? '')} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />
            ) : (
              <Input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} aria-label={f.label} value={v.typedFields[f.key] ?? ''} onChange={(e) => setTyped(f.key, e.target.value)} />
            )}
          </Field>
        </Col>
      ))}
      <Col xs={24} md={12}>
        <Field label="Source">
          <Select
            style={{ width: '100%' }}
            value={v.source}
            onChange={(source) => onChange({ source })}
            options={Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label }))}
          />
        </Field>
      </Col>
      <Col xs={24} md={12}>
        <Field label="Priority">
          <Select
            style={{ width: '100%' }}
            value={v.priority}
            onChange={(priority) => onChange({ priority })}
            options={Object.entries(PRIORITY_LABEL).map(([value, label]) => ({ value, label }))}
          />
        </Field>
      </Col>
      <Col xs={24} md={12}>
        <Field label="CRM ID">
          <Input value={v.crmId} onChange={(e) => onChange({ crmId: e.target.value })} />
        </Field>
      </Col>
      <Col xs={24} md={12}>
        <Field label="Collection charge (₹)">
          <InputNumber min={0} style={{ width: '100%' }} value={v.collectionCharge} onChange={(n) => onChange({ collectionCharge: n ?? 0 })} />
        </Field>
      </Col>
      <Col xs={24} md={12}>
        <Field label="Discount (₹)">
          <InputNumber min={0} style={{ width: '100%' }} value={v.discount} onChange={(n) => onChange({ discount: n ?? 0 })} />
        </Field>
      </Col>
      <Col xs={24}>
        <Field label="Custom fields">
          {v.customFields.map((f, k) => (
            <Space.Compact key={k} style={{ width: '100%', marginBottom: 4 }}>
              <Input
                placeholder="Field name"
                aria-label="Custom field name"
                value={f.key}
                onChange={(e) => onChange({ customFields: v.customFields.map((x, j) => (j === k ? { ...x, key: e.target.value } : x)) })}
              />
              <Input
                placeholder="Value"
                aria-label="Custom field value"
                value={f.value}
                onChange={(e) => onChange({ customFields: v.customFields.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)) })}
              />
              <Button aria-label="Remove field" icon={<DeleteOutlined />} onClick={() => onChange({ customFields: v.customFields.filter((_, j) => j !== k) })} />
            </Space.Compact>
          ))}
          <Button size="small" onClick={() => onChange({ customFields: [...v.customFields, { key: '', value: '' }] })}>
            Add field
          </Button>
        </Field>
      </Col>
      <Col xs={24}>
        <Field label="Notes">
          <Input.TextArea rows={3} value={v.notes} onChange={(e) => onChange({ notes: e.target.value })} />
        </Field>
      </Col>
    </Row>
  )
}

export function PaymentFields({ value: v, onChange }: SectionProps) {
  const t = draftTotals(v)
  return (
    <>
      <Field label="Payment">
        <Radio.Group
          value={v.paymentChannel}
          onChange={(e) => onChange({ paymentChannel: e.target.value })}
          options={[
            { value: 'collection', label: 'Pay at collection / prepaid at desk' },
            { value: 'online', label: 'Prepaid online' },
          ]}
        />
      </Field>
      <Row gutter={12}>
        <Col xs={24} md={8}>
          <Field label="Prepaid amount (₹)">
            <InputNumber min={0} style={{ width: '100%' }} value={v.prepaid} onChange={(n) => onChange({ prepaid: n ?? 0 })} />
          </Field>
        </Col>
        <Col xs={24} md={8}>
          <Field label="Mode">
            <Select
              style={{ width: '100%' }}
              value={v.prepaidMode}
              onChange={(prepaidMode) => onChange({ prepaidMode })}
              options={[
                { value: 'cash', label: 'Cash' },
                { value: 'upi', label: 'UPI' },
                { value: 'card', label: 'Card' },
              ]}
            />
          </Field>
        </Col>
        {v.paymentChannel === 'online' && (
          <Col xs={24} md={8}>
            <Field label="Online payment reference">
              <Input value={v.paymentRef} onChange={(e) => onChange({ paymentRef: e.target.value })} placeholder="Transaction / link ID" />
            </Field>
          </Col>
        )}
      </Row>
      {v.paymentChannel === 'online' && (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message={v.paymentRef.trim() ? 'Recorded as paid online.' : 'Save the booking, then open it and use Pay online to take the payment through the gateway. If you already have a transaction ID you can paste it here instead.'}
        />
      )}
      <Descriptions size="small" bordered column={1}>
        <Descriptions.Item label="Tests">{formatINR(t.tests)}</Descriptions.Item>
        <Descriptions.Item label="Collection charge">{formatINR(t.charge)}</Descriptions.Item>
        <Descriptions.Item label="Other charges">{formatINR(t.other)}</Descriptions.Item>
        <Descriptions.Item label="Total">{formatINR(t.total)}</Descriptions.Item>
        <Descriptions.Item label="Discount">{formatINR(t.discount)}</Descriptions.Item>
        <Descriptions.Item label="Net">{formatINR(t.net)}</Descriptions.Item>
        <Descriptions.Item label="Prepaid">{formatINR(t.prepaid)}</Descriptions.Item>
        <Descriptions.Item label="Balance">
          <b>{formatINR(t.balance)}</b>
        </Descriptions.Item>
      </Descriptions>
    </>
  )
}
