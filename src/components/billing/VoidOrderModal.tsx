import { useEffect, useState } from 'react'
import { Alert, App, AutoComplete, Modal, Radio } from 'antd'
import { can, useAuth } from '../../auth/AuthProvider'
import { useLabSettings } from '../../hooks/useCatalogue'
import { useMasters } from '../../lib/masters'
import { formatINR } from '../../lib/money'
import { voidOrder } from '../../lib/orders'
import type { Order } from '../../types'

// Delete (void) a bill: managers and admins. Money already collected is refunded straight away
// or left as "refund pending". The reason is required when the lab setting says so.
export default function VoidOrderModal({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const masters = useMasters()
  const [reason, setReason] = useState('')
  const [refundNow, setRefundNow] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) {
      setReason('')
      setRefundNow(true)
    }
  }, [open, order.id])

  const reasonRequired = settings.patientList.voidReasonRequired
  const problems: string[] = []
  if (!can(profile, 'billing.void')) problems.push('You do not have permission to delete a bill.')
  const reported = order.items.some((i) => i.status === 'approved')
  const hasMoney = order.paid > 0
  const wallet = order.billedTo === 'b2b'

  const submit = async () => {
    if (!profile) return
    setSaving(true)
    try {
      await voidOrder(order, reason.trim(), profile, { refundNow, reasonRequired })
      message.success('Bill deleted')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`Delete bill · ${order.billNo}`}
      destroyOnHidden
      okText="Delete bill"
      onOk={submit}
      okButtonProps={{ danger: true, disabled: problems.length > 0 || (reasonRequired && !reason.trim()), loading: saving }}
    >
      <p>
        Are you sure to delete this bill? {order.patientName} · the bill is hidden from lists but kept for audit and its number is not reused.
      </p>
      {problems.length > 0 ? (
        <Alert type="warning" showIcon message="This bill cannot be deleted" description={problems.map((p) => <div key={p}>{p}</div>)} />
      ) : (
        <>
          {reported && <Alert style={{ marginBottom: 8 }} type="warning" showIcon message="A test on this bill already has an approved result. Its report stops being available." />}
          {hasMoney && !wallet && (
            <Radio.Group
              style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}
              value={refundNow}
              onChange={(e) => setRefundNow(e.target.value)}
              options={[
                { value: true, label: `Refund ${formatINR(order.paid)} now (recorded in the payment history)` },
                { value: false, label: `Mark refund of ${formatINR(order.paid)} as pending` },
              ]}
            />
          )}
          {hasMoney && wallet && <Alert style={{ marginBottom: 8 }} type="info" showIcon message="The amount goes back to the B2B centre wallet." />}
          <AutoComplete
            style={{ width: '100%', marginBottom: 8 }}
            options={masters.voidReasons.map((r) => ({ value: r }))}
            value={reason}
            onChange={setReason}
            placeholder={reasonRequired ? 'Reason (required)' : 'Reason (optional)'}
            status={reasonRequired && !reason.trim() ? 'error' : undefined}
          />
        </>
      )}
    </Modal>
  )
}
