import type { ReactNode } from 'react'

// Page header: title as plain text (never a glass button), subtitle, and a
// trailing actions group. Put at most ONE primary action in `actions`
// (<Button variant="primary">).
export function PageHeader({
  title,
  subtitle,
  actions,
  className = '',
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={`page-header ${className}`}>
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}
