import { useEffect, useMemo, useState } from 'react'
import { App } from 'antd'
import { addDoc, deleteDoc, orderBy, query, serverTimestamp, Timestamp, limit } from 'firebase/firestore'
import dayjs from 'dayjs'
import { useAuth } from '../auth/AuthProvider'
import { col, docRef } from '../lib/db'
import { useLiveQuery } from '../hooks/useLive'
import { Button } from '../design/Button'

export interface Announcement {
  id: string
  title: string
  body: string
  createdAt?: Timestamp
  createdByName?: string
  audienceRoles?: string[]
  expiresAt?: Timestamp
}

const seenKey = (uid: string) => `hcl.announce.seen.${uid}`
const readSeen = (uid: string) => {
  try {
    return Number(localStorage.getItem(seenKey(uid)) ?? 0)
  } catch {
    return 0
  }
}

export function useAnnouncements() {
  const { profile } = useAuth()
  const uid = profile?.uid ?? ''
  const { data } = useLiveQuery<Announcement>(uid ? query(col('announcements'), orderBy('createdAt', 'desc'), limit(30)) : null, [uid])
  const [seen, setSeen] = useState(() => readSeen(uid))
  useEffect(() => {
    setSeen(readSeen(uid))
    const on = () => setSeen(readSeen(uid))
    window.addEventListener('hcl:announce-seen', on)
    return () => window.removeEventListener('hcl:announce-seen', on)
  }, [uid])
  const items = useMemo(() => {
    const now = Date.now()
    return data.filter((a) => {
      if (a.expiresAt && a.expiresAt.toMillis() < now) return false
      if (a.audienceRoles?.length && !a.audienceRoles.includes(profile?.role ?? '')) return false
      return true
    })
  }, [data, profile?.role])
  const isNew = (a: Announcement) => (a.createdAt?.toMillis() ?? Date.now()) > seen
  const unread = items.filter(isNew).length
  const markSeen = () => {
    const t = Date.now()
    try {
      localStorage.setItem(seenKey(uid), String(t))
    } catch {
      /* ignore */
    }
    setSeen(t)
    window.dispatchEvent(new Event('hcl:announce-seen'))
  }
  return { items, unread, isNew, markSeen }
}

export function AnnouncementComposer() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [days, setDays] = useState('')
  const [busy, setBusy] = useState(false)
  const post = async () => {
    setBusy(true)
    try {
      const n = Number(days)
      await addDoc(col('announcements'), {
        title: title.trim(),
        body: body.trim(),
        createdAt: serverTimestamp(),
        createdByName: profile?.name ?? '',
        ...(n > 0 ? { expiresAt: Timestamp.fromDate(dayjs().add(n, 'day').toDate()) } : {}),
      })
      setTitle('')
      setBody('')
      setDays('')
      message.success('Announcement posted')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--s-2)', marginTop: 'var(--s-3)' }}>
      <div className="field-row">
        <label htmlFor="ann-title">Announcement title</label>
        <input id="ann-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field-row">
        <label htmlFor="ann-body">Message</label>
        <textarea id="ann-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="field-row">
        <label htmlFor="ann-days">Expires after (days, optional)</label>
        <input id="ann-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
      </div>
      <Button variant="primary" disabled={!title.trim() || !body.trim() || busy} onClick={post}>Post announcement</Button>
    </div>
  )
}

/** Announcements section for the bell panel and the What's new drawer. */
export function AnnouncementList({ list, withComposer }: { list: ReturnType<typeof useAnnouncements>; withComposer?: boolean }) {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'labAdmin' || profile?.role === 'admin'
  return (
    <div>
      {list.items.length === 0 ? (
        <p style={{ color: 'var(--c-on-surface-variant)' }}>No announcements.</p>
      ) : (
        list.items.map((a) => (
          <div key={a.id} className="ann-item" data-unread={list.isNew(a)}>
            <strong>{a.title}</strong>
            <p>{a.body}</p>
            <time>{a.createdByName ? `${a.createdByName} · ` : ''}{a.createdAt?.toDate ? dayjs(a.createdAt.toDate()).format('DD MMM, h:mm A') : ''}</time>
            {isAdmin && <Button variant="text" onClick={() => void deleteDoc(docRef('announcements', a.id))}>Delete</Button>}
          </div>
        ))
      )}
      {withComposer && isAdmin && <AnnouncementComposer />}
    </div>
  )
}
