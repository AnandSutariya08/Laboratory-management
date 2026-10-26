import { useMemo } from 'react'
import { Drawer, Table } from 'antd'
import { StatusChip, type StatusVariant } from '../../../design/StatusChip'
import { query, where } from 'firebase/firestore'
import dayjs from 'dayjs'
import { col } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import type { InventoryItem, MovementType, StockBatch, StockMovement } from '../types'
import { INV, tsDate } from '../lib/stock'
import { useBranchScope } from '../../../lib/branchScope'

export const MOVEMENT_LABEL: Record<MovementType, { text: string; variant: StatusVariant }> = {
  receive: { text: 'Received', variant: 'success' },
  consume_auto: { text: 'Auto-consumed', variant: 'info' },
  consume_manual: { text: 'Manual use', variant: 'info' },
  adjust: { text: 'Adjusted', variant: 'caution' },
  expire: { text: 'Expired', variant: 'urgent' },
  return: { text: 'Returned', variant: 'neutral' },
}

export default function MovementDrawer({
  item,
  batchById,
  onClose,
}: {
  item: InventoryItem | null
  batchById: Map<string, StockBatch>
  onClose: () => void
}) {
  const scope = useBranchScope()
  const { data, loading } = useLiveQuery<StockMovement>(
    item ? query(col(INV.movements), ...scope.constraints, where('itemId', '==', item.id)) : null,
    [item?.id, scope.key],
  )
  const rows = useMemo(() => {
    const asc = [...data].sort((a, b) => tsDate(a.at).getTime() - tsDate(b.at).getTime())
    let bal = 0
    const withBal = asc.map((m) => {
      bal = Math.round((bal + m.qty) * 10000) / 10000
      return { ...m, balance: bal }
    })
    return withBal.reverse()
  }, [data])

  return (
    <Drawer title={item ? `Movement history - ${item.name}` : ''} open={!!item} onClose={onClose} size={820} destroyOnHidden>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'When', dataIndex: 'at', render: (t) => dayjs(tsDate(t)).format('DD MMM YY HH:mm') },
          { title: 'Type', dataIndex: 'type', render: (t: MovementType) => <StatusChip variant={MOVEMENT_LABEL[t].variant}>{MOVEMENT_LABEL[t].text}</StatusChip> },
          { title: 'Lot', dataIndex: 'batchId', render: (id: string) => batchById.get(id)?.lotNo ?? '-' },
          {
            title: `Qty (${item?.unit ?? ''})`,
            dataIndex: 'qty',
            align: 'right',
            render: (q: number, m) =>
              m.shortfall > 0 ? <StatusChip variant="urgent">short {m.shortfall}</StatusChip> : <span style={{ color: q < 0 ? 'var(--c-urgent)' : 'var(--c-success)' }}>{q > 0 ? `+${q}` : q}</span>,
          },
          { title: 'Balance', dataIndex: 'balance', align: 'right' },
          { title: 'Reason', dataIndex: 'reason' },
          { title: 'By', dataIndex: 'by' },
        ]}
      />
    </Drawer>
  )
}
