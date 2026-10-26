import { useEffect, useRef } from 'react'
import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore'
import { signOut } from 'firebase/auth'
import { App } from 'antd'
import { useAuth } from '../../auth/AuthProvider'
import { auth, db, LAB_ID } from '../../firebase'

// Login-limit enforcement. Every signed-in browser tab registers a document under
// labs/{lab}/users/{uid}/sessions/{sid} and refreshes `seenAt` every minute. When a
// user with maxLogins = N has more than N live sessions, the OLDEST ones are signed out
// (newest sign-in wins). Admins can list a user's sessions and end them (force logout):
// a session whose document disappears signs itself out. Sessions not seen for
// STALE_MS (closed tab, crash) do not count towards the limit.

export interface SessionDoc {
  id: string
  device: string
  startedAt: number // ms
  seenAt: number // ms
}

export const SESSION_STALE_MS = 3 * 60 * 1000
const HEARTBEAT_MS = 60 * 1000
const KEY = 'hcl.session.id'

export const sessionsCol = (uid: string) => collection(db, 'labs', LAB_ID, 'users', uid, 'sessions')
const sessionRef = (uid: string, sid: string) => doc(db, 'labs', LAB_ID, 'users', uid, 'sessions', sid)

const describeDevice = () => {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return `${browser}${os ? ` on ${os}` : ''}`
}

function mySessionId(): string {
  try {
    let id = sessionStorage.getItem(KEY)
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      sessionStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

// The sessions that currently count, oldest first.
export const liveSessions = (all: SessionDoc[], now = Date.now()) =>
  all.filter((s) => now - s.seenAt < SESSION_STALE_MS).sort((a, b) => a.startedAt - b.startedAt)

// Sessions that must be ended to honour `limit`: everything except the newest `limit`.
export function sessionsOverLimit(all: SessionDoc[], limit: number, now = Date.now()): SessionDoc[] {
  if (!limit || limit < 1) return []
  const live = liveSessions(all, now)
  return live.slice(0, Math.max(0, live.length - limit))
}

// Admin: end one session (the owner's browser signs itself out within a second).
export const endSession = (uid: string, sid: string) => deleteDoc(sessionRef(uid, sid))

// Mount once inside the signed-in shell. Renders nothing.
export function SessionGuard() {
  const { user, profile } = useAuth()
  const { message } = App.useApp()
  const sid = useRef(mySessionId())
  const created = useRef(false)
  const uid = user?.uid
  const maxLogins = profile?.maxLogins ?? 0

  useEffect(() => {
    if (!uid) return
    const id = sid.current
    const now = Date.now()
    const startedAt = now
    const beat = () => setDoc(sessionRef(uid, id), { device: describeDevice(), startedAt, seenAt: Date.now() }, { merge: true }).catch(() => {})
    void setDoc(sessionRef(uid, id), { device: describeDevice(), startedAt, seenAt: now }).then(() => (created.current = true)).catch(() => {})
    const t = window.setInterval(beat, HEARTBEAT_MS)
    const bye = () => void deleteDoc(sessionRef(uid, id)).catch(() => {})
    window.addEventListener('pagehide', bye)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('pagehide', bye)
      created.current = false
    }
  }, [uid])

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      sessionsCol(uid),
      (snap) => {
        const all = snap.docs.map((d) => ({ ...(d.data() as Omit<SessionDoc, 'id'>), id: d.id }))
        const mine = all.find((s) => s.id === sid.current)
        const out = async (why: string) => {
          message.warning(why)
          created.current = false
          try {
            await deleteDoc(sessionRef(uid, sid.current))
          } catch {
            /* already gone */
          }
          await signOut(auth)
        }
        // Force-logged-out by an admin: our document was removed after we had created it.
        if (created.current && !snap.metadata.hasPendingWrites && !mine) {
          void out('You were signed out by an administrator.')
          return
        }
        if (mine && maxLogins > 0 && sessionsOverLimit(all, maxLogins).some((s) => s.id === sid.current)) {
          void out(`Login limit reached (${maxLogins}). You were signed out because this account signed in elsewhere.`)
        }
      },
      () => {},
    )
  }, [uid, maxLogins, message])

  return null
}
