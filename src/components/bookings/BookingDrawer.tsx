import { useEffect, useMemo, useState } from 'react'
import { FieldGrid, FormSection } from '../../design/FormLayout'
import '../billing/billing.css'
import { Alert, App, Button, Checkbox, DatePicker, Descriptions, Divider, Drawer, Input, Modal, Select, Space, Tag, Timeline, Typography } from 'antd'
import { StatusChip } from '../../design/StatusChip'
import dayjs, { type Dayjs } from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { query, Timestamp } from 'firebase/firestore'
import { useBranchScope } from '../../lib/branchScope'
import { can, useAuth } from '../../auth/AuthProvider'
import { useBranch } from '../../branch/BranchProvider'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import {
  bookingName,
  bookingTotal,
  canMove,
  billingBlockedReason,
  confirmReschedule,
  convertToBill,
  rescheduleBooking,
  suggestCollectors,
  reminderDue,
  type Collector,
  isClosed,
  mapBookingItems,
  reopenBooking,
  SLOTS,
  duplicateBooking,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  STAGE_LABEL,
  STATUS_LABEL,
  STATUS_VARIANT,
  type BookingX,
  type PhleboStage,
  transitionBooking,
  updateBooking,
} from '../../lib/bookings'
import { col, docRef, paths } from '../../lib/db'
import { formatINR } from '../../lib/money'
import { QuotationAttachments } from '../../features/quotations/attachments'
import PayOnlineButton from '../billing/PayOnlineButton'
import { fillTemplate, sendBookingMessage, whatsappLink } from '../../lib/messaging'
import type { Booking, BookingItem, UserProfile } from '../../types'
import {
  draftFromBooking,
  draftToBooking,
  emptyDraft,
  ExtraFields,
  PatientFields,
  ReferrerFields,
  ScheduleFields,
  scheduledTimestamp,
  TestsFields,
  validateSection,
  type BookingDraft,
} from './BookingFields'

export type DrawerAction = 'assign' | 'reschedule' | 'cancel'
interface Props {
  bookingId: string | null
  onClose: () => void
  action?: DrawerAction | null // open straight into one of the dialogs (row actions)
}

