import { useEffect, useMemo, useState } from 'react'
import { App, Button, DatePicker, Descriptions, Drawer, Empty, Input, InputNumber, Modal, Popconfirm, Select, Space, Table } from 'antd'
import dayjs from 'dayjs'
import { useLabSettings } from '../../../hooks/useCatalogue'
import { formatINR, toPaise } from '../../../lib/money'
import type { InventoryData } from '../lib/useInventory'
import type { POLine, POStatus, PurchaseOrder } from '../types'
import {
  cancelPO,
  closeShort,
  createPurchaseOrder,
  itemSuppliers,
  lineAmount,
  markOrdered,
  poTotal,
  receiveAgainstPO,
  suggestedQty,
  tsDate,
  updatePOLines,
  type ReceiptLine,
} from '../lib/stock'
import { useActor } from './useActor'
import { Chip } from '../../qc/ui'
import { Segmented } from '../../../design/Segmented'
import { dialogWidth } from '../../../design/dialog'

const STATUS: Record<POStatus, { text: string; status: string }> = {
  draft: { text: 'Draft', status: 'draft' },
  ordered: { text: 'Ordered', status: 'scheduled' },
  partially_received: { text: 'Partially received', status: 'pending' },
  received: { text: 'Received', status: 'completed' },
  cancelled: { text: 'Cancelled', status: 'deleted' },
}

// ---- Cart ----------------------------------------------------------------------

interface CartLine {
  itemId: string
  qty: number
  supplierId: string
  unitCostRs: number
  taxPercent?: number
}
const CART_KEY = 'hcl-inventory-cart'

function loadCart(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) ?? '[]') as CartLine[]
  } catch {
    return []
  }
}

