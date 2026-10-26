import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Dropdown, Tooltip } from 'antd'
import {
  DownOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SearchOutlined,
  CustomerServiceOutlined,
} from '@ant-design/icons'
import { useAuth } from '../auth/AuthProvider'
import { Glass } from '../design/Glass'
import { SelectionPill, usePillBox } from '../design/SelectionPill'
import { BRAND } from '../theme'
import SupportTicketModal from './SupportTicketModal'
import { PlanBadge } from '../features/settings/PlanBadge'
import { InstallButton, useInstallPrompt } from './InstallApp'
import { useNavFlags } from './useNavFlags'
import { activeKey, flatten, groupOf, visibleNav, type FlatEntry, type IconType } from './nav'

interface SidebarProps {
  collapsed: boolean
  onToggleCollapsed?: () => void
  variant?: 'rail' | 'drawer' // drawer: compact screens, always expanded, no collapse button
  onNavigate?: () => void
  searchRef?: RefObject<HTMLInputElement | null>
}

function matches(e: FlatEntry, q: string) {
  const hay = `${e.label} ${e.group ?? ''} ${e.keywords}`.toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t))
}

export default function Sidebar({ collapsed, onToggleCollapsed, variant = 'rail', onNavigate, searchRef }: SidebarProps) {
  const { profile } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const navFlags = useNavFlags()
  const nodes = useMemo(() => visibleNav(profile, navFlags), [profile, navFlags])
  const entries = useMemo(() => flatten(nodes), [nodes])
  const active = activeKey(nodes, location.pathname, location.search)
  const activeGroup = groupOf(nodes, active)

  const [open, setOpen] = useState<Set<string>>(() => new Set(activeGroup ? [activeGroup] : []))
  useEffect(() => {
    if (activeGroup) setOpen((cur) => (cur.has(activeGroup) ? cur : new Set(cur).add(activeGroup)))
  }, [activeGroup])

  // ---- search ---------------------------------------------------------------
  const localSearch = useRef<HTMLInputElement>(null)
  const inputRef = searchRef ?? localSearch
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const listId = useId()
  const results = useMemo(() => {
    if (!q.trim()) return []
    const hits = entries.filter((e) => matches(e, q))
    const t = q.trim().toLowerCase()
    // Entries whose own label matches come first.
    return [...hits].sort((a, b) => Number(b.label.toLowerCase().includes(t)) - Number(a.label.toLowerCase().includes(t)))
  }, [q, entries])
  useEffect(() => setHi(0), [q])
  const go = useCallback(
    (path: string) => {
      setQ('')
      navigate(path)
      onNavigate?.()
    },
    [navigate, onNavigate],
  )
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((h) => Math.min(h + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter' && results[hi]) {
      e.preventDefault()
      go(results[hi].path)
    } else if (e.key === 'Escape') {
      setQ('')
    }
  }

  // ---- selection pill (re-measured while a group animates) --------------------
  const scrollRef = useRef<HTMLDivElement>(null)
  const [tick, setTick] = useState(0)
  const animate = () => {
    const start = performance.now()
    const loop = () => {
      setTick((t) => t + 1)
      if (performance.now() - start < 360) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }
  const box = usePillBox(scrollRef, [active, collapsed, [...open].join(','), q === '', tick, nodes.length])
  const toggle = (key: string) => {
    setOpen((cur) => {
      const n = new Set(cur)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
    animate()
  }

  const isCollapsed = collapsed && variant === 'rail'
  const [ticketOpen, setTicketOpen] = useState(false)
  const pwa = useInstallPrompt()

  const link = (key: string, label: string, path: string, Icon?: IconType, child = false) => {
    const isActive = active === key
    const a = (
      <Link
        to={path}
        className={`nav-item press ${child ? 'nav-item--child' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        aria-label={isCollapsed ? label : undefined}
        data-pill-item
        data-pill-active={isActive}
        onClick={onNavigate}
      >
        {Icon && <Icon className="nav-item__icon" />}
        {!isCollapsed && <span className="nav-item__label">{label}</span>}
      </Link>
    )
    return isCollapsed ? (
      <Tooltip title={label} placement="right">
        {a}
      </Tooltip>
    ) : (
      a
    )
  }

  const searchBox = isCollapsed ? (
    <Tooltip title="Search any feature" placement="right">
      <button
        type="button"
        className="nav-item nav-search-icon press"
        aria-label="Search any feature"
        onClick={() => {
          onToggleCollapsed?.()
          setTimeout(() => inputRef.current?.focus(), 60)
        }}
      >
        <SearchOutlined className="nav-item__icon" />
      </button>
    </Tooltip>
  ) : (
    <div className="nav-search">
      <SearchOutlined aria-hidden="true" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onSearchKey}
        type="search"
        placeholder="Search any feature…"
        aria-label="Search any feature"
        role="combobox"
        aria-expanded={!!q.trim()}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={results[hi] ? `${listId}-${results[hi].key}` : undefined}
        autoComplete="off"
      />
      <kbd aria-hidden="true">Ctrl K</kbd>
    </div>
  )

  return (
    <Glass as="nav" aria-label="Main navigation" className={`sidebar sidebar--${variant}`} data-collapsed={isCollapsed} radius="var(--r-panel)">
      <div className="sidebar__head">
        <Link to="/" className="sidebar__brand" aria-label={`${BRAND.name} home`} onClick={onNavigate}>
          <span className="sidebar__logo" aria-hidden="true">H</span>
          {!isCollapsed && <span className="sidebar__name">{BRAND.name}</span>}
        </Link>
        {variant === 'rail' && (
          <button
            type="button"
            className="gbtn sidebar__collapse press"
            onClick={onToggleCollapsed}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        )}
      </div>
      <PlanBadge />
      {searchBox}
      <div className="sidebar__scroll" ref={scrollRef}>
        <SelectionPill box={box} />
        {q.trim() && !isCollapsed ? (
          <ul className="nav-list" id={listId} role="listbox" aria-label="Search results">
            {results.length === 0 && <li className="nav-empty">No feature matches “{q}”.</li>}
            {results.map((r, i) => (
              <li
                key={r.key}
                id={`${listId}-${r.key}`}
                role="option"
                aria-selected={i === hi}
                className={`nav-result ${i === hi ? 'nav-result--hi' : ''}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(r.path)}
              >
                <r.icon className="nav-item__icon" />
                <span className="nav-item__label">
                  {r.label}
                  {r.group && <small>{r.group}</small>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="nav-list">
            {nodes.map((n) => {
              if (!n.children) return <li key={n.key}>{link(n.key, n.label, n.path!, n.icon)}</li>
              const expanded = open.has(n.key)
              const containsActive = activeGroup === n.key
              if (isCollapsed) {
                return (
                  <li key={n.key}>
                    <Dropdown
                      placement="rightTop"
                      trigger={['click', 'hover']}
                      menu={{
                        items: n.children.map((c) => ({ key: c.path, label: c.label })),
                        onClick: (e) => go(e.key),
                        selectedKeys: [],
                      }}
                    >
                      <button
                        type="button"
                        className="nav-item press"
                        aria-label={`${n.label} menu`}
                        aria-haspopup="menu"
                        data-pill-item
                        data-pill-active={containsActive}
                      >
                        <n.icon className="nav-item__icon" />
                      </button>
                    </Dropdown>
                  </li>
                )
              }
              const panelId = `${listId}-g-${n.key}`
              return (
                <li key={n.key} className="nav-group" data-open={expanded}>
                  <button
                    type="button"
                    className={`nav-item nav-item--group press ${containsActive ? 'nav-item--has-active' : ''}`}
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => toggle(n.key)}
                    data-pill-item
                    data-pill-active={containsActive && !expanded}
                  >
                    <n.icon className="nav-item__icon" />
                    <span className="nav-item__label">{n.label}</span>
                    <DownOutlined className="nav-item__chev" aria-hidden="true" />
                  </button>
                  <div className="nav-group__panel" id={panelId} inert={!expanded}>
                    <ul className="nav-list nav-list--children">
                      {n.children.map((c) => (
                        <li key={c.key}>{link(c.key, c.label, c.path, undefined, true)}</li>
                      ))}
                    </ul>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="sidebar__foot">
        <button type="button" className="nav-item press" onClick={() => setTicketOpen(true)} aria-label="Support ticket" title="Support ticket">
          <CustomerServiceOutlined className="nav-item__icon" />
          {!isCollapsed && <span className="nav-item__label">Support Ticket</span>}
        </button>
        {pwa.canInstall && <InstallButton collapsed={isCollapsed} install={pwa.install} />}
      </div>
      <SupportTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} />
    </Glass>
  )
}
