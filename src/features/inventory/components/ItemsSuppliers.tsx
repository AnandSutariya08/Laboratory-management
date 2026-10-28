import { FieldGrid, FormSection, SettingRow } from '../../../design/FormLayout'
import { useState } from 'react'
import { App, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table } from 'antd'
import { addDoc, deleteDoc, updateDoc } from 'firebase/firestore'
import { col, docRef } from '../../../lib/db'
import { formatINR } from '../../../lib/money'
import type { InventoryData } from '../lib/useInventory'
import { CATEGORIES, UNITS, type InventoryItem, type Supplier } from '../types'
import { INV, itemSuppliers } from '../lib/stock'
import { Chip } from '../../qc/ui'
import { Segmented } from '../../../design/Segmented'
import { useActor } from './useActor'

type ItemForm = Omit<InventoryItem, 'id' | 'suppliers'> & { suppliers?: { supplierId?: string; priceRs?: number }[] }
type SupplierForm = Omit<Supplier, 'id' | 'itemsSupplied'> & { suppliedIds: string[] }

function ItemsTab({ inv }: { inv: InventoryData }) {
  const { message } = App.useApp()
  const actor = useActor()
  const [form] = Form.useForm<ItemForm>()
  const [editing, setEditing] = useState<InventoryItem | 'new' | null>(null)
  const [search, setSearch] = useState('')

  const rows = inv.items.filter((i) => `${i.name} ${i.code}`.toLowerCase().includes(search.toLowerCase()))

  const openForm = (it: InventoryItem | 'new') => {
    setEditing(it)
    form.resetFields()
    form.setFieldsValue(
      it === 'new'
        ? { category: 'reagent', unit: 'test', packSize: 1, reorderLevel: 0, defaultSupplierId: '', storage: '', lastPrice: 0, active: true, code: '' }
        : { ...it, suppliers: (it.suppliers ?? []).map((x) => ({ supplierId: x.supplierId, priceRs: x.price / 100 })) },
    )
  }
  const save = async () => {
    const v = await form.validateFields()
    const suppliers = (v.suppliers ?? []).filter((x) => x.supplierId).map((x) => ({ supplierId: x.supplierId!, price: Math.round((x.priceRs ?? 0) * 100) }))
    const data = { ...v, suppliers, taxPercent: v.taxPercent ?? 0, purchaseUnit: v.purchaseUnit ?? '', lastPrice: v.lastPrice ?? 0, defaultSupplierId: v.defaultSupplierId ?? '' }
    try {
      if (editing === 'new') await addDoc(col(INV.items), data)
      else if (editing) await updateDoc(docRef(INV.items, editing.id), data)
      message.success('Item saved')
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="Search items" onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
        {actor.canItems && <Button type="primary" onClick={() => openForm('new')}>Add item</Button>}
      </Space>
      <Table
        size="middle"
        rowKey="id"
        loading={inv.loading}
        dataSource={rows}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Code', dataIndex: 'code' },
          { title: 'Category', dataIndex: 'category' },
          { title: 'Unit', dataIndex: 'unit' },
          { title: 'Pack', align: 'right', render: (_, i) => (i.packSize > 1 ? `1 ${i.purchaseUnit || 'pack'} = ${i.packSize} ${i.unit}` : '-') },
          { title: 'GST', align: 'right', render: (_, i) => (i.taxPercent ? `${i.taxPercent}%` : '-') },
          { title: 'Reorder', dataIndex: 'reorderLevel', align: 'right' },
          { title: 'Supplier', render: (_, i) => itemSuppliers(i).map((x, k) => `${k === 0 ? '' : ' > '}${inv.supplierById.get(x.supplierId)?.name ?? '?'}`).join('') || '-' },
          { title: 'Last price', align: 'right', render: (_, i) => (i.lastPrice ? formatINR(i.lastPrice) : '-') },
          { title: 'Status', render: (_, i) => <Chip status={i.active ? 'active' : 'inactive'} /> },
          {
            title: '',
            render: (_, i) =>
              actor.canItems && (
                <Space size={4}>
                  <Button size="small" onClick={() => openForm(i)}>Edit</Button>
                  {actor.canDelete && (
                    <Popconfirm title="Delete this item?" onConfirm={() => deleteDoc(docRef(INV.items, i.id))}>
                      <Button size="small" danger>Delete</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
          },
        ]}
      />
      <Modal title={editing === 'new' ? 'Add item' : 'Edit item'} open={!!editing} onCancel={() => setEditing(null)} onOk={save} destroyOnHidden forceRender>
        <Form form={form} layout="vertical">
          <FormSection title="Item" description="What it is called and how it is counted in stock.">
            <FieldGrid min={200}>
              <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name="code" label="Code / SKU"><Input /></Form.Item>
              <Form.Item name="category" label="Category"><Select options={CATEGORIES.map((c) => ({ value: c, label: c }))} /></Form.Item>
              <Form.Item name="unit" label="Unit" rules={[{ required: true }]}><Select showSearch options={UNITS.map((c) => ({ value: c, label: c }))} /></Form.Item>
              <Form.Item name="storage" label="Storage temperature"><Input placeholder="2-8 C" /></Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Purchasing and stock levels" description="Stock and consumption are counted in the base unit; purchase orders can be entered in purchase units.">
            <FieldGrid min={200}>
              <Form.Item name="purchaseUnit" label="Purchase unit"><Select allowClear showSearch options={UNITS.map((c) => ({ value: c, label: c }))} /></Form.Item>
              <Form.Item name="packSize" label="Base units per purchase unit" tooltip="1 purchase unit = this many base units."><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
              <Form.Item name="taxPercent" label="GST"><InputNumber min={0} max={100} precision={2} addonAfter="%" style={{ width: '100%' }} /></Form.Item>
              <Form.Item name="reorderLevel" label="Reorder level"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Suppliers" description="Suppliers in order of preference, each with its price per base unit. The first one is filled in on new purchase orders.">
            <Form.Item name="defaultSupplierId" label="Default supplier">
              <Select allowClear options={inv.suppliers.map((s) => ({ value: s.id, label: s.name }))} />
            </Form.Item>
            <Form.List name="suppliers">
              {(fields, { add, remove }) => (
                <div>
                  {fields.map((f, idx) => (
                    <div key={f.key} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(140px, 1fr) minmax(130px, 160px) auto', gap: 'var(--s-3)', alignItems: 'start' }}>
                      <span style={{ paddingTop: 5 }}>{idx + 1}.</span>
                      <Form.Item name={[f.name, 'supplierId']} rules={[{ required: true, message: 'Pick a supplier' }]}><Select aria-label="Supplier" placeholder="Supplier" options={inv.suppliers.map((s) => ({ value: s.id, label: s.name }))} /></Form.Item>
                      <Form.Item name={[f.name, 'priceRs']}><InputNumber aria-label="Price per base unit" addonBefore="₹" min={0} precision={2} style={{ width: '100%' }} /></Form.Item>
                      <Button size="small" style={{ marginTop: 3 }} onClick={() => remove(f.name)}>Remove</Button>
                    </div>
                  ))}
                  <Button size="small" onClick={() => add({ supplierId: undefined, priceRs: 0 })}>Add supplier</Button>
                </div>
              )}
            </Form.List>
          </FormSection>
          <FormSection title="Status">
            <SettingRow label="Active" help="Inactive items are hidden from new orders and consumption." htmlFor="inv-item-active"><Form.Item name="active" valuePropName="checked" noStyle><Switch id="inv-item-active" /></Form.Item></SettingRow>
          </FormSection>
        </Form>
      </Modal>
    </>
  )
}

function SuppliersTab({ inv }: { inv: InventoryData }) {
  const { message } = App.useApp()
  const actor = useActor()
  const [form] = Form.useForm<SupplierForm>()
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null)
  const [search, setSearch] = useState('')
  const rows = inv.suppliers.filter((s) => `${s.name} ${s.contact} ${s.gstin}`.toLowerCase().includes(search.toLowerCase()))

  const openForm = (s: Supplier | 'new') => {
    setEditing(s)
    form.resetFields()
    form.setFieldsValue(
      s === 'new'
        ? { name: '', contact: '', phone: '', email: '', gstin: '', address: '', active: true, suppliedIds: [] }
        : { ...s, suppliedIds: s.itemsSupplied.map((x) => x.itemId) },
    )
  }
  const save = async () => {
    const { suppliedIds, ...rest } = await form.validateFields()
    const prev = editing && editing !== 'new' ? editing.itemsSupplied : []
    const itemsSupplied = suppliedIds.map((id) => prev.find((p) => p.itemId === id) ?? { itemId: id, lastPrice: inv.itemById.get(id)?.lastPrice ?? 0 })
    try {
      if (editing === 'new') await addDoc(col(INV.suppliers), { ...rest, itemsSupplied })
      else if (editing) await updateDoc(docRef(INV.suppliers, editing.id), { ...rest, itemsSupplied })
      message.success('Supplier saved')
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const remove = async (s: Supplier) => {
    if (inv.pos.some((p) => p.supplierId === s.id && ['draft', 'ordered', 'partially_received'].includes(p.status))) {
      return message.error('This supplier has open purchase orders')
    }
    await deleteDoc(docRef(INV.suppliers, s.id))
  }

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="Search suppliers" onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
        {actor.canSuppliers && <Button type="primary" onClick={() => openForm('new')}>Add supplier</Button>}
      </Space>
      <Table
        size="middle"
        rowKey="id"
        loading={inv.loading}
        dataSource={rows}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Contact', dataIndex: 'contact' },
          { title: 'Phone', dataIndex: 'phone' },
          { title: 'GSTIN', dataIndex: 'gstin' },
          {
            title: 'Items supplied (last price)',
            render: (_, s) => s.itemsSupplied.map((x) => <Chip key={x.itemId} status="neutral">{inv.itemById.get(x.itemId)?.name ?? '?'}: {formatINR(x.lastPrice)}</Chip>),
          },
          { title: 'Status', render: (_, s) => <Chip status={s.active ? 'active' : 'inactive'} /> },
          {
            title: '',
            render: (_, s) =>
              actor.canSuppliers && (
                <Space size={4}>
                  <Button size="small" onClick={() => openForm(s)}>Edit</Button>
                  {actor.canDelete && (
                    <Popconfirm title="Delete this supplier?" onConfirm={() => remove(s)}>
                      <Button size="small" danger>Delete</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
          },
        ]}
      />
      <Modal title={editing === 'new' ? 'Add supplier' : 'Edit supplier'} open={!!editing} onCancel={() => setEditing(null)} onOk={save} destroyOnHidden forceRender>
        <Form form={form} layout="vertical">
          <FormSection title="Supplier" description="Who the supplier is and how to reach them.">
            <FieldGrid min={200}>
              <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name="contact" label="Contact person"><Input /></Form.Item>
              <Form.Item name="phone" label="Phone"><Input /></Form.Item>
              <Form.Item name="email" label="Email"><Input /></Form.Item>
              <Form.Item name="gstin" label="GSTIN"><Input /></Form.Item>
            </FieldGrid>
            <Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item>
          </FormSection>
          <FormSection title="Items and status">
            <Form.Item name="suppliedIds" label="Items supplied">
              <Select mode="multiple" optionFilterProp="label" options={inv.items.map((i) => ({ value: i.id, label: i.name }))} />
            </Form.Item>
            <SettingRow label="Active" help="Inactive suppliers cannot be chosen on new purchase orders." htmlFor="inv-sup-active"><Form.Item name="active" valuePropName="checked" noStyle><Switch id="inv-sup-active" /></Form.Item></SettingRow>
          </FormSection>
        </Form>
      </Modal>
    </>
  )
}

export default function ItemsSuppliers({ inv }: { inv: InventoryData }) {
  const [tab, setTab] = useState<'items' | 'suppliers'>('items')
  return (
    <div>
      <div className="qc-subnav"><Segmented aria-label="Items or suppliers" value={tab} onChange={setTab} options={[{ value: 'items', label: 'Items' }, { value: 'suppliers', label: 'Suppliers' }]} /></div>
      {tab === 'items' ? <ItemsTab inv={inv} /> : <SuppliersTab inv={inv} />}
    </div>
  )
}
