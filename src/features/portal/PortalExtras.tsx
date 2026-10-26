import { useMemo, useState } from 'react'
import { App as AntApp, Alert, Checkbox, Input, InputNumber, Popconfirm, Table } from 'antd'
import { query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import dayjs from 'dayjs'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { PageHeader } from '../../design/PageHeader'
import { StatusChip } from '../../design/StatusChip'
import { functions, LAB_ID } from '../../firebase'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { PaymentStatusChip } from '../../components/billing/PaymentStatusChip'
import PayOnlineButton from '../../components/billing/PayOnlineButton'
import { fmtDate } from '../../components/results/common'
import { col } from '../../lib/db'
import { formatINR } from '../../lib/money'
import { printManifest } from '../../pages/accession/Manifest'
import type { Manifest } from '../../lib/accession'
import { StatTile, TileGrid, Panel } from '../qc/ui'
import { centreBalance, canB2B } from '../partners/lib/b2b'
import { commissionForReferrer, orderMatchesReferrer } from '../partners/lib/commission'
import { downloadCsv } from '../partners/lib/csv'
import type { B2BCentre, CollectionCentre, CommissionSettlement, PartnerOrder, Referrer } from '../partners/types'
import { usePortal } from './usePortal'

// ---- Clear due: pay the balance online -------------------------------------------------------------------------------
// Each bill with a balance has its own Pay online button (one payment per bill). A B2B centre pays its wallet
// shortfall as a top-up; with "patient-wise due clearance" on it can also pay single bills.
export function ClearDueView() {
  const p = usePortal()
  const { profile } = useAuth()
  const owing = useMemo(() => p.orders.filter((o) => o.due > 0).sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0)), [p.orders])
  const isB2b = p.role === 'b2b'
  const centre = p.partner as B2BCentre | null
  const bal = isB2b && centre ? centreBalance(centre, p.orders, p.txns, p.notes) : null
  const shortfall = bal ? Math.max(0, -bal.wallet) : 0
  const total = owing.reduce((n, o) => n + o.due, 0)
  const patientWise = !isB2b || canB2B(p.flags, 'clearPatientDue')
  const allowed = can(profile, 'portal.clearDue')
  if (!allowed) return <Alert type="warning" showIcon message="Your login cannot pay dues online. Ask the lab to enable it." />

  return (
    <>
      <PageHeader title="Clear due" subtitle="Pay what is owed on your bills. Payments post to your account straight away." />
      <TileGrid>
        <StatTile label="Bills with a balance" value={owing.length} />
        {!isB2b && <StatTile label="Total due" value={formatINR(total)} tone={total > 0 ? 'caution' : undefined} />}
        {bal && <StatTile label="Wallet shortfall" value={formatINR(shortfall)} tone={shortfall > 0 ? 'caution' : 'success'} />}
      </TileGrid>
      {isB2b && centre && (
        <Panel title="Wallet">
          <div className="portal__row">
            <span>{shortfall > 0 ? `Your wallet is ${formatINR(shortfall)} below zero.` : 'Your wallet is not overdrawn.'}</span>
            <PayOnlineButton input={{ purpose: 'b2bTopup', refId: p.partnerId, amount: shortfall > 0 ? shortfall : undefined, description: centre.name }} label={shortfall > 0 ? `Pay ${formatINR(shortfall)}` : 'Top up'} disabled={shortfall <= 0} />
          </div>
          <p className="portal__note">To add a different amount, use Wallet &gt; Pay online.</p>
        </Panel>
      )}
      {patientWise && (
        <Table<PartnerOrder>
          rowKey="id"
          size="middle"
          dataSource={owing}
          pagination={{ pageSize: 25, hideOnSinglePage: true }}
          locale={{ emptyText: 'Nothing is due' }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: 'Bill', dataIndex: 'billNo' },
            { title: 'Date', render: (_: unknown, o) => fmtDate(o.billDate ?? o.createdAt) },
            { title: 'Patient', dataIndex: 'patientName' },
            { title: 'Net', align: 'right', render: (_: unknown, o) => formatINR(o.net) },
            { title: 'Paid', align: 'right', render: (_: unknown, o) => formatINR(o.paid) },
            { title: 'Due', align: 'right', render: (_: unknown, o) => <b>{formatINR(o.due)}</b> },
            { title: '', render: (_: unknown, o) => <PayOnlineButton variant="default" input={{ purpose: 'bill', refId: o.id, amount: o.due, description: `Bill ${o.billNo}` }} label={`Pay ${formatINR(o.due)}`} /> },
          ]}
        />
      )}
    </>
  )
}

