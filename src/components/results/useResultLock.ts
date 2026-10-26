import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteDoc, onSnapshot, setDoc } from 'firebase/firestore'
import { docRef } from '../../lib/db'

// "Someone else is editing this bill" marker: one short-lived doc per bill (resultLocks/{orderId}) that the editor
// refreshes every 20 seconds. A marker older than a minute is ignored, so a closed tab never blocks anyone.
export const LOCK_TTL_MS = 60_000
const BEAT_MS = 20_000

export interface LockInfo {
  uid: string
  name: string
  at: number
}

export function useResultLock(orderId: string, enabled: boolean, me: { uid: string; name: string }) {
  const [lock, setLock] = useState<LockInfo | null>(null)
  const [tick, setTick] = useState(0)
  const lockRef = useRef<LockInfo | null>(null)
  lockRef.current = lock
  const ref = orderId ? docRef('resultLocks', orderId) : null

  useEffect(() => {
    if (!ref) return
    return onSnapshot(ref, (s) => setLock(s.exists() ? (s.data() as LockInfo) : null), () => setLock(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  const claim = useCallback(() => {
    if (!ref || !me.uid) return
    void setDoc(ref, { uid: me.uid, name: me.name, at: Date.now() }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, me.uid, me.name])

  useEffect(() => {
    if (!enabled || !ref || !me.uid) return
    const beat = () => {
      const l = lockRef.current
      const free = !l || l.uid === me.uid || Date.now() - l.at > LOCK_TTL_MS
      if (free) claim()
      setTick((n) => n + 1)
    }
    beat()
    const h = setInterval(beat, BEAT_MS)
    return () => {
      clearInterval(h)
      if (lockRef.current?.uid === me.uid) void deleteDoc(ref).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, enabled, me.uid])

  void tick
  const other = lock && lock.uid !== me.uid && Date.now() - lock.at < LOCK_TTL_MS ? lock : null
  return { other, takeOver: claim }
}
