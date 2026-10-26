import { useEffect, useRef } from 'react'
import { arrayUnion, doc, increment, setDoc } from 'firebase/firestore'
import dayjs from 'dayjs'
import { db, LAB_ID } from '../firebase'

// Route key: path with ids stripped (long or numeric-looking segments), '.' and '/' made safe for a field name.
export function routeKey(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean).map((s) => (/^\d+$/.test(s) || s.length > 18 || /\d/.test(s) && s.length > 8 ? ':id' : s))
  return (segs.join('>') || 'home').replace(/\./g, '_')
}

/** Counts page views per user per day: labs/{lab}/usage/{YYYY-MM-DD}_{uid}. Debounced, fire-and-forget. */
export function useUsageTracking(uid: string | undefined, pathname: string) {
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!uid) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const day = dayjs().format('YYYY-MM-DD')
      // First view of this browser session also records a sign-in time (Analysis > Login details counts them).
      let first = false
      try {
        if (!sessionStorage.getItem('hcl.usage.signin')) { sessionStorage.setItem('hcl.usage.signin', '1'); first = true }
      } catch { /* private mode */ }
      setDoc(doc(db, 'labs', LAB_ID, 'usage', `${day}_${uid}`), { uid, day, views: { [routeKey(pathname)]: increment(1) }, ...(first ? { signIns: arrayUnion(Date.now()) } : {}) }, { merge: true }).catch(() => {})
    }, 1500)
    return () => window.clearTimeout(timer.current)
  }, [uid, pathname])
}
