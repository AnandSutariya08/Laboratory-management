import { lazy, Suspense, useMemo, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Alert, App as AntApp, DatePicker, Form, Input, InputNumber, Modal, Result, Select, Spin, Table } from 'antd'
import { addDoc, serverTimestamp } from 'firebase/firestore'
import { col } from '../../lib/db'
import dayjs, { type Dayjs } from 'dayjs'
import { can, useAuth } from '../../auth/AuthProvider'
import { ClearDueView, DispatchView, FinancialView, BillActions } from './PortalExtras'
import PayOnlineButton from '../../components/billing/PayOnlineButton'
import { PaymentStatusChip } from '../../components/billing/PaymentStatusChip'
import { tatDue } from '../patient/lib'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { Button } from '../../design/Button'
import { PageHeader } from '../../design/PageHeader'
import { StatusChip } from '../../design/StatusChip'
import { formatINR, toPaise } from '../../lib/money'
import { catalogueLine, computeTotals } from '../../lib/billing'
import { createOrder, createPatient } from '../../lib/orders'
import { fmtDate } from '../../components/results/common'
import { StatTile, TileGrid, Panel } from '../qc/ui'
import { buildLedger, centreBalance, checkFunds, canB2B, creditTypeLabel, effectiveTxns } from '../partners/lib/b2b'
import { commissionForReferrer, orderMatchesReferrer } from '../partners/lib/commission'
import { resolvePrice } from '../partners/lib/pricing'
import { downloadCsv } from '../partners/lib/csv'
import { esc, printHtml } from '../partners/lib/print'
import type { B2BCentre, CollectionCentre, PartnerInvoice, PartnerOrder, Referrer } from '../partners/types'
import { PORTAL_ROLE_TITLE, usePortal } from './usePortal'
import { ViewAsBanner } from '../settings/ViewAs'
import './portal.css'

const ReportPage = lazy(() => import('../../pages/report/ReportPage'))

const STATUS_VARIANT = { pending: 'caution', partial: 'info', provisional: 'info', final: 'success' } as const
const reportable = (o: PartnerOrder) => o.reportStatus !== 'pending'

// Reduced shell for external partner roles (b2b, collectionCentre, corporate, referrer). Only the
// partner's own bills, reports, statements and wallet; register/bill when the partner's flags allow.
export default function PortalApp() {
  const { profile, logout } = useAuth()
  const p = usePortal()
  const settings = useLabSettings()
  const tabs = [
    { to: '/portal/bills', label: 'Bills & reports', show: true },
    { to: '/portal/new', label: 'New bill', show: p.canBill },
    { to: '/portal/wallet', label: 'Wallet', show: p.role === 'b2b' },
    { to: '/portal/clear-due', label: 'Clear due', show: can(profile, 'portal.clearDue') },
    { to: '/portal/financials', label: 'Financial analysis', show: can(profile, 'portal.financials') },
    { to: '/portal/dispatch', label: 'Dispatch', show: p.role === 'collectionCentre' && can(profile, 'portal.dispatch') },
    { to: '/portal/statements', label: 'Statements', show: true },
  ].filter((t) => t.show)

  return (
    <div className="portal">
      <ViewAsBanner />
      <header className="portal__bar">
        <div className="portal__brand">
          <strong>{settings.name}</strong>
          <span>{PORTAL_ROLE_TITLE[p.role] ?? 'Partner'}: {p.partner?.name ?? '...'} · {profile?.name}</span>
        </div>
        <nav className="portal__nav" aria-label="Portal sections">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? 'active' : '')}>{t.label}</NavLink>
          ))}
        </nav>
        <Button onClick={() => void logout()} aria-label="Log out">Log out</Button>
      </header>
      <main className="portal__main" id="portal-main">
        {/* Support view is read-only: a disabled fieldset turns off every button and field on the page. */}
        <fieldset disabled={!!profile?.viewOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
        <Suspense fallback={<Spin />}>
          {!p.partnerId ? (
            <Result status="warning" title="Portal account not linked" subTitle="Ask the lab to link your login to your organisation." />
          ) : p.partner && p.partner.active === false ? (
            <Result status="warning" title="Account inactive" subTitle="This organisation is switched off. Contact the lab." />
          ) : (
            <Routes>
              <Route path="/report/:orderId" element={<ReportPage />} />
              <Route path="/portal/bills" element={<BillsView />} />
              <Route path="/portal/new" element={p.canBill ? <NewBill /> : <Result status="403" title="Billing is switched off for your account" />} />
              <Route path="/portal/wallet" element={p.role === 'b2b' ? <WalletView /> : <Navigate to="/portal/bills" replace />} />
 <Route path="/portal/clear-due" element={<ClearDueView />} />
              <Route path="/portal/financials" element={<FinancialView />} />
              <Route path="/portal/dispatch" element={p.role === 'collectionCentre' ? <DispatchView /> : <Navigate to="/portal/bills" replace />} />
              <Route path="/portal/statements" element={<StatementsView />} />
              <Route path="*" element={<Navigate to="/portal/bills" replace />} />
            </Routes>
          )}
        </Suspense>
        </fieldset>
      </main>
    </div>
  )
}