export default function BookingDrawer({ bookingId, onClose, action }: Props) {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const cat = useCatalogueMaps()
  const { data: booking0 } = useLiveDoc<Booking>(bookingId ? docRef<Booking>(paths.bookings, bookingId) : null, [bookingId])
  const booking = booking0 as BookingX | null
  const { data: users } = useLiveQuery<UserProfile>(col(paths.users), [])
  const { data: collectors } = useLiveQuery<Collector>(col('collectors'), [])
  const scope = useBranchScope()
  const { data: allBookings } = useLiveQuery<BookingX>(profile && profile.role !== 'phlebotomist' ? query(col<BookingX>(paths.bookings), ...scope.constraints) : null, [profile?.role, scope.key])
  const { current, branches } = useBranch()
  const phlebos = useMemo(
    () =>
      users.filter(
        (u) => u.role === 'phlebotomist' && u.active && (u.allBranches || (u.branchIds ?? ['main']).includes(current?.id ?? 'main')),
      ),
    [users, current],
  )

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<BookingDraft>(emptyDraft())
  const [mapItems, setMapItems] = useState<BookingItem[]>([])
  const [busy, setBusy] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignee, setAssignee] = useState<string>()
  const [notifyAssign, setNotifyAssign] = useState(false)
  const [reschedOpen, setReschedOpen] = useState(false)
  const [rDate, setRDate] = useState<Dayjs | null>(null)
  const [rSlot, setRSlot] = useState('')
  const [rReason, setRReason] = useState('')
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cReason, setCReason] = useState('')
  const [noteText, setNoteText] = useState('')
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (!bookingId || !action) return
    const key = `${bookingId}:${action}`
    if (done === key) return
    setDone(key)
    if (action === 'assign') { setAssignee(undefined); setNotifyAssign(false); setAssignOpen(true) }
    if (action === 'reschedule') { setRDate(null); setRSlot(''); setRReason(''); setReschedOpen(true) }
    if (action === 'cancel') { setCReason(''); setCancelOpen(true) }
  }, [bookingId, action, done])

  if (!booking || !profile) {
    return <Drawer open={!!bookingId} onClose={onClose} width={640} loading={!!bookingId && !booking} />
  }
  const b = booking
  const user = profile
  const closed = isClosed(b.status)
  const slotText = `${b.scheduledAt ? dayjs(b.scheduledAt.toDate()).format('DD MMM YYYY') : ''} ${b.slot}`.trim() || 'to be confirmed'

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) message.success(ok)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const notify = async (event: 'bookingConfirmed' | 'collectorAssigned') => {
    try {
      await sendBookingMessage({ bookingId: b.id, event, channels: ['whatsapp', 'sms'] })
    } catch (e) {
      message.warning(`Message could not be sent: ${(e as Error).message}`)
    }
  }

  const myWhatsApp = () => {
    const tpl = b.assignedToName ? settings.templates.collectorAssigned : settings.templates.bookingConfirmed
    const text = fillTemplate(tpl, {
      patientName: bookingName(b),
      labName: settings.name,
      bookingId: b.bookingNo,
      slot: slotText,
      collectorName: b.assignedToName,
      amount: formatINR(bookingTotal(b)),
    })
    window.open(whatsappLink(b.phone, text), '_blank', 'noopener')
  }

  const startEdit = () => {
    setDraft(draftFromBooking(b))
    setEditing(true)
  }
  const patch = (p: Partial<BookingDraft>) => setDraft((d) => ({ ...d, ...p }))

  const saveEdit = () => {
    const err = validateSection(draft, 'patient', settings.frontDesk) ?? validateSection(draft, 'tests') ?? validateSection(draft, 'extra', settings.frontDesk)
    if (err) return message.warning(err)
    const { ...data } = draftToBooking(draft)
    const upd: Partial<Booking> = { ...data }
    if (b.status === 'unmapped' && data.items.length > 0) upd.status = 'scheduled'
    return run(async () => {
      await updateBooking(b.id, upd, 'edited', '', user)
      setEditing(false)
    }, 'Booking updated')
  }

  const doMap = () =>
    run(() => mapBookingItems(b, mapItems, user), 'Tests mapped')

  const doAssign = () => {
    const p = phlebos.find((u) => u.uid === assignee)
    if (!p) return message.warning('Select a phlebotomist.')
    return run(async () => {
      await transitionBooking(b, 'assigned', user, { assignedTo: p.uid, assignedToName: p.name }, `Assigned to ${p.name}`)
      setAssignOpen(false)
      if (notifyAssign) await notify('collectorAssigned')
    }, `Assigned to ${p.name}`)
  }

  const doResched = () => {
    if (!rDate) return message.warning('Choose a new date.')
    if (!rSlot) return message.warning('Pick the new time slot.')
    if (!rReason.trim()) return message.warning('Enter a reason.')
    return run(async () => {
      await rescheduleBooking(b, { scheduledAt: scheduledTimestamp(rDate, rSlot)!, slot: rSlot, reason: `${rReason.trim()} (new: ${rDate.format('DD MMM YYYY')} ${rSlot})` }, user)
      setReschedOpen(false)
    }, 'Rescheduled')
  }

  const doCancel = () => {
    if (!cReason.trim()) return message.warning('A reason is required to cancel.')
    return run(async () => {
      await transitionBooking(b, 'cancelled', user, { cancelReason: cReason.trim() }, cReason.trim())
      setCancelOpen(false)
    }, 'Booking cancelled')
  }

  const doCollect = () =>
    run(async () => {
      const orderId = await convertToBill(b, settings, user, cat.packages, branches)
      message.success('Bill created')
      onClose()
      navigate(`/accession?order=${orderId}`)
    })

  const addNote = () =>
    run(async () => {
      await updateBooking(b.id, { notes: b.notes ? `${b.notes}\n${noteText.trim()}` : noteText.trim() }, 'note', noteText.trim(), user)
      setNoteText('')
    })

  const events = [...b.events].reverse()
  const actions = (
    <Space wrap>
      {canMove(b.status, 'confirmed') && b.status !== 'unmapped' && (
        <Button type="primary" loading={busy} onClick={() => run(async () => {
          await transitionBooking(b, 'confirmed', user)
        }, 'Confirmed')}>Confirm</Button>
      )}
      {b.status === 'rescheduled' && (
        <Button loading={busy} onClick={() => run(() => confirmReschedule(b, user), 'New slot confirmed')}>Confirm new slot</Button>
      )}
      {canMove(b.status, 'assigned') && can(profile, 'bookings.assign') && (
        <Button type="primary" onClick={() => { setAssignee(undefined); setNotifyAssign(false); setAssignOpen(true) }}>Assign Phlebotomist</Button>
      )}
      {canMove(b.status, 'inProgress') && (
        <Button type="primary" loading={busy} onClick={() => run(() => transitionBooking(b, 'inProgress', user), 'Started')}>Start</Button>
      )}
      {b.status === 'inProgress' &&
        (['started', 'atLocation', 'collected'] as PhleboStage[]).map((st) => (
          <Button key={st} size="small" type={b.phleboStage === st ? 'primary' : 'default'} loading={busy}
            onClick={() => run(() => updateBooking(b.id, { phleboStage: st } as Partial<Booking>, `stage: ${STAGE_LABEL[st]}`, '', user), STAGE_LABEL[st])}>
            {STAGE_LABEL[st]}
          </Button>
        ))}
      {!closed && b.items.length > 0 && b.status !== 'unmapped' && (
        <Button type="primary" loading={busy} disabled={!!billingBlockedReason(b, user)} title={billingBlockedReason(b, user) ?? undefined} onClick={doCollect}>Collect &amp; Create Bill</Button>
      )}
      {reminderDue(b, settings.frontDesk?.bookingReminderMinutes ?? 120) && (
        <Button loading={busy} onClick={() => {
          myWhatsApp()
          void run(() => updateBooking(b.id, { reminderSentAt: Timestamp.now() } as unknown as Partial<Booking>, 'reminder', 'Reminder opened in WhatsApp', user), 'Reminder logged')
        }}>Send reminder</Button>
      )}
      <Button href={`tel:${b.phone}`}>Call</Button>
      <Button onClick={myWhatsApp}>WhatsApp</Button>
      <Button loading={busy} onClick={() => run(async () => { const d = await duplicateBooking(b, user); message.success(`Duplicated as ${d.bookingNo}`) })}>Duplicate</Button>
      {canMove(b.status, 'rescheduled') && (
        <Button onClick={() => { setRDate(null); setRSlot(''); setRReason(''); setReschedOpen(true) }}>Reschedule</Button>
      )}
      {canMove(b.status, 'cancelled') && (
        <Button danger onClick={() => { setCReason(''); setCancelOpen(true) }}>Cancel</Button>
      )}
      {closed && ['labAdmin', 'admin', 'manager'].includes(user.role) && can(profile, 'bookings.manage') && !(b.status === 'completed' && b.orderId) && (
        <Button loading={busy} onClick={() => {
          let why = ''
          modal.confirm({
            title: 'Reopen this booking?',
            content: <Input placeholder="Reason (required)" onChange={(e) => { why = e.target.value }} />,
            okText: 'Reopen',
            onOk: () => run(() => reopenBooking(b, user, why), 'Booking reopened'),
          })
        }}>Reopen</Button>
      )}
    </Space>
  )

  return (
    <Drawer
      open={!!bookingId}
      onClose={() => { setEditing(false); onClose() }}
      width={680}
      destroyOnHidden
      title={
        <Space>
          <span>{b.bookingNo}</span>
          <StatusChip variant={STATUS_VARIANT[b.status]}>{STATUS_LABEL[b.status]}</StatusChip>
        </Space>
      }
      extra={
        !closed && !editing ? <Button onClick={startEdit}>Edit</Button> : null
      }
    >
      {closed && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`This booking is ${b.status}; editing is disabled.`} />}
      {!editing && <div style={{ marginBottom: 16 }}>{actions}</div>}

      {editing ? (
        <>
          <PatientFields value={draft} onChange={patch} />
          <ReferrerFields value={draft} onChange={patch} />
          <TestsFields value={draft} onChange={patch} />
          <ScheduleFields value={draft} onChange={patch} />
          <ExtraFields value={draft} onChange={patch} />
          <Space style={{ marginTop: 'var(--s-5)' }}>
            <Button type="primary" loading={busy} onClick={saveEdit}>Save changes</Button>
            <Button onClick={() => setEditing(false)}>Discard</Button>
          </Space>
        </>
      ) : (
        <>
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label="Patient">{bookingName(b)} · {b.ageValue}{b.ageUnit[0].toUpperCase()} / {b.gender}</Descriptions.Item>
            <Descriptions.Item label="Phone">{b.phone}{b.email ? ` · ${b.email}` : ''}</Descriptions.Item>
            <Descriptions.Item label="Address">{b.address}, {b.pincode}{b.landmark ? ` (${b.landmark})` : ''}</Descriptions.Item>
            <Descriptions.Item label="Referrer">{b.referrerName || 'Self'}</Descriptions.Item>
            <Descriptions.Item label="Type">{b.type === 'homeCollection' ? 'Home collection' : 'Lab visit'}</Descriptions.Item>
            <Descriptions.Item label="Schedule">{b.scheduledAt || b.slot ? slotText : 'Unscheduled'}</Descriptions.Item>
            <Descriptions.Item label="Phlebotomist">{b.assignedToName || '-'}{b.phleboStage ? ` (${STAGE_LABEL[b.phleboStage]})` : ''}</Descriptions.Item>
            <Descriptions.Item label="Source / priority">{SOURCE_LABEL[b.source ?? 'phone']} · {PRIORITY_LABEL[b.priority ?? 'medium']}{b.crmId ? ` · CRM ${b.crmId}` : ''}</Descriptions.Item>
            <Descriptions.Item label="Rate list / billing">{[b.rateListName, b.hospitalName && `Hospital: ${b.hospitalName}`, b.corporateName && `Corporate: ${b.corporateName}`].filter(Boolean).join(' · ') || 'Catalogue price'}</Descriptions.Item>
            {b.locationUrl && <Descriptions.Item label="Location"><a href={b.locationUrl} target="_blank" rel="noopener noreferrer">Open map</a></Descriptions.Item>}
            {b.specialInstructions && <Descriptions.Item label="Instructions">{b.specialInstructions}</Descriptions.Item>}
            {(b.customFields ?? []).map((f, i) => <Descriptions.Item key={i} label={f.key}>{f.value}</Descriptions.Item>)}
            <Descriptions.Item label="Tests">
              {b.items.length === 0 ? '-' : b.items.map((i) => `${i.name} (${formatINR(i.price)})`).join(', ')}
              {b.freeTextTests && <div><Tag color="orange">Requested</Tag>{b.freeTextTests}</div>}
            </Descriptions.Item>
            <Descriptions.Item label="Charges">
              Collection {formatINR(b.collectionCharge)} · Other {formatINR((b.otherCharges ?? []).reduce((x, c) => x + c.price, 0))} · Discount {formatINR(b.discount)} · Net {formatINR(bookingTotal(b))} · Prepaid {formatINR(b.prepaid)}{b.prepaidMode ? ` (${b.prepaidMode}${b.paymentChannel === 'online' ? `, online ${b.paymentState ?? ''}` : ''})` : ''}
            </Descriptions.Item>
            {b.cancelReason && <Descriptions.Item label="Cancel reason">{b.cancelReason}</Descriptions.Item>}
            {b.orderId && (
              <Descriptions.Item label="Bill">
                <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/accession?order=${b.orderId}`)}>Open bill</Button>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Notes"><span style={{ whiteSpace: 'pre-wrap' }}>{b.notes || '-'}</span></Descriptions.Item>
          </Descriptions>

          {b.status === 'unmapped' && (
            <>
              <Divider titlePlacement="start">Map tests to catalogue</Divider>
              <Typography.Paragraph type="secondary">Patient asked for: {b.freeTextTests}</Typography.Paragraph>
              <TestsFields
                value={{ ...emptyDraft(), items: mapItems, freeTextTests: '' }}
                onChange={(p) => p.items && setMapItems(p.items)}
              />
              <Button type="primary" disabled={mapItems.length === 0} loading={busy} onClick={doMap}>Save mapping</Button>
            </>
          )}

          <Divider titlePlacement="start">Message</Divider>
          <Space wrap>
            <Button loading={busy} onClick={() => run(() => notify('bookingConfirmed'), 'Confirmation requested')}>Send confirmation</Button>
            <Button onClick={myWhatsApp}>Send via my WhatsApp</Button>
          </Space>

          {!closed && (
            <>
              <Divider titlePlacement="start">Add note</Divider>
              <Space.Compact style={{ width: '100%' }}>
                <Input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note to the timeline" />
                <Button disabled={!noteText.trim()} loading={busy} onClick={addNote}>Add</Button>
              </Space.Compact>
            </>
          )}

          <Divider titlePlacement="start">Timeline</Divider>
          <Timeline
            items={events.map((e) => ({
              content: (
                <div>
                  <b>{e.action}</b> {e.note && <span>· {e.note}</span>}
                  <div style={{ fontSize: 12, color: 'var(--c-on-surface-variant)' }}>
                    {e.byName} · {e.at?.toDate ? dayjs(e.at.toDate()).format('DD MMM YYYY HH:mm') : ''}
                  </div>
                </div>
              ),
            }))}
          />
        </>
      )}

      <Modal title="Assign phlebotomist" open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={doAssign} confirmLoading={busy} okText="Assign">
        <label className="bill-field-label" htmlFor="assign-sel">Phlebotomist</label>
        <Select
          id="assign-sel"
          style={{ width: '100%', marginBottom: 12 }}
          placeholder={phlebos.length ? 'Select phlebotomist' : 'No phlebotomists found'}
          value={assignee}
          onChange={setAssignee}
          options={phlebos.map((u) => ({ value: u.uid, label: u.name }))}
        />
        {phlebos.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Typography.Text type="secondary">Suggested (pincode, shift, load)</Typography.Text>
            {suggestCollectors(b, phlebos.map((u) => ({ uid: u.uid, name: u.name })), collectors, allBookings).slice(0, 3).map((s) => (
              <div key={s.collector.uid}>
                <Button size="small" type={assignee === s.collector.uid ? 'primary' : 'link'} onClick={() => setAssignee(s.collector.uid)}>{s.collector.name}</Button>
                <span style={{ color: 'var(--c-on-surface-variant)' }}> {s.reasons.join(', ')}</span>
              </div>
            ))}
          </div>
        )}
        <Checkbox checked={notifyAssign} onChange={(e) => setNotifyAssign(e.target.checked)}>
          Notify patient (collector assigned)
        </Checkbox>
      </Modal>

      <Modal title="Reschedule" open={reschedOpen} onCancel={() => setReschedOpen(false)} onOk={doResched} confirmLoading={busy} okText="Reschedule">
        <FormSection title="New time" description="Pick the new date and slot.">
          <FieldGrid min={200}>
            <div>
              <label className="bill-field-label" htmlFor="rs-date">Date</label>
              <DatePicker id="rs-date" style={{ width: '100%' }} value={rDate} onChange={setRDate} disabledDate={(d) => d.isBefore(dayjs().startOf('day'))} />
            </div>
            <div>
              <label className="bill-field-label" htmlFor="rs-slot">Slot</label>
              <Select id="rs-slot" allowClear style={{ width: '100%' }} placeholder="Slot" value={rSlot || undefined} onChange={(s) => setRSlot(s ?? '')} options={SLOTS.map((s) => ({ value: s, label: s }))} />
            </div>
          </FieldGrid>
          <label className="bill-field-label" htmlFor="rs-reason" style={{ marginTop: 'var(--s-3)' }}>Reason</label>
          <Input.TextArea id="rs-reason" rows={2} placeholder="Reason (required)" value={rReason} onChange={(e) => setRReason(e.target.value)} />
        </FormSection>
      </Modal>

      {!closed && b.paymentChannel === 'online' && bookingTotal(b) - b.prepaid > 0 && (
        <>
          <Divider titlePlacement="start">Online payment</Divider>
          <Space>
            <span>Balance {formatINR(bookingTotal(b) - b.prepaid)}</span>
            <PayOnlineButton input={{ purpose: 'booking', refId: b.id, amount: bookingTotal(b) - b.prepaid, payer: { name: bookingName(b), email: b.email, phone: b.phone } }} label="Pay online" />
          </Space>
        </>
      )}

      <Divider titlePlacement="start">Note attachments</Divider>
      <QuotationAttachments quotationId={b.id} parent="bookings" pending={[]} onPending={() => undefined} readOnly={closed} />

      <Modal title="Cancel booking" open={cancelOpen} onCancel={() => setCancelOpen(false)} onOk={doCancel} confirmLoading={busy} okText="Cancel booking" okButtonProps={{ danger: true }}>
        <Input.TextArea aria-label="Cancel reason" rows={3} placeholder="Reason (required)" value={cReason} onChange={(e) => setCReason(e.target.value)} />
      </Modal>
    </Drawer>
  )
}
