import { useMemo, useState } from 'react'
import { Input, Select, Table } from 'antd'
import { Card } from '../../../design/Card'
import { money, downloadCsv, ExportButton, type MasterDoc } from '../shared'
import { COL_BY_KEY, csvVal, outsourceCols, outsourceOf, payStatus, type BaseTab, type ColDef, type Ctx, type FRow } from './model'

export interface TabFilters { search?: string; referral?: string; status?: string; user?: string; dept?: string; lab?: string; test?: string }

export function applyFilters(rows: FRow[], f: TabFilters, ctx: Ctx, labs: MasterDoc[]) {
  const s = (f.search ?? '').trim().toLowerCase()
  return rows.filter((r) => {
    if (f.referral && r.o.referrerName !== f.referral) return false
    if (f.status && payStatus(r.o) !== f.status) return false
    if (f.user && r.o.createdBy !== f.user) return false
    if (f.dept && (!r.testId || ctx.deptName(r.testId) !== f.dept)) return false
    if (f.test && r.testId !== f.test) return false
    if (f.lab && outsourceOf(r, labs)?.name !== f.lab) return false
    if (s && !`${r.o.billNo} ${r.o.patientName} ${r.o.patientNo} ${r.o.referrerName} ${r.test?.name ?? ''}`.toLowerCase().includes(s)) return false
    return true
  })
}

export const resolveCols = (keys: string[], labs: MasterDoc[]): ColDef[] => {
  const extra = new Map(outsourceCols(labs).map((c) => [c.key, c]))
  return keys.map((k) => COL_BY_KEY.get(k) ?? extra.get(k)).filter(Boolean) as ColDef[]
}

export function FilterBar({ base, filters, onChange, ctx, labs, users }: { base: BaseTab; filters: TabFilters; onChange: (f: TabFilters) => void; ctx: Ctx; labs: MasterDoc[]; users: { uid: string; name: string }[] }) {
  const set = (p: Partial<TabFilters>) => onChange({ ...filters, ...p })
  const refs = useMemo(() => Array.from(new Set(ctx.orders.map((o) => o.referrerName).filter(Boolean))).sort(), [ctx.orders])
  const depts = useMemo(() => Array.from(new Set(ctx.testById.size ? Array.from(ctx.testById.keys()).map((id) => ctx.deptName(id)) : [])).sort(), [ctx])
  const sel = (ph: string, key: keyof TabFilters, options: { value: string; label: string }[], w = 190) => (
    <Select allowClear showSearch optionFilterProp="label" placeholder={ph} aria-label={ph} style={{ width: w }} value={filters[key] || undefined} onChange={(v) => set({ [key]: v ?? '' })} options={options} />
  )
  return (
    <div className="an-pill-row">
      <Input allowClear placeholder="Search bill, patient, referral" aria-label="Search" className="search-wide" value={filters.search ?? ''} onChange={(e) => set({ search: e.target.value })} />
      {sel('All referrals', 'referral', refs.map((r) => ({ value: r, label: r })))}
      {base !== 'outsource' && sel('Payment status', 'status', ['Paid', 'Partial', 'Due'].map((v) => ({ value: v, label: v })), 180)}
      {sel('Billed by', 'user', users.map((u) => ({ value: u.uid, label: u.name })))}
      {base === 'test' && sel('Department', 'dept', depts.map((d) => ({ value: d, label: d })))}
      {base === 'outsource' && sel('Test', 'test', Array.from(ctx.testById.values()).map((t) => ({ value: t.id, label: t.name })))}
      {base === 'outsource' && sel('Outsource lab', 'lab', labs.map((l) => ({ value: l.name ?? l.id, label: l.name ?? l.id })))}
    </div>
  )
}

export interface ExportSettings { fileName?: string; includeTotals?: boolean; includeHeader?: boolean; delimiter?: ',' | ';' | '\t' | '|' }

const csvText = (table: (string | number)[][], d: string) =>
  table.map((r) => r.map((v) => { const t = String(v ?? ''); return t.includes(d) || /["\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }).join(d)).join('\n')

export function RowsTable({ rows, cols, ctx, fileName, pinned = [], empty, settings, actions }: { rows: FRow[]; cols: ColDef[]; ctx: Ctx; fileName: string; pinned?: string[]; empty?: string; settings?: ExportSettings; actions?: React.ReactNode }) {
  const [page, setPage] = useState(1)
  const totals = useMemo(() => {
    const t: Record<string, number> = {}
    for (const c of cols) if (c.money) t[c.key] = rows.reduce((s, r) => s + Number(c.get(r, ctx) || 0), 0)
    return t
  }, [rows, cols, ctx])
  const exportCsv = () => {
    const table = [
      ...(settings?.includeHeader === false ? [] : [cols.map((c) => c.title)]),
      ...rows.map((r) => cols.map((c) => csvVal(c, c.get(r, ctx)))),
      ...(settings?.includeTotals === false ? [] : [cols.map((c, i) => (i === 0 ? 'Total' : c.money ? csvVal(c, totals[c.key]) : ''))]),
    ]
    if (!settings) return downloadCsv(`${fileName}.csv`, table)
    const name = (settings.fileName || fileName).replace(/[^\w .-]+/g, '-')
    const blob = new Blob(['\ufeff' + csvText(table, settings.delimiter ?? ',')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <Card padding={0} style={{ overflow: 'hidden' }}>
      <div className="an-pill-row" style={{ padding: 'var(--s-3) var(--s-4) 0' }}>
        <span className="an-note" style={{ margin: 0 }}>{rows.length} rows</span>
        <span className="an-toolbar__spacer" />
        {actions}
        <ExportButton onClick={exportCsv} disabled={!rows.length} />
      </div>
      <Table<FRow>
        size="small" rowKey="key" dataSource={rows} scroll={{ x: Math.max(900, cols.length * 130) }}
        pagination={{ pageSize: 50, showSizeChanger: false, current: page, onChange: setPage, hideOnSinglePage: true }}
        locale={{ emptyText: empty ?? 'No rows for these filters' }}
        columns={cols.map((c) => ({
          title: c.title, key: c.key, align: c.money ? ('right' as const) : undefined, fixed: pinned.includes(c.key) ? ('left' as const) : undefined,
          render: (_: unknown, r: FRow) => { const v = c.get(r, ctx); const t = c.money ? money(Number(v)) : v; return c.key === 'due' && Number(v) > 0 ? <span className="an-due">{t}</span> : t },
        }))}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row className="an-total-row">
              {cols.map((c, i) => (
                <Table.Summary.Cell key={c.key} index={i} align={c.money ? 'right' : undefined}>{i === 0 ? `Total (${rows.length})` : c.money ? money(totals[c.key]) : ''}</Table.Summary.Cell>
              ))}
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />
    </Card>
  )
}
