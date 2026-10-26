import { logActivity } from '../../layout/activity'
import { getDoc, getDocs, query, Timestamp, updateDoc, where, type QueryConstraint } from 'firebase/firestore'
import { col, docRef, labDoc, nextBarcode, paths } from '../../lib/db'
import { createManifest, LABEL_MM, MANIFESTS, type Manifest, type ManifestLine, type SentToLab } from '../../lib/accession'
import { barcodeFor, setItemsStatus } from '../../lib/orders'
import type { AccessionSettings, LabSettings, Order, OrderItem, UserProfile } from '../../types'

// Accession data that lives on the shared Order / OrderItem docs as optional fields.
export interface RejectEntry {
  reason: string
  at: Timestamp
  by: string
}
export type AItem = OrderItem & {
  rejectReason?: string
  rejectRemark?: string
  rejectedAt?: Timestamp
  recollectRequested?: boolean
  recollectCount?: number
  rejectHistory?: RejectEntry[]
  notReceived?: boolean
  notReceivedReason?: string
  notReceivedAt?: Timestamp
  collectedByName?: string
  collectedAt?: Timestamp
  receivedAt?: Timestamp
  receivedByName?: string
  inTransit?: boolean // packed in a collection-centre dispatch manifest, on its way to the lab
  manifestId?: string
  sentToLab?: SentToLab | null // outsourced sample handed to the processing lab
  notReceivedAuto?: boolean // marked Not Received by the daily cut-off sweep
}
export type AOrder = Omit<Order, 'items'> & {
  items: AItem[]
  source?: string
  priority?: string
  collectionCentreId?: string
  collectionCentreName?: string
  b2bCentreId?: string
  b2bCentreName?: string
  collectedPlace?: string
  phlebotomistId?: string
  phlebotomistName?: string
  accessionDate?: Timestamp
  barcodeLog?: { from: string; to: string; byName: string; at: Timestamp }[]
  accessionLog?: { from: Timestamp | null; to: Timestamp; reason: string; byName: string; at: Timestamp }[]
  collectionPhotoFiles?: import('../../lib/accession').PhotoMeta[]
  collectionPhotos?: string[]
}

const log = (user: UserProfile, type: string, text: string, orderId: string) =>
  logActivity(type, text, `${paths.orders}/${orderId}`, { category: 'OTHER', actor: user })

// Write extra per-line fields (and order-level fields) after the status change.
async function patchLines(order: AOrder, ids: string[], linePatch: Partial<AItem>, orderPatch: Record<string, unknown> = {}) {
  await updateDoc(docRef(paths.orders, order.id), {
    ...orderPatch,
    items: order.items.map((i) => (ids.includes(i.lineId) ? { ...i, ...linePatch } : i)),
  })
}
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

// Bills always carry a barcode; when the lab turned auto-generation off one must be typed first.
async function ensureBarcode(order: AOrder, auto: boolean) {
  if (order.barcode) return
  if (!auto) throw new Error('Enter a barcode for this bill before collecting the sample.')
  const settings = (await getDoc(labDoc())).data() as LabSettings | undefined
  const pat = order.patientId ? (await getDoc(docRef(paths.patients, order.patientId))).data() : undefined
  const code = settings?.barcode?.type === 'patient' && order.patientId ? await barcodeFor(settings, { id: order.patientId, barcode: (pat as { barcode?: string } | undefined)?.barcode }) : await nextBarcode()
  await updateDoc(docRef(paths.orders, order.id), { barcode: code })
  order.barcode = code
}

export async function collectLines(
  order: AOrder,
  ids: string[],
  user: UserProfile,
  phlebo?: { id: string; name: string },
  autoBarcode = true,
) {
  if (!ids.length) return
  await ensureBarcode(order, autoBarcode)
  await setItemsStatus(order as unknown as Order, ids, 'collected')
  await patchLines(
    order,
    ids,
    { status: 'collected', notReceived: false, inTransit: false, sentToLab: null, collectedByName: phlebo?.name ?? user.name, collectedAt: Timestamp.now() },
    phlebo ? { phlebotomistId: phlebo.id, phlebotomistName: phlebo.name } : {},
  )
}

export async function receiveLines(
  order: AOrder,
  ids: string[],
  user: UserProfile,
  phlebo?: { id: string; name: string },
  autoBarcode = true,
) {
  if (!ids.length) return
  await ensureBarcode(order, autoBarcode)
  const now = Timestamp.now()
  await setItemsStatus(order as unknown as Order, ids, 'received')
  await patchLines(
    order,
    ids,
    { status: 'received', notReceived: false, inTransit: false, sentToLab: null, receivedAt: now, receivedByName: user.name },
    phlebo ? { phlebotomistId: phlebo.id, phlebotomistName: phlebo.name } : {},
  )
}

