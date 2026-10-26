import { useState } from 'react'
import { App, Form, Input, InputNumber, Modal, Select, Switch } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { addDoc, serverTimestamp } from 'firebase/firestore'
import { Button } from '../../design/Button'
import { col } from '../../lib/db'
import { useMasters, type PartnerContext } from '../../lib/masters'
import { useLabSettings } from '../../hooks/useCatalogue'
import { isRegistrationFieldHidden, registrationFieldLabel } from '../../features/settings/lib'
import './billing.css'

const opt = (xs: { id: string; name: string }[]) => xs.map((x) => ({ value: x.id, label: x.name }))
const fuzzy = (input: string, o?: { label?: unknown }) => String(o?.label ?? '').toLowerCase().includes(input.toLowerCase())

// Referrer, hospital, B2B, collection centre, corporate, government panel and TPA selects.
// Controlled; used by Registration, Billing and Edit bill so they stay in sync.
export function PartnerFields({
  value,
  onChange,
  required = [],
  only,
  withRateList = false,
  configurable = false,
}: {
  value: PartnerContext
  onChange: (next: PartnerContext) => void
  required?: string[] // registration.requiredFields keys
  only?: (keyof PartnerContext)[]
  withRateList?: boolean // manual rate list select (registration and billing)
  configurable?: boolean // registration: honour the lab's renamed labels and hidden fields (Settings > Registration fields)
}) {
  const m = useMasters()
  const settings = useLabSettings()
  const [add, setAdd] = useState<'doctor' | 'hospital' | null>(null)
  const set = (patch: Partial<PartnerContext>) => onChange({ ...value, ...patch })
  const show = (k: keyof PartnerContext) => (k === 'rateListId' ? withRateList : !only || only.includes(k))
  // Collection centre set to "selected referrers only": the doctor and hospital lists shrink to its allowed ones.
  const cc = m.collectionCentres.find((c) => c.id === value.collectionCentreId)
  const allowed = cc?.referrals === 'selected' ? new Set(cc.referrerIds ?? []) : null
  const limit = <T extends { id: string; name: string }>(xs: T[]) => (allowed ? xs.filter((x) => allowed.has(x.id)) : xs)
  const star = (k: string) => (required.includes(k) ? ' *' : '')

  const field = (
    k: keyof PartnerContext,
    label: string,
    options: { value: string; label: string }[],
    reqKey: string,
    plus?: 'doctor' | 'hospital',
  ) =>
    show(k) && !(configurable && isRegistrationFieldHidden(settings, reqKey)) && (
      <div key={k}>
        <label className="bill-field-label" htmlFor={`pf-${k}`}>
          {configurable ? registrationFieldLabel(settings, reqKey, label) : label}
          {star(reqKey)}
        </label>
        <div className="bill-partners__row">
          <Select
            id={`pf-${k}`}
            showSearch
            allowClear
            placeholder={`Select ${(configurable ? registrationFieldLabel(settings, reqKey, label) : label).toLowerCase()}`}
            value={value[k] || undefined}
            options={options}
            filterOption={fuzzy}
            onChange={(v) => set({ [k]: v ?? undefined })}
            style={{ width: '100%' }}
          />
          {plus && (
            <Button aria-label={`Add ${plus}`} icon={<PlusOutlined />} onClick={() => setAdd(plus)} />
          )}
        </div>
      </div>
    )

  return (
    <>
      <div className="bill-partners">
        {field('referrerId', 'Referring doctor', opt(limit(m.doctors)), 'referrer', 'doctor')}
        {field('hospitalId', 'Referring hospital', opt(limit(m.hospitals)), 'hospital', 'hospital')}
        {field('secondReferrerId', 'Second referral', opt([...m.secondReferrals, ...m.doctors.filter((d) => !m.secondReferrals.some((x) => x.id === d.id))]), 'secondReferrer')}
        {field('b2bCentreId', 'B2B centre', opt(m.b2bCentres), 'b2bCentre')}
        {field('collectionCentreId', 'Collection centre', opt(m.collectionCentres), 'collectionCentre')}
        {field('corporateClientId', 'Corporate client', opt(m.corporateClients), 'company')}
        {field('govPanelId', 'Government panel', opt(m.govPanels), 'govPanel')}
        {field('tpaId', 'TPA', opt(m.tpas), 'tpa')}
        {field('rateListId', 'Rate list', opt(m.rateLists), 'rateList')}
      </div>
      <QuickAddReferrer
        kind={add}
        onClose={() => setAdd(null)}
        onCreated={(id) => set(add === 'doctor' ? { referrerId: id } : { hospitalId: id })}
      />
    </>
  )
}

// "+" quick-create: a doctor (can be saved as temporary) or a hospital, stored in referrers.
function QuickAddReferrer({
  kind,
  onClose,
  onCreated,
}: {
  kind: 'doctor' | 'hospital' | null
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const save = async (temporary: boolean) => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      const ref = await addDoc(col('referrers'), {
        name: String(v.name).trim(),
        type: kind,
        degree: v.degree ?? '',
        phone: v.phone ?? '',
        email: v.email ?? '',
        address: '',
        speciality: '',
        commissionType: v.commission > 0 ? 'percent' : 'none',
        commissionValue: v.commission ?? 0,
        rateListId: '',
        proManagerId: '',
        temporary: kind === 'doctor' ? temporary : false,
        autoSendReports: !!v.autoSend,
        active: true,
        createdAt: serverTimestamp(),
      })
      onCreated(ref.id)
      form.resetFields()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open={!!kind}
      onCancel={onClose}
      destroyOnHidden
      title={kind === 'doctor' ? 'Add referring doctor' : 'Add referring hospital'}
      footer={
        <div className="bill-actions">
          <Button onClick={onClose}>Cancel</Button>
          {kind === 'doctor' && (
            <Button disabled={saving} onClick={() => save(true)}>
              Save as temporary
            </Button>
          )}
          <Button variant="primary" disabled={saving} onClick={() => save(false)}>
            Save
          </Button>
        </div>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label={kind === 'doctor' ? 'Doctor name' : 'Hospital name'} rules={[{ required: true, whitespace: true, message: 'Name is required' }]}>
          <Input autoFocus maxLength={120} />
        </Form.Item>
        {kind === 'doctor' && (
          <Form.Item name="degree" label="Degree">
            <Input maxLength={80} />
          </Form.Item>
        )}
        <Form.Item name="phone" label="Phone" rules={[{ pattern: /^\d{10}$/, message: 'Enter a 10 digit number' }]}>
          <Input maxLength={10} addonBefore="+91" />
        </Form.Item>
        <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Invalid email' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="commission" label="Commission %">
          <InputNumber min={0} max={100} precision={2} style={{ width: 160 }} />
        </Form.Item>
        {kind === 'doctor' && (
          <Form.Item name="autoSend" label="Send reports to this doctor automatically (paid bills only)" valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}
