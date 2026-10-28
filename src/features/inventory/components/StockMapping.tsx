import { useMemo, useState } from 'react'
import { App, Button, Form, InputNumber, Input, Popconfirm, Select, Space, Table } from 'antd'
import { deleteDoc, setDoc } from 'firebase/firestore'
import { docRef } from '../../../lib/db'
import { useTests } from '../../../hooks/useCatalogue'
import type { InventoryData } from '../lib/useInventory'
import type { StockMapping as Mapping } from '../types'
import { INV } from '../lib/stock'
import { useActor } from './useActor'
import { FieldGrid } from '../../../design/FormLayout'
import { Panel } from '../../qc/ui'

export default function StockMapping({ inv }: { inv: InventoryData }) {
  const { message } = App.useApp()
  const actor = useActor()
  const tests = useTests().data
  const testById = useMemo(() => new Map(tests.map((t) => [t.id, t])), [tests])
  const [testId, setTestId] = useState<string>()
  const [itemId, setItemId] = useState<string>()
  const [qty, setQty] = useState<number | null>(1)
  const [search, setSearch] = useState('')

  const save = async (m: Pick<Mapping, 'testId' | 'itemId' | 'qtyPerTest'>) => {
    try {
      await setDoc(docRef(INV.mappings, `${m.testId}_${m.itemId}`), m)
      message.success('Mapping saved')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const rows = inv.mappings
    .filter((m) => {
      const q = search.toLowerCase()
      return !q || (testById.get(m.testId)?.name ?? '').toLowerCase().includes(q) || (inv.itemById.get(m.itemId)?.name ?? '').toLowerCase().includes(q)
    })
    .sort((a, b) => (testById.get(a.testId)?.name ?? '').localeCompare(testById.get(b.testId)?.name ?? ''))

  return (
    <Space vertical size="middle" style={{ width: '100%' }}>
      {actor.canMapping && (
        <Panel size="small" title="Map a test to a consumable">
          <Form layout="vertical" component="div">
            <FieldGrid min={240}>
              <Form.Item label="Test"><Select aria-label="Test" showSearch optionFilterProp="label" placeholder="Choose a test" value={testId} onChange={setTestId} options={tests.filter((t) => !t.disabled).map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))} /></Form.Item>
              <Form.Item label="Consumable item"><Select aria-label="Item" showSearch optionFilterProp="label" placeholder="Choose an item" value={itemId} onChange={setItemId} options={inv.items.filter((i) => i.active).map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` }))} /></Form.Item>
              <Form.Item label="Quantity used per test"><InputNumber aria-label="Quantity per test" min={0} value={qty} onChange={setQty} addonAfter={itemId ? `${inv.itemById.get(itemId)?.unit} / test` : 'per test'} style={{ width: '100%' }} /></Form.Item>
            </FieldGrid>
            <Button type="primary" disabled={!testId || !itemId || !qty || qty <= 0} onClick={() => testId && itemId && qty && save({ testId, itemId, qtyPerTest: qty })}>Save mapping</Button>
          </Form>
          <div style={{ color: 'var(--c-on-surface-variant)', marginTop: 8, fontSize: 12 }}>
            When a sample is received, mapped quantities are consumed from stock automatically (earliest expiry first). A test can use several items.
          </div>
        </Panel>
      )}
      <Input.Search allowClear placeholder="Search tests or items" onChange={(e) => setSearch(e.target.value)} style={{ width: 280 }} />
      <Table
        size="middle"
        rowKey="id"
        loading={inv.loading}
        dataSource={rows}
        columns={[
          { title: 'Test', render: (_, m) => testById.get(m.testId)?.name ?? m.testId },
          { title: 'Item', render: (_, m) => inv.itemById.get(m.itemId)?.name ?? m.itemId },
          {
            title: 'Qty per test',
            render: (_, m) => {
              const unit = inv.itemById.get(m.itemId)?.unit
              return actor.canMapping ? (
                <InputNumber min={0} defaultValue={m.qtyPerTest} addonAfter={unit} style={{ width: 170 }} onBlur={(e) => {
                  const v = Number(e.target.value)
                  if (v > 0 && v !== m.qtyPerTest) save({ ...m, qtyPerTest: v })
                }} />
              ) : (
                `${m.qtyPerTest} ${unit ?? ''}`
              )
            },
          },
          { title: 'In stock', align: 'right', render: (_, m) => `${inv.levels.get(m.itemId)?.qty ?? 0} ${inv.itemById.get(m.itemId)?.unit ?? ''}` },
          {
            title: 'Est. tests remaining',
            align: 'right',
            sorter: (a, b) => Math.floor((inv.levels.get(a.itemId)?.qty ?? 0) / (a.qtyPerTest || 1)) - Math.floor((inv.levels.get(b.itemId)?.qty ?? 0) / (b.qtyPerTest || 1)),
            render: (_, m) => <b>{m.qtyPerTest > 0 ? Math.floor((inv.levels.get(m.itemId)?.qty ?? 0) / m.qtyPerTest) : '-'}</b>,
          },
          {
            title: '',
            render: (_, m) =>
              actor.canDelete && (
                <Popconfirm title="Remove this mapping?" onConfirm={() => deleteDoc(docRef(INV.mappings, m.id))}>
                  <Button size="small" danger>Remove</Button>
                </Popconfirm>
              ),
          },
        ]}
      />
    </Space>
  )
}
