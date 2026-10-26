import {
  addDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  type Timestamp,
} from 'firebase/firestore'
import dayjs from 'dayjs'
import { db } from '../../../firebase'
import { col, docRef, labDoc, nextCounter } from '../../../lib/db'
import { isBillingOnly, isOutsourced } from '../../outsource/lib'
import type { Order, Paise } from '../../../types'
import type {
  InventoryItem,
  MovementType,
  POLine,
  PurchaseOrder,
  StockBatch,
  StockMapping,
  StockMovement,
  Supplier,
} from '../types'
import { activeBranchId, branchCounterName, branchStamp, getActiveBranch, MAIN_BRANCH_ID } from '../../../lib/activeBranch'

export const INV = {
  items: 'invItems',
  suppliers: 'invSuppliers',
  batches: 'invBatches',
  pos: 'purchaseOrders',
  mappings: 'stockMappings',
  movements: 'stockMovements',
} as const

export const EXPIRY_WARN_DAYS = 30

const r4 = (n: number) => Math.round(n * 10000) / 10000
export const todayStr = () => dayjs().format('YYYY-MM-DD')
export const daysToExpiry = (expiry: string) => dayjs(expiry).diff(dayjs().startOf('day'), 'day')
export const isExpired = (b: Pick<StockBatch, 'expiry'>) => b.expiry < todayStr()
export const tsDate = (t: Timestamp | null | undefined): Date => (t ? t.toDate() : new Date())

// ---- Derived stock views -------------------------------------------------------

export interface ItemStock {
  qty: number // sellable: non-expired remaining
  expiredQty: number // expired but still on the shelf (awaiting write-off)
  batches: StockBatch[] // with qty remaining, FEFO order
}

export const fefoSort = (a: StockBatch, b: StockBatch) =>
  a.expiry.localeCompare(b.expiry) || (a.receivedAt?.toMillis() ?? 0) - (b.receivedAt?.toMillis() ?? 0)

export function stockLevels(items: InventoryItem[], batches: StockBatch[]): Map<string, ItemStock> {
  const m = new Map<string, ItemStock>()
  for (const it of items) m.set(it.id, { qty: 0, expiredQty: 0, batches: [] })
  for (const b of batches) {
    if (b.qtyRemaining <= 0) continue
    const s = m.get(b.itemId)
    if (!s) continue
    s.batches.push(b)
    if (isExpired(b)) s.expiredQty = r4(s.expiredQty + b.qtyRemaining)
    else s.qty = r4(s.qty + b.qtyRemaining)
  }
  for (const s of m.values()) s.batches.sort(fefoSort)
  return m
}

// Items at or below their reorder level (an item with no reorder level is never "low").
export function lowStockItems(items: InventoryItem[], levels: Map<string, ItemStock>) {
  return items.filter((i) => i.active && i.reorderLevel > 0 && (levels.get(i.id)?.qty ?? 0) <= i.reorderLevel)
}

// Non-expired batches that expire within `days` days.
export function expiringSoon(batches: StockBatch[], days = EXPIRY_WARN_DAYS) {
  return batches
    .filter((b) => b.qtyRemaining > 0 && !isExpired(b) && daysToExpiry(b.expiry) <= days)
    .sort(fefoSort)
}

export const expiredBatches = (batches: StockBatch[]) =>
  batches.filter((b) => b.qtyRemaining > 0 && isExpired(b)).sort(fefoSort)

// ---- Movements -----------------------------------------------------------------

interface MovementInput {
  itemId: string
  batchId?: string
  type: MovementType
  qty: number
  unitCost?: Paise
  reason?: string
  shortfall?: number
  orderId?: string
  testId?: string
  poId?: string
  by: string
}

