import { useEffect, useMemo, useState } from 'react'
import { App, AutoComplete, DatePicker, Form, Input, InputNumber, Modal, Radio, Select, Table } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { addDoc, serverTimestamp, Timestamp, updateDoc } from 'firebase/firestore'
import dayjs from 'dayjs'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { useLabSettings } from '../../hooks/useCatalogue'
import { branchStamp } from '../../lib/activeBranch'
import { allocateDiscount, allocatePercent, computeTotals, derivedPercent } from '../../lib/billing'
import { col, docRef } from '../../lib/db'
import { nextQuoNo } from './lib'
import { QuotationAttachments, saveAttachments, type AttachmentDoc } from './attachments'
import { effectiveStatus, type Quotation } from './types'
import { useMasters, type PartnerContext } from '../../lib/masters'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { clean, logActivity } from '../../lib/orders'
import type { AgeUnit, Gender, OrderItem } from '../../types'
import { Alert } from 'antd'
import { preCollectionGuidelines } from '../../pages/catalogue/flags'
import { ItemPicker, useLinePricer } from '../../components/billing/lines'
import { PartnerFields } from '../../components/billing/PartnerFields'
import '../../components/billing/billing.css'
import { FormSection } from '../../design/FormLayout'
import { dialogWidth } from '../../design/dialog'

export interface QuotationPrefill {
  name?: string
  phone?: string
  email?: string
  gender?: Gender
  ageValue?: number
  ageUnit?: AgeUnit
  patientId?: string
  patientNo?: string
  partners?: PartnerContext
}

