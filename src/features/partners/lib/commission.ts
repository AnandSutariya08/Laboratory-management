import type { OrderItem, Paise } from '../../../types'
import type { CommissionRule, CommissionType, PartnerOrder, Referrer } from '../types'

// ---------------------------------------------------------------------------
// ONE commission calculation shared by Referrals, Marketing and Finance.
//   basis    Lab Settings > Referrals > commissionBasis (gross | net | paid)
//   match    by referrerId / hospitalId / secondReferrerId, falling back to the
//            referrer NAME only for legacy bills that carry no ids at all
//   bearer   who bears the discount (order.discountBearer, else the referrer's
//            default): 'lab' | 'referrer' | 'split'. With 'split',
//            discountSplitReferrerPct is the referrer's share (0-100).
//            No bearer set = the plain basis amount (legacy behaviour).
// All amounts are paise.
// ---------------------------------------------------------------------------

export type CommissionBasis = 'gross' | 'net' | 'paid'
export type DiscountBearer = 'lab' | 'referrer' | 'split'

// Fields read from a bill. Order carries them; the two bearer fields are written by billing.
export type CommissionOrder = Pick<PartnerOrder, 'gross' | 'net' | 'paid' | 'discount'> & {
  referrerId?: string
  referrerName?: string
  hospitalId?: string
  secondReferrerId?: string
  discountBearer?: DiscountBearer
  discountSplitReferrerPct?: number
  items?: OrderItem[]
  deleted?: boolean
  commissionReversed?: boolean
  reportStatus?: string
  due?: Paise
}

export type CommissionReferrer = Pick<Referrer, 'id' | 'name' | 'commissionType' | 'commissionValue'> & {
  discountBearer?: DiscountBearer
  discountSplitReferrerPct?: number
  commissionMode?: Referrer['commissionMode']
  commissionRules?: CommissionRule[]
}