function movementDoc(m: MovementInput): Omit<StockMovement, 'id'> {
  return {
    ...branchStamp(),
    itemId: m.itemId,
    batchId: m.batchId ?? '',
    type: m.type,
    qty: m.qty,
    unitCost: m.unitCost ?? 0,
    reason: m.reason ?? '',
    shortfall: m.shortfall ?? 0,
    orderId: m.orderId ?? '',
    testId: m.testId ?? '',
    poId: m.poId ?? '',
    by: m.by,
    at: serverTimestamp() as Timestamp,
  }
}

const newMovementRef = () => doc(col(INV.movements))

// ---- FEFO consumption ----------------------------------------------------------

export interface ConsumeCtx {
  type: 'consume_auto' | 'consume_manual'
  by: string
  orderId?: string
  testId?: string
  batchId?: string // consume from one specific lot instead of FEFO
}

export interface ConsumeResult {
  consumed: number
  shortfall: number
}

// Consume `qty` of an item from the earliest-expiring non-expired batches that still
// have stock. Quantities never go below zero: anything that cannot be covered is
// returned as `shortfall` and recorded as a zero-quantity movement for follow-up.
export async function consumeFefo(
  itemId: string,
  qty: number,
  reason: string,
  ctx: ConsumeCtx,
): Promise<ConsumeResult> {
  if (!(qty > 0)) return { consumed: 0, shortfall: 0 }
  const snap = await getDocs(query(col<StockBatch>(INV.batches), where('branchId', '==', activeBranchId()), where('itemId', '==', itemId)))
  const today = todayStr()
  const candidates = snap.docs
    .map((d) => ({ ...d.data(), id: d.id }) as StockBatch)
    .filter((b) => b.qtyRemaining > 0 && b.expiry >= today && (!ctx.batchId || b.id === ctx.batchId))
    .sort(fefoSort)

  return runTransaction(db, async (tx) => {
    // Re-read inside the transaction so concurrent consumers cannot double-spend a batch.
    const fresh: StockBatch[] = []
    for (const c of candidates) {
      const s = await tx.get(docRef<StockBatch>(INV.batches, c.id))
      if (s.exists()) fresh.push({ ...s.data(), id: s.id })
    }
    let need = qty
    for (const b of fresh) {
      if (need <= 0) break
      if (b.qtyRemaining <= 0) continue
      const take = Math.min(b.qtyRemaining, need)
      tx.update(docRef(INV.batches, b.id), { qtyRemaining: r4(b.qtyRemaining - take) })
      tx.set(
        newMovementRef(),
        movementDoc({
          itemId,
          batchId: b.id,
          type: ctx.type,
          qty: -r4(take),
          unitCost: b.unitCost,
          reason,
          orderId: ctx.orderId,
          testId: ctx.testId,
          by: ctx.by,
        }),
      )
      need = r4(need - take)
    }
    if (need > 0) {
      tx.set(
        newMovementRef(),
        movementDoc({
          itemId,
          type: ctx.type,
          qty: 0,
          reason: `Stock shortfall of ${need}: ${reason}`,
          shortfall: need,
          orderId: ctx.orderId,
          testId: ctx.testId,
          by: ctx.by,
        }),
      )
    }
    return { consumed: r4(qty - need), shortfall: need }
  })
}

// ---- When to consume (Lab settings > Inventory > consumeOn) ---------------------

export type ConsumeTrigger = 'billing' | 'receipt'
let consumeOnCache: { at: number; v: ConsumeTrigger } | null = null

// The configured trigger ('receipt' unless the lab chose 'billing'). Cached for 30 s.
export async function configuredConsumeOn(): Promise<ConsumeTrigger> {
  if (consumeOnCache && Date.now() - consumeOnCache.at < 30000) return consumeOnCache.v
  let v: ConsumeTrigger = 'receipt'
  try {
    const snap = await getDoc(labDoc())
    if ((snap.data() as { inventory?: { consumeOn?: string } } | undefined)?.inventory?.consumeOn === 'billing') v = 'billing'
  } catch {
    /* keep the default */
  }
  consumeOnCache = { at: Date.now(), v }
  return v
}

