import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button as AButton, Checkbox, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd'
import { PrinterOutlined, ScanOutlined } from '@ant-design/icons'
import { orderBy, query } from 'firebase/firestore'
import { col } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { useBranchScope } from '../../lib/branchScope'
import { MANIFESTS, type Manifest } from '../../lib/accession'
import { StatusChip } from '../../design/StatusChip'
import { dialogWidth } from '../../design/dialog'
import { fmtDateTime, tsToDate } from '../../components/results/common'
import type { UserProfile } from '../../types'
import { receiveManifest, type AOrder } from './ops'

const { Text } = Typography
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

// Printable manifest sheet: what is in the box, for the courier and the receiving bench.
export function printManifest(m: Pick<Manifest, 'no' | 'centreName' | 'courier' | 'tubes' | 'temperature' | 'note' | 'lines'>, createdBy: string) {
  const w = window.open('', '_blank', 'width=800,height=700')
  if (!w) return false
  const rows = m.lines
    .map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.barcode)}</td><td>${esc(l.billNo)}</td><td>${esc(l.patientName)}</td><td>${esc(l.samples)}</td><td></td></tr>`)
    .join('')
  w.document.write(`<html><head><title>Manifest ${esc(m.no)}</title><style>body{font-family:Arial,sans-serif;margin:16px;font-size:13px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #888;padding:4px 6px;text-align:left}h2{margin:0 0 6px}p{margin:2px 0}</style></head><body>
<h2>Sample dispatch manifest ${esc(m.no)}</h2>
<p>From: <b>${esc(m.centreName || 'Collection centre')}</b> &nbsp; Courier: <b>${esc(m.courier || '-')}</b> &nbsp; Tubes: <b>${m.tubes}</b> &nbsp; Temperature: <b>${esc(m.temperature || '-')}</b></p>
<p>Prepared by ${esc(createdBy)} on ${esc(new Date().toLocaleString())}</p>${m.note ? `<p>Note: ${esc(m.note)}</p>` : ''}
<table><thead><tr><th>#</th><th>Barcode</th><th>Bill</th><th>Patient</th><th>Samples</th><th>Received</th></tr></thead><tbody>${rows}</tbody></table>
<script>window.onload=function(){window.print();}</script></body></html>`)
  w.document.close()
  return true
}

export function DispatchModal({
  open,
  entries,
  centres,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  entries: { order: AOrder; samples: string }[]
  centres: { id: string; name: string }[]
  busy: boolean
  onClose: () => void
  onSubmit: (meta: { centreId: string; centreName: string; courier: string; tubes: number; temperature: string; note: string }) => void
}) {
  const { message } = App.useApp()
  const [centreId, setCentreId] = useState<string>()
  const [courier, setCourier] = useState('')
  const [tubes, setTubes] = useState<number | null>(null)
  const [temp, setTemp] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    if (!open) return
    const ids = [...new Set(entries.map((e) => e.order.collectionCentreId).filter(Boolean))]
    setCentreId(ids.length === 1 ? (ids[0] as string) : undefined)
    setCourier('')
    setTemp('')
    setNote('')
    setTubes(entries.length)
  }, [open, entries])
  return (
    <Modal
      open={open}
      title={`Dispatch manifest (${entries.length} bill${entries.length === 1 ? '' : 's'})`}
      okText="Dispatch"
      okButtonProps={{ loading: busy }}
      onCancel={onClose}
      onOk={() => {
        if (!centreId) return message.warning('Choose the collection centre')
        onSubmit({ centreId, centreName: centres.find((c) => c.id === centreId)?.name ?? '', courier: courier.trim(), tubes: tubes ?? entries.length, temperature: temp.trim(), note: note.trim() })
      }}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select showSearch optionFilterProp="label" style={{ width: '100%' }} aria-label="Collection centre" placeholder="Collection centre" value={centreId} onChange={setCentreId} options={centres.map((c) => ({ value: c.id, label: c.name }))} />
        <Input aria-label="Courier" placeholder="Courier or person carrying the box" value={courier} onChange={(e) => setCourier(e.target.value)} />
        <Space wrap>
          <InputNumber aria-label="Number of tubes" min={1} value={tubes} onChange={setTubes} addonAfter="tubes" />
          <Input aria-label="Temperature" style={{ width: 200 }} placeholder="Temperature (e.g. 2-8 C)" value={temp} onChange={(e) => setTemp(e.target.value)} />
        </Space>
        <Input.TextArea aria-label="Note" rows={2} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Text type="secondary">{entries.map((e) => e.order.billNo).join(', ')}</Text>
      </Space>
    </Modal>
  )
}

// Receive a manifest at the lab: scan each tube; unscanned bills can be marked Not received.
export function ManifestReceiveModal({ open, user, autoBarcode, onClose }: { open: boolean; user: UserProfile; autoBarcode: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const scope = useBranchScope()
  const { data: all } = useLiveQuery<Manifest>(query(col<Manifest>(MANIFESTS), ...scope.constraints, orderBy('createdAt', 'desc')), [scope.key])
  const open_ = useMemo(() => all.filter((m) => m.status !== 'received'), [all])
  const [id, setId] = useState<string>()
  const [scanned, setScanned] = useState<string[]>([])
  const [markMissing, setMarkMissing] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<import('antd').InputRef>(null)
  const m = open_.find((x) => x.id === id) ?? null
  useEffect(() => {
    if (open) {
      setScanned([])
      setCode('')
      setMarkMissing(false)
    }
  }, [open, id])
  useEffect(() => {
    if (!id && open_.length) setId(open_[0].id)
  }, [open_, id])

  const scan = () => {
    const c = code.trim()
    if (!c || !m) return
    const hit = m.lines.find((l) => l.barcode === c || c.includes(l.barcode))
    setCode('')
    if (!hit) return message.error(`${c} is not on manifest ${m.no}`)
    if (scanned.includes(hit.orderId)) return message.warning(`${hit.billNo} already scanned`)
    setScanned((s) => [...s, hit.orderId])
    ref.current?.focus()
  }
  const missing = m ? m.lines.filter((l) => !scanned.includes(l.orderId) && !(m.receivedOrderIds ?? []).includes(l.orderId)) : []
  const submit = async () => {
    if (!m) return
    setBusy(true)
    try {
      await receiveManifest(m, scanned, markMissing ? missing.map((l) => l.orderId) : [], user, autoBarcode)
      message.success(`Received ${scanned.length} bill(s)${markMissing && missing.length ? `, ${missing.length} marked not received` : ''}`)
      onClose()
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not receive the manifest')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      title="Receive dispatch manifest"
      width={dialogWidth(720)}
      okText={`Receive ${scanned.length}`}
      okButtonProps={{ disabled: !m || (!scanned.length && !(markMissing && missing.length)), loading: busy }}
      onOk={submit}
      onCancel={onClose}
      destroyOnHidden
    >
      {open_.length === 0 ? (
        <Text type="secondary">No manifest is on its way.</Text>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            aria-label="Manifest"
            value={id}
            onChange={setId}
            options={open_.map((x) => ({ value: x.id, label: `${x.no} · ${x.centreName || 'Collection centre'} · ${x.lines.length} bill(s) · ${fmtDateTime(tsToDate(x.createdAt as never))}` }))}
          />
          {m && (
            <>
              <Space wrap>
                <StatusChip variant="info">Scanned {scanned.length + (m.receivedOrderIds?.length ?? 0)} of {m.lines.length}</StatusChip>
                <Text type="secondary">Courier {m.courier || '-'} · {m.tubes} tubes · {m.temperature || 'no temperature noted'}</Text>
                <AButton size="small" icon={<PrinterOutlined />} onClick={() => printManifest(m, m.createdByName)}>Print</AButton>
              </Space>
              <Input ref={ref} size="large" prefix={<ScanOutlined />} aria-label="Scan tube barcode" placeholder="Scan tube barcode and press Enter" value={code} onChange={(e) => setCode(e.target.value)} onPressEnter={scan} autoFocus />
              <Table
                size="small"
                rowKey="orderId"
                pagination={false}
                dataSource={m.lines}
                columns={[
                  { title: 'Barcode', dataIndex: 'barcode', width: 110 },
                  { title: 'Bill', dataIndex: 'billNo', width: 100 },
                  { title: 'Patient', dataIndex: 'patientName' },
                  { title: 'Samples', dataIndex: 'samples' },
                  {
                    title: 'Status',
                    width: 110,
                    render: (_v, l) =>
                      (m.receivedOrderIds ?? []).includes(l.orderId) ? <StatusChip variant="success">Received</StatusChip> : scanned.includes(l.orderId) ? <StatusChip variant="success">Scanned</StatusChip> : <StatusChip variant="caution">In transit</StatusChip>,
                  },
                ]}
              />
              {missing.length > 0 && (
                <Checkbox checked={markMissing} onChange={(e) => setMarkMissing(e.target.checked)}>
                  Mark the {missing.length} unscanned bill(s) as Not received
                </Checkbox>
              )}
            </>
          )}
        </Space>
      )}
    </Modal>
  )
}