function Cart({ inv, onCreated }: { inv: InventoryData; onCreated: () => void }) {
  const { message } = App.useApp()
  const actor = useActor()
  const [lines, setLines] = useState<CartLine[]>(loadCart)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(lines))
    } catch {
      /* storage unavailable: cart just stays in memory */
    }
  }, [lines])

  const addItem = (itemId: string, qty?: number) => {
    const item = inv.itemById.get(itemId)
    if (!item || lines.some((l) => l.itemId === itemId)) return
    // The preferred supplier (first in the item's list) and its own price are filled in; change the supplier on the line to compare.
    const pref = itemSuppliers(item)[0]
    setLines((ls) => [
      ...ls,
      {
        itemId,
        qty: qty ?? Math.max(item.packSize, 1),
        supplierId: pref?.supplierId ?? item.defaultSupplierId,
        unitCostRs: (pref?.price || item.lastPrice) / 100,
        taxPercent: item.taxPercent || undefined,
      },
    ])
  }

  const suggest = () => {
    let added = 0
    for (const item of inv.items) {
      const cur = inv.levels.get(item.id)?.qty ?? 0
      if (item.active && item.reorderLevel > 0 && cur <= item.reorderLevel && !lines.some((l) => l.itemId === item.id)) {
        addItem(item.id, suggestedQty(item, cur))
        added++
      }
    }
    message[added ? 'success' : 'info'](added ? `${added} item(s) added below reorder level` : 'No items below reorder level')
  }
  const patch = (itemId: string, p: Partial<CartLine>) => setLines((ls) => ls.map((l) => (l.itemId === itemId ? { ...l, ...p } : l)))

  const create = async () => {
    if (lines.some((l) => !l.supplierId)) return message.warning('Choose a supplier for every line')
    if (lines.some((l) => !(l.qty > 0))) return message.warning('Quantities must be above zero')
    setBusy(true)
    try {
      const bySupplier = new Map<string, CartLine[]>()
      for (const l of lines) bySupplier.set(l.supplierId, [...(bySupplier.get(l.supplierId) ?? []), l])
      for (const [supplierId, ls] of bySupplier) {
        await createPurchaseOrder(supplierId, ls.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: toPaise(l.unitCostRs), taxPercent: l.taxPercent })), '', actor.name)
      }
      message.success(`${bySupplier.size} draft purchase order(s) created`)
      setLines([])
      onCreated()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const total = lines.reduce((s, l) => s + lineAmount({ qty: l.qty, unitCost: toPaise(l.unitCostRs), taxPercent: l.taxPercent }), 0)

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          showSearch
          placeholder="Add item to cart"
          style={{ width: 280 }}
          optionFilterProp="label"
          value={null}
          onChange={(v: string) => addItem(v)}
          options={inv.items.filter((i) => i.active && !lines.some((l) => l.itemId === i.id)).map((i) => ({ value: i.id, label: i.name }))}
        />
        <Button onClick={suggest}>Suggest items below reorder level</Button>
        {lines.length > 0 && <Button onClick={() => setLines([])}>Clear</Button>}
      </Space>
      <Table
        size="small"
        rowKey="itemId"
        pagination={false}
        dataSource={lines}
        locale={{ emptyText: <Empty description="Cart is empty" /> }}
        columns={[
          { title: 'Item', render: (_, l) => inv.itemById.get(l.itemId)?.name },
          { title: 'In stock', align: 'right', render: (_, l) => inv.levels.get(l.itemId)?.qty ?? 0 },
          {
            title: 'Qty',
            render: (_, l) => (
              <Space.Compact>
                <InputNumber min={0} value={l.qty} onChange={(v) => patch(l.itemId, { qty: v ?? 0 })} style={{ width: 90 }} />
                <Space.Addon>{inv.itemById.get(l.itemId)?.unit}</Space.Addon>
                {(inv.itemById.get(l.itemId)?.packSize ?? 1) > 1 && (
                  <>
                    <InputNumber aria-label={`Packs of ${inv.itemById.get(l.itemId)?.name}`} min={0} step={1} value={Math.round((l.qty / (inv.itemById.get(l.itemId)?.packSize ?? 1)) * 100) / 100} onChange={(v) => patch(l.itemId, { qty: Math.round((v ?? 0) * (inv.itemById.get(l.itemId)?.packSize ?? 1) * 10000) / 10000 })} style={{ width: 80 }} />
                    <Space.Addon>{inv.itemById.get(l.itemId)?.purchaseUnit || 'pack'}</Space.Addon>
                  </>
                )}
              </Space.Compact>
            ),
          },
          { title: 'Unit cost (INR)', render: (_, l) => <InputNumber min={0} value={l.unitCostRs} onChange={(v) => patch(l.itemId, { unitCostRs: v ?? 0 })} style={{ width: 100 }} /> },
          {
            title: 'Supplier',
            render: (_, l) => (
              <Select
                value={l.supplierId || undefined}
                placeholder="Select"
                style={{ width: 180 }}
                status={l.supplierId ? undefined : 'warning'}
                onChange={(v) => {
                  const link = inv.itemById.get(l.itemId)?.suppliers?.find((x) => x.supplierId === v)
                  patch(l.itemId, { supplierId: v, ...(link?.price ? { unitCostRs: link.price / 100 } : {}) })
                }}
                options={inv.suppliers.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))}
              />
            ),
          },
          { title: 'GST', align: 'right', render: (_, l) => (l.taxPercent ? `${l.taxPercent}%` : '-') },
          { title: 'Line total', align: 'right', render: (_, l) => formatINR(lineAmount({ qty: l.qty, unitCost: toPaise(l.unitCostRs), taxPercent: l.taxPercent })) },
          { title: '', render: (_, l) => <Button size="small" type="link" danger onClick={() => setLines((ls) => ls.filter((x) => x.itemId !== l.itemId))}>Remove</Button> },
        ]}
      />
      {lines.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>Total {formatINR(Math.round(total))}</b>
          <Button type="primary" loading={busy} onClick={create}>Create purchase order per supplier</Button>
        </div>
      )}
    </div>
  )
}

// ---- Receive ---------------------------------------------------------------------

