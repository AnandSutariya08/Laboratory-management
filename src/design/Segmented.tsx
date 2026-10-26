import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Glass } from './Glass'
import { SelectionPill, usePillBox } from './SelectionPill'

export interface SegmentedOption<V extends string | number = string> {
  value: V
  label: ReactNode
  icon?: ReactNode
  count?: number // rendered as text inside the segment, not a separate button
  disabled?: boolean
}

export interface SegmentedProps<V extends string | number = string> {
  options: SegmentedOption<V>[]
  value: V
  onChange: (value: V) => void
  'aria-label': string
  size?: 'default' | 'small'
  block?: boolean
  className?: string
}

// Glass capsule with ONE sliding selection pill. Tabs, status tabs, filter
// chips and view switchers all use it. Arrow keys / Home / End move selection;
// the selected tab is the only tab stop (roving tabindex).
export function Segmented<V extends string | number = string>({
  options,
  value,
  onChange,
  size = 'default',
  block,
  className = '',
  ...aria
}: SegmentedProps<V>) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const box = usePillBox(ref, [value, options.length, options.map((o) => o.count).join(',')])

  const move = (from: number, dir: 1 | -1 | 'first' | 'last') => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0)
    if (!enabled.length) return
    let target: number
    if (dir === 'first') target = enabled[0]
    else if (dir === 'last') target = enabled[enabled.length - 1]
    else {
      const pos = enabled.indexOf(from)
      target = enabled[(pos + dir + enabled.length) % enabled.length]
    }
    onChange(options[target].value)
    ref.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus()
  }

  const onKey = (e: KeyboardEvent, i: number) => {
    const keys: Record<string, 1 | -1 | 'first' | 'last'> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      Home: 'first',
      End: 'last',
    }
    const d = keys[e.key]
    if (d !== undefined) {
      e.preventDefault()
      move(i, d)
    }
  }

  return (
    <Glass
      className={`seg seg--${size} ${block ? 'seg--block' : ''} ${className}`}
      radius="var(--r-capsule)"
    >
      <div ref={ref} className="seg__track" role="tablist" aria-label={aria['aria-label']}>
        <SelectionPill box={box} />
        {options.map((o, i) => {
          const selected = o.value === value
          return (
            <button
              key={String(o.value)}
              id={`${id}-${i}`}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              disabled={o.disabled}
              data-pill-item
              data-pill-active={selected}
              className="seg__item press"
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {o.icon}
              <span>{o.label}</span>
              {o.count !== undefined && <span className="seg__count">{o.count}</span>}
            </button>
          )
        })}
      </div>
    </Glass>
  )
}
