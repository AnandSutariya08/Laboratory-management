import { useState } from 'react'
import { App, Upload } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import { addDoc, collection, deleteDoc, doc, orderBy, query, serverTimestamp } from 'firebase/firestore'
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage'
import { Button } from '../../design/Button'
import { db, LAB_ID, storage } from '../../firebase'
import { useLiveQuery } from '../../hooks/useLive'

// Attachments live in Firebase Storage (labs/{lab}/{quotations|bookings}/{id}/...); the quotations/{id}/attachments
// (or bookings/{id}/attachments) sub-collection keeps only the storage path and details. PDF / PNG / JPG, up to
// 15 MB each. Older records kept small data URLs in the document itself: those are still shown.
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
const OK_TYPES = ['application/pdf', 'image/png', 'image/jpeg']

// `file` is set for a not-yet-uploaded attachment (a quotation that has no id yet); `dataUrl` only on old records.
export interface AttachmentDoc { id?: string; name: string; mime: string; size: number; path?: string; dataUrl?: string; file?: File }

const attCol = (qid: string, parent = 'quotations') => collection(db, 'labs', LAB_ID, parent, qid, 'attachments')

export function useQuotationAttachments(quotationId: string | null, parent = 'quotations') {
  return useLiveQuery<AttachmentDoc & { id: string }>(quotationId ? query(attCol(quotationId, parent), orderBy('name')) : null, [quotationId, parent])
}

export async function saveAttachments(quotationId: string, files: AttachmentDoc[], by: string, parent = 'quotations') {
  for (const f of files) {
    if (!f.file) continue
    if (f.file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${f.name} is larger than 15 MB.`)
    const safe = f.name.replace(/[^\w.-]+/g, '_').slice(-80) || 'file'
    const path = `labs/${LAB_ID}/${parent}/${quotationId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}`
    await uploadBytes(storageRef(storage, path), f.file, { contentType: f.mime })
    await addDoc(attCol(quotationId, parent), { name: f.name, mime: f.mime, size: f.size, path, uploadedBy: by, uploadedAt: serverTimestamp() })
  }
}

// Open a stored attachment (storage path) or an old data-URL one.
async function openAttachment(a: AttachmentDoc) {
  const url = a.path ? await getDownloadURL(storageRef(storage, a.path)) : a.dataUrl
  if (url) window.open(url, '_blank', 'noopener')
}

export function QuotationAttachments({
  quotationId, pending, onPending, readOnly, parent = 'quotations',
}: { quotationId: string | null; pending: AttachmentDoc[]; onPending: (f: AttachmentDoc[]) => void; readOnly?: boolean; parent?: 'quotations' | 'bookings' }) {
  const { message } = App.useApp()
  const saved = useQuotationAttachments(quotationId, parent).data
  const [busy, setBusy] = useState(false)
  const total = saved.length + pending.length

  const add = async (file: File) => {
    if (total >= MAX_ATTACHMENTS) { message.error(`At most ${MAX_ATTACHMENTS} attachments.`); return false }
    if (!OK_TYPES.includes(file.type)) { message.error('Attach a PDF, PNG or JPG file.'); return false }
    if (file.size > MAX_ATTACHMENT_BYTES) { message.error('Each attachment must be 15 MB or smaller.'); return false }
    const item: AttachmentDoc = { name: file.name, mime: file.type, size: file.size, file }
    if (quotationId) {
      setBusy(true)
      try {
        await saveAttachments(quotationId, [item], '', parent)
      } catch (e) {
        message.error((e as Error).message)
      } finally {
        setBusy(false)
      }
    } else onPending([...pending, item])
    return false
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div className="bill-row" style={{ marginTop: 0 }}>
        <b>Attachments</b>
        <span className="bill-muted">{total}/{MAX_ATTACHMENTS} · PDF, PNG or JPG, up to 15 MB each</span>
        {!readOnly && (
          <Upload accept="application/pdf,image/png,image/jpeg" showUploadList={false} beforeUpload={(f) => { void add(f); return false }} disabled={busy || total >= MAX_ATTACHMENTS}>
            <Button icon={<UploadOutlined />} disabled={busy || total >= MAX_ATTACHMENTS}>Attach file</Button>
          </Upload>
        )}
      </div>
      {saved.map((a) => (
        <div key={a.id} className="bill-row">
          <a href="#open" onClick={(e) => { e.preventDefault(); void openAttachment(a).catch((err) => message.error((err as Error).message)) }}>{a.name}</a>
          <span className="bill-muted">{a.size > 1024 * 1024 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.ceil(a.size / 1024)} KB`}</span>
          {!readOnly && quotationId && <Button variant="text" aria-label={`Remove attachment ${a.name}`} onClick={() => void deleteDoc(doc(attCol(quotationId, parent), a.id))}>Remove</Button>}
        </div>
      ))}
      {pending.map((a, i) => (
        <div key={`${a.name}-${i}`} className="bill-row">
          <span>{a.name}</span>
          <span className="bill-muted">{Math.ceil(a.size / 1024)} KB, saved with the quotation</span>
          <Button variant="text" aria-label={`Remove attachment ${a.name}`} onClick={() => onPending(pending.filter((_, n) => n !== i))}>Remove</Button>
        </div>
      ))}
    </div>
  )
}
