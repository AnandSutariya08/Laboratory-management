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
import { FormSection, SettingRow } from '../../design/FormLayout'

const TYPES = [{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }, { value: 'select', label: 'Choice list' }]

function DefEditor({ value, onChange, noun }: { value: CustomFieldDef[]; onChange: (v: CustomFieldDef[]) => void; noun: string }) {
  const set = (i: number, patch: Partial<CustomFieldDef>) => onChange(value.map((d, n) => (n === i ? { ...d, ...patch } : d)))
  return (
    <div className="fd-defs">
      {value.length === 0 && <div className="reg__hint">No {noun}s yet.</div>}
      {value.map((d, i) => (
        <div key={d.key} className="fd-def">
          <Input aria-label={`${noun} label`} placeholder="Label" value={d.label} onChange={(e) => set(i, { label: e.target.value })} />
          <Select aria-label={`${noun} type`} value={d.type ?? 'text'} options={TYPES} onChange={(type) => set(i, { type })} />
          <Checkbox checked={!!d.required} onChange={(e) => set(i, { required: e.target.checked })}>Required</Checkbox>
          <Button variant="text" aria-label={`Remove ${noun} ${d.label || ''}`} icon={<DeleteOutlined />} onClick={() => onChange(value.filter((_, n) => n !== i))} />
          {d.type === 'select' && (
            <Input className="fd-def__choices" aria-label={`${noun} choices`} placeholder="Choices, comma separated" value={(d.options ?? []).join(', ')} onChange={(e) => set(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          )}
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
              <FormSection title="Field labels" description="Rename the registration fields to match your lab's wording. Leave blank to keep the default.">
              <div className="fd-labels">
                {REGISTRATION_FIELDS.map((f) => (
                  <Input key={f.value} aria-label={`Label for ${f.label}`} addonBefore={f.label} placeholder="Default" value={labels[f.value] ?? ''} onChange={(e) => setLabels({ ...labels, [f.value]: e.target.value })} />
                ))}
              </div>
              </FormSection>
            ),
          },
          { key: 'custom', label: 'Add-on fields', children: <FormSection title="Add-on fields" description="Extra fields shown on the registration form."><DefEditor value={custom} onChange={setCustom} noun="field" /></FormSection> },
          {
            key: 'refund',
            label: 'Refunds',
            children: (
              <FormSection title="Approval limits" description="Amounts above these limits need a manager or admin.">
                <SettingRow label="Refund approval above" htmlFor="fd-threshold" help="Refunds above this amount need a manager or admin to approve. 0 = off.">
                  <InputNumber id="fd-threshold" addonBefore="₹" min={0} precision={2} value={threshold} onChange={(v) => setThreshold(v ?? 0)} style={{ width: 180 }} />
                </SettingRow>
                <SettingRow label="Largest discount per bill" htmlFor="fd-maxdisc" help="For staff who are not managers; above it a manager must approve. 0 = no cap.">
                  <InputNumber id="fd-maxdisc" addonBefore="₹" min={0} precision={2} value={maxDisc} onChange={(v) => setMaxDisc(v ?? 0)} style={{ width: 180 }} />
                </SettingRow>
              </FormSection>
            ),
          },
          {
            key: 'pins',
            label: 'Serviceable pincodes',
            children: (
              <FormSection title="Home collection area" description="Control where home collection can be booked.">
                <SettingRow label="Serviceable pincodes" htmlFor="fd-pins" help="Home collection is offered only in these pincodes. Empty = everywhere." align="start">
                  <Input.TextArea id="fd-pins" rows={4} style={{ width: '100%' }} value={pins} onChange={(e) => setPins(e.target.value)} placeholder="411001, 411002, ..." />
                </SettingRow>
                <SettingRow label="Outside the area" help="What happens when a pincode is not in the list.">
                  <Radio.Group value={policy} onChange={(e) => setPolicy(e.target.value)} options={[{ value: 'warn', label: 'Warn and allow override' }, { value: 'block', label: 'Block booking' }]} />
                </SettingRow>
              </FormSection>
            ),
          },
          {
            key: 'booking',
            label: 'Booking fields',
            children: (
              <>
                <FormSection title="Custom booking fields" description="Extra fields captured on each booking.">
                  <DefEditor value={bookingFields} onChange={setBookingFields} noun="booking field" />
                </FormSection>
                <FormSection title="Reminders">
                  <SettingRow label="Home collection reminder" htmlFor="fd-reminder" help="How long before a home collection the reminder is raised.">
                    <InputNumber id="fd-reminder" min={15} max={1440} value={reminder} onChange={(v) => setReminder(v ?? 120)} addonAfter="minutes" />
                  </SettingRow>
                </FormSection>
              </>
            ),
          },
        ]}
      />
    </Modal>
  )
}
