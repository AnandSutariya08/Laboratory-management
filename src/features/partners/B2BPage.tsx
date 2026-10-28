import { auditWalletChange } from '../settings/audit'
import { useMemo, useState } from 'react'
import { Checkbox, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Switch, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, ProfileOutlined, UploadOutlined, WalletOutlined } from '@ant-design/icons'
import { addDoc, query, serverTimestamp } from 'firebase/firestore'
import dayjs from 'dayjs'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { auth } from '../../firebase'
import { branchStamp } from '../../lib/activeBranch'
import { useBranchScope } from '../../lib/branchScope'
import { col } from '../../lib/db'
import { formatINR, toPaise } from '../../lib/money'
import { useLiveQuery } from '../../hooks/useLive'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { payOnline } from '../../lib/payments'
import { InvoicesPanel } from './InvoicesPanel'
import { buildLedger, centreBalance, creditTypeLabel, effectiveTxns } from './lib/b2b'
import { downloadCsv, parseCsvObjects } from './lib/csv'
import { ensureRateList, removeMaster, saveMaster, useMaster, useRateLists } from './lib/master'
import { useOrdersByPartner, type Range } from './lib/orders'
import { PriceListDrawer } from './RateListEditor'
import type { B2BCentre, B2BSettings, CreditNote, PartnerInvoice, PartnerOrder, WalletMode, WalletTxn } from './types'
import { ActiveChip, DataTable, FileButton, fmtDateTime, Kpis, RangeField, Section, Spacer, thisMonth, Toolbar } from './ui'

type Tab = 'labs' | 'wallet' | 'ledger' | 'invoices' | 'balance' | 'notes' | 'discount'

