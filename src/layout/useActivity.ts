import { useCallback, useEffect, useMemo, useState } from 'react'
import { limit, orderBy, query, type Timestamp } from 'firebase/firestore'
import { col } from '../lib/db'
import { useLiveQuery } from '../hooks/useLive'
import { useBranchScope } from '../lib/branchScope'

export interface ActivityItem {
  id: string
  type: string
  text: string
  refPath: string
  at: Timestamp | null
  byName: string
}

const load = (key: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
const save = (key: string, s: Set<string>) => {
  try {
    localStorage.setItem(key, JSON.stringify([...s].slice(-300)))
  } catch {
    /* ignore */
  }
}

// Latest 30 branch activity events. Read and dismissed state is per user, kept in localStorage.
// Needs the composite index activity(branchId asc, at desc); until it exists the
// unordered fallback is used and sorted here.
export function useActivity(uid: string) {
  const scope = useBranchScope()
  const ordered = useLiveQuery<ActivityItem>(query(col('activity'), ...scope.constraints, orderBy('at', 'desc'), limit(30)), [scope.key])
  const fallback = useLiveQuery<ActivityItem>(ordered.error ? query(col('activity'), ...scope.constraints, limit(100)) : null, [scope.key, !!ordered.error])
  const raw = ordered.error ? fallback.data : ordered.data

  const readKey = `hcl.activity.read.${uid}`
  const dismissKey = `hcl.activity.dismissed.${uid}`
  const [read, setRead] = useState(() => load(readKey))
  const [dismissed, setDismissed] = useState(() => load(dismissKey))
  useEffect(() => {
    setRead(load(readKey))
    setDismissed(load(dismissKey))
  }, [readKey, dismissKey])

  const items = useMemo(
    () =>
      [...raw]
        .sort((a, b) => (b.at?.toMillis?.() ?? Date.now()) - (a.at?.toMillis?.() ?? Date.now()))
        .slice(0, 30)
        .filter((i) => !dismissed.has(i.id)),
    [raw, dismissed],
  )
  const unread = items.filter((i) => !read.has(i.id)).length

  const markAllRead = useCallback(() => {
    const n = new Set(read)
    items.forEach((i) => n.add(i.id))
    setRead(n)
    save(readKey, n)
  }, [items, read, readKey])
  const dismiss = useCallback(
    (id: string) => {
      const n = new Set(dismissed).add(id)
      setDismissed(n)
      save(dismissKey, n)
    },
    [dismissed, dismissKey],
  )
  const clearAll = useCallback(() => {
    const n = new Set(dismissed)
    raw.forEach((i) => n.add(i.id))
    setDismissed(n)
    save(dismissKey, n)
  }, [raw, dismissed, dismissKey])
  return { items, unread, isRead: (id: string) => read.has(id), markAllRead, dismiss, clearAll }
}
