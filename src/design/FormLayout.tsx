import type { CSSProperties, ReactNode } from 'react'

// Shared form layout (DESIGN.md §6): forms are grouped into titled sections; each setting is one row with the
// label + plain-language help on the left and the control on the right (stacks on narrow screens); groups of
// plain inputs use a responsive grid. Use these instead of stacking bare labels and controls.

export function FormSection({
  title,
  description,
  extra,
  children,
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`fsec ${className}`}>
      <header className="fsec__head">
        <div className="fsec__titles">
          <h3 className="fsec__title">{title}</h3>
          {description && <p className="fsec__desc">{description}</p>}
        </div>
        {extra && <div className="fsec__extra">{extra}</div>}
      </header>
      <div className="fsec__body">{children}</div>
    </section>
  )
}

export function SettingRow({
  label,
  help,
  htmlFor,
  children,
  align = 'center',
}: {
  label: ReactNode
  help?: ReactNode
  htmlFor?: string
  children: ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <div className={`srow srow--${align}`}>
      <div className="srow__text">
        {htmlFor ? <label className="srow__label" htmlFor={htmlFor}>{label}</label> : <div className="srow__label">{label}</div>}
        {help && <div className="srow__help">{help}</div>}
      </div>
      <div className="srow__control">{children}</div>
    </div>
  )
}

// Responsive grid for related fields (e.g. a form's inputs): as many columns of `min` px as fit.
export function FieldGrid({ min = 220, children, style }: { min?: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="fgrid" style={{ ...style, ['--fgrid-min' as string]: `${min}px` }}>
      {children}
    </div>
  )
}