// ---- Financial analysis ------------------------------------------------------------------------------------------------
export function FinancialView() {
  const p = usePortal()
  const { profile } = useAuth()
  const maps = useCatalogueMaps()
  const settings = useLabSettings()
  const [months, setMonths] = useState(12)
  const money = p.role !== 'b2b' || canB2B(p.flags, 'showPriceColumn')
  const from = dayjs().startOf('month').subtract(months - 1, 'month')
  const inScope = useMemo(() => p.orders.filter((o) => !dayjs((o.billDate ?? o.createdAt)?.toDate?.() ?? 0).isBefore(from)), [p.orders, from])
  const monthly = useMemo(() => {
    const m = new Map<string, { bills: number; net: number; paid: number; due: number; commission: number }>()
    const ref = p.role === 'referrer' ? (p.partner as Referrer | null) : null
    for (const o of inScope) {
      const k = dayjs((o.billDate ?? o.createdAt)?.toDate?.() ?? 0).format('YYYY-MM')
      const x = m.get(k) ?? { bills: 0, net: 0, paid: 0, due: 0, commission: 0 }
      x.bills++
      x.net += o.net
      x.paid += o.paid
      x.due += Math.max(0, o.due)
      if (ref && orderMatchesReferrer(o, ref)) x.commission += commissionForReferrer(o, ref, settings.referrals?.commissionBasis ?? 'net')
      m.set(k, x)
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, v]) => ({ month, ...v }))
  }, [inScope, p.role, p.partner, settings.referrals?.commissionBasis])
  const top = useMemo(() => {
    const m = new Map<string, { name: string; count: number; amount: number }>()
    for (const o of inScope) for (const i of o.items) {
      if (i.status === 'refunded' || i.isCharge) continue
      const x = m.get(i.refId) ?? { name: i.name, count: 0, amount: 0 }
      x.count += i.qty ?? 1
      x.amount += i.price - i.discount
      m.set(i.refId, x)
    }
    return [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.amount - a.amount).slice(0, 10)
  }, [inScope])
  const byStatus = useMemo(() => {
    const m: Record<string, { n: number; amount: number }> = {}
    for (const o of inScope) {
      const k = o.due <= 0 ? 'Paid' : o.paid > 0 ? 'Partly paid' : 'Unpaid'
      m[k] = { n: (m[k]?.n ?? 0) + 1, amount: (m[k]?.amount ?? 0) + o.net }
    }
    return m
  }, [inScope])
  const payouts = useMemo(() => [...p.payouts].sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0)), [p.payouts])
  const paidOut = payouts.reduce((n, r) => n + r.amount, 0)
  const t = monthly.reduce((a, r) => ({ bills: a.bills + r.bills, net: a.net + r.net, paid: a.paid + r.paid, due: a.due + r.due, commission: a.commission + r.commission }), { bills: 0, net: 0, paid: 0, due: 0, commission: 0 })
  void maps
  if (!can(profile, 'portal.financials')) return <Alert type="warning" showIcon message="Your login cannot open the financial analysis. Ask the lab to enable it." />
  if (!money) return <Alert type="info" showIcon message="Prices are hidden for your account, so there is no financial analysis to show." />
  const share = t.net ? Math.round((t.paid / t.net) * 100) : 0
  return (
    <>
      <PageHeader title="Financial analysis" subtitle="Billing, collection and dues for your organisation."
        actions={<Button onClick={() => downloadCsv('financial-analysis', [['month', 'bills', 'billed', 'collected', 'due', ...(p.role === 'referrer' ? ['commission'] : [])], ...monthly.map((r) => [r.month, r.bills, r.net / 100, r.paid / 100, r.due / 100, ...(p.role === 'referrer' ? [r.commission / 100] : [])])])}>Export CSV</Button>} />
      <div className="portal__row">
        <span>Period</span>
        <InputNumber aria-label="Months to include" min={1} max={36} value={months} onChange={(v) => setMonths(v ?? 12)} addonAfter="months" style={{ width: 150 }} />
      </div>
      <TileGrid>
        <StatTile label="Bills" value={t.bills} />
        <StatTile label="Billed" value={formatINR(t.net)} />
        <StatTile label="Collected" value={formatINR(t.paid)} tone="success" hint={`${share}% of billed`} />
        <StatTile label="Due" value={formatINR(t.due)} tone={t.due > 0 ? 'caution' : undefined} />
        {p.role === 'referrer' && <StatTile label="Commission" value={formatINR(t.commission)} tone="info" />}
        {p.role === 'referrer' && <StatTile label="Paid out" value={formatINR(paidOut)} tone="success" hint={t.commission - paidOut > 0 ? `${formatINR(t.commission - paidOut)} still to be paid (this period)` : undefined} />}
      </TileGrid>
      {p.role === 'referrer' && (
        <Panel title="Commission payouts">
          <Table<CommissionSettlement>
            size="small"
            rowKey="id"
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            dataSource={payouts}
            locale={{ emptyText: 'No payouts have been recorded yet.' }}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: 'Date', render: (_: unknown, r) => fmtDate(r.at) },
              { title: 'Period', render: (_: unknown, r) => `${r.periodFrom} to ${r.periodTo}` },
              { title: 'Type', render: (_: unknown, r) => (r.kind === 'reversal' ? <StatusChip variant="caution">Reversed</StatusChip> : <StatusChip variant="success">Paid</StatusChip>) },
              { title: 'Mode', dataIndex: 'mode' },
              { title: 'Reference', dataIndex: 'reference' },
              { title: 'Amount', align: 'right' as const, render: (_: unknown, r) => formatINR(r.amount) },
              { title: 'Note', dataIndex: 'note' },
            ]}
          />
        </Panel>
      )}
      <Panel title="Month by month">
        <Table size="small" rowKey="month" pagination={false} dataSource={monthly} scroll={{ x: 'max-content' }}
          columns={[
            { title: 'Month', render: (_: unknown, r) => dayjs(`${r.month}-01`).format('MMM YYYY') },
            { title: 'Bills', align: 'right', dataIndex: 'bills' },
            { title: 'Billed', align: 'right', render: (_: unknown, r) => formatINR(r.net) },
            { title: 'Collected', align: 'right', render: (_: unknown, r) => formatINR(r.paid) },
            { title: 'Due', align: 'right', render: (_: unknown, r) => formatINR(r.due) },
            ...(p.role === 'referrer' ? [{ title: 'Commission', align: 'right' as const, render: (_: unknown, r: { commission: number }) => formatINR(r.commission) }] : []),
          ]} />
      </Panel>
      <div className="portal__row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 2, minWidth: 280 }}>
          <Panel title="Top tests by billed amount">
            <Table size="small" rowKey="id" pagination={false} dataSource={top}
              columns={[{ title: 'Test', dataIndex: 'name' }, { title: 'Count', align: 'right', dataIndex: 'count' }, { title: 'Amount', align: 'right', render: (_: unknown, r) => formatINR(r.amount) }]} />
          </Panel>
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <Panel title="Payment status">
            {Object.entries(byStatus).map(([k, v]) => (
              <div key={k} className="portal__line"><span>{k}</span><span className="tabular">{v.n} bills · {formatINR(v.amount)}</span></div>
            ))}
            {!inScope.length && <span className="portal__note">No bills in this period.</span>}
          </Panel>
        </div>
      </div>
    </>
  )
}

