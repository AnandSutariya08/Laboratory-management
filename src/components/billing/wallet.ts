import { where, query } from 'firebase/firestore'
import { useMemo } from 'react'
import { useLiveQuery } from '../../hooks/useLive'
import { centreBalance, canBill, type CentreBalance } from '../../features/partners/lib/b2b'
import { useOrdersByPartner } from '../../features/partners/lib/orders'
import type { B2BCentre, CreditNote, PartnerOrder, WalletTxn } from '../../features/partners/types'
import { col } from '../../lib/db'
import type { Paise } from '../../types'

// Live wallet position of a B2B centre (wallet + credit limit), using the partners ledger maths.
export function useCentreBalance(centre: B2BCentre | undefined): CentreBalance | null {
  const id = centre?.id
  const orders = useOrdersByPartner('b2bCentreId', id ? [id] : [])
  const txns = useLiveQuery<WalletTxn>(id ? query(col('walletTxns'), where('centreId', '==', id)) : null, [id])
  const notes = useLiveQuery<CreditNote>(id ? query(col('creditNotes'), where('centreId', '==', id)) : null, [id])
  return useMemo(
    () => (centre ? centreBalance(centre, orders.data as PartnerOrder[], txns.data, notes.data) : null),
    [centre, orders.data, txns.data, notes.data],
  )
}

export const withinCredit = (b: CentreBalance | null, amount: Paise) => (b ? canBill(b, amount) : true)
