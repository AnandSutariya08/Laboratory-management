import { useMemo, useState } from 'react'
import { Input, Table } from 'antd'
import dayjs from 'dayjs'
import { Card } from '../../../design/Card'
import { Segmented } from '../../../design/Segmented'
import { clearedOf, collectedOf, isMoneyIn, downloadCsv, ExportButton, Kpi, lineNet, liveItems, money, MODE_BUCKETS, MODE_TITLE, modeBucket, rupees, testCount, tsMs, type ModeBucket } from '../shared'
import { commissionOf, type Ctx } from './model'

type View = 'day' | 'test' | 'b2b' | 'doctor' | 'hospital'
type Row = Record<string, string | number> & { key: string }

export default function SummaryTab({ ctx, basis = 'bill', onBasis, range }: { ctx: Ctx; basis?: 'bill' | 'payment'; onBasis?: (b: 'bill' | 'payment') => void; range?: [dayjs.Dayjs, dayjs.Dayjs] }) {
  const [view, setView] = useState<View>('day')
  const [q, setQ] = useState('')
  const orders = useMemo(() => ctx.orders.filter((o) => !q || o.billNo.toLowerCase().includes(q.toLowerCase())), [ctx.orders, q])

  const totals = useMemo(() => {
    const t = { bills: orders.length, gross: 0, discount: 0, net: 0, paid: 0, due: 0, refunds: 0, cleared: 0 }
    for (const o of orders) {
      t.gross += o.gross; t.discount += o.discount; t.net += o.net; t.paid += collectedOf(o) - o.refunded; t.due += o.due; t.refunds += o.refunded
      t.cleared += clearedOf(ctx.ledgers[o.id] ?? [])
    }
    return t
  }, [orders, ctx.ledgers])

  const { cols, rows } = useMemo(() => {
    const m = new Map<string, Row>()
    const bump = (key: string, init: Row, f: (r: Row) => void) => { const r = m.get(key) ?? init; f(r); m.set(key, r) }
    const refType = (name: string) => (ctx.referrers.find((r) => (r.name ?? '').toLowerCase() === name.toLowerCase())?.type ?? 'doctor')
    for (const o of orders) {
      const entries = ctx.ledgers[o.id] ?? []
      const clearIds = new Set(entries.filter((e) => e.type === 'clearDue').map((e) => e.id))
      if (view === 'day' && basis === 'payment') {
        // Money received in the dates, grouped by the day it came in (backdated receipts use their payment date).
        const seen = new Set<string>()
        for (const e of entries) {
          if (!isMoneyIn(e)) continue
          const at = (e as { backdatedTo?: { toMillis?: () => number } }).backdatedTo?.toMillis?.() ?? tsMs((e as { postedAt?: unknown }).postedAt as never) ?? 0
          const day = dayjs(at)
          if (range && (day.isBefore(range[0].startOf('day')) || day.isAfter(range[1].endOf('day')))) continue
          const d = day.format('YYYY-MM-DD')
          bump(d, { key: d, date: dayjs(d).format('DD-MM-YYYY'), from: o.billNo, to: o.billNo, bills: 0, amount: 0, paid: 0, due: 0, cash: 0, upi: 0, card: 0, wallet: 0, other: 0, cleared: 0 }, (r) => {
            if (!seen.has(d)) { seen.add(d); r.bills = +r.bills + 1 }
            if (o.billNo < String(r.from)) r.from = o.billNo
            if (o.billNo > String(r.to)) r.to = o.billNo
            r.paid = +r.paid + e.amount
            const b = modeBucket(e.mode); r[b] = +r[b] + e.amount
            if (e.type === 'clearDue' || (e.type === 'reversal' && clearIds.has(e.reversesId ?? ''))) r.cleared = +r.cleared + e.amount
          })
        }
      } else if (view === 'day') {
        const d = dayjs(tsMs(o.createdAt) ?? 0).format('YYYY-MM-DD')
        bump(d, { key: d, date: dayjs(d).format('DD-MM-YYYY'), from: o.billNo, to: o.billNo, bills: 0, amount: 0, paid: 0, due: 0, cash: 0, upi: 0, card: 0, wallet: 0, other: 0, cleared: 0 }, (r) => {
          r.bills = +r.bills + 1; r.amount = +r.amount + o.net; r.paid = +r.paid + collectedOf(o) - o.refunded; r.due = +r.due + o.due
          if (o.billNo < String(r.from)) r.from = o.billNo
          if (o.billNo > String(r.to)) r.to = o.billNo
          for (const e of entries) {
            if (!isMoneyIn(e)) continue
            const b = modeBucket(e.mode); r[b] = +r[b] + e.amount
            if (e.type === 'clearDue' || (e.type === 'reversal' && clearIds.has(e.reversesId ?? ''))) r.cleared = +r.cleared + e.amount
          }
        })
      } else if (view === 'test') {
        for (const i of liveItems(o)) for (const tid of i.testIds) {
          const name = ctx.testById.get(tid)?.name ?? i.name
          bump(name, { key: name, name, volume: 0, amount: 0, discount: 0, net: 0 }, (r) => {
            const n = Math.max(1, i.testIds.length); r.volume = +r.volume + 1; r.amount = +r.amount + i.price / n; r.discount = +r.discount + i.discount / n; r.net = +r.net + lineNet(i) / n
          })
        }
      } else if (view === 'b2b') {
        if (!o.b2bCentreName) continue
        bump(o.b2bCentreName, { key: o.b2bCentreName, name: o.b2bCentreName, pro: o.proName ?? '', bills: 0, tests: 0, amount: 0, paid: 0, due: 0 }, (r) => {
          r.bills = +r.bills + 1; r.tests = +r.tests + testCount(o); r.amount = +r.amount + o.net; r.paid = +r.paid + collectedOf(o) - o.refunded; r.due = +r.due + o.due
        })
      } else {
        const name = o.hospitalName || o.referrerName || 'Self'
        const isHosp = o.hospitalName ? true : refType(o.referrerName) === 'hospital'
        if ((view === 'hospital') !== isHosp || !name || name === 'Self' || o.b2bCentreName) continue
        bump(name, { key: name, name, bills: 0, amount: 0, discount: 0, net: 0, paid: 0, due: 0, commission: 0 }, (r) => {
          r.bills = +r.bills + 1; r.amount = +r.amount + o.gross; r.discount = +r.discount + o.discount; r.net = +r.net + o.net
          r.paid = +r.paid + collectedOf(o) - o.refunded; r.due = +r.due + o.due; r.commission = +r.commission + commissionOf(o, ctx)
        })
      }
    }
    const list = Array.from(m.values()).sort((a, b) => (view === 'day' ? String(b.key).localeCompare(String(a.key)) : +(b.net ?? b.amount ?? 0) - +(a.net ?? a.amount ?? 0)))
    const C = (title: string, key: string, isMoney = false) => ({ title, key, isMoney })
    const defs: Record<View, ReturnType<typeof C>[]> = {
      day: [C('Bill date', 'date'), C('From bill ID', 'from'), C('To bill ID', 'to'), C('Bills', 'bills'), C('Billing amount', 'amount', true), C('Paid', 'paid', true), C('Due', 'due', true), ...(['cash', 'upi', 'card', 'wallet', 'other'] as ModeBucket[]).map((b) => C(MODE_TITLE[b], b, true)), C('Clear due received', 'cleared', true)],
      test: [C('Test / package', 'name'), C('Volume', 'volume'), C('Amount', 'amount', true), C('Discount', 'discount', true), C('Net', 'net', true)],
      b2b: [C('B2B name', 'name'), C('PRO', 'pro'), C('Bills', 'bills'), C('Tests', 'tests'), C('Amount', 'amount', true), C('Paid', 'paid', true), C('Due', 'due', true)],
      doctor: [C('Doctor', 'name'), C('Bills', 'bills'), C('Amount', 'amount', true), C('Discount', 'discount', true), C('Net', 'net', true), C('Paid', 'paid', true), C('Due', 'due', true), C('Commission', 'commission', true)],
      hospital: [C('Hospital', 'name'), C('Bills', 'bills'), C('Amount', 'amount', true), C('Discount', 'discount', true), C('Net', 'net', true), C('Paid', 'paid', true), C('Due', 'due', true), C('Commission', 'commission', true)],
    }
    return { cols: defs[view], rows: list }
  }, [orders, view, ctx, basis, range])

  void MODE_BUCKETS
  const exportCsv = () => downloadCsv(`summary-${view}.csv`, [cols.map((c) => c.title), ...rows.map((r) => cols.map((c) => (c.isMoney ? rupees(+r[c.key]) : r[c.key])))])

  return (
    <div className="an-stack">
      <div className="an-kpis">
        <Kpi label="Bills" value={totals.bills} />
        <Kpi label="Gross amount" value={money(totals.gross)} />
        <Kpi label="Discount" value={money(totals.discount)} />
        <Kpi label="Net amount" value={money(totals.net)} />
        <Kpi label="Paid" value={money(totals.paid)} tone="success" />
        <Kpi label="Due" value={money(totals.due)} tone="urgent" />
        <Kpi label="Refunds" value={money(totals.refunds)} />
        <Kpi label="Due cleared" value={money(totals.cleared)} />
      </div>
      <Card>
        <div className="an-pill-row">
          {onBasis && <Segmented<'bill' | 'payment'> aria-label="Summary basis" size="small" value={basis} onChange={onBasis} options={[{ value: 'bill', label: 'By bill date' }, { value: 'payment', label: 'By payment date' }]} />}
          <Segmented<View> aria-label="Summary view" size="small" value={view} onChange={setView} options={[{ value: 'day', label: 'Day wise' }, { value: 'test', label: 'Test / package wise' }, { value: 'b2b', label: 'B2B wise' }, { value: 'doctor', label: 'Ref doctor wise' }, { value: 'hospital', label: 'Ref hospital wise' }]} />
          <Input allowClear placeholder="Search bill ID" aria-label="Search bill ID" style={{ width: 180 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="an-toolbar__spacer" />
          <ExportButton onClick={exportCsv} disabled={!rows.length} />
        </div>
        <Table<Row> size="small" rowKey="key" dataSource={rows} pagination={{ pageSize: 25, hideOnSinglePage: true }} scroll={{ x: 900 }} locale={{ emptyText: 'No data in this period' }}
          columns={cols.map((c) => ({ title: c.title, dataIndex: c.key, align: c.isMoney || /^(bills|tests|volume)$/.test(c.key) ? ('right' as const) : undefined, render: (v: number | string) => (c.isMoney ? money(+v) : v) }))} />
      </Card>
    </div>
  )
}
