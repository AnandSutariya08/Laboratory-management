import { useState } from 'react'
import { FileProtectOutlined } from '@ant-design/icons'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import type { Order } from '../../types'
import FormFModal from './FormFModal'

// Per-bill "Form F filled" mark and the way into the Form F screen. Shown wherever a PCPNDT bill is listed.
export function FormFChip({ order }: { order: Pick<Order, 'pcpndt' | 'formFStatus'> }) {
  if (!order.pcpndt) return null
  return order.formFStatus === 'complete' ? <StatusChip variant="success">Form F filled</StatusChip> : <StatusChip variant="caution">{order.formFStatus === 'pending' ? 'Form F pending' : 'Form F needed'}</StatusChip>
}

export default function FormFAction({ order, label }: { order: Order; label?: string }) {
  const [open, setOpen] = useState(false)
  if (!order.pcpndt) return null
  return (
    <>
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <FormFChip order={order} />
        <Button icon={<FileProtectOutlined />} onClick={() => setOpen(true)}>{label ?? 'Form F'}</Button>
      </span>
      {open && <FormFModal order={order} open onClose={() => setOpen(false)} />}
    </>
  )
}
