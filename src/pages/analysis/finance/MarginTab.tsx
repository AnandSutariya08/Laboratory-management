import { useMemo, useState } from 'react'
import { App, Input, Modal, Table } from 'antd'
import dayjs from 'dayjs'
import { addDoc, doc, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { Button } from '../../../design/Button'
import { Card } from '../../../design/Card'
import { StatusChip } from '../../../design/StatusChip'
import { dialogWidth } from '../../../design/dialog'
import { useAuth } from '../../../auth/AuthProvider'
import { useLiveQuery } from '../../../hooks/useLive'
import { col } from '../../../lib/db'
import { branchParam } from '../../../lib/activeBranch'
import { downloadCsv, ExportButton, money, rupees, type MasterDoc, type Range } from '../shared'
import { buildRows, outsourceOf, type Ctx } from './model'
import { lineNet } from '../shared'
import { memberShare } from './model'

// Outsource wise margin and vendor settlement (FN-06). Per processing lab: what the bills charged for the outsourced
// tests, what the lab charges us (cost frozen on the bill line at billing), the margin, and how much of that cost has
// been settled. Settling a vendor locks the listed lines into one settlement record (labs/{lab}/outsourceSettlements);
// a line can only be settled once.
interface Line { key: string; vendor: string; testName: string; revenue: number; cost: number; billNo: string; date: number }
interface Settlement {
  id: string; vendor: string; from: string; to: string; lineKeys: string[]; lines: number; amount: number; revenue: number
  status: 'pending' | 'paid'; reference?: string; notes?: string; createdByName: string; createdAt?: { toMillis: () => number }; paidAt?: { toMillis: () => number }
}
const MAX_LINES = 4000

export default function MarginTab({ ctx, labs, range }: { ctx: Ctx; labs: MasterDoc[]; range: Range }) {
  const { profile } = useAuth()
  const { message } = App.useApp()
  const canWrite = ['labAdmin', 'admin', 'manager'].includes(profile?.role ?? '')
  const { data: settlements } = useLiveQuery<Settlement>(query(col('outsourceSettlements'), orderBy('createdAt', 'desc')), [])
  const [settle, setSettle] = useState<{ vendor: string; lines: Line[] } | null>(null)
  const [notes, setNotes] = useState('')
  const [paying, setPaying] = useState<Settlement | null>(null)
  const [payRef, setPayRef] = useState('')
  const [busy, setBusy] = useState(false)

  const settledKeys = useMemo(() => new Set(settlements.flatMap((s) => s.lineKeys ?? [])), [settlements])
  const lines = useMemo<Line[]>(() => buildRows('outsource', ctx, labs).map((r) => {
    const o = outsourceOf(r, labs)
    const revenue = r.item && r.testId ? lineNet(r.item) * memberShare(r.item, r.testId, ctx.testById) : 0
    return { key: `${r.o.id}:${r.item?.lineId}:${r.testId}`, vendor: o?.name || 'Unnamed lab', testName: r.test?.name ?? r.item?.name ?? '', revenue, cost: o?.price ?? 0, billNo: r.o.billNo, date: r.o.createdAt?.toMillis?.() ?? 0 }
  }), [ctx, labs])

  const vendors = useMemo(() => {
    const m = new Map<string, { vendor: string; tests: number; revenue: number; cost: number; settled: number; open: Line[] }>()
    for (const l of lines) {
      const v = m.get(l.vendor) ?? { vendor: l.vendor, tests: 0, revenue: 0, cost: 0, settled: 0, open: [] }
      v.tests++; v.revenue += l.revenue; v.cost += l.cost
      if (settledKeys.has(l.key)) v.settled += l.cost
      else v.open.push(l)
      m.set(l.vendor, v)
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost)
  }, [lines, settledKeys])

  const byTest = useMemo(() => {
    const m = new Map<string, { test: string; vendor: string; n: number; revenue: number; cost: number }>()
    for (const l of lines) {
      const k = `${l.testName}|${l.vendor}`
      const t = m.get(k) ?? { test: l.testName, vendor: l.vendor, n: 0, revenue: 0, cost: 0 }
      t.n++; t.revenue += l.revenue; t.cost += l.cost
      m.set(k, t)
    }
    return [...m.values()].sort((a, b) => b.revenue - b.cost - (a.revenue - a.cost))
  }, [lines])

  const total = vendors.reduce((a, v) => ({ revenue: a.revenue + v.revenue, cost: a.cost + v.cost }), { revenue: 0, cost: 0 })
  const pct = (rev: number, cost: number) => (rev > 0 ? `${(((rev - cost) / rev) * 100).toFixed(1)}%` : '')

  const create = async () => {
    if (!settle || !profile) return
    if (settle.lines.length > MAX_LINES) { message.error(`Too many lines for one settlement (${MAX_LINES} at most). Choose a shorter period.`); return }
    setBusy(true)
    try {
      await addDoc(col('outsourceSettlements'), {
        vendor: settle.vendor, from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD'),
        lineKeys: settle.lines.map((l) => l.key), lines: settle.lines.length,
        amount: settle.lines.reduce((s, l) => s + l.cost, 0), revenue: settle.lines.reduce((s, l) => s + l.revenue, 0),
        status: 'pending', reference: '', notes: notes.trim(), branchId: branchParam() === 'all' ? 'main' : branchParam(),
        createdBy: profile.uid, createdByName: profile.name, createdAt: serverTimestamp(),
      })
      message.success('Settlement created')
      setSettle(null); setNotes('')
    } catch { message.error('Could not create the settlement.') } finally { setBusy(false) }
  }
  const markPaid = async () => {
    if (!paying || !profile) return
    setBusy(true)
    try {
      await updateDoc(doc(col('outsourceSettlements'), paying.id), { status: 'paid', reference: payRef.trim(), paidAt: serverTimestamp(), paidBy: profile.uid, paidByName: profile.name })
      message.success('Marked as paid')
      setPaying(null); setPayRef('')
    } catch { message.error('Could not update the settlement.') } finally { setBusy(false) }
  }

  const exportVendors = () => downloadCsv('outsource-margin.csv', [['Lab', 'Tests', 'Revenue', 'Lab cost', 'Margin', 'Margin %', 'Settled', 'To settle'],
    ...vendors.map((v) => [v.vendor, v.tests, rupees(v.revenue), rupees(v.cost), rupees(v.revenue - v.cost), pct(v.revenue, v.cost), rupees(v.settled), rupees(v.cost - v.settled)])])

  return (
    <div className="an-stack">
      <Card>
        <div className="an-card-head">
          <h2 className="an-card-title">Outsource margin by lab</h2>
          <ExportButton onClick={exportVendors} disabled={!vendors.length} />
        </div>
        <p className="an-note">Revenue is the billed amount of the outsourced tests after discount. Lab cost is the price frozen on the bill at billing. {money(total.revenue - total.cost)} margin overall on {money(total.revenue)} revenue.</p>
        <Table size="small" rowKey="vendor" dataSource={vendors} pagination={false} locale={{ emptyText: 'No outsourced tests in this period' }} scroll={{ x: 820 }}
          columns={[
            { title: 'Lab', dataIndex: 'vendor' },
            { title: 'Tests', dataIndex: 'tests', align: 'right' },
            { title: 'Revenue', align: 'right', render: (_, v) => money(v.revenue) },
            { title: 'Lab cost', align: 'right', render: (_, v) => money(v.cost) },
            { title: 'Margin', align: 'right', render: (_, v) => <span className={v.revenue - v.cost < 0 ? 'an-due' : ''}>{money(v.revenue - v.cost)}</span> },
            { title: 'Margin %', align: 'right', render: (_, v) => pct(v.revenue, v.cost) },
            { title: 'Settled', align: 'right', render: (_, v) => money(v.settled) },
            { title: 'To settle', align: 'right', render: (_, v) => money(v.open.reduce((s, l) => s + l.cost, 0)) },
            { title: '', render: (_, v) => (canWrite && v.open.length ? <Button aria-label={`Settle ${v.vendor}`} onClick={() => setSettle({ vendor: v.vendor, lines: v.open })}>Settle</Button> : null) },
          ]} />
      </Card>

      <Card>
        <h2 className="an-card-title">Margin by test</h2>
        <Table size="small" rowKey={(r) => `${r.test}|${r.vendor}`} dataSource={byTest} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'No outsourced tests in this period' }}
          columns={[
            { title: 'Test', dataIndex: 'test' }, { title: 'Lab', dataIndex: 'vendor' }, { title: 'Count', dataIndex: 'n', align: 'right' },
            { title: 'Revenue', align: 'right', render: (_, r) => money(r.revenue) }, { title: 'Lab cost', align: 'right', render: (_, r) => money(r.cost) },
            { title: 'Margin', align: 'right', render: (_, r) => money(r.revenue - r.cost) }, { title: 'Margin %', align: 'right', render: (_, r) => pct(r.revenue, r.cost) },
          ]} />
      </Card>

      <Card>
        <h2 className="an-card-title">Vendor settlements</h2>
        <Table<Settlement> size="small" rowKey="id" dataSource={settlements} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'No settlements yet' }} scroll={{ x: 760 }}
          columns={[
            { title: 'Created', render: (_, s) => (s.createdAt ? dayjs(s.createdAt.toMillis()).format('DD-MM-YYYY') : '') },
            { title: 'Lab', dataIndex: 'vendor' },
            { title: 'Period', render: (_, s) => `${dayjs(s.from).format('DD MMM')} to ${dayjs(s.to).format('DD MMM YYYY')}` },
            { title: 'Tests', dataIndex: 'lines', align: 'right' },
            { title: 'Amount due to lab', align: 'right', render: (_, s) => money(s.amount) },
            { title: 'Status', render: (_, s) => <StatusChip variant={s.status === 'paid' ? 'success' : 'caution'}>{s.status === 'paid' ? 'Paid' : 'Pending'}</StatusChip> },
            { title: 'Reference', render: (_, s) => s.reference ?? '' },
            { title: '', render: (_, s) => (canWrite && s.status === 'pending' ? <Button onClick={() => setPaying(s)}>Mark paid</Button> : null) },
          ]} />
      </Card>

      {settle && (
        <Modal open title={`Settle ${settle.vendor}`} onCancel={() => setSettle(null)} onOk={create} okText="Create settlement" confirmLoading={busy} width={dialogWidth(520)}>
          <p>{settle.lines.length} outsourced tests from {range[0].format('DD MMM')} to {range[1].format('DD MMM YYYY')}, {money(settle.lines.reduce((s, l) => s + l.cost, 0))} payable to the lab. These tests are locked into this settlement and will not appear in another.</p>
          <Input.TextArea aria-label="Notes" placeholder="Notes (optional)" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Modal>
      )}
      {paying && (
        <Modal open title={`Mark paid: ${paying.vendor}`} onCancel={() => setPaying(null)} onOk={markPaid} okText="Mark paid" confirmLoading={busy} width={dialogWidth(440)}>
          <p>{money(paying.amount)} for {paying.lines} tests.</p>
          <Input aria-label="Payment reference" placeholder="Payment reference (UTR, cheque no.)" maxLength={80} value={payRef} onChange={(e) => setPayRef(e.target.value)} />
        </Modal>
      )}
    </div>
  )
}