// ---- Dispatch manifest (collection centre) --------------------------------------------------------------------------
export function DispatchView() {
  const { message } = AntApp.useApp()
  const p = usePortal()
  const { profile } = useAuth()
  const [sel, setSel] = useState<string[]>([])
  const [courier, setCourier] = useState('')
  const [tubes, setTubes] = useState<number | null>(null)
  const [temp, setTemp] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const centre = p.partner as CollectionCentre | null
  const waiting = useMemo(() => p.orders.filter((o) => o.items.some((i) => !i.isCharge && !i.onlyBilling && !(i as { inTransit?: boolean }).inTransit && (i.status === 'pending' || i.status === 'collected'))), [p.orders])
  const manifests = useLiveQuery<Manifest>(p.partnerId ? query(col('manifests'), where('centreId', '==', p.partnerId)) : null, [p.partnerId]).data
  const sorted = useMemo(() => [...manifests].sort((a, b) => String(b.no).localeCompare(String(a.no))), [manifests])
  if (!can(profile, 'portal.dispatch')) return <Alert type="warning" showIcon message="Your login cannot dispatch samples. Ask the lab to enable it." />

  const create = async () => {
    setBusy(true)
    try {
      const r = await httpsCallable<unknown, { id: string; no: string; bills: number }>(functions, 'portalDispatchManifest')({ labId: LAB_ID, orderIds: sel, courier, tubes: tubes ?? 0, temperature: temp, note })
      message.success(`Manifest ${r.data.no} created for ${r.data.bills} bill(s)`)
      setSel([])
      setCourier(''); setTubes(null); setTemp(''); setNote('')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const print = (m: Manifest) => {
    if (!printManifest({ no: m.no, centreName: m.centreName, courier: m.courier, tubes: m.tubes, temperature: m.temperature, note: m.note, lines: m.lines }, m.createdByName)) message.warning('Allow pop-ups to print the manifest')
  }
  return (
    <>
      <PageHeader title="Dispatch manifest" subtitle={`Pack the samples ${centre?.name ?? 'your centre'} has collected into a box sheet for the lab.`} />
      <Panel title="Samples waiting to be sent">
        <Table<PartnerOrder>
          rowKey="id"
          size="small"
          dataSource={waiting}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: 'No samples waiting' }}
          rowSelection={{ selectedRowKeys: sel, onChange: (k) => setSel(k as string[]) }}
          columns={[
            { title: 'Bill', dataIndex: 'billNo' },
            { title: 'Barcode', dataIndex: 'barcode' },
            { title: 'Patient', dataIndex: 'patientName' },
            { title: 'Tests', render: (_: unknown, o) => o.items.filter((i) => !i.isCharge && i.status !== 'refunded').map((i) => i.name).join(', ') },
          ]}
        />
        <div className="portal__row" style={{ marginTop: 12 }}>
          <Input aria-label="Courier" placeholder="Courier / runner" style={{ width: 180 }} value={courier} onChange={(e) => setCourier(e.target.value)} />
          <InputNumber aria-label="Tubes" placeholder="Tubes" min={0} value={tubes} onChange={setTubes} />
          <Input aria-label="Temperature" placeholder="Temperature (e.g. 2-8 C)" style={{ width: 200 }} value={temp} onChange={(e) => setTemp(e.target.value)} />
          <Input aria-label="Note" placeholder="Note" style={{ width: 240 }} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="primary" disabled={!sel.length || busy} onClick={create}>{busy ? 'Creating...' : `Create manifest (${sel.length})`}</Button>
        </div>
      </Panel>
      <Panel title="Your manifests">
        <Table<Manifest>
          rowKey="id"
          size="small"
          dataSource={sorted}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: 'No manifests yet' }}
          columns={[
            { title: 'Manifest', dataIndex: 'no' },
            { title: 'Bills', render: (_: unknown, m) => m.lines.length },
            { title: 'Courier', dataIndex: 'courier' },
            { title: 'Status', render: (_: unknown, m) => <StatusChip variant={m.status === 'received' ? 'success' : m.status === 'partial' ? 'caution' : 'info'}>{m.status === 'inTransit' ? 'In transit' : m.status === 'received' ? 'Received by lab' : 'Partly received'}</StatusChip> },
            { title: '', render: (_: unknown, m) => <Button variant="text" onClick={() => print(m)}>Print</Button> },
          ]}
        />
      </Panel>
    </>
  )
}

