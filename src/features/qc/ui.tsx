import type { ReactNode } from 'react'
import { Card } from '../../design/Card'
import { StatusChip, type StatusVariant } from '../../design/StatusChip'
import './qc.css'

// Summary tile: label, value, optional tone (text label always present, never colour alone).
export function StatTile({
  label,
  value,
  tone,
  onClick,
  selected,
  hint,
}: {
  label: string
  value: ReactNode
  tone?: 'success' | 'urgent' | 'caution' | 'info'
  onClick?: () => void
  selected?: boolean
  hint?: string
}) {
  const body = (
    <>
      <span className="stat-tile__label">{label}</span>
      <span className={`stat-tile__value tabular ${tone ? `stat-tile__value--${tone}` : ''}`}>{value}</span>
      {hint && <span className="stat-tile__hint">{hint}</span>}
    </>
  )
  return onClick ? (
    <Card as="div" interactive selected={selected} className="stat-tile">
      <button type="button" className="stat-tile__btn press" onClick={onClick} aria-pressed={!!selected}>
        {body}
      </button>
    </Card>
  ) : (
    <Card className="stat-tile">{body}</Card>
  )
}

export const TileGrid = ({ children }: { children: ReactNode }) => <div className="tile-grid">{children}</div>

export const Toolbar = ({ children }: { children: ReactNode }) => <div className="qc-toolbar">{children}</div>

const VARIANT: Record<string, StatusVariant> = {
  pass: 'success',
  acceptable: 'success',
  verified: 'success',
  completed: 'success',
  closed: 'success',
  active: 'success',
  warning: 'caution',
  pending: 'caution',
  open: 'caution',
  scheduled: 'info',
  inconclusive: 'neutral',
  notEvaluated: 'neutral',
  inactive: 'neutral',
  notPerformed: 'neutral',
  deleted: 'neutral',
  fail: 'urgent',
  unacceptable: 'urgent',
  missed: 'urgent',
}
const LABEL: Record<string, string> = { notEvaluated: 'Not evaluated', notPerformed: 'Not performed', pass: 'Pass', fail: 'Fail', warning: 'Warning' }

/** Status chip from a status/outcome word. */
export function Chip({ status, children }: { status: string; children?: ReactNode }) {
  const text = children ?? LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1)
  return <StatusChip variant={VARIANT[status] ?? 'neutral'}>{text}</StatusChip>
}

// Design-system content card with an optional title row; replaces Ant Design's Card in QC and inventory.
export function Panel({
  title,
  extra,
  style,
  children,
  className = '',
}: {
  title?: ReactNode
  extra?: ReactNode
  style?: React.CSSProperties
  children?: ReactNode
  size?: string
  className?: string
}) {
  return (
    <Card padding="var(--s-4)" style={style} className={className}>
      {(title || extra) && (
        <div className="panel-head">
          <h2 className="qc-card-title">{title}</h2>
          {extra && <div>{extra}</div>}
        </div>
      )}
      {children}
    </Card>
  )
}
