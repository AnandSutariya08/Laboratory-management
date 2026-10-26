import { doc, deleteDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { getBlob, ref as storageRef, uploadBytes } from 'firebase/storage'
import { useEffect, useState } from 'react'
import { db, LAB_ID, storage } from '../../firebase'
import { docRef, paths } from '../../lib/db'

export const reportFileDoc = (orderId: string) => doc(db, 'labs', LAB_ID, 'orders', orderId, 'reportFiles', 'main')

export const MAX_REPORT_FILE_BYTES = 15 * 1024 * 1024

export interface ReportFileDoc { name: string; dataUrl?: string; path?: string; size?: number }

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the file'))
    r.readAsDataURL(b)
  })

// Re-uploaded PDF: stored in Firebase Storage (labs/{lab}/orders/{order}/reportFile/...), only the path is kept in Firestore.
export async function uploadReportFile(orderId: string, file: File, by: string) {
  if (file.type !== 'application/pdf') throw new Error('Only PDF files can be attached')
  if (file.size > MAX_REPORT_FILE_BYTES) throw new Error(`The PDF is larger than ${Math.round(MAX_REPORT_FILE_BYTES / 1048576)} MB`)
  const path = `labs/${LAB_ID}/orders/${orderId}/reportFile/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`
  await uploadBytes(storageRef(storage, path), file, { contentType: 'application/pdf' })
  await setDoc(reportFileDoc(orderId), { name: file.name, path, size: file.size, by, at: serverTimestamp() })
  await updateDoc(docRef(paths.orders, orderId), { hasReportFile: true })
}

export async function removeReportFile(orderId: string) {
  await deleteDoc(reportFileDoc(orderId))
  await updateDoc(docRef(paths.orders, orderId), { hasReportFile: false })
}

// Resolves a stored report file (Storage path, or an older data URL) to something an <object> can show.
export function useReportFileData(file: ReportFileDoc | null | undefined): { name: string; dataUrl: string } | null {
  const [out, setOut] = useState<{ name: string; dataUrl: string } | null>(null)
  const key = file ? `${file.name}|${file.path ?? ''}|${file.dataUrl?.length ?? 0}` : ''
  useEffect(() => {
    let dead = false
    if (!file) {
      setOut(null)
      return
    }
    if (file.dataUrl) {
      setOut({ name: file.name, dataUrl: file.dataUrl })
      return
    }
    if (!file.path) {
      setOut(null)
      return
    }
    getBlob(storageRef(storage, file.path))
      .then(blobToDataUrl)
      .then((u) => !dead && setOut({ name: file.name, dataUrl: u }))
      .catch(() => !dead && setOut(null))
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return out
}