// Tests that never use stock: outsourced to another lab, or billing-only services.
export const skipsStock = (testId: string) => isOutsourced(testId) || isBillingOnly(testId)

// Auto-consumption: for every test, consume each mapped item (qtyPerTest) FEFO. A test on
// two lines counts twice. `trigger` says which event is calling; the call does nothing when
// the lab configured the other trigger, so BOTH call sites (bill created, sample received)
// can call it unconditionally:
//   billing  -> autoConsumeForTests(order, testIds, by, 'billing')   after the bill is saved
//   receipt  -> autoConsumeForTests(order, testIds, by, 'receipt')   (default, existing call)
// Outsourced and billing-only tests are skipped.
export async function autoConsumeForTests(
  order: Pick<Order, 'id' | 'billNo'>,
  testIds: string[],
  by: string,
  trigger: ConsumeTrigger = 'receipt',
): Promise<ConsumeResult[]> {
  const receivedTestIds = testIds.filter((t) => !skipsStock(t))
  if (receivedTestIds.length === 0) return []
  if ((await configuredConsumeOn()) !== trigger) return []
  const counts = new Map<string, number>()
  for (const t of receivedTestIds) counts.set(t, (counts.get(t) ?? 0) + 1)
  const ids = [...counts.keys()]
  const mappings: StockMapping[] = []
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await getDocs(query(col<StockMapping>(INV.mappings), where('testId', 'in', ids.slice(i, i + 30))))
    snap.docs.forEach((d) => mappings.push({ ...d.data(), id: d.id }))
  }
  const results: ConsumeResult[] = []
  for (const m of mappings) {
    const qty = m.qtyPerTest * (counts.get(m.testId) ?? 1)
    results.push(
      await consumeFefo(m.itemId, qty, `Auto-consumed for bill ${order.billNo}`, {
        type: 'consume_auto',
        by,
        orderId: order.id,
        testId: m.testId,
      }),
    )
  }
  return results
}

// Reversal on refund or void: puts back what auto-consumption took for this bill (all of it,
// or only for `testIds` on a partial refund) into the lots it came from, and records a
// 'return' movement per lot. Safe to call twice: only the net un-returned quantity is restored.
// Call after a refund (with the refunded lines' testIds) or a void (no testIds).
export async function reverseConsumptionForOrder(
  order: Pick<Order, 'id' | 'billNo'>,
  by: string,
  testIds?: string[],
): Promise<number> {
  const snap = await getDocs(
    query(
      col<StockMovement>(INV.movements),
      where('branchId', '==', activeBranchId()),
      where('orderId', '==', order.id),
      where('type', 'in', ['consume_auto', 'return']),
    ),
  )
  const only = testIds ? new Set(testIds) : null
  // net consumed per (batch, test): consumption is negative, returns positive.
  const net = new Map<string, { batchId: string; itemId: string; testId: string; qty: number }>()
  for (const d of snap.docs) {
    const m = d.data()
    if (!m.batchId) continue
    if (only && !only.has(m.testId)) continue
    const k = `${m.batchId}|${m.testId}`
    const cur = net.get(k) ?? { batchId: m.batchId, itemId: m.itemId, testId: m.testId, qty: 0 }
    cur.qty += m.qty
    net.set(k, cur)
  }
  let restored = 0
  for (const n of net.values()) {
    const back = r4(-n.qty)
    if (back <= 0) continue
    await runTransaction(db, async (tx) => {
      const ref = docRef<StockBatch>(INV.batches, n.batchId)
      const s = await tx.get(ref)
      if (!s.exists()) return
      tx.update(ref, { qtyRemaining: r4(s.data().qtyRemaining + back) })
      tx.set(
        newMovementRef(),
        movementDoc({ itemId: n.itemId, batchId: n.batchId, type: 'return', qty: back, unitCost: s.data().unitCost, reason: `Restored: bill ${order.billNo} refunded or voided`, orderId: order.id, testId: n.testId, by }),
      )
    })
    restored += back
  }
  return restored
}

