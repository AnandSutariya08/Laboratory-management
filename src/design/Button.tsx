import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

// Design-system button. Primary = tinted glass (one per surface); default =
// tonal pill used inside glass groups; text = bare. Icon-only buttons must
// pass aria-label.
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'default' | 'text'
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', icon, className = '', type = 'button', children, ...rest },
  ref,
) {
  const cls = [
    'dbtn',
    'press',
    `dbtn--${variant}`,
    variant === 'primary' && 'glass glass--tinted',
    !children && 'dbtn--icon',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  )
})
