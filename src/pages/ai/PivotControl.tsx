import { useState } from 'react'
import { Alert, Button, Select, Space, Switch, Table, Typography } from 'antd'
import { runAnalyticsIn } from '../../lib/aiAnalyst'
import { formatValue } from '../../components/ai/AnalyticsChart'
import { downloadCsv } from '../../components/billing/helpers'
import type { AnalyticsQuery, AnalyticsResult } from '../../types'

const { Text } = Typography

type RowDim = Exclude<AnalyticsQuery['groupBy'], 'none' | 'day' | 'week' | 'month'>
const ROW_DIMS: { value: RowDim; label: string }[] = [
  { value: 'referrer', label: 'Referrer' },
  { value: 'department', label: 'Department' },
  { value: 'test', label: 'Test' },
  { value: 'paymentMode', label: 'Payment mode' },
  { value: 'status', label: 'Status' },
  { value: 'user', label: 'User' },
]
type ColDim = 'none' | 'month' | 'week'

const MAX_COLS = 12
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const parse = (s: string) => new Date(`${s}T00:00:00Z`)

// Split the table's date range into month or Monday-start week buckets (clipped to the range), newest MAX_COLS.
function buckets(from: string, to: string, by: 'month' | 'week'): { label: string; from: string; to: string }[] {
  const start = parse(from)
  const end = parse(to)
  const out: { label: string; from: string; to: string }[] = []
  let cur = start
  while (cur <= end) {
    let next: Date
    if (by === 'month') next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1))
    else next = new Date(cur.getTime() + (8 - (cur.getUTCDay() || 7)) * 86_400_000) // next Monday
    const last = new Date(Math.min(next.getTime() - 86_400_000, end.getTime()))
    out.push({ label: by === 'month' ? ymd(cur).slice(0, 7) : ymd(cur), from: ymd(cur), to: ymd(last) })
    cur = next
  }
  return out.slice(-MAX_COLS)
}

interface Matrix {
  unit: AnalyticsResult['unit']
  cols: string[]
  rows: { label: string; cells: number[]; total: number }[]
}

// Client-side pivot for table widgets: choose the row dimension and optionally split columns by month or
// week. Re-queries through runAnalytics (one query per column), or pivots the returned rows when unchanged.
export default function PivotControl({ base, branchId }: { base: AnalyticsResult; branchId?: string }) {
  const baseDim = base.query.groupBy
  const [rowDim, setRowDim] = useState<RowDim | undefined>(ROW_DIMS.some((d) => d.value === baseDim) ? (baseDim as RowDim) : undefined)
  const [colDim, setColDim] = useState<ColDim>('none')
  const [transpose, setTranspose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matrix, setMatrix] = useState<Matrix | null>(null)

  const apply = async () => {
    if (!rowDim) return
    setBusy(true)
    setError(null)
    try {
      const q = base.query
      if (colDim === 'none') {
        const r = rowDim === baseDim ? base : await runAnalyticsIn({ query: { ...q, groupBy: rowDim, limit: 500 }, branchId })
        setMatrix({ unit: r.unit, cols: [q.metric], rows: r.rows.map((x) => ({ label: x.label, cells: [x.value], total: x.value })) })
      } else {
        const bs = buckets(base.from, base.to, colDim)
        const results = await Promise.all(bs.map((b) => runAnalyticsIn({ query: { ...q, groupBy: rowDim, range: { from: b.from, to: b.to }, limit: 500 }, branchId })))
        const labels = [...new Set(results.flatMap((r) => r.rows.map((x) => x.label)))]
        const rows = labels
          .map((label) => {
            const cells = results.map((r) => r.rows.find((x) => x.label === label)?.value ?? 0)
            return { label, cells, total: cells.reduce((a, b) => a + b, 0) }
          })
          .sort((a, b) => b.total - a.total)
          .slice(0, 50)
        setMatrix({ unit: results[0]?.unit ?? base.unit, cols: bs.map((b) => b.label), rows })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\s*\[\d+\]\s*$/, '') : 'Could not pivot this table')
      setMatrix(null)
    } finally {
      setBusy(false)
    }
  }

  const showTotal = !!matrix && matrix.cols.length > 1
  const view = (() => {
    if (!matrix) return null
    if (!transpose) {
      return {
        head: [rowDim ?? '', ...matrix.cols, ...(showTotal ? ['Total'] : [])],
        body: matrix.rows.map((r) => [r.label, ...r.cells.map((c) => formatValue(c, matrix.unit)), ...(showTotal ? [formatValue(r.total, matrix.unit)] : [])]),
        raw: matrix.rows.map((r) => [r.label, ...r.cells, ...(showTotal ? [r.total] : [])]),
      }
    }
    const heads = matrix.rows.map((r) => r.label)
    const raw = matrix.cols.map((c, ci) => [c, ...matrix.rows.map((r) => r.cells[ci])])
    return { head: ['', ...heads], body: raw.map((r) => [String(r[0]), ...r.slice(1).map((v) => formatValue(Number(v), matrix.unit))]), raw }
  })()

  return (
    <div style={{ marginTop: 8 }}>
      <Space wrap>
        <Select<RowDim> placeholder="Rows" value={rowDim} onChange={setRowDim} options={ROW_DIMS} style={{ width: 150 }} aria-label="Row dimension" size="small" />
        <Select<ColDim>
          value={colDim}
          onChange={setColDim}
          size="small"
          style={{ width: 150 }}
          aria-label="Column split"
          options={[{ value: 'none', label: 'No column split' }, { value: 'month', label: 'Columns by month' }, { value: 'week', label: 'Columns by week' }]}
        />
        <Space size={4}>
          <Switch size="small" checked={transpose} onChange={setTranspose} aria-label="Swap rows and columns" />
          <Text style={{ fontSize: 12 }}>Swap</Text>
        </Space>
        <Button size="small" type="primary" loading={busy} disabled={!rowDim} onClick={apply}>
          Pivot
        </Button>
        {view && (
          <Button size="small" onClick={() => downloadCsv('pivot.csv', [view.head, ...view.raw])}>
            Export CSV
          </Button>
        )}
      </Space>
      {error && <Alert style={{ marginTop: 6 }} type="warning" showIcon message={error} />}
      {view && (
        <Table
          style={{ marginTop: 6 }}
          size="small"
          pagination={view.body.length > 12 ? { pageSize: 12 } : false}
          scroll={{ x: 'max-content' }}
          dataSource={view.body.map((r, i) => ({ key: i, r }))}
          columns={view.head.map((h, i) => ({ title: h, align: i ? ('right' as const) : undefined, render: (_: unknown, row: { r: string[] }) => row.r[i] }))}
        />
      )}
    </div>
  )
}
