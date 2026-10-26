import { useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../firebase'

// Online payments (Razorpay) from the browser. The server functions in functions/src/payments.ts create the
// order, verify the signature and post the payment; this file opens Checkout in between.

export type PayPurpose = 'bill' | 'b2bTopup' | 'booking' | 'credits'
export interface PaymentConfig { configured: boolean; keyId: string; packs: { id: string; credits: number; amount: number }[] }

let cfgCache: Promise<PaymentConfig> | null = null
export function getPaymentConfig(force = false): Promise<PaymentConfig> {
  if (!cfgCache || force) {
    cfgCache = httpsCallable<{ labId: string }, PaymentConfig>(functions, 'getPaymentConfig')({ labId: LAB_ID })
      .then((r) => r.data)
      .catch(() => ({ configured: false, keyId: '', packs: [] }))
  }
  return cfgCache
}

// null while loading; configured false => show "Online payment is not set up".
export function usePaymentConfig(): PaymentConfig | null {
  const [cfg, setCfg] = useState<PaymentConfig | null>(null)
  useEffect(() => {
    let live = true
    void getPaymentConfig().then((c) => live && setCfg(c))
    return () => { live = false }
  }, [])
  return cfg
}

interface CheckoutResponse { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
declare global {
  interface Window { Razorpay?: new (o: Record<string, unknown>) => { open(): void; on(ev: string, cb: (r: { error?: { description?: string } }) => void): void } }
}
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Could not load the payment window. Check your connection.'))
    document.head.appendChild(s)
  })
}

export interface PayInput { purpose: PayPurpose; refId?: string; amount?: number; packId?: string; branchId?: string; payer?: { name?: string; email?: string; phone?: string }; description?: string }

// Create the order, open Checkout, verify. Resolves with the payment id; rejects with a readable message
// (including "Online payment is not set up" and "cancelled").
export async function payOnline(input: PayInput): Promise<{ paymentId: string }> {
  const cfg = await getPaymentConfig()
  if (!cfg.configured) throw new Error('Online payment is not set up.')
  const create = httpsCallable<unknown, { orderId: string; keyId: string; amount: number; currency: string; label: string }>(functions, 'createPaymentOrder')
  const order = (await create({ labId: LAB_ID, purpose: input.purpose, refId: input.refId, amount: input.amount, packId: input.packId, branchId: input.branchId })).data
  await loadCheckout()
  const res = await new Promise<CheckoutResponse>((resolve, reject) => {
    const rz = new window.Razorpay!({
      key: order.keyId, amount: order.amount, currency: order.currency, order_id: order.orderId, name: input.description ?? order.label, description: order.label,
      prefill: { name: input.payer?.name, email: input.payer?.email, contact: input.payer?.phone },
      handler: (r: CheckoutResponse) => resolve(r),
      modal: { ondismiss: () => reject(new Error('Payment cancelled.')) },
    })
    rz.on('payment.failed', (r) => reject(new Error(r.error?.description ?? 'The payment failed.')))
    rz.open()
  })
  const verify = httpsCallable<unknown, { ok: boolean; paymentId: string }>(functions, 'verifyPayment')
  const v = (await verify({ labId: LAB_ID, ...res })).data
  return { paymentId: v.paymentId }
}
