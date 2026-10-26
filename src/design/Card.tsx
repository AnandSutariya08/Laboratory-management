import { createElement, type HTMLAttributes, type ReactNode } from 'react'

// Content card (DESIGN.md §6.3): solid surfaceContainerHigh, 24 radius, 1px
// outlineVariant, no elevation. Selected = 2px primary ring. Never glass.
export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'li'
  selected?: boolean
  interactive?: boolean // pressed overlay only (content does not bounce)
  padding?: number | string
  children?: ReactNode
}

export function Card({ as = 'div', selected, interactive, padding, className = '', style, children, ...rest }: CardProps) {
  const cls = ['card', selected && 'card--selected', interactive && 'card--interactive', className]
    .filter(Boolean)
    .join(' ')
  return createElement(
    as,
    { className: cls, style: padding === undefined ? style : { padding, ...style }, ...rest },
    children,
  )
}

// Inner tonal section of a card/panel; radius is concentric with the card.
export function CardSection({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card-section ${className}`} {...rest}>
      {children}
    </div>
  )
}