const MODES: { value: WalletMode; label: string }[] = [
  { value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank transfer' }, { value: 'cheque', label: 'Cheque' }, { value: 'online', label: 'Online (gateway)' },
]

const SETTING_LABELS: Record<keyof B2BSettings, string> = {
  disableDashboard: 'Disable dashboard', disablePriceList: 'Disable price list', bookingLock: 'Booking lock',
  printingLock: 'Printing lock', noEditAfterApproval: 'No patient edit after report approval',
  registrationBelowLimitAtMain: 'Registration below credit limit at main lab', registrationBelowLimitAtB2B: 'Registration below credit limit at B2B lab',
  reportDownloadBelowLimit: 'Report download below credit limit', disableCustomization: 'Disable customisation', disableMrpEdit: 'Disable MRP price edit',
  hidePriceColumn: 'Hide price column and bill from patient list', barcodeEdit: 'Barcode edit', hideB2BRate: 'Hide B2B rate from billing',
  patientWiseDueClearance: 'Allow patient-wise due clearance', allowAddReferral: 'Allow add referral doctor', manualWhatsapp: 'Allow manual WhatsApp',
  autoSendReport: 'Auto send report', showTatColumn: 'Show TAT column',
}
const TAB_SETTINGS: (keyof B2BSettings)[] = ['disableDashboard', 'disablePriceList', 'bookingLock']

const who = (p: { name?: string } | null) => ({ by: auth.currentUser?.uid ?? '', byName: p?.name ?? auth.currentUser?.email ?? '' })

export default function B2BPage() {
  const { profile } = useAuth()
  const canApprove = can(profile, 'b2b.manage')
  const { constraints, key } = useBranchScope()
  const [tab, setTab] = useState<Tab>('labs')
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Partial<B2BCentre> | null>(null)
  const [pl, setPl] = useState<B2BCentre | null>(null)
  const [addMoney, setAddMoney] = useState(false)
  const [bulkPrice, setBulkPrice] = useState(false)
  const [bulkUp, setBulkUp] = useState(false)
  const [range, setRange] = useState<Range>(thisMonth())
  const [centreFilter, setCentreFilter] = useState('all')

  const centres = useMaster<B2BCentre>('b2bCentres')
  const txns = useLiveQuery<WalletTxn>(query(col('walletTxns'), ...constraints), [key])
  const notes = useLiveQuery<CreditNote>(query(col('creditNotes'), ...constraints), [key])
  const orders = useOrdersByPartner('b2bCentreId', centres.data.map((c) => c.id))
  const rates = useRateLists()

  const sortedTxns = useMemo(() => [...txns.data].sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0)), [txns.data])
  const decided = useMemo(() => new Map(txns.data.filter((t) => t.kind === 'approval').map((t) => [t.refTxnId, t])), [txns.data])
  const eff = useMemo(() => effectiveTxns(sortedTxns), [sortedTxns])
  const ledger = useMemo(() => buildLedger(centres.data, orders.data, txns.data, notes.data), [centres.data, orders.data, txns.data, notes.data])
  const bal = (c: B2BCentre) => centreBalance(c, orders.data, txns.data, notes.data)
  const inRange = (d: Date) => d.getTime() >= range[0].startOf('day').valueOf() && d.getTime() <= range[1].endOf('day').valueOf()
  const centreOk = (id: string) => centreFilter === 'all' || id === centreFilter
  const centreOpts = [{ value: 'all', label: 'All B2B labs' }, ...centres.data.map((c) => ({ value: c.id, label: c.name }))]
  const loading = centres.loading || txns.loading

  const decide = async (t: WalletTxn, status: 'approved' | 'declined') => {
    try {
      await addDoc(col('walletTxns'), { ...branchStamp(), centreId: t.centreId, centreName: t.centreName, kind: 'approval', refTxnId: t.id, status, amount: 0, reference: t.reference, remark: `${status} manual payment`, ...who(profile), at: serverTimestamp() })
      void auditWalletChange(t.centreName, `b2bCentres/${t.centreId}`, 0, `payment ${status}`, t.reference ?? '')
      message.success(`Payment ${status}`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const rows = centres.data.filter((c) => !q.trim() || `${c.name} ${c.code} ${c.city}`.toLowerCase().includes(q.toLowerCase()))
  const totals = centres.data.reduce((a, c) => { const b = bal(c); return { wallet: a.wallet + b.wallet, hold: a.hold + b.onHold } }, { wallet: 0, hold: 0 })

  return (
    <div>
      <PageHeader
        title="B2B Labs"
        subtitle="Partner labs on prepaid or credit terms: wallet, ledger, invoices and price lists"
        actions={
          <>
            <Button icon={<WalletOutlined />} onClick={() => setAddMoney(true)}>Add money</Button>
            <Button onClick={() => setBulkPrice(true)}>Bulk price edit</Button>
            <Button icon={<UploadOutlined />} onClick={() => setBulkUp(true)}>Bulk upload</Button>
            <Button variant="primary" icon={<PlusOutlined />} onClick={() => setEdit({ active: true, creditType: 'creditLimit', paymentMethod: 'manual', settings: {}, bank: { bank: '', account: '', ifsc: '', pan: '' } })}>New B2B lab</Button>
          </>
        }
      />
      <div className="pt-tabs">
        <Segmented<Tab> aria-label="B2B view" value={tab} onChange={setTab} options={[
          { value: 'labs', label: 'B2B labs', count: centres.data.length },
          { value: 'wallet', label: 'Wallet history' },
          { value: 'ledger', label: 'Ledger' },
          { value: 'invoices', label: 'Invoices' },
          { value: 'balance', label: 'Balance' },
          { value: 'notes', label: 'Credit / debit note' },
          { value: 'discount', label: 'Bulk discount' },
        ]} />
      </div>

      {tab === 'labs' && (
        <>
          <Kpis items={[{ label: 'B2B labs', value: centres.data.length }, { label: 'Wallet balance (all)', value: formatINR(totals.wallet) }, { label: 'On hold', value: formatINR(totals.hold) }]} />
          <DataTable<B2BCentre>
            loading={loading}
            dataSource={rows}
            emptyTitle="No B2B labs yet"
            emptyHint="Add a partner lab or bulk upload a CSV."
            toolbar={
              <Toolbar>
                <Input.Search allowClear aria-label="Search B2B labs" placeholder="Search by lab or code" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
                <Spacer />
                <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('b2b-labs', [['name', 'code', 'credit type', 'credit limit', 'wallet', 'on hold', 'net balance', 'spendable', 'active'], ...rows.map((c) => { const b = bal(c); return [c.name, c.code, c.creditType, c.creditLimit / 100, b.wallet / 100, b.onHold / 100, b.netBalance / 100, b.net / 100, c.active] })])}>Export CSV</Button>
              </Toolbar>
            }
            columns={[
              { title: 'B2B lab', render: (_, c) => <span>{c.name} <span className="pt-muted">{c.code}</span></span> },
              { title: 'Credit type', render: (_, c) => creditTypeLabel(c.creditType) },
              { title: 'Credit limit', align: 'right', render: (_, c) => <span className="pt-num">{formatINR(c.creditLimit ?? 0)}</span> },
              { title: 'Wallet balance', align: 'right', render: (_, c) => { const w = bal(c).wallet; return <span className="pt-num">{formatINR(w)} {w < 0 && <StatusChip variant="caution">Owes</StatusChip>}</span> } },
              { title: 'On hold', align: 'right', render: (_, c) => <span className="pt-num">{formatINR(bal(c).onHold)}</span> },
              { title: 'Net balance', align: 'right', render: (_, c) => <span className="pt-num">{formatINR(bal(c).netBalance)}</span> },
              { title: 'Spendable', align: 'right', render: (_, c) => { const b = bal(c); return <span className="pt-num">{formatINR(b.net)} {b.isLow && <StatusChip variant="urgent">Low</StatusChip>}</span> } },
              { title: 'Status', render: (_, c) => <ActiveChip active={c.active} /> },
              { title: 'Active', render: (_, c) => <Switch size="small" aria-label={`Active: ${c.name}`} checked={c.active} onChange={(v) => saveMaster('b2bCentres', c.id, { active: v })} /> },
              {
                title: 'Actions',
                render: (_, c) => (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <Button variant="text" icon={<EditOutlined />} aria-label={`Edit ${c.name}`} onClick={() => setEdit(c)} />
                    <Button variant="text" icon={<ProfileOutlined />} aria-label={`Price list for ${c.name}`} onClick={() => setPl(c)} />
                    <Popconfirm title={`Delete ${c.name}?`} okText="Delete" onConfirm={() => removeMaster('b2bCentres', c.id).catch((e) => message.error(e.message))}>
                      <Button variant="text" icon={<DeleteOutlined />} aria-label={`Delete ${c.name}`} />
                    </Popconfirm>
                  </span>
                ),
              },
            ]}
          />
        </>
      )}

      {tab === 'wallet' && (
        <DataTable<WalletTxn>
          loading={txns.loading}
          dataSource={eff.filter((t) => centreOk(t.centreId) && inRange(t.at?.toDate?.() ?? new Date()))}
          emptyTitle="No wallet transactions"
          emptyHint="Top-ups, per-bill debits and adjustments show here."
          toolbar={
            <Toolbar>
              <Select aria-label="B2B lab" style={{ minWidth: 200 }} value={centreFilter} onChange={setCentreFilter} options={centreOpts} showSearch optionFilterProp="label" />
              <RangeField value={range} onChange={setRange} />
              <Spacer />
              <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('wallet-history', [['date', 'lab', 'type', 'method', 'amount', 'reference', 'status', 'decided by', 'remark'], ...eff.filter((t) => centreOk(t.centreId)).map((t) => [fmtDateTime(t.at?.toDate?.()), t.centreName, t.kind, t.mode ?? '', t.amount / 100, t.reference, t.status, decided.get(t.id)?.byName ?? '', t.remark])])}>Export CSV</Button>
            </Toolbar>
          }
          columns={[
            { title: 'Date and time', render: (_, t) => fmtDateTime(t.at?.toDate?.()) },
            { title: 'B2B lab', dataIndex: 'centreName' },
            { title: 'Type', dataIndex: 'kind', render: (k: string) => k[0].toUpperCase() + k.slice(1) },
            { title: 'Method', render: (_, t) => MODES.find((m) => m.value === t.mode)?.label ?? '' },
            { title: 'Amount', align: 'right', render: (_, t) => <span className="pt-num">{formatINR(t.amount)}</span> },
            { title: 'Transaction ID', dataIndex: 'reference' },
            { title: 'Approved / declined by', render: (_, t) => decided.get(t.id)?.byName ?? '' },
            { title: 'Status', render: (_, t) => <StatusChip variant={t.status === 'approved' ? 'success' : t.status === 'declined' ? 'urgent' : 'caution'}>{t.status[0].toUpperCase() + t.status.slice(1)}</StatusChip> },
            { title: 'Remark', dataIndex: 'remark' },
            {
              title: 'Action',
              render: (_, t) =>
                t.kind === 'topup' && t.status === 'pending' && canApprove ? (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <Button variant="text" onClick={() => decide(t, 'approved')} aria-label={`Approve payment ${t.reference}`}>Approve</Button>
                    <Button variant="text" onClick={() => decide(t, 'declined')} aria-label={`Decline payment ${t.reference}`}>Decline</Button>
                  </span>
                ) : null,
            },
          ]}
        />
      )}

      {tab === 'ledger' && (
        <DataTable<(typeof ledger)[number] & { id: string }>
          loading={loading || orders.loading}
          dataSource={ledger.filter((r) => centreOk(r.centreId) && inRange(r.at)).map((r) => ({ ...r, id: r.key })).reverse()}
          emptyTitle="No ledger entries in this range"
          toolbar={
            <Toolbar>
              <Select aria-label="B2B lab" style={{ minWidth: 200 }} value={centreFilter} onChange={setCentreFilter} options={centreOpts} showSearch optionFilterProp="label" />
              <RangeField value={range} onChange={setRange} />
              <Spacer />
              <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('b2b-ledger', [['date', 'lab', 'entry', 'patients', 'tests', 'debit', 'credit', 'balance', 'status'], ...ledger.filter((r) => centreOk(r.centreId) && inRange(r.at)).map((r) => [fmtDateTime(r.at), r.centreName, r.description, r.patients ?? '', r.items ?? '', r.debit / 100, r.credit / 100, r.balance / 100, r.status])])}>Export CSV</Button>
            </Toolbar>
          }
          columns={[
            { title: 'Date and time', render: (_, r) => fmtDateTime(r.at) },
            { title: 'B2B lab', dataIndex: 'centreName' },
            { title: 'Entry', dataIndex: 'description' },
            { title: 'Patients', dataIndex: 'patients' },
            { title: 'Tests / packages', dataIndex: 'items', ellipsis: true },
            { title: 'Status', dataIndex: 'status' },
            { title: 'Debit', align: 'right', render: (_, r) => <span className="pt-num">{r.debit ? formatINR(r.debit) : ''}</span> },
            { title: 'Credit', align: 'right', render: (_, r) => <span className="pt-num">{r.credit ? formatINR(r.credit) : ''}</span> },
            { title: 'Running balance', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.balance)}</span> },
          ]}
        />
      )}

      {tab === 'invoices' && <InvoicesPanel kind="b2b" field="b2bCentreId" parties={centres.data.map((c) => ({ id: c.id, name: c.name, code: c.code, address: c.address, gstin: c.gstin, cycle: c.invoiceCycle }))} />}

      {tab === 'balance' && <BalanceTab centres={centres.data} ledger={ledger} loading={loading || orders.loading} range={range} setRange={setRange} />}

      {tab === 'notes' && <NotesTab centres={centres.data} notes={notes.data} loading={notes.loading} profile={profile} range={range} setRange={setRange} />}

      {tab === 'discount' && <DiscountTab centres={centres.data} txns={sortedTxns} profile={profile} rates={rates.data} orders={orders.data} />}

      <CentreDrawer value={edit} onClose={() => setEdit(null)} />
      <PriceListDrawer open={!!pl} onClose={() => setPl(null)} owner={pl && { collection: 'b2bCentres', id: pl.id, name: pl.name, rateListId: pl.rateListId, kind: 'b2b' }} />
      <AddMoney open={addMoney} onClose={() => setAddMoney(false)} centres={centres.data} profile={profile} canApprove={canApprove} />
      <BulkPriceEdit open={bulkPrice} onClose={() => setBulkPrice(false)} />
      <BulkUpload open={bulkUp} onClose={() => setBulkUp(false)} />
    </div>
  )
}

