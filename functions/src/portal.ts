import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { REGION, FIRESTORE_DB } from './secrets'

// Collection-centre portal: pack collected samples into a dispatch manifest. Portal users cannot write bills
// or manifests directly (rules), so this callable does it as the server, in exactly the shape the lab's
// Accession > Manifests screen reads (manifests/{id}, line flags inTransit + manifestId).

const db = () => getFirestore(FIRESTORE_DB)
const LAB_ID_RE = /^[\w-]{1,64}$/

export const portalDispatchManifest = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
  const d = (request.data ?? {}) as { labId?: string; orderIds?: string[]; courier?: string; tubes?: number; temperature?: string; note?: string }
  if (typeof d.labId !== 'string' || !LAB_ID_RE.test(d.labId)) throw new HttpsError('invalid-argument', 'labId is required.')
  const labId = d.labId
  const u = (await db().doc(`labs/${labId}/users/${request.auth.uid}`).get()).data()
  if (!u || u.active !== true || u.role !== 'collectionCentre' || !u.partnerId) throw new HttpsError('permission-denied', 'Only a collection centre login can dispatch a manifest.')
  if ((u.denies ?? []).includes('portal.dispatch')) throw new HttpsError('permission-denied', 'You do not have permission to dispatch samples.')
  const ids = [...new Set(Array.isArray(d.orderIds) ? d.orderIds.filter((x) => typeof x === 'string' && x && !x.includes('/')) : [])].slice(0, 200)
  if (!ids.length) throw new HttpsError('invalid-argument', 'Choose at least one bill.')
  const centre = (await db().doc(`labs/${labId}/collectionCentres/${u.partnerId}`).get()).data()
  if (!centre) throw new HttpsError('not-found', 'Your collection centre was not found.')

  const picks: { id: string; o: DocumentData; lineIds: string[] }[] = []
  for (const id of ids) {
    const o = (await db().doc(`labs/${labId}/orders/${id}`).get()).data()
    if (!o || o.deleted) continue
    if (o.collectionCentreId !== u.partnerId) throw new HttpsError('permission-denied', 'A bill you chose does not belong to your centre.')
    const lineIds = ((o.items ?? []) as DocumentData[])
      .filter((i) => !i.isCharge && !i.onlyBilling && !i.inTransit && (i.status === 'pending' || i.status === 'collected'))
      .map((i) => String(i.lineId))
    if (lineIds.length) picks.push({ id, o, lineIds })
  }
  if (!picks.length) throw new HttpsError('failed-precondition', 'None of these bills has a sample waiting to be sent.')

  const cref = db().doc(`labs/${labId}/counters/manifest`)
  const n = await db().runTransaction(async (tx) => {
    const s = await tx.get(cref)
    const v = ((s.exists ? s.data()?.value : 0) as number) + 1
    tx.set(cref, { value: v })
    return v
  })
  const no = `MF-${String(n).padStart(5, '0')}`
  const lines = picks.map(({ id, o, lineIds }) => ({
    orderId: id, billNo: o.billNo, patientName: o.patientName, barcode: o.barcode ?? '', lineIds,
    samples: ((o.items ?? []) as DocumentData[]).filter((i) => lineIds.includes(String(i.lineId))).map((i) => i.name).join(', '),
  }))
  const mref = await db().collection(`labs/${labId}/manifests`).add({
    branchId: picks[0].o.branchId ?? 'main', no, centreId: u.partnerId, centreName: centre.name ?? '', courier: String(d.courier ?? '').slice(0, 80),
    tubes: Math.max(0, Math.round(Number(d.tubes) || 0)), temperature: String(d.temperature ?? '').slice(0, 40), note: String(d.note ?? '').slice(0, 300), lines,
    status: 'inTransit', createdBy: request.auth.uid, createdByName: String(u.name ?? ''), createdAt: FieldValue.serverTimestamp(), viaPortal: true,
  })
  for (const { id, o, lineIds } of picks) {
    const items = ((o.items ?? []) as DocumentData[]).map((i) =>
      lineIds.includes(String(i.lineId))
        ? { ...i, status: i.status === 'pending' ? 'collected' : i.status, collectedAt: i.collectedAt ?? new Date(), collectedByName: i.collectedByName ?? String(centre.name ?? 'Collection centre'), inTransit: true, manifestId: mref.id }
        : i,
    )
    await db().doc(`labs/${labId}/orders/${id}`).update({ items, ...(o.collectedAt ? {} : { collectedAt: FieldValue.serverTimestamp() }) })
  }
  await db().collection(`labs/${labId}/activity`).add({
    type: 'accession.dispatch', text: `${centre.name ?? 'Collection centre'} dispatched manifest ${no} (${picks.length} bill(s)) from the portal`, refPath: `manifests/${mref.id}`, category: 'OTHER',
    at: FieldValue.serverTimestamp(), by: request.auth.uid, byName: String(u.name ?? ''), branchId: picks[0].o.branchId ?? 'main',
  })
  return { id: mref.id, no, bills: picks.length }
})