// Override the bill barcode: must be unique in the branch, and the change is audited.
export async function changeBarcode(order: AOrder, next: string, user: UserProfile, scope: QueryConstraint[]) {
  const v = next.trim()
  if (!v) throw new Error('A barcode cannot be empty.')
  if (v === order.barcode) return
  const snap = await getDocs(query(col<Order>(paths.orders), ...scope, where('barcode', '==', v)))
  if (snap.docs.some((d) => d.id !== order.id && !d.data().deleted)) throw new Error(`Barcode ${v} is already used by another bill.`)
  await updateDoc(docRef(paths.orders, order.id), {
    barcode: v,
    barcodeLog: [...(order.barcodeLog ?? []), { from: order.barcode, to: v, byName: user.name, at: Timestamp.now() }],
  })
  await log(user, 'accession.barcode', `${order.billNo}: barcode changed from ${order.barcode || '(none)'} to ${v}`, order.id)
}

export async function markNotReceived(order: AOrder, ids: string[], reason: string, user: UserProfile) {
  if (!ids.length) return
  await patchLines(order, ids, clean({ status: 'pending', notReceived: true, inTransit: false, notReceivedReason: reason, notReceivedAt: Timestamp.now() }))
  await log(user, 'accession.notReceived', `${order.billNo}: marked not received${reason ? ` (${reason})` : ''}`, order.id)
}

export async function rejectLines(order: AOrder, ids: string[], reason: string, recollect: boolean, user: UserProfile, remark = '') {
  // A released result must be un-approved before its sample can be rejected.
  const approved = order.items.filter((i) => ids.includes(i.lineId) && i.status === 'approved')
  if (approved.length) throw new Error(`Un-approve ${approved.map((i) => i.name).join(', ')} before rejecting the sample.`)
  const now = Timestamp.now()
  await updateDoc(docRef(paths.orders, order.id), {
    items: order.items.map((i) =>
      ids.includes(i.lineId)
        ? {
            ...i,
            // "Send for recollection" ticked: the sample goes straight back to Sample Collection (same barcode, rejection kept on record).
            status: recollect ? 'pending' : 'rejected',
            rejectReason: reason,
            ...(remark ? { rejectRemark: remark } : {}),
            rejectedAt: now,
            recollectRequested: false,
            ...(recollect ? { recollectCount: (i.recollectCount ?? 0) + 1, notReceived: false } : {}),
            rejectHistory: [...(i.rejectHistory ?? []), { reason, at: now, by: user.name, ...(remark ? { remark } : {}) }],
          }
        : i,
    ),
  })
  await log(user, 'accession.reject', `${order.billNo}: sample rejected (${reason})${remark ? `, ${remark}` : ''}${recollect ? ', sent for recollection' : ''}`, order.id)
}

// Send a rejected line back to Sample Collection for a fresh draw.
export async function requestRecollection(order: AOrder, ids: string[], user: UserProfile) {
  await patchLines(order, ids, {
    status: 'pending',
    recollectRequested: false,
    notReceived: false,
    recollectCount: 1 + Math.max(0, ...order.items.filter((i) => ids.includes(i.lineId)).map((i) => i.recollectCount ?? 0)),
  })
  await log(user, 'accession.recollect', `${order.billNo}: re-collection requested`, order.id)
}

export async function changeAccessionDate(order: AOrder, to: Date, reason: string, user: UserProfile) {
  const entry = {
    from: order.accessionDate ?? order.createdAt ?? null,
    to: Timestamp.fromDate(to),
    reason,
    byName: user.name,
    at: Timestamp.now(),
  }
  await updateDoc(docRef(paths.orders, order.id), {
    accessionDate: entry.to,
    accessionLog: [...(order.accessionLog ?? []), entry],
  })
  await log(user, 'accession.date', `${order.billNo}: accession date changed (${reason})`, order.id)
}

export async function assignPhlebotomist(order: AOrder, phlebo: { id: string; name: string } | null) {
  await updateDoc(docRef(paths.orders, order.id), {
    phlebotomistId: phlebo?.id ?? '',
    phlebotomistName: phlebo?.name ?? '',
  })
}

