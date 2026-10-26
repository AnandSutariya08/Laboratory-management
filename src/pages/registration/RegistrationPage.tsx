import { useEffect, useMemo, useRef, useState } from 'react'
import { isRegistrationFieldHidden } from '../../features/settings/lib'
import { Alert, App, AutoComplete, DatePicker, Dropdown, Form, Input, InputNumber, Modal, Radio, Select, Switch, Table } from 'antd'
import { EllipsisOutlined, FileTextOutlined } from '@ant-design/icons'
import { limit, orderBy, query } from 'firebase/firestore'
import dayjs, { type Dayjs } from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import type { BillContext } from '../../lib/orders'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { col, docRef, paths } from '../../lib/db'
import { useMasters, type PartnerContext } from '../../lib/masters'
import { createPatient, updatePatient } from '../../lib/orders'
import { useFrontDesk } from '../../lib/frontDesk'
import { formatINR } from '../../lib/money'
import { useAuth, can } from '../../auth/AuthProvider'
import { useMaster } from '../../features/patient/lib'
import FrontDeskSettingsModal from './FrontDeskSettingsModal'
import { catalogueLine, displayId } from '../../lib/billing'
import type { OrderItem } from '../../types'
import { ageInDays, salutationFor } from '../../lib/results'
import type { AgeUnit, DispatchMode, Gender, Patient, UserProfile } from '../../types'
import BillingModal from '../../components/billing/BillingModal'
import { ageText, DISPATCH_OPTIONS, GENDER_SHORT } from '../../components/billing/helpers'
import { PartnerFields } from '../../components/billing/PartnerFields'
import QuotationModal from '../../features/quotations/QuotationModal'
import './registration.css'

interface FormValues {
  salutation: string
  firstName: string
  lastName: string
  gender: Gender
  ageY: number | null
  ageM: number | null
  ageD: number | null
  dob: Dayjs | null
  countryCode: string
  phone: string
  altPhone: string
  email: string
  address: string
  city: string
  pincode: string
  uhid: string
  abhaNo: string
  idType: string
  idNumber: string
  dispatchModes: DispatchMode[]
  notes: string
  insuranceNo: string
  district: string
  town: string
  weight: number | null
  height: number | null
  clinicalHistory: string
  category: string
  species: string
  breed: string
  ownerName: string
  corporateUser: string
  corporatePlanId: string
  collectionDateTime: Dayjs | null
  phlebotomistId: string
  proId: string
  customFields: Record<string, string>
}

const COUNTRY_CODES = [
  ['+91', 'India (+91)'], ['+1', 'US / Canada (+1)'], ['+44', 'UK (+44)'], ['+971', 'UAE (+971)'], ['+966', 'Saudi Arabia (+966)'],
  ['+974', 'Qatar (+974)'], ['+968', 'Oman (+968)'], ['+965', 'Kuwait (+965)'], ['+977', 'Nepal (+977)'], ['+880', 'Bangladesh (+880)'],
  ['+94', 'Sri Lanka (+94)'], ['+65', 'Singapore (+65)'], ['+61', 'Australia (+61)'],
].map(([value, label]) => ({ value, label }))
const ID_TYPES = ['Aadhaar', 'Passport', 'Driving licence', 'Voter ID', 'PAN', 'Other'].map((v) => ({ value: v, label: v }))

// Age as Y/M/D from either entered parts or a date of birth.
// A phone number long enough to look up (10 digits for India).
const cc0Valid = (cc: string, phone: string) => (cc === '+91' ? /^\d{10}$/.test(phone) : /^\d{6,15}$/.test(phone))

function deriveAge(mode: 'age' | 'dob', v: Partial<FormValues>) {
  let y = 0, m = 0, d = 0
  let dob: Dayjs | null = null
  if (mode === 'dob') {
    if (!v.dob) return null
    dob = v.dob
    const now = dayjs()
    y = now.diff(dob, 'year')
    m = now.subtract(y, 'year').diff(dob, 'month')
    d = now.subtract(y, 'year').subtract(m, 'month').diff(dob, 'day')
  } else {
    if (v.ageY == null && v.ageM == null && v.ageD == null) return null
    y = v.ageY ?? 0; m = v.ageM ?? 0; d = v.ageD ?? 0
    dob = dayjs().subtract(y, 'year').subtract(m, 'month').subtract(d, 'day')
  }
  const [ageValue, ageUnit]: [number, AgeUnit] = y > 0 ? [y, 'year'] : m > 0 ? [m, 'month'] : [d, 'day']
  return { y, m, d, ageValue, ageUnit, dob }
}