// ---- Adjustments and expiry ----------------------------------------------------

export async function adjustStock(batchId: string, delta: number, reason: string, by: string) {
  await runTransaction(db, async (tx) => {
    const ref = docRef<StockBatch>(INV.batches, batchId)
    const s = await tx.get(ref)
    if (!s.exists()) throw new Error('Batch not found')
    const b = s.data()
    const next = r4(b.qtyRemaining + delta)
    if (next < 0) throw new Error(`Only ${b.qtyRemaining} left in this lot`)
    tx.update(ref, { qtyRemaining: next })
    tx.set(
      newMovementRef(),
      movementDoc({ itemId: b.itemId, batchId, type: 'adjust', qty: r4(delta), unitCost: b.unitCost, reason, by }),
    )
  })
}

// Write off what is left of a batch as expired.
export async function markExpired(batchId: string, by: string, reason = 'Expired - written off') {
  await runTransaction(db, async (tx) => {
    const ref = docRef<StockBatch>(INV.batches, batchId)
    const s = await tx.get(ref)
    if (!s.exists()) throw new Error('Batch not found')
    const b = s.data()
    if (b.qtyRemaining <= 0) return
    tx.update(ref, { qtyRemaining: 0 })
    tx.set(
      newMovementRef(),
      movementDoc({ itemId: b.itemId, batchId, type: 'expire', qty: -b.qtyRemaining, unitCost: b.unitCost, reason, by }),
    )
  })
}

// ---- Purchase orders -----------------------------------------------------------

// Line amount including its GST.
export const lineAmount = (l: Pick<POLine, 'qty' | 'unitCost'> & { taxPercent?: number }): Paise => Math.round(l.qty * l.unitCost * (1 + (l.taxPercent ?? 0) / 100))
export const poTotal = (lines: (Pick<POLine, 'qty' | 'unitCost'> & { taxPercent?: number })[]): Paise =>
  lines.reduce((s, l) => s + lineAmount(l), 0)

// Supplier choices for an item, preferred first (falls back to the default supplier).
export function itemSuppliers(item: InventoryItem): { supplierId: string; price: Paise }[] {
  const list = item.suppliers?.filter((s) => s.supplierId) ?? []
  if (list.length) return list
  return item.defaultSupplierId ? [{ supplierId: item.defaultSupplierId, price: item.lastPrice }] : []
}

// The lot FEFO consumption will use next: earliest-expiring non-expired lot with stock.
export const nextLot = (batches: StockBatch[]): StockBatch | undefined => [...batches].filter((b) => b.qtyRemaining > 0 && !isExpired(b)).sort(fefoSort)[0]

// Correct a lot's number, expiry or location. Quantities change only through movements; this logs a zero-quantity
// 'adjust' row saying what was edited.
export async function editBatch(batchId: string, patch: { lotNo: string; expiry: string; location: string }, by: string) {
  if (!patch.lotNo.trim()) throw new Error('Lot number is required')
  if (!patch.expiry) throw new Error('Expiry date is required')
  await runTransaction(db, async (tx) => {
    const ref = docRef<StockBatch>(INV.batches, batchId)
    const s = await tx.get(ref)
    if (!s.exists()) throw new Error('Batch not found')
    const b = s.data()
    const notes: string[] = []
    if (b.lotNo !== patch.lotNo.trim()) notes.push(`lot ${b.lotNo} to ${patch.lotNo.trim()}`)
    if (b.expiry !== patch.expiry) notes.push(`expiry ${b.expiry} to ${patch.expiry}`)
    if ((b.location ?? '') !== patch.location) notes.push(`location ${b.location || '-'} to ${patch.location || '-'}`)
    if (!notes.length) return
    tx.update(ref, { lotNo: patch.lotNo.trim(), expiry: patch.expiry, location: patch.location })
    tx.set(newMovementRef(), movementDoc({ itemId: b.itemId, batchId, type: 'adjust', qty: 0, unitCost: b.unitCost, reason: `Lot edited: ${notes.join('; ')}`, by }))
  })
}

