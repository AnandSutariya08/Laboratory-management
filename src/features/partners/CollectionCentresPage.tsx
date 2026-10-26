import { useMemo, useState } from 'react'
import { Drawer, Form, Input, InputNumber, Popconfirm, Select, Switch, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, ProfileOutlined } from '@ant-design/icons'
import { Button } from '../../design/Button'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { formatINR, toPaise } from '../../lib/money'
import { downloadCsv } from './lib/csv'
import { removeMaster, saveMaster, useMaster } from './lib/master'
import { usePartnerOrders, type Range } from './lib/orders'
import { PriceListDrawer } from './RateListEditor'
import type { CollectionCentre, Referrer } from './types'
import { ActiveChip, DataTable, Kpis, RangeField, Section, Spacer, thisMonth, Toolbar } from './ui'

const settlementOf = (c: CollectionCentre, net: number, bills: number) =>
  c.settlementType === 'sharePercent' ? Math.round((net * c.settlementValue) / 100) : c.settlementType === 'flatPerBill' ? Math.round(c.settlementValue * bills) : 0

export default function CollectionCentresPage() {
  const [tab, setTab] = useState<'list' | 'summary'>('list')
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Partial<CollectionCentre> | null>(null)
  const [pl, setPl] = useState<CollectionCentre | null>(null)
  const [range, setRange] = useState<Range>(thisMonth())
  const centres = useMaster<CollectionCentre>('collectionCentres')
  const orders = usePartnerOrders(range)

  const rows = centres.data.filter((c) => !q.trim() || `${c.name} ${c.code} ${c.city} ${c.phone}`.toLowerCase().includes(q.toLowerCase()))
  const summary = useMemo(
    () =>
      centres.data.map((c) => {
        const mine = orders.data.filter((o) => o.collectionCentreId === c.id)
        const net = mine.reduce((s, o) => s + o.net, 0)
        return { id: c.id, c, bills: mine.length, gross: mine.reduce((s, o) => s + o.gross, 0), discount: mine.reduce((s, o) => s + o.discount, 0), net, paid: mine.reduce((s, o) => s + o.paid, 0), due: mine.reduce((s, o) => s + o.due, 0), settle: settlementOf(c, net, mine.length) }
      }),
    [centres.data, orders.data],
  )

  return (
    <div>
      <PageHeader title="Collection Centres" subtitle="Franchise and collection points with their price lists and settlement"
        actions={<Button variant="primary" icon={<PlusOutlined />} onClick={() => setEdit({ active: true, settlementType: 'none', settlementValue: 0, settlementDays: 30, referrals: 'all', qrWidth: 120, qrHeight: 120 })}>Add centre</Button>} />
      <div className="pt-tabs">
        <Segmented aria-label="Collection centre view" value={tab} onChange={setTab} options={[{ value: 'list', label: 'Centres', count: centres.data.length }, { value: 'summary', label: 'Billing summary' }]} />
      </div>
      {tab === 'list' ? (
        <DataTable<CollectionCentre>
          loading={centres.loading}
          dataSource={rows}
          emptyTitle="No collection centres yet"
          toolbar={
            <Toolbar>
              <Input.Search allowClear aria-label="Search centres" placeholder="Search name, code, city" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
              <Spacer />
              <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('collection-centres', [['name', 'code', 'phone', 'email', 'city', 'active'], ...rows.map((c) => [c.name, c.code, c.phone, c.email, c.city, c.active])])}>Export CSV</Button>
            </Toolbar>
          }
          columns={[
            { title: 'Centre', render: (_, c) => <span>{c.name} <span className="pt-muted">{c.code}</span></span> },
            { title: 'Contact', render: (_, c) => <span>{c.phone}<br /><span className="pt-muted">{c.email}</span></span> },
            { title: 'City', dataIndex: 'city' },
            { title: 'Settlement', render: (_, c) => (c.settlementType === 'sharePercent' ? `${c.settlementValue}% share` : c.settlementType === 'flatPerBill' ? `${formatINR(c.settlementValue)} / bill` : 'None') },
            { title: 'Status', render: (_, c) => <ActiveChip active={c.active} /> },
            { title: 'Active', render: (_, c) => <Switch size="small" aria-label={`Active: ${c.name}`} checked={c.active} onChange={(v) => saveMaster('collectionCentres', c.id, { active: v })} /> },
            {
              title: 'Actions',
              render: (_, c) => (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  <Button variant="text" icon={<EditOutlined />} aria-label={`Edit ${c.name}`} onClick={() => setEdit(c)} />
                  <Button variant="text" icon={<ProfileOutlined />} aria-label={`Price list for ${c.name}`} onClick={() => setPl(c)} />
                  <Popconfirm title={`Delete ${c.name}?`} okText="Delete" onConfirm={() => removeMaster('collectionCentres', c.id).catch((e) => message.error(e.message))}>
                    <Button variant="text" icon={<DeleteOutlined />} aria-label={`Delete ${c.name}`} />
                  </Popconfirm>
                </span>
              ),
            },
          ]}
        />
      ) : (
        <>
          <Kpis items={[
            { label: 'Bills', value: summary.reduce((s, r) => s + r.bills, 0) },
            { label: 'Net billed', value: formatINR(summary.reduce((s, r) => s + r.net, 0)) },
            { label: 'Due', value: formatINR(summary.reduce((s, r) => s + r.due, 0)) },
            { label: 'Settlement payable', value: formatINR(summary.reduce((s, r) => s + r.settle, 0)) },
          ]} />
          <DataTable<(typeof summary)[number]>
            loading={centres.loading || orders.loading}
            dataSource={summary}
            emptyTitle="No collection centres yet"
            toolbar={
              <Toolbar>
                <RangeField value={range} onChange={setRange} />
                <Spacer />
                <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('centre-billing-summary', [['centre', 'bills', 'gross', 'discount', 'net', 'paid', 'due', 'settlement'], ...summary.map((r) => [r.c.name, r.bills, r.gross / 100, r.discount / 100, r.net / 100, r.paid / 100, r.due / 100, r.settle / 100])])}>Export CSV</Button>
              </Toolbar>
            }
            columns={[
              { title: 'Centre', render: (_, r) => r.c.name },
              { title: 'Bills', align: 'right', render: (_, r) => <span className="pt-num">{r.bills}</span> },
              { title: 'Gross', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.gross)}</span> },
              { title: 'Discount', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.discount)}</span> },
              { title: 'Net', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.net)}</span> },
              { title: 'Paid', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.paid)}</span> },
              { title: 'Due', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.due)}</span> },
              { title: 'Settlement', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.settle)}</span> },
            ]}
          />
        </>
      )}
      <CentreDrawer value={edit} onClose={() => setEdit(null)} />
      <PriceListDrawer open={!!pl} onClose={() => setPl(null)} owner={pl && { collection: 'collectionCentres', id: pl.id, name: pl.name, rateListId: pl.rateListId, kind: 'collectionCentre' }} />
    </div>
  )
}