function ReceiveModal({ po, inv, onClose }: { po: PurchaseOrder | null; inv: InventoryData; onClose: () => void }) {
  const { message } = App.useApp()
  const actor = useActor()
  const [rows, setRows] = useState<(ReceiptLine & { unitCostRs: number })[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!po) return
    setRows(
      po.lines.flatMap((l, i) =>
        l.receivedQty >= l.qty
          ? []
          : [{ lineIndex: i, qty: Math.round((l.qty - l.receivedQty) * 10000) / 10000, lotNo: '', expiry: '', unitCost: l.unitCost, unitCostRs: l.unitCost / 100, location: '' }],
      ),
    )
  }, [po])

  const patch = (idx: number, p: Partial<ReceiptLine & { unitCostRs: number }>) =>
    setRows((rs) => rs.map((r) => (r.lineIndex === idx ? { ...r, ...p } : r)))

  const submit = async () => {
    if (!po) return
    setBusy(true)
    try {
      await receiveAgainstPO(po.id, rows.map((r) => ({ ...r, unitCost: toPaise(r.unitCostRs) })), actor.name)
      message.success('Stock received')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={!!po} title={`Receive goods - ${po?.poNo ?? ''}`} width={dialogWidth(980)} onCancel={onClose} onOk={submit} okText="Receive" confirmLoading={busy} destroyOnHidden>
      <p className="qc-muted">Enter what arrived. Leave quantity 0 for lines not delivered. Lot number and expiry are required for received lines.</p>
      <Table
        size="small"
        rowKey="lineIndex"
        pagination={false}
        dataSource={rows}
        scroll={{ x: 880 }}
        columns={[
          { title: 'Item', render: (_, r) => inv.itemById.get(po!.lines[r.lineIndex].itemId)?.name },
          { title: 'Pending', align: 'right', render: (_, r) => po!.lines[r.lineIndex].qty - po!.lines[r.lineIndex].receivedQty },
          { title: 'Received qty', render: (_, r) => <InputNumber min={0} value={r.qty} onChange={(v) => patch(r.lineIndex, { qty: v ?? 0 })} style={{ width: 90 }} /> },
          { title: 'Lot no', render: (_, r) => <Input value={r.lotNo} onChange={(e) => patch(r.lineIndex, { lotNo: e.target.value })} style={{ width: 120 }} /> },
          { title: 'Expiry', render: (_, r) => <DatePicker value={r.expiry ? dayjs(r.expiry) : null} onChange={(d) => patch(r.lineIndex, { expiry: d ? d.format('YYYY-MM-DD') : '' })} style={{ width: 130 }} /> },
          { title: 'Unit cost', render: (_, r) => <InputNumber min={0} value={r.unitCostRs} onChange={(v) => patch(r.lineIndex, { unitCostRs: v ?? 0 })} style={{ width: 90 }} /> },
          { title: 'Location', render: (_, r) => <Input value={r.location} onChange={(e) => patch(r.lineIndex, { location: e.target.value })} style={{ width: 110 }} /> },
        ]}
      />
    </Modal>
  )
}

