import { useEffect, useState } from 'react'
import { DownloadOutlined } from '@ant-design/icons'

interface InstallEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: string }>
}

// Registers the minimal service worker and captures the browser's install prompt.
export function useInstallPrompt() {
  const [ev, setEv] = useState<InstallEvent | null>(null)
  useEffect(() => {
    if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {})
    const on = (e: Event) => {
      e.preventDefault()
      setEv(e as InstallEvent)
    }
    const done = () => setEv(null)
    window.addEventListener('beforeinstallprompt', on)
    window.addEventListener('appinstalled', done)
    return () => {
      window.removeEventListener('beforeinstallprompt', on)
      window.removeEventListener('appinstalled', done)
    }
  }, [])
  return {
    canInstall: !!ev,
    install: async () => {
      if (!ev) return
      await ev.prompt()
      await ev.userChoice.catch(() => null)
      setEv(null)
    },
  }
}

export function InstallButton({ collapsed, install }: { collapsed: boolean; install: () => void }) {
  return (
    <button type="button" className="nav-item press" onClick={install} aria-label="Install app" title="Install app">
      <DownloadOutlined className="nav-item__icon" />
      {!collapsed && <span className="nav-item__label">Install app</span>}
    </button>
  )
}