async function partnerUser(request: { auth?: { uid: string } | null }, labId: unknown, role: string) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
  if (typeof labId !== 'string' || !LAB_ID_RE.test(labId)) throw new HttpsError('invalid-argument', 'labId is required.')
  const u = (await db().doc(`labs/${labId}/users/${request.auth.uid}`).get()).data()
  if (!u || u.active !== true || u.role !== role || !u.partnerId) throw new HttpsError('permission-denied', 'You do not have permission to do this.')
  return { uid: request.auth.uid, name: String(u.name ?? ''), partnerId: String(u.partnerId), denies: (u.denies ?? []) as string[] }
}

// Collection centre with "Allow bill delete" on may delete (void) its own bill while nothing has been collected and
// no money is on it. The barcode and commission are voided with the bill, as in the lab's own delete.
export const portalVoidBill = onCall({ region: REGION }, async (request) => {
  const d = (request.data ?? {}) as { labId?: string; orderId?: string; reason?: string }
  const me = await partnerUser(request, d.labId, 'collectionCentre')
  const labId = d.labId as string
  const centre = (await db().doc(`labs/${labId}/collectionCentres/${me.partnerId}`).get()).data()
  if (!centre?.allowBillDelete) throw new HttpsError('permission-denied', 'Deleting bills is switched off for your centre.')
  if (typeof d.orderId !== 'string' || !d.orderId || d.orderId.includes('/')) throw new HttpsError('invalid-argument', 'orderId is required.')
  const ref = db().doc(`labs/${labId}/orders/${d.orderId}`)
  const o = (await ref.get()).data()
  if (!o || o.deleted) throw new HttpsError('not-found', 'Bill not found.')
  if (o.collectionCentreId !== me.partnerId) throw new HttpsError('permission-denied', 'This bill does not belong to your centre.')
  const started = ((o.items ?? []) as DocumentData[]).some((i) => i.status !== 'pending' || i.inTransit)
  if (started) throw new HttpsError('failed-precondition', 'A sample on this bill has already been collected or sent. Ask the lab to delete it.')
  if ((Number(o.paid) || 0) > 0) throw new HttpsError('failed-precondition', 'Money is recorded on this bill. Ask the lab to delete it.')
  const reason = String(d.reason ?? '').trim().slice(0, 200) || 'Deleted by collection centre'
  await ref.update({
    deleted: true, voidReason: reason, voidedBy: me.uid, voidedByName: me.name, voidedAt: FieldValue.serverTimestamp(),
    barcodeVoided: true, voidedBarcode: o.barcode ?? '', commissionReversed: true, commissionReversedAt: FieldValue.serverTimestamp(), paid: 0, due: 0,
  })
  await db().collection(`labs/${labId}/activity`).add({
    type: 'billDelete', text: `Bill ${o.billNo} deleted by ${centre.name ?? 'collection centre'} (${me.name}): ${reason}; barcode voided`, refPath: `orders/${d.orderId}`, category: 'DELETE',
    at: FieldValue.serverTimestamp(), by: me.uid, byName: me.name, branchId: o.branchId ?? 'main',
  })
  return { ok: true }
})

// B2B centre with "Barcode edit" on may change the barcode of its own bill before the sample is collected.
export const portalEditBarcode = onCall({ region: REGION }, async (request) => {
  const d = (request.data ?? {}) as { labId?: string; orderId?: string; barcode?: string }
  const me = await partnerUser(request, d.labId, 'b2b')
  const labId = d.labId as string
  const centre = (await db().doc(`labs/${labId}/b2bCentres/${me.partnerId}`).get()).data()
  if (!centre?.settings?.barcodeEdit) throw new HttpsError('permission-denied', 'Barcode editing is switched off for your centre.')
  const code = String(d.barcode ?? '').trim().slice(0, 40)
  if (!code) throw new HttpsError('invalid-argument', 'A barcode cannot be empty.')
  if (typeof d.orderId !== 'string' || !d.orderId || d.orderId.includes('/')) throw new HttpsError('invalid-argument', 'orderId is required.')
  const ref = db().doc(`labs/${labId}/orders/${d.orderId}`)
  const o = (await ref.get()).data()
  if (!o || o.deleted) throw new HttpsError('not-found', 'Bill not found.')
  if (o.b2bCentreId !== me.partnerId) throw new HttpsError('permission-denied', 'This bill does not belong to your centre.')
  if (((o.items ?? []) as DocumentData[]).some((i) => i.status !== 'pending')) throw new HttpsError('failed-precondition', 'The sample has already been collected; the barcode can no longer be changed.')
  if (code === o.barcode) return { ok: true }
  const clash = await db().collection(`labs/${labId}/orders`).where('barcode', '==', code).where('branchId', '==', o.branchId ?? 'main').limit(3).get()
  if (clash.docs.some((x) => x.id !== d.orderId && !x.data().deleted)) throw new HttpsError('already-exists', `Barcode ${code} is already used by another bill.`)
  await ref.update({ barcode: code, barcodeLog: FieldValue.arrayUnion({ from: o.barcode ?? '', to: code, byName: me.name, at: new Date() }) })
  return { ok: true }
})
