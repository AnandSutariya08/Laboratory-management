import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore'
import { getBlob, getBytes, ref as storageRef } from 'firebase/storage'
import { db, LAB_ID, storage } from '../../firebase'
import { createReportSnapshotNow } from '../../lib/messaging'
import type { ReportPayload } from './payload'

// Stored report versions (RP-31, X-04): the server freezes each issued version as a JSON payload and a PDF file
// in Storage (labs/{lab}/orders/{order}/snapshots), hashed with sha256. Issued reports render from that payload.
export interface ReportSnapshot {
  id: string
  revision: number
  sha256: string
  html: string
  bytes: number
  status: string
  trigger: string
  billNo: string
  pdfPath?: string
  pdfBytes?: number
  modelPath?: string
  createdAt: { toDate(): Date } | null
}

export const snapshotsCol = (orderId: string) => collection(db, 'labs', LAB_ID, 'orders', orderId, 'reportSnapshots')

export async function latestSnapshot(orderId: string): Promise<ReportSnapshot | null> {
  const s = await getDocs(query(snapshotsCol(orderId), orderBy('createdAt', 'desc'), limit(1)))
  return s.empty ? null : ({ ...(s.docs[0].data() as object), id: s.docs[0].id } as ReportSnapshot)
}

// Makes sure the snapshot reflects the current approved results, then returns it.
export async function ensureSnapshot(orderId: string): Promise<ReportSnapshot> {
  await createReportSnapshotNow(orderId)
  const snap = await latestSnapshot(orderId)
  if (!snap) throw new Error('The report copy could not be created.')
  return snap
}

// The frozen report payload of a snapshot (null when the version predates stored payloads).
export async function loadSnapshotPayload(sn: Pick<ReportSnapshot, 'modelPath'>): Promise<ReportPayload | null> {
  if (!sn.modelPath) return null
  const buf = await getBytes(storageRef(storage, sn.modelPath))
  return JSON.parse(new TextDecoder().decode(buf)) as ReportPayload
}

export function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function downloadHtml(filename: string, html: string) {
  saveBlob(filename, new Blob([html], { type: 'text/html;charset=utf-8' }))
}

// Downloads the stored PDF file of a snapshot.
export async function downloadSnapshotPdf(billNo: string, sn: ReportSnapshot) {
  if (!sn.pdfPath) throw new Error('This version has no PDF file; create a new stored copy.')
  saveBlob(`report-${billNo}-r${sn.revision}.pdf`, await getBlob(storageRef(storage, sn.pdfPath)))
}

// Bulk download: one stored PDF per bill.
export async function bulkDownloadReports(orders: { id: string; billNo: string }[], onProgress?: (done: number) => void): Promise<{ ok: number; failed: string[] }> {
  let ok = 0
  const failed: string[] = []
  for (const [i, o] of orders.entries()) {
    try {
      const s = await ensureSnapshot(o.id)
      if (s.pdfPath) await downloadSnapshotPdf(o.billNo, s)
      else downloadHtml(`report-${o.billNo}-r${s.revision}.html`, s.html)
      ok++
    } catch {
      failed.push(o.billNo)
    }
    onProgress?.(i + 1)
  }
  return { ok, failed }
}
