import { useState } from 'react'
import { Alert, App, InputNumber } from 'antd'
import { Button } from '../../design/Button'
import { payOnline, usePaymentConfig, type PayInput } from '../../lib/payments'

// "Pay online" button used by bookings, the partner portal and the credit wallet. Without gateway
// secrets it shows "Online payment is not set up" instead of a button.
export default function PayOnlineButton({ input, label = 'Pay online', disabled, onPaid, variant = 'primary', askAmount }: { askAmount?: boolean; input: PayInput; label?: string; disabled?: boolean; onPaid?: (paymentId: string) => void; variant?: 'primary' | 'default' }) {
  const { message } = App.useApp()
  const cfg = usePaymentConfig()
  const [busy, setBusy] = useState(false)
  const [rupees, setRupees] = useState<number | null>(null)
  if (cfg && !cfg.configured) return <Alert type="info" showIcon message="Online payment is not set up" />
  const go = async () => {
    setBusy(true)
    try {
      const r = await payOnline(askAmount ? { ...input, amount: Math.round((rupees ?? 0) * 100) } : input)
      message.success('Payment received')
      onPaid?.(r.paymentId)
    } catch (e) {
      const m = (e as Error).message
      if (m !== 'Payment cancelled.') message.error(m)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      {askAmount && <InputNumber aria-label="Amount to pay" addonBefore="₹" min={1} precision={2} value={rupees} onChange={setRupees} style={{ width: 150 }} />}
      <Button variant={variant} disabled={disabled || busy || !cfg || (askAmount && !(rupees && rupees >= 1))} onClick={go}>{busy ? 'Waiting for payment...' : label}</Button>
    </span>
  )
}