// ---- Bills & reports --------------------------------------------------------------------------

function BillsView() {
  const p = usePortal()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<string>('all')
  const hidePrice = p.role === 'b2b' && !canB2B(p.flags, 'showPriceColumn')
  const rows = useMemo(
    () =>
      p.orders.filter(
        (o) =>
          (status === 'all' || o.reportStatus === status) &&
          `${o.billNo} ${o.patientName} ${o.items.map((i) => i.name).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [p.orders, q, status],
  )
  const tot = useMemo(() => ({ bills: p.orders.length, net: p.orders.reduce((s, o) => s + o.net, 0), due: p.orders.reduce((s, o) => s + Math.max(0, o.due), 0), ready: p.orders.filter((o) => o.reportStatus === 'final').length }), [p.orders])
  const showTiles = p.role !== 'b2b' || canB2B(p.flags, 'dashboard')
  const ccDueBlocked = (o: PartnerOrder) => p.role === 'collectionCentre' && o.due > 0 && !(p.partner as CollectionCentre | null)?.dueReportView
  const showTat = p.role === 'b2b' && canB2B(p.flags, 'showTat')
  const manualWa = p.role === 'b2b' && canB2B(p.flags, 'manualWhatsapp')
  const reportBlocked = (o: PartnerOrder) => ccDueBlocked(o) || p.role === 'b2b' && o.due > 0 && !canB2B(p.flags, 'downloadReportBelowLimit') && (p.flags && centreBal(p).net < 0)

  return (
    <>
      <PageHeader title="Bills & reports" subtitle="Bills raised for your organisation and their report status." />
      {showTiles && (
        <TileGrid>
          <StatTile label="Bills" value={tot.bills} />
          {!hidePrice && <StatTile label="Billed" value={formatINR(tot.net)} />}
          {!hidePrice && <StatTile label="Due" value={formatINR(tot.due)} tone={tot.due > 0 ? 'caution' : undefined} />}
          <StatTile label="Reports ready" value={tot.ready} tone="success" />
        </TileGrid>
      )}
      <div className="portal__row">
        <Input.Search aria-label="Search bills" placeholder="Search bill, patient or test" allowClear style={{ maxWidth: 320 }} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Report status" style={{ width: 170 }} value={status} onChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, { value: 'pending', label: 'Pending' }, { value: 'partial', label: 'Partial' }, { value: 'provisional', label: 'Provisional' }, { value: 'final', label: 'Final' }]} />
      </div>
      <Table<PartnerOrder>
        rowKey="id"
        size="middle"
        loading={p.loading}
        dataSource={rows}
        pagination={{ pageSize: 25, hideOnSinglePage: true }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: 'Bill', dataIndex: 'billNo' },
          { title: 'Date', render: (_: unknown, o) => fmtDate(o.billDate ?? o.createdAt) },
          { title: 'Patient', dataIndex: 'patientName' },
          { title: 'Tests', render: (_: unknown, o) => o.items.filter((i) => i.status !== 'refunded').map((i) => i.name).join(', ') },
          ...(hidePrice ? [] : [
            { title: 'Net', align: 'right' as const, render: (_: unknown, o: PartnerOrder) => formatINR(o.net) },
            { title: 'Due', align: 'right' as const, render: (_: unknown, o: PartnerOrder) => formatINR(Math.max(0, o.due)) },
          ]),
          ...(hidePrice ? [] : [{ title: 'Payment', render: (_: unknown, o: PartnerOrder) => <PaymentStatusChip order={o} /> }]),
          ...(showTat ? [{ title: 'TAT', render: (_: unknown, o: PartnerOrder) => tatDue(o)?.text ?? '-' }] : []),
          { title: 'Report', render: (_: unknown, o) => <StatusChip variant={STATUS_VARIANT[o.reportStatus] ?? 'neutral'}>{o.reportStatus}</StatusChip> },
          { title: 'Actions', render: (_: unknown, o) => <BillActions o={o} /> },
          {
            title: '', render: (_: unknown, o) =>
              reportable(o) && p.canPrint && !reportBlocked(o) ? (
                <span style={{ display: 'inline-flex', gap: 8 }}>
                  <a href={`/report/${o.id}`} target="_blank" rel="noreferrer" aria-label={`Open report for ${o.patientName}`}>Report</a>
                  {manualWa && <a href={`https://wa.me/?text=${encodeURIComponent(`Report for ${o.patientName} (${o.billNo}): ${window.location.origin}/report/${o.id}`)}`} target="_blank" rel="noreferrer">WhatsApp</a>}
                </span>
              ) : reportable(o) ? <span className="portal__note">{reportBlocked(o) ? (ccDueBlocked(o) ? 'Dues must be cleared' : 'Clear dues to download') : 'Printing locked'}</span> : null,
          },
        ]}
      />
    </>
  )
}

