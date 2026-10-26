import { useMemo, useState } from 'react'
import { DatePicker, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Tag, message } from 'antd'
import dayjs from 'dayjs'
import { DeleteOutlined, DownloadOutlined, EditOutlined, MinusCircleOutlined, PlusOutlined, ProfileOutlined, UploadOutlined } from '@ant-design/icons'
import { Button } from '../../design/Button'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { usePackages } from '../../hooks/useCatalogue'
import { formatINR, toPaise } from '../../lib/money'
import { InvoicesPanel } from './InvoicesPanel'
import { downloadCsv, parseCsvObjects } from './lib/csv'
import { removeMaster, saveMaster, useMaster } from './lib/master'
import { orderDate, useOrdersByPartner } from './lib/orders'
import { PriceListDrawer } from './RateListEditor'
import type { CorporateClient, CorporateEmployee, CorporatePlan } from './types'
import { ActiveChip, DataTable, FileButton, fmtDate, Spacer, Toolbar } from './ui'
import { dialogWidth } from '../../design/dialog'

type Tab = 'clients' | 'companies' | 'invoices' | 'patients'
const TYPES = [{ value: 'company', label: 'Company' }, { value: 'insurance', label: 'Insurance' }, { value: 'tpa', label: 'TPA' }]
const EMP_HEAD = ['employeeId', 'name', 'gender', 'age', 'phone', 'email', 'department']

