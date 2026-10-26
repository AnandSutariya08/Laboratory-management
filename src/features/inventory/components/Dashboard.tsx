import { useMemo, useState } from 'react'
import { App, Button, DatePicker, Popconfirm, Space, Table } from 'antd'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { orderBy, query, where, Timestamp } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import dayjs, { type Dayjs } from 'dayjs'
import { col } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import { formatINR } from '../../../lib/money'
import type { StockMovement } from '../types'
import type { InventoryData } from '../lib/useInventory'
import { expiredBatches, expiringSoon, INV, lowStockItems, markExpired, tsDate } from '../lib/stock'
import { ConsumeModal } from './StockModals'
import { expiryTag } from './CurrentStock'
import { useActor } from './useActor'
import { useBranchScope } from '../../../lib/branchScope'
import { Panel, StatTile, TileGrid, Chip } from '../../qc/ui'
import { Segmented } from '../../../design/Segmented'
import { fmtDate } from '../../../components/results/common'
import { MOVEMENT_LABEL } from './MovementDrawer'

const useMovementsSince = (from: Dayjs, to: Dayjs) => {
  const scope = useBranchScope()
  return useLiveQuery<StockMovement>(
    query(
      col(INV.movements),
      ...scope.constraints,
      where('at', '>=', Timestamp.fromDate(from.startOf('day').toDate())),
      where('at', '<=', Timestamp.fromDate(to.endOf('day').toDate())),
      orderBy('at'),
    ),
    [from.valueOf(), to.valueOf(), scope.key],
  )
}