// ---- PO detail ---------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function printPO(po: PurchaseOrder, inv: InventoryData, lab: { name: string; address: string; phone: string }) {
  const sup = inv.supplierById.get(po.supplierId)
  const rows = po.lines
    .map((l, i) => {
      const it = inv.itemById.get(l.itemId)
      return `<tr><td>${i + 1}</td><td>${esc(it?.name ?? '')}</td><td style="text-align:right">${l.qty} ${esc(it?.unit ?? '')}</td><td style="text-align:right">${formatINR(l.unitCost)}</td><td style="text-align:right">${formatINR(lineAmount(l))}${l.taxPercent ? ` (incl. GST ${l.taxPercent}%)` : ''}</td></tr>`
    })
    .join('')
  const w = window.open('', '_blank', 'width=800,height=900')
  if (!w) return
  w.document.write(`<!doctype html><title>${esc(po.poNo)}</title><style>
    body{font-family:Arial,sans-serif;padding:32px;color:#111}h1{color:#0369A1;margin:0}
    table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ccc;padding:6px 8px;font-size:13px}th{background:#E0F2FE;text-align:left}
    .meta{display:flex;justify-content:space-between;margin-top:16px;font-size:13px}</style>
    <h1>${esc(lab.name)}</h1><div style="font-size:12px;color:#555">${esc(lab.address)} ${esc(lab.phone)}</div>
    <h2>Purchase Order ${esc(po.poNo)}</h2>
    <div class="meta"><div><b>Supplier</b><br>${esc(sup?.name ?? '')}<br>${esc(sup?.address ?? '')}<br>${esc(sup?.phone ?? '')}<br>GSTIN: ${esc(sup?.gstin ?? '')}</div>
    <div><b>Date</b> ${dayjs(tsDate(po.orderedAt ?? po.createdAt)).format('DD MMM YYYY')}<br><b>Status</b> ${STATUS[po.status].text}</div></div>
    <table><tr><th>#</th><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>${rows}
    <tr><td colspan="4" style="text-align:right"><b>Total</b></td><td style="text-align:right"><b>${formatINR(po.total)}</b></td></tr></table>
    <p>${esc(po.notes)}</p><script>window.onload=()=>window.print()</script>`)
  w.document.close()
}

