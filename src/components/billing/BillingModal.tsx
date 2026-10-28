import { useEffect, useMemo, useState } from 'react'
import { where, query } from 'firebase/firestore'
import { Alert, App, AutoComplete, Checkbox, DatePicker, Input, InputNumber, Modal, Radio, Select, Table } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { useLabSettings } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { allocateDiscount, allocatePercent, canBackdate, computeTotals, derivedPercent, discountableGross, dueAmount, isManagerOrAdmin } from '../../lib/billing'
import { col, paths } from '../../lib/db'
import { modeLabel, useMasters, useNeedsReference, usePaymentModes, type PartnerContext } from '../../lib/masters'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { createOrder, markCollectedOnCreate, type BillContext } from '../../lib/orders'
import type { Order, OrderItem, Paise, Patient, UserProfile } from '../../types'
import BillReceipt from './BillReceipt'
import { ageText, GENDER_SHORT } from './helpers'
import { OutsourceLabSelect } from '../../features/outsource/OutsourceLabSelect'
import { outsourceOptions, outsourceSnapshot, useOutsourceLookup } from '../../features/outsource/lib'
import { canB2B, checkFunds } from '../../features/partners/lib/b2b'
import { nablPrompts, showCommissionOnBills, showTatIn } from '../../features/settings/lib'
import { commissionForReferrer } from '../../features/partners/lib/commission'
import { consentText, needsConsent, needsIdProof, needsLmp, preCollectionGuidelines } from '../../pages/catalogue/flags'
import { ItemPicker, useLinePricer } from './lines'
import { PartnerFields } from './PartnerFields'
import { useCentreBalance } from './wallet'
import './billing.css'
import { dialogWidth } from '../../design/dialog'

interface Props {
  open: boolean
  patient: Patient
  onClose: () => void
  onSaved?: (orderId: string) => void
  // Optional (backward compatible): registration context, items from a quotation, prefilled note.
  context?: BillContext
  initialItems?: OrderItem[]
  initialNote?: string
  quotationId?: string
  bookingId?: string
  initialDiscount?: { reason?: string; by?: string }
  quotedNet?: Paise // quotation total, to flag a price change at conversion
  lockedPriceLineIds?: string[] // lines whose price is fixed (corporate plan price): rate lists do not re-price them
}

interface PayRow {
  key: string
  mode: string
  amount: number // rupees
  reference: string
}

// How the bill-level discount was last entered, so it can be re-applied when lines change.
type DiscSetting = { kind: 'pct'; value: number } | { kind: 'amt'; value: Paise } | null

const newRow = (mode: string, amount: number): PayRow => ({ key: crypto.randomUUID(), mode, amount, reference: '' })

// Bill percent: every line = price x %. Bill rupees: spread pro rata (largest line takes any remainder).
// Charge lines never take a discount.
function applyDiscount(items: OrderItem[], setting: DiscSetting): OrderItem[] {
  if (!setting) return items
  const shares = setting.kind === 'pct' ? allocatePercent(items, setting.value) : allocateDiscount(items, setting.value)
  return items.map((i, idx) => ({ ...i, discount: shares[idx] }))
}

// Test-level prompts (LMP, ID proof, consent) a line needs before it can be billed.
export interface LineNeeds { lmp: boolean; id: boolean; consent: boolean }

type SaveAction = 'accession' | 'print' | 'collect'

