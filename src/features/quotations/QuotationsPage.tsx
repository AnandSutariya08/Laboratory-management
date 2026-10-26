import { useMemo, useState } from 'react'
import { App, Checkbox, DatePicker, Dropdown, Input, Modal, Radio, Table, InputNumber, Select, Form } from 'antd'
import { EllipsisOutlined, FileTextOutlined, PlusOutlined, PrinterOutlined, SettingOutlined } from '@ant-design/icons'
import { query, serverTimestamp, setDoc, Timestamp, updateDoc, type DocumentData } from 'firebase/firestore'
import dayjs, { type Dayjs } from 'dayjs'
import { can, useAuth } from '../../auth/AuthProvider'
import BillingModal from '../../components/billing/BillingModal'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { SkeletonRows } from '../../design/Skeletons'
import { StatusChip, type StatusVariant } from '../../design/StatusChip'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { useBranchScope } from '../../lib/branchScope'
import { col, docRef, labDoc } from '../../lib/db'
import { formatINR } from '../../lib/money'
import { createPatient } from '../../lib/orders'
import { ageInDays, salutationFor } from '../../lib/results'
import { esc, printHtml } from '../partners/lib/print'
import { preCollectionGuidelines } from '../../pages/catalogue/flags'
import type { AgeUnit, Gender, Patient, QuotationSettings } from '../../types'
import QuotationModal from './QuotationModal'
import { duplicateQuotation } from './lib'
import { sendQuotation } from '../../lib/messaging'
import { effectiveStatus, STATUS_LABEL, type Quotation, type QuotationStatus } from './types'
import '../../components/billing/billing.css'

const VARIANT: Record<QuotationStatus, StatusVariant> = {
  draft: 'neutral', sent: 'info', accepted: 'success', expired: 'caution', converted: 'success', cancelled: 'urgent',
}
type Filter = 'all' | QuotationStatus

