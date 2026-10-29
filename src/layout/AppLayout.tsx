import { PageErrorBoundary } from './PageErrorBoundary'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Drawer } from 'antd'
import { updateDoc, serverTimestamp } from 'firebase/firestore'
import { useAuth } from '../auth/AuthProvider'
import { docRef, paths } from '../lib/db'
import { setActivityActor } from './activity'
import { useUsageTracking } from './usage'
import { ScrollEdge } from '../design/ScrollEdge'
import { fadeThrough } from '../design/motion'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import { ViewAsBanner } from '../features/settings/ViewAs'
import { LabSettingsHost } from '../features/settings/LabSettingsModal'
import { useNavFlags } from './useNavFlags'
import { titleFor, visibleNav } from './nav'
import './shell.css'

const COLLAPSE_KEY = 'hcl.sidebar.collapsed'

function useMediaQuery(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mql = window.matchMedia(q)
    const on = () => setM(mql.matches)
    on()
    mql.addEventListener('change', on)
    return () => mql.removeEventListener('change', on)
  }, [q])
  return m
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

// App shell (DESIGN.md §7): ambient sky wash, floating glass sidebar and top
// bar (inset 12), content padded so nothing rests under glass. Compact (< 768)
// turns the sidebar into a drawer opened from the top bar.
export default function AppLayout() {
  const { profile, user, logout } = useAuth()
  const location = useLocation()
  const compact = useMediaQuery('(max-width: 767px)')

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !c
    })
  }, [])

  const [menuOpen, setMenuOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const sidebarSearchRef = useRef<HTMLInputElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [announce, setAnnounce] = useState('')

  // Activity events carry the user's name; record the last sign-in once per browser session.
  useEffect(() => {
    if (profile?.name) setActivityActor(profile.name)
  }, [profile?.name])
  useEffect(() => {
    if (!user) return
    try {
      if (sessionStorage.getItem('hcl.login.logged') === user.uid) return
      sessionStorage.setItem('hcl.login.logged', user.uid)
    } catch {
      /* ignore */
    }
    // Needs the users rule that lets a user stamp their own lastLoginAt; failures are harmless.
    updateDoc(docRef(paths.users, user.uid), { lastLoginAt: serverTimestamp() }).catch(() => {})
  }, [user])

  // Auto sign-out after the user's idle timeout (profile.sessionTimeoutMin; 0 = never).
  const timeoutMin = profile?.sessionTimeoutMin ?? 0
  useEffect(() => {
    if (!timeoutMin) return
    let t = window.setTimeout(() => void logout(), timeoutMin * 60000)
    const reset = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => void logout(), timeoutMin * 60000)
    }
    const evs = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    return () => {
      window.clearTimeout(t)
      evs.forEach((e) => window.removeEventListener(e, reset))
    }
  }, [timeoutMin, logout])

  useUsageTracking(user?.uid, location.pathname)
  const navFlags = useNavFlags()
  const nodes = useMemo(() => visibleNav(profile, navFlags), [profile, navFlags])
  const title = titleFor(location.pathname, location.search, nodes)

  // Page change: fade-through, reset scroll, announce, move focus to the content.
  const first = useRef(true)
  useEffect(() => {
    document.title = `${title} · Healthcare Labs`
    if (first.current) {
      first.current = false
      return
    }
    window.scrollTo(0, 0)
    if (bodyRef.current) fadeThrough(bodyRef.current)
    setAnnounce(`${title} page`)
    mainRef.current?.focus({ preventScroll: true })
    setMenuOpen(false)
    // Only a path change counts as a page change (query updates stay put).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, title])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (compact) setMenuOpen(true)
        else if (collapsed) toggleCollapsed()
        setTimeout(() => sidebarSearchRef.current?.focus(), 80)
      } else if (e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setScanOpen(true)
      } else if (!isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '/') {
          e.preventDefault()
          searchRef.current?.focus()
        } else if (e.key === '?') {
          e.preventDefault()
          setHelpOpen(true)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compact, collapsed, toggleCollapsed])

  return (
    <div className="app-shell" data-compact={compact} data-collapsed={collapsed && !compact}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="ambient" aria-hidden="true" />

      {!compact && (
        <aside className="app-shell__sidebar">
          <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} searchRef={sidebarSearchRef} />
        </aside>
      )}

      <ScrollEdge fixed height={24} offset={84} />
      <TopBar
        title={title}
        compact={compact}
        onOpenMenu={() => setMenuOpen(true)}
        searchRef={searchRef}
        scanOpen={scanOpen}
        setScanOpen={setScanOpen}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
      />

      {compact && (
        <Drawer
          placement="left"
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          size={300}
          closable={false}
          styles={{ body: { padding: 0 }, header: { display: 'none' } }}
          aria-label="Navigation"
        >
          <Sidebar collapsed={false} variant="drawer" onNavigate={() => setMenuOpen(false)} searchRef={sidebarSearchRef} />
        </Drawer>
      )}

      <ViewAsBanner />
      <LabSettingsHost />
      <main id="main" ref={mainRef} tabIndex={-1} className="app-shell__main">
        <div ref={bodyRef} className="app-shell__body">
          <PageErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </PageErrorBoundary>
        </div>
      </main>

      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>
  )
}
