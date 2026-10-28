import { useMemo, useState } from 'react'
import { App, Form, Input, InputNumber, Modal, Radio, Select, Switch, Table } from 'antd'
import { AppstoreOutlined, BarsOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, PlusOutlined } from '@ant-design/icons'
import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { auditPriceChange, auditBulkPriceChange } from '../../features/settings/audit'
import { CopyToBranchesModal } from './CopyToBranches'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useAuth, can } from '../../auth/AuthProvider'
import { col, docRef, paths } from '../../lib/db'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { downloadText } from './helpers'
import { inactivePackageMembers } from './flags'
import { PACKAGE_CATEGORY_LABEL, type PackageCategory, type PackageExt } from './ext'
import { CsvUpload, commitBatch, csvLine, headerIndex } from './shared'
import './catalogue.css'
import { dialogWidth } from '../../design/dialog'

interface PackageForm {
  code: string
  name: string
  description: string
  price: number
  disabled: boolean
  category: PackageCategory
  gender: 'both' | 'male' | 'female'
  showTestsOnBill: boolean
  preCollectionGuidelines: string
}

export default function PackagesPage() {
  const { message, modal } = App.useApp()
  const { profile } = useAuth()
  const canEdit = can(profile, 'catalogue.edit')
  const canPrice = can(profile, 'catalogue.price')
  const canDelete = can(profile, 'catalogue.delete')
  const [copyId, setCopyId] = useState<string | null>(null)
  const maps = useCatalogueMaps()
  const { tests, testById } = maps
  const packages = maps.packages as PackageExt[]
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<PackageExt | 'new' | null>(null)
  const [items, setItems] = useState<string[]>([])
  const [form] = Form.useForm<PackageForm>()
  const [viewAll, setViewAll] = useState<PackageExt | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulk, setBulk] = useState<{ kind: 'percent' | 'flat'; amount: number }>({ kind: 'percent', amount: 0 })

  const sumOf = (ids: string[]) => ids.reduce((s, id) => s + (testById.get(id)?.price ?? 0), 0)
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return packages.filter((p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))
  }, [packages, search])

  const open = (p: PackageExt | 'new', copy?: PackageExt) => {
    setEditing(p)
    const base = copy ?? (p === 'new' ? null : p)
    setItems(base ? [...base.testIds] : [])
    form.setFieldsValue({
      code: copy ? '' : base?.code ?? '',
      name: copy ? '' : base?.name ?? '',
      description: base?.description ?? '',
      price: base ? toRupees(base.price) : 0,
      disabled: base?.disabled ?? false,
      category: base?.category ?? 'general',
      gender: base?.gender ?? 'both',
      showTestsOnBill: base?.showTestsOnBill ?? true,
      preCollectionGuidelines: base?.preCollectionGuidelines ?? '',
    })
  }

  // Adding a package expands into its member tests (no nested packages are stored).
  const addEntry = (value: string) => {
    const [kind, id] = value.split(':')
    const ids = kind === 'p' ? packages.find((p) => p.id === id)?.testIds ?? [] : [id]
    setItems((cur) => [...cur, ...ids.filter((x) => !cur.includes(x))])
  }

  const save = async () => {
    const v = await form.validateFields()
    const code = v.code.trim().toUpperCase()
    const id = editing && editing !== 'new' ? editing.id : null
    if (packages.some((p) => p.code.toUpperCase() === code && p.id !== id)) return message.error(`Package code ${code} already exists`)
    if (items.length === 0) return message.error('Add at least one test')
    const data = { code, name: v.name.trim(), description: v.description ?? '', price: toPaise(v.price), testIds: items, disabled: !!v.disabled, category: v.category ?? 'general', gender: v.gender ?? 'both', showTestsOnBill: v.showTestsOnBill !== false, preCollectionGuidelines: (v.preCollectionGuidelines ?? '').trim() }
    try {
      await setDoc(id ? docRef(paths.packages, id) : doc(col(paths.packages)), data, { merge: true })
      const before = id ? packages.find((x) => x.id === id) : null
      if (before && before.price !== data.price) void auditPriceChange('package', `${code} ${data.name}`, `packages/${id}`, before.price, data.price)
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const remove = (p: PackageExt) =>
    modal.confirm({
      title: `Delete package "${p.name}"?`,
      content: 'Existing bills keep their copy of the package. It is hidden, not erased: restore it from Test catalogue > Deleted items.',
      okButtonProps: { danger: true },
      onOk: () => setDoc(docRef(paths.packages, p.id), { deleted: true, deletedAt: serverTimestamp() }, { merge: true }),
    })

  const exportCsv = () =>
    downloadText('packages.csv', [
      csvLine(['package_code', 'package_name', 'price', 'test_codes']),
      ...rows.map((p) => csvLine([p.code, p.name, toRupees(p.price), p.testIds.map((i) => testById.get(i)?.code).filter(Boolean).join('|')])),
    ].join('\n'))

  const upload = async (data: string[][]) => {
    const idx = headerIndex(data[0] ?? [])
    if (['package_code', 'package_name', 'price', 'test_codes'].some((h) => idx(h) < 0)) return message.error('Needs columns package_code, package_name, price, test_codes')
    const idByCode = new Map(tests.map((t) => [t.code.toUpperCase(), t.id]))
    const byCode = new Map(packages.map((p) => [p.code.toUpperCase(), p]))
    const problems: string[] = []
    const ops: Parameters<typeof commitBatch>[0] = []
    data.slice(1).forEach((r, i) => {
      const code = (r[idx('package_code')] ?? '').trim().toUpperCase()
      const price = Number(r[idx('price')])
      const codes = (r[idx('test_codes')] ?? '').split('|').map((x) => x.trim().toUpperCase()).filter(Boolean)
      const unknown = codes.filter((c) => !idByCode.has(c))
      if (!code || !Number.isFinite(price) || unknown.length || !codes.length) {
        problems.push(`Row ${i + 2}: ${!code ? 'missing code' : !Number.isFinite(price) ? 'bad price' : unknown.length ? `unknown tests ${unknown.join(', ')}` : 'no tests'}`)
        return
      }
      const prev = byCode.get(code)
      const ref = prev ? docRef(paths.packages, prev.id) : doc(col(paths.packages))
      ops.push((b) =>
        b.set(ref, { code, name: (r[idx('package_name')] ?? '').trim() || code, price: toPaise(price), testIds: codes.map((c) => idByCode.get(c)!), disabled: prev?.disabled ?? false }, { merge: true }))
    })
    try {
      await commitBatch(ops)
      if (problems.length) modal.warning({ title: `Imported ${ops.length}, skipped ${problems.length}`, content: problems.slice(0, 10).join('\n'), styles: { body: { whiteSpace: 'pre-line' } } })
      else message.success(`Imported ${ops.length} package(s)`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const bulkPreview = useMemo(
    () => packages.map((p) => ({ p, next: Math.max(0, Math.round((bulk.kind === 'percent' ? p.price * (1 + bulk.amount / 100) : p.price + toPaise(bulk.amount)) / 100) * 100) })).filter((r) => r.next !== r.p.price),
    [packages, bulk],
  )
  const applyBulk = async () => {
    try {
      await commitBatch(bulkPreview.map((r) => (b) => b.set(docRef(paths.packages, r.p.id), { price: r.next }, { merge: true })))
      void auditBulkPriceChange('Package bulk price update', bulkPreview.length, 'packages')
      message.success(`Updated ${bulkPreview.length} package price(s)`)
      setBulkOpen(false)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const sum = sumOf(items)
  const priceNow = Form.useWatch('price', form) ?? 0
  const discount = sum - toPaise(priceNow)

  const savings = (p: PackageExt) => {
    const s = sumOf(p.testIds)
    return s > p.price ? <StatusChip variant="success">Saves {formatINR(s - p.price)}</StatusChip> : s < p.price ? <StatusChip variant="caution">Above sum</StatusChip> : null
  }
  const statusChip = (p: PackageExt) => {
    const bad = inactivePackageMembers(p, testById)
    return (
      <>
        <StatusChip variant={p.disabled ? 'neutral' : 'success'}>{p.disabled ? 'Disabled' : 'Active'}</StatusChip>
        {bad.length > 0 && <StatusChip variant="caution">{`${bad.length} member test${bad.length > 1 ? 's' : ''} inactive`}</StatusChip>}
      </>
    )
  }

  return (
    <div>
      <PageHeader
        title="Packages"
        subtitle={`${packages.length} packages`}
        actions={canEdit && <Button variant="primary" icon={<PlusOutlined />} onClick={() => open('new')}>New package</Button>}
      />
      <div className="cat-toolbar">
        <Input.Search allowClear aria-label="Search packages" placeholder="Search name or code" style={{ width: 260 }} onChange={(e) => setSearch(e.target.value)} />
        <Segmented<'grid' | 'list'> size="small" aria-label="View" value={view} onChange={setView}
          options={[{ value: 'grid', label: 'Grid', icon: <AppstoreOutlined /> }, { value: 'list', label: 'List', icon: <BarsOutlined /> }]} />
        <span className="cat-toolbar__grow" />
        <Button disabled={!canPrice} onClick={() => setBulkOpen(true)}>Bulk price update</Button>
        <CsvUpload disabled={!canEdit} onRows={upload}>Upload CSV</CsvUpload>
        <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export</Button>
      </div>

      {rows.length === 0 ? (
        <Card><EmptyState title="No packages" description="Create a package to bundle tests at a package price." /></Card>
      ) : view === 'grid' ? (
        <div className="cat-grid">
          {rows.map((p) => (
            <Card key={p.id} as="article">
              <div className="cat-pkg">
                <div className="cat-pkg__top">
                  <div>
                    <h2 className="cat-pkg__name">{p.name}</h2>
                    <span className="cat-code">{p.code}</span>
                  </div>
                  <div className="cat-pkg__price">{formatINR(p.price)}</div>
                </div>
                <div className="cat-toolbar" style={{ margin: 0 }}>{statusChip(p)}{savings(p)}</div>
                <div className="cat-pkg__tests">
                  {p.testIds.slice(0, 4).map((id) => <span key={id} className="cat-code">{testById.get(id)?.code ?? id}</span>)}
                  {p.testIds.length > 4 && <Button variant="text" onClick={() => setViewAll(p)}>{`View all (${p.testIds.length})`}</Button>}
                </div>
                <div className="cat-pkg__actions">
                  <Button disabled={!canEdit} onClick={() => open(p)}>Edit</Button>
                  <Button variant="text" disabled={!canEdit} onClick={() => setCopyId(p.id)}>Branches</Button>
                  <Button variant="text" icon={<DeleteOutlined />} aria-label={`Delete ${p.name}`} disabled={!canDelete} onClick={() => remove(p)} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Table<PackageExt>
            rowKey="id"
            dataSource={rows}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            columns={[
              { title: 'Code', dataIndex: 'code', width: 110, render: (c: string) => <span className="cat-code">{c}</span> },
              { title: 'Name', dataIndex: 'name' },
              { title: 'Tests', render: (_, p) => <Button variant="text" onClick={() => setViewAll(p)}>{`${p.testIds.length} tests`}</Button> },
              { title: 'Package price', width: 130, render: (_, p) => formatINR(p.price) },
              { title: 'Sum of tests', width: 220, render: (_, p) => <span>{formatINR(sumOf(p.testIds))} {savings(p)}</span> },
              { title: 'Status', width: 110, render: (_, p) => statusChip(p) },
              {
                title: 'Actions', width: 160,
                render: (_, p) => (
                  <span className="cat-toolbar" style={{ margin: 0 }}>
                    <Button variant="text" disabled={!canEdit} onClick={() => open(p)} aria-label={`Edit ${p.name}`}>Edit</Button>
                    <Button variant="text" disabled={!canEdit} onClick={() => setCopyId(p.id)} aria-label={`Copy ${p.name} to branches`}>Branches</Button>
                    <Button variant="text" disabled={!canDelete} onClick={() => remove(p)} aria-label={`Delete ${p.name}`}>Delete</Button>
                  </span>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Modal title={editing === 'new' ? 'New package' : 'Edit package'} open={!!editing} onOk={save} okText={editing === 'new' ? 'Create' : 'Save'} onCancel={() => setEditing(null)} width={dialogWidth(720)} destroyOnHidden>
        <Form form={form} layout="vertical">
          <div className="cat-toolbar">
            <Select showSearch optionFilterProp="label" placeholder="Copy from existing package" aria-label="Copy from package" style={{ width: 280 }} suffixIcon={<CopyOutlined />}
              options={packages.filter((p) => editing === 'new' || (editing && p.id !== editing.id)).map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))}
              onChange={(id) => { const src = packages.find((p) => p.id === id); if (src) open(editing ?? 'new', src) }} />
          </div>
          <Form.Item name="name" label="Package name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="code" label="Package code" rules={[{ required: true }]}><Input style={{ width: 200 }} /></Form.Item>
          <Form.Item name="description" label="Description"><Input.TextArea rows={2} /></Form.Item>
          <div className="cat-toolbar">
            <Form.Item name="category" label="Category"><Select style={{ width: 200 }} options={(Object.keys(PACKAGE_CATEGORY_LABEL) as PackageCategory[]).map((k) => ({ value: k, label: PACKAGE_CATEGORY_LABEL[k] }))} /></Form.Item>
            <Form.Item name="gender" label="Applies to"><Select style={{ width: 140 }} options={[{ value: 'both', label: 'Everyone' }, { value: 'male', label: 'Male only' }, { value: 'female', label: 'Female only' }]} /></Form.Item>
            <Form.Item name="showTestsOnBill" label="Show tests on bill" valuePropName="checked"><Switch /></Form.Item>
          </div>
          <Form.Item name="preCollectionGuidelines" label="Pre-collection guidelines" extra="Fasting or preparation instructions shown at registration."><Input.TextArea rows={2} /></Form.Item>
          {items.some((id) => !testById.get(id) || testById.get(id)?.disabled) && <p className="cat-warn">Some member tests are disabled or deleted; billing will warn and leave them out after confirmation.</p>}
          <Form.Item label="Add test or package">
            <Select showSearch optionFilterProp="label" placeholder="Search tests and packages" value={null as unknown as string} onChange={addEntry}
              options={[
                { label: 'Tests', options: tests.filter((t) => !t.disabled && !items.includes(t.id)).map((t) => ({ value: `t:${t.id}`, label: `${t.code} - ${t.name} (${formatINR(t.price)})` })) },
                { label: 'Packages (adds their tests)', options: packages.filter((p) => !editing || editing === 'new' || p.id !== editing.id).map((p) => ({ value: `p:${p.id}`, label: `${p.code} - ${p.name}` })) },
              ]} />
          </Form.Item>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={items.map((id, i) => ({ id, sr: i + 1 }))}
            locale={{ emptyText: 'No tests added' }}
            columns={[
              { title: 'Sr', dataIndex: 'sr', width: 60 },
              { title: 'Test', render: (_, r) => testById.get(r.id)?.name ?? r.id },
              { title: 'Price', width: 120, render: (_, r) => formatINR(testById.get(r.id)?.price ?? 0) },
              { title: 'Action', width: 80, render: (_, r) => <Button variant="text" icon={<DeleteOutlined />} aria-label={`Remove ${testById.get(r.id)?.name ?? r.id}`} onClick={() => setItems((c) => c.filter((x) => x !== r.id))} /> },
            ]}
          />
          <div className="cat-toolbar" style={{ marginTop: 'var(--s-4)' }}>
            <Form.Item name="price" label="Package price (₹)" rules={[{ required: true }]} style={{ margin: 0 }}><InputNumber min={0} precision={2} disabled={editing !== 'new' && !canPrice} /></Form.Item>
            <span>Total of tests: <b>{formatINR(sum)}</b></span>
            {items.length > 0 && (discount > 0 ? <StatusChip variant="success">Discount {formatINR(discount)} ({sum ? Math.round((discount / sum) * 100) : 0}%)</StatusChip> : discount < 0 ? <StatusChip variant="caution">Above sum by {formatINR(-discount)}</StatusChip> : <StatusChip>Equal to sum</StatusChip>)}
            <Form.Item name="disabled" label="Disabled" valuePropName="checked" style={{ margin: 0 }}><Switch /></Form.Item>
          </div>
        </Form>
      </Modal>

      <Modal title={viewAll ? `${viewAll.name} - included tests` : ''} open={!!viewAll} onCancel={() => setViewAll(null)} footer={null} destroyOnHidden>
        <Table size="small" rowKey="id" pagination={false} dataSource={(viewAll?.testIds ?? []).map((id) => ({ id }))}
          columns={[
            { title: 'Test', render: (_, r) => testById.get(r.id)?.name ?? r.id },
            { title: 'Price', width: 120, render: (_, r) => formatINR(testById.get(r.id)?.price ?? 0) },
          ]} />
      </Modal>

      <CopyToBranchesModal open={!!copyId} packageIds={copyId ? [copyId] : []} onClose={() => setCopyId(null)} />
      <Modal title="Bulk price update" open={bulkOpen} onCancel={() => setBulkOpen(false)} onOk={applyBulk} okText={`Apply to ${bulkPreview.length}`} okButtonProps={{ disabled: bulkPreview.length === 0 }} destroyOnHidden>
        <div className="cat-toolbar">
          <Radio.Group optionType="button" value={bulk.kind} onChange={(e) => setBulk((b) => ({ ...b, kind: e.target.value }))} options={[{ value: 'percent', label: 'By percent' }, { value: 'flat', label: 'By amount (₹)' }]} />
          <InputNumber aria-label="Change (negative to reduce)" value={bulk.amount} onChange={(v) => setBulk((b) => ({ ...b, amount: v ?? 0 }))} suffix={bulk.kind === 'percent' ? '%' : '₹'} />
        </div>
        <Table size="small" rowKey={(r) => r.p.id} pagination={{ pageSize: 6, showSizeChanger: false }} dataSource={bulkPreview}
          locale={{ emptyText: 'No price would change.' }}
          columns={[
            { title: 'Package', render: (_, r) => r.p.name },
            { title: 'Current', width: 110, render: (_, r) => formatINR(r.p.price) },
            { title: 'New', width: 110, render: (_, r) => formatINR(r.next) },
          ]} />
      </Modal>
    </div>
  )
}