export default function Dashboard({ inv }: { inv: InventoryData }) {
  const { message } = App.useApp()
  const nav = useNavigate()
  const actor = useActor()
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, 'day'), dayjs()])
  const [group, setGroup] = useState<'day' | 'month'>('day')
  const [mode, setMode] = useState<'purchase' | 'consumption'>('purchase')
  const [consumeOpen, setConsumeOpen] = useState(false)

  const month = useMovementsSince(dayjs().startOf('month'), dayjs())
  const ranged = useMovementsSince(range[0], range[1])

  const monthSpend = useMemo(
    () => month.data.filter((m) => m.type === 'receive').reduce((s, m) => s + m.qty * m.unitCost, 0),
    [month.data],
  )

  const chart = useMemo(() => {
    const fmt = group === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM'
    const sums = new Map<string, number>()
    // Seed every bucket so gaps show as zero.
    for (let d = range[0].startOf(group); !d.isAfter(range[1]); d = d.add(1, group)) sums.set(d.format(fmt), 0)
    for (const m of ranged.data) {
      const hit = mode === 'purchase' ? m.type === 'receive' : m.type === 'consume_auto' || m.type === 'consume_manual'
      if (!hit) continue
      const k = dayjs(tsDate(m.at)).format(fmt)
      sums.set(k, (sums.get(k) ?? 0) + Math.abs(m.qty) * m.unitCost)
    }
    return [...sums].map(([label, paise]) => ({ label, value: Math.round(paise) / 100 }))
  }, [ranged.data, range, group, mode])
  const chartTotal = chart.reduce((s, c) => s + c.value, 0)

  const { levels, items, batches } = inv
  const active = items.filter((i) => i.active)
  const inStock = active.filter((i) => (levels.get(i.id)?.qty ?? 0) > 0).length
  const outOfStock = active.length - inStock
  const lowList = lowStockItems(items, levels)
  const lowCount = lowList.filter((i) => (levels.get(i.id)?.qty ?? 0) > 0).length
  const expiring = expiringSoon(batches)
  const expired = expiredBatches(batches)

  const writeOff = async () => {
    try {
      for (const b of expired) await markExpired(b.id, actor.name)
      message.success('Expired lots written off')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const tile = (label: string, value: number | string, tone?: 'urgent' | 'caution', to?: string) => (
    <StatTile key={label} label={label} value={value} tone={value ? tone : undefined} onClick={to ? () => nav(to) : undefined} />
  )
  const recent = useMemo(() => [...ranged.data].reverse().slice(0, 12), [ranged.data])
  const orders = inv.pos.filter((p) => p.status !== 'draft' && p.status !== 'cancelled').slice(0, 8)

  return (
    <Space vertical size="middle" style={{ width: '100%' }}>
      <TileGrid>
        {tile('Items in stock', inStock, undefined, '/inventory/stock')}
        {tile('Low stock', lowCount, 'caution', '/inventory/stock')}
        {tile('Out of stock', outOfStock, 'urgent', '/inventory/stock')}
        {tile('Expiring in 30 days', expiring.length, 'caution')}
        {tile('Expired lots', expired.length, 'urgent')}
        {tile("This month's spend", formatINR(Math.round(monthSpend)))}
      </TileGrid>

      <Space wrap>
        <Button type="primary" onClick={() => setConsumeOpen(true)}>Manual consumption</Button>
        <Button onClick={() => nav('/inventory/purchase-orders')}>Go to cart / purchase orders</Button>
        <Button onClick={() => nav('/inventory/items')}>Items &amp; suppliers</Button>
        <Button onClick={() => nav('/inventory/mapping')}>Stock mapping</Button>
        {actor.canManage && expired.length > 0 && (
          <Popconfirm title={`Write off ${expired.length} expired lot(s)?`} onConfirm={writeOff}>
            <Button danger>Write off expired</Button>
          </Popconfirm>
        )}
      </Space>

      <Panel
        title={`Expenditure - ${formatINR(Math.round(chartTotal * 100))}`}
        extra={
          <Space wrap>
            <Segmented size="small" aria-label="Expenditure type" value={mode} onChange={setMode} options={[{ value: 'purchase', label: 'Purchases' }, { value: 'consumption', label: 'Consumption cost' }]} />
            <Segmented size="small" aria-label="Group by" value={group} onChange={setGroup} options={[{ value: 'day', label: 'Day' }, { value: 'month', label: 'Month' }]} />
            <DatePicker.RangePicker size="small" allowClear={false} value={range} onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} />
          </Space>
        }
      >
        <div style={{ height: 260, color: 'var(--c-primary)' }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatINR(Math.round(Number(v) * 100))} />
              <Bar dataKey="value" name="Amount" fill="currentColor" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="two-col">
          <Panel size="small" title="Low stock">
            <Table
              size="small"
              rowKey="id"
              pagination={{ pageSize: 6, hideOnSinglePage: true }}
              dataSource={lowList}
              locale={{ emptyText: 'Nothing below reorder level' }}
              columns={[
                { title: 'Item', dataIndex: 'name' },
                { title: 'In stock', align: 'right', render: (_, i) => `${levels.get(i.id)?.qty ?? 0} ${i.unit}` },
                { title: 'Reorder at', dataIndex: 'reorderLevel', align: 'right' },
                { title: '', render: (_, i) => ((levels.get(i.id)?.qty ?? 0) <= 0 ? <Chip status="fail">Out</Chip> : <Chip status="warning">Low</Chip>) },
              ]}
            />
          </Panel>
          <Panel size="small" title="Expiring and expired lots">
            <Table
              size="small"
              rowKey="id"
              pagination={{ pageSize: 6, hideOnSinglePage: true }}
              dataSource={[...expired, ...expiring]}
              locale={{ emptyText: 'No lots near expiry' }}
              columns={[
                { title: 'Item', render: (_, b) => inv.itemById.get(b.itemId)?.name ?? '-' },
                { title: 'Lot', dataIndex: 'lotNo' },
                { title: 'Expiry', render: (_, b) => expiryTag(b) },
                { title: 'Qty', dataIndex: 'qtyRemaining', align: 'right' },
              ]}
            />
          </Panel>
      </div>
      <div className="two-col">
        <Panel title="Orders placed and received">
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={orders}
            locale={{ emptyText: 'No purchase orders yet' }}
            columns={[
              { title: 'PO', dataIndex: 'poNo' },
              { title: 'Supplier', render: (_, o) => inv.supplierById.get(o.supplierId)?.name ?? '-' },
              { title: 'Items', align: 'right', render: (_, o) => o.lines.length },
              { title: 'Total', align: 'right', render: (_, o) => formatINR(o.total) },
              { title: 'Date', render: (_, o) => fmtDate(o.orderedAt ?? o.createdAt) },
              { title: 'Status', render: (_, o) => <Chip status={o.status === 'received' ? 'completed' : o.status === 'partially_received' ? 'pending' : 'scheduled'}>{o.status.replace('_', ' ')}</Chip> },
            ]}
          />
        </Panel>
        <Panel title="Activity tracking">
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={recent}
            locale={{ emptyText: 'No stock movement in this range' }}
            columns={[
              { title: 'Item', render: (_, m) => inv.itemById.get(m.itemId)?.name ?? '-' },
              { title: 'Change', render: (_, m) => MOVEMENT_LABEL[m.type]?.text ?? m.type },
              { title: 'Qty', align: 'right', render: (_, m) => (m.qty > 0 ? `+${m.qty}` : m.qty) },
              { title: 'By', dataIndex: 'by' },
              { title: 'When', render: (_, m) => dayjs(tsDate(m.at)).format('DD MMM, h:mm A') },
            ]}
          />
        </Panel>
      </div>
      <ConsumeModal open={consumeOpen} inv={inv} onClose={() => setConsumeOpen(false)} />
    </Space>
  )
}