function centreBal(p: ReturnType<typeof usePortal>) {
  return centreBalance(p.partner as B2BCentre, p.orders, p.txns, p.notes)
}

// ---- New bill ---------------------------------------------------------------------------------

interface NewBillForm { firstName: string; lastName: string; gender: 'male' | 'female' | 'other'; ageValue: number; ageUnit: 'year' | 'month' | 'day'; phone: string; email?: string; referrer?: string; items: string[] }

function NewBill() {
  const { message } = AntApp.useApp()
  const { profile } = useAuth()
  const p = usePortal()
  const settings = useLabSettings()
  const maps = useCatalogueMaps()
  const [form] = Form.useForm<NewBillForm>()
  const [saving, setSaving] = useState(false)
  const picked = (Form.useWatch('items', form) as string[] | undefined) ?? []

  const options = useMemo(() => {
    const lists = [p.rateList]
    const t = maps.tests.filter((x) => !x.disabled).map((x) => ({ value: `test:${x.id}`, label: `${x.name} (${x.code})`, price: resolvePrice(x.id, x.price, lists) }))
    const k = maps.packages.filter((x) => !x.disabled).map((x) => ({ value: `package:${x.id}`, label: `Package: ${x.name}`, price: resolvePrice(x.id, x.price, lists) }))
    return [...t, ...k]
  }, [maps.tests, maps.packages, p.rateList])
  const total = picked.reduce((s, v) => s + (options.find((o) => o.value === v)?.price ?? 0), 0)
  const funds = useMemo(() => {
    if (p.role !== 'b2b' || !p.partner) return null
    return checkFunds(p.partner as B2BCentre, centreBal(p), total, settings.b2bLab?.creditLimitBehaviour ?? 'block', 'b2b')
  }, [p.role, p.partner, p.orders, p.txns, p.notes, total, settings.b2bLab?.creditLimitBehaviour]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const v = await form.validateFields()
    if (!profile || !p.partner) return
    if (funds?.blocks) return void message.error(funds.message)
    setSaving(true)
    try {
      const items = v.items.map((key) => {
        const [kind, id] = key.split(':') as ['test' | 'package', string]
        const price = options.find((o) => o.value === key)?.price ?? 0
        if (kind === 'test') {
          const t = maps.testById.get(id)!
          return catalogueLine('test', id, t.code, t.name, price, [id], t.tatMinutes, { onlyBilling: !!t.onlyBilling })
        }
        const pk = maps.packageById.get(id)!
        return catalogueLine('package', id, pk.code, pk.name, price, pk.testIds)
      })
      const patient = await createPatient({
        salutation: v.gender === 'female' ? 'Ms.' : v.gender === 'male' ? 'Mr.' : '', firstName: v.firstName.trim(), lastName: (v.lastName ?? '').trim(), gender: v.gender,
        ageValue: v.ageValue, ageUnit: v.ageUnit, phone: v.phone.trim(), email: (v.email ?? '').trim(), dispatchModes: v.email ? ['email'] : [], referrerName: (v.referrer ?? '').trim() || 'Self', partnerId: p.partnerId,
      })
      const name = p.partner.name
      const ctx =
        p.role === 'b2b' ? { b2bCentreId: p.partnerId, b2bCentreName: name }
        : p.role === 'collectionCentre' ? { collectionCentreId: p.partnerId, collectionCentreName: name }
        : { corporateClientId: p.partnerId, corporateClientName: name }
      const rl = (p.partner as { rateListId?: string }).rateListId
      await createOrder({
        patient, items, discountReason: '', discountedBy: '', note: `Raised from partner portal by ${profile.name}`, payments: [], settings, user: profile,
        context: { ...ctx, referrerName: (v.referrer ?? '').trim() || undefined, rateListIds: rl ? [rl] : undefined, ...(p.role === 'corporate' ? { disableLetterhead: (p.partner as { disableLetterhead?: boolean }).disableLetterhead, hidePlan: (p.partner as { hidePlan?: boolean }).hidePlan } : {}) }, billedTo: p.role === 'b2b' ? 'b2b' : 'patient',
      })
      message.success('Bill created')
      form.resetFields()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader title="New bill" subtitle="Register a patient and bill tests at your agreed rates." />
      <Panel>
        <Form form={form} layout="vertical" initialValues={{ gender: 'male', ageUnit: 'year', items: [] }} disabled={saving}>
          <div className="portal__row">
            <Form.Item name="firstName" label="First name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="lastName" label="Last name"><Input /></Form.Item>
            <Form.Item name="gender" label="Gender"><Select style={{ width: 120 }} options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} /></Form.Item>
            <Form.Item name="ageValue" label="Age" rules={[{ required: true, type: 'number', min: 0 }]}><InputNumber min={0} /></Form.Item>
            <Form.Item name="ageUnit" label="Unit"><Select style={{ width: 110 }} options={[{ value: 'year', label: 'Years' }, { value: 'month', label: 'Months' }, { value: 'day', label: 'Days' }]} /></Form.Item>
            <Form.Item name="phone" label="Phone" rules={[{ required: true, pattern: /^\d{10}$/, message: '10 digit mobile' }]}><Input inputMode="tel" maxLength={10} /></Form.Item>
            <Form.Item name="email" label="Email (report delivery)" rules={[{ type: 'email' }]}><Input /></Form.Item>
            {(p.role !== 'b2b' || canB2B(p.flags, 'addReferral')) && <Form.Item name="referrer" label="Referring doctor (name)"><Input maxLength={80} /></Form.Item>}
          </div>
          <Form.Item name="items" label="Tests and packages" rules={[{ required: true, type: 'array', min: 1, message: 'Pick at least one test' }]}>
            <Select mode="multiple" showSearch optionFilterProp="label" placeholder="Search tests" options={options.map((o) => ({ value: o.value, label: o.label }))} />
          </Form.Item>
        </Form>
        <div className="portal__lines">
          {picked.map((k) => {
            const o = options.find((x) => x.value === k)
            return o ? <div key={k} className="portal__line"><span>{o.label}</span>{!(p.role === 'b2b' && (!canB2B(p.flags, 'showPriceColumn') || !canB2B(p.flags, 'showB2BRate'))) && <span className="tabular">{formatINR(o.price)}</span>}</div> : null
          })}
          <div className="portal__line"><strong>Total</strong><strong className="tabular">{formatINR(computeTotals(picked.map((k) => catalogueLine('test', k, '', '', options.find((x) => x.value === k)?.price ?? 0, []))).net)}</strong></div>
        </div>
        {funds && funds.level !== 'ok' && <Alert style={{ marginTop: 12 }} type={funds.blocks ? 'error' : 'warning'} showIcon message={funds.message} />}
        <div className="portal__row" style={{ marginTop: 16 }}>
          <Button variant="primary" onClick={() => void submit()} disabled={saving || !!funds?.blocks}>{saving ? 'Creating...' : 'Create bill'}</Button>
          <span className="portal__note">The bill is charged to {p.role === 'b2b' ? 'your wallet / credit' : 'your account'}; payment is settled with the lab.</span>
        </div>
      </Panel>
    </>
  )
}

