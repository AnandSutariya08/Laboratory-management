import { useState } from 'react'
import { Drawer, Form, Input, InputNumber, Popconfirm, Switch, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, ProfileOutlined } from '@ant-design/icons'
import { Button } from '../../design/Button'
import { PageHeader } from '../../design/PageHeader'
import { useOutsourceData } from '../outsource/lib'
import { downloadCsv } from './lib/csv'
import { removeMaster, saveMaster, useMaster, useRateLists } from './lib/master'
import { PriceListDrawer } from './RateListEditor'
import type { ProcessingLab } from './types'
import { DataTable, Spacer, Toolbar } from './ui'

export default function ProcessingLabsPage() {
  const labs = useMaster<ProcessingLab>('processingLabs')
  const rates = useRateLists()
  const { tests } = useOutsourceData()
  // Number of catalogue tests mapped to a lab (Outsource page). A lab with mappings cannot be deleted.
  const mapped = (id: string) => [...tests.values()].filter((t) => t.outsourceLabs?.some((e) => e.labId === id)).length
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Partial<ProcessingLab> | null>(null)
  const [pl, setPl] = useState<ProcessingLab | null>(null)
  const offered = (l: ProcessingLab) => Object.keys(rates.data.find((r) => r.id === l.rateListId)?.entries ?? {}).length
  const rows = labs.data.filter((l) => !q.trim() || `${l.name} ${l.address} ${l.contact}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <PageHeader title="Processing Labs" subtitle="Outsource labs that run tests for us, with the price they charge"
        actions={<Button variant="primary" icon={<PlusOutlined />} onClick={() => setEdit({ active: true, turnaroundHours: 24 })}>Add lab</Button>} />
      <DataTable<ProcessingLab>
        loading={labs.loading}
        dataSource={rows}
        emptyTitle="No processing labs yet"
        emptyHint="Add the labs you outsource tests to."
        toolbar={
          <Toolbar>
            <Input.Search allowClear aria-label="Search labs" placeholder="Search lab, address, contact" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
            <Spacer />
            <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('processing-labs', [['name', 'contact', 'email', 'address', 'turnaround hours', 'tests offered', 'active'], ...rows.map((l) => [l.name, l.contact, l.email, l.address, l.turnaroundHours, offered(l), l.active])])}>Export CSV</Button>
          </Toolbar>
        }
        columns={[
          { title: 'Lab name', dataIndex: 'name' },
          { title: 'Address', dataIndex: 'address' },
          { title: 'Contact', render: (_, l) => <span>{l.contact}<br /><span className="pt-muted">{l.email}</span></span> },
          { title: 'Turnaround', align: 'right', render: (_, l) => <span className="pt-num">{l.turnaroundHours ? `${l.turnaroundHours} h` : '-'}</span> },
          { title: 'Tests offered', align: 'right', render: (_, l) => <span className="pt-num">{offered(l)}</span> },
          { title: 'Active', render: (_, l) => <Switch size="small" aria-label={`Active: ${l.name}`} checked={l.active} onChange={(v) => saveMaster('processingLabs', l.id, { active: v })} /> },
          {
            title: 'Actions',
            render: (_, l) => (
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <Button variant="text" icon={<EditOutlined />} aria-label={`Edit ${l.name}`} onClick={() => setEdit(l)} />
                <Button variant="text" icon={<ProfileOutlined />} aria-label={`Tests and prices of ${l.name}`} onClick={() => setPl(l)} />
                <Popconfirm
                  title={mapped(l.id) ? `${l.name} is mapped to ${mapped(l.id)} test(s). Remove those mappings on the Outsource page first, or deactivate the lab.` : `Delete ${l.name}?`}
                  okText={mapped(l.id) ? 'Deactivate instead' : 'Delete'}
                  onConfirm={() => (mapped(l.id) ? saveMaster('processingLabs', l.id, { active: false }) : removeMaster('processingLabs', l.id)).catch((e) => message.error(e.message))}
                >
                  <Button variant="text" icon={<DeleteOutlined />} aria-label={`Delete ${l.name}`} />
                </Popconfirm>
              </span>
            ),
          },
        ]}
      />
      <LabDrawer value={edit} onClose={() => setEdit(null)} />
      <PriceListDrawer open={!!pl} onClose={() => setPl(null)} owner={pl && { collection: 'processingLabs', id: pl.id, name: pl.name, rateListId: pl.rateListId, kind: 'custom' }} />
    </div>
  )
}

function LabDrawer({ value, onClose }: { value: Partial<ProcessingLab> | null; onClose: () => void }) {
  const [form] = Form.useForm()
  const submit = async () => {
    const v = await form.validateFields()
    try {
      await saveMaster('processingLabs', value?.id ?? null, { ...v, rateListId: value?.rateListId ?? '' })
      message.success('Saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Drawer open={!!value} onClose={onClose} destroyOnHidden title={value?.id ? 'Edit processing lab' : 'Add processing lab'}
      footer={<div className="pt-sticky-foot"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save</Button></div>}>
      <Form form={form} layout="vertical" initialValues={{ active: true, ...value }}>
        <Form.Item name="name" label="Lab name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="contact" label="Contact"><Input /></Form.Item>
        <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input /></Form.Item>
        <Form.Item name="address" label="Address"><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="turnaroundHours" label="Turnaround (hours)"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="active" label="Active" valuePropName="checked"><Switch /></Form.Item>
        <p className="pt-muted">After saving, use the price list button to choose the tests this lab offers and what they charge us.</p>
      </Form>
    </Drawer>
  )
}
