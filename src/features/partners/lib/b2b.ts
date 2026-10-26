import type { Paise } from '../../../types'
import type { B2BCentre, CreditNote, PartnerOrder, WalletTxn } from '../types'
import { orderDate } from './orders'

// A top-up counts only once approved. Pending/declined rows and approval rows themselves
// carry no balance; an approval row flips the status of the txn it references.
export function effectiveTxns(txns: WalletTxn[]): WalletTxn[] {
  const decided = new Map<string, WalletTxn['status']>()
  for (const t of txns) if (t.kind === 'approval' && t.refTxnId) decided.set(t.refTxnId, t.status)
  return txns
    .filter((t) => t.kind !== 'approval')
    .map((t) => (decided.has(t.id) ? { ...t, status: decided.get(t.id)! } : t))
}

export type LedgerKind = 'bill' | 'topup' | 'adjustment' | 'discount' | 'creditNote' | 'debitNote'
export interface LedgerRow {
  key: string
  at: Date
  centreId: string
  centreName: string
  kind: LedgerKind
  description: string
  debit: Paise // reduces the balance
  credit: Paise // adds to the balance
  balance: Paise // running, per centre
  status: string
  patients?: string
  items?: string
  orderId?: string
}

// Per centre: bills debit the wallet (net of the bill, at creation), approved top-ups,
// discounts and credit notes add to it, debit notes and negative adjustments reduce it.
// walletTxns of kind 'debit' are informational mirrors of bills and are NOT counted again.
export function buildLedger(
  centres: B2BCentre[],
  orders: PartnerOrder[],
  txns: WalletTxn[],
  notes: CreditNote[],
): LedgerRow[] {
  const rows: Omit<LedgerRow, 'balance'>[] = []
  const nameOf = new Map(centres.map((c) => [c.id, c.name]))
  for (const o of orders) {
    if (!o.b2bCentreId || o.deleted) continue
    rows.push({
      key: `o-${o.id}`,
      at: orderDate(o),
      centreId: o.b2bCentreId,
      centreName: nameOf.get(o.b2bCentreId) ?? o.b2bCentreId,
      kind: 'bill',
      description: `Bill ${o.billNo}`,
      debit: o.net,
      credit: 0,
      status: o.reportStatus,
      patients: o.patientName,
      items: o.items.map((i) => i.name).join(', '),
      orderId: o.id,
    })
  }
  for (const t of effectiveTxns(txns)) {
    if (t.kind === 'debit') continue
    const counted = t.status === 'approved'
    rows.push({
      key: `t-${t.id}`,
      at: t.at?.toDate?.() ?? new Date(),
      centreId: t.centreId,
      centreName: t.centreName || nameOf.get(t.centreId) || t.centreId,
      kind: t.kind === 'topup' ? 'topup' : t.kind === 'discount' ? 'discount' : 'adjustment',
      description: t.remark || (t.kind === 'topup' ? `Top-up (${t.mode ?? ''})` : t.kind),
      debit: counted && t.amount < 0 ? -t.amount : 0,
      credit: counted && t.amount > 0 ? t.amount : 0,
      status: t.status,
    })
  }
  for (const n of notes) {
    rows.push({
      key: `n-${n.id}`,
      at: n.at?.toDate?.() ?? new Date(),
      centreId: n.centreId,
      centreName: n.centreName || nameOf.get(n.centreId) || n.centreId,
      kind: n.kind === 'credit' ? 'creditNote' : 'debitNote',
      description: n.reason,
      debit: n.kind === 'debit' ? n.amount : 0,
      credit: n.kind === 'credit' ? n.amount : 0,
      status: 'posted',
    })
  }
  rows.sort((a, b) => a.at.getTime() - b.at.getTime())
  const bal = new Map<string, number>()
  return rows.map((r) => {
    const b = (bal.get(r.centreId) ?? 0) + r.credit - r.debit
    bal.set(r.centreId, b)
    return { ...r, balance: b }
  })
}

export interface CentreBalance {
  wallet: Paise // confirmed credits - debits (negative = the centre owes)
  onHold: Paise // top-ups awaiting approval (NOT spendable until approved)
  // Spendable headroom for new bills, by credit type:
  //   prepaid         wallet                    (bill must be covered by the wallet)
  //   creditLimit     wallet + creditLimit      (wallet may go negative down to -limit)
  //   rollingAdvance  wallet - creditLimit      (limit is the standing advance that must stay in the wallet)
  net: Paise // spendable headroom for new bills (wallet and credit limit); the list's Net Balance is netBalance
  netBalance: Paise // Flabs: Net Balance = Wallet - On Hold
  billed: Paise
  creditType: B2BCreditType
  limit: Paise
  lowAlert: Paise
  // Remaining headroom is at or below the centre's intimation (low balance alert) amount.
  isLow: boolean
}

export type B2BCreditType = 'prepaid' | 'creditLimit' | 'rollingAdvance'

