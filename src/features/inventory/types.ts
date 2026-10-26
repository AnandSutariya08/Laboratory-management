import type { Timestamp } from 'firebase/firestore'
import type { Paise } from '../../types'

export type ItemCategory = 'reagent' | 'consumable' | 'kit' | 'control' | 'calibrator' | 'other'

export const CATEGORIES: ItemCategory[] = ['reagent', 'consumable', 'kit', 'control', 'calibrator', 'other']
export const UNITS = ['test', 'ml', 'piece', 'box', 'vial', 'kit', 'pack']

export interface InventoryItem {
  id: string
  name: string
  code: string
  category: ItemCategory
  unit: string // base unit consumed, e.g. test, ml, piece
  packSize: number // base units per purchased pack
  reorderLevel: number // in base units
  defaultSupplierId: string // '' when none
  storage: string // e.g. "2-8 C"
  lastPrice: Paise // last purchase unit cost
  active: boolean
  // Unit conversion: stock and consumption are counted in `unit` (base); the item is bought in `purchaseUnit`,
  // and 1 purchase unit = `packSize` base units.
  purchaseUnit?: string
  taxPercent?: number // GST % added to purchase orders for this item
  // Suppliers in order of preference (first = preferred); each with its own price per base unit.
  suppliers?: { supplierId: string; price: Paise }[]
}

export interface SupplierItemLink {
  itemId: string
  lastPrice: Paise
}

export interface Supplier {
  id: string
  name: string
  contact: string
  phone: string
  email: string
  gstin: string
  address: string
  itemsSupplied: SupplierItemLink[]
  active: boolean
}

export interface StockBatch {
  id: string
  itemId: string
  lotNo: string
  expiry: string // YYYY-MM-DD
  receivedQty: number
  qtyRemaining: number
  unitCost: Paise
  receivedAt: Timestamp | null
  poId: string // '' when not from a PO
  location: string
  deleted?: boolean // lot removed (kept for the movement history; qtyRemaining is 0)
}

export type MovementType = 'receive' | 'consume_auto' | 'consume_manual' | 'adjust' | 'expire' | 'return'

export interface StockMovement {
  id: string
  itemId: string
  batchId: string // '' for shortfall records
  type: MovementType
  qty: number // signed: receipts positive, consumption negative
  unitCost: Paise
  reason: string
  shortfall: number // unmet quantity (auto/manual consumption), else 0
  orderId: string
  testId: string
  poId: string
  by: string
  at: Timestamp | null
}

export type POStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled'

export interface POLine {
  itemId: string
  qty: number
  unitCost: Paise
  receivedQty: number
  taxPercent?: number // GST % frozen from the item when the line was created
}

export interface PurchaseOrder {
  id: string
  poNo: string
  supplierId: string
  lines: POLine[]
  status: POStatus
  total: Paise
  notes: string
  createdBy: string
  createdAt: Timestamp | null
  orderedAt: Timestamp | null
  receivedAt: Timestamp | null
}

export interface StockMapping {
  id: string // `${testId}_${itemId}`
  testId: string
  itemId: string
  qtyPerTest: number
}