export default function BillingModal({ open, patient, onClose, onSaved, context, initialItems, initialNote, quotationId, bookingId, initialDiscount, quotedNet, lockedPriceLineIds }: Props) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const masters = useMasters()
  const payModes = usePaymentModes()
  const { data: users } = useLiveQuery<UserProfile>(col(paths.users), [])

  const [partners, setPartners] = useState<PartnerContext>({
    referrerId: context?.referrerId ?? patient.referrerId,
    hospitalId: context?.hospitalId ?? patient.hospitalId,
    b2bCentreId: context?.b2bCentreId,
    collectionCentreId: context?.collectionCentreId,
    corporateClientId: context?.corporateClientId,
    govPanelId: context?.govPanelId,
    tpaId: context?.tpaId,
    secondReferrerId: context?.secondReferrerId,
    rateListId: context?.rateListId,
  })
  const priority = context?.priority ?? 'routine'
  useOutsourceLookup() // re-render when the outsource mapping changes
  const [outsourceChoice, setOutsourceChoice] = useState<Record<string, string>>({}) // testId -> processing lab picked for this bill
  const [urgentRemark, setUrgentRemark] = useState('')
  const pricer = useLinePricer(partners)

  const [items, setItems] = useState<OrderItem[]>(() => initialItems ?? [])
  const [manualPrice, setManualPrice] = useState<Set<string>>(() => new Set(lockedPriceLineIds ?? []))
  const [setting, setSetting] = useState<DiscSetting>(null)
  const [zeroBill, setZeroBill] = useState(false)
  const [discountedBy, setDiscountedBy] = useState(initialDiscount?.by ?? (settings.registration.defaultDiscountedBy === 'staff' ? profile?.name ?? '' : ''))
  const [reason, setReason] = useState(initialDiscount?.reason ?? '')
  const [note, setNote] = useState(initialNote ?? '')
  const [billDate, setBillDate] = useState<Dayjs>(dayjs())
  const [billTo, setBillTo] = useState<'patient' | 'b2b'>(context?.b2bCentreId ? 'b2b' : 'patient')
  const [payerAmt, setPayerAmt] = useState(0) // rupees paid by TPA / government panel
  const [rows, setRows] = useState<PayRow[]>([newRow('cash', 0)])
  const [saving, setSaving] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [approverId, setApproverId] = useState<string>('')

  const backdateOk = canBackdate(profile)
  const needsRef = useNeedsReference()
  const centre = masters.b2bCentres.find((c) => c.id === partners.b2bCentreId)
  const balance = useCentreBalance(centre)
  const b2b = billTo === 'b2b' && !!centre
  // Per-centre flags: MRP editing and the price column can be switched off for a B2B centre's bills.
  const canEditPrice = can(profile, 'billing.editPrice') && (!b2b || canB2B(centre, 'editMrp'))
  const showPriceCol = !b2b || canB2B(centre, 'showPriceColumn')
  const panel = masters.govPanels.find((g) => g.id === partners.govPanelId)
  const tpa = masters.tpas.find((t) => t.id === partners.tpaId)
  const payerName = panel?.name ?? tpa?.name
  const payerPaise = payerName ? Math.max(0, toPaise(payerAmt)) : 0

  const totals = useMemo(() => computeTotals(items), [items])
  const payable = Math.max(0, totals.net - payerPaise)
  // Without the Collect payments permission the bill is saved fully due (a cashier collects later).
  const canCollect = can(profile, 'payment.collect')
  const paidPaise = b2b ? payable : canCollect ? rows.reduce((s, r) => s + toPaise(r.amount || 0), 0) : 0
  const due = dueAmount(payable, paidPaise)
  const overpaid = !b2b && paidPaise > payable
  const discPct = derivedPercent(items)
  const discGross = discountableGross(items)

  // Billing to a B2B centre defaults on when one is chosen.
  useEffect(() => {
    setBillTo(partners.b2bCentreId ? 'b2b' : 'patient')
  }, [partners.b2bCentreId])

  // Rate lists of the chosen partners re-price catalogue lines (manual overrides stay).
  useEffect(() => {
    setItems((prev) => applyDiscount(pricer.reprice(prev, manualPrice), setting))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricer.reprice])

  // Payment re-defaults to the full payable amount whenever it changes (unless "default due bill").
  useEffect(() => {
    if (settings.registration.defaultDueBill) return
    setRows((prev) => {
      const others = prev.slice(1).reduce((s, r) => s + (r.amount || 0), 0)
      return [{ ...prev[0], amount: Math.max(0, toRupees(payable) - others) }, ...prev.slice(1)]
    })
  }, [payable, settings.registration.defaultDueBill])

  const updateItems = (next: OrderItem[], keepSetting = true) => setItems(applyDiscount(next, keepSetting ? setting : null))

  const addLine = (line: OrderItem) => {
    // A test that is already on the bill (directly or as a member of a package) cannot be added again.
    if (!line.isCharge && line.testIds.some((t) => items.some((i) => !i.isCharge && i.testIds.includes(t)))) {
      message.warning('Test already added')
      return
    }
    if (priority === 'urgent' && !line.isCharge) line = { ...line, urgent: true }
    if (!line.isCharge && line.testIds.some((t) => (pricer.cat.testById.get(t) as { pcpndt?: boolean } | undefined)?.pcpndt)) line = { ...line, pcpndt: true }
    updateItems([...items, line])
  }

  // The patient's other live bills on the same day (for the repeat-test guard).
  const { data: patientOrders } = useLiveQuery<Order>(open ? query(col(paths.orders), where('patientId', '==', patient.id)) : null, [open, patient.id])
  const sameDayTests = useMemo(() => {
    const day = billDate
    const ids = new Set<string>()
    for (const o of patientOrders) {
      if (o.deleted) continue
      const when = dayjs((o.billDate ?? o.createdAt)?.toDate?.() ?? new Date())
      if (!when.isSame(day, 'day')) continue
      o.items.filter((i) => i.status !== 'refunded').forEach((i) => i.testIds.forEach((t) => ids.add(t)))
    }
    return ids
  }, [patientOrders, billDate])

  // Per-test prompts a line needs (LMP, ID proof, consent), from the catalogue flags of its tests.
  const needsOf = (line: OrderItem): LineNeeds => {
    const out: LineNeeds = { lmp: false, id: false, consent: false }
    if (line.isCharge) return out
    for (const tid of line.testIds) {
      const t = pricer.cat.testById.get(tid)
      if (needsLmp(t)) out.lmp = true
      if (needsIdProof(t)) out.id = true
      if (needsConsent(t)) out.consent = true
    }
    return out
  }
  const promptMissing = items.find((l) => {
    const n = needsOf(l)
    return (n.lmp && !l.lmp) || (n.id && !l.idRef?.trim()) || (n.consent && !l.consent)
  })

  // Warnings: gender-restricted tests, and tests billed twice (directly or through a package).
  // Charge lines have no tests, so they never show up here.
  const warnings = useMemo(() => {
    const out: string[] = []
    const repeatToday: string[] = []
    const seen = new Map<string, number>()
    for (const line of items) {
      if (line.isCharge) continue
      for (const tid of line.testIds) {
        seen.set(tid, (seen.get(tid) ?? 0) + 1)
        const t = pricer.cat.testById.get(tid)
        if (t && t.gender !== 'both' && t.gender !== patient.gender && patient.gender !== 'other') {
          out.push(`${t.name} is meant for ${t.gender} patients only.`)
        }
        if (sameDayTests.has(tid)) repeatToday.push(t?.name ?? tid)
      }
    }
    for (const [tid, n] of seen) {
      if (n > 1) out.push(`${pricer.cat.testById.get(tid)?.name ?? tid} appears ${n} times on this bill (duplicate test).`)
    }
    for (const n of new Set(repeatToday)) {
      out.push(`${n} was already billed for this patient today.`)
    }
    return Array.from(new Set(out))
  }, [items, pricer.cat.testById, patient.gender, sameDayTests])
  const repeatBlocked = !!settings.registration.duplicateTestGuard && items.some((l) => !l.isCharge && l.testIds.some((t) => sameDayTests.has(t)))

  // Discount caps: a percent cap and a rupee cap per bill. Managers and admins are exempt; anyone else
  // above a cap needs a manager or admin to approve (named on the bill as discountApprovedBy).
  const isAdmin = isManagerOrAdmin(profile)
  const maxDisc = can(profile, 'billing.discount') ? (profile?.maxDiscountPct ?? 0) : 0
  const maxDiscAmt = can(profile, 'billing.discount') ? (profile?.maxDiscountAmount || settings.frontDesk?.maxDiscountAmount || 0) : 0
  const overPct = discPct > maxDisc + 1e-9
  const overAmt = maxDiscAmt > 0 && totals.discount > maxDiscAmt
  const overLimit = !isAdmin && !!profile && (overPct || overAmt)
  const approvers = users.filter((u) => u.active && !u.deleted && ['labAdmin', 'admin', 'manager'].includes(u.role) && u.uid !== profile?.uid)
  const approver = overLimit ? approvers.find((u) => u.uid === approverId) : undefined
  const needsApprover = overLimit && !approver
  const reasonMissing = settings.discountReasonRequired && totals.discount > 0 && !reason.trim()

  // Settings > Referrals > show commission on bills: a staff-only estimate (never printed on the patient copy).
  const commissionNote = useMemo(() => {
    if (!showCommissionOnBills(settings) || !can(profile, 'referrals.view')) return null
    const ids = [partners.referrerId, partners.hospitalId, partners.secondReferrerId].filter((x): x is string => !!x)
    const bearerSrc = partners.referrerId ? masters.referrerById.get(partners.referrerId) : undefined
    const order = { gross: totals.gross, net: totals.net, paid: paidPaise, discount: totals.discount, items, referrerId: partners.referrerId, hospitalId: partners.hospitalId, secondReferrerId: partners.secondReferrerId, discountBearer: bearerSrc?.discountBearer, discountSplitReferrerPct: bearerSrc?.discountSplitReferrerPct }
    const parts = ids.flatMap((id) => {
      const r = masters.referrerById.get(id)
      return r ? [{ name: r.name, amount: commissionForReferrer(order, r, settings.referrals.commissionBasis) }] : []
    })
    return parts.length ? parts : null
  }, [settings, profile, partners.referrerId, partners.hospitalId, partners.secondReferrerId, masters.referrerById, totals, paidPaise, items])

  const funds = b2b && !!balance && centre ? checkFunds(centre, balance, payable, settings.b2bLab.creditLimitBehaviour, 'main') : null
  const creditBlocked = funds?.level === 'insufficient'
  const creditBlocks = !!funds?.blocks
  const lowFunds = funds?.level === 'low'

  // Outsourced tests on the bill (each can go to a different processing lab) and the urgent remark prompt.
  const outsourcedTests = items.flatMap((l) => (l.isCharge ? [] : l.testIds)).filter((t) => outsourceOptions(t).length > 0)
  const anyUrgent = priority === 'urgent' || items.some((l) => l.urgent && !l.isCharge)
  const remarkNeeded = nablPrompts(settings).urgentRemark && anyUrgent
  const unlisted = items.find((l) => !l.isCharge && pricer.isUnlisted(l.refId))

  const reapply = (s: DiscSetting) => {
    setSetting(s)
    setItems(applyDiscount(items.map((i) => ({ ...i, discount: 0 })), s))
  }
  const setDiscountPct = (v: number | null) => {
    const value = Math.max(0, Math.min(100, v ?? 0))
    setZeroBill(false)
    reapply(value > 0 ? { kind: 'pct', value } : null)
  }
  const setDiscountAmt = (v: number | null) => {
    const value = Math.max(0, toPaise(v ?? 0))
    setZeroBill(false)
    reapply(value > 0 ? { kind: 'amt', value } : null)
  }
  const toggleZero = (on: boolean) => {
    setZeroBill(on)
    reapply(on ? { kind: 'pct', value: 100 } : null)
  }

  // A single-line edit changes only that line: the other lines' discounts are never re-spread
  // and the bill-level fields simply re-sum. A line discount above the line price is refused.
  const setLine = (lineId: string, patch: Partial<OrderItem>, manualDiscount = false) => {
    const cur = items.find((i) => i.lineId === lineId)
    if (!cur) return
    const merged = { ...cur, ...patch }
    if (merged.discount > merged.price) {
      if (manualDiscount) message.warning('Discount cannot exceed the actual price')
      merged.discount = manualDiscount ? 0 : merged.price
    }
    if (manualDiscount || 'price' in patch) {
      setSetting(null)
      setZeroBill(false)
    }
    setItems(items.map((i) => (i.lineId === lineId ? merged : i)))
  }

  const blocker = (): string | null => {
    if (items.length === 0) return 'Add at least one test, package or charge.'
    if (needsApprover) return overAmt ? `Your discount limit is ${formatINR(maxDiscAmt)} per bill. Pick a manager to approve a higher discount.` : `Your discount limit is ${maxDisc}%. Pick a manager to approve a higher discount.`
    if (reasonMissing) return 'Enter a reason for the discount.'
    if (overpaid) return `Collecting more than the bill total. Reduce it by ${formatINR(paidPaise - payable)}.`
    if (promptMissing) return `${promptMissing.name}: fill in the LMP date, ID proof or consent this test needs.`
    if (repeatBlocked) return 'A test on this bill was already billed to this patient today.'
    if (!b2b && canCollect && rows.some((r) => r.amount > 0 && needsRef(r.mode) && !r.reference.trim())) return 'Enter the transaction ID for non-cash payments.'
    if (payerPaise > totals.net) return 'The payer share is more than the net amount.'
    if (unlisted) return `${unlisted.name} is not in the partner's price list (strict partner pricing is on). Remove it or change the partner.`
    if (remarkNeeded && !urgentRemark.trim()) return 'Enter a remark for the urgent test (NABL).'
    if (creditBlocks) return funds?.message ?? 'This B2B centre has no balance or credit left for this bill.'
    if (settings.registration.requiredFields.includes('payment') && !b2b && canCollect && paidPaise <= 0 && !zeroBill && payable > 0) return 'Payment is required: record a payment before saving.'
    if (totals.net === 0 && !zeroBill && totals.gross > 0) return 'Net amount is zero: tick "Zero amount bill" to confirm.'
    return null
  }

  const save = async (then: SaveAction) => {
    const err = blocker()
    if (err) return message.warning(err)
    if (!profile) return
    setSaving(true)
    try {
      const payments = b2b
        ? payable > 0 ? [{ mode: 'wallet', amount: payable, reference: centre?.name ?? '' }] : []
        : canCollect
          ? rows.map((r) => ({ mode: r.mode, amount: toPaise(r.amount || 0), reference: r.reference.trim() })).filter((p) => p.amount > 0)
          : []
      const ref = partners.referrerId ? masters.doctors.find((d) => d.id === partners.referrerId) : undefined
      const sec = partners.secondReferrerId ? [...masters.secondReferrals, ...masters.doctors].find((d) => d.id === partners.secondReferrerId) : undefined
      const id = await createOrder({
        patient,
        items: items.map((l) => {
          const stamp = l.isCharge || l.onlyBilling ? [] : outsourceSnapshot(l.testIds, outsourceChoice)
          const { outsource: _old, ...rest } = l
          void _old
          return stamp.length ? { ...rest, outsource: stamp } : rest
        }),
        discountBearer: ref?.discountBearer,
        discountSplitReferrerPct: ref?.discountSplitReferrerPct,
        urgentRemark: remarkNeeded ? urgentRemark.trim() : undefined,
        discountReason: reason.trim(),
        discountedBy,
        discountApprovedBy: approver?.uid,
        discountApprovedByName: approver?.name,
        note: note.trim(),
        payments,
        settings,
        user: profile,
        billDate: billDate.toDate(),
        billedTo: b2b ? 'b2b' : 'patient',
        quotationId,
        bookingId,
        payer: payerName && payerPaise > 0 ? { kind: panel ? 'govPanel' : 'tpa', id: (panel ?? tpa)!.id, name: payerName, amount: payerPaise } : undefined,
        context: {
          ...partners,
          referrerName: ref?.name,
          secondReferrerName: sec?.name,
          rateListIds: pricer.rateListIds,
          b2bCentreName: centre?.name,
          hospitalName: masters.hospitals.find((h) => h.id === partners.hospitalId)?.name,
          collectionCentreName: masters.collectionCentres.find((c) => c.id === partners.collectionCentreId)?.name,
          corporateClientName: masters.corporateClients.find((c) => c.id === partners.corporateClientId)?.name,
          govPanelName: panel?.name,
          tpaName: tpa?.name,
          priority,
          sampleCollectedAt: context?.sampleCollectedAt,
          uhid: context?.uhid ?? patient.uhid,
          phlebotomistId: context?.phlebotomistId,
          phlebotomistName: context?.phlebotomistName,
          collectionDateTime: context?.collectionDateTime,
          proId: context?.proId,
          proName: context?.proName,
          corporateUser: context?.corporateUser,
          corporatePlan: context?.corporatePlan,
          clinicalHistory: context?.clinicalHistory,
          weight: context?.weight,
          height: context?.height,
          category: context?.category,
        },
      })
      if (then === 'collect') await markCollectedOnCreate(id, items)
      if (then === 'accession') {
        onSaved?.(id)
        // The accession page opens its Sample Collection dialog for this bill (it must read ?collect=).
        navigate(`/accession?collect=${id}`)
      } else setReceiptId(id)
    } catch (e) {
      message.error(`Could not save bill: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const blockMsg = blocker()
  const showTat = showTatIn(settings, 'billing')
  const name = `${patient.salutation} ${patient.firstName} ${patient.lastName}`.replace(/\s+/g, ' ').trim()

  return (
    <>
      <Modal
        open={open && !receiptId}
        title={
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 'var(--s-2)', alignItems: 'center' }}>
            <span>Billing</span>
            <StatusChip variant="info">{patient.patientNo}</StatusChip>
            <span>{name}</span>
            <span className="bill-muted" style={{ fontWeight: 400 }}>
              {ageText(patient.ageValue, patient.ageUnit)} / {GENDER_SHORT[patient.gender]}
              {patient.phone ? ` · ${patient.phone}` : ''}
            </span>
            {priority === 'urgent' && <StatusChip variant="urgent">Urgent</StatusChip>}
          </span>
        }
        width={dialogWidth(1120)}
        onCancel={onClose}
        maskClosable={false}
        destroyOnHidden
        footer={
          <div className="bill-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button disabled={saving || items.length === 0 || overpaid} onClick={() => save('collect')}>
              Save &amp; Collect
            </Button>
            <Button disabled={saving || items.length === 0 || overpaid} onClick={() => save('print')}>
              Save &amp; Print Bill
            </Button>
            <Button variant="primary" disabled={saving || items.length === 0 || overpaid} onClick={() => save('accession')}>
              Save &amp; Accession
            </Button>
          </div>
        }
      >
        <div className="bill-section" style={{ marginBottom: 'var(--s-3)' }}>
          <h3 className="bill-section__title">Partner and payer</h3>
          <PartnerFields value={partners} onChange={setPartners} withRateList />
          {commissionNote && (
            <p className="bill-muted" style={{ margin: '4px 0 0' }}>
              Commission (staff only): {commissionNote.map((c) => `${c.name} ${formatINR(c.amount)}`).join(' · ')}
            </p>
          )}
          <div className="bill-row">
            <label htmlFor="bill-date" className="bill-muted">Billing date and time</label>
            <DatePicker
              id="bill-date"
              showTime
              allowClear={false}
              format="DD MMM YYYY HH:mm"
              value={billDate}
              onChange={(d) => d && setBillDate(d)}
              disabledDate={(d) => d.isAfter(dayjs(), 'day') || (!backdateOk && d.isBefore(dayjs(), 'day'))}
            />
            {!backdateOk && <span className="bill-muted">Back-dating needs the back-date permission.</span>}
          </div>
        </div>

        <ItemPicker ctx={partners} gender={patient.gender} species={patient.species} onPick={addLine} hidePrice={b2b && !canB2B(centre, 'showB2BRate')} />

        {quotedNet !== undefined && totals.net !== quotedNet && items.length > 0 && (
          <Alert type="info" showIcon style={{ marginBottom: 6 }} message={`Prices changed since the quotation: quoted ${formatINR(quotedNet)}, now ${formatINR(totals.net)}.`} />
        )}
        {preCollectionGuidelines(items.flatMap((l) => l.testIds.map((t) => pricer.cat.testById.get(t)))).map((g) => (
          <Alert key={g.text} type="info" showIcon style={{ marginBottom: 6 }} message={`${g.name}: ${g.text}`} />
        ))}
        {warnings.map((w) => (
          <Alert key={w} type="warning" showIcon message={w} style={{ marginBottom: 6 }} />
        ))}

        <Table<OrderItem>
          size="small"
          rowKey="lineId"
          pagination={false}
          dataSource={items}
          locale={{ emptyText: 'No tests added yet' }}
          scroll={{ y: 240 }}
          columns={[
            { title: '#', width: 40, render: (_, __, i) => i + 1 },
            {
              title: 'Test / Package',
              render: (_, r) => (
                <>
                  {r.name} <span className="bill-muted">{r.code}</span>{' '}
                  {r.kind === 'package' && <StatusChip variant="info">Package · {r.testIds.length} tests</StatusChip>}
                  {r.isCharge && <StatusChip>Other charge</StatusChip>}
                  {!r.isCharge && !r.onlyBilling && r.testIds.some((t) => outsourceOptions(t).length > 0) && <StatusChip variant="info">Outsourced</StatusChip>}
                  {!r.isCharge && (() => {
                    const fb = pricer.fallbackOf(r.refId)
                    return fb ? <StatusChip variant="caution">{fb.fromParent ? `From parent of ${fb.listName}` : `Not in ${fb.listName}: MRP`}</StatusChip> : null
                  })()}
                </>
              ),
            },
            ...(showTat
              ? [{
                  title: 'TAT',
                  width: 80,
                  render: (_: unknown, r: OrderItem) => {
                    const t = r.testIds[0] ? pricer.cat.testById.get(r.testIds[0]) : undefined
                    const mins = r.urgent ? t?.urgentTatMinutes ?? t?.tatMinutes : t?.tatMinutes
                    return mins ? `${Math.round(mins / 60)}h` : '-'
                  },
                }]
              : []),
            {
              title: 'Qty',
              width: 80,
              render: (_: unknown, r: OrderItem) =>
                r.isCharge || r.kind === 'package' || r.onlyBilling ? null : (
                  <InputNumber
                    aria-label={`Quantity of ${r.name}`}
                    min={1}
                    max={20}
                    precision={0}
                    value={r.qty ?? 1}
                    onChange={(v) => {
                      const q = Math.max(1, Math.round(v ?? 1))
                      const unit = Math.round(r.price / (r.qty ?? 1))
                      setLine(r.lineId, { qty: q, price: unit * q })
                    }}
                    style={{ width: '100%' }}
                  />
                ),
            },
            ...(showPriceCol ? [{
              title: 'Price (₹)',
              width: 120,
              render: (_: unknown, r: OrderItem) =>
                canEditPrice && r.kind === 'test' && !r.isCharge ? (
                  <InputNumber
                    aria-label={`Price of ${r.name}`}
                    min={0}
                    precision={2}
                    value={toRupees(r.price)}
                    onChange={(v) => {
                      setManualPrice(new Set(manualPrice).add(r.lineId))
                      setLine(r.lineId, { price: toPaise(v ?? 0) })
                    }}
                    style={{ width: '100%' }}
                  />
                ) : (
                  <span className="tabular">{formatINR(r.price)}</span>
                ),
            }] : []),
            {
              title: 'Discount (₹)',
              width: 120,
              render: (_, r) => (
                <InputNumber
                  aria-label={`Discount on ${r.name}`}
                  min={0}
                  precision={2}
                  value={toRupees(r.discount)}
                  disabled={r.isCharge}
                  onChange={(v) => setLine(r.lineId, { discount: toPaise(v ?? 0) }, true)}
                  style={{ width: '100%' }}
                />
              ),
            },
            {
              title: (
                <Checkbox
                  checked={items.some((i) => !i.isCharge) && items.filter((i) => !i.isCharge).every((i) => i.urgent)}
                  onChange={(e) => setItems(items.map((i) => (i.isCharge ? i : { ...i, urgent: e.target.checked })))}
                >
                  Urgent
                </Checkbox>
              ),
              width: 100,
              render: (_, r) =>
                r.isCharge ? null : (
                  <Checkbox aria-label={`Urgent ${r.name}`} checked={r.urgent} onChange={(e) => setLine(r.lineId, { urgent: e.target.checked })} />
                ),
            },
            {
              title: '',
              width: 50,
              render: (_, r) => (
                <Button
                  variant="text"
                  aria-label={`Remove ${r.name}`}
                  icon={<DeleteOutlined />}
                  onClick={() => updateItems(items.filter((i) => i.lineId !== r.lineId))}
                />
              ),
            },
          ]}
        />

        {outsourcedTests.length > 0 && (
          <div className="bill-section" style={{ marginTop: 'var(--s-3)' }}>
            <h3 className="bill-section__title">Outsourced tests: processing lab</h3>
            {[...new Set(outsourcedTests)].map((tid) => (
              <div key={tid} className="bill-row">
                <b className="bill-row__name">{pricer.cat.testById.get(tid)?.name ?? tid}</b>
                <OutsourceLabSelect testId={tid} value={outsourceChoice[tid]} onChange={(labId) => setOutsourceChoice({ ...outsourceChoice, [tid]: labId })} />
              </div>
            ))}
          </div>
        )}

        {remarkNeeded && (
          <div className="bill-section" style={{ marginTop: 'var(--s-3)' }}>
            <h3 className="bill-section__title">Urgent remark</h3>
            <Input aria-label="Urgent remark" placeholder="Why is this urgent? (required)" status={urgentRemark.trim() ? undefined : 'error'} value={urgentRemark} onChange={(e) => setUrgentRemark(e.target.value)} maxLength={200} />
          </div>
        )}

        {items.some((l) => {
          const n = needsOf(l)
          return n.lmp || n.id || n.consent
        }) && (
          <div className="bill-section" style={{ marginTop: 'var(--s-3)' }}>
            <h3 className="bill-section__title">Test requirements</h3>
            {items.map((l) => {
              const n = needsOf(l)
              if (!n.lmp && !n.id && !n.consent) return null
              return (
                <div key={l.lineId} className="bill-row">
                  <b className="bill-row__name">{l.name}</b>
                  {n.lmp && (
                    <DatePicker
                      aria-label={`LMP for ${l.name}`}
                      placeholder="LMP date"
                      value={l.lmp ? dayjs(l.lmp) : null}
                      disabledDate={(d) => d.isAfter(dayjs())}
                      status={l.lmp ? undefined : 'error'}
                      onChange={(d) => setLine(l.lineId, { lmp: d ? d.format('YYYY-MM-DD') : undefined })}
                    />
                  )}
                  {n.id && (
                    <Input
                      aria-label={`ID proof for ${l.name}`}
                      placeholder="ID proof number"
                      style={{ width: 220 }}
                      status={l.idRef?.trim() ? undefined : 'error'}
                      value={l.idRef ?? ''}
                      onChange={(e) => setLine(l.lineId, { idRef: e.target.value })}
                    />
                  )}
                  {n.consent && (
                    <Checkbox checked={!!l.consent} onChange={(e) => setLine(l.lineId, { consent: e.target.checked })}>
                      {consentText(pricer.cat.testById.get(l.testIds[0])) || 'Patient consent obtained'}
                    </Checkbox>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="bill-grid2" style={{ marginTop: 'var(--s-4)' }}>
          <div className="bill-section">
            <h3 className="bill-section__title">Discount</h3>
            <div className="bill-fgrid">
              <div>
                <label className="bill-field-label" htmlFor="disc-pct">Discount percent</label>
                <InputNumber
                  id="disc-pct"
                  aria-label="Discount percent"
                  addonAfter="%"
                  min={0}
                  max={100}
                  precision={2}
                  value={setting?.kind === 'pct' ? setting.value : Number(discPct.toFixed(2))}
                  onChange={setDiscountPct}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label className="bill-field-label" htmlFor="disc-amt">Discount amount</label>
                <InputNumber
                  id="disc-amt"
                  aria-label="Discount amount"
                  addonBefore="₹"
                  min={0}
                  max={toRupees(discGross)}
                  precision={2}
                  value={toRupees(totals.discount)}
                  onChange={setDiscountAmt}
                  style={{ width: '100%' }}
                />
              </div>
              <Checkbox className="bill-fgrid__full" checked={zeroBill} onChange={(e) => toggleZero(e.target.checked)}>
                Zero amount bill
              </Checkbox>
            </div>
            {overLimit && (
              <Alert
                style={{ marginTop: 8 }}
                type={approver ? 'warning' : 'error'}
                showIcon
                message={overAmt ? `Discount above the ${formatINR(maxDiscAmt)} per-bill cap needs a manager.` : `Discount above your ${maxDisc}% limit needs a manager.`}
                description={
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    aria-label="Approved by (manager)"
                    placeholder="Approved by (manager or admin)"
                    style={{ width: '100%', minWidth: 220 }}
                    value={approverId || undefined}
                    onChange={(v) => setApproverId(v ?? '')}
                    options={approvers.map((u) => ({ value: u.uid, label: u.name }))}
                  />
                }
              />
            )}
            <div className="bill-fgrid" style={{ marginTop: 'var(--s-3)' }}>
              <div>
              <label className="bill-field-label" htmlFor="disc-by">Discounted by</label>
              <Select
                id="disc-by"
                allowClear
                showSearch
                aria-label="Discounted by"
                placeholder="Discounted by"
                style={{ width: '100%' }}
                value={discountedBy || undefined}
                onChange={(v) => setDiscountedBy(v ?? '')}
                options={[
                  ...['By All', 'By Lab', 'By Percentage'].map((v) => ({ value: v, label: v })),
                  ...users.filter((u) => u.active).map((u) => ({ value: u.name, label: u.name })),
                ]}
              />
              </div>
              <div>
              <label className="bill-field-label" htmlFor="disc-reason">Reason</label>
              <AutoComplete
                id="disc-reason"
                aria-label="Discount reason"
                style={{ width: '100%' }}
                value={reason}
                onChange={setReason}
                options={masters.reasons.map((r) => ({ value: r }))}
                placeholder={settings.discountReasonRequired && totals.discount > 0 ? 'Reason (required)' : 'Reason'}
                status={reasonMissing ? 'error' : undefined}
              />
              </div>
            </div>
            <label className="bill-field-label" htmlFor="bill-note" style={{ marginTop: 'var(--s-3)' }}>Note on bill</label>
            <Input.TextArea
              id="bill-note"
              rows={2}
              aria-label="Note on bill"
              placeholder="Note on bill"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="bill-section">
            <div className="bill-sum">
              <span>Sub total</span>
              <b style={{ textAlign: 'right' }}>{formatINR(totals.gross)}</b>
              <span>Discount</span>
              <b style={{ textAlign: 'right' }}>- {formatINR(totals.discount)}</b>
              <span className="bill-sum__net">Net amount</span>
              <b className="bill-sum__net" style={{ textAlign: 'right' }}>{formatINR(totals.net)}</b>
              {payerName && (
                <>
                  <span>Paid by {payerName}</span>
                  <b style={{ textAlign: 'right' }}>- {formatINR(payerPaise)}</b>
                </>
              )}
            </div>

            {payerName && (
              <div className="bill-row">
                <label className="bill-muted" htmlFor="payer-amt">{panel ? 'Government panel' : 'TPA'} share</label>
                <InputNumber id="payer-amt" addonBefore="₹" min={0} precision={2} value={payerAmt} onChange={(v) => setPayerAmt(v ?? 0)} style={{ width: 170 }} />
              </div>
            )}

            {centre && (
              <div className="bill-row">
                <Radio.Group
                  value={billTo}
                  onChange={(e) => setBillTo(e.target.value)}
                  options={[{ value: 'b2b', label: `Bill to ${centre.name} wallet` }, { value: 'patient', label: 'Patient pays' }]}
                />
              </div>
            )}

            {b2b ? (
              <div style={{ marginTop: 'var(--s-3)' }}>
                {balance && (
                  <p className="bill-muted" style={{ margin: 0 }}>
                    Wallet {formatINR(balance.wallet)} · credit limit {formatINR(centre?.creditLimit ?? 0)} · after this bill{' '}
                    <b className={creditBlocked ? 'bill-due' : undefined}>{formatINR(balance.net - payable)}</b> spendable
                  </p>
                )}
                {(creditBlocked || lowFunds) && (
                  <Alert
                    style={{ marginTop: 8 }}
                    type={creditBlocks ? 'error' : 'warning'}
                    showIcon
                    message={creditBlocks ? 'Credit limit reached: this bill cannot be saved.' : funds?.message}
                  />
                )}
              </div>
            ) : !canCollect ? (
              <Alert style={{ marginTop: 'var(--s-3)' }} type="info" showIcon message="You do not have permission to collect payments. The bill will be saved with the full amount due." />
            ) : (
              <>
                <h3 className="bill-section__title bill-section__title--split">Payment</h3>
                {rows.map((r, idx) => (
                  <div key={r.key} className="bill-payrow">
                    <Select
                      aria-label="Payment mode"
                      value={r.mode}
                      style={{ width: '100%' }}
                      onChange={(mode) => setRows(rows.map((x) => (x.key === r.key ? { ...x, mode } : x)))}
                      options={payModes}
                    />
                    <InputNumber
                      aria-label="Payment amount"
                      min={0}
                      precision={2}
                      value={r.amount}
                      addonBefore="₹"
                      style={{ width: '100%' }}
                      onChange={(v) => setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: v ?? 0 } : x)))}
                    />
                    <Input
                      aria-label="Transaction ID"
                      status={needsRef(r.mode) && r.amount > 0 && !r.reference.trim() ? 'error' : undefined}
                      placeholder={needsRef(r.mode) ? 'Transaction ID (required)' : 'Transaction ID'}
                      style={{ width: '100%' }}
                      value={r.reference}
                      onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, reference: e.target.value } : x)))}
                    />
                    {idx > 0 && (
                      <Button variant="text" aria-label="Remove payment row" icon={<DeleteOutlined />} onClick={() => setRows(rows.filter((x) => x.key !== r.key))} />
                    )}
                  </div>
                ))}
                <div className="bill-row">
                  <Button icon={<PlusOutlined />} onClick={() => setRows([...rows, newRow(payModes[1]?.value ?? payModes[0].value, 0)])}>
                    Split payment
                  </Button>
                </div>
                <div className="bill-row bill-row--tight">
                  <Checkbox checked={due > 0} disabled aria-label="Due payment">Due payment</Checkbox>
                  <span className="bill-muted">Ticks itself when less than the total is collected.</span>
                </div>
                <p style={{ margin: 'var(--s-2) 0 0' }}>
                  Collecting {formatINR(paidPaise)} ·{' '}
                  <span className={due > 0 ? 'bill-due' : undefined}>{formatINR(due)} will remain due</span>
                </p>
                {rows.length > 1 && (
                  <p className="bill-muted" style={{ margin: 0 }}>
                    {rows.map((r) => `${modeLabel(r.mode)} ${formatINR(toPaise(r.amount || 0))}`).join(' + ')}
                  </p>
                )}
                {overpaid && <Alert style={{ marginTop: 6 }} type="error" showIcon message={`Collecting more than the bill total. Reduce it by ${formatINR(paidPaise - payable)}.`} />}
              </>
            )}
          </div>
        </div>
        {blockMsg && items.length > 0 && (
          <p role="alert" className="bill-due" style={{ marginTop: 'var(--s-2)' }}>
            {blockMsg}
          </p>
        )}
      </Modal>

      <BillReceipt
        open={!!receiptId}
        orderId={receiptId}
        onClose={() => {
          const id = receiptId
          setReceiptId(null)
          if (id) onSaved?.(id)
        }}
      />
    </>
  )
}
