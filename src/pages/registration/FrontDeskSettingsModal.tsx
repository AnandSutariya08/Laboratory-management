import { useEffect, useState } from 'react'
import { App, Checkbox, Input, InputNumber, Modal, Radio, Select, Tabs } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { updateDoc } from 'firebase/firestore'
import { Button } from '../../design/Button'
import { useFrontDesk } from '../../lib/frontDesk'
import { labDoc } from '../../lib/db'
import { toPaise, toRupees } from '../../lib/money'
import { REGISTRATION_FIELDS } from '../../features/settings/constants'
import type { CustomFieldDef, FrontDeskSettings } from '../../types'
import { dialogWidth } from '../../design/dialog'

const TYPES = [{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }, { value: 'select', label: 'Choice list' }]

function DefEditor({ value, onChange, noun }: { value: CustomFieldDef[]; onChange: (v: CustomFieldDef[]) => void; noun: string }) {
  const set = (i: number, patch: Partial<CustomFieldDef>) => onChange(value.map((d, n) => (n === i ? { ...d, ...patch } : d)))
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {value.map((d, i) => (
        <div key={d.key} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input aria-label={`${noun} label`} style={{ width: 200 }} placeholder="Label" value={d.label} onChange={(e) => set(i, { label: e.target.value })} />
          <Select aria-label={`${noun} type`} style={{ width: 130 }} value={d.type ?? 'text'} options={TYPES} onChange={(type) => set(i, { type })} />
          {d.type === 'select' && (
            <Input aria-label={`${noun} choices`} style={{ width: 220 }} placeholder="Choices, comma separated" value={(d.options ?? []).join(', ')} onChange={(e) => set(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          )}
          <Checkbox checked={!!d.required} onChange={(e) => set(i, { required: e.target.checked })}>Required</Checkbox>
          <Button variant="text" aria-label={`Remove ${noun} ${d.label || ''}`} icon={<DeleteOutlined />} onClick={() => onChange(value.filter((_, n) => n !== i))} />
        </div>
      ))}
      <div>
        <Button icon={<PlusOutlined />} onClick={() => onChange([...value, { key: `f${Date.now().toString(36)}`, label: '', type: 'text' }])}>Add {noun}</Button>
      </div>
    </div>
  )
}

// Front desk configuration kept on the lab doc: renamed registration labels, add-on fields,
// refund approval threshold, serviceable pincodes and booking custom fields.
export default function FrontDeskSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const fd = useFrontDesk()
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState<CustomFieldDef[]>([])
  const [bookingFields, setBookingFields] = useState<CustomFieldDef[]>([])
  const [threshold, setThreshold] = useState<number>(0)
  const [maxDisc, setMaxDisc] = useState<number>(0)
  const [pins, setPins] = useState('')
  const [policy, setPolicy] = useState<'warn' | 'block'>('warn')
  const [reminder, setReminder] = useState<number>(120)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLabels(fd.fieldLabels ?? {})
    setCustom(fd.customFields)
    setBookingFields(fd.bookingFields)
    setThreshold(toRupees(fd.refundApprovalThreshold ?? 0))
    setMaxDisc(toRupees(fd.maxDiscountAmount ?? 0))
    setPins((fd.serviceablePincodes ?? []).join(', '))
    setPolicy(fd.pincodePolicy ?? 'warn')
    setReminder(fd.bookingReminderMinutes ?? 120)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const save = async () => {
    setSaving(true)
    try {
      const next: FrontDeskSettings = {
        fieldLabels: Object.fromEntries(Object.entries(labels).filter(([, v]) => v.trim())),
        customFields: custom.filter((c) => c.label.trim()),
        bookingFields: bookingFields.filter((c) => c.label.trim()),
        refundApprovalThreshold: toPaise(threshold || 0),
        maxDiscountAmount: toPaise(maxDisc || 0),
        serviceablePincodes: pins.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d{6}$/.test(x)),
        pincodePolicy: policy,
        bookingReminderMinutes: reminder || 120,
      }
      await updateDoc(labDoc(), { frontDesk: next })
      message.success('Front desk settings saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title="Front desk settings" okText="Save" onOk={save} confirmLoading={saving} width={dialogWidth(760)} destroyOnHidden>
      <Tabs
        items={[
          {
            key: 'labels',
            label: 'Field labels',
            children: (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, maxHeight: 360, overflow: 'auto' }}>
                {REGISTRATION_FIELDS.map((f) => (
                  <Input key={f.value} aria-label={`Label for ${f.label}`} addonBefore={f.label} placeholder="Default" value={labels[f.value] ?? ''} onChange={(e) => setLabels({ ...labels, [f.value]: e.target.value })} />
                ))}
              </div>
            ),
          },
          { key: 'custom', label: 'Add-on fields', children: <DefEditor value={custom} onChange={setCustom} noun="field" /> },
          {
            key: 'refund',
            label: 'Refunds',
            children: (
              <div style={{ display: 'grid', gap: 8 }}>
                <label htmlFor="fd-threshold">Refunds above this amount need a manager or admin to approve (0 = off)</label>
                <InputNumber id="fd-threshold" addonBefore="₹" min={0} precision={2} value={threshold} onChange={(v) => setThreshold(v ?? 0)} style={{ width: 200 }} />
                <label htmlFor="fd-maxdisc" style={{ display: 'block', marginTop: 12 }}>Largest discount per bill (₹) for staff who are not managers; above it a manager must approve (0 = no cap)</label>
                <InputNumber id="fd-maxdisc" addonBefore="₹" min={0} precision={2} value={maxDisc} onChange={(v) => setMaxDisc(v ?? 0)} style={{ width: 200 }} />
              </div>
            ),
          },
          {
            key: 'pins',
            label: 'Serviceable pincodes',
            children: (
              <div style={{ display: 'grid', gap: 8 }}>
                <label htmlFor="fd-pins">Home collection is offered only in these pincodes (empty = everywhere)</label>
                <Input.TextArea id="fd-pins" rows={4} value={pins} onChange={(e) => setPins(e.target.value)} placeholder="411001, 411002, ..." />
                <Radio.Group value={policy} onChange={(e) => setPolicy(e.target.value)} options={[{ value: 'warn', label: 'Warn and allow override' }, { value: 'block', label: 'Block booking' }]} />
              </div>
            ),
          },
          {
            key: 'booking',
            label: 'Booking fields',
            children: (
              <div style={{ display: 'grid', gap: 12 }}>
                <DefEditor value={bookingFields} onChange={setBookingFields} noun="booking field" />
                <div>
                  <label htmlFor="fd-reminder">Reminder before a home collection (minutes)</label>
                  <div><InputNumber id="fd-reminder" min={15} max={1440} value={reminder} onChange={(v) => setReminder(v ?? 120)} /></div>
                </div>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  )
}