export default function CorporateClientsPage() {
  const [tab, setTab] = useState<Tab>('clients')
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Partial<CorporateClient> | null>(null)
  const [pl, setPl] = useState<CorporateClient | null>(null)
  const [emp, setEmp] = useState<CorporateClient | null>(null)
  const [pc, setPc] = useState<string>('all')
  const clients = useMaster<CorporateClient>('corporateClients')
  const orders = useOrdersByPartner('corporateClientId', clients.data.map((c) => c.id))
  const rows = clients.data.filter((c) => !q.trim() || `${c.name} ${c.email} ${c.phone}`.toLowerCase().includes(q.toLowerCase()))
  const patientRows = useMemo(() => orders.data.filter((o) => pc === 'all' || o.corporateClientId === pc), [orders.data, pc])
  const nameOf = (id?: string) => clients.data.find((c) => c.id === id)?.name ?? ''

  return (
    <div>
      <PageHeader title="Corporate Clients" subtitle="Companies, insurers and TPAs billed on credit"
        actions={<Button variant="primary" icon={<PlusOutlined />} onClick={() => setEdit({ active: true, type: 'company', creditDays: 30, creditLimit: 0, employeeIdRequired: false, planPackageIds: [], companies: [] })}>Add client</Button>} />
      <div className="pt-tabs">
        <Segmented<Tab> aria-label="Corporate view" value={tab} onChange={setTab} options={[
          { value: 'clients', label: 'Corporate clients', count: clients.data.length },
          { value: 'companies', label: 'Company list' },
          { value: 'invoices', label: 'Invoices' },
          { value: 'patients', label: 'Patient details' },
        ]} />
      </div>

      {tab === 'clients' && (
        <DataTable<CorporateClient>
          loading={clients.loading}
          dataSource={rows}
          emptyTitle="No corporate clients yet"
          toolbar={
            <Toolbar>
              <Input.Search allowClear aria-label="Search clients" placeholder="Search name, email, phone" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
              <Spacer />
              <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('corporate-clients', [['name', 'email', 'phone', 'type', 'active', 'employees'], ...rows.map((c) => [c.name, c.email, c.phone, c.type, c.active, c.employees?.length ?? 0])])}>Export CSV</Button>
            </Toolbar>
          }
          columns={[
            { title: 'Corporate name', dataIndex: 'name' },
            { title: 'Email', dataIndex: 'email' },
            { title: 'Type', render: (_, c) => TYPES.find((t) => t.value === c.type)?.label },
            { title: 'Credit', render: (_, c) => <span className="pt-num">{c.creditDays} d / {formatINR(c.creditLimit ?? 0)}</span> },
            { title: 'Employees', align: 'right', render: (_, c) => <span className="pt-num">{c.employees?.length ?? 0}</span> },
            { title: 'Status', render: (_, c) => <ActiveChip active={c.active} /> },
            { title: 'Active', render: (_, c) => <Switch size="small" aria-label={`Active: ${c.name}`} checked={c.active} onChange={(v) => saveMaster('corporateClients', c.id, { active: v })} /> },
            {
              title: 'Actions',
              render: (_, c) => (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  <Button variant="text" icon={<EditOutlined />} aria-label={`Edit ${c.name}`} onClick={() => setEdit(c)} />
                  <Button variant="text" icon={<ProfileOutlined />} aria-label={`Price list for ${c.name}`} onClick={() => setPl(c)} />
                  <Button variant="text" icon={<UploadOutlined />} aria-label={`Employees of ${c.name}`} onClick={() => setEmp(c)} />
                  <Popconfirm title={`Delete ${c.name}?`} okText="Delete" onConfirm={() => removeMaster('corporateClients', c.id).catch((e) => message.error(e.message))}>
                    <Button variant="text" icon={<DeleteOutlined />} aria-label={`Delete ${c.name}`} />
                  </Popconfirm>
                </span>
              ),
            },
          ]}
        />
      )}

      {tab === 'companies' && (
        <DataTable<CorporateClient>
          loading={clients.loading}
          dataSource={clients.data}
          emptyTitle="No corporate clients yet"
          columns={[
            { title: 'Client', dataIndex: 'name' },
            {
              title: 'Companies under this client',
              render: (_, c) => (
                <span>
                  {(c.companies ?? []).map((n) => (
                    <Tag key={n} closable onClose={(e) => { e.preventDefault(); saveMaster('corporateClients', c.id, { companies: c.companies.filter((x) => x !== n) }) }}>{n}</Tag>
                  ))}
                </span>
              ),
            },
            {
              title: 'Add company',
              render: (_, c) => (
                <Input.Search aria-label={`Add company to ${c.name}`} placeholder="Company name" enterButton="Add" style={{ width: 240 }}
                  onSearch={(v, e) => { if (v.trim()) { saveMaster('corporateClients', c.id, { companies: [...(c.companies ?? []), v.trim()] }); (e as { currentTarget?: HTMLInputElement })?.currentTarget && ((e as { currentTarget: HTMLInputElement }).currentTarget.value = '') } }} />
              ),
            },
          ]}
        />
      )}

      {tab === 'invoices' && <InvoicesPanel kind="corporate" field="corporateClientId" parties={clients.data.map((c) => ({ id: c.id, name: c.name, address: c.address, creditDays: c.creditDays }))} />}

      {tab === 'patients' && (
        <DataTable
          loading={orders.loading}
          dataSource={patientRows}
          emptyTitle="No bills for corporate clients yet"
          emptyHint="Bills created with a corporate client appear here."
          toolbar={
            <Toolbar>
              <Select aria-label="Client" style={{ minWidth: 220 }} value={pc} onChange={setPc} options={[{ value: 'all', label: 'All clients' }, ...clients.data.map((c) => ({ value: c.id, label: c.name }))]} />
              <Spacer />
              <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('corporate-patients', [['date', 'client', 'bill', 'patient', 'patient no', 'tests', 'net', 'due'], ...patientRows.map((o) => [fmtDate(orderDate(o)), nameOf(o.corporateClientId), o.billNo, o.patientName, o.patientNo, o.items.map((i) => i.name).join('; '), o.net / 100, o.due / 100])])}>Export CSV</Button>
            </Toolbar>
          }
          columns={[
            { title: 'Date', render: (_, o) => fmtDate(orderDate(o)) },
            { title: 'Client', render: (_, o) => nameOf(o.corporateClientId) },
            { title: 'Bill', dataIndex: 'billNo' },
            { title: 'Patient', render: (_, o) => `${o.patientName} (${o.patientNo})` },
            { title: 'Tests', render: (_, o) => o.items.map((i) => i.name).join(', ') },
            { title: 'Net', align: 'right', render: (_, o) => <span className="pt-num">{formatINR(o.net)}</span> },
            { title: 'Due', align: 'right', render: (_, o) => <span className="pt-num">{formatINR(o.due)}</span> },
          ]}
        />
      )}

      <ClientDrawer value={edit} onClose={() => setEdit(null)} />
      <EmployeesModal client={emp} onClose={() => setEmp(null)} />
      <PriceListDrawer open={!!pl} onClose={() => setPl(null)} owner={pl && { collection: 'corporateClients', id: pl.id, name: pl.name, rateListId: pl.rateListId, kind: 'corporate' }} />
    </div>
  )
}

