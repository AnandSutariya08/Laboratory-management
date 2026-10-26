import { useMemo, useState } from 'react'
import { Alert, App, Input, Modal, Table } from 'antd'
import { StatusChip, type StatusVariant } from '../../design/StatusChip'
import dayjs from 'dayjs'
import { orderBy, query } from 'firebase/firestore'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { useLabSettings } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { ledgerCol } from '../../lib/db'
import { formatINR } from '../../lib/money'
import { approveRefund, rejectRefund, reversePayment } from '../../lib/orders'
import { isManagerOrAdmin } from '../../lib/billing'
import type { LedgerEntry, Order } from '../../types'
import { modeLabel } from '../../lib/masters'
import ClearDueModal from './ClearDueModal'
import { PaymentStatusChip } from './PaymentStatusChip'
import { tsDate } from './helpers'
import './billing.css'
import { dialogWidth } from '../../design/dialog'

const TYPE: Record<LedgerEntry['type'], { label: string; variant: StatusVariant }> = {
  payment: { label: 'Payment', variant: 'success' },
  clearDue: { label: 'Due cleared', variant: 'info' },
  refund: { label: 'Refund', variant: 'urgent' },
  reversal: { label: 'Reversal', variant: 'urgent' },
}

// The ledger is append-only: a wrong payment is undone with a reversal entry (reason required,
// managers and admins only), never deleted. "Due after" is the balance following each entry.
export default function PaymentHistoryModal({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const { data, loading } = useLiveQuery<LedgerEntry>(
    open ? query(ledgerCol(order.id), orderBy('postedAt')) : null,
    [open, order.id],
  )
  const [reversing, setReversing] = useState<LedgerEntry | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const mayReverse = can(profile, 'billing.reverse')
  const pending = order.refundPendingApproval
  const decide = async (approve: boolean) => {
    if (!profile) return
    setBusy(true)
    try {
      if (approve) await approveRefund(order, profile, settings)
      else await rejectRefund(order, profile)
      message.success(approve ? 'Refund approved and posted' : 'Refund request rejected')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const reversed = useMemo(() => new Set(data.map((e) => e.reversesId).filter(Boolean) as string[]), [data])
  // Running due: net (after payer share) minus money received so far. Refund rows leave it unchanged
  // because refunded lines already left the bill net.
  const dueAfter = useMemo(() => {
    const target = Math.max(0, order.net - (order.payer?.amount ?? 0))
    let paid = 0
    const m = new Map<string, number>()
    for (const e of data) {
      if (e.type !== 'refund') paid += e.amount
      m.set(e.id, Math.max(0, target - paid))
    }
    return m
  }, [data, order.net, order.payer])

  const doReverse = async () => {
    if (!profile || !reversing) return
    setBusy(true)
    try {
      await reversePayment(order, reversing, reason, profile, settings)
      message.success('Payment reversed')
      setReversing(null)
      setReason('')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={
          order.due > 0 && !order.deleted && can(profile, 'payment.collect') ? (
            <Button variant="primary" onClick={() => setAdding(true)}>Add payment</Button>
          ) : null
        }
        width={dialogWidth(900)}
        title={`Payment history · ${order.billNo}`}
        destroyOnHidden
      >
        <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <PaymentStatusChip order={order} />
          <span className="bill-muted">Net {formatINR(order.net)} · paid {formatINR(order.paid)} · due {formatINR(order.due)}</span>
        </div>
        {pending && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message={`Refund of ${formatINR(pending.amount)} (${modeLabel(pending.mode)}) is waiting for approval`}
            description={`Requested by ${pending.requestedByName}: ${pending.reason}`}
            action={isManagerOrAdmin(profile) && can(profile, 'billing.refund') ? (
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <Button variant="primary" disabled={busy} onClick={() => decide(true)}>Approve</Button>
                <Button disabled={busy} onClick={() => decide(false)}>Reject</Button>
              </span>
            ) : undefined}
          />
        )}
        <Table<LedgerEntry>
          size="small"
          rowKey="id"
          loading={loading}
          pagination={false}
          dataSource={data}
          locale={{ emptyText: 'No payments recorded' }}
          columns={[
            { title: '#', width: 40, render: (_, __, i) => i + 1 },
            {
              title: 'Type',
              render: (_, r) => (
                <>
                  <StatusChip variant={TYPE[r.type].variant}>{TYPE[r.type].label}</StatusChip>
                  {reversed.has(r.id) && <StatusChip>Reversed</StatusChip>}
                </>
              ),
            },
            { title: 'Receipt / refund no.', render: (_, r) => r.receiptNo ?? r.refundNo ?? '-' },
            { title: 'Mode', render: (_, r) => modeLabel(r.mode) },
            {
              title: 'Amount',
              align: 'right',
              render: (_, r) => <span className={r.amount < 0 ? 'bill-due' : undefined}>{formatINR(r.amount)}</span>,
            },
            { title: 'Due after', align: 'right', render: (_, r) => (r.type === 'refund' ? '-' : formatINR(dueAfter.get(r.id) ?? 0)) },
            { title: 'Ref / remark', render: (_, r) => [r.reference, r.remark].filter(Boolean).join(' · ') || '-' },
            { title: 'Posted by', render: (_, r) => <>{r.postedByName}{r.shift && <div className="bill-muted">{r.shift} shift</div>}</> },
            {
              title: 'Time',
              render: (_, r) => {
                const d = tsDate(r.postedAt)
                const back = tsDate(r.backdatedTo)
                return (
                  <>
                    {d ? dayjs(d).format('DD MMM YYYY HH:mm') : '...'}
                    {back && <div className="bill-muted">dated {dayjs(back).format('DD MMM YYYY')}</div>}
                  </>
                )
              },
            },
            {
              title: '',
              width: 90,
              render: (_, r) =>
                mayReverse && (r.type === 'payment' || r.type === 'clearDue') && !reversed.has(r.id) && !order.deleted ? (
                  <Button variant="text" onClick={() => { setReversing(r); setReason('') }}>Reverse</Button>
                ) : null,
            },
          ]}
        />
      </Modal>
      <Modal
        open={!!reversing}
        onCancel={() => setReversing(null)}
        title="Reverse payment"
        okText="Reverse payment"
        onOk={doReverse}
        okButtonProps={{ danger: true, disabled: !reason.trim(), loading: busy }}
        destroyOnHidden
      >
        <p>
          {reversing && `${modeLabel(reversing.mode)} ${formatINR(reversing.amount)} will be undone with a reversal entry. The original stays in the history.`}
        </p>
        <Input.TextArea rows={2} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
      <ClearDueModal order={order} open={adding} onClose={() => setAdding(false)} />
    </>
  )
}
