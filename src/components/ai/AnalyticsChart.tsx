import { useMemo } from 'react'
import { Empty, Table, Typography } from 'antd'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts'
import type { AnalyticsResult, WidgetKind } from '../../types'

const { Text } = Typography

export const PALETTE = ['var(--c-primary)', 'var(--c-accent)', 'var(--c-info)', 'var(--c-success)', 'var(--c-caution)', 'var(--c-urgent)', 'var(--c-on-surface-variant)', 'var(--c-outline)']

const inrFull = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

// The server returns rupees (not paise) for unit INR.
export function formatValue(v: number, unit: AnalyticsResult['unit'], compact = false): string {
  switch (unit) {
    case 'INR':
      return compact ? inrWhole.format(v) : inrFull.format(v)
    case 'minutes':
      return v >= 120 ? `${num.format(Math.round(v / 6) / 10)} h` : `${num.format(Math.round(v))} min`
    case 'percent':
      return `${num.format(v)}%`
    default:
      return num.format(v)
  }
}

export const chartKindFor = (r: AnalyticsResult): WidgetKind => {
  const g = r.query.groupBy
  if (g === 'none') return 'kpi'
  return g === 'day' || g === 'week' || g === 'month' ? 'line' : 'bar'
}

const METRIC_LABEL: Record<string, string> = {
  revenue: 'Revenue',
  collections: 'Collections',
  dues: 'Dues',
  refunds: 'Refunds',
  discounts: 'Discounts',
  bills: 'Bills',
  patients: 'Patients',
  tests: 'Tests',
  tat: 'Turnaround',
  bookings: 'Bookings',
}
export const metricLabel = (r: AnalyticsResult) => METRIC_LABEL[r.query.metric] ?? r.query.metric

interface Props {
  result: AnalyticsResult
  kind: WidgetKind
  height?: number
}

export default function AnalyticsChart({ result, kind, height = 260 }: Props) {
  const { rows, unit } = result
  const data = useMemo(() => rows.map((r) => ({ label: r.label, value: r.value })), [rows])
  const fmt = (v: number) => formatValue(v, unit)
  const fmtC = (v: number) => formatValue(v, unit, true)

  if (kind === 'kpi') {
    const big = result.query.groupBy === 'none' && rows.length === 1 ? rows[0].value : result.total
    return (
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--c-primary)', lineHeight: 1.2 }}>{fmt(big)}</div>
        <Text type="secondary">
          {metricLabel(result)} · {result.from} to {result.to}
        </Text>
      </div>
    )
  }

  if (kind === 'table' || rows.length === 0) {
    if (rows.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data for this period" />
    const extraKeys = Array.from(new Set(rows.flatMap((r) => Object.keys(r.extra ?? {}))))
    return (
      <Table
        size="small"
        pagination={rows.length > 10 ? { pageSize: 10, size: 'small' } : false}
        rowKey="label"
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: result.query.groupBy === 'none' ? 'Metric' : result.query.groupBy, dataIndex: 'label' },
          { title: metricLabel(result), dataIndex: 'value', align: 'right', render: (v: number) => fmt(v) },
          ...extraKeys.map((k) => ({
            title: k,
            align: 'right' as const,
            render: (_: unknown, r: AnalyticsResult['rows'][number]) => String(r.extra?.[k] ?? ''),
          })),
        ]}
      />
    )
  }

  const tip = (v: unknown) => fmt(Number(v))

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        {kind === 'line' ? (
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--c-outline-variant)" />
            <XAxis dataKey="label" fontSize={11} tickMargin={6} />
            <YAxis fontSize={11} width={64} tickFormatter={fmtC} />
            <Tooltip formatter={(v) => tip(v)} />
            <Line type="monotone" dataKey="value" name={metricLabel(result)} stroke={PALETTE[0]} strokeWidth={2} dot={data.length < 40} />
          </LineChart>
        ) : kind === 'pie' ? (
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius="45%" outerRadius="80%" paddingAngle={1}>
              {data.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => tip(v)} />
            <Legend />
          </PieChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--c-outline-variant)" vertical={false} />
            <XAxis dataKey="label" fontSize={11} tickMargin={6} interval={0} angle={data.length > 6 ? -25 : 0} textAnchor={data.length > 6 ? 'end' : 'middle'} height={data.length > 6 ? 60 : 30} />
            <YAxis fontSize={11} width={64} tickFormatter={fmtC} />
            <Tooltip formatter={(v) => tip(v)} />
            <Bar dataKey="value" name={metricLabel(result)} fill={PALETTE[0]} radius={[4, 4, 0, 0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