// Create a quotation from registration (prefilled) or standalone (prospect name/phone only).
export default function QuotationModal({
  open,
  onClose,
  prefill,
  onCreated,
  editing,
}: {
  open: boolean
  onClose: () => void
  prefill?: QuotationPrefill
  onCreated?: (id: string) => void
  // Open an existing quotation: editable while Draft / Sent, read-only otherwise.
  editing?: Quotation | null
}) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const masters = useMasters()
  const [form] = Form.useForm()
  const watchedGender = Form.useWatch('gender', form)
  const [partners, setPartners] = useState<PartnerContext>({})
  const [items, setItems] = useState<OrderItem[]>([])
  const [pct, setPct] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [valid, setValid] = useState(dayjs().add(settings.quotation.validityDays, 'day'))
  const [saving, setSaving] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<AttachmentDoc[]>([])
  const pricer = useLinePricer(partners)
  const readOnly = !!editing && !['draft', 'sent'].includes(effectiveStatus(editing)) && effectiveStatus(editing) !== 'expired'

  useEffect(() => {
    if (!open) return
    setPendingFiles([])
    if (editing) {
      const pr = editing.prospect
      form.setFieldsValue({ name: pr.name, phone: pr.phone, email: pr.email, gender: pr.gender || undefined, ageValue: pr.ageValue ?? undefined, ageUnit: pr.ageUnit, notes: editing.notes })
      setPartners(editing.partners ?? {})
      setItems(editing.items)
      setPct(null)
      setReason(editing.discountReason ?? '')
      setValid(dayjs(editing.validUntil?.toDate?.() ?? new Date()))
      return
    }
    form.setFieldsValue({
      name: prefill?.name ?? '', phone: prefill?.phone ?? '', email: prefill?.email ?? '',
      gender: prefill?.gender, ageValue: prefill?.ageValue, ageUnit: prefill?.ageUnit ?? 'year', notes: '',
    })
    setPartners(prefill?.partners ?? {})
    setItems([])
    setPct(null)
    setReason('')
    setValid(dayjs().add(settings.quotation.validityDays, 'day'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Rate list changes re-price the lines (not when just opening a saved quotation).
  useEffect(() => {
    if (editing) return
    setItems((prev) => spread(pricer.reprice(prev), pct))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricer.reprice])

  function spread(list: OrderItem[], p: number | null): OrderItem[] {
    if (!p) return list.map((i) => ({ ...i, discount: 0 }))
    const shares = allocatePercent(list, p)
    return list.map((i, k) => ({ ...i, discount: shares[k] }))
  }
  const totals = useMemo(() => computeTotals(items), [items])
  const setPercent = (p: number | null) => { setPct(p); setItems(spread(items, p)) }
  const setAmount = (v: number | null) => {
    const paise = Math.max(0, toPaise(v ?? 0))
    const shares = allocateDiscount(items, paise)
    const next = items.map((i, k) => ({ ...i, discount: shares[k] }))
    setItems(next)
    setPct(paise > 0 ? derivedPercent(next) : null)
  }

  const save = async () => {
    const v = await form.validateFields()
    if (!items.length) return message.warning('Add at least one test, package or charge.')
    if (!profile) return
    setSaving(true)
    try {
      const quoNo = editing ? editing.quoNo : await nextQuoNo(settings)
      const doc = clean({
        ...branchStamp(),
        quoNo,
        status: 'draft',
        prospect: { name: String(v.name).trim(), phone: v.phone ?? '', email: v.email ?? '', gender: v.gender ?? '', ageValue: v.ageValue ?? null, ageUnit: v.ageUnit ?? 'year' },
        patientId: prefill?.patientId ?? '',
        patientNo: prefill?.patientNo ?? '',
        partners: clean(partners as Record<string, unknown>),
        items: items.map((i) => clean(i as unknown as Record<string, unknown>)),
        ...totals,
        discountReason: reason.trim(),
        notes: v.notes ?? '',
        validUntil: Timestamp.fromDate(valid.endOf('day').toDate()),
        orderId: '',
        createdAt: serverTimestamp(),
        createdBy: profile.uid,
        createdByName: profile.name,
      })
      if (editing) {
        const { createdAt: _c, createdBy: _b, createdByName: _n, status: _s, orderId: _o, ...rest } = doc as Record<string, unknown>
        void [_c, _b, _n, _s, _o]
        await updateDoc(docRef('quotations', editing.id), { ...rest, updatedAt: serverTimestamp() })
        void logActivity('quotation', `Quotation ${quoNo} edited`, `quotations/${editing.id}`, { category: 'OTHER', actor: profile })
        message.success(`Quotation ${quoNo} updated`)
        onCreated?.(editing.id)
        onClose()
        return
      }
      const ref = await addDoc(col('quotations'), doc)
      if (pendingFiles.length) await saveAttachments(ref.id, pendingFiles, profile.uid)
      void logActivity('quotation', `Quotation ${quoNo} created for ${doc.prospect.name}`, `quotations/${ref.id}`, { category: 'OTHER', actor: profile })
      message.success(`Quotation ${quoNo} created`)
      onCreated?.(ref.id)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      destroyOnHidden
      maskClosable={false}
      width={dialogWidth(980)}
      title={editing ? `${readOnly ? 'Quotation' : 'Edit quotation'} ${editing.quoNo}` : 'Create quotation'}
      footer={
        <div className="bill-actions">
          <Button onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button variant="primary" disabled={saving} onClick={save}>{editing ? 'Save changes' : 'Create quotation'}</Button>}
        </div>
      }
    >
      <Form form={form} layout="vertical" requiredMark disabled={readOnly}>
        <FormSection title="Prospect details" description="Who the quotation is for and how long it stays valid.">
        <div className="bill-partners">
          <Form.Item name="name" label="Prospect / patient name" rules={[{ required: true, whitespace: true, message: 'Name is required' }]}>
            <Input maxLength={120} autoFocus />
          </Form.Item>
          <Form.Item name="phone" label="Phone" rules={[{ pattern: /^\d{10}$/, message: 'Enter a 10 digit number' }]}>
            <Input maxLength={10} addonBefore="+91" />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Invalid email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="gender" label="Gender">
            <Radio.Group options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} />
          </Form.Item>
          <Form.Item label="Age">
            <Input.Group compact>
              <Form.Item name="ageValue" noStyle><InputNumber min={0} max={150} precision={0} style={{ width: '55%' }} /></Form.Item>
              <Form.Item name="ageUnit" noStyle>
                <Select style={{ width: '45%' }} options={[{ value: 'year', label: 'Years' }, { value: 'month', label: 'Months' }, { value: 'day', label: 'Days' }]} />
              </Form.Item>
            </Input.Group>
          </Form.Item>
          <Form.Item label="Valid until">
            <DatePicker value={valid} allowClear={false} onChange={(d) => d && setValid(d)} disabledDate={(d) => d.isBefore(dayjs(), 'day')} />
          </Form.Item>
        </div>
        </FormSection>
      </Form>
      <FormSection title="Rate list (partner)" description="Pricing follows the partner you pick.">
        <PartnerFields value={partners} onChange={setPartners} only={['referrerId', 'hospitalId', 'b2bCentreId', 'collectionCentreId', 'corporateClientId', 'govPanelId', 'tpaId']} />
      </FormSection>
      <FormSection title="Tests and charges">
      {!readOnly && <ItemPicker ctx={partners} gender={watchedGender} onPick={(l) => setItems(spread([...items, l], pct))} />}
      {preCollectionGuidelines(items.flatMap((l) => l.testIds.map((t) => pricer.cat.testById.get(t)))).map((g) => (
        <Alert key={g.text} type="info" showIcon style={{ marginBottom: 6 }} message={`${g.name}: ${g.text}`} />
      ))}
      <Table<OrderItem>
        size="small"
        rowKey="lineId"
        pagination={false}
        dataSource={items}
        locale={{ emptyText: 'No items added yet' }}
        scroll={{ y: 220 }}
        columns={[
          { title: 'Sr', width: 44, render: (_, __, i) => i + 1 },
          { title: 'Test / Package', render: (_, r) => (<>{r.name} {r.isCharge && <StatusChip>Other charge</StatusChip>}</>) },
          { title: 'Price', width: 110, align: 'right', render: (_, r) => formatINR(r.price) },
          {
            title: '', width: 50,
            render: (_, r) => <Button variant="text" aria-label={`Remove ${r.name}`} icon={<DeleteOutlined />} onClick={() => setItems(spread(items.filter((i) => i.lineId !== r.lineId), pct))} />,
          },
        ]}
      />
      </FormSection>
      <FormSection title="Discount and total">
      <div className="bill-grid2">
        <div className="bill-section">
          <h3 className="bill-section__title">Discount</h3>
          <div className="bill-fgrid">
            <div>
              <label className="bill-field-label" htmlFor="q-pct">Discount percent</label>
              <InputNumber id="q-pct" aria-label="Discount percent" addonAfter="%" min={0} max={100} precision={2} value={pct === null ? null : Number(pct.toFixed(2))} onChange={setPercent} disabled={readOnly} style={{ width: '100%' }} />
            </div>
            <div>
              <label className="bill-field-label" htmlFor="q-amt">Discount amount</label>
              <InputNumber id="q-amt" aria-label="Discount amount" addonBefore="₹" min={0} precision={2} value={toRupees(totals.discount)} onChange={setAmount} disabled={readOnly} style={{ width: '100%' }} />
            </div>
          </div>
          <label className="bill-field-label" htmlFor="q-reason" style={{ marginTop: 'var(--s-3)' }}>Reason</label>
          <AutoComplete id="q-reason" aria-label="Discount reason" style={{ width: '100%' }} value={reason} onChange={setReason} options={masters.reasons.map((r) => ({ value: r }))} placeholder="Reason" />
          <Form form={form} layout="vertical" component={false}>
            <Form.Item name="notes" style={{ marginTop: 8, marginBottom: 0 }}>
              <Input.TextArea rows={2} placeholder="Notes for the quotation" aria-label="Notes" />
            </Form.Item>
          </Form>
        </div>
        <div className="bill-section">
          <div className="bill-sum">
            <span>Amount</span><b style={{ textAlign: 'right' }}>{formatINR(totals.gross)}</b>
            <span>Discount</span><b style={{ textAlign: 'right' }}>- {formatINR(totals.discount)}</b>
            <span className="bill-sum__net">Total</span><b className="bill-sum__net" style={{ textAlign: 'right' }}>{formatINR(totals.net)}</b>
          </div>
          <QuotationAttachments quotationId={editing?.id ?? null} pending={pendingFiles} onPending={setPendingFiles} readOnly={readOnly} />
        </div>
      </div>
      </FormSection>
    </Modal>
  )
}
