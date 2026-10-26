import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, AutoComplete, Input, InputNumber, Modal, Table } from 'antd'
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { useLabSettings } from '../../hooks/useCatalogue'
import { allocateDiscount, allocatePercent, computeTotals, derivedPercent, discountableGross, lineLocked } from '../../lib/billing'
import { useMasters, type PartnerContext } from '../../lib/masters'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { editOrder } from '../../lib/orders'
import type { Order, OrderItem } from '../../types'
import { ItemPicker, useLinePricer } from './lines'
import { PartnerFields } from './PartnerFields'
import BillReceipt from './BillReceipt'
import { tsDate } from './helpers'
import './billing.css'
import { dialogWidth } from '../../design/dialog'

// Permission-gated (billing.edit) edit of a saved bill. Every save appends a revision.
// Collected, received and resulted lines cannot be removed (use refund); their price and discount
// stay editable until a result is entered. The header discount re-spreads over the editable lines.
export default function EditBillModal({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const masters = useMasters()
  const allowed = can(profile, 'billing.edit')
  const canEditPrice = can(profile, 'billing.editPrice')
  const [items, setItems] = useState<OrderItem[]>(order.items)
  const [partners, setPartners] = useState<PartnerContext>({
    referrerId: order.referrerId,
    hospitalId: order.hospitalId,
    b2bCentreId: order.b2bCentreId,
    collectionCentreId: order.collectionCentreId,
    corporateClientId: order.corporateClientId,
    govPanelId: order.govPanelId,
    tpaId: order.tpaId,
    secondReferrerId: order.secondReferrerId,
  })
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [note, setNote] = useState(order.note)
  const [why, setWhy] = useState('')
  const [saving, setSaving] = useState(false)
  const pricer = useLinePricer(partners)
  const totals = useMemo(() => computeTotals(items), [items])
  const locked = (i: OrderItem) => ['approved', 'entered', 'refunded'].includes(i.status)
  const [discBy, setDiscBy] = useState(order.discountedBy ?? '')
  const [reason, setReason] = useState(order.discountReason ?? '')

  // Switching the B2B centre re-prices the editable lines from the new centre's rate list.
  const lastCentre = useRef(order.b2bCentreId)
  useEffect(() => {
    if (partners.b2bCentreId === lastCentre.current) return
    lastCentre.current = partners.b2bCentreId
    setItems((prev) => pricer.reprice(prev, new Set(prev.filter(locked).map((i) => i.lineId))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partners.b2bCentreId, pricer.reprice])

  // Header discount: percent -> every editable line price x %; rupees -> pro rata (largest line
  // takes any rounding remainder). Locked lines keep what they have.
  const applyHeader = (kind: 'pct' | 'amt', value: number) => {
    const idx = items.map((i, n) => (locked(i) ? -1 : n)).filter((n) => n >= 0)
    const sub = idx.map((n) => items[n])
    const shares = kind === 'pct' ? allocatePercent(sub, value) : allocateDiscount(sub, toPaise(value))
    const next = [...items]
    idx.forEach((n, k) => { next[n] = { ...next[n], discount: shares[k] } })
    setItems(next)
  }
  const gross = discountableGross(items)
  // New lines take the bill's current discount percent; deleting a line re-spreads what is left of the bill discount over
  // the remaining editable lines.
  const addLine = (l: OrderItem) => {
    if (!l.isCharge && l.testIds.some((t) => items.some((i) => !i.isCharge && i.testIds.includes(t)))) return void message.warning('Test already added')
    const pct = derivedPercent(items)
    setItems([...items, pct > 0 && !l.isCharge ? { ...l, discount: Math.min(l.price, Math.round((l.price * pct) / 100)) } : l])
  }
  const removeLine = (lineId: string) => {
    const rest = items.filter((i) => i.lineId !== lineId)
    const totalLeft = rest.reduce((s, i) => s + i.discount, 0)
    const lockedD = rest.filter(locked).reduce((s, i) => s + i.discount, 0)
    const idx = rest.map((i, n) => (locked(i) || i.isCharge ? -1 : n)).filter((n) => n >= 0)
    if (!idx.length || totalLeft <= 0) return setItems(rest)
    const shares = allocateDiscount(idx.map((n) => rest[n]), Math.max(0, totalLeft - lockedD))
    const next = [...rest]
    idx.forEach((n, k) => { next[n] = { ...next[n], discount: shares[k] } })
    setItems(next)
  }
  // Nothing to save until something changes; and an edit may not leave the bill below what was already collected.
  const sig = (xs: OrderItem[]) => JSON.stringify(xs.map((i) => [i.lineId, i.price, i.discount, !!i.urgent]))
  const changed = sig(items) !== sig(order.items) || note !== order.note || discBy !== (order.discountedBy ?? '') || reason !== (order.discountReason ?? '')
    || partners.referrerId !== order.referrerId || partners.hospitalId !== order.hospitalId || partners.b2bCentreId !== order.b2bCentreId
    || partners.collectionCentreId !== order.collectionCentreId || partners.corporateClientId !== order.corporateClientId
    || partners.govPanelId !== order.govPanelId || partners.tpaId !== order.tpaId || partners.secondReferrerId !== order.secondReferrerId

  const summary = () => {
    const was = new Set(order.items.map((i) => i.lineId))
    const now = new Set(items.map((i) => i.lineId))
    const added = items.filter((i) => !was.has(i.lineId)).map((i) => i.name)
    const removed = order.items.filter((i) => !now.has(i.lineId)).map((i) => i.name)
    const repriced = items.filter((i) => was.has(i.lineId) && order.items.find((o) => o.lineId === i.lineId)?.price !== i.price).length
    const parts = [
      added.length && `added ${added.join(', ')}`,
      removed.length && `removed ${removed.join(', ')}`,
      repriced && `${repriced} price change(s)`,
      partners.referrerId !== order.referrerId && 'referrer changed',
      partners.b2bCentreId !== order.b2bCentreId && 'B2B centre changed',
      note !== order.note && 'note changed',
    ].filter(Boolean)
    return `${parts.join('; ') || 'edited'}${why.trim() ? `. Reason: ${why.trim()}` : ''}`
  }

  const save = async (print = false) => {
    if (!profile) return
    if (items.length === 0) return message.warning('A bill needs at least one item. Void the bill instead.')
    setSaving(true)
    try {
      const ref = masters.doctors.find((d) => d.id === partners.referrerId)
      const sec = [...masters.secondReferrals, ...masters.doctors].find((d) => d.id === partners.secondReferrerId)
      await editOrder(
        order,
        {
          items,
          note: note.trim(),
          ...partners,
          referrerName: partners.referrerId ? ref?.name ?? order.referrerName : 'Self',
          hospitalName: masters.hospitals.find((h) => h.id === partners.hospitalId)?.name,
          secondReferrerName: sec?.name,
          b2bCentreName: masters.b2bCentres.find((c) => c.id === partners.b2bCentreId)?.name,
          discountedBy: discBy,
          discountReason: reason.trim(),
          summary: summary(),
        },
        profile,
        settings,
      )
      message.success('Bill updated')
      if (print) setReceiptId(order.id)
      else onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const overpaid = totals.net - (order.payer?.amount ?? 0) < order.paid
  const revisions = order.revisions ?? []

  return (
    <Modal open={open} onCancel={onClose} destroyOnHidden width={dialogWidth(980)} maskClosable={false} title={`Edit bill · ${order.billNo}`}
      footer={
        <div className="bill-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={!allowed || saving || !changed || overpaid} onClick={() => save(false)}>Save changes</Button>
          <Button variant="primary" disabled={!allowed || saving || !changed || overpaid} onClick={() => save(true)}>Update &amp; Print</Button>
        </div>
      }
    >
      {!allowed && <Alert type="error" showIcon message="Your role is not permitted to edit saved bills." style={{ marginBottom: 8 }} />}
      <div className="bill-section" style={{ marginBottom: 'var(--s-3)' }}>
        <h3 className="bill-section__title">Referrer and partner</h3>
        <PartnerFields value={partners} onChange={setPartners} />
      </div>
      <ItemPicker ctx={partners} gender={order.gender} branchId={order.branchId} onPick={addLine} />
      <div className="bill-row" style={{ marginBottom: 8 }}>
        <Button icon={<ReloadOutlined />} onClick={() => setItems(pricer.reprice(items, new Set(items.filter(locked).map((i) => i.lineId))))}>
          Re-price from rate lists
        </Button>
        <span className="bill-muted">Re-pricing resets line discounts.</span>
      </div>
      <Table<OrderItem>
        size="small"
        rowKey="lineId"
        pagination={false}
        dataSource={items}
        scroll={{ y: 240 }}
        columns={[
          { title: '#', width: 40, render: (_, __, i) => i + 1 },
          { title: 'Test / Package', render: (_, r) => (<>{r.name} <StatusChip>{r.status}</StatusChip></>) },
          {
            title: 'Price (₹)', width: 120,
            render: (_, r) =>
              canEditPrice && !locked(r) ? (
                <InputNumber aria-label={`Price of ${r.name}`} min={0} precision={2} value={toRupees(r.price)} style={{ width: '100%' }}
                  onChange={(v) => setItems(items.map((i) => (i.lineId === r.lineId ? { ...i, price: toPaise(v ?? 0), discount: 0 } : i)))} />
              ) : formatINR(r.price),
          },
          {
            title: 'Discount (₹)', width: 120,
            render: (_, r) =>
              locked(r) ? formatINR(r.discount) : (
                <InputNumber aria-label={`Discount on ${r.name}`} min={0} max={toRupees(r.price)} precision={2} value={toRupees(r.discount)} style={{ width: '100%' }}
                  onChange={(v) => setItems(items.map((i) => (i.lineId === r.lineId ? { ...i, discount: toPaise(v ?? 0) } : i)))} />
              ),
          },
          {
            title: '', width: 50,
            render: (_, r) => (
              <Button variant="text" aria-label={`Remove ${r.name}`} disabled={lineLocked(r)} title={lineLocked(r) ? 'Already collected or resulted: use refund' : undefined} icon={<DeleteOutlined />}
                onClick={() => removeLine(r.lineId)} />
            ),
          },
        ]}
      />
      <div className="bill-row" style={{ marginTop: 'var(--s-3)' }}>
        <InputNumber aria-label="Discount percent" addonAfter="%" min={0} max={100} precision={2} value={derivedPercent(items)} style={{ width: 130 }} onChange={(v) => applyHeader('pct', v ?? 0)} />
        <InputNumber aria-label="Discount amount" addonBefore="₹" min={0} max={toRupees(gross)} precision={2} value={toRupees(totals.discount)} style={{ width: 150 }} onChange={(v) => applyHeader('amt', v ?? 0)} />
        <AutoComplete aria-label="Discount reason" style={{ width: 240 }} value={reason} onChange={setReason} options={masters.reasons.map((r) => ({ value: r }))} placeholder="Discount reason" />
        <Input aria-label="Discounted by" style={{ width: 160 }} value={discBy} onChange={(e) => setDiscBy(e.target.value)} placeholder="Discounted by" />
      </div>
      <p style={{ marginTop: 'var(--s-3)' }}>
        Net {formatINR(totals.net)} (was {formatINR(order.net)}) · collected {formatINR(order.paid)}
      </p>
      {overpaid && <Alert type="error" showIcon message="The new net is below what was collected, so this edit cannot be saved. Use Refund to return the difference." style={{ marginBottom: 8 }} />}
      <Input.TextArea rows={2} aria-label="Note on bill" placeholder="Note on bill" value={note} onChange={(e) => setNote(e.target.value)} />
      <Input style={{ marginTop: 8 }} aria-label="Reason for edit" placeholder="Reason for this edit (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
      {revisions.length > 0 && (
        <div className="bill-section" style={{ marginTop: 'var(--s-3)' }}>
          <h3 className="bill-section__title">Revision trail</h3>
          {revisions.map((r, i) => (
            <p key={i} className="bill-muted" style={{ margin: 0 }}>
              {dayjs(tsDate(r.at) ?? new Date()).format('DD MMM HH:mm')} · {r.byName}: {r.summary} ({formatINR(r.before.net)} to {formatINR(r.after.net)})
            </p>
          ))}
        </div>
      )}
      <BillReceipt open={!!receiptId} orderId={receiptId} onClose={() => { setReceiptId(null); onClose() }} />
    </Modal>
  )
}
