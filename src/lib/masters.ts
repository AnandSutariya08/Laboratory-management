import { useMemo } from 'react'
import { useLiveQuery } from '../hooks/useLive'
import { needsReference } from './billing'
import { expandWithParents } from '../features/partners/lib/pricing'
import { col } from './db'
import type {
  B2BCentre,
  CollectionCentre,
  CorporateClient,
  GovPanel,
  RateList,
  Referrer,
  Tpa,
} from '../features/partners/types'

export interface OtherCharge { id: string; name: string; price: number; active: boolean; showOnBill?: boolean }
export interface PaymentModeDoc { id: string; name: string; active: boolean; builtIn?: boolean; requiresReference?: boolean }
export interface ReasonDoc { id: string; kind: string; text: string }

const byName = <T extends { name?: string }>(a: T, b: T) => String(a.name ?? '').localeCompare(String(b.name ?? ''))
const live = <T extends { active?: boolean }>(xs: T[]) => xs.filter((x) => x.active !== false)

function useList<T extends { id: string }>(name: string) {
  const r = useLiveQuery<T>(col(name), [name])
  return r.data
}

// Shared master data used by registration, billing, quotations and bulk registration.
export function useMasters() {
  const referrers = useList<Referrer>('referrers')
  const hospitalsCol = useList<Referrer>('hospitals')
  const tpas = useList<Tpa>('tpas')
  const govPanels = useList<GovPanel>('govPanels')
  const b2bCentres = useList<B2BCentre>('b2bCentres')
  const collectionCentres = useList<CollectionCentre>('collectionCentres')
  const corporateClients = useList<CorporateClient>('corporateClients')
  const rateLists = useList<RateList>('rateLists')
  const otherCharges = useList<OtherCharge>('otherCharges')
  const paymentModeDocs = useList<PaymentModeDoc>('paymentModes')
  const reasons = useList<ReasonDoc>('reasons')

  return useMemo(() => {
    const doctors = live(referrers.filter((r) => r.type !== 'hospital' && r.type !== 'second')).sort(byName)
    const secondReferrals = live(referrers.filter((r) => r.type === 'second')).sort(byName)
    const hospitals = live([...referrers.filter((r) => r.type === 'hospital'), ...hospitalsCol]).sort(byName)
    const rateListById = new Map(rateLists.map((r) => [r.id, r]))
    return {
      doctors,
      secondReferrals,
      hospitals,
      referrerById: new Map([...referrers, ...hospitalsCol].map((r) => [r.id, r])),
      tpas: live(tpas).sort(byName),
      govPanels: live(govPanels).sort(byName),
      b2bCentres: live(b2bCentres).sort(byName),
      collectionCentres: live(collectionCentres).sort(byName),
      corporateClients: live(corporateClients).sort(byName),
      rateListById,
      rateLists: live(rateLists).sort(byName),
      otherCharges: live(otherCharges).sort(byName),
      reasons: reasons.filter((r) => r.kind === 'discount').map((r) => r.text),
      voidReasons: reasons.filter((r) => r.kind === 'void' || r.kind === 'delete').map((r) => r.text),
      paymentModeDocs,
    }
  }, [referrers, hospitalsCol, tpas, govPanels, b2bCentres, collectionCentres, corporateClients, rateLists, otherCharges, reasons, paymentModeDocs])
}
export type Masters = ReturnType<typeof useMasters>

const BUILT_IN: { value: string; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
]

export const modeLabel = (mode: string) =>
  ({ cash: 'Cash', upi: 'UPI', card: 'Card', wallet: 'Wallet' } as Record<string, string>)[mode] ?? mode

// Payment modes offered at the counter: the paymentModes master (built-in ids cash/upi/card/wallet
// are stored lower-case; custom modes by name). Wallet is only offered for B2B bills (added by the caller).
export function usePaymentModes(): { value: string; label: string }[] {
  const { paymentModeDocs } = useMasters()
  return useMemo(() => {
    if (paymentModeDocs.length === 0) return BUILT_IN
    const out = paymentModeDocs
      .filter((m) => (m.builtIn || m.active) && m.id !== 'wallet')
      .map((m) => (m.builtIn ? { value: m.id, label: m.name } : { value: m.name, label: m.name }))
    // built-ins never configured stay on by default
    for (const b of BUILT_IN) if (!paymentModeDocs.some((m) => m.id === b.value)) out.unshift(b)
    return out.length ? out : BUILT_IN
  }, [paymentModeDocs])
}

// Does this payment mode need a transaction reference? The paymentModes master can override.
export function useNeedsReference(): (mode: string) => boolean {
  const { paymentModeDocs } = useMasters()
  return useMemo(
    () => (mode: string) => {
      const d = paymentModeDocs.find((m) => m.id === mode || m.name === mode)
      return d?.requiresReference ?? needsReference(mode)
    },
    [paymentModeDocs],
  )
}

// Rate lists in priority order for a bill context (first list with the item wins).
export interface PartnerContext {
  referrerId?: string
  hospitalId?: string
  b2bCentreId?: string
  collectionCentreId?: string
  corporateClientId?: string
  govPanelId?: string
  tpaId?: string
  secondReferrerId?: string
  rateListId?: string // rate list picked by hand at registration: wins over partner lists
}
export type AutoRateList = 'none' | 'referrer' | 'hospital' | 'corporate' | 'all'
// `auto` is Settings > Registration > Auto rate list select: which referral list is applied automatically.
// B2B / collection centre / government panel / TPA lists and a hand-picked list always apply.
export function rateListsFor(ctx: PartnerContext, m: Masters, auto: AutoRateList = 'referrer'): (RateList | undefined)[] {
  return expandWithParents(rawRateLists(ctx, m, auto), m.rateListById)
}
function rawRateLists(ctx: PartnerContext, m: Masters, auto: AutoRateList): (RateList | undefined)[] {
  const id = (x: { rateListId?: string } | undefined) => (x?.rateListId ? m.rateListById.get(x.rateListId) : undefined)
  const is = (k: 'referrer' | 'hospital' | 'corporate') => auto === 'all' || auto === k
  return [
    ctx.rateListId ? m.rateListById.get(ctx.rateListId) : undefined,
    id(m.b2bCentres.find((x) => x.id === ctx.b2bCentreId)),
    id(m.collectionCentres.find((x) => x.id === ctx.collectionCentreId)),
    is('corporate') ? id(m.corporateClients.find((x) => x.id === ctx.corporateClientId)) : undefined,
    id(m.govPanels.find((x) => x.id === ctx.govPanelId)),
    id(m.tpas.find((x) => x.id === ctx.tpaId)),
    is('referrer') ? id(m.doctors.find((x) => x.id === ctx.referrerId)) : undefined,
    is('hospital') ? id(m.hospitals.find((x) => x.id === ctx.hospitalId)) : undefined,
    is('referrer') ? id(m.secondReferrals.find((x) => x.id === ctx.secondReferrerId)) : undefined,
  ]
}

// The partner lists themselves (without their parents), for the per-list "missing item" policy.
export function primaryRateLists(ctx: PartnerContext, m: Masters, auto: AutoRateList = 'referrer'): RateList[] {
  return rawRateLists(ctx, m, auto).filter((l): l is RateList => !!l)
}
