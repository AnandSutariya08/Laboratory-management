// Motion helpers (DESIGN.md §5). CSS owns the curves (motion.css); this module
// owns durations for script-driven (Web Animations API) motion and reads the
// reduce-motion state from <html data-motion> (set by DisplaySettings, which
// merges prefers-reduced-motion with Settings > Display).

export const DUR = { micro: 100, short: 160, medium: 240, long: 300 } as const
export const STAGGER_MS = 18
export const STAGGER_CAP = 8

export function isMotionReduced(): boolean {
  if (typeof document === 'undefined') return false
  const m = document.documentElement.dataset.motion
  if (m) return m === 'reduce'
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

// Duration honouring reduce motion: 100 ms fade at most.
export const dur = (ms: number) => (isMotionReduced() ? Math.min(ms, 100) : ms)

export const staggerDelay = (index: number) =>
  isMotionReduced() ? 0 : Math.min(index, STAGGER_CAP) * STAGGER_MS

const EASE = 'cubic-bezier(0.2, 0, 0, 1)'

// Press: scale to 0.97 (130 ms) and release. Pure-CSS `.press` does this for
// pointer use; call these for keyboard activation.
export function press(el: HTMLElement) {
  if (isMotionReduced()) return
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.97)', offset: 0.35 }, { transform: 'scale(1)' }], {
    duration: 250,
    easing: EASE,
  })
}

// Materialize: glass appears by ramping opacity and a small scale.
export function materialize(el: HTMLElement) {
  if (isMotionReduced()) return fadeIn(el)
  return el.animate(
    [
      { opacity: 0, transform: 'scale(0.92)' },
      { opacity: 1, transform: 'scale(1)' },
    ],
    { duration: 300, easing: EASE, fill: 'both' },
  )
}

// Morph: grow a surface from the control that opened it (pivot = source centre).
export function morphFrom(el: HTMLElement, source: Element | DOMRect | null) {
  if (!source || isMotionReduced()) return fadeIn(el)
  const s = source instanceof Element ? source.getBoundingClientRect() : source
  const t = el.getBoundingClientRect()
  const dx = s.left + s.width / 2 - (t.left + t.width / 2)
  const dy = s.top + s.height / 2 - (t.top + t.height / 2)
  return el.animate(
    [
      { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.6)`, transformOrigin: 'center' },
      { opacity: 1, transform: 'translate(0,0) scale(1)', transformOrigin: 'center' },
    ],
    { duration: 300, easing: EASE, fill: 'both' },
  )
}

export function fadeIn(el: HTMLElement, ms = DUR.short) {
  return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur(ms), easing: 'linear', fill: 'both' })
}

// Fade-through between content states: short fade with a 4 px settle. Reduce
// motion: plain fade.
export function fadeThrough(el: HTMLElement) {
  const keyframes: Keyframe[] = isMotionReduced()
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'none' },
      ]
  return el.animate(keyframes, { duration: dur(DUR.short), easing: 'cubic-bezier(0, 0, 0, 1)', fill: 'both' })
}

// Decaying shake for errors; reduce motion: nothing (show error text instead).
export function shake(el: HTMLElement) {
  if (isMotionReduced()) return
  el.animate(
    [0, -8, 6, -4, 3, -1, 0].map((x) => ({ transform: `translateX(${x}px)` })),
    { duration: 360, easing: EASE },
  )
}
