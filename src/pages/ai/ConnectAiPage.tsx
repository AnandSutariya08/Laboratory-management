import { useState } from 'react'
import { Alert, App, Button, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Radio, Space, Table, Typography } from 'antd'
import { CopyOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons'
import { doc as fsDoc, limit, orderBy, query } from 'firebase/firestore'
import { useLiveDoc } from '../../hooks/useLive'
import { labDoc } from '../../lib/db'
import { db, LAB_ID } from '../../firebase'
import type { Timestamp } from 'firebase/firestore'
import { col } from '../../lib/db'
import { DEFAULT_MCP_SCOPES, MCP_SCOPES, MCP_TOOLS, confirmMcpConnection, createMcpConnection, revokeMcpConnection, updateMcpConnection } from '../../lib/ai'
import { useLiveQuery } from '../../hooks/useLive'
import { fmtDateTime, tsToDate } from '../../components/results/common'
import type { McpConnection } from '../../types'
import { Panel as Card } from '../../features/qc/ui'
import { StatusChip, type StatusVariant } from '../../design/StatusChip'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { Button as DsButton } from '../../design/Button'
import { useBranch } from '../../branch/BranchProvider'
import '../../features/qc/qc.css'

const { Text, Paragraph } = Typography

// Shape written by the MCP server; every field is optional on purpose.
interface AuditRow {
  id: string
  at?: Timestamp
  connectionId?: string
  connectionLabel?: string
  label?: string
  tool?: string
  summary?: string
  args?: unknown
  ok?: boolean
  error?: string
}

// Callable errors end with the HTTP status (e.g. "[400]"); users don't need it.
const splitIps = (t?: string) => (t ?? '').split(/[\s,]+/).filter(Boolean)
const errText = (e: unknown) =>
  e instanceof Error ? e.message.replace(/\s*\[\d+\]\s*$/, '') : 'Something went wrong'

function statusOf(c: McpConnection): { text: string; color: StatusVariant } {
  if ((c as McpConnection & { status?: string }).status === 'pending') return { text: 'Waiting for code', color: 'caution' }
  if (c.revoked) return { text: 'Revoked', color: 'urgent' }
  const exp = tsToDate(c.expiresAt)
  if (exp && exp.getTime() < Date.now()) return { text: 'Expired', color: 'neutral' }
  return { text: 'Active', color: 'success' }
}

function GrantFields() {
  return (
    <>
      <Form.Item name="scopes" label="What this connection may read" extra="Finance numbers and bill-level tools need the Finance scope. Patient details stay hidden unless you add the masked-patient scope, which shows initials only.">
        <Checkbox.Group options={MCP_SCOPES.map((x) => ({ value: x.value, label: x.label }))} style={{ display: 'grid', gap: 4 }} />
      </Form.Item>
      <Form.Item name="tools" label="Tools it may call">
        <Checkbox.Group options={MCP_TOOLS.map((x) => ({ value: x.value, label: x.label }))} style={{ display: 'grid', gap: 4 }} />
      </Form.Item>
      <Space wrap>
        <Form.Item name="rowLimit" label="Row limit per call"><InputNumber min={1} max={5000} /></Form.Item>
        <Form.Item name="ips" label="Allowed IP addresses (optional)" extra="Comma separated; empty = any."><Input style={{ width: 280 }} /></Form.Item>
      </Space>
    </>
  )
}

export default function ConnectAiPage() {
  const { message } = App.useApp()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ url: string; label: string } | null>(null)
  const [form] = Form.useForm<{ label: string; days: number; consent: boolean; scopes: string[]; tools: string[]; rowLimit: number; ips: string }>()
  const [grantsFor, setGrantsFor] = useState<McpConnection | null>(null)
  const [gform] = Form.useForm<{ scopes: string[]; tools: string[]; rowLimit: number; ips: string }>()
  const [pending, setPending] = useState<{ id: string; label: string; sentTo: string; devOtp?: string } | null>(null)
  const [otp, setOtp] = useState('')
  const month = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7)
  const usage = useLiveDoc<{ calls?: number; byFeature?: Record<string, number> }>(fsDoc(db, 'labs', LAB_ID, 'aiUsage', month), [month])
  const lab = useLiveDoc<{ aiLimits?: { monthlyCap?: number }; aiConsent?: { at?: Timestamp; byName?: string } }>(labDoc(), [])

  const conns = useLiveQuery<McpConnection>(query(col('mcpConnections'), orderBy('createdAt', 'desc')), [])
  const audit = useLiveQuery<AuditRow>(query(col('mcpAudit'), orderBy('at', 'desc'), limit(50)), [])

  const copy = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t)
      message.success('Copied')
    } catch {
      message.error('Could not copy. Select the text and copy it manually.')
    }
  }

  const create = async () => {
    const v = await form.validateFields()
    setBusy(true)
    try {
      const res = await createMcpConnection({ label: v.label.trim(), days: v.days, consent: !!v.consent, scopes: v.scopes, tools: v.tools, rowLimit: v.rowLimit, ipAllowlist: splitIps(v.ips) })
      setOpen(false)
      form.resetFields()
      setOtp('')
      setPending({ id: res.id, label: v.label.trim(), sentTo: res.sentTo, devOtp: res.devOtp })
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const res = await confirmMcpConnection({ id: pending.id, otp: otp.trim() })
      setCreated({ url: res.url, label: pending.label })
      setPending(null)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (id: string) => {
    try {
      await revokeMcpConnection({ id })
      message.success('Connection revoked')
    } catch (e) {
      message.error(errText(e))
    }
  }

  const { branches } = useBranch()
  const [client, setClient] = useState<'claude' | 'chatgpt' | 'other'>('claude')
  const [done, setDone] = useState<Set<number>>(new Set())
  const STEPS: Record<typeof client, string[]> = {
    claude: [
      'Choose the assistant you will use. Here: Claude.',
      'Create a connection on this page (button at the top) and give it a recognisable label.',
      'Copy the connection address. It is shown only once, so paste it somewhere safe straight away.',
      'Open Claude and go to Settings, then Connectors.',
      'Choose Add custom connector.',
      'Type a name, paste the address and save.',
      'Start a new chat and ask something like "What did we collect last week, by department?" Check the activity table below shows the call.',
    ],
    chatgpt: [
      'Choose the assistant you will use. Here: ChatGPT or a similar assistant that accepts remote tools.',
      'Create a connection on this page and give it a recognisable label.',
      'Copy the connection address and keep it private.',
      'In the assistant, open its settings and find the area for connectors, apps or developer mode (the name differs between plans).',
      'Add a new remote server and pick the HTTP streaming type; no sign-in is needed because the address carries its own key.',
      'Paste the address, name it and confirm. Enable the connector for the chat you start.',
      'Ask a business question in that chat and confirm the call appears in the activity table below.',
    ],
    other: [
      'Pick any assistant or tool that supports remote MCP servers over streamable HTTP.',
      'Create a connection on this page.',
      'Copy the connection address.',
      'Find where the tool registers MCP servers.',
      'Add a remote server and select the streamable HTTP transport.',
      'Paste the address. No extra headers are required.',
      'Run a test question and check the activity table below.',
    ],
  }
  const steps = STEPS[client]

  return (
    <div>
      <PageHeader
        title="Connect AI (MCP)"
        subtitle="Let an AI assistant answer questions about your lab. Read-only, aggregated numbers only, every call logged."
        actions={<DsButton variant="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>Create connection</DsButton>}
      />
      <Card title="Connect in seven steps" style={{ marginBottom: 'var(--s-4)' }}>
        <Segmented aria-label="Assistant" value={client} onChange={(v) => { setClient(v); setDone(new Set()) }} options={[{ value: 'claude', label: 'Claude' }, { value: 'chatgpt', label: 'ChatGPT' }, { value: 'other', label: 'Other MCP client' }]} />
        <ol className="wizard" style={{ marginTop: 'var(--s-4)' }}>
          {steps.map((t, i) => (
            <li key={i} data-done={done.has(i)}>
              <label>
                <input
                  type="checkbox"
                  checked={done.has(i)}
                  onChange={() => setDone((d) => { const n = new Set(d); if (n.has(i)) n.delete(i); else n.add(i); return n })}
                />
                <span><strong>Step {i + 1}.</strong> {t}</span>
              </label>
            </li>
          ))}
        </ol>
        <Paragraph className="qc-muted" style={{ marginBottom: 0 }}>
          The connection is <Text strong>read-only</Text> and never exposes patient names, contact details or individual reports. Revoke it below at any time.
        </Paragraph>
      </Card>

      <Card title="AI usage this month" style={{ marginBottom: 'var(--s-4)' }}>
        <p style={{ marginTop: 0 }}>
          <Text strong>{usage.data?.calls ?? 0}</Text> AI calls of {lab.data?.aiLimits?.monthlyCap ?? 5000} allowed
          {usage.data?.byFeature ? ` (${Object.entries(usage.data.byFeature).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}.
        </p>
        <p className="qc-muted" style={{ marginBottom: 0 }}>
          Every call is logged without its content. Each admin gets a limited number of requests per minute.
          {lab.data?.aiConsent?.at ? ` AI was switched on with consent recorded by ${lab.data.aiConsent.byName ?? 'an admin'} on ${fmtDateTime(lab.data.aiConsent.at)}.` : ''}
        </p>
      </Card>

      <Card title="What the AI app can see" style={{ marginBottom: 'var(--s-4)' }}>
        <p className="qc-muted" style={{ marginTop: 0 }}>Aggregated figures for every branch of this lab. Access is lab-wide; revoke a connection to cut it off.</p>
        <ul className="howto">
          {branches.map((b) => (
            <li key={b.id}>
              {b.name} <StatusChip variant={b.active ? 'success' : 'neutral'}>{b.active ? 'Included' : 'Inactive branch'}</StatusChip>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Connected apps"
        style={{ marginBottom: 'var(--s-4)' }}
      >
        <Table<McpConnection>
          size="small"
          rowKey="id"
          loading={conns.loading}
          dataSource={conns.data}
          scroll={{ x: 'max-content' }}
          pagination={false}
          locale={{ emptyText: 'No connections yet' }}
          columns={[
            {
              title: 'Label',
              render: (_, c) => (
                <span>
                  {c.label} <Text type="secondary">...{c.tokenHint}</Text>
                </span>
              ),
            },
            { title: 'Created by', dataIndex: 'createdByName' },
            { title: 'Access', render: (_, c) => <Text type="secondary">{(c.scopes ?? DEFAULT_MCP_SCOPES).map((x) => x.replace('_READ', '').toLowerCase()).join(', ')}</Text> },
            { title: 'Created', render: (_, c) => fmtDateTime(c.createdAt) },
            { title: 'Expires', render: (_, c) => fmtDateTime(c.expiresAt) },
            { title: 'Last used', render: (_, c) => (c.lastUsedAt ? fmtDateTime(c.lastUsedAt) : <Text type="secondary">never</Text>) },
            {
              title: 'Status',
              render: (_, c) => {
                const s = statusOf(c)
                return <StatusChip variant={s.color}>{s.text}</StatusChip>
              },
            },
            {
              title: '',
              render: (_, c) =>
                !c.revoked && (
                  <Space>
                  <Button size="small" onClick={() => { setGrantsFor(c); gform.setFieldsValue({ scopes: c.scopes ?? DEFAULT_MCP_SCOPES, tools: c.tools ?? MCP_TOOLS.map((x) => x.value), rowLimit: c.rowLimit ?? 500, ips: (c.ipAllowlist ?? []).join(', ') }) }} aria-label={`Edit access for ${c.label}`}>Access</Button>
                  <Popconfirm
                    title="Revoke this connection?"
                    description="Anything using this URL stops working immediately."
                    okText="Revoke"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => revoke(c.id)}
                  >
                    <Button size="small" danger>
                      Revoke
                    </Button>
                  </Popconfirm>
                  </Space>
                ),
            },
          ]}
        />
      </Card>

      <Card title="Recent activity (latest 50)">
        <Table<AuditRow>
          size="small"
          rowKey="id"
          loading={audit.loading}
          dataSource={audit.data}
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }}
          locale={{ emptyText: 'No activity yet' }}
          columns={[
            { title: 'Time', render: (_, r) => fmtDateTime(r.at) },
            { title: 'Connection', render: (_, r) => r.connectionLabel ?? r.label ?? r.connectionId ?? '' },
            { title: 'Tool', render: (_, r) => (r.tool ? <Text code>{r.tool}</Text> : null) },
            {
              title: 'Request',
              render: (_, r) => (
                <Text type="secondary" ellipsis style={{ maxWidth: 360 }}>
                  {r.summary ?? (r.args ? JSON.stringify(r.args) : '')}
                </Text>
              ),
            },
            {
              title: 'Result',
              render: (_, r) =>
                r.ok === false ? <StatusChip variant="urgent">{r.error ?? 'error'}</StatusChip> : r.ok === true ? <StatusChip variant="success">ok</StatusChip> : null,
            },
          ]}
        />
      </Card>

      <Modal
        title={`Access for ${grantsFor?.label ?? ''}`}
        open={!!grantsFor}
        onCancel={() => setGrantsFor(null)}
        okText="Save access"
        onOk={async () => {
          const v = await gform.validateFields()
          try {
            await updateMcpConnection({ id: grantsFor!.id, scopes: v.scopes, tools: v.tools, rowLimit: v.rowLimit, ipAllowlist: splitIps(v.ips) })
            message.success('Access updated')
            setGrantsFor(null)
          } catch (e) {
            message.error(errText(e))
          }
        }}
        destroyOnHidden
      >
        <Form form={gform} layout="vertical"><GrantFields /></Form>
      </Modal>
      <Modal
        title="Create MCP connection"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={create}
        okText="Create connection"
        confirmLoading={busy}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ days: 30, scopes: DEFAULT_MCP_SCOPES, tools: MCP_TOOLS.map((x) => x.value), rowLimit: 500, ips: '' }}>
          <Form.Item name="label" label="Label" rules={[{ required: true, message: 'Give the connection a name' }]} extra="For example: Owner's Claude">
            <Input maxLength={60} />
          </Form.Item>
          <Form.Item name="days" label="Valid for">
            <Radio.Group options={[{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]} optionType="button" />
          </Form.Item>
          <GrantFields />
          <Form.Item name="consent" valuePropName="checked" rules={[{ validator: (_, v) => (v ? Promise.resolve() : Promise.reject(new Error('Consent is needed to connect'))) }]}>
            <Checkbox>I allow this external AI app to read my lab's aggregated, read-only figures. I can revoke it at any time.</Checkbox>
          </Form.Item>
          <Text type="secondary">A one-time code is sent to your registered phone or email. Enter it in the next step to activate the connection.</Text>
        </Form>
      </Modal>

      <Modal title="Enter the one-time code" open={!!pending} onCancel={() => setPending(null)} onOk={confirm} okText="Activate connection" confirmLoading={busy} okButtonProps={{ disabled: otp.trim().length !== 6 }} destroyOnHidden>
        <p>A 6-digit code was issued for <Text strong>{pending?.label}</Text>{pending?.sentTo ? ` and queued for ${pending.sentTo}` : ''}. It expires in 10 minutes.</p>
        {pending?.devOtp && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`Local test mode: the code is ${pending.devOtp}`} />}
        <Input aria-label="One-time code" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} onPressEnter={confirm} />
      </Modal>

      <Modal
        title={<Space><KeyOutlined /> Connection created</Space>}
        open={!!created}
        onCancel={() => setCreated(null)}
        footer={<DsButton variant="primary" onClick={() => setCreated(null)}>I have copied it</DsButton>}
        maskClosable={false}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="This URL is a secret and is shown only once"
          description="Anyone with it can read your lab's aggregated numbers until it expires or is revoked. Do not share it publicly."
        />
        <Text type="secondary">{created?.label}</Text>
        <Input.TextArea readOnly autoSize value={created?.url} style={{ margin: '6px 0 10px', fontFamily: 'monospace' }} onFocus={(e) => e.target.select()} />
        <Button icon={<CopyOutlined />} onClick={() => created && copy(created.url)}>
          Copy URL
        </Button>
      </Modal>
    </div>
  )
}