// ---- Add money --------------------------------------------------------------

function AddMoney({ open, onClose, centres, profile, canApprove }: { open: boolean; onClose: () => void; centres: B2BCentre[]; profile: { name?: string } | null; canApprove: boolean }) {
  const [form] = Form.useForm()
  const run = async () => {
    const v = await form.validateFields()
    const c = centres.find((x) => x.id === v.centreId)!
    if (v.mode === 'online') {
      // Through the payment gateway: the server posts the approved top-up once the payment is verified.
      try {
        await payOnline({ purpose: 'b2bTopup', refId: c.id, amount: toPaise(v.amount), branchId: branchStamp().branchId, description: c.name })
        message.success('Payment received and added to the wallet')
        form.resetFields()
        onClose()
      } catch (e) {
        if ((e as Error).message !== 'Payment cancelled.') message.error((e as Error).message)
      }
      return
    }
    try {
      await addDoc(col('walletTxns'), {
        ...branchStamp(), centreId: c.id, centreName: c.name, kind: 'topup', mode: v.mode, reference: v.reference ?? '', amount: toPaise(v.amount),
        status: v.approveNow && canApprove ? 'approved' : 'pending', remark: v.remark ?? '', ...who(profile), at: serverTimestamp(),
      })
      void auditWalletChange(c.name, `b2bCentres/${c.id}`, toPaise(v.amount), v.approveNow && canApprove ? 'top-up' : 'top-up requested', v.remark ?? '')
      message.success(v.approveNow && canApprove ? 'Money added' : 'Top-up recorded and waiting for approval')
      form.resetFields()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Modal open={open} onCancel={onClose} onOk={run} okText="Add money" title="Add money to wallet" destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ mode: 'upi' }}>
        <Form.Item name="centreId" label="B2B lab" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={centres.map((c) => ({ value: c.id, label: c.name }))} /></Form.Item>
        <div className="pt-grid2">
          <Form.Item name="amount" label="Amount (Rs)" rules={[{ required: true }, { type: 'number', min: 1, message: 'Enter an amount' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="mode" label="Mode"><Select options={MODES} /></Form.Item>
        </div>
        <Form.Item name="reference" label="Transaction ID / reference"><Input /></Form.Item>
        <Form.Item name="remark" label="Remark"><Input /></Form.Item>
        {canApprove && <Form.Item name="approveNow" valuePropName="checked"><Checkbox>I verified this payment: approve now</Checkbox></Form.Item>}
      </Form>
    </Modal>
  )
}

// ---- Balance ------------------------------------------------------------------

function BalanceTab({ centres, ledger, loading, range, setRange }: { centres: B2BCentre[]; ledger: ReturnType<typeof buildLedger>; loading: boolean; range: Range; setRange: (r: Range) => void }) {
  const [mode, setMode] = useState<'day' | 'b2b'>('day')
  const from = range[0].startOf('day').valueOf()
  const to = range[1].endOf('day').valueOf()
  const rows = useMemo(() => {
    const out: { id: string; date: string; name: string; opening: number; closing: number; collected: number }[] = []
    for (const c of centres) {
      const mine = ledger.filter((r) => r.centreId === c.id)
      const before = mine.filter((r) => r.at.getTime() < from)
      let opening = before.length ? before[before.length - 1].balance : 0
      const within = mine.filter((r) => r.at.getTime() >= from && r.at.getTime() <= to)
      if (mode === 'b2b') {
        out.push({ id: c.id, date: '', name: c.name, opening, closing: within.length ? within[within.length - 1].balance : opening, collected: within.filter((r) => r.kind === 'topup').reduce((s, r) => s + r.credit, 0) })
        continue
      }
      const days = new Map<string, typeof within>()
      for (const r of within) days.set(dayjs(r.at).format('YYYY-MM-DD'), [...(days.get(dayjs(r.at).format('YYYY-MM-DD')) ?? []), r])
      for (const [d, list] of days) {
        const closing = list[list.length - 1].balance
        out.push({ id: `${c.id}-${d}`, date: d, name: c.name, opening, closing, collected: list.filter((r) => r.kind === 'topup').reduce((s, r) => s + r.credit, 0) })
        opening = closing
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
  }, [centres, ledger, from, to, mode])
  return (
    <>
      <div className="pt-tabs"><Segmented aria-label="Balance grouping" size="small" value={mode} onChange={setMode} options={[{ value: 'day', label: 'Day wise' }, { value: 'b2b', label: 'B2B wise' }]} /></div>
      <DataTable<(typeof rows)[number]>
        loading={loading}
        dataSource={rows}
        emptyTitle="No balance movement in this range"
        toolbar={
          <Toolbar>
            <RangeField value={range} onChange={setRange} />
            <Spacer />
            <Button icon={<DownloadOutlined />} onClick={() => downloadCsv(`balance-${mode}`, [['date', 'lab', 'opening', 'closing', 'payment collected'], ...rows.map((r) => [r.date, r.name, r.opening / 100, r.closing / 100, r.collected / 100])])}>Export CSV</Button>
          </Toolbar>
        }
        columns={[
          ...(mode === 'day' ? [{ title: 'Date', dataIndex: 'date' }] : []),
          { title: 'B2B name', dataIndex: 'name' },
          { title: 'Opening balance', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => <span className="pt-num">{formatINR(r.opening)}</span> },
          { title: 'Closing balance', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => <span className="pt-num">{formatINR(r.closing)}</span> },
          { title: 'Payment collected', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => <span className="pt-num">{formatINR(r.collected)}</span> },
        ]}
      />
    </>
  )
}

// ---- Credit / debit notes ---------------------------------------------------

function NotesTab({ centres, notes, loading, profile, range, setRange }: { centres: B2BCentre[]; notes: CreditNote[]; loading: boolean; profile: { name?: string } | null; range: Range; setRange: (r: Range) => void }) {
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const rows = [...notes].sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0)).filter((n) => { const t = n.at?.toMillis?.() ?? Date.now(); return t >= range[0].startOf('day').valueOf() && t <= range[1].endOf('day').valueOf() })
  const run = async () => {
    const v = await form.validateFields()
    const c = centres.find((x) => x.id === v.centreId)!
    try {
      await addDoc(col('creditNotes'), { ...branchStamp(), centreId: c.id, centreName: c.name, kind: v.kind, amount: toPaise(v.amount), reason: v.reason, remark: v.remark ?? '', ...who(profile), at: serverTimestamp() })
      message.success('Note posted')
      form.resetFields()
      setOpen(false)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <>
      <DataTable<CreditNote>
        loading={loading}
        dataSource={rows}
        emptyTitle="No credit or debit notes"
        toolbar={
          <Toolbar>
            <RangeField value={range} onChange={setRange} />
            <Spacer />
            <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('credit-debit-notes', [['date', 'lab', 'user', 'credit', 'debit', 'reason', 'remark'], ...rows.map((n) => [fmtDateTime(n.at?.toDate?.()), n.centreName, n.byName, n.kind === 'credit' ? n.amount / 100 : '', n.kind === 'debit' ? n.amount / 100 : '', n.reason, n.remark])])}>Export CSV</Button>
            <Button variant="primary" onClick={() => setOpen(true)}>Credit / debit amount</Button>
          </Toolbar>
        }
        columns={[
          { title: 'Date and time', render: (_, n) => fmtDateTime(n.at?.toDate?.()) },
          { title: 'B2B lab', dataIndex: 'centreName' },
          { title: 'User', dataIndex: 'byName' },
          { title: 'Credit amount', align: 'right', render: (_, n) => <span className="pt-num">{n.kind === 'credit' ? formatINR(n.amount) : ''}</span> },
          { title: 'Debit amount', align: 'right', render: (_, n) => <span className="pt-num">{n.kind === 'debit' ? formatINR(n.amount) : ''}</span> },
          { title: 'Reason', dataIndex: 'reason' },
          { title: 'Remark', dataIndex: 'remark' },
        ]}
      />
      <Modal open={open} onCancel={() => setOpen(false)} onOk={run} okText="Post note" title="Credit / debit note" destroyOnHidden>
        <Form form={form} layout="vertical" initialValues={{ kind: 'credit' }}>
          <Form.Item name="centreId" label="B2B lab" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={centres.map((c) => ({ value: c.id, label: c.name }))} /></Form.Item>
          <div className="pt-grid2">
            <Form.Item name="kind" label="Type"><Select options={[{ value: 'credit', label: 'Credit (adds to wallet)' }, { value: 'debit', label: 'Debit (reduces wallet)' }]} /></Form.Item>
            <Form.Item name="amount" label="Amount (Rs)" rules={[{ required: true }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item>
          </div>
          <Form.Item name="reason" label="Reason" rules={[{ required: true, message: 'A reason is required' }]}><Input /></Form.Item>
          <Form.Item name="remark" label="Remark"><Input /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}

// ---- Bulk discount ------------------------------------------------------------

function DiscountTab({ centres, txns, profile, rates, orders }: { centres: B2BCentre[]; txns: WalletTxn[]; profile: { name?: string } | null; rates: { id: string; entries: Record<string, number> }[]; orders: PartnerOrder[] }) {
  const { tests, packages, departments, testById } = useCatalogueMaps()
  const { constraints, key } = useBranchScope()
  const invoices = useLiveQuery<PartnerInvoice>(query(col('partnerInvoices'), ...constraints), [key])
  const [dept, setDept] = useState<string>('all')
  const [dueRange, setDueRange] = useState<Range>(thisMonth())
  const [dueBusy, setDueBusy] = useState(false)
  const [cid, setCid] = useState<string>()
  const [pct, setPct] = useState<number | null>(null)
  const [base, setBase] = useState<'mrp' | 'current'>('mrp')
  const [form] = Form.useForm()
  const apply = async () => {
    const c = centres.find((x) => x.id === cid)
    if (!c || pct === null) return
    try {
      const id = await ensureRateList('b2bCentres', c.id, c.name, 'b2b', c.rateListId)
      const cur = rates.find((r) => r.id === id)?.entries ?? {}
      const entries: Record<string, number> = { ...cur }
      // Department scope: only that department's tests (packages span departments, so they are left alone).
      const scope = dept === 'all' ? [...tests.filter((t) => !t.disabled), ...packages.filter((p) => !p.disabled)] : tests.filter((t) => !t.disabled && t.departmentId === dept)
      for (const it of scope) {
        const start = base === 'current' && cur[it.id] !== undefined ? cur[it.id] : it.price
        entries[it.id] = Math.max(0, Math.round((start * (100 - pct)) / 100))
      }
      await saveMaster('rateLists', id, { entries })
      message.success(`${pct}% discount applied to ${scope.length} item(s) in ${c.name}'s price list`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const record = async () => {
    const v = await form.validateFields()
    const c = centres.find((x) => x.id === v.centreId)!
    try {
      await addDoc(col('walletTxns'), { ...branchStamp(), centreId: c.id, centreName: c.name, kind: 'discount', mode: v.mode, reference: '', amount: toPaise(v.amount), status: 'approved', remark: v.reason, ...who(profile), at: serverTimestamp() })
      void auditWalletChange(c.name, `b2bCentres/${c.id}`, toPaise(v.amount), 'discount', v.reason ?? '')
      message.success('Discount recorded')
      form.resetFields()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const history = txns.filter((t) => t.kind === 'discount')

  // Due bills: the centre's bills in the range that are not on a paid invoice. The discount is worked out on the
  // chosen department's lines (every non-charge line when "all") and applied as one credit note.
  const paidOrderIds = useMemo(() => new Set(invoices.data.filter((i) => i.kind === 'b2b' && i.status === 'paid').flatMap((i) => i.orderIds)), [invoices.data])
  const duePreview = useMemo(() => {
    if (!cid || pct === null) return []
    const from = dueRange[0].startOf('day').valueOf()
    const to = dueRange[1].endOf('day').valueOf()
    return orders
      .filter((o) => o.b2bCentreId === cid && !paidOrderIds.has(o.id) && o.createdAt?.toMillis && o.createdAt.toMillis() >= from && o.createdAt.toMillis() <= to)
      .map((o) => {
        const base = o.items
          .filter((i) => i.status !== 'refunded' && !i.isCharge && (dept === 'all' || i.testIds.some((t) => testById.get(t)?.departmentId === dept)))
          .reduce((n, i) => n + (i.price - i.discount), 0)
        return { id: o.id, billNo: o.billNo, patient: o.patientName, base, discount: Math.round((base * pct) / 100) }
      })
      .filter((r) => r.discount > 0)
  }, [orders, cid, pct, dept, dueRange, paidOrderIds, testById])
  const dueTotal = duePreview.reduce((n, r) => n + r.discount, 0)
  const applyDue = async () => {
    const c = centres.find((x) => x.id === cid)
    if (!c || !dueTotal) return
    setDueBusy(true)
    try {
      await addDoc(col('creditNotes'), {
        ...branchStamp(), centreId: c.id, centreName: c.name, kind: 'credit', amount: dueTotal,
        reason: `Bulk discount ${pct}% on ${duePreview.length} due bill(s)${dept === 'all' ? '' : ` (${departments.find((d) => d.id === dept)?.name ?? 'department'})`}`,
        remark: duePreview.map((r) => r.billNo).join(', '), ...who(profile), at: serverTimestamp(),
      })
      message.success(`Credit note of ${formatINR(dueTotal)} recorded for ${c.name}`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setDueBusy(false)
    }
  }
  return (
    <div className="pt-stack">
      <Section title="Percentage discount on a price list">
        <Toolbar>
          <Select aria-label="B2B lab" placeholder="B2B lab" style={{ minWidth: 220 }} value={cid} onChange={setCid} showSearch optionFilterProp="label" options={centres.map((c) => ({ value: c.id, label: c.name }))} />
          <Select aria-label="Department scope" style={{ width: 200 }} value={dept} onChange={setDept} options={[{ value: 'all', label: 'All departments' }, ...departments.map((d) => ({ value: d.id, label: d.name }))]} />
          <Select aria-label="Discount base" style={{ width: 200 }} value={base} onChange={setBase} options={[{ value: 'mrp', label: 'Off MRP' }, { value: 'current', label: 'Off current list price' }]} />
          <InputNumber aria-label="Discount percent" placeholder="Discount %" min={0} max={100} value={pct} onChange={setPct} />
          <Button variant="primary" onClick={apply} disabled={!cid || pct === null}>Apply discount</Button>
        </Toolbar>
        <p className="pt-muted" style={{ margin: 0 }}>Rewrites every test and package price in the lab's list. Review it afterwards in Price list.</p>
      </Section>
      <Section title="Discount on due bills (credit note)">
        <Toolbar>
          <RangeField value={dueRange} onChange={setDueRange} />
          <span className="pt-muted">Uses the B2B lab, department and percent chosen above.</span>
          <Spacer />
          <Button variant="primary" disabled={!dueTotal || dueBusy} onClick={applyDue}>Apply {dueTotal ? formatINR(dueTotal) : ''} as credit note</Button>
        </Toolbar>
        <DataTable<{ id: string; billNo: string; patient: string; base: number; discount: number }>
          loading={false}
          dataSource={duePreview}
          emptyTitle={cid && pct !== null ? 'No due bills in this period' : 'Pick a B2B lab and a percent to preview'}
          columns={[
            { title: 'Bill', dataIndex: 'billNo' },
            { title: 'Patient', dataIndex: 'patient' },
            { title: 'Discountable amount', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.base)}</span> },
            { title: 'Discount', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.discount)}</span> },
          ]}
        />
      </Section>
      <Section title="Record a discount against dues">
        <Form form={form} layout="inline" initialValues={{ mode: 'cash' }} style={{ rowGap: 12 }}>
          <Form.Item name="centreId" rules={[{ required: true }]}><Select aria-label="B2B lab" placeholder="B2B lab" style={{ minWidth: 200 }} showSearch optionFilterProp="label" options={centres.map((c) => ({ value: c.id, label: c.name }))} /></Form.Item>
          <Form.Item name="amount" rules={[{ required: true }]}><InputNumber aria-label="Discount amount in rupees" placeholder="Amount (Rs)" min={0} precision={2} /></Form.Item>
          <Form.Item name="mode"><Select aria-label="Mode" style={{ width: 130 }} options={MODES.filter((m) => m.value !== 'online')} /></Form.Item>
          <Form.Item name="reason" rules={[{ required: true, message: 'Reason required' }]}><Input aria-label="Reason" placeholder="Reason" style={{ width: 220 }} /></Form.Item>
          <Button onClick={record}>Record discount</Button>
        </Form>
      </Section>
      <DataTable<WalletTxn>
        loading={false}
        dataSource={history}
        emptyTitle="No discounts recorded"
        columns={[
          { title: 'Date and time', render: (_, t) => fmtDateTime(t.at?.toDate?.()) },
          { title: 'B2B lab', dataIndex: 'centreName' },
          { title: 'Discount', align: 'right', render: (_, t) => <span className="pt-num">{formatINR(t.amount)}</span> },
          { title: 'Mode', dataIndex: 'mode' },
          { title: 'Reason', dataIndex: 'remark' },
          { title: 'User', dataIndex: 'byName' },
        ]}
      />
    </div>
  )
}

// ---- Add / edit centre ----------------------------------------------------------

function CentreDrawer({ value, onClose }: { value: Partial<B2BCentre> | null; onClose: () => void }) {
  const [form] = Form.useForm()
  const submit = async () => {
    const v = await form.validateFields()
    const settings: Partial<B2BSettings> = {}
    for (const k of Object.keys(SETTING_LABELS) as (keyof B2BSettings)[]) settings[k] = !!v[`s_${k}`]
    const clean = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('s_')))
    try {
      await saveMaster('b2bCentres', value?.id ?? null, {
        ...clean, securityAmount: toPaise(v.securityRs ?? 0), creditLimit: toPaise(v.creditLimitRs ?? 0), lowBalanceAlert: toPaise(v.lowRs ?? 0),
        securityRs: undefined, creditLimitRs: undefined, lowRs: undefined, settings, rateListId: value?.rateListId ?? '',
      })
      message.success('Saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const init: Record<string, unknown> = { paymentMethod: 'manual', creditType: 'creditLimit', ...value, securityRs: (value?.securityAmount ?? 0) / 100, creditLimitRs: (value?.creditLimit ?? 0) / 100, lowRs: (value?.lowBalanceAlert ?? 0) / 100 }
  for (const k of Object.keys(SETTING_LABELS) as (keyof B2BSettings)[]) init[`s_${k}`] = !!value?.settings?.[k]
  const sw = (k: keyof B2BSettings) => <Form.Item key={k} name={`s_${k}`} label={SETTING_LABELS[k]} valuePropName="checked"><Switch /></Form.Item>
  return (
    <Drawer open={!!value} onClose={onClose} size="large" destroyOnHidden title={value?.id ? 'Edit B2B lab' : 'New B2B lab'}
      footer={<div className="pt-sticky-foot"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save</Button></div>}>
      <Form form={form} layout="vertical" initialValues={init}>
        <Section title="Lab details">
          <div className="pt-grid2">
            <Form.Item name="name" label="Lab name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="code" label="Centre code"><Input /></Form.Item>
            <Form.Item name="city" label="City"><Input /></Form.Item>
            <Form.Item name="phone" label="Phone"><Input /></Form.Item>
            <Form.Item name="email" label="Login email (portal)" rules={[{ required: true, type: 'email', message: 'A valid email is required' }]}><Input /></Form.Item>
            <Form.Item name="active" label="Active" valuePropName="checked"><Switch /></Form.Item>
          </div>
          <Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item>
        </Section>
        <Section title="Financial management">
          <div className="pt-grid2">
            <Form.Item name="creditType" label="Credit type" style={{ gridColumn: "1 / -1" }}><Select options={[{ value: 'prepaid', label: 'Prepaid wallet (bills must be covered by the balance)' }, { value: 'creditLimit', label: 'Credit limit (balance may go negative to the limit)' }, { value: 'rollingAdvance', label: 'Rolling advance (limit is the advance kept in the wallet)' }]} /></Form.Item>
            <Form.Item name="creditLimitRs" label="Credit limit (Rs)"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="securityRs" label="Security amount (Rs)"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="lowRs" label="Low balance alert (Rs)"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="gstin" label="GSTIN"><Input /></Form.Item>
            <Form.Item name="invoiceCycle" label="Invoice cycle" tooltip="Blank uses the lab default (Lab settings > B2B)"><Select allowClear options={[{ value: 'perBill', label: 'Per bill' }, { value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' }]} /></Form.Item>
            <Form.Item name="paymentMethod" label="Payment method"><Select options={[{ value: 'manual', label: 'Manual' }, { value: 'online', label: 'Pay online' }]} /></Form.Item>
          </div>
          <Form.Item name="paymentTerms" label="Payment terms"><Input.TextArea rows={2} /></Form.Item>
        </Section>
        <Section title="Tab access">
          <div className="pt-grid3">{TAB_SETTINGS.map(sw)}</div>
        </Section>
        <Section title="Permissions and security">
          <div className="pt-grid2">{(Object.keys(SETTING_LABELS) as (keyof B2BSettings)[]).filter((k) => !TAB_SETTINGS.includes(k)).map(sw)}</div>
        </Section>
        <Section title="Bank details">
          <div className="pt-grid2">
            <Form.Item name={['bank', 'bank']} label="Bank"><Input /></Form.Item>
            <Form.Item name={['bank', 'account']} label="Account number"><Input /></Form.Item>
            <Form.Item name={['bank', 'ifsc']} label="IFSC"><Input /></Form.Item>
            <Form.Item name={['bank', 'pan']} label="PAN"><Input /></Form.Item>
          </div>
        </Section>
      </Form>
    </Drawer>
  )
}

// ---- Bulk price edit and bulk upload ----------------------------------------------

function BulkPriceEdit({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rates = useRateLists()
  const [ids, setIds] = useState<string[]>([])
  const [pct, setPct] = useState<number | null>(null)
  const run = async () => {
    if (pct === null) return
    try {
      for (const id of ids) {
        const l = rates.data.find((r) => r.id === id)
        if (!l) continue
        const entries = Object.fromEntries(Object.entries(l.entries ?? {}).map(([k, v]) => [k, Math.max(0, Math.round((v * (100 + pct)) / 100))]))
        await saveMaster('rateLists', id, { entries })
      }
      message.success(`Changed ${ids.length} list(s) by ${pct}%`)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Modal open={open} onCancel={onClose} onOk={run} okText="Apply" okButtonProps={{ disabled: !ids.length || pct === null }} title="Bulk price edit" destroyOnHidden>
      <div className="pt-stack">
        <Select mode="multiple" aria-label="Price lists" placeholder="Choose price lists" optionFilterProp="label" value={ids} onChange={setIds}
          options={rates.data.map((r) => ({ value: r.id, label: `${r.name} (${r.kind})` }))} />
        <InputNumber aria-label="Percent change" placeholder="Change in % (negative to reduce)" value={pct} onChange={setPct} style={{ width: '100%' }} />
        <p className="pt-muted" style={{ margin: 0 }}>Changes every price already in the chosen lists by the percentage.</p>
      </div>
    </Modal>
  )
}

function BulkUpload({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const valid = rows.filter((r) => r.name)
  const run = async () => {
    try {
      for (const r of valid) {
        await saveMaster('b2bCentres', null, {
          name: r.name, code: r.code ?? '', city: r.city ?? '', phone: r.phone ?? '', email: r.email ?? '', address: r.address ?? '', active: true,
          creditType: r.credittype === 'rollingAdvance' ? 'rollingAdvance' : r.credittype === 'prepaid' ? 'prepaid' : 'creditLimit', securityAmount: 0, creditLimit: toPaise(parseFloat(r.creditlimit) || 0), lowBalanceAlert: 0,
          paymentTerms: '', paymentMethod: 'manual', rateListId: '', bank: { bank: '', account: '', ifsc: '', pan: '' }, settings: {},
        })
      }
      message.success(`Imported ${valid.length} B2B lab(s)`)
      setRows([])
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Modal open={open} onCancel={onClose} onOk={run} okText={`Import ${valid.length}`} okButtonProps={{ disabled: !valid.length }} title="Bulk upload B2B labs" destroyOnHidden>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('b2b-template', [['name', 'code', 'city', 'phone', 'email', 'creditType', 'creditLimit'], ['Example Diagnostics', 'EX01', 'Pune', '9999999999', 'lab@example.com', 'creditLimit', '50000']])}>Download template</Button>
        <FileButton label="Choose CSV" icon={<UploadOutlined />} onText={(t) => setRows(parseCsvObjects(t))} />
      </div>
      {rows.length > 0 && <p>{valid.length} valid row(s) of {rows.length}. creditType is creditLimit, prepaid or rollingAdvance; creditLimit is in rupees.</p>}
    </Modal>
  )
}