export default function QuotationsPage() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const cat = useCatalogueMaps()
  const manage = can(profile, 'quotation.manage')
  const [layoutOpen, setLayoutOpen] = useState(false)
  const { constraints, key } = useBranchScope()
  const q = useMemo(() => query(col<DocumentData>('quotations'), ...constraints), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const { data, loading } = useLiveQuery<Quotation>(q, [key])
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<Quotation | null>(null)
  const [dates, setDates] = useState<[Dayjs, Dayjs] | null>(null)
  const [convert, setConvert] = useState<Quotation | null>(null)
  const [billing, setBilling] = useState<{ q: Quotation; patient: Patient } | null>(null)

  const rows = useMemo(
    () =>
      data
        .map((x) => ({ ...x, eff: effectiveStatus(x) }))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)),
    [data],
  )
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length }
    for (const r of rows) c[r.eff] = (c[r.eff] ?? 0) + 1
    return c
  }, [rows])
  const shown = rows.filter((r) => {
    if (filter !== 'all' && r.eff !== filter) return false
    if (dates) {
      const d = dayjs(r.createdAt?.toDate?.() ?? new Date())
      if (d.isBefore(dates[0].startOf('day')) || d.isAfter(dates[1].endOf('day'))) return false
    }
    const s = search.trim().toLowerCase()
    return !s || `${r.quoNo} ${r.prospect.name} ${r.prospect.phone} ${r.patientNo}`.toLowerCase().includes(s)
  })

  const setStatus = async (r: Quotation, status: QuotationStatus) => {
    try {
      await updateDoc(docRef('quotations', r.id), { status, updatedAt: serverTimestamp() })
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // Printing or sending a Draft marks it Sent.
  const markSentIfDraft = (r: Quotation) => {
    if (r.status === 'draft') void setStatus(r, 'sent')
  }

  const send = async (r: Quotation, via: 'whatsapp' | 'email' | 'sms') => {
    try {
      const { results } = await sendQuotation(r.id, [via])
      const res = results[0]
      if (!res || res.status === 'failed') message.error(`Could not send: ${res?.error ?? 'unknown error'}`)
      else if (res.status === 'logged') message.info(`No ${via === 'sms' ? 'SMS' : via === 'email' ? 'email' : 'WhatsApp'} provider is set up yet, so the message was saved to the outbox.`)
      else message.success(`Quotation sent to ${res.to}`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const duplicate = async (r: Quotation) => {
    if (!profile) return
    try {
      await duplicateQuotation(r, settings, profile)
      message.success('Duplicated as a new draft')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // Expired -> Draft again, with a fresh validity window.
  const reopen = async (r: Quotation) => {
    try {
      await updateDoc(docRef('quotations', r.id), {
        status: 'draft',
        validUntil: Timestamp.fromDate(dayjs().add(settings.quotation.validityDays, 'day').endOf('day').toDate()),
        updatedAt: serverTimestamp(),
      })
      message.success('Reopened as draft')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const print = (r: Quotation) => {
    markSentIfDraft(r)
    const ql = settings.quotation
    const sampleOf = (testIds: string[]) => [...new Set(testIds.map((t) => cat.sampleTypeById.get(cat.testById.get(t)?.sampleTypeId ?? '')?.name).filter(Boolean))].join(', ')
    const compact = ql.template === 'compact'
    const rows = r.items.map((i, n) => {
      const members = ql.showPackageContents && i.kind === 'package' ? `<div class="muted" style="font-size:11px">${esc(i.testIds.map((t) => cat.testById.get(t)?.name ?? t).join(', '))}</div>` : ''
      return `<tr><td>${n + 1}</td>${ql.showTestCode ? `<td>${esc(i.isCharge ? '' : i.code)}</td>` : ''}<td>${esc(i.name)}${members}</td>${ql.showSampleColumn ? `<td>${esc(i.isCharge ? '' : sampleOf(i.testIds))}</td>` : ''}<td class="n">${formatINR(i.price)}</td></tr>`
    }).join('')
    const guides = preCollectionGuidelines(r.items.filter((i) => !i.isCharge).flatMap((i) => i.testIds.map((t) => cat.testById.get(t))))
    const extraCols = (ql.showTestCode ? 1 : 0) + (ql.showSampleColumn ? 1 : 0) + 1
    printHtml(
      `Quotation ${r.quoNo}`,
      `<style>@page{margin:${ql.marginMm ?? 12}mm}${compact ? 'body{font-size:11px;margin:12px}th,td{padding:3px 6px}' : ''}</style>
       <h1>${esc(settings.name)}</h1><div class="muted">${esc(settings.address)} ${esc(settings.phone)}</div>
       ${settings.quotation.header ? `<p>${esc(settings.quotation.header)}</p>` : ''}
       <h2>Quotation ${esc(r.quoNo)}</h2>
       <div class="meta"><div><b>${esc(r.prospect.name)}</b><br>${esc(r.prospect.phone)}</div>
       <div>Date ${dayjs(r.createdAt?.toDate?.() ?? new Date()).format('DD-MM-YYYY')}<br>Valid until ${dayjs(r.validUntil?.toDate?.()).format('DD-MM-YYYY')}</div></div>
       <table><tr><th>Sr</th>${ql.showTestCode ? '<th>Code</th>' : ''}<th>Test / Package</th>${ql.showSampleColumn ? '<th>Sample</th>' : ''}<th class="n">Price</th></tr>${rows}
       <tr><td colspan="${extraCols}" class="n">Amount</td><td class="n">${formatINR(r.gross)}</td></tr>
       <tr><td colspan="${extraCols}" class="n">Discount</td><td class="n">${formatINR(r.discount)}</td></tr>
       <tr><td colspan="${extraCols}" class="n"><b>Total</b></td><td class="n"><b>${formatINR(r.net)}</b></td></tr></table>
       ${guides.length ? `<p><b>Before your sample collection</b></p><ul>${guides.map((g) => `<li>${esc(g.name)}: ${esc(g.text)}</li>`).join('')}</ul>` : ''}
       ${r.notes ? `<p>${esc(r.notes)}</p>` : ''}
       <p class="muted" style="white-space:pre-line">${esc(settings.quotation.terms)}</p>
       ${ql.showSignature ? `<p style="margin-top:48px">______________________<br>${esc(ql.signatureName || 'Authorised signatory')}</p>` : ''}
       ${ql.footer ? `<p class="muted" style="margin-top:24px;white-space:pre-line;text-align:center">${esc(ql.footer)}</p>` : ''}`,
    )
  }

  return (
    <div>
      <PageHeader
        title="Quotations"
        subtitle="Create, track and convert quotations into bills."
        actions={
          <>
            {manage && <Button icon={<SettingOutlined />} onClick={() => setLayoutOpen(true)}>Print layout</Button>}
            {manage && <Button variant="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>New quotation</Button>}
          </>
        }
      />
      <div style={{ marginBottom: 'var(--s-4)', display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap', alignItems: 'center' }}>
        <Segmented<Filter>
          aria-label="Quotation status"
          value={filter}
          onChange={setFilter}
          options={(['all', 'draft', 'sent', 'accepted', 'expired', 'converted', 'cancelled'] as Filter[]).map((v) => ({
            value: v, label: v === 'all' ? 'All' : STATUS_LABEL[v], count: counts[v] ?? 0,
          }))}
        />
        <DatePicker.RangePicker aria-label="Created between" value={dates} onChange={(v) => setDates(v?.[0] && v[1] ? [v[0], v[1]] : null)} />
        <Input.Search allowClear aria-label="Search quotations" placeholder="Search number, name, phone" style={{ maxWidth: 320 }} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Card padding={0}>
        {loading ? (
          <SkeletonRows rows={6} columns={6} />
        ) : shown.length === 0 ? (
          <EmptyState icon={<FileTextOutlined />} title="No quotations" description="Create a quotation to share prices with a prospect before registering them." action={manage ? <Button onClick={() => setCreating(true)}>New quotation</Button> : undefined} />
        ) : (
          <Table
            size="small"
            rowKey="id"
            dataSource={shown}
            pagination={{ pageSize: 25, hideOnSinglePage: true }}
            columns={[
              { title: 'Quotation', dataIndex: 'quoNo' },
              { title: 'Date', render: (_, r) => dayjs(r.createdAt?.toDate?.() ?? new Date()).format('DD MMM YYYY') },
              { title: 'Prospect', render: (_, r) => (<>{r.prospect.name}{r.patientNo ? <span className="bill-muted"> · {r.patientNo}</span> : null}</>) },
              { title: 'Phone', render: (_, r) => r.prospect.phone || '-' },
              { title: 'Items', render: (_, r) => r.items.length },
              { title: 'Total', align: 'right', render: (_, r) => formatINR(r.net) },
              { title: 'Valid until', render: (_, r) => dayjs(r.validUntil?.toDate?.()).format('DD MMM YYYY') },
              { title: 'Created by', dataIndex: 'createdByName', render: (v: string) => v || '-' },
              { title: 'Status', render: (_, r) => <StatusChip variant={VARIANT[r.eff]}>{STATUS_LABEL[r.eff]}</StatusChip> },
              {
                title: 'Actions', width: 230,
                render: (_, r) => {
                  const open = r.eff !== 'converted' && r.eff !== 'cancelled'
                  const cancellable = r.status === 'draft' || r.status === 'sent'
                  return (
                    <div className="bill-row" style={{ marginTop: 0 }}>
                      <Button aria-label={`Print ${r.quoNo}`} icon={<PrinterOutlined />} onClick={() => print(r)} />
                      {open && manage && <Button onClick={() => setConvert(r)}>Convert to bill</Button>}
                      <Dropdown
                        trigger={['click']}
                        menu={{
                          items: [
                            { key: 'view', label: manage && (r.eff === 'draft' || r.eff === 'sent') ? 'View / edit' : 'View' },
                            ...(manage ? [
                              { key: 'wa', label: 'Send by WhatsApp', disabled: !open },
                              { key: 'mail', label: 'Send by email', disabled: !open },
                              { key: 'sms', label: 'Send by SMS', disabled: !open },
                              { key: 'dup', label: 'Duplicate' },
                              ...(r.eff === 'expired' ? [{ key: 'reopen', label: 'Reopen with new validity' }] : []),
                              { key: 'sent', label: 'Mark as sent', disabled: !open },
                              { key: 'accepted', label: 'Mark as accepted', disabled: !open },
                              { key: 'cancelled', label: 'Cancel quotation', danger: true, disabled: !cancellable },
                            ] : []),
                          ],
                          onClick: ({ key: k }) => {
                            if (k === 'view') setViewing(r)
                            else if (k === 'wa') send(r, 'whatsapp')
                            else if (k === 'mail') send(r, 'email')
                            else if (k === 'sms') send(r, 'sms')
                            else if (k === 'dup') void duplicate(r)
                            else if (k === 'reopen') void reopen(r)
                            else void setStatus(r, k as QuotationStatus)
                          },
                        }}
                      >
                        <Button aria-label={`More actions for ${r.quoNo}`} icon={<EllipsisOutlined />} />
                      </Dropdown>
                    </div>
                  )
                },
              },
            ]}
          />
        )}
      </Card>

      <QuotationModal open={creating} onClose={() => setCreating(false)} />
      <LayoutModal open={layoutOpen} onClose={() => setLayoutOpen(false)} value={settings.quotation} />
      {viewing && <QuotationModal open editing={viewing} onClose={() => setViewing(null)} />}
      <ConvertDialog
        quotation={convert}
        onClose={() => setConvert(null)}
        onReady={(r, patient) => { setConvert(null); setBilling({ q: r, patient }) }}
        uhidAuto={settings.registration.uhidMode === 'auto'}
      />
      {billing && (
        <BillingModal
          open
          patient={billing.patient}
          initialItems={billing.q.items.map((i) => ({ ...i, status: 'pending' }))}
          initialDiscount={{ reason: billing.q.discountReason }}
          quotedNet={billing.q.net}
          initialNote={billing.q.notes}
          context={{ ...billing.q.partners }}
          quotationId={billing.q.id}
          onClose={() => setBilling(null)}
          onSaved={async (orderId) => {
            const r = billing.q
            setBilling(null)
            if (profile) {
              try { await updateDoc(docRef('quotations', r.id), { status: 'converted', orderId, patientId: billing.patient.id, patientNo: billing.patient.patientNo }) }
              catch (e) { message.error((e as Error).message) }
            }
          }}
        />
      )}
    </div>
  )
}

// Converting needs a registered patient: create one from the prospect (confirming gender and age) if needed.
function ConvertDialog({
  quotation, onClose, onReady, uhidAuto,
}: { quotation: Quotation | null; onClose: () => void; onReady: (q: Quotation, p: Patient) => void; uhidAuto: boolean }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const { data: linked } = useLiveDoc<Patient>(quotation?.patientId ? docRef<Patient>('patients', quotation.patientId) : null, [quotation?.patientId])

  const go = async () => {
    if (!quotation) return
    setBusy(true)
    try {
      if (quotation.patientId) {
        const p = linked
        if (!p) throw new Error('Registered patient not found')
        return onReady(quotation, p)
      }
      const v = await form.validateFields()
      const parts = quotation.prospect.name.trim().split(/\s+/)
      const gender = v.gender as Gender
      const patient = await createPatient(
        {
          salutation: salutationFor(gender, ageInDays(v.ageValue, v.ageUnit)),
          firstName: parts[0] ?? '', lastName: parts.slice(1).join(' '),
          gender, ageValue: v.ageValue, ageUnit: v.ageUnit as AgeUnit,
          phone: quotation.prospect.phone, email: quotation.prospect.email,
          dispatchModes: ['hardcopy'], referrerName: '',
          referrerId: quotation.partners.referrerId, hospitalId: quotation.partners.hospitalId,
        },
        { autoUhid: uhidAuto },
      )
      onReady(quotation, patient)
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pr = quotation?.prospect
  return (
    <Modal
      open={!!quotation}
      onCancel={onClose}
      destroyOnHidden
      title={`Convert ${quotation?.quoNo ?? ''} to bill`}
      footer={<div className="bill-actions"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={go}>Continue to billing</Button></div>}
    >
      {quotation?.patientId ? (
        <p>Registered patient {quotation.patientNo}. Prices are refreshed from the current catalogue and rate lists on the billing screen.</p>
      ) : (
        <>
          <p>{pr?.name} is not registered yet. Confirm details to register them, then continue to billing (items are re-priced).</p>
          <Form form={form} layout="vertical" initialValues={{ gender: pr?.gender || undefined, ageValue: pr?.ageValue ?? undefined, ageUnit: pr?.ageUnit ?? 'year' }}>
            <Form.Item name="gender" label="Gender" rules={[{ required: true, message: 'Select gender' }]}>
              <Radio.Group options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} />
            </Form.Item>
            <div className="bill-row">
              <Form.Item name="ageValue" label="Age" rules={[{ required: true, message: 'Age is required' }]}><InputNumber min={0} max={150} precision={0} /></Form.Item>
              <Form.Item name="ageUnit" label=" "><Select style={{ width: 110 }} options={[{ value: 'year', label: 'Years' }, { value: 'month', label: 'Months' }, { value: 'day', label: 'Days' }]} /></Form.Item>
            </div>
          </Form>
        </>
      )}
    </Modal>
  )
}

// Quotation print layout and lab profile text (kept in settings.quotation on the lab document).
function LayoutModal({ open, onClose, value }: { open: boolean; onClose: () => void; value: QuotationSettings }) {
  const { message } = App.useApp()
  const [v, setV] = useState<QuotationSettings>(value)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof QuotationSettings>(k: K, x: QuotationSettings[K]) => setV((p) => ({ ...p, [k]: x }))
  return (
    <Modal
      open={open}
      title="Quotation print layout"
      okText="Save"
      confirmLoading={saving}
      destroyOnHidden
      afterOpenChange={(o) => { if (o) setV(value) }}
      onCancel={onClose}
      onOk={async () => {
        setSaving(true)
        try {
          await setDoc(labDoc(), { quotation: v }, { merge: true })
          message.success('Layout saved')
          onClose()
        } catch (e) {
          message.error((e as Error).message)
        } finally {
          setSaving(false)
        }
      }}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <label>Header text<Input.TextArea rows={2} value={v.header} onChange={(e) => set('header', e.target.value)} /></label>
        <label>Terms<Input.TextArea rows={3} value={v.terms} onChange={(e) => set('terms', e.target.value)} /></label>
        <label>Footer<Input.TextArea rows={2} value={v.footer ?? ''} onChange={(e) => set('footer', e.target.value)} /></label>
        <div className="bill-row">
          <label>Page margin (mm) <InputNumber min={0} max={40} value={v.marginMm ?? 12} onChange={(n) => set('marginMm', n ?? 12)} /></label>
          <label>Template <Select style={{ width: 140 }} value={v.template ?? 'standard'} onChange={(t) => set('template', t)} options={[{ value: 'standard', label: 'Standard' }, { value: 'compact', label: 'Compact' }]} /></label>
        </div>
        <Checkbox checked={!!v.showPackageContents} onChange={(e) => set('showPackageContents', e.target.checked)}>Show package contents</Checkbox>
        <Checkbox checked={!!v.showTestCode} onChange={(e) => set('showTestCode', e.target.checked)}>Show test code column</Checkbox>
        <Checkbox checked={!!v.showSampleColumn} onChange={(e) => set('showSampleColumn', e.target.checked)}>Show sample column</Checkbox>
        <Checkbox checked={!!v.showSignature} onChange={(e) => set('showSignature', e.target.checked)}>Show signature line</Checkbox>
        {v.showSignature && <Input aria-label="Signatory name" placeholder="Signatory name" value={v.signatureName ?? ''} onChange={(e) => set('signatureName', e.target.value)} />}
      </div>
    </Modal>
  )
}