function PODetail({ po, inv, onClose }: { po: PurchaseOrder | null; inv: InventoryData; onClose: () => void }) {
  const { message } = App.useApp()
  const actor = useActor()
  const lab = useLabSettings()
  const [receiving, setReceiving] = useState(false)
  const [edit, setEdit] = useState<POLine[] | null>(null)

  useEffect(() => setEdit(null), [po?.id])
  if (!po) return <Drawer open={false} onClose={onClose} />

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      message.success(ok)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const lines = edit ?? po.lines
  const editPatch = (i: number, p: Partial<POLine>) => setEdit((edit ?? po.lines).map((l, k) => (k === i ? { ...l, ...p } : l)))
  const canAct = actor.canPurchase

  return (
    <Drawer
      open
      onClose={onClose}
      size={760}
      title={<Space>{po.poNo}<Chip status={STATUS[po.status].status}>{STATUS[po.status].text}</Chip></Space>}
      extra={<Button onClick={() => printPO(po, inv, lab)}>Print</Button>}
      destroyOnHidden
    >
      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="Supplier">{inv.supplierById.get(po.supplierId)?.name ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="Total">{formatINR(edit ? poTotal(edit) : po.total)}</Descriptions.Item>
        <Descriptions.Item label="Created">{dayjs(tsDate(po.createdAt)).format('DD MMM YYYY')}</Descriptions.Item>
        <Descriptions.Item label="Ordered">{po.orderedAt ? dayjs(tsDate(po.orderedAt)).format('DD MMM YYYY') : '-'}</Descriptions.Item>
        <Descriptions.Item label="Received">{po.receivedAt ? dayjs(tsDate(po.receivedAt)).format('DD MMM YYYY') : '-'}</Descriptions.Item>
        <Descriptions.Item label="Notes">{po.notes || '-'}</Descriptions.Item>
      </Descriptions>
      <Table
        size="small"
        rowKey={(_, i) => String(i)}
        pagination={false}
        dataSource={lines}
        columns={[
          { title: 'Item', render: (_, l) => inv.itemById.get(l.itemId)?.name },
          {
            title: 'Ordered',
            align: 'right',
            render: (_, l, i) => (po.status === 'draft' && canAct ? <InputNumber min={0} value={l.qty} onChange={(v) => editPatch(i, { qty: v ?? 0 })} style={{ width: 80 }} /> : `${l.qty} ${inv.itemById.get(l.itemId)?.unit ?? ''}`),
          },
          { title: 'Received', dataIndex: 'receivedQty', align: 'right' },
          {
            title: 'Unit cost',
            align: 'right',
            render: (_, l, i) => (po.status === 'draft' && canAct ? <InputNumber min={0} value={l.unitCost / 100} onChange={(v) => editPatch(i, { unitCost: toPaise(v ?? 0) })} style={{ width: 90 }} /> : formatINR(l.unitCost)),
          },
          { title: 'Amount', align: 'right', render: (_, l) => formatINR(lineAmount(l)) },
        ]}
      />
      {canAct && (
        <Space wrap style={{ marginTop: 16 }}>
          {po.status === 'draft' && edit && <Button onClick={() => run(async () => { await updatePOLines(po, edit); setEdit(null) }, 'Lines saved')}>Save changes</Button>}
          {po.status === 'draft' && <Button type="primary" disabled={!!edit} onClick={() => run(() => markOrdered(po.id), 'Marked as ordered')}>Mark ordered</Button>}
          {(po.status === 'ordered' || po.status === 'partially_received') && actor.canReceive && <Button type="primary" onClick={() => setReceiving(true)}>Receive goods</Button>}
          {po.status === 'partially_received' && (
            <Popconfirm title="Close this order short? Remaining quantities will not be received." onConfirm={() => run(() => closeShort(po.id), 'Order closed')}>
              <Button>Close short</Button>
            </Popconfirm>
          )}
          {(po.status === 'draft' || po.status === 'ordered') && (
            <Popconfirm title="Cancel this purchase order?" onConfirm={() => run(() => cancelPO(po.id), 'Order cancelled')}>
              <Button danger>Cancel order</Button>
            </Popconfirm>
          )}
        </Space>
      )}
      <ReceiveModal po={receiving ? po : null} inv={inv} onClose={() => setReceiving(false)} />
    </Drawer>
  )
}

// ---- Page ------------------------------------------------------------------------------

export default function PurchaseOrders({ inv }: { inv: InventoryData }) {
  const actor = useActor()
  const [view, setView] = useState<'orders' | 'cart'>('orders')
  const [tab, setTab] = useState<'all' | POStatus>('all')
  const [openId, setOpenId] = useState<string | null>(null)

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: inv.pos.length }
    for (const p of inv.pos) c[p.status] = (c[p.status] ?? 0) + 1
    return c
  }, [inv.pos])
  const shown = tab === 'all' ? inv.pos : inv.pos.filter((p) => p.status === tab)
  const open = inv.pos.find((p) => p.id === openId) ?? null

  return (
    <div>
      {actor.canPurchase && <div className="qc-subnav"><Segmented aria-label="Purchase orders or cart" value={view} onChange={setView} options={[{ value: 'orders', label: 'Purchase orders' }, { value: 'cart', label: 'Cart' }]} /></div>}
      {view === 'cart' && actor.canPurchase ? (
        <Cart inv={inv} onCreated={() => setView('orders')} />
      ) : (
        <>
          <div className="qc-subnav">
            <Segmented
              aria-label="Purchase order status"
              value={tab}
              onChange={setTab}
              options={[{ value: 'all' as const, label: 'All', count: counts.all }, ...(Object.keys(STATUS) as POStatus[]).map((st) => ({ value: st, label: STATUS[st].text, count: counts[st] ?? 0 }))]}
            />
          </div>
          <Table
            size="middle"
            rowKey="id"
            loading={inv.loading}
            dataSource={shown}
            onRow={(p) => ({ onClick: () => setOpenId(p.id), style: { cursor: 'pointer' } })}
            columns={[
              { title: 'PO no', dataIndex: 'poNo' },
              { title: 'Supplier', render: (_, p) => inv.supplierById.get(p.supplierId)?.name ?? '-' },
              { title: 'Items', align: 'right', render: (_, p) => p.lines.length },
              { title: 'Total', align: 'right', render: (_, p) => formatINR(p.total) },
              { title: 'Date', render: (_, p) => dayjs(tsDate(p.createdAt)).format('DD MMM YYYY') },
              { title: 'Status', render: (_, p) => <Chip status={STATUS[p.status].status}>{STATUS[p.status].text}</Chip> },
            ]}
          />
        </>
      )}
      <PODetail po={open} inv={inv} onClose={() => setOpenId(null)} />
    </div>
  )
}
