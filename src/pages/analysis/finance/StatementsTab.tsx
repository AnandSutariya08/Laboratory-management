import { useMemo, useState } from 'react'
import { App, Input, Modal, Table } from 'antd'
import { addDoc, doc as fsDoc, getDoc, limit, orderBy, query, serverTimestamp, updateDoc, increment } from 'firebase/firestore'
import { col } from '../../../lib/db'
import { useAuth } from '../../../auth/AuthProvider'
import { useLiveQuery } from '../../../hooks/useLive'
import { useBranchScope } from '../../../lib/branchScope'
import { StatusChip } from '../../../design/StatusChip'
import dayjs from 'dayjs'
import { Button } from '../../../design/Button'
import { Card } from '../../../design/Card'
import { Segmented } from '../../../design/Segmented'
import { collectedOf, downloadCsv, ExportButton, money, rupees, type OrderExt, type Range } from '../shared'
import { type BaseTab, BASE_LABEL, PRESETS, buildRows, csvVal, type Ctx } from './model'
import { resolveCols } from './RowsTable'
import { dialogWidth } from '../../../design/dialog'

type PartyKind = 'referral' | 'b2b' | 'corporate'
const KEY: Record<PartyKind, (o: OrderExt) => string> = { referral: (o) => o.referrerName ?? '', b2b: (o) => o.b2bCentreName ?? '', corporate: (o) => o.corporateClientName ?? '' }
const KIND_TITLE: Record<PartyKind, string> = { referral: 'Referrer', b2b: 'B2B centre', corporate: 'Corporate client' }

interface Job {
  id: string
  type: BaseTab
  kind: PartyKind
  party?: string
  from: number
  to: number
  status: 'queued' | 'processing' | 'completed' | 'failed'
  requestedAt?: { toMillis: () => number } | null
  completedAt?: { toMillis: () => number } | null
  tookMs?: number
  error?: string
  rows?: number
}
const JOB_VARIANT = { queued: 'neutral', processing: 'info', completed: 'success', failed: 'urgent' } as const
const ts = (t?: { toMillis: () => number } | null) => (t ? dayjs(t.toMillis()).format('DD-MM-YYYY HH:mm') : '')