// Remove a lot: its remaining stock is written off (a movement keeps the history) and the lot is marked deleted.
export async function deleteBatch(batchId: string, reason: string, by: string) {
  if (!reason.trim()) throw new Error('Enter a reason for removing the lot')
  await runTransaction(db, async (tx) => {
    const ref = docRef<StockBatch>(INV.batches, batchId)
    const s = await tx.get(ref)
    if (!s.exists()) throw new Error('Batch not found')
    const b = s.data()
    tx.update(ref, { qtyRemaining: 0, deleted: true })
    tx.set(newMovementRef(), movementDoc({ itemId: b.itemId, batchId, type: 'adjust', qty: -b.qtyRemaining, unitCost: b.unitCost, reason: `Lot ${b.lotNo} removed: ${reason.trim()}`, by }))
  })
}

export async function createPurchaseOrder(
  supplierId: string,
  lines: { itemId: string; qty: number; unitCost: Paise; taxPercent?: number }[],
  notes: string,
  by: string,
): Promise<string> {
  const b = getActiveBranch()
  const seq = await nextCounter(branchCounterName('po', b.id))
  const poNo = b.id === MAIN_BRANCH_ID ? `PO${seq}` : `PO-${b.code}-${seq}`
  const full: POLine[] = lines.map((l) => ({ ...l, receivedQty: 0, ...(l.taxPercent ? { taxPercent: l.taxPercent } : { taxPercent: undefined }) })).map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)) as unknown as POLine)
  const po: Omit<PurchaseOrder, 'id'> = {
    ...branchStamp(),
    poNo,
    supplierId,
    lines: full,
    status: 'draft',
    total: poTotal(full),
    notes,
    createdBy: by,
    createdAt: serverTimestamp() as Timestamp,
    orderedAt: null,
    receivedAt: null,
  }
  return (await addDoc(col(INV.pos), po)).id
}

export const updatePOLines = (po: PurchaseOrder, lines: POLine[]) =>
  updateDoc(docRef(INV.pos, po.id), { lines, total: poTotal(lines) })

export const markOrdered = (poId: string) =>
  updateDoc(docRef(INV.pos, poId), { status: 'ordered', orderedAt: serverTimestamp() })

export const cancelPO = (poId: string) => updateDoc(docRef(INV.pos, poId), { status: 'cancelled' })

// Accept a partially received PO as complete (supplier will not ship the rest).
export const closeShort = (poId: string) =>
  updateDoc(docRef(INV.pos, poId), { status: 'received', receivedAt: serverTimestamp() })

export interface ReceiptLine {
  lineIndex: number
  qty: number
  lotNo: string
  expiry: string // YYYY-MM-DD
  unitCost: Paise
  location: string
}