// Settings > Referrals > "commission is earned when": a bill earns nothing until the trigger is met.
// Set once from the lab settings (useLabSettings) so every caller of the shared calculation agrees.
export type CommissionTrigger = 'billing' | 'reportFinal' | 'fullyPaid'
let trigger: CommissionTrigger = 'billing'
export const setCommissionTrigger = (t: CommissionTrigger | undefined) => {
  trigger = t ?? 'billing'
}
function triggerMet(o: CommissionOrder): boolean {
  if (trigger === 'reportFinal') return o.reportStatus === 'final'
  if (trigger === 'fullyPaid') return (o.due ?? 0) <= 0 && o.net > 0
  return true
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// The amount a percentage commission is applied to.
export function commissionBase(o: CommissionOrder, basis: CommissionBasis, bearer?: DiscountBearer, splitPct = 50): Paise {
  const discount = o.discount ?? 0
  const share = bearer === 'referrer' ? 1 : bearer === 'split' ? clamp(splitPct, 0, 100) / 100 : bearer === 'lab' ? 0 : null
  if (basis === 'gross') return Math.max(0, share == null ? o.gross : o.gross - discount * share)
  const raw = basis === 'net' ? o.net : Math.max(0, o.paid)
  if (share == null) return raw
  // net / paid already have the whole discount taken off: give the lab's part back.
  if (raw <= 0) return 0
  return Math.max(0, raw + discount * (1 - share))
}

// The most specific rule for a line: test, then package, then department.
export function ruleForLine(line: OrderItem, rules: CommissionRule[] | undefined): CommissionRule | undefined {
  if (!rules?.length) return undefined
  if (line.kind === 'test') {
    const t = rules.find((x) => x.scope === 'test' && x.refId === line.refId)
    if (t) return t
  } else {
    const p = rules.find((x) => x.scope === 'package' && x.refId === line.refId)
    if (p) return p
  }
  return line.departmentId ? rules.find((x) => x.scope === 'department' && x.refId === line.departmentId) : undefined
}

// Per-line commission: per-test / package / department rules, and rate-list difference. A line no rule
// covers earns the referrer's default percent (a default flat amount is paid once per bill).
function commissionByLine(o: CommissionOrder, r: CommissionReferrer, basis: CommissionBasis): Paise {
  const lines = (o.items ?? []).filter((i) => i.status !== 'refunded' && !i.isCharge)
  if (!lines.length) return 0
  const bearer = o.discountBearer ?? r.discountBearer
  const pct = o.discountBearer ? o.discountSplitReferrerPct : (r as { discountSplitReferrerPct?: number }).discountSplitReferrerPct
  const paidShare = o.net > 0 ? clamp(o.paid / o.net, 0, 1) : 0
  let total = 0
  let defaultFlat = false
  for (const l of lines) {
    const net = l.price - l.discount
    const pseudo = { gross: l.price, net, paid: Math.round(net * paidShare), discount: l.discount }
    const rule = ruleForLine(l, r.commissionRules)
    if (rule) {
      if (rule.type === 'percent') total += Math.round((commissionBase(pseudo as CommissionOrder, basis, bearer, pct) * rule.value) / 100)
      else if (rule.type === 'flat') total += basis === 'paid' && !(pseudo.paid > 0) ? 0 : Math.round(rule.value)
      continue
    }
    if (r.commissionMode === 'rateListDiff' && typeof l.commissionCost === 'number') {
      const base = basis === 'gross' ? l.price : basis === 'net' ? net : pseudo.paid
      total += Math.max(0, base - l.commissionCost)
      continue
    }
    if (r.commissionType === 'percent') total += Math.round((commissionBase(pseudo as CommissionOrder, basis, bearer, pct) * r.commissionValue) / 100)
    else if (r.commissionType === 'flat') defaultFlat = true
  }
  if (defaultFlat && !(basis === 'paid' && !(o.paid > 0))) total += Math.round(r.commissionValue)
  return total
}

// Commission for one bill. percent -> % of the base; flat -> value (paise) per bill. A deleted (voided)
// bill earns nothing. With per-test rules or rate-list difference the commission is worked out line by line.
export function commissionForReferrer(o: CommissionOrder, r: CommissionReferrer, basis: CommissionBasis): Paise {
  if (o.deleted || o.commissionReversed || !triggerMet(o)) return 0
  if ((r.commissionRules?.length || r.commissionMode === 'rateListDiff') && o.items?.length) return commissionByLine(o, r, basis)
  if (!r.commissionType || r.commissionType === 'none') return 0
  if (r.commissionType === 'flat') return basis === 'paid' && !(o.paid > 0) ? 0 : Math.round(r.commissionValue)
  const bearer = o.discountBearer ?? r.discountBearer
  const pct = o.discountBearer ? o.discountSplitReferrerPct : r.discountSplitReferrerPct
  return Math.round((commissionBase(o, basis, bearer, pct) * r.commissionValue) / 100)
}

// Legacy helper kept for callers that only have type/value.
export function commissionFor(type: CommissionType, value: number, net: Paise): Paise {
  if (type === 'percent') return Math.round((net * value) / 100)
  if (type === 'flat') return Math.round(value)
  return 0
}

// Marketing member commission on one bill (percent of the basis amount, or flat per bill). The member earns
// on bills of their referrers: the PRO stamped on the bill, else the referrer's mapped PRO.
export function marketingCommissionForOrder(
  o: CommissionOrder & { proId?: string },
  m: { id: string; commissionType?: CommissionType; commissionValue?: number },
  basis: CommissionBasis,
  mappedProOf?: (o: CommissionOrder) => string | undefined,
): Paise {
  if (o.deleted || o.commissionReversed || !triggerMet(o)) return 0
  const pro = o.proId || mappedProOf?.(o)
  if (pro !== m.id) return 0
  if (!m.commissionType || m.commissionType === 'none') return 0
  if (m.commissionType === 'flat') return basis === 'paid' && !(o.paid > 0) ? 0 : Math.round(m.commissionValue ?? 0)
  return Math.round((commissionBase(o, basis) * (m.commissionValue ?? 0)) / 100)
}

const norm = (s?: string) => (s ?? '').trim().toLowerCase()

// An order belongs to a referrer by id (doctor, hospital or second referrer), or by name
// only when the bill has no referrer ids at all (legacy / free text).
export function orderMatchesReferrer(o: CommissionOrder, r: Pick<Referrer, 'id' | 'name'>): boolean {
  if (o.referrerId === r.id || o.hospitalId === r.id || o.secondReferrerId === r.id) return true
  if (o.referrerId || o.hospitalId || o.secondReferrerId) return false
  return !!o.referrerName && norm(o.referrerName) === norm(r.name)
}

// Every referrer earning on a bill (doctor, hospital, second referrer).
export function referrersOf<R extends Pick<Referrer, 'id' | 'name'>>(o: CommissionOrder, referrers: R[]): R[] {
  return referrers.filter((r) => orderMatchesReferrer(o, r))
}

// Total commission payable on one bill across all its referrers. Finance uses this per bill.
export function commissionForOrder(o: CommissionOrder, referrers: CommissionReferrer[], basis: CommissionBasis): Paise {
  return referrersOf(o, referrers).reduce((s, r) => s + commissionForReferrer(o, r, basis), 0)
}

export interface ReferrerTotals {
  bills: number
  gross: Paise
  net: Paise
  commission: Paise
}

export function totalsFor(r: Referrer, orders: PartnerOrder[], basis: CommissionBasis = 'net'): ReferrerTotals {
  let bills = 0
  let gross = 0
  let net = 0
  let commission = 0
  for (const o of orders) {
    if (!orderMatchesReferrer(o, r)) continue
    bills++
    gross += o.gross
    net += o.net
    commission += commissionForReferrer(o, r, basis)
  }
  return { bills, gross, net, commission }
}

export const commissionLabel = (r: { commissionType: CommissionType; commissionValue: number }) =>
  r.commissionType === 'percent'
    ? `${r.commissionValue}%`
    : r.commissionType === 'flat'
      ? `Rs ${(r.commissionValue / 100).toFixed(2)} / bill`
      : 'None'
