import { useState } from 'react'
import { App, Input, Modal, Tooltip } from 'antd'
import { EditOutlined, PrinterOutlined } from '@ant-design/icons'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useBranchScope } from '../../lib/branchScope'
import { changeBarcode, printLabels, type AOrder } from '../../pages/accession/ops'
import { sampleLabels } from '../../pages/catalogue/flags'
import type { Order } from '../../types'

// Barcode text with edit (unique, audited) and print-label icons for the Patient List.
// A voided bill shows its barcode struck through and offers no actions.
export default function BarcodeActions({ order }: { order: Order }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const maps = useCatalogueMaps()
  const scope = useBranchScope({ analytics: true })
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(order.barcode)
  const [busy, setBusy] = useState(false)
  const voided = order.deleted || order.barcodeVoided
  const canEdit = !voided && (can(profile, 'accession.collect') || can(profile, 'billing.edit'))

  const print = () => {
    const o = order as unknown as AOrder
    const labels = sampleLabels(o.barcode, o.items, maps.testById, maps.sampleTypeById, settings, (id) => maps.departmentById.get(id)?.name ?? '')
    const samples = labels.length ? labels.map((l) => ({ name: l.sampleName, barcode: l.barcode })) : [{ name: '', barcode: o.barcode }]
    if (!printLabels([{ order: o, samples }], settings.accession?.labelSize)) message.warning('Allow pop-ups to print labels')
  }
  const save = async () => {
    if (!profile) return
    setBusy(true)
    try {
      await changeBarcode(order as unknown as AOrder, value, profile, scope.constraints)
      message.success('Barcode updated')
      setEditing(false)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <span style={voided ? { textDecoration: 'line-through' } : undefined} title={voided ? 'Barcode voided with the bill' : undefined}>{order.barcode}</span>
      {!voided && (
        <>
          {canEdit && (
            <Tooltip title="Edit barcode">
              <Button variant="text" aria-label={`Edit barcode of ${order.billNo}`} icon={<EditOutlined />} onClick={() => { setValue(order.barcode); setEditing(true) }} />
            </Tooltip>
          )}
          <Tooltip title="Print barcode label">
            <Button variant="text" aria-label={`Print barcode label for ${order.billNo}`} icon={<PrinterOutlined />} onClick={print} />
          </Tooltip>
        </>
      )}
      <Modal open={editing} title={`Edit barcode · ${order.billNo}`} onCancel={() => setEditing(false)} onOk={save} okText="Save" okButtonProps={{ loading: busy, disabled: !value.trim() || value.trim() === order.barcode }} destroyOnHidden>
        <Input aria-label="Barcode" value={value} onChange={(e) => setValue(e.target.value)} onPressEnter={save} autoFocus />
        <p className="pl-sub" style={{ marginTop: 8 }}>Must be unique. The change is recorded on the bill.</p>
      </Modal>
    </span>
  )
}
