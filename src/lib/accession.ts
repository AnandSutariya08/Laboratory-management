import { addDoc, arrayUnion, serverTimestamp, updateDoc } from 'firebase/firestore'
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage'
import { LAB_ID, storage } from '../firebase'
import { branchStamp } from './activeBranch'
import { col, docRef, nextCounter, paths } from './db'
import type { AccessionSettings } from '../types'

// Barcode and label rules shared by the accession screen and label printing.

// Barcode composition (prefix / suffix), label sets and scan resolution live in pages/catalogue/flags.ts
// (composeBarcode, sampleLabels, billBarcodeFromScan); this file only holds the label sizes.

export const LABEL_MM: Record<AccessionSettings['labelSize'], { w: number; h: number; font: number }> = {
  '50x25': { w: 50, h: 25, font: 20 },
  '38x25': { w: 38, h: 25, font: 16 },
  '75x38': { w: 75, h: 38, font: 30 },
}

// ---- Collection photos (Firebase Storage) -------------------------------------
// Photos taken at collection (camera on a phone, or a file pick) are stored under
// labs/{lab}/collection/{orderId}/ and only the path and details sit on the bill (collectionPhotoFiles).
// Older bills keep data-URL photos in `collectionPhotos`; both are shown.

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024
export const MAX_PHOTOS = 6

export interface PhotoMeta {
  path: string
  name: string
  size: number
  contentType: string
  at: number
  by: string
  byName: string
}

// Shrinks a large camera photo before upload (long side 1600 px); small files go up untouched.
async function shrink(file: File): Promise<Blob> {
  if (file.size < 600 * 1024 || !file.type.startsWith('image/')) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale)
    c.height = Math.round(bmp.height * scale)
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.85))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}

export async function uploadCollectionPhotos(orderId: string, files: File[], who: { uid: string; name: string }, existing = 0): Promise<PhotoMeta[]> {
  if (existing + files.length > MAX_PHOTOS) throw new Error(`A bill can hold at most ${MAX_PHOTOS} collection photos.`)
  const out: PhotoMeta[] = []
  for (const f of files) {
    if (!f.type.startsWith('image/')) throw new Error(`${f.name} is not an image.`)
    if (f.size > MAX_PHOTO_BYTES) throw new Error(`${f.name} is larger than 15 MB.`)
    const body = await shrink(f)
    const safe = f.name.replace(/[^\w.-]+/g, '_').slice(-60) || 'photo.jpg'
    const path = `labs/${LAB_ID}/collection/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}`
    await uploadBytes(storageRef(storage, path), body, { contentType: body.type || f.type || 'image/jpeg' })
    out.push({ path, name: f.name, size: body.size, contentType: body.type || f.type, at: Date.now(), by: who.uid, byName: who.name })
  }
  if (out.length) await updateDoc(docRef(paths.orders, orderId), { collectionPhotoFiles: arrayUnion(...out) })
  return out
}

export const photoUrl = (path: string) => getDownloadURL(storageRef(storage, path))

// ---- Collection-centre dispatch manifest -----------------------------------------
// A collection centre packs its collected samples into a manifest. While it travels the lines are In transit;
// the lab receives the batch by scanning tubes. Tubes not scanned can be marked Not received.
export interface ManifestLine {
  orderId: string
  billNo: string
  patientName: string
  barcode: string
  lineIds: string[]
  samples: string
}
export interface Manifest {
  id: string
  branchId?: string
  no: string
  centreId: string
  centreName: string
  lines: ManifestLine[]
  courier: string
  tubes: number
  temperature: string
  note: string
  status: 'inTransit' | 'received' | 'partial'
  createdBy: string
  createdByName: string
  createdAt?: unknown
  receivedBy?: string
  receivedByName?: string
  receivedAt?: number
  receivedOrderIds?: string[]
}
export const MANIFESTS = 'manifests'

export async function createManifest(
  meta: { centreId: string; centreName: string; courier: string; tubes: number; temperature: string; note: string },
  lines: ManifestLine[],
  who: { uid: string; name: string },
): Promise<{ id: string; no: string }> {
  if (!lines.length) throw new Error('Choose at least one collected sample.')
  const no = `MF-${String(await nextCounter('manifest')).padStart(5, '0')}`
  const d = await addDoc(col(MANIFESTS), {
    ...branchStamp(),
    ...meta,
    no,
    lines,
    status: 'inTransit',
    createdBy: who.uid,
    createdByName: who.name,
    createdAt: serverTimestamp(),
  })
  return { id: d.id, no }
}

// ---- Outsourced samples ------------------------------------------------------------
export interface SentToLab {
  labId: string
  labName: string
  at: number
  by: string
  byName: string
}

// Hours after registration before a pending sample is marked Not Received (lab setting). Off by default: Flabs only marks it by hand.
export const notReceivedHours = (a: { notReceivedAfterHours?: number } | undefined) => {
  const n = a?.notReceivedAfterHours
  return typeof n === 'number' && n >= 0 ? n : 0
}
