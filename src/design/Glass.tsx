import { createElement, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import './glass.css'

// A glass surface. Variants (DESIGN.md §4.1):
//  small  - top bar, sidebar, toolbars, toasts
//  large  - panels, popovers, sheets (use sparingly; Ant Design overlays are themed by CSS)
//  tinted - the single primary action of a surface
// Reduce Transparency / Increase Contrast / no-backdrop-filter paths live in glass.css.
export type GlassVariant = 'small' | 'large' | 'tinted'

export interface GlassProps extends HTMLAttributes<HTMLElement> {
  variant?: GlassVariant
  as?: keyof React.JSX.IntrinsicElements
  radius?: number | string
  children?: ReactNode
}

export function Glass({ variant = 'small', as = 'div', radius, className = '', style, children, ...rest }: GlassProps) {
  const cls = ['glass', variant === 'large' && 'glass--large', variant === 'tinted' && 'glass--tinted', className]
    .filter(Boolean)
    .join(' ')
  const s: CSSProperties = radius === undefined ? { ...style } : { borderRadius: radius, ...style }
  return createElement(as, { className: cls, style: s, ...rest }, children)
}

// Capsule group (6.1): height 44, padding 4, children 36. Never nest a group in a group.
export function CapsuleGroup({
  children,
  className = '',
  label,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { label?: string }) {
  return (
    <Glass
      className={`capsule-group ${className}`}
      role="group"
      aria-label={label}
      radius="var(--r-capsule)"
      {...rest}
    >
      {children}
    </Glass>
  )
}
