import { App } from 'antd'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { logActivity } from '../../layout/activity'
import type { UserProfile } from '../../types'

// Super-admin "view as user" (USR-15). Read-only (can() returns false for every change permission while viewing) and
// audited: start and end are written to the audit log with category ADMIN_ACCESS.
// Wire: <ViewAsBanner /> once at the top of the app shell; the Users page already has the "View as" action.

export function useViewAs() {
  const { realProfile, profile, startViewAs, stopViewAs, viewingAs } = useAuth()
  const { message } = App.useApp()
  const begin = async (u: Pick<UserProfile, 'uid' | 'name'>) => {
    const admin = realProfile ?? profile
    if (!admin) return
    await logActivity('admin', `Support view started: ${admin.name} is viewing as ${u.name}`, `users/${u.uid}`, { category: 'ADMIN_ACCESS', actor: { uid: admin.uid, name: admin.name }, extra: { targetUid: u.uid } })
    await startViewAs(u.uid)
    message.info(`Viewing as ${u.name}. Nothing can be changed in this mode.`)
  }
  const end = async () => {
    const admin = realProfile
    await logActivity('admin', `Support view ended: ${admin?.name ?? 'admin'} stopped viewing as ${profile?.viewedBy ? profile.name : 'user'}`, `users/${profile?.uid ?? ''}`, { category: 'ADMIN_ACCESS', actor: admin ? { uid: admin.uid, name: admin.name } : undefined })
    stopViewAs()
  }
  return { viewingAs, begin, end }
}

export function ViewAsBanner() {
  const { viewingAs, end } = useViewAs()
  const { profile } = useAuth()
  if (!viewingAs) return null
  return (
    <div role="status" style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', padding: '8px 16px', background: 'var(--c-caution-wash, #fff4d6)', color: 'var(--c-on-surface, #1b1b1b)', borderBottom: '1px solid var(--c-outline-variant, #ccc)' }}>
      <span>Viewing as <b>{profile?.name}</b>. Read-only, and recorded in the audit log.</span>
      <Button onClick={() => void end()}>Exit view</Button>
    </div>
  )
}
