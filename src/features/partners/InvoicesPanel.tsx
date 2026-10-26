import { useMemo, useState } from 'react'
import { DatePicker, Modal, Popconfirm, Select, Table, message } from 'antd'
import { addDoc, deleteDoc, query, serverTimestamp, setDoc } from 'firebase/firestore'
import dayjs from 'dayjs'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { auth } from '../../firebase'
import { branchStamp, branchCounterName } from '../../lib/activeBranch'
import { col, docRef, nextCounter } from '../../lib/db'
import { financialYear } from '../../lib/orders'
import { useBranchScope } from '../../lib/branchScope'
import { useLiveQuery } from '../../hooks/useLive'
import { useLabSettings } from '../../hooks/useCatalogue'
import { formatINR, rupeesInWords } from '../../lib/money'
import { downloadCsv } from './lib/csv'
import { esc, printHtml } from './lib/print'
import { orderDate, useOrdersByPartner, type Range } from './lib/orders'
import type { PartnerInvoice, PartnerOrder } from './types'
import { DataTable, fmtDate, RangeField, Spacer, thisMonth, Toolbar } from './ui'

export interface Party {
  id: string
  name: string
  code?: string
  address?: string
  gstin?: string
  cycle?: 'perBill' | 'weekly' | 'fortnightly' | 'monthly' // the centre's own invoice cycle, if set
  creditDays?: number // corporate clients: invoice due date = invoice date + credit days
}

type Cycle = 'perBill' | 'weekly' | 'fortnightly' | 'monthly'
// Invoice settings for this kind (Lab profile > B2B / Corporate invoice).
export function invoiceCfg(settings: ReturnType<typeof useLabSettings>, kind: 'b2b' | 'corporate') {
  const c = kind === 'b2b' ? settings.b2bInvoice : settings.corporateInvoice
  const fallback = kind === 'b2b' ? 'B2B-' : 'CORP-'
  return { ...c, prefix: c?.prefix?.trim() ? c.prefix.trim() : fallback, defaultCycle: ((kind === 'b2b' && (!c?.cycle || c.cycle === 'monthly') ? settings.b2bLab?.invoiceCycle : undefined) ?? c?.cycle ?? 'monthly') as Cycle }
}
const cycleRange = (c: Cycle): Range =>
  c === 'weekly' ? [dayjs().subtract(6, 'day'), dayjs()] : c === 'fortnightly' ? [dayjs().subtract(14, 'day'), dayjs()] : c === 'perBill' ? [dayjs().startOf('day'), dayjs()] : thisMonth()

const variant = { draft: 'neutral', sent: 'info', paid: 'success' } as const

