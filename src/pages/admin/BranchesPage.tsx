import { useMemo, useState } from 'react'
import { Alert, App, Button, Form, Input, Modal, Space, Switch, Table, Typography } from 'antd'
import { Panel } from '../../features/qc/ui'
import { PageHeader } from '../../design/PageHeader'
import { Button as DsButton } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { PlusOutlined } from '@ant-design/icons'
import { orderBy, query, setDoc } from 'firebase/firestore'
import { useLiveQuery } from '../../hooks/useLive'
import { col, docRef, paths } from '../../lib/db'
import { backfillMainBranch } from '../../lib/branchBackfill'
import type { Branch } from '../../branch/BranchProvider'
import type { UserProfile } from '../../types'

type BranchForm = Omit<Branch, 'id'> & { id?: string }

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export default function BranchesPage() {
  const { message, modal } = App.useApp()
  const { data: branches, loading } = useLiveQuery<Branch>(query(col('branches'), orderBy('name')), [])
  const { data: users } = useLiveQuery<UserProfile>(query(col(paths.users)), [])
  const [editing, setEditing] = useState<Branch | 'new' | null>(null)
  const [saving, setSaving] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [form] = Form.useForm<BranchForm>()

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of branches) {
      m.set(b.id, users.filter((u) => u.active && (u.allBranches || (u.branchIds ?? ['main']).includes(b.id))).length)
    }
    return m
  }, [branches, users])

  const open = (b: Branch | 'new') => {
    setEditing(b)
    form.resetFields()
    form.setFieldsValue(
      b === 'new'
        ? { name: '', code: '', address: '', phone: '', email: '', billPrefix: '', active: true }
        : { ...b, email: b.email ?? '', billPrefix: b.billPrefix ?? '' },
    )
  }

  const save = async () => {
    const v = await form.validateFields()
    const id = editing === 'new' ? slug(v.code) : (editing as Branch).id
    if (!id) {
      message.error('Branch code is required')
      return
    }
    if (editing === 'new' && branches.some((b) => b.id === id)) {
      message.error('A branch with this code already exists')
      return
    }
    setSaving(true)
    try {
      await setDoc(docRef('branches', id), {
        name: v.name.trim(),
        code: v.code.trim().toUpperCase(),
        address: v.address?.trim() ?? '',
        phone: v.phone?.trim() ?? '',
        email: v.email?.trim() ?? '',
        billPrefix: v.billPrefix?.trim() ?? '',
        active: !!v.active,
      })
      message.success('Branch saved')
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const createMain = () =>
    setDoc(docRef('branches', 'main'), { name: 'Main branch', code: 'MAIN', address: '', phone: '', email: '', billPrefix: '', active: true })
      .then(() => message.success('Main branch created'))
      .catch((e) => message.error((e as Error).message))

  const backfill = () =>
    modal.confirm({
      title: 'Assign existing records to the Main branch?',
      content:
        'Bills, bookings, stock, QC and other branch records created before branches existed have no branch. This stamps them as Main branch so they show up there. Safe to run again.',
      okText: 'Run',
      onOk: async () => {
        setMigrating(true)
        try {
          const n = await backfillMainBranch()
          message.success(`${n} record(s) assigned to Main`)
        } catch (e) {
          message.error((e as Error).message)
        } finally {
          setMigrating(false)
        }
      },
    })

  return (
    <div>
      <PageHeader
        title="Branches"
        subtitle="Labs and centres under this account."
        actions={<DsButton variant="primary" icon={<PlusOutlined />} onClick={() => open('new')}>Add branch</DsButton>}
      />
      <Panel>
      <Typography.Paragraph type="secondary">
        The test catalogue, packages and patients are shared by all branches. Bills, samples, bookings, stock and QC belong to one branch.
      </Typography.Paragraph>
      {!loading && branches.length === 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="No branches yet"
          description="The lab is running as a single implicit Main branch. Create it to edit its details and add more branches."
          action={<Button onClick={createMain}>Create Main branch</Button>}
        />
      )}
      <Table<Branch>
        rowKey="id"
        loading={loading}
        dataSource={branches}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Code', dataIndex: 'code', width: 100 },
          { title: 'Bill prefix', dataIndex: 'billPrefix', width: 120, render: (v?: string) => v || '(lab prefix + code)' },
          { title: 'Address', dataIndex: 'address' },
          { title: 'Phone', dataIndex: 'phone', width: 140 },
          { title: 'Users', width: 80, render: (_, b) => counts.get(b.id) ?? 0 },
          { title: 'Status', dataIndex: 'active', width: 100, render: (a: boolean) => <StatusChip variant={a !== false ? 'success' : 'neutral'}>{a !== false ? 'Active' : 'Inactive'}</StatusChip> },
          { title: '', width: 80, render: (_, b) => <Button type="link" onClick={() => open(b)}>Edit</Button> },
        ]}
      />
      <Space style={{ marginTop: 24 }} vertical>
        <Typography.Text strong>Existing data</Typography.Text>
        <Typography.Text type="secondary">Records created before branches were introduced belong to the Main branch.</Typography.Text>
        <Button loading={migrating} onClick={backfill}>
          Assign existing records to Main
        </Button>
      </Space>
      <Modal
        title={editing === 'new' ? 'Add branch' : 'Edit branch'}
        open={!!editing}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="code"
            label="Code"
            rules={[{ required: true }]}
            extra={editing === 'new' ? 'Short code used in bill numbers. The branch id is derived from it and cannot change.' : 'Short code used in bill numbers.'}
          >
            <Input style={{ textTransform: 'uppercase' }} maxLength={10} />
          </Form.Item>
          <Form.Item name="billPrefix" label="Bill prefix (optional)" extra="Replaces the lab prefix + branch code, e.g. CITY-">
            <Input />
          </Form.Item>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="phone" label="Phone">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email">
            <Input />
          </Form.Item>
          <Form.Item name="active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
      </Panel>
    </div>
  )
}
