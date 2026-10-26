import { useEffect, useMemo, useState } from 'react'
import { Alert, App, DatePicker, Input, InputNumber, Modal, Select, Table } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { canBackdate, derivedPercent } from '../../lib/billing'
import { getDocs } from 'firebase/firestore'
import { ledgerCol } from '../../lib/db'
import { useNeedsReference, usePaymentModes } from '../../lib/masters'
import './billing.css'
import { useLabSettings } from '../../hooks/useCatalogue'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { clearDue, clearDueBulk, writeOffDue } from '../../lib/orders'
import type { LedgerEntry, Order, PaymentMode } from '../../types'
import { tsDate } from './helpers'
import { dialogWidth } from '../../design/dialog'

interface Row {
  key: string
  mode: PaymentMode
  amount: number
  reference: string
}
const mk = (mode: PaymentMode, amount: number): Row => ({ key: crypto.randomUUID(), mode, amount, reference: '' })

const billTime = (o: Order) => (o.billDate ?? o.createdAt)?.toMillis?.() ?? 0

// Clear due on one bill, or (with `orders`) on several: the amount collected is allocated
// oldest bill first, each bill taking up to its own due.
export default function ClearDueModal({
  order,
  orders,
  open,
  onClose,
}: {
  order?: Order
  orders?: Order[]
  open: boolean
  onClose: () => void
}) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const payModes = usePaymentModes()
  const needsRef = useNeedsReference()
  const list = useMemo(() => (orders ?? (order ? [order] : [])).filter((o) => o.due > 0).sort((a, b) => billTime(a) - billTime(b)), [orders, order])
  const bulk = list.length > 1
  const totalDue = list.reduce((n, o) => n + o.due, 0)
  const [rows, setRows] = useState<Row[]>([mk('cash', toRupees(totalDue))])
  const [remark, setRemark] = useState('')
  const [paidAt, setPaidAt] = useState<Dayjs | null>(null)
  const [saving, setSaving] = useState(false)
  const backdateOk = canBackdate(profile)
  const [woOpen, setWoOpen] = useState(false)
  const [woAmt, setWoAmt] = useState(0)
  const [woReason, setWoReason] = useState('')
  const canWriteOff = !bulk && can(profile, 'billing.discount')
  const writeOff = async () => {
    if (!profile || !list[0]) return
    setSaving(true)
    try {
      await writeOffDue(list[0], toPaise(woAmt || 0), woReason, profile, settings)
      message.success('Written off as a discount adjustment')
      setWoOpen(false)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Previous remark: the latest non-empty remark on this bill's payments (single bill only).
  const [prevRemark, setPrevRemark] = useState<{ text: string; by: string } | null>(null)
  const singleId = !bulk ? list[0]?.id : undefined
  useEffect(() => {
    setPrevRemark(null)
    if (!open || !singleId) return
    let alive = true
    getDocs(ledgerCol(singleId))
      .then((snap) => {
        const last = snap.docs
          .map((d) => d.data() as LedgerEntry)
          .filter((e) => (e.type === 'clearDue' || e.type === 'payment') && e.remark?.trim())
          .sort((a, b) => (b.postedAt?.toMillis?.() ?? 0) - (a.postedAt?.toMillis?.() ?? 0))[0]
        if (alive && last) setPrevRemark({ text: last.remark.trim(), by: last.postedByName })
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [open, singleId])

  useEffect(() => {
    if (open) {
      setRows([mk('cash', toRupees(totalDue))])
      setRemark('')
      setPaidAt(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, list.map((o) => o.id).join(',')])

  const total = rows.reduce((s, r) => s + toPaise(r.amount || 0), 0)
  const remaining = totalDue - total
  const refMissing = rows.some((r) => r.amount > 0 && needsRef(r.mode) && !r.reference.trim())
  const blankRow = rows.some((r) => !(r.amount > 0)) // a payment row with no amount blocks the button
  const invalid = total <= 0 || total > totalDue || refMissing || blankRow

  // Oldest-first preview of how the amount lands on each bill.
  const preview = useMemo(() => {
    let left = total
    return list.map((o) => {
      const take = Math.max(0, Math.min(o.due, left))
      left -= take
      return { o, take }
    })
  }, [list, total])

  const submit = async () => {
    if (!profile || list.length === 0) return
    setSaving(true)
    try {
      const pays = rows.map((r) => ({ mode: r.mode, amount: toPaise(r.amount || 0), reference: r.reference.trim(), paidAt: paidAt?.toDate() }))
      if (bulk) await clearDueBulk(list, pays, remark.trim(), profile, settings)
      else await clearDue(list[0], pays, remark.trim(), profile, settings)
      message.success('Payment recorded')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const title = bulk ? `Clear due · ${list.length} bills` : `Clear due · ${list[0]?.billNo ?? ''}`
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      width={typeof (bulk ? 720 : 520) === 'number' ? dialogWidth(bulk ? 720 : 520) : (bulk ? 720 : 520)}
      destroyOnHidden
      okText="Receive payment"
      onOk={submit}
      okButtonProps={{ disabled: invalid, loading: saving }}
    >
      <Table<{ o: Order; take: number }>
        size="small"
        rowKey={(r) => r.o.id}
        pagination={false}
        dataSource={preview}
        scroll={{ y: 180 }}
        columns={[
          { title: 'Date', render: (_, r) => { const d = tsDate(r.o.billDate ?? r.o.createdAt); return d ? dayjs(d).format('DD MMM') : '' } },
          { title: 'Bill', render: (_, r) => <>{r.o.billNo} <span className="bill-muted">{r.o.patientName}</span></> },
          { title: 'Tests', ellipsis: true, render: (_, r) => r.o.items.filter((i) => i.status !== 'refunded' && !i.isCharge).map((i) => i.name).join(', ') },
          { title: 'Total', align: 'right', render: (_, r) => formatINR(r.o.net) },
          { title: 'Paid', align: 'right', render: (_, r) => formatINR(r.o.paid) },
          { title: 'Due', align: 'right', render: (_, r) => <b className="bill-due">{formatINR(r.o.due)}</b> },
          ...(bulk ? [{ title: 'Applying', align: 'right' as const, render: (_: unknown, r: { take: number }) => formatINR(r.take) }] : []),
        ]}
      />
      {!bulk && list[0] && list[0].discount > 0 && (
        <p className="bill-muted" style={{ marginTop: 8 }}>
          Discount {derivedPercent(list[0].items)}% ({formatINR(list[0].discount)}){list[0].discountedBy ? ` by ${list[0].discountedBy}` : ''}
        </p>
      )}
      <p style={{ marginTop: 8 }}>
        Total due <b className="bill-due">{formatINR(totalDue)}</b>
      </p>
      {prevRemark && (
        <Alert style={{ marginBottom: 8 }} type="info" message={<>Previous remark: {prevRemark.text} <span className="bill-muted">({prevRemark.by})</span></>} />
      )}
      {rows.map((r, idx) => (
        <div key={r.key} className="bill-row">
          <Select
            value={r.mode}
            style={{ width: 90 }}
            options={payModes}
            onChange={(mode) => setRows(rows.map((x) => (x.key === r.key ? { ...x, mode } : x)))}
          />
          <InputNumber
            min={0}
            precision={2}
            addonBefore="₹"
            value={r.amount}
            onChange={(v) => setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: v ?? 0 } : x)))}
          />
          <Input
            placeholder={needsRef(r.mode) ? 'Transaction ID (required)' : 'Transaction ID'}
            aria-label="Transaction ID"
            status={needsRef(r.mode) && r.amount > 0 && !r.reference.trim() ? 'error' : undefined}
            style={{ width: 160 }}
            value={r.reference}
            onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, reference: e.target.value } : x)))}
          />
          {idx > 0 && <Button variant="text" aria-label="Remove payment row" icon={<DeleteOutlined />} onClick={() => setRows(rows.filter((x) => x.key !== r.key))} />}
        </div>
      ))}
      <Button icon={<PlusOutlined />} onClick={() => setRows([...rows, mk(payModes[1]?.value ?? payModes[0].value, 0)])}>
        Split payment
      </Button>
      {backdateOk && (
        <div className="bill-row" style={{ marginTop: 8 }}>
          <label className="bill-muted" htmlFor="paid-at">Payment date (back-dated)</label>
          <DatePicker id="paid-at" value={paidAt} onChange={setPaidAt} allowClear disabledDate={(d) => d.isAfter(dayjs(), 'day')} placeholder="Today" />
        </div>
      )}
      {canWriteOff && (
        <div style={{ marginTop: 8 }}>
          {!woOpen ? (
            <Button variant="text" onClick={() => { setWoOpen(true); setWoAmt(toRupees(totalDue)) }}>Write off a balance as discount</Button>
          ) : (
            <div className="bill-row">
              <InputNumber aria-label="Write-off amount" addonBefore="₹" min={0} precision={2} value={woAmt} onChange={(v) => setWoAmt(v ?? 0)} style={{ width: 150 }} />
              <Input aria-label="Write-off reason" placeholder="Reason (required)" style={{ width: 220 }} value={woReason} onChange={(e) => setWoReason(e.target.value)} />
              <Button disabled={saving || !woReason.trim() || woAmt <= 0} onClick={writeOff}>Write off</Button>
              <Button variant="text" onClick={() => setWoOpen(false)}>Cancel</Button>
            </div>
          )}
        </div>
      )}
      <Input.TextArea rows={2} maxLength={500} placeholder={prevRemark ? 'Remark (leave empty to keep the previous remark on the Due list)' : 'Remark (shown on the Due list until the bill is cleared)'} value={remark} onChange={(e) => setRemark(e.target.value)} style={{ marginTop: 8 }} />
      <div style={{ marginTop: 8 }}>
        Receiving {formatINR(total)} ·{' '}
        <b className={remaining > 0 ? 'bill-due' : 'bill-ok'}>
          {remaining >= 0 ? `${formatINR(remaining)} will remain due` : 'more than the due amount'}
        </b>
      </div>
      {total > totalDue && <Alert style={{ marginTop: 8 }} type="error" showIcon message="Amount exceeds the due balance." />}
    </Modal>
  )
}