// Invoices (partnerInvoices) for B2B labs or corporate clients, generated from the
// party's bills in a period. Bills already on an invoice are not billed twice.
export function InvoicesPanel({ kind, parties, field }: { kind: 'b2b' | 'corporate'; parties: Party[]; field: 'b2bCentreId' | 'corporateClientId' }) {
  const { constraints, key } = useBranchScope()
  const inv = useLiveQuery<PartnerInvoice>(query(col('partnerInvoices'), ...constraints), [key])
  const orders = useOrdersByPartner(field, parties.map((p) => p.id))
  const settings = useLabSettings()
  const [pf, setPf] = useState<string>('all')
  const [sf, setSf] = useState<string>('all')
  const [open, setOpen] = useState(false)
  const [bulk, setBulk] = useState(false)
  const [preview, setPreview] = useState<PartnerInvoice | null>(null)

  const rows = useMemo(
    () =>
      inv.data
        .filter((i) => i.kind === kind && (pf === 'all' || i.partyId === pf) && (sf === 'all' || i.status === sf))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)),
    [inv.data, kind, pf, sf],
  )
  const invoiced = useMemo(() => new Set(inv.data.filter((i) => i.kind === kind).flatMap((i) => i.orderIds)), [inv.data, kind])

  const setStatus = async (i: PartnerInvoice, status: PartnerInvoice['status']) => {
    await setDoc(docRef('partnerInvoices', i.id), { status, paid: status === 'paid' ? i.amount : status === 'draft' ? 0 : i.paid, updatedAt: serverTimestamp() }, { merge: true })
    message.success(`Marked ${status}`)
  }
  // Refresh a draft: pull the party's bills in the invoice period again (new bills in, deleted bills out).
  const refresh = async (i: PartnerInvoice) => {
    const from = dayjs(i.periodFrom).startOf('day').valueOf()
    const to = dayjs(i.periodTo).endOf('day').valueOf()
    const otherInvoiced = new Set(inv.data.filter((x) => x.kind === kind && x.id !== i.id).flatMap((x) => x.orderIds))
    const bills = orders.data.filter((o) => o[field] === i.partyId && !otherInvoiced.has(o.id) && orderDate(o).getTime() >= from && orderDate(o).getTime() <= to)
    await setDoc(docRef('partnerInvoices', i.id), {
      orderIds: bills.map((o) => o.id),
      amount: bills.reduce((n, o) => n + o.net, 0),
      lines: bills.map((o) => ({ orderId: o.id, billNo: o.billNo, patientName: o.patientName, date: dayjs(orderDate(o)).format('YYYY-MM-DD'), amount: o.net, items: o.items.map((x) => x.name).join(', ') })),
      updatedAt: serverTimestamp(),
    }, { merge: true })
    message.success(`Refreshed: ${bills.length} bill(s)`)
  }
  const removeDraft = async (i: PartnerInvoice) => {
    try {
      await deleteDoc(docRef('partnerInvoices', i.id))
      message.success('Draft deleted; its bills can be invoiced again')
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const toggleDispatch = (i: PartnerInvoice) => setDoc(docRef('partnerInvoices', i.id), { dispatched: !i.dispatched }, { merge: true })

  const print = (i: PartnerInvoice) => {
    const cfg = invoiceCfg(settings, kind)
    const detailed = cfg.detailedView === 'test'
    const party = parties.find((p) => p.id === i.partyId)
    const bank = [cfg.bankName, cfg.bankAccountName && `A/c name ${cfg.bankAccountName}`, cfg.bankAccountNo && `A/c no ${cfg.bankAccountNo}`, cfg.bankIfsc && `IFSC ${cfg.bankIfsc}`].filter(Boolean).join(' | ')
    const body = `<div class="meta"><div><h1>Invoice ${esc(i.number)}</h1><div class="muted">${esc(settings.name)}<br>${esc(settings.address)}</div></div>
<div><b>${esc(i.partyName)}</b> ${esc(i.partyCode)}<br>Period ${esc(i.periodFrom)} to ${esc(i.periodTo)}<br>Due ${esc(i.dueDate)}${party?.gstin ? `<br>GSTIN ${esc(party.gstin)}` : ''}</div></div>
<table><tr><th>Bill</th><th>Date</th><th>Patient</th>${detailed ? '<th>Tests</th>' : ''}<th class="n">Amount</th></tr>
${i.lines.map((l) => `<tr><td>${esc(l.billNo)}</td><td>${esc(l.date)}</td><td>${esc(l.patientName)}</td>${detailed ? `<td>${esc(l.items ?? '')}</td>` : ''}<td class="n">${formatINR(l.amount)}</td></tr>`).join('')}
<tr><th colspan="${detailed ? 4 : 3}">Total</th><th class="n">${formatINR(i.amount)}</th></tr></table>
<p>${esc(rupeesInWords(i.amount))}</p><p>Paid ${formatINR(i.paid)} / Due ${formatINR(i.amount - i.paid)}</p>
${bank ? `<p><b>Bank details</b><br>${esc(bank)}</p>` : ''}${cfg.upiId ? `<p>UPI: ${esc(cfg.upiId)}</p>` : ''}${cfg.terms ? `<p class="muted">${esc(cfg.terms)}</p>` : ''}`
    if (!printHtml(`Invoice ${i.number}`, body)) message.warning('Allow pop-ups to print the invoice')
  }

  return (
    <>
      <DataTable<PartnerInvoice>
        loading={inv.loading}
        dataSource={rows}
        emptyTitle="No invoices yet"
        emptyHint="Create an invoice for a period from the bills of a partner."
        toolbar={
          <Toolbar>
            <Select aria-label="Filter partner" style={{ minWidth: 200 }} value={pf} onChange={setPf} showSearch optionFilterProp="label" options={[{ value: 'all', label: 'All' }, ...parties.map((p) => ({ value: p.id, label: p.name }))]} />
            <Select aria-label="Filter status" style={{ width: 140 }} value={sf} onChange={setSf} options={[{ value: 'all', label: 'All statuses' }, { value: 'draft', label: 'Draft' }, { value: 'sent', label: 'Sent' }, { value: 'paid', label: 'Paid' }]} />
            <Spacer />
            <Button onClick={() => setBulk(true)}>Bulk invoice</Button>
            <Button variant="primary" onClick={() => setOpen(true)}>Create invoice</Button>
            <Button onClick={() => downloadCsv(`${kind}-invoices`, [['created', 'party', 'number', 'period', 'amount', 'paid', 'due', 'status', 'dispatched'], ...rows.map((i) => [fmtDate(i.createdAt?.toDate?.()), i.partyName, i.number, `${i.periodFrom} to ${i.periodTo}`, i.amount / 100, i.paid / 100, (i.amount - i.paid) / 100, i.status, i.dispatched])])}>Export CSV</Button>
          </Toolbar>
        }
        columns={[
          { title: 'Created', render: (_, i) => fmtDate(i.createdAt?.toDate?.()) },
          { title: 'Name', render: (_, i) => <span>{i.partyName} <span className="pt-muted">{i.partyCode}</span></span> },
          { title: 'Invoice no.', dataIndex: 'number' },
          { title: 'Duration', render: (_, i) => `${i.periodFrom} to ${i.periodTo}` },
          { title: 'Amount', align: 'right', render: (_, i) => <span className="pt-num">{formatINR(i.amount)}</span> },
          { title: 'Paid', align: 'right', render: (_, i) => <span className="pt-num">{formatINR(i.paid)}</span> },
          { title: 'Due', align: 'right', render: (_, i) => <span className="pt-num">{formatINR(i.amount - i.paid)}</span> },
          { title: 'Status', render: (_, i) => <StatusChip variant={variant[i.status]}>{i.status[0].toUpperCase() + i.status.slice(1)}</StatusChip> },
          { title: 'Dispatched', render: (_, i) => <Button variant="text" aria-pressed={i.dispatched} onClick={() => toggleDispatch(i)}>{i.dispatched ? 'Yes' : 'No'}</Button> },
          {
            title: 'Actions',
            render: (_, i) => (
              <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                <Button variant="text" onClick={() => setPreview(i)} aria-label={`Preview invoice ${i.number}`}>Preview</Button>
                <Button variant="text" onClick={() => print(i)} aria-label={`Print invoice ${i.number}`}>Print</Button>
                {i.status === 'draft' && <Button variant="text" onClick={() => refresh(i)} aria-label={`Refresh invoice ${i.number}`}>Refresh</Button>}
                {i.status === 'draft' && (
                  <Popconfirm title={`Delete draft ${i.number}?`} okText="Delete" onConfirm={() => removeDraft(i)}>
                    <Button variant="text" aria-label={`Delete invoice ${i.number}`}>Delete</Button>
                  </Popconfirm>
                )}
                {i.status === 'draft' && <Button variant="text" onClick={() => setStatus(i, 'sent')} aria-label={`Send invoice ${i.number}`}>Send</Button>}
                {i.status !== 'paid' && <Button variant="text" onClick={() => setStatus(i, 'paid')} aria-label={`Mark invoice ${i.number} paid`}>Mark paid</Button>}
              </span>
            ),
          },
        ]}
      />
      <Modal open={!!preview} onCancel={() => setPreview(null)} footer={<><Button onClick={() => preview && print(preview)}>Print</Button><Button variant="primary" onClick={() => setPreview(null)}>Close</Button></>} title={`Invoice ${preview?.number ?? ''}`} width={720} destroyOnHidden>
        <p className="pt-muted">{preview?.partyName} · {preview?.periodFrom} to {preview?.periodTo} · due {preview?.dueDate}</p>
        <Table size="small" rowKey="orderId" pagination={{ pageSize: 8, hideOnSinglePage: true }} dataSource={preview?.lines ?? []}
          columns={[{ title: 'Bill', dataIndex: 'billNo' }, { title: 'Date', dataIndex: 'date' }, { title: 'Patient', dataIndex: 'patientName' }, { title: 'Amount', align: 'right', render: (_, l) => formatINR(l.amount) }]} />
        <p style={{ textAlign: 'right' }}><b>Total {formatINR(preview?.amount ?? 0)}</b> · paid {formatINR(preview?.paid ?? 0)}</p>
      </Modal>
      <CreateModal open={open || bulk} bulk={bulk} onClose={() => { setOpen(false); setBulk(false) }} kind={kind} parties={parties} orders={orders.data} invoiced={invoiced} />
    </>
  )
}

function CreateModal({ open, bulk, onClose, kind, parties, orders, invoiced }: { open: boolean; bulk: boolean; onClose: () => void; kind: 'b2b' | 'corporate'; parties: Party[]; orders: PartnerOrder[]; invoiced: Set<string> }) {
  const [party, setParty] = useState<string>()
  const settings = useLabSettings()
  const cfg = invoiceCfg(settings, kind)
  const [range, setRange] = useState<Range>(() => cycleRange(cfg.defaultCycle))
  const [due, setDue] = useState(dayjs().add(15, 'day'))
  const [status, setStatus] = useState<'draft' | 'sent'>('draft')
  const [busy, setBusy] = useState(false)
  const field = kind === 'b2b' ? 'b2bCentreId' : 'corporateClientId'
  const billsFor = (id: string) =>
    orders.filter((o) => o[field] === id && !invoiced.has(o.id) && (orderDate(o).getTime() >= range[0].startOf('day').valueOf() && orderDate(o).getTime() <= range[1].endOf('day').valueOf()))
  const targets = bulk ? parties : parties.filter((p) => p.id === party)

  const run = async () => {
    setBusy(true)
    try {
      let made = 0
      for (const p of targets) {
        const all = billsFor(p.id)
        if (!all.length) continue
        // A centre set to "per bill" gets one invoice per bill, otherwise one per period.
        const groups = (p.cycle ?? cfg.defaultCycle) === 'perBill' ? all.map((o) => [o]) : [all]
        for (const bills of groups) {
        const fy = financialYear()
        const n = await nextCounter(branchCounterName(`invoice-${kind}-${fy}`))
        const amount = bills.reduce((s, o) => s + o.net, 0)
        await addDoc(col('partnerInvoices'), {
          ...branchStamp(), kind, partyId: p.id, partyName: p.name, partyCode: p.code ?? '',
          number: `${cfg.prefix}${fy}-${String(n).padStart(4, '0')}`,
          periodFrom: range[0].format('YYYY-MM-DD'), periodTo: range[1].format('YYYY-MM-DD'), dueDate: (p.creditDays ? dayjs().add(p.creditDays, 'day') : due).format('YYYY-MM-DD'),
          amount, paid: 0, status, dispatched: false, orderIds: bills.map((o) => o.id),
          lines: bills.map((o) => ({ orderId: o.id, billNo: o.billNo, patientName: o.patientName, date: dayjs(orderDate(o)).format('YYYY-MM-DD'), amount: o.net, items: o.items.map((x) => x.name).join(', ') })),
          createdBy: auth.currentUser?.uid ?? '', createdAt: serverTimestamp(),
        })
        made++
        }
      }
      message.success(made ? `Created ${made} invoice(s)` : 'No un-invoiced bills in this period')
      if (made) onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const preview = party && !bulk ? billsFor(party) : []
  return (
    <Modal open={open} onCancel={onClose} title={bulk ? 'Bulk invoice' : 'Create invoice'} okText={bulk ? 'Create invoices' : 'Create'} onOk={run} okButtonProps={{ loading: busy, disabled: !bulk && !party }} destroyOnHidden>
      <div className="pt-stack">
        {!bulk && <Select aria-label="Partner" placeholder="Select partner" showSearch optionFilterProp="label" value={party} onChange={setParty} options={parties.map((p) => ({ value: p.id, label: p.name }))} />}
        <RangeField value={range} onChange={setRange} />
        <DatePicker aria-label="Invoice due date" value={due} onChange={(d) => d && setDue(d)} />
        <Select aria-label="Initial status" value={status} onChange={setStatus} options={[{ value: 'draft', label: 'Draft' }, { value: 'sent', label: 'Sent' }]} />
        {!bulk && party && <p className="pt-muted">{preview.length} un-invoiced bill(s), {formatINR(preview.reduce((s, o) => s + o.net, 0))}{parties.find((p) => p.id === party)?.creditDays ? `. Due date follows the client's ${parties.find((p) => p.id === party)?.creditDays}-day credit period.` : ''}</p>}
        {!bulk && party && preview.length > 0 && (
          <Table size="small" rowKey="id" pagination={{ pageSize: 5, hideOnSinglePage: true }} dataSource={preview}
            columns={[{ title: 'Bill', dataIndex: 'billNo' }, { title: 'Date', render: (_, o) => fmtDate(orderDate(o)) }, { title: 'Patient', dataIndex: 'patientName' }, { title: 'Net', align: 'right', render: (_, o) => formatINR(o.net) }]} />
        )}
        {bulk && <p className="pt-muted">One draft per partner that has un-invoiced bills in the period.</p>}
      </div>
    </Modal>
  )
}
