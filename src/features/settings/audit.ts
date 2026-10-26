import { logActivity } from '../../layout/activity'

// Audit entries for edits that change money or clinical ranges (X-03). They go through logActivity, which the
// server mirrors into the append-only auditLog. All are best-effort and never throw.
// Wired here: catalogue price and range edits. To wire elsewhere: partners (commission, wallet) call
// auditCommissionChange / auditWalletChange after saving.

export const auditPriceChange = (kind: 'test' | 'package' | 'rateList', name: string, refPath: string, before: number | null, after: number | null, reason = '') =>
  logActivity('price', `Price changed (${kind}): ${name}`, refPath, { category: 'SETTINGS', before: { price: before }, after: { price: after }, reason })

export const auditBulkPriceChange = (summary: string, count: number, batchId: string) =>
  logActivity('price', `Mass price update: ${summary} (${count} items)`, `priceBatches/${batchId}`, { category: 'SETTINGS', after: { count, batchId } })

export const auditRangeChange = (testCode: string, refPath: string, before: unknown, after: unknown) =>
  logActivity('range', `Reference ranges changed: ${testCode}`, refPath, { category: 'SETTINGS', before, after })

export const auditCommissionChange = (partnerName: string, refPath: string, before: unknown, after: unknown) =>
  logActivity('commission', `Commission changed: ${partnerName}`, refPath, { category: 'BILLING', before, after })

export const auditWalletChange = (centreName: string, refPath: string, amountPaise: number, kind: string, reason = '') =>
  logActivity('wallet', `Wallet ${kind}: ${centreName}`, refPath, { category: 'BILLING', after: { amount: amountPaise, kind }, reason })

/** Compact before/after view of a parameter list's ranges, for the audit entry. */
export const rangeDigest = (params: { key: string; low?: number | null; high?: number | null; ranges?: unknown[] }[]) =>
  Object.fromEntries(params.map((p) => [p.key, { low: p.low ?? null, high: p.high ?? null, ranges: p.ranges ?? [] }]))
