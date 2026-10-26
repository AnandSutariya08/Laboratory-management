import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

// One sliding selection pill per control (DESIGN.md §2.9): a tonal primary
// capsule behind the active item. The active element is marked with
// data-pill-active="true"; the pill is positioned from its measured box and
// moves with the --spring-select curve (CSS transition on transform/size).

export interface PillBox {
  x: number
  y: number
  w: number
  h: number
}

export function usePillBox(container: RefObject<HTMLElement | null>, deps: unknown[]): PillBox | null {
  const [box, setBox] = useState<PillBox | null>(null)
  const measure = useCallback(() => {
    const root = container.current
    if (!root) return
    const active = root.querySelector<HTMLElement>('[data-pill-active="true"]')
    if (!active) {
      setBox(null)
      return
    }
    const r = root.getBoundingClientRect()
    const a = active.getBoundingClientRect()
    setBox((prev) => {
      const next = { x: a.left - r.left + root.scrollLeft, y: a.top - r.top + root.scrollTop, w: a.width, h: a.height }
      return prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next
    })
  }, [container])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [measure, ...deps])

  useEffect(() => {
    const root = container.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    root.querySelectorAll('[data-pill-item]').forEach((n) => ro.observe(n))
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps])

  return box
}

export function SelectionPill({ box }: { box: PillBox | null }) {
  const first = useRef(true)
  const [animate, setAnimate] = useState(false)
  useEffect(() => {
    if (box && first.current) {
      first.current = false
      // Place without animating the very first time.
      const id = requestAnimationFrame(() => setAnimate(true))
      return () => cancelAnimationFrame(id)
    }
  }, [box])
  const style: CSSProperties = box
    ? { width: box.w, height: box.h, transform: `translate(${box.x}px, ${box.y}px)`, opacity: 1 }
    : { opacity: 0 }
  return <span className={`pill ${animate ? 'pill--animate' : ''}`} style={style} aria-hidden="true" />
}
