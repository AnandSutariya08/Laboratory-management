import { useMemo, useState } from 'react'
import { addDoc, query, serverTimestamp, where } from 'firebase/firestore'
import { App, Input, InputNumber, Modal, Select, Table } from 'antd'
import dayjs from 'dayjs'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { dialogWidth } from '../../design/dialog'
import { StatusChip } from '../../design/StatusChip'
import { useLiveQuery } from '../../hooks/useLive'
import { branchStamp } from '../../lib/activeBranch'
import { useBranchScope } from '../../lib/branchScope'
import { col } from '../../lib/db'
import { usePaymentModes } from '../../lib/masters'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { logActivity } from '../../lib/orders'
import { downloadCsv } from './lib/csv'
import { usePartnerOrders, type Range } from './lib/orders'
import type { CommissionSettlement, PartnerOrder } from './types'
import { Kpis, RangeField, Toolbar, Spacer, thisMonth } from './ui'

interface Partner { id: string; name: string }

// Commission accrual and payout ledger. Accrual is derived from the bills in the period (one shared
// calculation, see lib/commission.ts); each payout is an append-only commissionSettlements row, and a mistake is
// undone with a negative reversal row. Balance = accrued - paid out, per partner, for the chosen period.
export default function CommissionLedger({
  open,
  onClose,
  kind,
  partners,
  accruedFor,
  title,
}: {
  open: boolean
  onClose: () => void
  kind: 'referrer' | 'marketing'
  partners: Partner[]
  accruedFor: (partnerId: string, orders: PartnerOrder[]) => number
  title: string
}) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const scope = useBranchScope({ analytics: true })
  const modes = usePaymentModes()
  const [range, setRange] = useState<Range>(thisMonth())
  const [pay, setPay] = useState<{ partner: Partner; accrued: number; balance: number } | null>(null)
  const [amount, setAmount] = useState(0)
  const [mode, setMode] = useState('bank')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<Partner | null>(null)
  const [reverse, setReverse] = useState<CommissionSettlement | null>(null)
  const [reason, setReason] = useState('')

  const orders = usePartnerOrders(range)
  const from = range[0].format('YYYY-MM-DD')
  const to = range[1].format('YYYY-MM-DD')
  const settleQ = useMemo(() => (open ? query(col<CommissionSettlement>('commissionSettlements'), ...scope.constraints, where('partnerKind', '==', kind)) : null), [open, scope.key, kind])
  const settlements = useLiveQuery<CommissionSettlement>(settleQ, [open, scope.key, kind])
  const inPeriod = useMemo(() => settlements.data.filter((s) => s.periodFrom >= from && s.periodTo <= to), [settlements.data, from, to])

  const rows = useMemo(
    () =>
      partners
        .map((p) => {
          const accrued = accruedFor(p.id, orders.data)
          const paid = inPeriod.filter((s) => s.partnerId === p.id).reduce((n, s) => n + s.amount, 0)
          return { ...p, accrued, paid, balance: accrued - paid }
        })
        .filter((r) => r.accrued !== 0 || r.paid !== 0),
    [partners, orders.data, inPeriod, accruedFor],
  )
  const totals = rows.reduce((t, r) => ({ accrued: t.accrued + r.accrued, paid: t.paid + r.paid }), { accrued: 0, paid: 0 })
  const modeOptions = [...modes, { value: 'bank', label: 'Bank transfer' }, { value: 'cheque', label: 'Cheque' }].filter((m, i, a) => a.findIndex((x) => x.value === m.value) === i)

  const recordPayout = async () => {
    if (!pay || !profile) return
    const amt = toPaise(amount)
    if (amt <= 0) return message.warning('Enter the amount paid out.')
    if (amt > Math.max(0, pay.balance)) return message.warning('The payout is more than the balance owed for this period.')
    setBusy(true)
    try {
      await addDoc(col('commissionSettlements'), {
        ...branchStamp(),
        partnerKind: kind,
        partnerId: pay.partner.id,
        partnerName: pay.partner.name,
        kind: 'payout',
        periodFrom: from,
        periodTo: to,
        accrued: pay.accrued,
        amount: amt,
        mode,
        reference: reference.trim(),
        note: note.trim(),
        by: profile.uid,
        byName: profile.name,
        at: serverTimestamp(),
      })
      void logActivity('commissionPayout', `Commission payout of ${formatINR(amt)} to ${pay.partner.name} for ${from} to ${to}`, 'commissionSettlements', { category: 'BILLING', actor: profile })
      message.success('Payout recorded')
      setPay(null)
      setReference('')
      setNote('')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doReverse = async () => {
    if (!reverse || !profile) return
    if (!reason.trim()) return message.warning('Enter a reason.')
    if (settlements.data.some((s) => s.reversesId === reverse.id)) return message.warning('This payout was already reversed.')
    setBusy(true)
    try {
      await addDoc(col('commissionSettlements'), {
        ...branchStamp(),
        partnerKind: kind,
        partnerId: reverse.partnerId,
        partnerName: reverse.partnerName,
        kind: 'reversal',
        periodFrom: reverse.periodFrom,
        periodTo: reverse.periodTo,
        accrued: reverse.accrued,
        amount: -reverse.amount,
        mode: reverse.mode,
        reference: reverse.reference,
        note: reason.trim(),
        reversesId: reverse.id,
        by: profile.uid,
        byName: profile.name,
        at: serverTimestamp(),
      })
      message.success('Payout reversed')
      setReverse(null)
      setReason('')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const exportCsv = () =>
    downloadCsv(`${kind}-commission-ledger-${from}-${to}`, [
      ['name', 'accrued', 'paid out', 'balance'],
      ...rows.map((r) => [r.name, r.accrued / 100, r.paid / 100, r.balance / 100]),
    ])
  const reversedIds = new Set(settlements.data.map((s) => s.reversesId).filter(Boolean) as string[])
  const detailRows = detail ? settlements.data.filter((s) => s.partnerId === detail.id).sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0)) : []

  return (
    <Modal open={open} onCancel={onClose} width={dialogWidth(860)} title={title} footer={null} destroyOnHidden>
      <Toolbar>
        <RangeField value={range} onChange={setRange} />
        <Spacer />
        <Button onClick={exportCsv}>Export CSV</Button>
      </Toolbar>
      <Kpis items={[{ label: 'Accrued', value: formatINR(totals.accrued) }, { label: 'Paid out', value: formatINR(totals.paid) }, { label: 'Balance owed', value: formatINR(totals.accrued - totals.paid) }]} />
      <Table
        size="small"
        rowKey="id"
        loading={orders.loading || settlements.loading}
        dataSource={rows}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{ emptyText: 'No commission accrued in this period' }}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Accrued', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.accrued)}</span> },
          { title: 'Paid out', align: 'right', render: (_, r) => <span className="pt-num">{formatINR(r.paid)}</span> },
          { title: 'Balance', align: 'right', render: (_, r) => <b className="pt-num">{formatINR(r.balance)}</b> },
          {
            title: '',
            render: (_, r) => (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <Button disabled={r.balance <= 0} onClick={() => { setPay({ partner: r, accrued: r.accrued, balance: r.balance }); setAmount(toRupees(r.balance)) }}>Record payout</Button>
                <Button variant="text" onClick={() => setDetail(r)}>History</Button>
              </span>
            ),
          },
        ]}
      />
      <Modal open={!!pay} onCancel={() => setPay(null)} title={`Payout to ${pay?.partner.name ?? ''}`} okText="Record payout" onOk={recordPayout} okButtonProps={{ loading: busy }} destroyOnHidden>
        <p>Period {dayjs(from).format('DD MMM')} to {dayjs(to).format('DD MMM YYYY')}. Balance owed {formatINR(pay?.balance ?? 0)}.</p>
        <div style={{ display: 'grid', gap: 8 }}>
          <InputNumber aria-label="Payout amount" addonBefore="₹" min={0} precision={2} value={amount} onChange={(v) => setAmount(v ?? 0)} style={{ width: '100%' }} />
          <Select aria-label="Payout mode" value={mode} onChange={setMode} options={modeOptions} />
          <Input aria-label="Reference" placeholder="Transaction / cheque reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          <Input.TextArea aria-label="Note" rows={2} placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Modal>
      <Modal open={!!detail} onCancel={() => setDetail(null)} title={`Payout history · ${detail?.name ?? ''}`} footer={null} width={dialogWidth(720)} destroyOnHidden>
        <Table
          size="small"
          rowKey="id"
          dataSource={detailRows}
          pagination={false}
          locale={{ emptyText: 'No payouts yet' }}
          columns={[
            { title: 'Recorded', render: (_, s) => (s.at?.toDate ? dayjs(s.at.toDate()).format('DD MMM YYYY HH:mm') : '') },
            { title: 'Period', render: (_, s) => `${s.periodFrom} to ${s.periodTo}` },
            { title: 'Amount', align: 'right', render: (_, s) => <span className="pt-num">{formatINR(s.amount)}</span> },
            { title: 'Mode', dataIndex: 'mode' },
            { title: 'Reference', dataIndex: 'reference' },
            { title: 'By', dataIndex: 'byName' },
            {
              title: '',
              render: (_, s) =>
                s.kind === 'reversal' ? <StatusChip variant="urgent">Reversal</StatusChip> : reversedIds.has(s.id) ? <StatusChip variant="neutral">Reversed</StatusChip> : <Button variant="text" onClick={() => setReverse(s)}>Reverse</Button>,
            },
          ]}
        />
      </Modal>
      <Modal open={!!reverse} onCancel={() => setReverse(null)} title="Reverse payout" okText="Reverse" onOk={doReverse} okButtonProps={{ loading: busy }} destroyOnHidden>
        <p>This adds a negative row for {formatINR(reverse?.amount ?? 0)}; the original row is kept.</p>
        <Input.TextArea aria-label="Reason" rows={2} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </Modal>
  )
}
