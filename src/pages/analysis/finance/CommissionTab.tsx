import { useMemo } from 'react'
import { Table } from 'antd'
import { Card } from '../../../design/Card'
import { StatusChip } from '../../../design/StatusChip'
import { collectedOf, downloadCsv, ExportButton, Kpi, money, rupees } from '../shared'
import { commissionOf, payStatus, type Ctx } from './model'
import type { OrderExt } from '../shared'

interface Row { key: string; name: string; type: string; rule: string; bills: number; gross: number; net: number; paid: number; commission: number; orders: OrderExt[] }

export default function CommissionTab({ ctx }: { ctx: Ctx }) {
  const rows = useMemo(() => {
    const m = new Map<string, Row>()
    for (const o of ctx.orders) {
      const name = o.referrerName?.trim()
      if (!name || name.toLowerCase() === 'self' || o.b2bCentreName) continue
      const ref = ctx.referrers.find((r) => (r.name ?? '').trim().toLowerCase() === name.toLowerCase())
      const r = m.get(name) ?? { key: name, name, type: ref?.type ?? 'doctor', rule: !ref || ref.commissionType === 'none' || !ref.commissionType ? 'None' : ref.commissionType === 'percent' ? `${ref.commissionValue}% of ${ctx.settings.referrals.commissionBasis}` : `Flat ${money(Number(ref.commissionValue ?? 0))} per bill`, bills: 0, gross: 0, net: 0, paid: 0, commission: 0, orders: [] }
      r.bills++; r.gross += o.gross; r.net += o.net; r.paid += collectedOf(o) - o.refunded; r.commission += commissionOf(o, ctx); r.orders.push(o)
      m.set(name, r)
    }
    return Array.from(m.values()).sort((a, b) => b.commission - a.commission)
  }, [ctx])
  const total = rows.reduce((s, r) => s + r.commission, 0)
  const exportCsv = () => downloadCsv('referral-commission.csv', [['Referrer', 'Type', 'Commission rule', 'Bills', 'Gross', 'Net', 'Paid', 'Commission'], ...rows.map((r) => [r.name, r.type, r.rule, r.bills, rupees(r.gross), rupees(r.net), rupees(r.paid), rupees(r.commission)])])
  return (
    <div className="an-stack">
      <div className="an-kpis">
        <Kpi label="Referrers" value={rows.length} />
        <Kpi label="Total commission" value={money(total)} tone="success" hint={`Basis: ${ctx.settings.referrals.commissionBasis}`} />
      </div>
      <Card>
        <div className="an-pill-row"><span className="an-toolbar__spacer" /><ExportButton onClick={exportCsv} disabled={!rows.length} /></div>
        <p className="an-note">Commission comes from each referrer's rule in the referral master. Referrers without a rule show zero.</p>
        <Table<Row> size="small" rowKey="key" dataSource={rows} pagination={{ pageSize: 15, hideOnSinglePage: true }} locale={{ emptyText: 'No referral bills in this period' }}
          expandable={{ expandedRowRender: (r) => (
            <Table size="small" rowKey="id" pagination={false} dataSource={r.orders} columns={[
              { title: 'Bill', dataIndex: 'billNo' }, { title: 'Patient', dataIndex: 'patientName' },
              { title: 'Net', align: 'right', render: (_, o) => money(o.net) },
              { title: 'Status', render: (_, o) => <StatusChip variant={payStatus(o) === 'Paid' ? 'success' : payStatus(o) === 'Partial' ? 'caution' : 'urgent'}>{payStatus(o)}</StatusChip> },
              { title: 'Commission', align: 'right', render: (_, o) => money(commissionOf(o, ctx)) },
            ]} />
          ) }}
          columns={[
            { title: 'Referrer', dataIndex: 'name' }, { title: 'Type', dataIndex: 'type' }, { title: 'Commission rule', dataIndex: 'rule' },
            { title: 'Bills', dataIndex: 'bills', align: 'right' },
            { title: 'Gross', dataIndex: 'gross', align: 'right', render: money }, { title: 'Net', dataIndex: 'net', align: 'right', render: money },
            { title: 'Paid', dataIndex: 'paid', align: 'right', render: money }, { title: 'Commission', dataIndex: 'commission', align: 'right', render: money },
          ]} />
      </Card>
    </div>
  )
}
