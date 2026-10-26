import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

// Display settings (DESIGN.md §8). User choices layer over the system
// preferences: a setting turned on forces the mode, otherwise the OS decides.
// The resolved values are written to <html> as data-* attributes that
// tokens.css / glass.css / motion.css key off.

export type ThemeChoice = 'light' | 'dark' | 'system'

export interface DisplayPrefs {
  theme: ThemeChoice
  reduceMotion: boolean
  reduceTransparency: boolean
  increaseContrast: boolean
}

export interface DisplayResolved {
  scheme: 'light' | 'dark'
  motion: 'full' | 'reduce'
  transparency: 'full' | 'reduce'
  contrast: 'normal' | 'more'
}

const KEY = 'hcl.display'
const DEFAULTS: DisplayPrefs = { theme: 'system', reduceMotion: false, reduceTransparency: false, increaseContrast: false }

const mq = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null)

function load(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    /* storage unavailable */
  }
  return DEFAULTS
}

export function resolve(p: DisplayPrefs): DisplayResolved {
  const sysDark = !!mq('(prefers-color-scheme: dark)')?.matches
  return {
    scheme: p.theme === 'system' ? (sysDark ? 'dark' : 'light') : p.theme,
    motion: p.reduceMotion || mq('(prefers-reduced-motion: reduce)')?.matches ? 'reduce' : 'full',
    transparency: p.reduceTransparency || mq('(prefers-reduced-transparency: reduce)')?.matches ? 'reduce' : 'full',
    contrast: p.increaseContrast || mq('(prefers-contrast: more)')?.matches ? 'more' : 'normal',
  }
}

export function applyToDocument(p: DisplayPrefs, r: DisplayResolved) {
  const el = document.documentElement
  el.dataset.theme = p.theme === 'system' ? 'system' : p.theme
  el.dataset.scheme = r.scheme
  el.dataset.motion = r.motion
  el.dataset.transparency = r.transparency
  el.dataset.contrast = r.contrast
}

// Apply before React renders to avoid a flash of the wrong theme.
if (typeof document !== 'undefined') {
  const p = load()
  applyToDocument(p, resolve(p))
}

interface DisplayState {
  prefs: DisplayPrefs
  resolved: DisplayResolved
  set: (patch: Partial<DisplayPrefs>) => void
  reset: () => void
}

const DisplayContext = createContext<DisplayState>({
  prefs: DEFAULTS,
  resolved: { scheme: 'light', motion: 'full', transparency: 'full', contrast: 'normal' },
  set: () => {},
  reset: () => {},
})

export function DisplaySettingsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<DisplayPrefs>(load)
  const [resolved, setResolved] = useState<DisplayResolved>(() => resolve(prefs))

  useEffect(() => {
    const update = () => {
      const r = resolve(prefs)
      setResolved(r)
      applyToDocument(prefs, r)
    }
    update()
    const queries = [
      '(prefers-color-scheme: dark)',
      '(prefers-reduced-motion: reduce)',
      '(prefers-reduced-transparency: reduce)',
      '(prefers-contrast: more)',
    ].map(mq)
    queries.forEach((q) => q?.addEventListener('change', update))
    return () => queries.forEach((q) => q?.removeEventListener('change', update))
  }, [prefs])

  const set = useCallback((patch: Partial<DisplayPrefs>) => {
    setPrefs((cur) => {
      const next = { ...cur, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])
  const reset = useCallback(() => set(DEFAULTS), [set])

  const value = useMemo(() => ({ prefs, resolved, set, reset }), [prefs, resolved, set, reset])
  return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useDisplay = () => useContext(DisplayContext)
