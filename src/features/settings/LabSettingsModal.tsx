import { useEffect, useState } from 'react'
import { Modal, Tabs } from 'antd'
import { can, useAuth } from '../../auth/AuthProvider'
import { MODAL_TABS, SettingsWorkspace } from '../../pages/admin/SettingsPage'
import { dialogWidth } from '../../design/dialog'

// Lab Settings as a tabbed modal opened from the gear in the top bar (the /settings page keeps working).
// Wire: mount <LabSettingsHost /> once in the app shell; the gear calls openLabSettings() (optionally with a tab key
// from MODAL_TABS, e.g. 'reports'). Users without settings access do not get the modal: the caller should fall back
// to navigating to /settings.

const EVENT = 'hcl:open-lab-settings'
export const openLabSettings = (tab?: string) => window.dispatchEvent(new CustomEvent(EVENT, { detail: { tab } }))

export function LabSettingsModal({ open, onClose, tab: tabProp }: { open: boolean; onClose: () => void; tab?: string }) {
  const [tab, setTab] = useState(tabProp ?? MODAL_TABS[0].key)
  const [section, setSection] = useState<string | null>(null)
  useEffect(() => { if (open && tabProp) { setTab(tabProp); setSection(null) } }, [open, tabProp])
  const active = MODAL_TABS.find((t) => t.key === tab) ?? MODAL_TABS[0]
  const sectionId = section && active.ids.includes(section) ? section : active.ids[0]
  return (
    <Modal title="Lab settings" open={open} onCancel={onClose} footer={null} width={dialogWidth(1100)} styles={{ body: { maxHeight: '75vh', overflow: 'auto' } }}>
      <Tabs
        activeKey={tab}
        onChange={(k) => { setTab(k); setSection(null) }}
        items={MODAL_TABS.map((t) => ({ key: t.key, label: t.label }))}
      />
      <SettingsWorkspace sectionId={sectionId} onSection={setSection} ids={active.ids} />
    </Modal>
  )
}

export function LabSettingsHost() {
  const { profile } = useAuth()
  const [state, setState] = useState<{ open: boolean; tab?: string }>({ open: false })
  useEffect(() => {
    const h = (e: Event) => setState({ open: true, tab: (e as CustomEvent<{ tab?: string }>).detail?.tab })
    window.addEventListener(EVENT, h)
    return () => window.removeEventListener(EVENT, h)
  }, [])
  if (!can(profile, 'settings.manage') && !can(profile, 'labprofile.edit')) return null
  return <LabSettingsModal open={state.open} tab={state.tab} onClose={() => setState({ open: false })} />
}
