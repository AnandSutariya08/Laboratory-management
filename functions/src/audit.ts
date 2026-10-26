import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { db, REGION } from './ai/common'
import { FIRESTORE_DB } from './secrets'

// Append-only audit log. Every activity event (bill create / void / refund, result actions, user and
// settings changes...) is copied to labs/{lab}/auditLog with actor role, category and optional
// before / after / reason. Clients cannot write or delete auditLog (see firestore.rules): entries
// are retained indefinitely (the policy is >= 5 years; nothing here ever deletes).
export const AUDIT_CATEGORIES = ['LOGIN', 'BILLING', 'RESULT', 'VERIFY', 'DISCOUNT', 'DELETE', 'REFUND', 'SETTINGS', 'QC', 'EXPORT', 'ADMIN_ACCESS', 'OTHER'] as const

export function categoryOf(type: string, text: string, explicit?: unknown): string {
  if (typeof explicit === 'string' && (AUDIT_CATEGORIES as readonly string[]).includes(explicit)) return explicit
  const t = `${type} ${text}`.toLowerCase()
  if (/login|sign-?in/.test(t)) return 'LOGIN'
  if (/refund/.test(t)) return 'REFUND'
  if (/void|delete|deleted/.test(t)) return 'DELETE'
  if (/discount/.test(t)) return 'DISCOUNT'
  if (/approv|verif/.test(t)) return 'VERIFY'
  if (/result|sample|reject/.test(t)) return 'RESULT'
  if (/setting|profile|template/.test(t)) return 'SETTINGS'
  if (/\bqc\b|eqas|ilc|capa/.test(t)) return 'QC'
  if (/export|download/.test(t)) return 'EXPORT'
  if (/support access|impersonat/.test(t)) return 'ADMIN_ACCESS'
  if (/^user|user |role|branch/.test(t)) return 'SETTINGS'
  if (/bill|payment|due|quotation|patient/.test(t)) return 'BILLING'
  return 'OTHER'
}

export const mirrorActivityToAudit = onDocumentCreated({ document: 'labs/{labId}/activity/{id}', database: FIRESTORE_DB, region: REGION }, async (event) => {
  const d = event.data?.data() as Record<string, unknown> | undefined
  if (!d) return
  const { labId, id } = event.params
  const by = typeof d.by === 'string' ? d.by : ''
  const actor = by ? ((await db().doc(`labs/${labId}/users/${by}`).get()).data() as { role?: string } | undefined) : undefined
  await db().doc(`labs/${labId}/auditLog/${id}`).set({
    category: categoryOf(String(d.type ?? ''), String(d.text ?? ''), d.category),
    type: d.type ?? '',
    text: d.text ?? '',
    entity: d.refPath ?? '',
    before: d.before ?? null,
    after: d.after ?? null,
    reason: d.reason ?? '',
    by,
    byName: d.byName ?? '',
    role: actor?.role ?? '',
    branchId: d.branchId ?? 'main',
    at: d.at ?? FieldValue.serverTimestamp(),
    ip: '', // not available to a Firestore trigger; the HTTP-level audit of sign-ins lives in Firebase Auth logs
  })
})
