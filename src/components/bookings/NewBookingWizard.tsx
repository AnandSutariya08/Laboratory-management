import { useState } from 'react'
import { App, Button, Checkbox, Modal, Space, Steps } from 'antd'
import { useAuth } from '../../auth/AuthProvider'
import { useLabSettings } from '../../hooks/useCatalogue'
import { useBranch } from '../../branch/BranchProvider'
import { createBooking } from '../../lib/bookings'
import { formatINR } from '../../lib/money'
import { fillTemplate, sendBookingMessage, whatsappLink } from '../../lib/messaging'
import {
  draftToBooking,
  draftTotals,
  emptyDraft,
  ExtraFields,
  PatientFields,
  PaymentFields,
  ReferrerFields,
  ScheduleFields,
  TestsFields,
  validateSection,
  type BookingDraft,
} from './BookingFields'
import { dialogWidth } from '../../design/dialog'

interface Props {
  open: boolean
  onClose: () => void
  onCreated?: (bookingId: string) => void
  initial?: Partial<BookingDraft> // e.g. from a pre-booking enquiry
}

const STEPS = ['Patient', 'Referrer & Rate List', 'Tests', 'Schedule', 'Additional', 'Payment']

export default function NewBookingWizard({ open, onClose, onCreated, initial }: Props) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const { current } = useBranch()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<BookingDraft>({ ...emptyDraft(), ...initial })
  const [seeded, setSeeded] = useState(initial)
  if (open && initial !== seeded) {
    setSeeded(initial)
    setDraft({ ...emptyDraft(), ...initial })
    setStep(0)
  }
  const [send, setSend] = useState(true)
  const [saving, setSaving] = useState(false)

  const patch = (p: Partial<BookingDraft>) => setDraft((d) => ({ ...d, ...p }))
  const reset = () => {
    setStep(0)
    setDraft({ ...emptyDraft(), ...initial })
    setSend(true)
  }
  const close = () => {
    reset()
    onClose()
  }

  const validate = (s: number): string | null =>
    s === 0 ? validateSection(draft, 'patient', settings.frontDesk)
    : s === 2 ? validateSection(draft, 'tests')
    : s === 4 ? validateSection(draft, 'extra', settings.frontDesk)
    : s === 5 ? validateSection(draft, 'payment')
    : null

  const next = () => {
    const err = validate(step)
    if (err) return message.warning(err)
    setStep(step + 1)
  }

  const slotText = () =>
    draft.date ? `${draft.date.format('DD MMM YYYY')}${draft.slot ? ` ${draft.slot}` : ''}` : 'a time to be confirmed'

  const waText = (bookingNo: string) =>
    fillTemplate(settings.templates.bookingConfirmed, {
      patientName: `${draft.firstName} ${draft.lastName}`.trim(),
      labName: settings.name,
      bookingId: bookingNo,
      slot: slotText(),
      amount: formatINR(draftTotals(draft).net),
      collectorName: '',
    })

  const save = async (viaMyWhatsApp = false) => {
    for (const s of [0, 2, 4, 5]) {
      const err = validate(s)
      if (err) {
        setStep(s)
        return message.warning(err)
      }
    }
    if (!profile) return
    setSaving(true)
    try {
      const booking = await createBooking(draftToBooking(draft), profile)
      message.success(`Booking ${booking.bookingNo} created`)
      if (viaMyWhatsApp) {
        window.open(whatsappLink(draft.phone, waText(booking.bookingNo)), '_blank', 'noopener')
      } else if (send) {
        try {
          await sendBookingMessage({ bookingId: booking.id, event: 'bookingConfirmed', channels: ['whatsapp', 'sms'] })
        } catch (e) {
          message.warning(`Booking saved, but the confirmation could not be sent: ${(e as Error).message}`)
        }
      }
      onCreated?.(booking.id)
      close()
    } catch (e) {
      message.error(`Could not save booking: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={`New Booking${current ? ` · ${current.name}` : ''}`}
      width={dialogWidth(760)}
      onCancel={close}
      maskClosable={false}
      destroyOnHidden
      footer={
        <Space wrap>
          {step === 5 && (
            <>
              <Checkbox checked={send} onChange={(e) => setSend(e.target.checked)}>
                Send confirmation
              </Checkbox>
              <Button loading={saving} onClick={() => save(true)}>
                Save &amp; send via my WhatsApp
              </Button>
            </>
          )}
          <Button onClick={close}>Cancel</Button>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
          {step < 5 ? (
            <Button type="primary" onClick={next}>
              Next
            </Button>
          ) : (
            <Button type="primary" loading={saving} onClick={() => save(false)}>
              Save Booking
            </Button>
          )}
        </Space>
      }
    >
      <Steps current={step} size="small" items={STEPS.map((title) => ({ title }))} style={{ marginBottom: 20 }} responsive={false} />
      {step === 0 && <PatientFields value={draft} onChange={patch} />}
      {step === 1 && <ReferrerFields value={draft} onChange={patch} />}
      {step === 2 && <TestsFields value={draft} onChange={patch} />}
      {step === 3 && <ScheduleFields value={draft} onChange={patch} />}
      {step === 4 && <ExtraFields value={draft} onChange={patch} />}
      {step === 5 && <PaymentFields value={draft} onChange={patch} />}
    </Modal>
  )
}