// Receive goods against a PO: one batch per line (merged into an existing batch with
// the same item + lot + expiry), a `receive` movement each, and the PO status moves
// to partially_received or received. All in one transaction.
export async function receiveAgainstPO(poId: string, receipts: ReceiptLine[], by: string) {
  const lines = receipts.filter((r) => r.qty > 0)
  if (lines.length === 0) throw new Error('Enter a received quantity for at least one line')
  for (const r of lines) {
    if (!r.lotNo.trim()) throw new Error('Lot number is required')
    if (!r.expiry) throw new Error('Expiry date is required')
  }
  // Pre-fetch candidate batches so same-lot receipts can be merged.
  const poPre = (await getDoc(docRef<PurchaseOrder>(INV.pos, poId))).data()
  if (!poPre) throw new Error('Purchase order not found')
  const preItemIds = [...new Set(lines.map((r) => poPre.lines[r.lineIndex]?.itemId).filter(Boolean))] as string[]
  const existing: StockBatch[] = []
  for (let i = 0; i < preItemIds.length; i += 30) {
    const s = await getDocs(query(col<StockBatch>(INV.batches), where('branchId', '==', activeBranchId()), where('itemId', 'in', preItemIds.slice(i, i + 30))))
    s.docs.forEach((d) => existing.push({ ...d.data(), id: d.id }))
  }

  await runTransaction(db, async (tx) => {
    const poRef = docRef<PurchaseOrder>(INV.pos, poId)
    const ps = await tx.get(poRef)
    const po = ps.exists() ? ps.data() : null
    if (!po) throw new Error('Purchase order not found')
    if (po.status !== 'ordered' && po.status !== 'partially_received') {
      throw new Error('Only ordered purchase orders can be received')
    }
    const supRef = docRef<Supplier>(INV.suppliers, po.supplierId)
    const sup = await tx.get(supRef)

    // Reads first: any batch we will merge into.
    const merges = new Map<number, StockBatch>()
    for (const r of lines) {
      const itemId = po.lines[r.lineIndex].itemId
      const same = existing.find((b) => b.itemId === itemId && b.lotNo === r.lotNo.trim())
      if (!same) continue
      if (same.expiry !== r.expiry) {
        throw new Error(`Lot ${r.lotNo} of this item already exists with expiry ${same.expiry}`)
      }
      const fresh = await tx.get(docRef<StockBatch>(INV.batches, same.id))
      if (fresh.exists()) merges.set(r.lineIndex, { ...fresh.data(), id: fresh.id })
    }

    const newLines = po.lines.map((l) => ({ ...l }))
    const supplied = sup.exists() ? [...(sup.data().itemsSupplied ?? [])] : null
    for (const r of lines) {
      const line = newLines[r.lineIndex]
      const itemId = line.itemId
      const merged = merges.get(r.lineIndex)
      let batchId: string
      if (merged) {
        batchId = merged.id
        tx.update(docRef(INV.batches, merged.id), {
          receivedQty: r4(merged.receivedQty + r.qty),
          qtyRemaining: r4(merged.qtyRemaining + r.qty),
        })
      } else {
        const ref = doc(col(INV.batches))
        batchId = ref.id
        const batch: Omit<StockBatch, 'id'> = {
          ...branchStamp(),
          itemId,
          lotNo: r.lotNo.trim(),
          expiry: r.expiry,
          receivedQty: r.qty,
          qtyRemaining: r.qty,
          unitCost: r.unitCost,
          receivedAt: serverTimestamp() as Timestamp,
          poId,
          location: r.location,
        }
        tx.set(ref, batch)
      }
      tx.set(
        newMovementRef(),
        movementDoc({
          itemId,
          batchId,
          type: 'receive',
          qty: r.qty,
          unitCost: r.unitCost,
          reason: `Received against ${po.poNo}`,
          poId,
          by,
        }),
      )
      line.receivedQty = r4(line.receivedQty + r.qty)
      tx.update(docRef(INV.items, itemId), { lastPrice: r.unitCost })
      if (supplied) {
        const k = supplied.findIndex((s) => s.itemId === itemId)
        if (k >= 0) supplied[k] = { itemId, lastPrice: r.unitCost }
        else supplied.push({ itemId, lastPrice: r.unitCost })
      }
    }
    if (supplied) tx.update(supRef, { itemsSupplied: supplied })
    const complete = newLines.every((l) => l.receivedQty >= l.qty)
    tx.update(poRef, {
      lines: newLines,
      status: complete ? 'received' : 'partially_received',
      ...(complete ? { receivedAt: serverTimestamp() } : {}),
    })
  })
}

// Suggested reorder quantity: top up to twice the reorder level, in whole packs.
export function suggestedQty(item: InventoryItem, current: number): number {
  const target = Math.max(item.reorderLevel * 2 - current, item.reorderLevel)
  const pack = item.packSize > 0 ? item.packSize : 1
  return Math.max(pack, Math.ceil(target / pack) * pack)
}
