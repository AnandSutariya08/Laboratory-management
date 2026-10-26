import { useState, type RefObject } from 'react'
import { canChangeOwnPassword } from '../features/settings/lib'
import { Link, useLocation } from 'react-router-dom'
import { Dropdown, Popover, Tooltip, type MenuProps } from 'antd'
import {
  BarcodeOutlined,
  BellOutlined,
  CheckOutlined,
  DownOutlined,
  EnvironmentOutlined,
  GiftOutlined,
  LogoutOutlined,
  MenuOutlined,
  KeyOutlined,
  PlayCircleOutlined,
  CustomerServiceOutlined,
  ReadOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  UserOutlined,
  BgColorsOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { can, useAuth } from '../auth/AuthProvider'
import { useBranch } from '../branch/BranchProvider'
import { CapsuleGroup } from '../design/Glass'
import { useDisplay, type ThemeChoice } from '../design/DisplaySettings'
import { StatusChip } from '../design/StatusChip'
import { Skeleton } from '../design/Skeletons'
import { EmptyState } from '../design/EmptyState'
import { useAlerts, type AlertSeverity } from './useAlerts'
import GlobalSearch from './GlobalSearch'
import ScanDialog from './ScanDialog'
import NewsDrawer from './NewsDrawer'
import ProfileModal from './ProfileModal'
import SupportTicketModal from './SupportTicketModal'
import SupportBot from './SupportBot'
import { BrowserCodeModal } from '../features/settings/DeviceCode'
import { DeleteAccountModal } from '../features/settings/AccountRequests'
import { openLabSettings } from '../features/settings/LabSettingsModal'
import { AnnouncementList, useAnnouncements } from './Announcements'
import { DemoVideos, HelpDrawer, SupportCenter } from './HelpPanels'
import { useActivity } from './useActivity'
import { Button } from '../design/Button'
import dayjs from 'dayjs'
import { CloseOutlined } from '@ant-design/icons'

const ROLE_LABEL: Record<string, string> = {
  labAdmin: 'Lab admin',
  admin: 'Admin',
  manager: 'Manager',
  reception: 'Reception',
  technician: 'Technician',
  doctor: 'Doctor',
  phlebotomist: 'Phlebotomist',
}

const SEVERITY_VARIANT: Record<AlertSeverity, 'urgent' | 'caution' | 'info'> = {
  urgent: 'urgent',
  caution: 'caution',
  info: 'info',
}

interface TopBarProps {
  title: string
  compact: boolean
  onOpenMenu: () => void
  searchRef: RefObject<HTMLInputElement | null>
  scanOpen: boolean
  setScanOpen: (v: boolean) => void
  helpOpen: boolean
  setHelpOpen: (v: boolean) => void
}

export default function TopBar({ title, compact, onOpenMenu, searchRef, scanOpen, setScanOpen, helpOpen, setHelpOpen }: TopBarProps) {
  const { profile, logout } = useAuth()
  const { branches, current, setCurrent, allBranches, setAllBranches } = useBranch()
  const display = useDisplay()
  const { pathname } = useLocation()
  const { alerts, total: alertTotal, loading } = useAlerts(profile)
  const activity = useActivity(profile?.uid ?? '')
  const ann = useAnnouncements()
  const total = alertTotal + activity.unread + ann.unread

  const [bellOpen, setBellOpen] = useState(false)
  const [newsOpen, setNewsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [videosOpen, setVideosOpen] = useState(false)
  const [botOpen, setBotOpen] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)

  // ---- branch switcher ---------------------------------------------------------
  const canAll = can(profile, 'branches.allView') && branches.length > 1
  const branchLabel = allBranches ? 'All branches' : (current?.name ?? 'Branch')
  const branchItems: MenuProps['items'] = [
    ...branches.map((b) => ({
      key: `b:${b.id}`,
      label: b.name,
      icon: !allBranches && current?.id === b.id ? <CheckOutlined /> : <span style={{ width: 14, display: 'inline-block' }} />,
      disabled: !b.active,
    })),
    ...(canAll
      ? [
          { type: 'divider' as const },
          { key: 'all', label: 'All branches', icon: allBranches ? <CheckOutlined /> : <span style={{ width: 14, display: 'inline-block' }} /> },
        ]
      : []),
  ]
  const onBranch: MenuProps['onClick'] = ({ key }) => {
    if (key === 'all') setAllBranches(!allBranches)
    else {
      setAllBranches(false)
      setCurrent(key.slice(2))
    }
  }

  // ---- notifications ---------------------------------------------------------------
  const bell = (
    <div className="bell-panel" role="region" aria-label="Notifications">
      <div className="bell-panel__bar">
        <h2 className="panel-title">Activity</h2>
        <span style={{ display: 'flex', gap: 'var(--s-1)' }}>
          {activity.unread > 0 && <Button variant="text" onClick={activity.markAllRead}>Mark all read</Button>}
          {activity.items.length > 0 && <Button variant="text" onClick={activity.clearAll}>Clear all</Button>}
        </span>
      </div>
      <div className="bell-panel__scroll">
      {activity.items.length === 0 ? (
        <p style={{ color: 'var(--c-on-surface-variant)', margin: '0 0 var(--s-3)' }}>No recent activity in this branch.</p>
      ) : (
        <ul className="alert-list">
          {activity.items.map((i) => {
            const unread = !activity.isRead(i.id)
            const body = (
              <span className="act-item__body">
                <span>{i.text}</span>
                <time>{i.byName ? `${i.byName} · ` : ''}{i.at?.toDate ? dayjs(i.at.toDate()).format('DD MMM, h:mm A') : ''}</time>
              </span>
            )
            return (
              <li key={i.id} className="act-item" data-unread={unread}>
                {i.refPath ? <Link to={i.refPath} onClick={() => setBellOpen(false)} style={{ flex: 1, color: 'inherit', textDecoration: 'none' }}>{body}</Link> : body}
                <Button variant="text" aria-label="Dismiss notification" icon={<CloseOutlined />} onClick={() => activity.dismiss(i.id)} />
              </li>
            )
          })}
        </ul>
      )}
      <h2 className="panel-title">Announcements</h2>
      <AnnouncementList list={ann} />
      <h2 className="panel-title">Needs attention</h2>
      {loading && alerts.length === 0 ? (
        <div style={{ display: 'grid', gap: 12, padding: 8 }}>
          <Skeleton height={16} />
          <Skeleton width="70%" height={12} />
        </div>
      ) : alerts.length === 0 ? (
        <EmptyState title="All clear" description="Nothing needs attention right now." />
      ) : (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.key}>
              <Link to={a.to} onClick={() => setBellOpen(false)} className="alert-item press">
                <span className="alert-item__head">
                  <strong>{a.title}</strong>
                  <StatusChip variant={SEVERITY_VARIANT[a.severity]}>
                    {a.severity === 'urgent' ? 'Urgent' : a.severity === 'caution' ? 'Attention' : 'Info'}
                  </StatusChip>
                </span>
                <span className="alert-item__detail">{a.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      </div>
    </div>
  )

  const helpItems: MenuProps['items'] = [
    { key: 'bot', icon: <RobotOutlined />, label: 'Ask Support Assistant' },
    { key: 'support', icon: <CustomerServiceOutlined />, label: 'Support Center' },
    { key: 'helpcenter', icon: <ReadOutlined />, label: 'Help Center' },
    { key: 'videos', icon: <PlayCircleOutlined />, label: 'Demo videos' },
  ]
  const onHelp: MenuProps['onClick'] = ({ key }) => {
    if (key === 'bot') setBotOpen(true)
    else if (key === 'support') setSupportOpen(true)
    else if (key === 'helpcenter') setHelpOpen(true)
    else if (key === 'videos') setVideosOpen(true)
  }

  // ---- user menu ---------------------------------------------------------------------
  const check = (on: boolean) => (on ? <CheckOutlined /> : <span style={{ width: 14, display: 'inline-block' }} />)
  const userItems: MenuProps['items'] = [
    {
      key: 'who',
      disabled: true,
      label: (
        <span className="user-who">
          <strong>{profile?.name}</strong>
          <small>
            {ROLE_LABEL[profile?.role ?? ''] ?? profile?.role} · {allBranches ? 'All branches' : (current?.name ?? '')}
          </small>
        </span>
      ),
    },
    { type: 'divider' },
    { key: 'profile', icon: <UserOutlined />, label: 'My profile' },
    ...(canChangeOwnPassword(profile) ? [{ key: 'password', icon: <KeyOutlined />, label: 'Change password' }] : []),
    {
      key: 'display',
      icon: <BgColorsOutlined />,
      label: 'Display settings',
      children: [
        { key: 'theme:light', icon: check(display.prefs.theme === 'light'), label: 'Light theme' },
        { key: 'theme:dark', icon: check(display.prefs.theme === 'dark'), label: 'Dark theme' },
        { key: 'theme:system', icon: check(display.prefs.theme === 'system'), label: 'Match system' },
        { type: 'divider' },
        { key: 'reduceMotion', icon: check(display.prefs.reduceMotion), label: 'Reduce motion' },
        { key: 'reduceTransparency', icon: check(display.prefs.reduceTransparency), label: 'Reduce transparency' },
        { key: 'increaseContrast', icon: check(display.prefs.increaseContrast), label: 'Increase contrast' },
      ],
    },
    ...(compact
      ? [
          { key: 'help', icon: <QuestionCircleOutlined />, label: 'Help Center' },
          { key: 'bot', icon: <RobotOutlined />, label: 'Ask Support Assistant' },
          { key: 'support', icon: <CustomerServiceOutlined />, label: 'Support Center' },
          { key: 'news', icon: <GiftOutlined />, label: "What's new" },
        ]
      : []),
    { key: 'browsercode', icon: <SafetyCertificateOutlined />, label: 'Browser Code' },
    { key: 'deleteaccount', icon: <DeleteOutlined />, label: 'Delete Account', danger: true },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: 'Log out' },
  ]
  const onUser: MenuProps['onClick'] = ({ key }) => {
    if (key.startsWith('theme:')) display.set({ theme: key.slice(6) as ThemeChoice })
    else if (key === 'reduceMotion') display.set({ reduceMotion: !display.prefs.reduceMotion })
    else if (key === 'reduceTransparency') display.set({ reduceTransparency: !display.prefs.reduceTransparency })
    else if (key === 'increaseContrast') display.set({ increaseContrast: !display.prefs.increaseContrast })
    else if (key === 'profile' || key === 'password') setProfileOpen(true)
    else if (key === 'help') setHelpOpen(true)
    else if (key === 'bot') setBotOpen(true)
    else if (key === 'support') setSupportOpen(true)
    else if (key === 'news') setNewsOpen(true)
    else if (key === 'browsercode') setCodeOpen(true)
    else if (key === 'deleteaccount') setDelOpen(true)
    else if (key === 'logout') void logout()
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar__title" aria-hidden="true">
          {title}
        </div>

        {/* Group 1: search + scan */}
        <CapsuleGroup label="Search">
          {compact && (
            <button type="button" className="gbtn press" aria-label="Open navigation menu" onClick={onOpenMenu}>
              <MenuOutlined />
            </button>
          )}
          <GlobalSearch inputRef={searchRef} />
          <Tooltip title="Scan barcode (Alt S)">
            <button type="button" className="gbtn press" aria-label="Scan barcode" onClick={() => setScanOpen(true)}>
              <BarcodeOutlined />
              {!compact && <span className="hide-md">Scan</span>}
            </button>
          </Tooltip>
        </CapsuleGroup>

        {/* Group 2: branch, alerts, help, what's new */}
        <CapsuleGroup label="Workspace">
          <Dropdown menu={{ items: branchItems, onClick: onBranch }} trigger={['click']} placement="bottomRight">
            <button type="button" className="gbtn press" aria-label={`Branch: ${branchLabel}. Change branch`} aria-haspopup="menu">
              <EnvironmentOutlined />
              <span className="gbtn__text hide-sm">{branchLabel}</span>
              <DownOutlined style={{ fontSize: 10 }} aria-hidden="true" />
            </button>
          </Dropdown>
          <Popover content={bell} trigger="click" placement="bottomRight" open={bellOpen} onOpenChange={(v) => { setBellOpen(v); if (v) setTimeout(ann.markSeen, 1500) }} arrow={false} classNames={{ root: 'bell-popover' }} styles={{ container: { padding: 8 } }}>
            <button
              type="button"
              className="gbtn press"
              aria-label={total ? `Notifications, ${total} alert${total === 1 ? '' : 's'}` : 'Notifications, none'}
              aria-expanded={bellOpen}
            >
              <BellOutlined />
              {total > 0 && <span className="gbtn__badge" aria-hidden="true">{total > 99 ? '99+' : total}</span>}
            </button>
          </Popover>
          {!compact && (
            <>
              <Dropdown menu={{ items: helpItems, onClick: onHelp }} trigger={['click']} placement="bottomRight">
                <button type="button" className="gbtn press" aria-label="Help menu" aria-haspopup="menu">
                  <QuestionCircleOutlined />
                </button>
              </Dropdown>
              <Tooltip title="What's new">
                <button type="button" className="gbtn press" aria-label="What's new" onClick={() => setNewsOpen(true)}>
                  <GiftOutlined />
                </button>
              </Tooltip>
            </>
          )}
        </CapsuleGroup>

        {/* Group 3: settings + user */}
        <CapsuleGroup label="Account">
          {can(profile, 'settings.manage') && (
            <Tooltip title="Lab settings">
              <button type="button" className="gbtn press" aria-label="Lab settings" onClick={() => openLabSettings()}>
                <SettingOutlined />
              </button>
            </Tooltip>
          )}
          <Dropdown menu={{ items: userItems, onClick: onUser }} trigger={['click']} placement="bottomRight">
            <button type="button" className="gbtn press gbtn--user" aria-label={`Account menu for ${profile?.name ?? 'user'}`} aria-haspopup="menu">
              <span className="avatar" aria-hidden="true">{profile?.name?.[0]?.toUpperCase() ?? '?'}</span>
              <span className="gbtn__text hide-md">{profile?.name}</span>
            </button>
          </Dropdown>
        </CapsuleGroup>
      </header>

      <ScanDialog open={scanOpen} onClose={() => setScanOpen(false)} />
      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} pathname={pathname} />
      <SupportCenter open={supportOpen} onClose={() => setSupportOpen(false)} onTicket={() => setTicketOpen(true)} />
      <SupportTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} />
      <DemoVideos open={videosOpen} onClose={() => setVideosOpen(false)} />
      <NewsDrawer open={newsOpen} onClose={() => setNewsOpen(false)} />
      <SupportBot open={botOpen} onClose={() => setBotOpen(false)} />
      <BrowserCodeModal open={codeOpen} onClose={() => setCodeOpen(false)} />
      <DeleteAccountModal open={delOpen} onClose={() => setDelOpen(false)} />
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  )
}