// ---- Per-bill actions in the bills list (delete for a collection centre, barcode edit for B2B) --------------------------
export function BillActions({ o }: { o: PartnerOrder }) {
  const { message, modal } = AntApp.useApp()
  const p = usePortal()
  const centre = p.role === 'collectionCentre' ? (p.partner as CollectionCentre | null) : null
  const b2b = p.role === 'b2b' ? (p.partner as B2BCentre | null) : null
  const untouched = o.items.every((i) => i.status === 'pending')
  const canDelete = !!centre?.allowBillDelete && untouched && o.paid <= 0 && !o.deleted
  const canBarcode = !!b2b && canB2B(b2b, 'editBarcode') && untouched
  const call = async (name: string, data: Record<string, unknown>) => {
    try {
      await httpsCallable(functions, name)({ labId: LAB_ID, orderId: o.id, ...data })
      message.success('Done')
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const editBarcode = () => {
    let v = o.barcode
    modal.confirm({ title: `Barcode for ${o.billNo}`, content: <Input aria-label="Barcode" defaultValue={o.barcode} onChange={(e) => { v = e.target.value }} />, okText: 'Save', onOk: () => call('portalEditBarcode', { barcode: v }) })
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      {canBarcode && <Button variant="text" onClick={editBarcode}>Edit barcode</Button>}
      {canDelete && (
        <Popconfirm title={`Delete bill ${o.billNo}?`} okText="Delete" onConfirm={() => call('portalVoidBill', { reason: 'Deleted by collection centre' })}>
          <Button variant="text">Delete</Button>
        </Popconfirm>
      )}
    </span>
  )
}

// Small helper for the bills list.
export const BillPayChip = ({ o }: { o: PartnerOrder }) => <PaymentStatusChip order={o} />
export { Checkbox as _Checkbox }
