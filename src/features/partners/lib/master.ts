import { useMemo } from 'react'
import { addDoc, deleteDoc, getDoc, serverTimestamp, setDoc, type DocumentData } from 'firebase/firestore'
import { auditCommissionChange } from '../../settings/audit'
import { assertCan } from '../../../auth/AuthProvider'
import { col, docRef } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import type { RateList } from '../types'

// Shared (all-branch) master collections, live. Sorted by name on the client so no
// index is needed and docs missing a name are never hidden.
export function useMaster<T extends { id: string }>(name: string) {
  const r = useLiveQuery<T>(col<DocumentData>(name), [name])
  const data = useMemo(
    () =>
      [...r.data].filter((x) => !(x as { deleted?: boolean }).deleted).sort((a, b) =>
        String((a as { name?: string }).name ?? '').localeCompare(String((b as { name?: string }).name ?? '')),
      ),
    [r.data],
  )
  return { data, loading: r.loading, error: r.error }
}

export const useRateLists = () => useMaster<RateList>('rateLists')

const COMMISSION_KEYS = ['commissionType', 'commissionValue', 'commissionRules', 'commissionMode', 'commissionListId', 'settlementType', 'settlementValue']

// Create (id null) or merge-update a master doc. Returns the id.
export async function saveMaster(name: string, id: string | null, data: Record<string, unknown>): Promise<string> {
  const clean = Object.fromEntries(Object.entries(data).filter(([k, v]) => k !== 'id' && v !== undefined))
  if (id) {
    // X-03: commission / settlement changes are audited with the before and after values.
    const watched = Object.keys(clean).filter((k) => COMMISSION_KEYS.includes(k))
    let before: DocumentData | undefined
    if (watched.length) before = (await getDoc(docRef(name, id))).data() as DocumentData | undefined
    await setDoc(docRef(name, id), { ...clean, updatedAt: serverTimestamp() }, { merge: true })
    if (watched.length && before) {
      const pick = (o: DocumentData) => Object.fromEntries(watched.map((k) => [k, o[k] ?? null]))
      const b = pick(before)
      const a = pick(clean)
      if (JSON.stringify(b) !== JSON.stringify(a)) void auditCommissionChange(String(clean.name ?? before.name ?? id), `${name}/${id}`, b, a)
    }
    return id
  }
  const ref = await addDoc(col(name), { ...clean, createdAt: serverTimestamp() })
  return ref.id
}

// Soft delete (X-02): the doc stays for old bills, hidden from lists, restorable from Lab settings > Deleted items.
export const removeMaster = (name: string, id: string) => {
  try {
    assertCan('catalogue.delete', 'delete this record')
  } catch (e) {
    return Promise.reject(e)
  }
  return setDoc(docRef(name, id), { deleted: true, deletedAt: serverTimestamp() }, { merge: true })
}
export const restoreMaster = (name: string, id: string) => setDoc(docRef(name, id), { deleted: false, deletedAt: null }, { merge: true })
// Permanent removal, only for rows that were never used (e.g. a draft). Prefer removeMaster.
export const purgeMaster = (name: string, id: string) => deleteDoc(docRef(name, id))

// Make sure an owner (centre, client, lab...) has a rate list; creates one and links it.
export async function ensureRateList(
  ownerCollection: string,
  ownerId: string,
  ownerName: string,
  kind: RateList['kind'],
  existingId?: string,
): Promise<string> {
  if (existingId) return existingId
  const id = await saveMaster('rateLists', null, { name: `${ownerName} price list`, kind, entries: {}, active: true })
  await saveMaster(ownerCollection, ownerId, { rateListId: id })
  return id
}
