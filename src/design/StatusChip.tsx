import type { ReactNode } from 'react'

export type StatusVariant = 'neutral' | 'info' | 'success' | 'caution' | 'urgent'

// Content-layer status: tonal wash + dot (or icon) + text. Never glass, never
// pressable, never colour alone (the label is always rendered).
export function StatusChip({
  variant = 'neutral',
  children,
  icon,
  className = '',
}: {
  variant?: StatusVariant
  children: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <span className={`chip chip--${variant} ${className}`}>
      {icon ?? <span className="chip__dot" aria-hidden="true" />}
      <span>{children}</span>
    </span>
  )
}
