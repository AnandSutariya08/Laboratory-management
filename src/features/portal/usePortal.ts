import { useEffect, useMemo, useState } from 'react'
import { onSnapshot, query, where, type DocumentData } from 'firebase/firestore'
import { useAuth } from '../../auth/AuthProvider'
import { PARTNER_COLLECTION, PARTNER_ORDER_FIELD } from '../../auth/permissions'
import { col, docRef, paths } from '../../lib/db'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import type { B2BCentre, CollectionCentre, CommissionSettlement, CorporateClient, CreditNote, PartnerInvoice, PartnerOrder, RateList, Referrer, WalletTxn } from '../partners/types'
import { canB2B } from '../partners/lib/b2b'

export type PartnerDoc = (B2BCentre | CollectionCentre | CorporateClient | Referrer) & { id: string }

// Everything a partner portal user may see, resolved from profile.partnerId. All queries filter
// on the partner id, which is exactly what firestore.rules require for these reads.
export function usePortal() {
  const { profile } = useAuth()
  const role = profile?.role ?? 'b2b'
  const partnerId = profile?.partnerId ?? ''
  const collectionName = PARTNER_COLLECTION[role] ?? 'b2bCentres'
  const orderField = PARTNER_ORDER_FIELD[role] ?? 'b2bCentreId'

  const { data: partner, loading: partnerLoading } = useLiveDoc<PartnerDoc>(partnerId ? docRef(collectionName, partnerId) : null, [collectionName, partnerId])

  // Bills: one query per linking field (a referring doctor portal also sees bills of a hospital id).
  const [byField, setByField] = useState<Record<string, PartnerOrder[]>>({})
  const [loadingOrders, setLoadingOrders] = useState(true)
  const fields = useMemo(() => (role === 'referrer' ? ['referrerId', 'hospitalId'] : [orderField]), [role, orderField])
  useEffect(() => {
    if (!partnerId) {
      setLoadingOrders(false)
      return
    }
    setLoadingOrders(true)
    let pending = fields.length
    const unsubs = fields.map((f) =>
      onSnapshot(
        query(col<DocumentData>(paths.orders), where(f, '==', partnerId)),
        (snap) => {
          setByField((p) => ({ ...p, [f]: snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as PartnerOrder) }))
          if (pending > 0 && --pending === 0) setLoadingOrders(false)
        },
        () => setLoadingOrders(false),
      ),
    )
    return () => unsubs.forEach((u) => u())
  }, [partnerId, fields])
  const orders = useMemo(() => {
    const m = new Map<string, PartnerOrder>()
    for (const l of Object.values(byField)) for (const o of l) if (!o.deleted) m.set(o.id, o)
    return [...m.values()].sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
  }, [byField])

  const isB2b = role === 'b2b'
  const { data: txns } = useLiveQuery<WalletTxn>(isB2b && partnerId ? query(col('walletTxns'), where('centreId', '==', partnerId)) : null, [isB2b, partnerId])
  const { data: notes } = useLiveQuery<CreditNote>(isB2b && partnerId ? query(col('creditNotes'), where('centreId', '==', partnerId)) : null, [isB2b, partnerId])
  const hasInvoices = role === 'b2b' || role === 'corporate'
  const { data: invoices } = useLiveQuery<PartnerInvoice>(hasInvoices && partnerId ? query(col('partnerInvoices'), where('partyId', '==', partnerId)) : null, [hasInvoices, partnerId])
  // A referrer sees the commission payouts the lab recorded for them (firestore.rules: referrer role, own partnerId).
  const { data: payouts } = useLiveQuery<CommissionSettlement>(role === 'referrer' && partnerId ? query(col('commissionSettlements'), where('partnerKind', '==', 'referrer'), where('partnerId', '==', partnerId)) : null, [role, partnerId])
  const rateListId = (partner as { rateListId?: string } | null)?.rateListId ?? ''
  const { data: rateList } = useLiveDoc<RateList>(rateListId ? docRef('rateLists', rateListId) : null, [rateListId])

  // Per-centre flags (B2B). Other partner kinds: register/bill allowed while active.
  const flags = role === 'b2b' ? (partner as B2BCentre | null) : null
  const canBill = role !== 'referrer' && !!partner && partner.active !== false && (role !== 'b2b' || canB2B(flags, 'book'))
  const canPrint = role !== 'b2b' || canB2B(flags, 'print')

  return {
    profile, role, partnerId, partner, partnerLoading, orders, loadingOrders,
    txns, notes, invoices, payouts, rateList: rateList ?? null, canBill, canPrint, flags,
    loading: partnerLoading || loadingOrders,
  }
}

export const PORTAL_ROLE_TITLE: Record<string, string> = {
  b2b: 'B2B centre',
  collectionCentre: 'Collection centre',
  corporate: 'Corporate client',
  referrer: 'Referring doctor / hospital',
}
