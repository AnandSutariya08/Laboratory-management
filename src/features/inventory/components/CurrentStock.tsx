import { useMemo, useState } from 'react'
import { App, Button, DatePicker, Input, Modal, Popconfirm, Select, Space, Table } from 'antd'
import dayjs from 'dayjs'
import { DownloadOutlined } from '@ant-design/icons'
import type { InventoryData } from '../lib/useInventory'
import { CATEGORIES, type InventoryItem, type StockBatch } from '../types'
import { daysToExpiry, deleteBatch, editBatch, EXPIRY_WARN_DAYS, isExpired, markExpired, nextLot } from '../lib/stock'
import { downloadCsv } from '../lib/csv'
import { formatINR } from '../../../lib/money'
import { AdjustModal, ConsumeModal } from './StockModals'
import MovementDrawer from './MovementDrawer'
import { useActor } from './useActor'
import { Chip } from '../../qc/ui'

export const expiryTag = (b: Pick<StockBatch, 'expiry'>) => {
  const d = daysToExpiry(b.expiry)
  if (d < 0) return <Chip status="fail">{b.expiry} - expired</Chip>
  if (d <= EXPIRY_WARN_DAYS) return <Chip status="warning">{b.expiry} - {d}d</Chip>
  return <Chip status="pass">{b.expiry}</Chip>
}

type StatusFilter = 'all' | 'low' | 'out' | 'expiring' | 'expired'

