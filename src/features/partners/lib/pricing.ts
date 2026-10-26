import type { RateList } from '../types'

export type {
  RateList,
  Referrer,
  B2BCentre,
  CollectionCentre,
  CorporateClient,
  GovPanel,
  Tpa,
  ProcessingLab,
} from '../types'

// Price resolution contract (billing consumes this): pass the lists in priority order
// (b2bCentre / collectionCentre / corporate / govPanel list first, then doctor / hospital
// list). The first list that has an entry for the item wins; otherwise the MRP is used.
// All values are paise.
export function resolvePrice(itemId: string, mrp: number, lists: (RateList | null | undefined)[]): number {
  for (const l of lists) {
    if (!l || l.active === false) continue
    const v = l.entries?.[itemId]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return mrp
}

// A list followed by its parent list, the parent's parent... (cycle safe). An item the list does not price
// is looked up down this chain before the MRP.
export function listChain(l: RateList, byId: Map<string, RateList>): RateList[] {
  const out: RateList[] = [l]
  const seen = new Set([l.id])
  let cur = l
  while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
    cur = byId.get(cur.parentId)!
    seen.add(cur.id)
    out.push(cur)
  }
  return out
}

// Priority list of lists with each list's parent chain spliced in right after it.
export function expandWithParents(lists: (RateList | undefined)[], byId: Map<string, RateList>): (RateList | undefined)[] {
  const out: (RateList | undefined)[] = []
  const seen = new Set<string>()
  for (const l of lists) {
    if (!l) { out.push(l); continue }
    for (const x of listChain(l, byId)) {
      if (seen.has(x.id)) continue
      seen.add(x.id)
      out.push(x)
    }
  }
  return out
}

// Does a list (through its parents) price this item?
export const listPrices = (l: RateList, itemId: string, byId: Map<string, RateList>): boolean =>
  listChain(l, byId).some((x) => x.active !== false && typeof x.entries?.[itemId] === 'number')