function CentreDrawer({ value, onClose }: { value: Partial<CollectionCentre> | null; onClose: () => void }) {
  const refs = useMaster<Referrer>('referrers')
  const [form] = Form.useForm()
  const st = Form.useWatch('settlementType', form)
  const submit = async () => {
    const v = await form.validateFields()
    try {
      await saveMaster('collectionCentres', value?.id ?? null, { ...v, settlementValue: v.settlementType === 'flatPerBill' ? toPaise(v.settlementValue ?? 0) : v.settlementType === 'none' ? 0 : (v.settlementValue ?? 0), rateListId: value?.rateListId ?? '' })
      message.success('Saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Drawer open={!!value} onClose={onClose} size="large" destroyOnHidden title={value?.id ? 'Edit collection centre' : 'Add collection centre'}
      footer={<div className="pt-sticky-foot"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save</Button></div>}>
      <Form form={form} layout="vertical" initialValues={{ ...value, settlementValue: value?.settlementType === 'flatPerBill' ? (value.settlementValue ?? 0) / 100 : value?.settlementValue }}>
        <Section title="Centre details">
          <div className="pt-grid2">
            <Form.Item name="name" label="Centre name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="code" label="Centre code"><Input /></Form.Item>
            <Form.Item name="city" label="City"><Input /></Form.Item>
            <Form.Item name="phone" label="Phone"><Input /></Form.Item>
            <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input /></Form.Item>
            <Form.Item name="loginEmail" label="Login email (centre portal)" rules={[{ type: 'email' }]}><Input /></Form.Item>
          </div>
          <Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="active" label="Active" valuePropName="checked"><Switch /></Form.Item>
        </Section>
        <Section title="Settlement terms">
          <div className="pt-grid3">
            <Form.Item name="settlementType" label="Settlement"><Select options={[{ value: 'none', label: 'None' }, { value: 'sharePercent', label: 'Centre share % of net' }, { value: 'flatPerBill', label: 'Flat per bill' }]} /></Form.Item>
            {st !== 'none' && <Form.Item name="settlementValue" label={st === 'flatPerBill' ? 'Per bill (Rs)' : 'Share (%)'}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>}
            <Form.Item name="settlementDays" label="Settle every (days)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          </div>
        </Section>
        <Section title="Permissions and bill settings">
          <div className="pt-grid3">
            <Form.Item name="dueReportView" label="View / download due reports" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="allowBillDelete" label="Allow bill delete" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="referrals" label="Referral doctors"><Select options={[{ value: 'all', label: 'All' }, { value: 'selected', label: 'Selected only' }]} /></Form.Item>
            <Form.Item noStyle shouldUpdate={(a, b) => a.referrals !== b.referrals}>
              {({ getFieldValue }) => getFieldValue('referrals') === 'selected' && (
                <Form.Item name="referrerIds" label="Allowed referrers">
                  <Select mode="multiple" showSearch optionFilterProp="label" options={refs.data.filter((r) => !r.mergedInto).map((r) => ({ value: r.id, label: r.name }))} />
                </Form.Item>
              )}
            </Form.Item>
            <Form.Item name="upiId" label="UPI ID"><Input /></Form.Item>
            <Form.Item name="qrWidth" label="QR width (px)"><InputNumber min={40} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="qrHeight" label="QR height (px)"><InputNumber min={40} style={{ width: '100%' }} /></Form.Item>
          </div>
        </Section>
      </Form>
    </Drawer>
  )
}