export default function CurrentStock({ inv }: { inv: InventoryData }) {
  const { message } = App.useApp()
  const actor = useActor()
  const [search, setSearch] = useState('')
  const [cat, setCat] = useState<string>()
  const [status, setStatus] = useState<StatusFilter>('all')
  const [consume, setConsume] = useState<string | null | undefined>(undefined) // undefined = closed
  const [adjust, setAdjust] = useState<string | null>(null)
  const [history, setHistory] = useState<InventoryItem | null>(null)
  const [lotEdit, setLotEdit] = useState<{ b: StockBatch; lotNo: string; expiry: string; location: string } | null>(null)
  const [lotDel, setLotDel] = useState<{ b: StockBatch; reason: string } | null>(null)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inv.items
      .filter((i) => i.active)
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q))
      .filter((i) => !cat || i.category === cat)
      .map((i) => ({ item: i, stock: inv.levels.get(i.id)! }))
      .filter(({ item, stock }) => {
        switch (status) {
          case 'low':
            return stock.qty > 0 && item.reorderLevel > 0 && stock.qty <= item.reorderLevel
          case 'out':
            return stock.qty <= 0
          case 'expiring':
            return stock.batches.some((b) => !isExpired(b) && daysToExpiry(b.expiry) <= EXPIRY_WARN_DAYS)
          case 'expired':
            return stock.expiredQty > 0
          default:
            return true
        }
      })
  }, [inv, search, cat, status])

  const exportCsv = () =>
    downloadCsv('current-stock.csv', [
      ['Item', 'Code', 'Category', 'Unit', 'Lot', 'Expiry', 'Remaining', 'Unit cost (INR)', 'Item total (non-expired)', 'Reorder level'],
      ...rows.flatMap(({ item, stock }) =>
        stock.batches.length
          ? stock.batches.map((b) => [item.name, item.code, item.category, item.unit, b.lotNo, b.expiry, b.qtyRemaining, b.unitCost / 100, stock.qty, item.reorderLevel])
          : [[item.name, item.code, item.category, item.unit, '', '', 0, '', 0, item.reorderLevel]],
      ),
    ])

  const expire = async (b: StockBatch) => {
    try {
      await markExpired(b.id, actor.name)
      message.success(`Lot ${b.lotNo} written off as expired`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveLot = async () => {
    if (!lotEdit) return
    try {
      await editBatch(lotEdit.b.id, { lotNo: lotEdit.lotNo, expiry: lotEdit.expiry, location: lotEdit.location }, actor.name)
      message.success('Lot updated')
      setLotEdit(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const removeLot = async () => {
    if (!lotDel) return
    try {
      await deleteBatch(lotDel.b.id, lotDel.reason, actor.name)
      message.success('Lot removed')
      setLotDel(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="Search item or code" onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
        <Select allowClear placeholder="Category" value={cat} onChange={setCat} style={{ width: 150 }} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
        <Select
          value={status}
          onChange={setStatus}
          style={{ width: 160 }}
          options={[
            { value: 'all', label: 'All stock' },
            { value: 'low', label: 'Low stock' },
            { value: 'out', label: 'Out of stock' },
            { value: 'expiring', label: `Expiring in ${EXPIRY_WARN_DAYS} days` },
            { value: 'expired', label: 'Has expired lots' },
          ]}
        />
        {actor.canConsume && <Button type="primary" onClick={() => setConsume(null)}>Manual consumption</Button>}
        <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export CSV</Button>
      </Space>
      <Table
        size="middle"
        rowKey={(r) => r.item.id}
        loading={inv.loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: 'Item', render: (_, { item }) => <><b>{item.name}</b><div className="qc-muted" style={{ fontSize: 'var(--fs-dense)' }}>{item.code} - {item.category}</div></> },
          {
            title: 'In stock',
            align: 'right',
            sorter: (a, b) => a.stock.qty - b.stock.qty,
            render: (_, { item, stock }) => (
              <span>
                <b>{stock.qty}</b> {item.unit}
                {stock.qty <= 0 ? <Chip status="fail">Out</Chip> : item.reorderLevel > 0 && stock.qty <= item.reorderLevel ? <Chip status="warning">Low</Chip> : null}
                {stock.expiredQty > 0 && <Chip status="fail">{stock.expiredQty} expired</Chip>}
              </span>
            ),
          },
          { title: 'Reorder at', dataIndex: ['item', 'reorderLevel'], align: 'right' },
          { title: 'Next lot (FEFO)', render: (_, { stock }) => { const n = nextLot(stock.batches); return n ? <span>{n.lotNo} <span className="qc-muted">exp {n.expiry}</span></span> : '-' } },
          { title: 'Lots', render: (_, { stock }) => stock.batches.length, align: 'right' },
          {
            title: 'Actions',
            render: (_, { item }) => (
              <Space size={4} wrap>
                {actor.canConsume && <Button size="small" onClick={() => setConsume(item.id)}>Consume</Button>}
                {actor.canAdjust && <Button size="small" onClick={() => setAdjust(item.id)}>Adjust</Button>}
                <Button size="small" type="link" onClick={() => setHistory(item)}>History</Button>
              </Space>
            ),
          },
        ]}
        expandable={{
          rowExpandable: ({ stock }) => stock.batches.length > 0,
          expandedRowRender: ({ item, stock }) => (
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={stock.batches}
              columns={[
                { title: 'Lot', dataIndex: 'lotNo' },
                { title: 'Expiry', render: (_, b) => expiryTag(b) },
                { title: `Remaining (${item.unit})`, dataIndex: 'qtyRemaining', align: 'right' },
                { title: 'Received', dataIndex: 'receivedQty', align: 'right' },
                { title: 'Unit cost', dataIndex: 'unitCost', align: 'right', render: (c: number) => formatINR(c) },
                { title: 'Location', dataIndex: 'location' },
                {
                  title: '',
                  render: (_, b) => (
                    <Space size={4}>
                      {nextLot(stock.batches)?.id === b.id && <Chip status="pass">Next to use</Chip>}
                      {actor.canManage && <Button size="small" onClick={() => setLotEdit({ b, lotNo: b.lotNo, expiry: b.expiry, location: b.location ?? '' })}>Edit</Button>}
                      {actor.canManage && <Button size="small" danger onClick={() => setLotDel({ b, reason: '' })}>Delete</Button>}
                      {actor.canManage && isExpired(b) && (
                        <Popconfirm title={`Write off ${b.qtyRemaining} ${item.unit} as expired?`} onConfirm={() => expire(b)}>
                          <Button size="small" danger>Mark expired</Button>
                        </Popconfirm>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          ),
        }}
      />
      <Modal open={!!lotEdit} title={`Edit lot ${lotEdit?.b.lotNo ?? ''}`} onCancel={() => setLotEdit(null)} onOk={saveLot} okText="Save" destroyOnHidden>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input aria-label="Lot number" value={lotEdit?.lotNo} onChange={(e) => lotEdit && setLotEdit({ ...lotEdit, lotNo: e.target.value })} />
          <DatePicker aria-label="Expiry date" style={{ width: '100%' }} value={lotEdit?.expiry ? dayjs(lotEdit.expiry) : null} onChange={(d) => lotEdit && setLotEdit({ ...lotEdit, expiry: d ? d.format('YYYY-MM-DD') : '' })} />
          <Input aria-label="Location" placeholder="Location" value={lotEdit?.location} onChange={(e) => lotEdit && setLotEdit({ ...lotEdit, location: e.target.value })} />
          <span className="qc-muted">The quantity cannot be edited here; use Adjust. The change is logged in the item's history.</span>
        </Space>
      </Modal>
      <Modal open={!!lotDel} title={`Remove lot ${lotDel?.b.lotNo ?? ''}`} onCancel={() => setLotDel(null)} onOk={removeLot} okText="Remove lot" okButtonProps={{ danger: true }} destroyOnHidden>
        <p>{lotDel?.b.qtyRemaining} left in this lot will be written off. The history is kept.</p>
        <Input.TextArea aria-label="Reason" rows={2} placeholder="Reason (required)" value={lotDel?.reason} onChange={(e) => lotDel && setLotDel({ ...lotDel, reason: e.target.value })} />
      </Modal>
      <ConsumeModal open={consume !== undefined} itemId={consume ?? undefined} inv={inv} onClose={() => setConsume(undefined)} />
      <AdjustModal open={!!adjust} itemId={adjust} inv={inv} onClose={() => setAdjust(null)} />
      <MovementDrawer item={history} batchById={inv.batchById} onClose={() => setHistory(null)} />
    </div>
  )
}
