import { useEffect, useState } from 'react'
import { Alert, App, Input, Modal, Select, Table } from 'antd'
import { can, useAuth } from '../../auth/AuthProvider'
import { StatusChip } from '../../design/StatusChip'
import { useLabSettings } from '../../hooks/useCatalogue'
import { orderBy, query } from 'firebase/firestore'
import { useLiveQuery } from '../../hooks/useLive'
import { ledgerCol } from '../../lib/db'
import { modeLabel, usePaymentModes } from '../../lib/masters'
import { isManagerOrAdmin, lineNet } from '../../lib/billing'
import { formatINR } from '../../lib/money'
import { refundLines } from '../../lib/orders'
import type { LedgerEntry, Order, OrderItem, PaymentMode } from '../../types'
import './billing.css'
import { dialogWidth } from '../../design/dialog'

export default function RefundModal({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const payModes = usePaymentModes()
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<PaymentMode | undefined>()
  const [saving, setSaving] = useState(false)
  const { data: ledger } = useLiveQuery<LedgerEntry>(open ? query(ledgerCol(order.id), orderBy('postedAt')) : null, [open, order.id])

  // The mode the patient paid with is only used to offer Wallet when that is where the money came from.
  const paidMode = (() => {
    const by = new Map<string, number>()
    for (const e of ledger) by.set(e.mode, (by.get(e.mode) ?? 0) + e.amount)
    return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  })()

  useEffect(() => {
    if (open) {
      setSelected([])
      setReason('')
      setMode(undefined)
    }
  }, [open, order.id])

  const allowed = can(profile, 'billing.refund')
  const amount = order.items.filter((i) => selected.includes(i.lineId)).reduce((s, i) => s + lineNet(i), 0)
  const tooMuch = amount > order.paid
  const approvedSelected = order.items.some((i) => selected.includes(i.lineId) && i.status === 'approved')
  const needsManager = approvedSelected && !isManagerOrAdmin(profile)
  const threshold = settings.frontDesk?.refundApprovalThreshold ?? 0
  const needsApproval = threshold > 0 && amount > threshold && !isManagerOrAdmin(profile)
  // The Refund button stays enabled once lines are picked; a missing reason or mode is explained when it is pressed.
  const ready = allowed && !order.refundPendingApproval && !needsManager && selected.length > 0 && amount > 0 && !tooMuch

  const submit = () => {
    if (!profile) return
    if (!reason.trim() || !mode) return void message.warning('Enter a refund reason and pick a refund mode to continue.')
    const run = async () => {
      setSaving(true)
      try {
        const res = await refundLines(order, selected, mode, reason.trim(), profile, settings)
        message.success(res === 'requested' ? `Refund of ${formatINR(amount)} sent for manager approval` : `Refunded ${formatINR(amount)}`)
        onClose()
      } catch (e) {
        message.error((e as Error).message)
      } finally {
        setSaving(false)
      }
    }
    Modal.confirm({
      title: `${needsApproval ? 'Request refund of' : 'Refund'} ${formatINR(amount)} by ${modeLabel(mode)}?`,
      content: needsApproval ? 'A manager or admin must approve before the money is returned.' : 'The lines stay on the bill marked as refunded. This cannot be undone.',
      okText: needsApproval ? 'Send for approval' : 'Confirm refund',
      okButtonProps: { danger: true },
      onOk: run,
    })
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`Refund · ${order.billNo}`}
      width={dialogWidth(700)}
      destroyOnHidden
      okText="Refund"
      onOk={submit}
      okButtonProps={{ disabled: !ready, loading: saving, danger: true }}
    >
      {!allowed && <Alert type="error" showIcon message="Your role is not permitted to refund." style={{ marginBottom: 8 }} />}
      <Table<OrderItem>
        size="small"
        rowKey="lineId"
        pagination={false}
        dataSource={order.items}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (k) => setSelected(k as string[]),
          getCheckboxProps: (r) => ({ disabled: r.status === 'refunded' }),
        }}
        columns={[
          {
            title: 'Test / Package',
            render: (_, r) =>
              r.status === 'refunded' ? (
                <>
                  <s>{r.name}</s> <StatusChip variant="urgent">Refunded</StatusChip>
                </>
              ) : (
                <>
                  {r.name} <StatusChip>{r.status}</StatusChip>
                </>
              ),
          },
          { title: 'Amount', align: 'right', render: (_, r) => formatINR(r.price) },
          { title: 'Discount', align: 'right', render: (_, r) => formatINR(r.discount) },
          { title: 'Net', align: 'right', render: (_, r) => formatINR(lineNet(r)) },
        ]}
      />
      <div style={{ margin: '12px 0' }}>
        Refund amount: <b>{formatINR(amount)}</b>
        <span className="bill-muted"> (collected so far {formatINR(order.paid)})</span>
      </div>
      {order.refundPendingApproval && <Alert type="warning" showIcon message="A refund is already waiting for approval on this bill. Approve or reject it in Payment history first." style={{ marginBottom: 8 }} />}
      {needsApproval && <Alert type="info" showIcon message={`Refunds above ${formatINR(threshold)} need a manager or admin to approve. This will be sent as a request.`} style={{ marginBottom: 8 }} />}
      {tooMuch && <Alert type="error" showIcon message="Refund is more than the money collected. Collect the due first or refund fewer lines." style={{ marginBottom: 8 }} />}
      {approvedSelected && (
        <Alert
          type={needsManager ? 'error' : 'warning'}
          showIcon
          message={needsManager ? 'A selected test already has a result. Only a manager or admin can refund it.' : 'A selected test already has an approved result. Say in the reason why the refund is given.'}
          style={{ marginBottom: 8 }}
        />
      )}
      <Select
        aria-label="Refund mode"
        placeholder="Refund mode (required)"
        style={{ width: 200, marginRight: 8 }}
        value={mode}
        onChange={setMode}
        options={mode === 'wallet' || paidMode === 'wallet' ? [...payModes, { value: 'wallet', label: 'Wallet' }] : payModes}
      />
      <Input
        placeholder="Reason (required)"
        style={{ width: 'calc(100% - 210px)' }}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  )
}