// Request a statement report as a background job; it is built on the server and listed here.
function StatementJobs({ kind, type, range }: { kind: PartyKind; type: BaseTab; range: Range }) {
  const { message } = App.useApp()
  const { user } = useAuth()
  const scope = useBranchScope({ analytics: true })
  const [party, setParty] = useState('')
  const { data: jobs, error } = useLiveQuery<Job>(query(col('statementJobs'), orderBy('requestedAt', 'desc'), limit(50)), [])
  
  const request = async () => {
    try {
      await addDoc(col('statementJobs'), {
        type, kind, party: party.trim(), branchId: scope.all ? '' : scope.branchId,
        from: range[0].startOf('day').valueOf(), to: range[1].endOf('day').valueOf(),
        status: 'queued', requestedBy: user?.uid ?? '', requestedAt: serverTimestamp(), retryCount: 0,
      })
      message.success('Statement requested. It appears below when ready.')
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const retry = (j: Job) => updateDoc(fsDoc(col('statementJobs'), j.id), { status: 'queued', retryCount: increment(1) }).catch((e) => message.error(e.message))
  const download = async (j: Job) => {
    const s = await getDoc(fsDoc(col('statementJobs'), j.id, 'files', 'csv'))
    const csv = (s.data() as { csv?: string } | undefined)?.csv
    if (!csv) return void message.error('The file is not available')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `statement-${j.type}-${dayjs(j.from).format('YYYYMMDD')}-${dayjs(j.to).format('YYYYMMDD')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="an-pill-row">
        <Input allowClear placeholder={`Only this ${KIND_TITLE[kind].toLowerCase()} (optional)`} aria-label="Party filter" style={{ width: 260 }} value={party} onChange={(e) => setParty(e.target.value)} />
        <Button variant="primary" onClick={request}>Request report</Button>
        <span className="an-note" style={{ margin: 0 }}>{BASE_LABEL[type]} for {range[0].format('DD-MM-YYYY')} to {range[1].format('DD-MM-YYYY')}, all {KIND_TITLE[kind].toLowerCase()}s unless one is named.</span>
      </div>
      {error && <p className="an-note">Statement jobs could not be loaded: {error.message}</p>}
      <Table<Job> size="small" rowKey="id" dataSource={jobs} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: 'No statement requests yet' }}
        columns={[
          { title: 'Statement type', render: (_, j) => `${BASE_LABEL[j.type]} (${KIND_TITLE[j.kind]})` },
          { title: 'Date range', render: (_, j) => `${dayjs(j.from).format('DD-MM-YYYY')} to ${dayjs(j.to).format('DD-MM-YYYY')}` },
          { title: 'Filters', render: (_, j) => j.party || 'All' },
          { title: 'Status', render: (_, j) => <StatusChip variant={JOB_VARIANT[j.status] ?? 'neutral'}>{j.status === 'failed' && j.error ? `Failed: ${j.error}` : j.status.charAt(0).toUpperCase() + j.status.slice(1)}</StatusChip> },
          { title: 'Requested at', render: (_, j) => ts(j.requestedAt) },
          { title: 'Completed at', render: (_, j) => ts(j.completedAt) },
          { title: 'Time taken', render: (_, j) => (j.tookMs != null ? `${Math.max(1, Math.round(j.tookMs / 1000))} s` : '') },
          { title: '', render: (_, j) => (j.status === 'completed' ? <Button onClick={() => download(j)}>Download</Button> : j.status === 'failed' ? <Button onClick={() => retry(j)}>Retry</Button> : null) },
        ]} />
    </div>
  )
}

export default function StatementsTab({ ctx, range, labName }: { ctx: Ctx; range: Range; labName: string }) {
  const [kind, setKind] = useState<PartyKind>('referral')
  const [type, setType] = useState<BaseTab>('billing')
  const [open, setOpen] = useState<string | null>(null)

  const parties = useMemo(() => {
    const m = new Map<string, OrderExt[]>()
    for (const o of ctx.orders) {
      const k = KEY[kind](o).trim()
      if (!k || (kind === 'referral' && k.toLowerCase() === 'self')) continue
      m.set(k, [...(m.get(k) ?? []), o])
    }
    return Array.from(m.entries()).map(([name, orders]) => ({ name, orders, bills: orders.length, net: orders.reduce((s, o) => s + o.net, 0), paid: orders.reduce((s, o) => s + collectedOf(o) - o.refunded, 0), due: orders.reduce((s, o) => s + o.due, 0) })).sort((a, b) => b.net - a.net)
  }, [ctx.orders, kind])

  const stmt = (name: string) => {
    const p = parties.find((x) => x.name === name)!
    const sub: Ctx = { ...ctx, orders: p.orders }
    const cols = resolveCols(PRESETS[type], [])
    const rows = buildRows(type === 'outsource' ? 'billing' : type, sub, [])
    return { p, cols, rows, sub }
  }
  const csv = (name: string) => {
    const { cols, rows, sub } = stmt(name)
    downloadCsv(`statement-${name}.csv`, [[`${KIND_TITLE[kind]}: ${name}`, `${range[0].format('DD-MM-YYYY')} to ${range[1].format('DD-MM-YYYY')}`], cols.map((c) => c.title), ...rows.map((r) => cols.map((c) => csvVal(c, c.get(r, sub))))])
  }
  const print = (name: string) => {
    const { p, cols, rows, sub } = stmt(name)
    const esc = (s: string | number) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const html = `<html><head><title>Statement ${esc(name)}</title><style>body{font:12px system-ui;margin:24px;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 6px;text-align:left}td.n{text-align:right}h1{font-size:18px;margin:0}</style></head><body><h1>${esc(labName)}: ${BASE_LABEL[type]} statement</h1><p>${KIND_TITLE[kind]}: <b>${esc(name)}</b><br>Period: ${range[0].format('DD-MM-YYYY')} to ${range[1].format('DD-MM-YYYY')}<br>Bills ${p.bills}, net ${money(p.net)}, paid ${money(p.paid)}, due ${money(p.due)}</p><table><tr>${cols.map((c) => `<th>${esc(c.title)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.money ? 'n' : ''}">${esc(c.money ? money(Number(c.get(r, sub))) : c.get(r, sub))}</td>`).join('')}</tr>`).join('')}</table></body></html>`
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(html); w.document.close(); w.focus(); w.print()
  }
  const exportAll = () => downloadCsv(`statements-${kind}.csv`, [[KIND_TITLE[kind], 'Bills', 'Net', 'Paid', 'Due'], ...parties.map((p) => [p.name, p.bills, rupees(p.net), rupees(p.paid), rupees(p.due)])])

  const shown = open ? stmt(open) : null
  return (
    <Card>
      <div className="an-pill-row">
        <Segmented<PartyKind> aria-label="Statement for" size="small" value={kind} onChange={setKind} options={[{ value: 'referral', label: 'Referrers' }, { value: 'b2b', label: 'B2B centres' }, { value: 'corporate', label: 'Corporate clients' }]} />
        <Segmented<BaseTab> aria-label="Statement type" size="small" value={type} onChange={setType} options={(['billing', 'collection', 'test'] as BaseTab[]).map((v) => ({ value: v, label: BASE_LABEL[v] }))} />
        <span className="an-toolbar__spacer" />
        <ExportButton label="Export summary" onClick={exportAll} disabled={!parties.length} />
      </div>
      <StatementJobs kind={kind} type={type} range={range} />
      <h3 className="an-card-title">Quick statements for this page's period</h3>
      <p className="an-note">One statement per party for {range[0].format('DD-MM-YYYY')} to {range[1].format('DD-MM-YYYY')}. Statements are generated instantly from the period's bills.</p>
      <Table size="small" rowKey="name" dataSource={parties} pagination={{ pageSize: 15, hideOnSinglePage: true }} locale={{ emptyText: `No ${KIND_TITLE[kind].toLowerCase()} bills in this period` }}
        columns={[
          { title: KIND_TITLE[kind], dataIndex: 'name' }, { title: 'Bills', dataIndex: 'bills', align: 'right' },
          { title: 'Net', dataIndex: 'net', align: 'right', render: money }, { title: 'Paid', dataIndex: 'paid', align: 'right', render: money }, { title: 'Due', dataIndex: 'due', align: 'right', render: money },
          { title: 'Actions', render: (_, p) => (<span className="an-pill-row" style={{ margin: 0 }}><Button onClick={() => setOpen(p.name)}>Preview</Button><Button onClick={() => print(p.name)}>Print</Button><Button onClick={() => csv(p.name)}>CSV</Button></span>) },
        ]} />
      <Modal open={!!shown} onCancel={() => setOpen(null)} footer={null} width={dialogWidth(1000)} title={shown ? `${BASE_LABEL[type]} statement: ${shown.p.name}` : ''}>
        {shown && <Table size="small" rowKey="key" pagination={{ pageSize: 20, hideOnSinglePage: true }} dataSource={shown.rows} scroll={{ x: 800 }} columns={shown.cols.map((c) => ({ title: c.title, key: c.key, align: c.money ? ('right' as const) : undefined, render: (_: unknown, r: (typeof shown.rows)[number]) => (c.money ? money(Number(c.get(r, shown.sub))) : c.get(r, shown.sub)) }))} />}
      </Modal>
    </Card>
  )
}