// Pack collected samples into a dispatch manifest; their lines turn In transit until the lab receives them.
export async function dispatchManifest(
  entries: { order: AOrder; lineIds: string[]; samples: string }[],
  meta: { centreId: string; centreName: string; courier: string; tubes: number; temperature: string; note: string },
  user: UserProfile,
): Promise<{ id: string; no: string }> {
  const lines: ManifestLine[] = entries.map((e) => ({
    orderId: e.order.id,
    billNo: e.order.billNo,
    patientName: e.order.patientName,
    barcode: e.order.barcode,
    lineIds: e.lineIds,
    samples: e.samples,
  }))
  const made = await createManifest(meta, lines, { uid: user.uid, name: user.name })
  const id = made.id
  for (const e of entries) {
    await patchLines(e.order, e.lineIds, { inTransit: true, manifestId: id })
    await log(user, 'accession.dispatch', `${e.order.billNo}: dispatched from ${meta.centreName || 'collection centre'} in manifest`, e.order.id)
  }
  return made
}

// Receive a manifest: scanned bills are received, unscanned ones are marked Not received (when asked) or stay in transit.
export async function receiveManifest(
  m: Manifest,
  receivedOrderIds: string[],
  notReceivedOrderIds: string[],
  user: UserProfile,
  autoBarcode = true,
) {
  const load = async (id: string) => {
    const snap = await getDoc(docRef<Order>(paths.orders, id))
    return snap.exists() ? ({ ...(snap.data() as unknown as AOrder), id: snap.id }) : null
  }
  for (const l of m.lines) {
    const wantRecv = receivedOrderIds.includes(l.orderId)
    const wantNot = notReceivedOrderIds.includes(l.orderId)
    if (!wantRecv && !wantNot) continue
    const o = await load(l.orderId)
    if (!o) continue
    const ids = o.items.filter((i) => l.lineIds.includes(i.lineId) && i.inTransit).map((i) => i.lineId)
    if (!ids.length) continue
    if (wantRecv) await receiveLines(o, ids, user, undefined, autoBarcode)
    else await markNotReceived(o, ids, `Not in manifest ${m.no} on arrival`, user)
  }
  const handled = new Set([...receivedOrderIds, ...notReceivedOrderIds])
  const all = m.lines.every((l) => handled.has(l.orderId))
  await updateDoc(docRef(MANIFESTS, m.id), {
    status: all ? 'received' : 'partial',
    receivedBy: user.uid,
    receivedByName: user.name,
    receivedAt: Date.now(),
    receivedOrderIds: [...new Set([...(m.receivedOrderIds ?? []), ...receivedOrderIds])],
  })
}

// Hand an outsourced sample to its processing lab: the lines show Sent to processing lab until they come back.
export async function sendToProcessingLab(order: AOrder, ids: string[], lab: { labId: string; labName: string }, user: UserProfile) {
  if (!ids.length) return
  const entry: SentToLab = { labId: lab.labId, labName: lab.labName, at: Date.now(), by: user.uid, byName: user.name }
  await patchLines(order, ids, { sentToLab: entry })
  await log(user, 'accession.sentOut', `${order.billNo}: sample sent to processing lab ${lab.labName}`, order.id)
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

// One label per bill, or one per sample type when barcodes are per sample.
export function printLabels(
  entries: { order: AOrder; samples: { name: string; barcode: string }[] }[],
  size: AccessionSettings['labelSize'] = '50x25',
) {
  const w = window.open('', '_blank', 'width=420,height=320')
  if (!w) return false
  const mm = LABEL_MM[size] ?? LABEL_MM['50x25']
  const pages = entries
    .flatMap(({ order, samples }) =>
      samples.length ? samples.map((sm) => ({ order, name: sm.name, barcode: sm.barcode })) : [{ order, name: '', barcode: order.barcode }],
    )
    .map(
      ({ order, name, barcode }) => `<div class="p"><div class="n">${esc(order.patientName)}</div>
<div class="s">Bill: ${esc(order.billNo)}</div>
<div class="b">${esc(barcode || '-')}</div>
<div class="s">${esc(name)}</div></div>`,
    )
    .join('')
  w.document.write(`<html><head><title>Labels</title>
<style>@page{size:${mm.w}mm ${mm.h}mm;margin:2mm}body{font-family:Arial,sans-serif;margin:0}.p{padding:4px;page-break-after:always}
.n{font-size:${Math.round(mm.font * 0.5)}px;font-weight:700}.b{font-family:'Courier New',monospace;font-size:${mm.font}px;font-weight:700;letter-spacing:3px;margin:4px 0}
.s{font-size:${Math.round(mm.font * 0.4)}px}</style></head><body>${pages}
<script>window.onload=function(){window.print();}</script></body></html>`)
  w.document.close()
  return true
}
