import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Progress, Radio, Space, Table, Tag } from 'antd'
import { MailOutlined, MessageOutlined, SendOutlined, WhatsAppOutlined } from '@ant-design/icons'
import { sendReportsBulk, type BulkSendRow, type ReportRecipient } from '../../lib/messaging'
import type { Channel } from '../../types'
import { dialogWidth } from '../../design/dialog'

const CHUNK = 5 // bills per server call, so the progress bar moves

// Bulk send (DP-20): sends reports for many bills with progress. The server checks each bill on its own
// (due balance, report status, duplicates) and reports per-bill outcomes.
export default function BulkSendModal({
  open, onClose, orders, defaultChannels = ['whatsapp'],
}: {
  open: boolean
  onClose: () => void
  orders: { id: string; billNo: string; patientName: string }[]
  defaultChannels?: Channel[]
}) {
  const [channels, setChannels] = useState<Channel[]>(defaultChannels)
  const [recipient, setRecipient] = useState<ReportRecipient>('patient')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(0)
  const [rows, setRows] = useState<BulkSendRow[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setRows([])
    setDone(0)
    setError('')
    setChannels(defaultChannels)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const run = async () => {
    setBusy(true)
    setRows([])
    setDone(0)
    setError('')
    const all: BulkSendRow[] = []
    try {
      for (let i = 0; i < orders.length; i += CHUNK) {
        const part = orders.slice(i, i + CHUNK)
        const res = await sendReportsBulk({ orderIds: part.map((o) => o.id), channels, recipient })
        all.push(...res)
        setRows([...all])
        setDone(Math.min(orders.length, i + CHUNK))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const name = (id: string) => orders.find((o) => o.id === id)?.patientName ?? ''
  const state = (r: BulkSendRow) =>
    r.skipped ? <Tag>Skipped</Tag> : !r.ok ? <Tag color="red">Not sent</Tag> : r.results.some((x) => x.status === 'logged') ? <Tag color="gold">Dev log only</Tag> : <Tag color="green">Sent</Tag>

  return (
    <Modal
      open={open}
      onCancel={busy ? undefined : onClose}
      title={`Send ${orders.length} report${orders.length === 1 ? '' : 's'}`}
      width={dialogWidth(640)}
      footer={
        <Space>
          <Button onClick={onClose} disabled={busy}>Close</Button>
          <Button type="primary" icon={<SendOutlined />} loading={busy} disabled={!channels.length || !orders.length || orders.length > 100} onClick={run}>Send</Button>
        </Space>
      }
    >
      <Radio.Group value={recipient} onChange={(e) => setRecipient(e.target.value)} style={{ marginBottom: 12 }}>
        <Radio.Button value="patient">Patients</Radio.Button>
        <Radio.Button value="doctor">Referring doctors</Radio.Button>
        <Radio.Button value="b2b">B2B centres</Radio.Button>
        <Radio.Button value="centre">Collection centres</Radio.Button>
        <Radio.Button value="corporate">Corporate clients</Radio.Button>
      </Radio.Group>
      <div>
        <Checkbox.Group
          value={channels}
          onChange={(v) => setChannels(v as Channel[])}
          options={[
            { value: 'whatsapp', label: <span><WhatsAppOutlined /> WhatsApp</span> },
            { value: 'sms', label: <span><MessageOutlined /> SMS</span> },
            { value: 'email', label: <span><MailOutlined /> Email</span> },
          ]}
        />
      </div>
      <p style={{ marginTop: 8 }}>Each bill is checked on its own: bills with a due balance, a report that is not ready, or a send within the last hour are skipped.</p>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      {(busy || rows.length > 0) && <Progress percent={orders.length ? Math.round((done / orders.length) * 100) : 0} />}
      {rows.length > 0 && (
        <Table<BulkSendRow>
          size="small"
          rowKey="orderId"
          dataSource={rows}
          pagination={false}
          scroll={{ y: 240 }}
          columns={[
            { title: 'Bill', dataIndex: 'billNo', width: 110 },
            { title: 'Patient', render: (_, r) => name(r.orderId) },
            { title: 'Result', width: 120, render: (_, r) => state(r) },
            { title: 'Detail', render: (_, r) => r.error || r.results.map((x) => `${x.channel}: ${x.status}`).join(', ') },
          ]}
        />
      )}
    </Modal>
  )
}
