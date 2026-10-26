import { useRef, type ReactNode } from 'react'
import { DatePicker, Table, type TableProps } from 'antd'
import dayjs from 'dayjs'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonRows } from '../../design/Skeletons'
import { StatusChip } from '../../design/StatusChip'
import { Button } from '../../design/Button'
import type { Range } from './lib/orders'
import './partners.css'

export const Toolbar = ({ children }: { children: ReactNode }) => <div className="pt-toolbar">{children}</div>
export const Spacer = () => <span className="pt-toolbar__spacer" />

export const ActiveChip = ({ active }: { active: boolean }) => (
  <StatusChip variant={active ? 'success' : 'neutral'}>{active ? 'Active' : 'Inactive'}</StatusChip>
)

export const Kpis = ({ items }: { items: { label: string; value: ReactNode }[] }) => (
  <div className="pt-kpis">
    {items.map((k) => (
      <div className="pt-kpi" key={k.label}>
        <div className="pt-kpi__label">{k.label}</div>
        <div className="pt-kpi__value">{k.value}</div>
      </div>
    ))}
  </div>
)

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="pt-section">
    <h3 className="pt-section__title">{title}</h3>
    {children}
  </section>
)

export const thisMonth = (): Range => [dayjs().startOf('month'), dayjs().endOf('month')]

export function RangeField({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <DatePicker.RangePicker
      aria-label="Date range"
      value={value}
      allowClear={false}
      onChange={(v) => v && v[0] && v[1] && onChange([v[0], v[1]])}
    />
  )
}

// Table inside a content card with first-load skeleton and empty state.
export function DataTable<T extends { id: string }>({
  loading,
  emptyTitle,
  emptyHint,
  toolbar,
  ...rest
}: TableProps<T> & { emptyTitle: string; emptyHint?: string; toolbar?: ReactNode }) {
  const empty = !loading && (rest.dataSource?.length ?? 0) === 0
  return (
    <Card className="pt-card">
      {toolbar}
      {loading && !rest.dataSource?.length ? (
        <SkeletonRows rows={6} columns={Math.min(rest.columns?.length ?? 4, 6)} />
      ) : empty ? (
        <EmptyState title={emptyTitle} description={emptyHint} />
      ) : (
        <Table<T>
          size="small"
          rowKey="id"
          pagination={{ pageSize: 25, showSizeChanger: false, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          {...rest}
        />
      )}
    </Card>
  )
}

// A button that opens a file chooser and hands the file text to `onText`.
export function FileButton({
  label,
  accept = '.csv,text/csv',
  onText,
  icon,
}: {
  label: string
  accept?: string
  icon?: ReactNode
  onText: (text: string, file: File) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        aria-label={label}
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (f) onText(await f.text(), f)
          e.target.value = ''
        }}
      />
      <Button icon={icon} onClick={() => ref.current?.click()}>
        {label}
      </Button>
    </>
  )
}

export const rupeesStr = (paise: number) => (paise / 100).toFixed(2)
export const fmtDate = (d: Date | null | undefined) => (d ? dayjs(d).format('DD MMM YYYY') : '')
export const fmtDateTime = (d: Date | null | undefined) => (d ? dayjs(d).format('DD MMM YYYY HH:mm') : '')
