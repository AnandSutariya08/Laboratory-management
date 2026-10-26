import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Input, Modal } from 'antd'
import { BarcodeOutlined } from '@ant-design/icons'
import { getDocs, limit, query, where } from 'firebase/firestore'
import { col } from '../lib/db'
import { useBranchScope } from '../lib/branchScope'
import { StatusChip, type StatusVariant } from '../design/StatusChip'
import { Button } from '../design/Button'
import { liveItems } from '../components/results/common'
import type { Order } from '../types'
import { dialogWidth } from '../design/dialog'

const ITEM_VARIANT: Record<string, StatusVariant> = { approved: 'success', entered: 'info', hold: 'caution', rejected: 'urgent' }

export default function ScanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const scope = useBranchScope()
  const [code, setCode] = useState('')
  const [order, setOrder] = useState<Order | null>(null)
  const [state, setState] = useState<'idle' | 'busy' | 'none'>('idle')

  useEffect(() => {
    if (!open) {
      setCode('')
      setOrder(null)
      setState('idle')
    }
  }, [open])

  const find = async () => {
    const c = code.trim()
    if (!c) return
    setState('busy')
    setOrder(null)
    try {
      for (const f of ['barcode', 'billNo'] as const) {
        const s = await getDocs(query(col('orders'), ...scope.constraints, where(f, '==', f === 'billNo' ? c.toUpperCase() : c), limit(1)))
        if (!s.empty) {
          setOrder({ ...(s.docs[0].data() as object), id: s.docs[0].id } as Order)
          setState('idle')
          return
        }
      }
      setState('none')
    } catch {
      setState('none')
    }
  }

  const items = order ? liveItems(order) : []
  return (
    <Modal title="Scan barcode" open={open} onCancel={onClose} footer={null} destroyOnHidden width={dialogWidth(480)} afterOpenChange={(o) => o && document.getElementById('scan-input')?.focus()}>
      <p style={{ margin: '0 0 var(--s-3)', color: 'var(--c-on-surface-variant)' }}>
        Point the scanner at the sample label (the code is typed for you), then press Enter or choose Get details.
      </p>
      <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
        <Input id="scan-input" size="large" prefix={<BarcodeOutlined />} value={code} onChange={(e) => setCode(e.target.value)} onPressEnter={find} placeholder="Waiting for scan…" aria-label="Barcode or bill number" autoComplete="off" className="tabular" />
        <Button variant="primary" onClick={find} disabled={!code.trim() || state === 'busy'}>
          Get details
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {state === 'none' && <p style={{ marginTop: 'var(--s-3)' }}>No bill or sample with this code in the current branch.</p>}
        {order && (
          <div className="scan-card">
            <div className="scan-card__row">
              <strong>{order.patientName}</strong>
              <span className="tabular">{order.patientNo}</span>
            </div>
            <div className="scan-card__row">
              <span>Bill {order.billNo}</span>
              <span className="tabular">Barcode {order.barcode}</span>
              <StatusChip variant={order.reportStatus === 'final' ? 'success' : 'info'}>Report {order.reportStatus}</StatusChip>
              <StatusChip variant={order.due > 0 ? 'caution' : 'success'}>{order.due > 0 ? 'Payment due' : 'Paid'}</StatusChip>
              <StatusChip variant={order.receivedAt ? 'success' : 'neutral'}>{order.receivedAt ? 'Sample received' : 'Not received'}</StatusChip>
            </div>
            <ul className="howto">
              {items.map((i, n) => (
                <li key={n} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>{i.name}</span>
                  <StatusChip variant={ITEM_VARIANT[i.status] ?? 'neutral'}>{i.status}</StatusChip>
                </li>
              ))}
            </ul>
            <div className="scan-card__actions">
              <Link to={`/accession?scan=${encodeURIComponent(order.barcode || code.trim())}`} onClick={onClose} className="dbtn dbtn--default press"><span>Open accession</span></Link>
              <Link to={`/results/${order.id}`} onClick={onClose} className="dbtn dbtn--default press"><span>Results</span></Link>
              <Link to={`/report/${order.id}`} onClick={onClose} className="dbtn dbtn--default press"><span>Report</span></Link>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