// ---- Wallet (B2B) -----------------------------------------------------------------------------

function WalletView() {
  const p = usePortal()
  const centre = p.partner as B2BCentre | null
  const ledger = useMemo(() => (centre ? buildLedger([centre], p.orders, p.txns, p.notes) : []), [centre, p.orders, p.txns, p.notes])
  const [asking, setAsking] = useState(false)
  const requests = useMemo(
    () => effectiveTxns(p.txns).filter((t) => t.kind === 'topup').sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0)),
    [p.txns],
  )
  if (!centre) return <Spin />
  const bal = centreBal(p)
  return (
    <>
      <PageHeader
        title="Wallet"
        subtitle={`${creditTypeLabel(bal.creditType)}. Balances move with bills, approved top-ups and notes.`}
        actions={<><PayOnlineButton askAmount variant="default" input={{ purpose: 'b2bTopup', refId: centre.id, description: centre.name }} label="Pay online" /><Button variant="primary" onClick={() => setAsking(true)}>Request top-up</Button></>}
      />
      <TopUpRequest open={asking} onClose={() => setAsking(false)} centre={centre} />
      <TileGrid>
        <StatTile label="Wallet balance" value={formatINR(bal.wallet)} tone={bal.wallet < 0 ? 'caution' : 'success'} />
        <StatTile label="Spendable now" value={formatINR(bal.net)} tone={bal.isLow ? 'caution' : undefined} hint={bal.isLow ? 'Below your alert amount' : undefined} />
        <StatTile label="Top-ups awaiting approval" value={formatINR(bal.onHold)} />
        <StatTile label="Total billed" value={formatINR(bal.billed)} />
      </TileGrid>
      <Table
        rowKey="key"
        size="middle"
        dataSource={[...ledger].reverse()}
        pagination={{ pageSize: 25, hideOnSinglePage: true }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: 'Date', render: (_: unknown, r) => dayjs(r.at).format('DD MMM YYYY') },
          { title: 'Entry', dataIndex: 'description' },
          { title: 'Debit', align: 'right', render: (_: unknown, r) => (r.debit ? formatINR(r.debit) : '') },
          { title: 'Credit', align: 'right', render: (_: unknown, r) => (r.credit ? formatINR(r.credit) : '') },
          { title: 'Balance', align: 'right', render: (_: unknown, r) => formatINR(r.balance) },
        ]}
      />
      <Panel title="Top-up requests">
        <Table
          rowKey="id"
          size="middle"
          dataSource={requests}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'No top-up requests yet' }}
          columns={[
            { title: 'Date', render: (_: unknown, t) => (t.at ? dayjs(t.at.toDate()).format('DD MMM YYYY HH:mm') : '') },
            { title: 'Amount', align: 'right', render: (_: unknown, t) => formatINR(t.amount) },
            { title: 'Paid by', render: (_: unknown, t) => MODE_LABEL[t.mode ?? ''] ?? t.mode ?? '' },
            { title: 'Reference', dataIndex: 'reference' },
            {
              title: 'Status',
              render: (_: unknown, t) => (
                <StatusChip variant={t.status === 'approved' ? 'success' : t.status === 'declined' ? 'urgent' : 'caution'}>
                  {t.status === 'approved' ? 'Approved' : t.status === 'declined' ? 'Declined' : 'Awaiting approval'}
                </StatusChip>
              ),
            },
          ]}
        />
      </Panel>
    </>
  )
}

