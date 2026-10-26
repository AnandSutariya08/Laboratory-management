import { useEffect, useState } from 'react'
import { App, Alert, Form, InputNumber, Modal, Radio, Select, Input } from 'antd'
import type { InventoryData } from '../lib/useInventory'
import { adjustStock, consumeFefo, isExpired } from '../lib/stock'
import { useActor } from './useActor'

const REASONS = ['QC run', 'Calibration', 'Spillage', 'Wastage', 'Other']

export function ConsumeModal({
  open,
  inv,
  itemId,
  onClose,
}: {
  open: boolean
  inv: InventoryData
  itemId?: string
  onClose: () => void
}) {
  const { message } = App.useApp()
  const actor = useActor()
  const [item, setItem] = useState<string | undefined>(itemId)
  const [qty, setQty] = useState<number | null>(null)
  const [reason, setReason] = useState('QC run')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setItem(itemId)
      setQty(null)
      setReason('QC run')
      setNote('')
    }
  }, [open, itemId])

  const avail = item ? (inv.levels.get(item)?.qty ?? 0) : 0
  const unit = item ? inv.itemById.get(item)?.unit : ''

  const submit = async () => {
    if (!item || !qty || qty <= 0) return message.warning('Pick an item and a quantity')
    if (qty > avail) return message.error(`Only ${avail} ${unit} available (non-expired)`)
    setBusy(true)
    try {
      const r = await consumeFefo(item, qty, note ? `${reason}: ${note}` : reason, {
        type: 'consume_manual',
        by: actor.name,
      })
      message.success(`Consumed ${r.consumed} ${unit} (earliest expiry first)`)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Manual consumption" open={open} onCancel={onClose} onOk={submit} okText="Consume" confirmLoading={busy} destroyOnHidden>
      <Form layout="vertical">
        <Form.Item label="Item" required>
          <Select
            showSearch
            optionFilterProp="label"
            value={item}
            onChange={setItem}
            options={inv.items.filter((i) => i.active).map((i) => ({ value: i.id, label: `${i.name} (${inv.levels.get(i.id)?.qty ?? 0} ${i.unit})` }))}
          />
        </Form.Item>
        <Form.Item label={`Quantity${unit ? ` (${unit})` : ''}`} required extra={item ? `Available: ${avail} ${unit}. Drawn from the earliest-expiry lots first.` : undefined}>
          <InputNumber min={0} value={qty} onChange={setQty} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Reason">
          <Select value={reason} onChange={setReason} options={REASONS.map((r) => ({ value: r, label: r }))} />
        </Form.Item>
        <Form.Item label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export function AdjustModal({
  open,
  inv,
  itemId,
  onClose,
}: {
  open: boolean
  inv: InventoryData
  itemId: string | null
  onClose: () => void
}) {
  const { message } = App.useApp()
  const actor = useActor()
  const [batchId, setBatchId] = useState<string>()
  const [dir, setDir] = useState<1 | -1>(-1)
  const [qty, setQty] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setBatchId(undefined)
      setDir(-1)
      setQty(null)
      setReason('')
    }
  }, [open, itemId])

  const batches = inv.batches.filter((b) => b.itemId === itemId && (b.qtyRemaining > 0 || dir === 1))
  const item = itemId ? inv.itemById.get(itemId) : undefined

  const submit = async () => {
    if (!batchId || !qty || qty <= 0) return message.warning('Pick a lot and a quantity')
    if (!reason.trim()) return message.warning('A reason is required')
    setBusy(true)
    try {
      await adjustStock(batchId, dir * qty, reason.trim(), actor.name)
      message.success('Stock adjusted')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Adjust stock${item ? ` - ${item.name}` : ''}`} open={open} onCancel={onClose} onOk={submit} okText="Apply" confirmLoading={busy} destroyOnHidden>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} title="Adjustments are logged in the movement history with your reason." />
      <Form layout="vertical">
        <Form.Item label="Lot" required>
          <Select
            value={batchId}
            onChange={setBatchId}
            options={batches.map((b) => ({
              value: b.id,
              label: `${b.lotNo} - exp ${b.expiry}${isExpired(b) ? ' (expired)' : ''} - ${b.qtyRemaining} ${item?.unit ?? ''}`,
            }))}
          />
        </Form.Item>
        <Form.Item label="Direction">
          <Radio.Group value={dir} onChange={(e) => setDir(e.target.value)}>
            <Radio.Button value={1}>Add (+)</Radio.Button>
            <Radio.Button value={-1}>Remove (-)</Radio.Button>
          </Radio.Group>
        </Form.Item>
        <Form.Item label={`Quantity${item ? ` (${item.unit})` : ''}`} required>
          <InputNumber min={0} value={qty} onChange={setQty} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Reason" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Stock count correction, damaged, QC fail..." />
        </Form.Item>
      </Form>
    </Modal>
  )
}
