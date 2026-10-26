import { useEffect, useRef, useState } from 'react'

// Scroll edge effect (DESIGN.md §5.3 H). One per pane, only where something
// floats over scrolling content.
//  soft: 24px gradient from the pane colour to transparent, fades in once
//        content is under it.
//  hard: opaque band + 1px outlineVariant hairline once content scrolls under.
// An IntersectionObserver watches a sentinel at the start of the scrolling
// content; render <ScrollEdge/> as the first child of the scroller (or with
// `fixed` for window scrolling, positioned by CSS vars --edge-top).
export function ScrollEdge({
  variant = 'soft',
  position = 'top',
  fixed = false,
  height = 24,
  offset = 0,
  root,
}: {
  variant?: 'soft' | 'hard'
  position?: 'top' | 'bottom'
  fixed?: boolean
  height?: number
  offset?: number // distance from the pane edge to the end of the floating glass
  root?: Element | null
}) {
  const sentinel = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)

  useEffect(() => {
    const el = sentinel.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setActive(!e.isIntersecting), { root: root ?? null, threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  return (
    <>
      <div
        ref={sentinel}
        aria-hidden="true"
        style={{ position: 'absolute', top: position === 'top' ? 0 : undefined, bottom: position === 'bottom' ? 0 : undefined, height: 1, width: 1, pointerEvents: 'none' }}
      />
      <div
        aria-hidden="true"
        className={`scroll-edge scroll-edge--${variant} scroll-edge--${position} ${fixed ? 'scroll-edge--fixed' : ''}`}
        data-active={active}
        style={{ height: height + offset, ['--edge-h' as string]: `${height + offset}px` }}
      />
    </>
  )
}
