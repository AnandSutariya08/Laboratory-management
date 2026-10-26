import { useEffect, useState } from 'react'
import {
  onSnapshot,
  type DocumentReference,
  type Query,
} from 'firebase/firestore'

// Real-time list bound to a Firestore query via onSnapshot.
// Pass null to pause the subscription (e.g. while inputs are incomplete).
export function useLiveQuery<T>(q: Query | null, deps: unknown[] = []) {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!q) {
      setData([])
      setLoading(false)
      return
    }
    setLoading(true)
    return onSnapshot(
      q,
      (snap) => {
        setData(snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as T))
        setLoading(false)
      },
      (err) => {
        setError(err)
        setLoading(false)
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading, error }
}

export function useLiveDoc<T>(ref: DocumentReference | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!ref) {
      setData(null)
      setLoading(false)
      return
    }
    setLoading(true)
    return onSnapshot(ref, (snap) => {
      setData(snap.exists() ? ({ ...(snap.data() as object), id: snap.id } as T) : null)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading }
}