interface PlanForm { id?: string; name?: string; packageIds?: string[]; priceRs?: number; valid?: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null; active?: boolean }
const planToForm = (p: CorporatePlan): PlanForm => ({
  id: p.id, name: p.name, packageIds: p.packageIds, priceRs: (p.price ?? 0) / 100, active: p.active !== false,
  valid: p.validFrom || p.validTo ? [p.validFrom ? dayjs(p.validFrom) : null, p.validTo ? dayjs(p.validTo) : null] : null,
})

function ClientDrawer({ value, onClose }: { value: Partial<CorporateClient> | null; onClose: () => void }) {
  const [form] = Form.useForm()
  const pk = usePackages().data
  const submit = async () => {
    const v = await form.validateFields()
    try {
      const plans: CorporatePlan[] = ((v.plans ?? []) as PlanForm[])
        .filter((p) => p.name?.trim())
        .map((p) => ({
          id: p.id || crypto.randomUUID(),
          name: p.name!.trim(),
          packageIds: p.packageIds ?? [],
          price: toPaise(p.priceRs ?? 0),
          validFrom: p.valid?.[0] ? p.valid[0].format('YYYY-MM-DD') : '',
          validTo: p.valid?.[1] ? p.valid[1].format('YYYY-MM-DD') : '',
          active: p.active !== false,
        }))
      await saveMaster('corporateClients', value?.id ?? null, { ...v, plans, creditLimit: toPaise(v.creditLimitRs ?? 0), creditLimitRs: undefined, rateListId: value?.rateListId ?? '', companies: value?.companies ?? [], employees: value?.employees ?? [] })
      message.success('Saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Drawer open={!!value} onClose={onClose} size="large" destroyOnHidden title={value?.id ? 'Edit corporate client' : 'Add corporate client'}
      footer={<div className="pt-sticky-foot"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save</Button></div>}>
      <Form form={form} layout="vertical" initialValues={{ ...value, creditLimitRs: (value?.creditLimit ?? 0) / 100, plans: (value?.plans ?? []).map(planToForm) }}>
        <div className="pt-grid2">
          <Form.Item name="name" label="Company name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="type" label="Type"><Select options={TYPES} /></Form.Item>
          <Form.Item name="contactPerson" label="Contact person"><Input /></Form.Item>
          <Form.Item name="phone" label="Phone"><Input /></Form.Item>
          <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input /></Form.Item>
          <Form.Item name="loginEmail" label="Login email (future portal)" rules={[{ type: 'email' }]}><Input /></Form.Item>
        </div>
        <Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item>
        <Form.List name="plans">
          {(fields, { add, remove }) => (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Plans for employees</div>
              <div className="pt-muted" style={{ marginBottom: 8 }}>A plan is a set of packages at one price per employee, valid for a period. Registration offers only plans that are active and in date.</div>
              {fields.map((f) => (
                <div key={f.key} style={{ border: '1px solid var(--c-border, #ddd)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                  <Space align="baseline" wrap style={{ display: 'flex' }}>
                    <Form.Item name={[f.name, 'id']} hidden><Input /></Form.Item>
                    <Form.Item name={[f.name, 'name']} rules={[{ required: true, message: 'Plan name' }]}><Input aria-label="Plan name" placeholder="Plan name" style={{ width: 180 }} /></Form.Item>
                    <Form.Item name={[f.name, 'priceRs']}><InputNumber aria-label="Price per employee" addonBefore="₹" min={0} precision={2} placeholder="Per employee" style={{ width: 160 }} /></Form.Item>
                    <Form.Item name={[f.name, 'valid']}><DatePicker.RangePicker aria-label="Plan validity" allowEmpty={[true, true]} /></Form.Item>
                    <Form.Item name={[f.name, 'active']} valuePropName="checked" initialValue><Switch checkedChildren="Active" unCheckedChildren="Off" /></Form.Item>
                    <Button variant="text" aria-label="Remove plan" icon={<MinusCircleOutlined />} onClick={() => remove(f.name)} />
                  </Space>
                  <Form.Item name={[f.name, 'packageIds']} style={{ marginBottom: 0 }}>
                    <Select mode="multiple" aria-label="Plan packages" placeholder="Packages in this plan" optionFilterProp="label" options={pk.filter((p) => !p.disabled).map((p) => ({ value: p.id, label: p.name }))} />
                  </Form.Item>
                </div>
              ))}
              <Button icon={<PlusOutlined />} onClick={() => add({ active: true, packageIds: [], priceRs: 0 })}>Add plan</Button>
            </div>
          )}
        </Form.List>
        <Form.Item name="planPackageIds" label="Legacy package mapping" extra="Older clients only: packages offered without a priced plan.">
          <Select mode="multiple" optionFilterProp="label" options={pk.filter((p) => !p.disabled).map((p) => ({ value: p.id, label: p.name }))} />
        </Form.Item>
        <div className="pt-grid3">
          <Form.Item name="creditDays" label="Credit period (days)"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="creditLimitRs" label="Credit limit (Rs)"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
        </div>
        <Form.Item name="creditTerms" label="Credit terms"><Input.TextArea rows={2} /></Form.Item>
        <div className="pt-grid3">
          <Form.Item name="employeeIdRequired" label="Employee ID required" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="disableLetterhead" label="Disable letterhead" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="hidePlan" label="Hide corporate plan" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="active" label="Active" valuePropName="checked"><Switch /></Form.Item>
        </div>
      </Form>
    </Drawer>
  )
}

function EmployeesModal({ client, onClose }: { client: CorporateClient | null; onClose: () => void }) {
  const [pending, setPending] = useState<CorporateEmployee[] | null>(null)
  const list = pending ?? client?.employees ?? []
  const parse = (t: string) =>
    setPending(parseCsvObjects(t).filter((r) => r.employeeid || r.name).map((r) => ({ empId: r.employeeid ?? '', name: r.name ?? '', gender: r.gender ?? '', age: r.age ?? '', phone: r.phone ?? '', email: r.email ?? '', department: r.department ?? '' })))
  const save = async () => {
    if (!client || !pending) return onClose()
    try {
      await saveMaster('corporateClients', client.id, { employees: pending })
      message.success(`Saved ${pending.length} employees`)
      setPending(null)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Modal open={!!client} onCancel={() => { setPending(null); onClose() }} title={`Employees: ${client?.name ?? ''}`} okText="Save" onOk={save} destroyOnHidden width={dialogWidth(720)}>
      <Toolbar>
        <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('employee-template', [EMP_HEAD, ['E001', 'Asha Rao', 'female', '32', '9999999999', 'asha@example.com', 'Finance']])}>Download template</Button>
        <FileButton label="Upload CSV" icon={<UploadOutlined />} onText={parse} />
        {pending && <span className="pt-muted">{pending.length} rows ready; Save replaces the list</span>}
      </Toolbar>
      <DataTable<CorporateEmployee & { id: string }>
        loading={false}
        dataSource={list.map((e, i) => ({ ...e, id: `${i}` }))}
        emptyTitle="No employees uploaded"
        columns={[{ title: 'Employee ID', dataIndex: 'empId' }, { title: 'Name', dataIndex: 'name' }, { title: 'Gender', dataIndex: 'gender' }, { title: 'Age', dataIndex: 'age' }, { title: 'Phone', dataIndex: 'phone' }, { title: 'Department', dataIndex: 'department' }]}
      />
    </Modal>
  )
}
