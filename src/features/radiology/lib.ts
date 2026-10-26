import { ref as storageRef, uploadBytes } from 'firebase/storage'
import { isRadiologyTest } from '../../pages/catalogue/behaviour'
import { LAB_ID, storage } from '../../firebase'
import type { Test } from '../../types'
import type { RadImage } from './types'

export const MODALITIES = ['X-Ray', 'USG', 'CT', 'MRI', 'ECG', 'Echo', 'Mammography', 'Other'] as const

const RULES: [RegExp, string][] = [
  [/mammo/i, 'Mammography'],
  [/\b(x-?ray|radiograph)\b/i, 'X-Ray'],
  [/\b(usg|ultrasound|sonograph|sonography)\b/i, 'USG'],
  [/\b(cect|hrct|computed tomography)\b|\bct\s+(scan|head|brain|chest|abdomen|thorax|angio|spine|kub)/i, 'CT'],
  [/\b(mri|mra)\b/i, 'MRI'],
  [/\b(ecg|ekg|electrocardio)/i, 'ECG'],
  [/\b(echo|2d echo|echocardio)/i, 'Echo'],
]

// '' for non-radiology tests. A `modality` field on the test wins; then department, name and code.
export function modalityOf(test: Test | undefined, departmentName = '', list?: { code: string; label: string }[]): string {
  if (!test) return ''
  const explicit = (test as unknown as { modality?: unknown }).modality
  if (typeof explicit === 'string' && explicit.trim()) {
    const e = explicit.trim()
    // A configured DICOM code (US, CR...) maps to its label; anything else is kept as typed.
    return list?.find((x) => x.code.toLowerCase() === e.toLowerCase() || x.label.toLowerCase() === e.toLowerCase())?.label ?? e
  }
  const hay = [test.name, test.code]
  for (const [re, m] of RULES) if (hay.some((h) => re.test(h ?? ''))) return m
  if (/radiolog|imaging|scan/i.test(departmentName)) {
    for (const [re, m] of RULES) if (re.test(departmentName)) return m
    return 'Other'
  }
  for (const [re, m] of RULES) if (re.test(departmentName)) return m
  // A test the catalogue marks as radiology stays on the radiology worklist even when no modality can be inferred.
  return isRadiologyTest(test as never) ? 'Other' : ''
}

export const MAX_IMAGES = 12
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024
export const dataUrlBytes = (u: string) => Math.round((u.length - (u.indexOf(',') + 1)) * 0.75)

export function dataUrlToBlob(u: string): Blob {
  const [head, b64] = u.split(',')
  const type = /data:([^;]+)/.exec(head)?.[1] ?? 'image/jpeg'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

// Key images go to Firebase Storage (labs/{lab}/radiology/{order}/{test}/...); the report keeps only the path.
export async function uploadKeyImages(orderId: string, testId: string, images: RadImage[]): Promise<RadImage[]> {
  const out: RadImage[] = []
  for (const im of images) {
    if (im.path || !im.dataUrl) {
      out.push(im)
      continue
    }
    const blob = dataUrlToBlob(im.dataUrl)
    const path = `labs/${LAB_ID}/radiology/${orderId}/${testId}/${im.id}.jpg`
    await uploadBytes(storageRef(storage, path), blob, { contentType: blob.type || 'image/jpeg' })
    out.push({ id: im.id, name: im.name, path, contentType: blob.type || 'image/jpeg', caption: im.caption ?? '', size: blob.size })
  }
  return out
}

// Resize to <= 1280 px and re-encode as JPEG until the image fits the per-image budget.
export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error(`${file.name} is not an image`))
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * scale)
      c.height = Math.round(img.height * scale)
      const ctx = c.getContext('2d')
      if (!ctx) return reject(new Error('Image processing is not available'))
      ctx.drawImage(img, 0, 0, c.width, c.height)
      for (const q of [0.85, 0.72, 0.55, 0.4]) {
        const out = c.toDataURL('image/jpeg', q)
        if (dataUrlBytes(out) <= MAX_IMAGE_BYTES) return resolve(out)
      }
      reject(new Error(`${file.name} is still larger than ${Math.round(MAX_IMAGE_BYTES / 1048576)} MB after compression`))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`Could not read ${file.name}`))
    }
    img.src = url
  })
}

export const MACROS: { label: string; text: string }[] = [
  { label: 'Patient name', text: '{{patientName}}' },
  { label: 'Age', text: '{{age}}' },
  { label: 'Gender', text: '{{gender}}' },
  { label: 'Date', text: '{{date}}' },
  { label: 'Normal study', text: 'No acute abnormality is seen.' },
  { label: 'No effusion', text: 'No pleural or pericardial effusion.' },
  { label: 'Clinical correlation', text: 'Clinical correlation is suggested.' },
  { label: 'Follow-up', text: 'Follow-up imaging is advised if symptoms persist.' },
]

export function fillTokens(text: string, v: { patientName: string; age: string; gender: string; date: string }): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in v ? v[k as keyof typeof v] : m))
}

// Template text may be HTML: token values are escaped before substitution.
export function fillTokensHtml(text: string, v: { patientName: string; age: string; gender: string; date: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in v ? esc(v[k as keyof typeof v]) : m))
}

// Turnaround targets per modality, in hours.
export const TAT_HOURS: Record<string, number> = { 'X-Ray': 2, USG: 4, CT: 6, MRI: 24 }
export const tatHoursOf = (modality: string) => TAT_HOURS[modality] ?? 24

// Only https viewer links; no scripts, no credentials in the URL.
export function validDicomUrl(raw: string): { ok: boolean; url?: string; warn?: string } {
  const s = raw.trim()
  if (!s) return { ok: false }
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:') return { ok: false }
    const warn = /token|key|auth|secret|password|sig/i.test(u.search) || u.username || u.password ? 'The link seems to carry a token or credentials. Do not put secrets in the viewer link.' : undefined
    return { ok: true, url: u.toString(), warn }
  } catch {
    return { ok: false }
  }
}