export default function RegistrationPage() {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const settings = useLabSettings()
  const reg = settings.registration
  const masters = useMasters()
  const [form] = Form.useForm<FormValues>()
  const [search, setSearch] = useState('')
  const [existing, setExisting] = useState<Patient | null>(null)
  const [saving, setSaving] = useState(false)
  const [billing, setBilling] = useState<Patient | null>(null)
  const [planLines, setPlanLines] = useState<OrderItem[]>([])
  const [quote, setQuote] = useState(false)
  const [ageMode, setAgeMode] = useState<'age' | 'dob'>('age')
  const [partners, setPartners] = useState<PartnerContext>({})
  const [priority, setPriority] = useState<'routine' | 'urgent'>('routine')
  const [collectedAt, setCollectedAt] = useState<'lab' | 'home'>('lab')
  const salTouched = useRef(false)
  const { profile } = useAuth()
  const fd = useFrontDesk()
  const L = fd.label
  const H = (k: string) => isRegistrationFieldHidden(settings, k)
  const [fdOpen, setFdOpen] = useState(false)
  const [animal, setAnimal] = useState(false)
  const [extraCtx, setExtraCtx] = useState<BillContext>({})
  const cat = useCatalogueMaps()
  const proTouched = useRef(false)
  const users = useLiveQuery<UserProfile>(query(col(paths.users), orderBy('name')), []).data
  const phlebs = users.filter((u) => u.role === 'phlebotomist' && u.active !== false)
  const pros = useMaster('marketingTeam') as { id: string; name: string }[]
  // External logins (B2B centre, collection centre, corporate) register only for their own partner:
  // the partner is fixed and its select is hidden.
  const scopeKey: keyof PartnerContext | null =
    profile?.partnerId && profile.role === 'b2b' ? 'b2bCentreId'
    : profile?.partnerId && profile.role === 'collectionCentre' ? 'collectionCentreId'
    : profile?.partnerId && profile.role === 'corporate' ? 'corporateClientId' : null
  const scopedValue = scopeKey ? partners[scopeKey] : undefined
  useEffect(() => {
    if (scopeKey && profile?.partnerId && scopedValue !== profile.partnerId) setPartners((p) => ({ ...p, [scopeKey]: profile.partnerId }))
  }, [scopeKey, scopedValue, profile?.partnerId])
  useEffect(() => {
    if (proTouched.current || existing) return
    const pm = masters.doctors.find((d) => d.id === partners.referrerId)?.proManagerId
    form.setFieldValue('proId', pm ?? '')
  }, [partners.referrerId, masters.doctors, existing, form])

  const required = reg.requiredFields
  const req = (k: string) => required.includes(k)

  // Recent patients are watched live; matching happens client-side.
  const { data: patients } = useLiveQuery<Patient>(query(col(paths.patients), orderBy('createdAt', 'desc'), limit(500)), [])

  const day = dayjs().format('YYMMDD')
  const { data: counter } = useLiveDoc<{ value: number }>(docRef(paths.counters, `patient-${day}`), [day])
  const nextPatientNo = `${day}${String((counter?.value ?? 0) + 1).padStart(3, '0')}`

  const initial: Partial<FormValues> = {
    salutation: '', gender: 'male', countryCode: '+91', ageY: null, ageM: null, ageD: null, dob: null,
    dispatchModes: settings.dispatchDefaults, notes: '', weight: null, height: null, collectionDateTime: null, customFields: {},
  }
  // SET-06: bills for a B2B centre start from the B2B dispatch defaults (when the user has not chosen modes yet).
  const defaultDispatch = partners.b2bCentreId && reg.dispatchDefaultsB2b?.length ? reg.dispatchDefaultsB2b : settings.dispatchDefaults
  useEffect(() => {
    if (!form.isFieldTouched('dispatchModes')) form.setFieldValue('dispatchModes', defaultDispatch)
  }, [defaultDispatch, form])

  const w = Form.useWatch([], form) as Partial<FormValues> | undefined
  const gender = w?.gender
  const age = useMemo(() => deriveAge(ageMode, w ?? {}), [ageMode, w])
  const autoSal = gender && age ? salutationFor(gender, ageInDays(age.ageValue, age.ageUnit)) : ''
  useEffect(() => {
    if (reg.autoSalutationFromGender && !salTouched.current && !existing) form.setFieldValue('salutation', autoSal)
  }, [autoSal, reg.autoSalutationFromGender, existing, form])

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q.length < 2) return []
    return patients
      .filter((p) => !(p as { merged?: boolean }).merged)
      .filter((p) =>
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(q) ||
        (p.phone ?? '').includes(q) ||
        p.patientNo.includes(q) ||
        (p.uhid ?? '').toLowerCase().includes(q) ||
        (p.abhaNo ?? '').includes(q),
      )
      .slice(0, 12)
  }, [patients, search])

  const phone = w?.phone ?? ''
  const [dupOpen, setDupOpen] = useState(false)
  const dupPrompted = useRef('')
  const duplicates = useMemo(
    () => (phone.length >= 6 ? patients.filter((p) => p.phone === phone && p.id !== existing?.id).slice(0, 5) : []),
    [patients, phone, existing],
  )

  // Typing a phone that is already registered opens a list: Select loads that patient, OK carries on with a new patient
  // on the same number (the same phone may belong to many patients).
  const fullPhone = cc0Valid(w?.countryCode ?? '+91', phone)
  useEffect(() => {
    // Not while saving: the patient just created shows up in the live list a moment before the form is linked to it.
    if (saving || !fullPhone || existing || duplicates.length === 0 || dupPrompted.current === phone) return
    dupPrompted.current = phone
    setDupOpen(true)
  }, [fullPhone, phone, duplicates.length, existing, saving])
  // Never leave an empty list open (e.g. the only match turned out to be this patient).
  useEffect(() => {
    if (dupOpen && duplicates.length === 0) setDupOpen(false)
  }, [dupOpen, duplicates.length])

  // Same phone + same name + age within 2 years: the likely-duplicate rule.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
  const strongDuplicate = (v: FormValues, ageVal: number, unit: AgeUnit) =>
    patients.find((p) => {
      if (existing?.id === p.id || !v.phone || p.phone !== v.phone) return false
      if (norm(`${p.firstName}${p.lastName}`) !== norm(`${v.firstName}${v.lastName ?? ''}`)) return false
      const y = (n: number, u: AgeUnit) => (u === 'year' ? n : u === 'month' ? n / 12 : n / 365)
      return Math.abs(y(p.ageValue, p.ageUnit) - y(ageVal, unit)) <= 2
    })

  const pick = (p: Patient) => {
    setExisting(p)
    salTouched.current = true
    setAgeMode(p.dob ? 'dob' : 'age')
    form.setFieldsValue({
      salutation: p.salutation, firstName: p.firstName, lastName: p.lastName, gender: p.gender,
      ageY: p.ageUnit === 'year' ? p.ageValue : null, ageM: p.ageUnit === 'month' ? p.ageValue : null, ageD: p.ageUnit === 'day' ? p.ageValue : null,
      dob: p.dob ? dayjs(p.dob) : null,
      countryCode: p.countryCode ?? '+91', phone: p.phone, altPhone: p.altPhone ?? '', email: p.email,
      address: p.address ?? '', city: p.city ?? '', pincode: p.pincode ?? '', uhid: p.uhid ?? '', abhaNo: p.abhaNo ?? '',
      idType: p.idType, idNumber: p.idNumber ?? '',
      // Dispatch methods are not kept on the patient: every new bill starts from the lab's defaults.
      dispatchModes: defaultDispatch,
      insuranceNo: p.insuranceNo ?? '', district: p.district ?? '', town: p.town ?? '', weight: p.weight ?? null, height: p.height ?? null,
      clinicalHistory: p.clinicalHistory ?? '', category: p.category ?? '', species: p.species ?? '', breed: p.breed ?? '', ownerName: p.ownerName ?? '',
      corporateUser: p.corporateUser ?? '', corporatePlanId: p.corporatePlanId ?? '', customFields: p.customFields ?? {},
    })
    setAnimal(!!(p.species || p.breed || p.ownerName))
    setPartners((x) => ({ ...x, referrerId: p.referrerId, hospitalId: p.hospitalId, secondReferrerId: p.secondReferrerId }))
    setSearch('')
  }

  const reset = () => {
    form.resetFields()
    form.setFieldValue('dispatchModes', settings.dispatchDefaults)
    form.setFields([{ name: 'dispatchModes', touched: false }])
    dupPrompted.current = ''
    setExisting(null)
    setSearch('')
    setPartners({})
    setExtraCtx({})
    proTouched.current = false
    setAnimal(false)
    setPriority('routine')
    setCollectedAt('lab')
    setAgeMode('age')
    salTouched.current = false
  }

  const corpClient = masters.corporateClients.find((c) => c.id === partners.corporateClientId)
  // Plans on offer: priced plans that are active and in date today; older clients fall back to their package mapping.
  const planOptions = useMemo(() => {
    if (!corpClient) return []
    const today = dayjs().format('YYYY-MM-DD')
    const live = (corpClient.plans ?? []).filter((p) => p.active !== false && (!p.validFrom || p.validFrom <= today) && (!p.validTo || p.validTo >= today))
    const out = live.map((p) => ({ value: p.id, label: `${p.name}${p.price ? ` · ${formatINR(p.price)}` : ''}` }))
    if (!(corpClient.plans ?? []).length) for (const id of corpClient.planPackageIds ?? []) out.push({ value: id, label: cat.packageById.get(id)?.name ?? id })
    return out
  }, [corpClient, cat.packageById])
  // Lines the chosen plan puts on the bill: its packages, the plan price shared over them by MRP.
  const buildPlanLines = (planId?: string): OrderItem[] => {
    const plan = corpClient?.plans?.find((p) => p.id === planId)
    if (!plan) return []
    const pkgs = plan.packageIds.map((id) => cat.packageById.get(id)).filter((x): x is NonNullable<typeof x> => !!x)
    const mrp = pkgs.reduce((n, x) => n + x.price, 0)
    let left = plan.price
    return pkgs.map((pk, i) => {
      const price = plan.price > 0 ? (i === pkgs.length - 1 ? left : Math.round((plan.price * pk.price) / (mrp || 1))) : pk.price
      left -= price
      return catalogueLine('package', pk.id, pk.code, pk.name, price, pk.testIds)
    })
  }

  const missingPartner = (): string | null => {
    const map: [string, keyof PartnerContext, string][] = [
      ['referrer', 'referrerId', 'Referring doctor'], ['hospital', 'hospitalId', 'Referring hospital'],
      ['b2bCentre', 'b2bCentreId', 'B2B centre'], ['collectionCentre', 'collectionCentreId', 'Collection centre'],
      ['company', 'corporateClientId', 'Corporate client'], ['govPanel', 'govPanelId', 'Government panel'], ['tpa', 'tpaId', 'TPA'],
      ['secondReferrer', 'secondReferrerId', 'Second referral'], ['rateList', 'rateListId', 'Rate list'],
    ]
    const m = map.find(([k, f]) => req(k) && !partners[f])
    return m ? `${m[2]} is required.` : null
  }

  const goToBilling = async () => {
    // One combined message listing every missing required field (Flabs behaviour).
    const cur = form.getFieldsValue() as Partial<FormValues>
    // Age from the live form values: the watched copy can lag one render behind a fast click.
    const age = deriveAge(ageMode, cur)
    const missing: string[] = []
    if (!(cur.firstName ?? '').trim()) missing.push('First Name')
    if (!cur.gender) missing.push('Gender')
    if (!age) missing.push('Age/DOB info (Age & Type, or DOB, or Year/Month/Day)')
    const extra: [string, unknown, string][] = [
      ['lastName', cur.lastName?.trim(), 'Last Name'], ['phone', cur.phone?.trim(), 'Phone Number'], ['email', cur.email?.trim(), 'Email'],
      ['address', cur.address?.trim(), 'Address'], ['pincode', cur.pincode?.trim(), 'Pincode'], ['aadhaar', cur.idNumber?.trim(), 'ID number'],
      ['uhid', reg.uhidMode === 'auto' ? 'x' : cur.uhid?.trim(), 'UHID'],
      ['insuranceNo', cur.insuranceNo?.trim(), L('insuranceNo', 'Insurance no.')], ['district', cur.district?.trim(), L('district', 'District')], ['town', cur.town?.trim(), L('town', 'Town')],
      ['weight', cur.weight, L('weight', 'Weight')], ['height', cur.height, L('height', 'Height')], ['clinicalHistory', cur.clinicalHistory?.trim(), L('clinicalHistory', 'Clinical history')],
      ['category', cur.category?.trim(), L('category', 'Category')], ['species', cur.species?.trim(), L('species', 'Species')], ['breed', cur.breed?.trim(), L('breed', 'Breed')],
      ['owner', cur.ownerName?.trim(), L('owner', 'Owner name')], ['corporateUser', cur.corporateUser?.trim(), L('corporateUser', 'Corporate user')],
      ['corporatePlan', cur.corporatePlanId, L('corporatePlan', 'Corporate plan')], ['collectionDateTime', cur.collectionDateTime, L('collectionDateTime', 'Collection date and time')],
      ['phlebotomist', cur.phlebotomistId, L('phlebotomist', 'Phlebotomist')], ['pro', cur.proId, L('pro', 'PRO')],
      ['dispatch', (cur.dispatchModes ?? []).length > 0 ? 'x' : '', L('dispatch', 'Dispatch methods')],
      ...fd.customFields.filter((c) => c.required).map((c): [string, unknown, string] => ['custom', cur.customFields?.[c.key]?.toString().trim(), c.label]),
    ]
    for (const [k, val, label] of extra) if ((k === 'custom' || req(k)) && !val) missing.push(label)
    // Corporate client flag: every bill needs the employee ID.
    if (corpClient?.employeeIdRequired && !(cur.corporateUser ?? '').trim() && !missing.includes(L('corporateUser', 'Corporate user'))) missing.push(L('corporateUser', 'Employee ID'))
    if (missing.length) {
      message.warning(`Please fill all Required fields: ${missing.join(', ')}`)
      return
    }
    let v: FormValues
    try {
      v = await form.validateFields()
    } catch (e) {
      const names = ((e as { errorFields?: { errors: string[] }[] }).errorFields ?? []).flatMap((f) => f.errors)
      message.warning(names.length ? names.join('. ') : 'Please fix the highlighted fields.')
      return
    }
    const pm = missingPartner()
    if (pm) return message.warning(pm)
    if (!age) return message.warning('Enter the age or date of birth.')
    if (age.y + age.m + age.d === 0) return message.warning('Age must be more than zero.')
    if (reg.uniqueContact && v.phone && duplicates.length > 0) {
      return message.error('This contact number is already registered. Pick the existing patient.')
    }
    if (!existing && reg.strongDuplicateGuard) {
      const dup = strongDuplicate(v, age.ageValue, age.ageUnit)
      if (dup) {
        const go = await new Promise<boolean>((resolve) =>
          modal.confirm({
            title: 'Possible duplicate patient',
            content: `${dup.salutation} ${dup.firstName} ${dup.lastName} (${dup.patientNo}) has the same phone, name and a similar age. Register a new patient anyway?`,
            okText: 'Register new',
            cancelText: 'Cancel',
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          }),
        )
        if (!go) return
      }
    }
    setSaving(true)
    try {
      const fields = {
        salutation: v.salutation ?? '',
        firstName: v.firstName.trim(),
        lastName: (v.lastName ?? '').trim(),
        gender: v.gender,
        ageValue: age.ageValue,
        ageUnit: age.ageUnit,
        dob: age.dob?.format('YYYY-MM-DD'),
        countryCode: v.countryCode,
        phone: (v.phone ?? '').trim(),
        altPhone: (v.altPhone ?? '').trim() || undefined,
        email: (v.email ?? '').trim(),
        address: (v.address ?? '').trim() || undefined,
        city: (v.city ?? '').trim() || undefined,
        pincode: (v.pincode ?? '').trim() || undefined,
        insuranceNo: (v.insuranceNo ?? '').trim() || undefined,
        district: (v.district ?? '').trim() || undefined,
        town: (v.town ?? '').trim() || undefined,
        weight: v.weight ?? undefined,
        height: v.height ?? undefined,
        clinicalHistory: (v.clinicalHistory ?? '').trim() || undefined,
        category: (v.category ?? '').trim() || undefined,
        species: (v.species ?? '').trim() || undefined,
        breed: (v.breed ?? '').trim() || undefined,
        ownerName: (v.ownerName ?? '').trim() || undefined,
        corporateUser: (v.corporateUser ?? '').trim() || undefined,
        corporatePlanId: v.corporatePlanId || undefined,
        customFields: Object.fromEntries(Object.entries(v.customFields ?? {}).filter(([, x]) => String(x ?? '').trim() !== '')) as Record<string, string>,
        abhaNo: (v.abhaNo ?? '').replace(/\D/g, '') || undefined,
        idType: v.idNumber ? v.idType : undefined,
        idNumber: (v.idNumber ?? '').trim() || undefined,
        dispatchModes: v.dispatchModes ?? [],
        referrerName: masters.doctors.find((d) => d.id === partners.referrerId)?.name ?? '',
        referrerId: partners.referrerId,
        hospitalId: partners.hospitalId,
        secondReferrerId: partners.secondReferrerId,
      }
      let patient = existing
      if (patient) {
        // Picked an existing patient and edited it: update that patient, never a duplicate.
        const uhid = reg.uhidMode !== 'auto' ? (v.uhid ?? '').trim() || undefined : undefined
        const changed = (Object.keys(fields) as (keyof typeof fields)[]).some((k) => JSON.stringify(fields[k] ?? null) !== JSON.stringify((patient as unknown as Record<string, unknown>)[k] ?? null))
        if (changed || (uhid && uhid !== patient.uhid)) patient = await updatePatient(patient, { ...fields, ...(uhid ? { uhid } : {}) })
        message.success('Patient updated')
      } else {
        patient = await createPatient(
          { ...fields, uhid: reg.uhidMode !== 'auto' ? (v.uhid ?? '').trim() || undefined : undefined },
          { autoUhid: reg.uhidMode === 'auto' },
        )
        // Keep the form tied to the patient just created, so closing billing and
        // pressing Go to Billing again reuses it instead of registering a duplicate.
        setExisting(patient)
        message.success('Patient registered')
      }
      setExtraCtx({
        phlebotomistId: v.phlebotomistId || undefined,
        phlebotomistName: phlebs.find((u) => u.uid === v.phlebotomistId)?.name,
        collectionDateTime: v.collectionDateTime ? v.collectionDateTime.toDate() : undefined,
        proId: v.proId || undefined,
        proName: pros.find((x) => x.id === v.proId)?.name,
        corporateUser: (v.corporateUser ?? '').trim() || undefined,
        corporatePlan: v.corporatePlanId ? (corpClient?.plans?.find((p) => p.id === v.corporatePlanId)?.name ?? cat.packageById.get(v.corporatePlanId)?.name) : undefined,
        corporatePlanId: v.corporatePlanId || undefined,
        disableLetterhead: corpClient?.disableLetterhead || undefined,
        hidePlan: corpClient?.hidePlan || undefined,
        clinicalHistory: (v.clinicalHistory ?? '').trim() || undefined,
        weight: v.weight ?? undefined,
        height: v.height ?? undefined,
        category: (v.category ?? '').trim() || undefined,
      })
      setPlanLines(buildPlanLines(v.corporatePlanId))
      setBilling(patient)
    } catch (e) {
      message.error(`Could not save patient: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const cc = w?.countryCode ?? '+91'
  const phoneRule = { pattern: cc === '+91' ? /^\d{10}$/ : /^\d{6,15}$/, message: cc === '+91' ? 'Enter a 10 digit number' : 'Enter 6 to 15 digits' }
  const RN = (k: string, label: string) => ({ required: req(k), message: `${label} is required` })
  const R = (k: string, label: string) => ({ required: req(k), whitespace: true, message: `${label} is required` })

  const menu = {
    items: [
      { key: 'quotations', label: 'Quotation tracking' },
      { key: 'bulk', label: 'Bulk registration' },
      { key: 'reset', label: 'Reset form' },
      ...(can(profile, 'settings.manage') ? [{ key: 'frontdesk', label: 'Front desk settings' }] : []),
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'quotations') navigate('/quotations')
      else if (key === 'bulk') navigate('/bulk-registration')
      else if (key === 'frontdesk') setFdOpen(true)
      else reset()
    },
  }

  return (
    <div className="reg">
      <PageHeader
        title="New Registration"
        subtitle="Register a patient, then bill their tests."
        actions={
          <>
            <Dropdown menu={menu} trigger={['click']}>
              <Button aria-label="More registration actions" icon={<EllipsisOutlined />} />
            </Dropdown>
            {can(profile, 'quotation.manage') && <Button icon={<FileTextOutlined />} onClick={() => setQuote(true)}>Create quotation</Button>}
            <Button variant="primary" disabled={saving} onClick={goToBilling}>Go to Billing</Button>
          </>
        }
      />

      <Card padding={16}>
        <label className="bill-field-label" htmlFor="reg-search">Search existing patient by phone, name, patient ID or UHID</label>
        <AutoComplete
          id="reg-search"
          style={{ width: '100%' }}
          value={search}
          onChange={setSearch}
          placeholder="Type at least 2 characters"
          options={matches.map((p) => ({
            value: p.id,
            label: (
              <span className="reg__hit">
                <b>{`${p.salutation} ${p.firstName} ${p.lastName}`.replace(/\s+/g, ' ').trim()}</b>
                <span>{ageText(p.ageValue, p.ageUnit)} / {GENDER_SHORT[p.gender]}</span>
                <span>{p.phone || 'no phone'}</span>
                <StatusChip variant="info">{displayId(p, reg.idDisplay)}</StatusChip>
                {p.uhid && reg.idDisplay !== 'uhid' && <StatusChip>{p.uhid}</StatusChip>}
                {p.createdAt?.toDate && <span>Registered on {dayjs(p.createdAt.toDate()).format('DD-MM-YYYY')}</span>}
              </span>
            ),
          }))}
          onSelect={(id: string) => {
            const p = patients.find((x) => x.id === id)
            if (p) pick(p)
          }}
          notFoundContent={search.trim().length >= 2 ? 'No matching patient. Fill the form to register.' : null}
        />
      </Card>

      <Form
        form={form}
        layout="vertical"
        initialValues={initial}
        requiredMark
        onValuesChange={(changed) => {
          if ('salutation' in changed) salTouched.current = true
        }}
      >
        <div className="reg">
          <Card padding={20} className="reg-pd">
            <div className="reg-pd__head">
              <h2 className="reg__card-title reg-pd__title">Patient details</h2>
              <div className="reg-pd__ids">
                <span className="reg-pd__idlabel">Patient ID</span>
                <StatusChip variant="info">{existing ? existing.patientNo : `${nextPatientNo} (assigned on save)`}</StatusChip>
                {existing?.uhid && <StatusChip>UHID {existing.uhid}</StatusChip>}
                {existing && <StatusChip variant="success">Existing patient</StatusChip>}
                {existing && <Button variant="text" onClick={reset}>Clear</Button>}
              </div>
            </div>
            <div className="reg-pd__grid">
              {/* Name: salutation + first + last read as one line. */}
              <div className="reg-pd__name">
                <Form.Item name="salutation" label="Title" className="reg-pd__sal">
                  <Select allowClear options={reg.salutations.map((s) => ({ value: s, label: s }))} placeholder="Auto" />
                </Form.Item>
                <Form.Item name="firstName" label="First name" rules={[{ required: true, whitespace: true, message: 'First name is required' }, { pattern: /\D/, message: 'First name cannot be only digits' }]}>
                  <Input maxLength={80} autoFocus />
                </Form.Item>
                <Form.Item name="lastName" hidden={H('lastName')} label={L('lastName', 'Last name')} rules={[R('lastName', 'Last name')]}>
                  <Input maxLength={80} />
                </Form.Item>
              </div>
              <Form.Item name="gender" label="Gender" className="reg-pd__gender" rules={[{ required: true, message: 'Select gender' }]}>
                <Radio.Group
                  optionType="button"
                  buttonStyle="solid"
                  options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]}
                />
              </Form.Item>
              <Form.Item
                className="reg-pd__age"
                required
                label={ageMode === 'age' ? 'Age' : 'Date of birth'}
              >
                <div className="reg-pd__agerow">
                  {ageMode === 'age' ? (
                    <div className="reg__age">
                      {(['year', 'month', 'day'] as ('year' | 'month' | 'day')[])
                        .sort((a, b) => (a === reg.defaultAgeUnit ? -1 : b === reg.defaultAgeUnit ? 1 : 0))
                        .map((u) =>
                          u === 'year' ? <Form.Item key={u} name="ageY" noStyle><InputNumber min={0} max={150} precision={0} addonAfter="Y" aria-label="Age in years" /></Form.Item>
                          : u === 'month' ? <Form.Item key={u} name="ageM" noStyle><InputNumber min={0} max={11} precision={0} addonAfter="M" aria-label="Age in months" /></Form.Item>
                          : <Form.Item key={u} name="ageD" noStyle><InputNumber min={0} max={31} precision={0} addonAfter="D" aria-label="Age in days" /></Form.Item>,
                        )}
                    </div>
                  ) : (
                    <Form.Item name="dob" noStyle>
                      <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" disabledDate={(d) => d.isAfter(dayjs())} aria-label="Date of birth" />
                    </Form.Item>
                  )}
                  <Segmented<'age' | 'dob'> aria-label="Enter age or date of birth" value={ageMode} onChange={setAgeMode}
                    options={[{ value: 'age', label: 'Age' }, { value: 'dob', label: 'DOB' }]} />
                  <StatusChip variant={age ? 'success' : 'neutral'}>{age ? `${age.y}Y ${age.m}M ${age.d}D` : 'Required'}</StatusChip>
                </div>
              </Form.Item>
            </div>
          </Card>

          <Card padding={20}>
            <h2 className="reg__card-title">Contact and identity</h2>
            <div className="reg__grid">
              <Form.Item label={L('phone', 'Phone')} hidden={H('phone')} required={req('phone')} style={{ marginBottom: 0 }}>
                <div className="reg__phone">
                  <Form.Item name="countryCode" noStyle>
                    <Select style={{ width: 150 }} showSearch options={COUNTRY_CODES} aria-label="Country code" />
                  </Form.Item>
                  <Form.Item
                    name="phone"
                    noStyle
                    rules={[
                      R('phone', 'Phone'),
                      phoneRule,
                    ]}
                  >
                    <Input maxLength={15} inputMode="numeric" aria-label="Phone" />
                  </Form.Item>
                </div>
                <div style={{ minHeight: 24 }} />
              </Form.Item>
              <Form.Item name="altPhone" label="Alternate phone" rules={[phoneRule]}>
                <Input maxLength={15} inputMode="numeric" />
              </Form.Item>
              <Form.Item
                name="email"
                hidden={H('email')}
                label={L('email', 'Email')}
                rules={[R('email', 'Email'), { type: 'email', message: 'Invalid email' }]}
              >
                <Input />
              </Form.Item>
              {duplicates.length > 0 && reg.uniqueContact && (
                <div className="reg__span3" style={{ marginBottom: 'var(--s-3)' }}>
                  <Alert
                    type={reg.uniqueContact ? 'error' : 'warning'}
                    showIcon
                    message={reg.uniqueContact ? 'This contact number is already registered' : 'Possible duplicate: this phone number is already registered'}
                    description={duplicates.map((p) => (
                      <div key={p.id} className="reg__match">
                        <span>{`${p.salutation} ${p.firstName} ${p.lastName}`.replace(/\s+/g, ' ').trim()} · {ageText(p.ageValue, p.ageUnit)} / {GENDER_SHORT[p.gender]} · {p.patientNo}</span>
                        <Button onClick={() => pick(p)}>Use this patient</Button>
                      </div>
                    ))}
                  />
                </div>
              )}
              <Form.Item name="address" hidden={H('address')} label={L('address', 'Address')} className="reg__span2" rules={[R('address', 'Address')]}>
                <Input.TextArea rows={2} maxLength={300} />
              </Form.Item>
              <Form.Item name="city" label="City"><Input maxLength={80} /></Form.Item>
              <Form.Item name="pincode" hidden={H('pincode')} label={L('pincode', 'Pincode')} rules={[R('pincode', 'Pincode'), { pattern: /^\d{6}$/, message: 'Enter a 6 digit pincode' }]}>
                <Input maxLength={6} inputMode="numeric" />
              </Form.Item>
              <Form.Item name="district" hidden={H('district')} label={L('district', 'District')} rules={[R('district', 'District')]}><Input maxLength={80} /></Form.Item>
              <Form.Item name="town" hidden={H('town')} label={L('town', 'Town')} rules={[R('town', 'Town')]}><Input maxLength={80} /></Form.Item>
              <Form.Item name="insuranceNo" hidden={H('insuranceNo')} label={L('insuranceNo', 'Insurance no.')} rules={[R('insuranceNo', 'Insurance no.')]}><Input maxLength={40} /></Form.Item>
              {reg.uhidMode !== 'auto' ? (
                <Form.Item name="uhid" hidden={H('uhid') || (reg.uhidMode === 'none' && !req('uhid'))} label={L('uhid', 'UHID')} rules={[R('uhid', 'UHID')]}><Input maxLength={30} /></Form.Item>
              ) : (
                <Form.Item label={L('uhid', 'UHID')} hidden={H('uhid')}><Input disabled value={existing?.uhid ?? ''} placeholder="Assigned on save" aria-label="UHID" /></Form.Item>
              )}
              <Form.Item name="abhaNo" label="ABHA number" rules={[{ pattern: /^(\d{14}|\d{2}-\d{4}-\d{4}-\d{4})$/, message: 'ABHA is 14 digits' }]}>
                <Input maxLength={17} placeholder="14 digits" />
              </Form.Item>
              <Form.Item label={L('aadhaar', 'Passport / ID')} hidden={H('aadhaar')} required={req('aadhaar')} className="reg__span2" style={{ marginBottom: 0 }}>
                <div className="reg__phone">
                  <Form.Item name="idType" noStyle><Select style={{ width: 180, flex: '0 0 auto' }} options={ID_TYPES} placeholder="ID type" aria-label="ID type" /></Form.Item>
                  <Form.Item name="idNumber" noStyle rules={[R('aadhaar', 'ID number')]}><Input maxLength={30} aria-label="ID number" /></Form.Item>
                </div>
              </Form.Item>
            </div>
          </Card>

          <Card padding={20}>
            <h2 className="reg__card-title">Referral and payer</h2>
            <PartnerFields value={partners} onChange={setPartners} required={required} configurable withRateList={!scopeKey}
              only={scopeKey ? (['referrerId', 'hospitalId', 'secondReferrerId', 'b2bCentreId', 'collectionCentreId', 'corporateClientId', 'govPanelId', 'tpaId'] as (keyof PartnerContext)[]).filter((k) => k !== scopeKey && (scopeKey !== 'b2bCentreId' || (k !== 'govPanelId' && k !== 'tpaId'))) : undefined} />
          </Card>

          <Card padding={20}>
            <h2 className="reg__card-title">Clinical details</h2>
            <div className="reg__grid">
              <Form.Item name="weight" hidden={H('weight')} label={L('weight', 'Weight (kg)')} rules={[RN('weight', 'Weight')]}>
                <InputNumber min={0} max={500} precision={1} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="height" hidden={H('height')} label={L('height', 'Height (cm)')} rules={[RN('height', 'Height')]}>
                <InputNumber min={0} max={300} precision={1} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="category" hidden={H('category')} label={L('category', 'Patient category')} rules={[R('category', 'Category')]}>
                <AutoComplete allowClear options={['General', 'VIP', 'Staff', 'Senior citizen'].map((v) => ({ value: v }))} placeholder="Select or type" />
              </Form.Item>
              <Form.Item name="clinicalHistory" hidden={H('clinicalHistory')} label={L('clinicalHistory', 'Clinical history')} className="reg__span3" rules={[R('clinicalHistory', 'Clinical history')]}>
                <Input.TextArea rows={2} maxLength={1000} />
              </Form.Item>
              <Form.Item label={L('animal', 'Animal patient')} className="reg__span3" style={{ marginBottom: 0 }}>
                <span style={{ display: 'inline-flex', gap: 'var(--s-2)', alignItems: 'center' }}>
                  <Switch checked={animal || req('species') || req('breed') || req('owner')} disabled={req('species') || req('breed') || req('owner')} onChange={setAnimal} aria-label="Animal patient" />
                  <span>Veterinary sample</span>
                </span>
              </Form.Item>
              {(animal || req('species') || req('breed') || req('owner')) && (
                <>
                  <Form.Item name="species" hidden={H('species')} label={L('species', 'Species')} rules={[R('species', 'Species')]}><Input maxLength={60} /></Form.Item>
                  <Form.Item name="breed" hidden={H('breed')} label={L('breed', 'Breed')} rules={[R('breed', 'Breed')]}><Input maxLength={60} /></Form.Item>
                  <Form.Item name="ownerName" hidden={H('owner')} label={L('owner', 'Owner name')} rules={[R('owner', 'Owner name')]}><Input maxLength={80} /></Form.Item>
                </>
              )}
              {fd.customFields.map((c) => (
                <Form.Item key={c.key} name={['customFields', c.key]} label={c.label} rules={[{ required: !!c.required, message: `${c.label} is required` }]}>
                  {c.type === 'select' ? <Select allowClear options={(c.options ?? []).map((o) => ({ value: o, label: o }))} /> : c.type === 'number' ? <Input type="number" /> : c.type === 'date' ? <Input type="date" /> : <Input maxLength={200} />}
                </Form.Item>
              ))}
            </div>
          </Card>

          <Card padding={20}>
            <h2 className="reg__card-title">Collection and dispatch</h2>
            <div className="reg__grid">
              <Form.Item name="dispatchModes" hidden={H('dispatch')} label={L('dispatch', 'Report dispatch methods')} className="reg__span2">
                <Select mode="multiple" options={DISPATCH_OPTIONS} placeholder="Select" />
              </Form.Item>
              <Form.Item hidden={H('collectedAt')} label={`${L('collectedAt', 'Sample collected at')}${req('collectedAt') ? ' *' : ''}`}>
                <Radio.Group value={collectedAt} onChange={(e) => setCollectedAt(e.target.value)} options={[{ value: 'lab', label: 'Lab' }, { value: 'home', label: 'Home' }]} />
              </Form.Item>
              <Form.Item name="collectionDateTime" hidden={H('collectionDateTime')} label={L('collectionDateTime', 'Collection date and time')} rules={[RN('collectionDateTime', 'Collection date and time')]}>
                <DatePicker showTime format="DD MMM YYYY HH:mm" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
              </Form.Item>
              <Form.Item name="phlebotomistId" hidden={H('phlebotomist')} label={L('phlebotomist', 'Phlebotomist')} rules={[R('phlebotomist', 'Phlebotomist')]}>
                <Select allowClear showSearch optionFilterProp="label" placeholder="Select" options={phlebs.map((u) => ({ value: u.uid, label: u.name }))} />
              </Form.Item>
              <Form.Item name="proId" hidden={H('pro')} label={L('pro', 'PRO')} rules={[R('pro', 'PRO')]}>
                <Select allowClear showSearch optionFilterProp="label" placeholder="From the referring doctor" options={pros.map((x) => ({ value: x.id, label: x.name }))} onChange={() => { proTouched.current = true }} />
              </Form.Item>
              {(partners.corporateClientId || req('corporateUser') || req('corporatePlan')) && (
                <>
                  <Form.Item name="corporateUser" hidden={H('corporateUser') && !corpClient?.employeeIdRequired} label={L('corporateUser', 'Corporate user (employee)')} rules={[{ required: req('corporateUser') || !!corpClient?.employeeIdRequired, whitespace: true, message: corpClient?.employeeIdRequired ? 'Employee ID is required for this client' : 'Corporate user is required' }]}><Input maxLength={80} /></Form.Item>
                  <Form.Item name="corporatePlanId" hidden={H('corporatePlan')} label={L('corporatePlan', 'Corporate plan')} rules={[{ required: req('corporatePlan'), message: 'Corporate plan is required' }]}>
                    <Select allowClear showSearch optionFilterProp="label" placeholder="Select plan"
                      options={planOptions} />
                  </Form.Item>
                </>
              )}
              <Form.Item label="Priority">
                <span style={{ display: 'inline-flex', gap: 'var(--s-2)', alignItems: 'center' }}>
                  <Switch checked={priority === 'urgent'} onChange={(on) => setPriority(on ? 'urgent' : 'routine')} aria-label="Urgent" />
                  <span>{priority === 'urgent' ? 'Urgent' : 'Routine'}</span>
                </span>
              </Form.Item>
              <Form.Item name="notes" label="Notes on bill" className="reg__span2">
                <Input.TextArea rows={2} maxLength={500} />
              </Form.Item>
            </div>
          </Card>
        </div>
      </Form>

      <Modal
        open={dupOpen}
        title="Patient already registered with this number"
        onCancel={() => setDupOpen(false)}
        onOk={() => setDupOpen(false)}
        okText="OK"
        width={720}
        destroyOnHidden
      >
        <Table<Patient>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={duplicates}
          columns={[
            { title: 'Patient name', render: (_, p) => `${p.salutation} ${p.firstName} ${p.lastName}`.replace(/\s+/g, ' ').trim() },
            { title: 'Age', render: (_, p) => ageText(p.ageValue, p.ageUnit) },
            { title: 'Gender', render: (_, p) => GENDER_SHORT[p.gender] },
            { title: 'Registration date', render: (_, p) => (p.createdAt?.toDate ? dayjs(p.createdAt.toDate()).format('DD-MM-YYYY') : '') },
            { title: 'Email', dataIndex: 'email' },
            { title: 'Action', render: (_, p) => <Button variant="text" onClick={() => { pick(p); setDupOpen(false) }}>Select →</Button> },
          ]}
        />
        <p className="bill-muted" style={{ marginTop: 8 }}>OK keeps the form as a new patient on this number.</p>
      </Modal>
      <QuotationModal
        open={quote}
        onClose={() => setQuote(false)}
        prefill={{
          name: `${w?.firstName ?? ''} ${w?.lastName ?? ''}`.trim(),
          phone: w?.phone, email: w?.email, gender: w?.gender,
          ageValue: age?.ageValue, ageUnit: age?.ageUnit,
          patientId: existing?.id, patientNo: existing?.patientNo, partners,
        }}
      />

      <FrontDeskSettingsModal open={fdOpen} onClose={() => setFdOpen(false)} />

      {billing && (
        <BillingModal
          open
          patient={billing}
          context={{ ...partners, ...extraCtx, priority, sampleCollectedAt: collectedAt, uhid: billing.uhid }}
          initialNote={form.getFieldValue('notes')}
          initialItems={planLines.length ? planLines : undefined}
          lockedPriceLineIds={planLines.length ? planLines.map((l) => l.lineId) : undefined}
          onClose={() => setBilling(null)}
          onSaved={() => {
            setBilling(null)
            reset()
            message.success(`Bill saved ${dayjs().format('HH:mm')}`)
          }}
        />
      )}
    </div>
  )
}