const MODE_LABEL: Record<string, string> = { upi: 'UPI', bank: 'Bank transfer', cheque: 'Cheque', cash: 'Cash', card: 'Card', online: 'Online' }

// A B2B centre asks the lab to add money it has paid. The request is pending and is not counted in the
// balance until lab staff approve it (B2B Labs > Wallet history).
function TopUpRequest({ open, onClose, centre }: { open: boolean; onClose: () => void; centre: B2BCentre }) {
  const { message } = AntApp.useApp()
  const { profile } = useAuth()
  const [form] = Form.useForm<{ amount: number; mode: string; reference?: string; remark?: string }>()
  const [saving, setSaving] = useState(false)
  const mode = Form.useWatch('mode', form)
  const submit = async () => {
    const v = await form.validateFields()
    if (!profile) return
    setSaving(true)
    try {
      await addDoc(col('walletTxns'), {
        branchId: 'main', // B2B centres are lab-wide masters; requests are reviewed from the main branch
        centreId: centre.id,
        centreName: centre.name,
        kind: 'topup',
        mode: v.mode,
        reference: (v.reference ?? '').trim(),
        amount: toPaise(v.amount),
        status: 'pending',
        remark: (v.remark ?? '').trim() || 'Requested from partner portal',
        requestedByPartner: true,
        by: profile.uid,
        byName: profile.name,
        at: serverTimestamp(),
      })
      message.success('Top-up requested. It will show in your balance once the lab approves it.')
      form.resetFields()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title="Request a top-up" open={open} onCancel={onClose} onOk={submit} okText="Send request" confirmLoading={saving} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ mode: 'upi' }}>
        <Form.Item name="amount" label="Amount paid (₹)" rules={[{ required: true, message: 'Enter the amount' }, { type: 'number', min: 1, message: 'Must be at least ₹1' }]}>
          <InputNumber min={1} precision={2} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="mode" label="Paid by" rules={[{ required: true }]}>
          <Select options={['upi', 'bank', 'cheque', 'cash'].map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        </Form.Item>
        <Form.Item name="reference" label="Transaction ID / cheque number" rules={[{ required: mode !== 'cash', whitespace: true, message: 'Needed so the lab can match your payment' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="remark" label="Note for the lab">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ---- Statements -------------------------------------------------------------------------------

function StatementsView() {
  const { message } = AntApp.useApp()
  const p = usePortal()
  const settings = useLabSettings()
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('month'), dayjs().endOf('day')])
  const inRange = useMemo(() => p.orders.filter((o) => { const d = dayjs((o.billDate ?? o.createdAt)?.toDate?.() ?? 0); return !d.isBefore(range[0].startOf('day')) && !d.isAfter(range[1].endOf('day')) }), [p.orders, range])
  const gross = inRange.reduce((s, o) => s + o.gross, 0)
  const net = inRange.reduce((s, o) => s + o.net, 0)
  const paid = inRange.reduce((s, o) => s + o.paid, 0)
  const due = inRange.reduce((s, o) => s + Math.max(0, o.due), 0)

  // Role-specific extra: collection centre settlement, doctor commission.
  let extraLabel = ''
  let extra = 0
  if (p.role === 'collectionCentre' && p.partner) {
    const c = p.partner as CollectionCentre
    extraLabel = c.settlementType === 'sharePercent' ? `Your share (${c.settlementValue}% of net)` : c.settlementType === 'flatPerBill' ? 'Your share (flat per bill)' : ''
    extra = c.settlementType === 'sharePercent' ? Math.round((net * c.settlementValue) / 100) : c.settlementType === 'flatPerBill' ? inRange.length * Math.round(c.settlementValue) : 0
  }
  if (p.role === 'referrer' && p.partner) {
    const r = p.partner as Referrer
    extraLabel = 'Commission'
    extra = inRange.filter((o) => orderMatchesReferrer(o, r)).reduce((s, o) => s + commissionForReferrer(o, r, settings.referrals?.commissionBasis ?? 'net'), 0)
  }
  const showMoney = p.role !== 'b2b' || canB2B(p.flags, 'showPriceColumn')

  const csvRows = () => [['Bill', 'Date', 'Patient', 'Tests', 'Net', 'Paid', 'Due'], ...inRange.map((o) => [o.billNo, fmtDate(o.billDate ?? o.createdAt), o.patientName, o.items.map((i) => i.name).join('; '), o.net / 100, o.paid / 100, Math.max(0, o.due) / 100])]
  const print = () => {
    const body = `<h1>Statement</h1><div class="muted">${esc(settings.name)} · ${esc(p.partner?.name)}<br>${range[0].format('DD MMM YYYY')} to ${range[1].format('DD MMM YYYY')}</div>
<table><tr><th>Bill</th><th>Date</th><th>Patient</th><th class="n">Net</th><th class="n">Paid</th><th class="n">Due</th></tr>
${inRange.map((o) => `<tr><td>${esc(o.billNo)}</td><td>${esc(fmtDate(o.billDate ?? o.createdAt))}</td><td>${esc(o.patientName)}</td><td class="n">${formatINR(o.net)}</td><td class="n">${formatINR(o.paid)}</td><td class="n">${formatINR(Math.max(0, o.due))}</td></tr>`).join('')}
<tr><th colspan="3">Total (${inRange.length} bills)</th><th class="n">${formatINR(net)}</th><th class="n">${formatINR(paid)}</th><th class="n">${formatINR(due)}</th></tr></table>${extraLabel ? `<p><b>${esc(extraLabel)}:</b> ${formatINR(extra)}</p>` : ''}`
    if (!printHtml('Statement', body)) message.warning('Allow pop-ups to print the statement')
  }

  return (
    <>
      <PageHeader title="Statements" subtitle="Your bills for a period, with totals." actions={<><Button onClick={() => downloadCsv('statement', csvRows())}>Export CSV</Button><Button variant="primary" onClick={print}>Print</Button></>} />
      <div className="portal__row">
        <DatePicker.RangePicker aria-label="Statement period" value={range} allowClear={false} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
      </div>
      {showMoney && (
        <TileGrid>
          <StatTile label="Bills" value={inRange.length} />
          <StatTile label="Gross" value={formatINR(gross)} />
          <StatTile label="Net billed" value={formatINR(net)} />
          <StatTile label="Paid" value={formatINR(paid)} />
          <StatTile label="Due" value={formatINR(due)} tone={due > 0 ? 'caution' : undefined} />
          {extraLabel && <StatTile label={extraLabel} value={formatINR(extra)} tone="info" />}
        </TileGrid>
      )}
      {(p.role === 'b2b' || p.role === 'corporate') && (
        <Panel title="Invoices">
          <Table<PartnerInvoice>
            rowKey="id"
            size="small"
            dataSource={[...p.invoices].sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{ emptyText: 'No invoices yet' }}
            columns={[
              { title: 'Number', dataIndex: 'number' },
              { title: 'Period', render: (_: unknown, i) => `${i.periodFrom} to ${i.periodTo}` },
              { title: 'Amount', align: 'right', render: (_: unknown, i) => formatINR(i.amount) },
              { title: 'Paid', align: 'right', render: (_: unknown, i) => formatINR(i.paid) },
              { title: 'Status', render: (_: unknown, i) => <StatusChip variant={i.status === 'paid' ? 'success' : i.status === 'sent' ? 'info' : 'neutral'}>{i.status}</StatusChip> },
            ]}
          />
        </Panel>
      )}
    </>
  )
}
