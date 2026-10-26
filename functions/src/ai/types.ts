// Server-side mirror of the AI types in src/types.ts (functions/ cannot import from src/).

export const METRICS = ['revenue', 'collections', 'dues', 'refunds', 'discounts', 'bills', 'patients', 'tests', 'tat', 'bookings'] as const
export const GROUP_BYS = ['none', 'day', 'week', 'month', 'referrer', 'department', 'test', 'paymentMode', 'status', 'user'] as const
export const PRESETS = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'last90', 'thisYear'] as const
export const WIDGET_KINDS = ['kpi', 'bar', 'line', 'pie', 'table'] as const

export type Metric = (typeof METRICS)[number]
export type GroupBy = (typeof GROUP_BYS)[number]
export type Preset = (typeof PRESETS)[number]
export type WidgetKind = (typeof WIDGET_KINDS)[number]

export interface AnalyticsQuery {
  metric: Metric
  groupBy: GroupBy
  range: { preset: Preset } | { from: string; to: string }
  limit?: number
}

export interface AnalyticsResult {
  query: AnalyticsQuery
  rows: { label: string; value: number; extra?: Record<string, number | string> }[]
  total: number
  unit: 'INR' | 'count' | 'minutes' | 'percent'
  from: string
  to: string
}

export interface DashboardWidget {
  id: string
  title: string
  kind: WidgetKind
  query: AnalyticsQuery
}