export function spendable(creditType: B2BCreditType | undefined, wallet: Paise, limit: Paise): Paise {
  const l = limit || 0
  return creditType === 'prepaid' ? wallet : creditType === 'rollingAdvance' ? wallet - l : wallet + l
}

export function centreBalance(
  centre: B2BCentre,
  orders: PartnerOrder[],
  txns: WalletTxn[],
  notes: CreditNote[],
): CentreBalance {
  const ledger = buildLedger([centre], orders.filter((o) => o.b2bCentreId === centre.id), txns.filter((t) => t.centreId === centre.id), notes.filter((n) => n.centreId === centre.id))
  const wallet = ledger.length ? ledger[ledger.length - 1].balance : 0
  const onHold = effectiveTxns(txns)
    .filter((t) => t.centreId === centre.id && t.kind === 'topup' && t.status === 'pending')
    .reduce((s, t) => s + t.amount, 0)
  const billed = orders.filter((o) => o.b2bCentreId === centre.id).reduce((s, o) => s + o.net, 0)
  const creditType = (centre.creditType ?? 'creditLimit') as B2BCreditType
  const net = spendable(creditType, wallet, centre.creditLimit || 0)
  const lowAlert = centre.lowBalanceAlert || 0
  return { wallet, onHold, net, netBalance: wallet - onHold, billed, creditType, limit: centre.creditLimit || 0, lowAlert, isLow: lowAlert > 0 && net < lowAlert }
}

export const creditTypeLabel = (t: B2BCreditType | undefined) =>
  t === 'prepaid' ? 'Prepaid wallet' : t === 'rollingAdvance' ? 'Rolling advance' : 'Credit limit'

// For the billing agent: may this centre register a bill of `amount` right now?
export const canBill = (b: CentreBalance, amount: Paise) => b.net - amount >= 0

export type FundsLevel = 'ok' | 'low' | 'insufficient'
// One call for billing: level 'insufficient' blocks (when settings.b2bLab.creditLimitBehaviour is
// 'block' and the centre has no below-limit override), 'low' only warns (low-balance alert).
export function checkFunds(
  centre: Pick<B2BCentre, 'settings'>,
  b: CentreBalance,
  amount: Paise,
  behaviour: 'block' | 'warn' = 'block',
  at: 'main' | 'b2b' = 'main',
): { level: FundsLevel; blocks: boolean; message: string; after: Paise } {
  const after = b.net - amount
  if (after < 0) {
    const override = at === 'main' ? centre.settings?.registrationBelowLimitAtMain : centre.settings?.registrationBelowLimitAtB2B
    const blocks = behaviour === 'block' && !override
    return {
      level: 'insufficient',
      blocks,
      after,
      message: blocks ? 'Insufficient funds: this B2B centre has no balance or credit left for this bill.' : 'This bill takes the centre below its limit.',
    }
  }
  if (b.lowAlert > 0 && after < b.lowAlert) return { level: 'low', blocks: false, after, message: 'Low balance: the centre will be below its alert amount after this bill.' }
  return { level: 'ok', blocks: false, after, message: '' }
}

export type B2BAction =
  | 'dashboard' | 'priceList' | 'book' | 'print' | 'editAfterApproval' | 'customize' | 'editMrp' | 'showPriceColumn'
  | 'showB2BRate' | 'editBarcode' | 'clearPatientDue' | 'addReferral' | 'manualWhatsapp' | 'autoSendReport' | 'showTat'
  | 'registerBelowLimitAtMain' | 'registerBelowLimitAtB2B' | 'downloadReportBelowLimit'

// Every per-centre permission flag in one place. Positive actions are allowed unless the
// matching "disable / hide / lock" flag is set; opt-in actions need their flag switched on.
// Billing, the B2B portal and report download call this instead of reading flags directly.
export function canB2B(centre: Pick<B2BCentre, 'settings'> | null | undefined, action: B2BAction): boolean {
  const s = centre?.settings ?? {}
  switch (action) {
    case 'dashboard': return !s.disableDashboard
    case 'priceList': return !s.disablePriceList
    case 'book': return !s.bookingLock
    case 'print': return !s.printingLock
    case 'editAfterApproval': return !s.noEditAfterApproval
    case 'customize': return !s.disableCustomization
    case 'editMrp': return !s.disableMrpEdit
    case 'showPriceColumn': return !s.hidePriceColumn
    case 'showB2BRate': return !s.hideB2BRate
    case 'editBarcode': return !!s.barcodeEdit
    case 'clearPatientDue': return !!s.patientWiseDueClearance
    case 'addReferral': return !!s.allowAddReferral
    case 'manualWhatsapp': return !!s.manualWhatsapp
    case 'autoSendReport': return !!s.autoSendReport
    case 'showTat': return !!s.showTatColumn
    case 'registerBelowLimitAtMain': return !!s.registrationBelowLimitAtMain
    case 'registerBelowLimitAtB2B': return !!s.registrationBelowLimitAtB2B
    case 'downloadReportBelowLimit': return !!s.reportDownloadBelowLimit
  }
}
