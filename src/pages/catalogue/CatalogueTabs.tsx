import { useMemo, useState } from 'react'
import { FieldGrid, FormSection, SettingRow } from '../../design/FormLayout'
import { App, ColorPicker, Form, Input, Modal, Switch, Table } from 'antd'
import { serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { PlusOutlined, DownloadOutlined, HolderOutlined } from '@ant-design/icons'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { col, docRef, paths } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { Select } from 'antd'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import type { Department } from '../../types'
import { downloadText, slug } from './helpers'
import { fmtTat, type ParameterExt, type SampleTypeExt, type TestExt } from './ext'
import { UnmappedInbox } from './UnmappedInbox'
import { CsvUpload, EditableText, TatInput, commitBatch, csvLine, headerIndex, mergeOp } from './shared'


// ---- Departments ----------------------------------------------------------
export function DepartmentsTab({ canEdit, canDelete = canEdit }: { canEdit: boolean; canDelete?: boolean }) {
  const { message, modal } = App.useApp()
  const { departments, tests } = useCatalogueMaps()
  const templates = useLiveQuery<{ id: string; name: string }>(col('reportTemplates'), []).data
  const [editing, setEditing] = useState<Partial<Department> | null>(null)
  const [form] = Form.useForm<{ name: string; order: number; active: boolean; reportTemplateId: string }>()
  const [dragId, setDragId] = useState<string | null>(null)
  const [moveFrom, setMoveFrom] = useState<Department | null>(null)
  const [moveTo, setMoveTo] = useState<string | undefined>()
  const open = (d: Partial<Department>) => {
    setEditing(d)
    form.setFieldsValue({ name: d.name ?? '', order: d.order ?? departments.length + 1, active: d.active !== false, reportTemplateId: d.reportTemplateId ?? '' })
  }
  const save = async () => {
    const v = await form.validateFields()
    const id = editing?.id ?? slug(v.name)
    try {
      await setDoc(docRef(paths.departments, id), { name: v.name.trim(), order: Number(v.order), active: v.active !== false, reportTemplateId: v.reportTemplateId ?? '', deleted: false }, { merge: true })
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const usedBy = (d: Department) => tests.filter((t) => t.departmentId === d.id && !(t as { deleted?: boolean }).deleted)
  const softDelete = (d: Department) => setDoc(docRef(paths.departments, d.id), { deleted: true, deletedAt: serverTimestamp() }, { merge: true })
  const remove = (d: Department) => {
    if (usedBy(d).length) {
      setMoveFrom(d)
      setMoveTo(undefined)
      return
    }
    modal.confirm({
      title: `Delete department "${d.name}"?`,
      content: 'It is hidden, not erased. Restore it from Deleted items.',
      okButtonProps: { danger: true },
      onOk: () => softDelete(d),
    })
  }
  const moveAndDelete = async () => {
    if (!moveFrom || !moveTo) return
    try {
      await commitBatch(usedBy(moveFrom).map((t) => mergeOp(docRef(paths.tests, t.id), { departmentId: moveTo })))
      await softDelete(moveFrom)
      message.success(`Moved ${usedBy(moveFrom).length} test(s) and deleted ${moveFrom.name}`)
      setMoveFrom(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const drop = async (overId: string) => {
    if (!dragId || dragId === overId) return
    const ids = departments.map((d) => d.id)
    ids.splice(ids.indexOf(dragId), 1)
    ids.splice(ids.indexOf(overId), 0, dragId)
    setDragId(null)
    await commitBatch(ids.map((id, i) => mergeOp(docRef(paths.departments, id), { order: i + 1 }))).catch((e) => message.error((e as Error).message))
  }
  return (
    <div className="cat-stack">
      <div className="cat-toolbar">
        <Button icon={<PlusOutlined />} disabled={!canEdit} onClick={() => open({})}>Add department</Button>
        <span className="cat-muted">Drag a row to change the report order.</span>
      </div>
      <Table<Department>
        rowKey="id"
        dataSource={departments}
        pagination={false}
        locale={{ emptyText: <EmptyState title="No departments yet" /> }}
        onRow={(d) => ({
          draggable: canEdit,
          onDragStart: () => setDragId(d.id),
          onDragOver: (e) => e.preventDefault(),
          onDrop: () => void drop(d.id),
          style: { cursor: canEdit ? 'grab' : undefined, opacity: dragId === d.id ? 0.5 : 1 },
        })}
        columns={[
          { title: '', width: 36, render: () => <HolderOutlined aria-hidden="true" /> },
          { title: 'Order', dataIndex: 'order', width: 80 },
          { title: 'Department name', dataIndex: 'name' },
          { title: 'Tests', width: 80, render: (_, d) => usedBy(d).length },
          {
            title: 'Report template', width: 170,
            render: (_, d) => templates.find((t) => t.id === d.reportTemplateId)?.name ?? <span className="cat-muted">Lab default</span>,
          },
          {
            title: 'Active', width: 90,
            render: (_, d) => <Switch size="small" aria-label={`Active ${d.name}`} disabled={!canEdit} checked={d.active !== false} onChange={(on) => void setDoc(docRef(paths.departments, d.id), { active: on }, { merge: true })} />,
          },
          {
            title: 'Actions',
            width: 180,
            render: (_, d) => (
              <span className="cat-toolbar" style={{ margin: 0 }}>
                <Button variant="text" disabled={!canEdit} onClick={() => open(d)} aria-label={`Edit ${d.name}`}>Edit</Button>
                <Button variant="text" disabled={!canDelete} onClick={() => remove(d)} aria-label={`Delete ${d.name}`}>Delete</Button>
              </span>
            ),
          },
        ]}
      />
      <Modal title={editing?.id ? 'Edit department' : 'Add department'} open={!!editing} onOk={save} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={form} layout="vertical">
          <FormSection title="Department details" description="Name and where it sits in lists and reports.">
            <FieldGrid min={220}>
          <Form.Item name="name" label="Department name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="order" label="Display order" rules={[{ required: true }]}><Input type="number" min={0} /></Form.Item>
            </FieldGrid>
          <Form.Item name="reportTemplateId" label="Report template" extra="Used for this department's tests unless a test names its own.">
            <Select allowClear placeholder="Lab default" options={templates.map((t) => ({ value: t.id, label: t.name }))} />
          </Form.Item>
          </FormSection>
          <FormSection title="Availability">
            <SettingRow label="Active" help="An inactive department stays on old tests but is not offered for new ones." htmlFor="dept-active"><Form.Item name="active" valuePropName="checked" noStyle><Switch id="dept-active" /></Form.Item></SettingRow>
          </FormSection>
        </Form>
      </Modal>
      <Modal title={`Delete "${moveFrom?.name}"`} open={!!moveFrom} onCancel={() => setMoveFrom(null)} onOk={() => void moveAndDelete()} okText="Move tests and delete" okButtonProps={{ disabled: !moveTo, danger: true }} destroyOnHidden>
        <p>{moveFrom ? usedBy(moveFrom).length : 0} test(s) still use this department. Move them to another department to delete it.</p>
        <Select style={{ width: '100%' }} aria-label="Move tests to" placeholder="Move tests to" value={moveTo} onChange={setMoveTo}
          options={departments.filter((d) => d.id !== moveFrom?.id && d.active !== false).map((d) => ({ value: d.id, label: d.name }))} />
      </Modal>
    </div>
  )
}

// ---- Test mapping (catalogue code + machine/LIS code per test) -------------
export function TestMappingTab({ canEdit }: { canEdit: boolean }) {
  const { message } = App.useApp()
  const { tests, departmentById } = useCatalogueMaps()
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (tests as TestExt[]).filter((t) => !s || t.name.toLowerCase().includes(s) || t.code.toLowerCase().includes(s))
  }, [tests, q])
  const set = (t: TestExt, patch: Partial<TestExt>) =>
    updateDoc(docRef(paths.tests, t.id), patch).catch((e) => message.error((e as Error).message))
  const exportCsv = () =>
    downloadText(
      'test-mapping.csv',
      [csvLine(['test_code', 'test_name', 'catalogue_code', 'machine_code']), ...(tests as TestExt[]).map((t) => csvLine([t.code, t.name, t.catalogueCode, t.machineCode]))].join('\n'),
    )
  const sync = async (data: string[][]) => {
    const idx = headerIndex(data[0] ?? [])
    if (idx('test_code') < 0) return message.error('Missing column test_code')
    const byCode = new Map((tests as TestExt[]).map((t) => [t.code.toUpperCase(), t]))
    const ops: Parameters<typeof commitBatch>[0] = []
    for (const r of data.slice(1)) {
      const t = byCode.get((r[idx('test_code')] ?? '').trim().toUpperCase())
      if (!t) continue
      const patch: Record<string, string> = {}
      if (idx('catalogue_code') >= 0) patch.catalogueCode = (r[idx('catalogue_code')] ?? '').trim()
      if (idx('machine_code') >= 0) patch.machineCode = (r[idx('machine_code')] ?? '').trim()
      ops.push(mergeOp(docRef(paths.tests, t.id), patch))
    }
    await commitBatch(ops)
    message.success(`Mapped ${ops.length} test(s)`)
  }
  return (
    <div className="cat-stack">
      <div className="cat-toolbar">
        <Input.Search allowClear aria-label="Search tests" placeholder="Search test" style={{ width: 260 }} onChange={(e) => setQ(e.target.value)} />
        <span className="cat-toolbar__grow" />
        <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export</Button>
        <CsvUpload disabled={!canEdit} onRows={sync}>Sync from CSV</CsvUpload>
      </div>
      <Table<TestExt>
        rowKey="id"
        size="middle"
        dataSource={rows}
        pagination={{ pageSize: 25, showSizeChanger: false }}
        columns={[
          { title: 'Test', render: (_, t) => <span>{t.name} <span className="cat-code">{t.code}</span></span> },
          { title: 'Department', width: 180, render: (_, t) => departmentById.get(t.departmentId)?.name ?? '-' },
          { title: 'Catalogue code', width: 200, render: (_, t) => <EditableText key={t.catalogueCode} label={`Catalogue code for ${t.code}`} disabled={!canEdit} value={t.catalogueCode ?? ''} onCommit={(v) => set(t, { catalogueCode: v })} /> },
          { title: 'Machine / LIS code', width: 220, render: (_, t) => <EditableText key={t.machineCode} label={`Machine code for ${t.code}`} disabled={!canEdit} value={t.machineCode ?? ''} onCommit={(v) => set(t, { machineCode: v })} /> },
          { title: 'Read from machine', width: 140, render: (_, t) => <Switch size="small" aria-label={`Machine reading ${t.code}`} disabled={!canEdit} checked={!!t.machineReading} onChange={(on) => void set(t, { machineReading: on })} /> },
        ]}
      />
      <UnmappedInbox canEdit={canEdit} />
    </div>
  )
}

// ---- Parameter mapping --------------------------------------------------------
export function ParameterMappingTab({ canEdit }: { canEdit: boolean }) {
  const { message } = App.useApp()
  const { tests } = useCatalogueMaps()
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (tests as TestExt[]).flatMap((t) =>
      (t.parameters as ParameterExt[]).filter((p) => p.structure !== 'group').map((p) => ({ id: `${t.id}/${p.key}`, test: t, p })),
    ).filter((r) => !s || r.test.name.toLowerCase().includes(s) || r.p.name.toLowerCase().includes(s) || r.test.code.toLowerCase().includes(s))
  }, [tests, q])
  const setCode = (t: TestExt, key: string, machineCode: string) =>
    updateDoc(docRef(paths.tests, t.id), {
      parameters: (t.parameters as ParameterExt[]).map((p) => (p.key === key ? { ...p, machineCode } : p)),
    }).catch((e) => message.error((e as Error).message))
  const exportCsv = () =>
    downloadText('parameter-mapping.csv', [csvLine(['test_code', 'param_key', 'param_name', 'machine_code']), ...rows.map((r) => csvLine([r.test.code, r.p.key, r.p.name, r.p.machineCode]))].join('\n'))
  const sync = async (data: string[][]) => {
    const idx = headerIndex(data[0] ?? [])
    if (idx('test_code') < 0 || idx('param_key') < 0 || idx('machine_code') < 0) return message.error('Needs columns test_code, param_key, machine_code')
    const map = new Map<string, Map<string, string>>()
    for (const r of data.slice(1)) {
      const c = (r[idx('test_code')] ?? '').trim().toUpperCase()
      if (!c) continue
      if (!map.has(c)) map.set(c, new Map())
      map.get(c)!.set((r[idx('param_key')] ?? '').trim().toUpperCase(), (r[idx('machine_code')] ?? '').trim())
    }
    const ops: Parameters<typeof commitBatch>[0] = []
    for (const t of tests as TestExt[]) {
      const m = map.get(t.code.toUpperCase())
      if (!m) continue
      ops.push(mergeOp(docRef(paths.tests, t.id), { parameters: (t.parameters as ParameterExt[]).map((p) => (m.has(p.key) ? { ...p, machineCode: m.get(p.key) } : p)) }))
    }
    await commitBatch(ops)
    message.success(`Updated ${ops.length} test(s)`)
  }
  return (
    <div className="cat-stack">
      <div className="cat-toolbar">
        <Input.Search allowClear aria-label="Search parameters" placeholder="Search test or parameter" style={{ width: 280 }} onChange={(e) => setQ(e.target.value)} />
        <span className="cat-toolbar__grow" />
        <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export</Button>
        <CsvUpload disabled={!canEdit} onRows={sync}>Sync from CSV</CsvUpload>
      </div>
      <Table
        rowKey="id"
        size="middle"
        dataSource={rows}
        pagination={{ pageSize: 25, showSizeChanger: false }}
        columns={[
          { title: 'Test', render: (_, r) => r.test.name },
          { title: 'Parameter', render: (_, r) => r.p.name },
          { title: 'Key', width: 110, render: (_, r) => <span className="cat-code">{r.p.key}</span> },
          { title: 'Machine code', width: 220, render: (_, r) => <EditableText key={r.p.machineCode} label={`Machine code for ${r.p.key}`} disabled={!canEdit} value={r.p.machineCode ?? ''} onCommit={(v) => setCode(r.test, r.p.key, v)} /> },
        ]}
      />
    </div>
  )
}

// ---- TAT ---------------------------------------------------------------------------
export function TatTab({ canEdit }: { canEdit: boolean }) {
  const { message } = App.useApp()
  const { tests, departmentById } = useCatalogueMaps()
  const [q, setQ] = useState('')
  const [dirty, setDirty] = useState<Record<string, { tat?: number | null; urgent?: number | null }>>({})
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return tests.filter((t) => !s || t.name.toLowerCase().includes(s) || t.code.toLowerCase().includes(s))
  }, [tests, q])
  const edit = (id: string, patch: { tat?: number | null; urgent?: number | null }) => setDirty((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  const saveAll = async () => {
    setBusy(true)
    try {
      await commitBatch(Object.entries(dirty).map(([id, v]) => mergeOp(docRef(paths.tests, id), {
        ...(v.tat !== undefined ? { tatMinutes: v.tat } : {}),
        ...(v.urgent !== undefined ? { urgentTatMinutes: v.urgent } : {}),
      })))
      message.success(`Saved TAT for ${Object.keys(dirty).length} test(s)`)
      setDirty({})
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const exportCsv = () =>
    downloadText('tat.csv', [csvLine(['test_code', 'test_name', 'tat_minutes', 'urgent_tat_minutes']), ...tests.map((t) => csvLine([t.code, t.name, t.tatMinutes, t.urgentTatMinutes]))].join('\n'))
  const upload = (data: string[][]) => {
    const idx = headerIndex(data[0] ?? [])
    if (idx('test_code') < 0) return message.error('Missing column test_code')
    const byCode = new Map(tests.map((t) => [t.code.toUpperCase(), t]))
    const next: typeof dirty = {}
    for (const r of data.slice(1)) {
      const t = byCode.get((r[idx('test_code')] ?? '').trim().toUpperCase())
      if (!t) continue
      const num = (n: string) => { const raw = idx(n) >= 0 ? (r[idx(n)] ?? '').trim() : undefined; return raw === undefined ? undefined : raw === '' ? null : Number(raw) }
      const tat = num('tat_minutes'), urgent = num('urgent_tat_minutes')
      next[t.id] = { ...(tat !== undefined && !Number.isNaN(tat) ? { tat } : {}), ...(urgent !== undefined && !Number.isNaN(urgent) ? { urgent } : {}) }
    }
    setDirty((d) => ({ ...d, ...next }))
    message.info(`${Object.keys(next).length} row(s) loaded. Review and press Save changes.`)
  }
  return (
    <div className="cat-stack">
      <div className="cat-toolbar">
        <Input.Search allowClear aria-label="Search tests" placeholder="Search test" style={{ width: 260 }} onChange={(e) => setQ(e.target.value)} />
        <span className="cat-toolbar__grow" />
        <Button icon={<DownloadOutlined />} onClick={exportCsv}>Download list</Button>
        <CsvUpload disabled={!canEdit} onRows={upload}>Upload list</CsvUpload>
        <Button variant="primary" disabled={!canEdit || busy || Object.keys(dirty).length === 0} onClick={saveAll}>
          {`Save changes${Object.keys(dirty).length ? ` (${Object.keys(dirty).length})` : ''}`}
        </Button>
      </div>
      <Table
        rowKey="id"
        size="middle"
        dataSource={rows}
        pagination={{ pageSize: 25, showSizeChanger: false }}
        columns={[
          { title: 'Test', render: (_, t) => <span>{t.name} <span className="cat-code">{t.code}</span></span> },
          { title: 'Department', width: 160, render: (_, t) => departmentById.get(t.departmentId)?.name ?? '-' },
          { title: 'Total TAT', width: 260, render: (_, t) => <TatInput label={`TAT ${t.code}`} disabled={!canEdit} value={dirty[t.id]?.tat !== undefined ? dirty[t.id].tat : t.tatMinutes} onChange={(v) => edit(t.id, { tat: v })} /> },
          { title: 'Urgent TAT', width: 260, render: (_, t) => <TatInput label={`Urgent TAT ${t.code}`} disabled={!canEdit} value={dirty[t.id]?.urgent !== undefined ? dirty[t.id].urgent : t.urgentTatMinutes} onChange={(v) => edit(t.id, { urgent: v })} /> },
          { title: 'Saved', width: 130, render: (_, t) => <span className="cat-muted">{fmtTat(t.tatMinutes)} / {fmtTat(t.urgentTatMinutes)}</span> },
        ]}
      />
    </div>
  )
}

// ---- Sample list ------------------------------------------------------------------------
export function SamplesTab({ canEdit, canDelete = canEdit }: { canEdit: boolean; canDelete?: boolean }) {
  const { message, modal } = App.useApp()
  const { sampleTypes, tests } = useCatalogueMaps()
  const [editing, setEditing] = useState<Partial<SampleTypeExt> | null>(null)
  const [form] = Form.useForm<SampleTypeExt>()
  const open = (s: Partial<SampleTypeExt>) => {
    setEditing(s)
    form.setFieldsValue({ name: s.name ?? '', tubeColor: s.tubeColor ?? '#DC2626', container: s.container ?? '', volume: s.volume ?? '', barcodePrefix: s.barcodePrefix ?? '', barcodeSuffix: s.barcodeSuffix ?? '', active: s.active ?? true })
  }
  const save = async () => {
    const v = await form.validateFields()
    const color = typeof v.tubeColor === 'string' ? v.tubeColor : String(v.tubeColor)
    const id = editing?.id ?? slug(v.name)
    try {
      await setDoc(docRef(paths.sampleTypes, id), { name: v.name.trim(), tubeColor: color, container: v.container ?? '', volume: v.volume ?? '', barcodePrefix: v.barcodePrefix ?? '', barcodeSuffix: v.barcodeSuffix ?? '', active: v.active !== false, deleted: false }, { merge: true })
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const remove = (s: SampleTypeExt) => {
    const used = tests.filter((t) => t.sampleTypeId === s.id).length
    if (used) {
      modal.warning({ title: `Cannot delete "${s.name}"`, content: `${used} test(s) use this sample. Change their sample first, or mark the sample inactive.` })
      return
    }
    modal.confirm({ title: `Delete sample "${s.name}"?`, content: 'It is hidden, not erased. Restore it from Deleted items.', okButtonProps: { danger: true }, onOk: () => setDoc(docRef(paths.sampleTypes, s.id), { deleted: true, deletedAt: serverTimestamp() }, { merge: true }) })
  }
  return (
    <div className="cat-stack">
      <div className="cat-toolbar">
        <Button icon={<PlusOutlined />} disabled={!canEdit} onClick={() => open({})}>New sample</Button>
      </div>
      <Table<SampleTypeExt>
        rowKey="id"
        dataSource={sampleTypes as SampleTypeExt[]}
        pagination={false}
        columns={[
          { title: 'Sample', render: (_, s) => <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><span className="cat-dot" style={{ background: s.tubeColor }} aria-hidden="true" />{s.name}</span> },
          { title: 'Tube colour', dataIndex: 'tubeColor', width: 120, render: (c: string) => <span className="cat-code">{c}</span> },
          { title: 'Container', dataIndex: 'container', render: (v?: string) => v || '-' },
          { title: 'Volume', dataIndex: 'volume', width: 100, render: (v?: string) => v || '-' },
          { title: 'Barcode prefix', dataIndex: 'barcodePrefix', width: 130, render: (v?: string) => v || '-' },
          { title: 'Barcode suffix', dataIndex: 'barcodeSuffix', width: 130, render: (v?: string) => v || '-' },
          { title: 'Status', width: 110, render: (_, s) => <StatusChip variant={s.active === false ? 'neutral' : 'success'}>{s.active === false ? 'Inactive' : 'Active'}</StatusChip> },
          {
            title: 'Actions',
            width: 170,
            render: (_, s) => (
              <span className="cat-toolbar" style={{ margin: 0 }}>
                <Button variant="text" disabled={!canEdit} onClick={() => open(s)} aria-label={`Edit ${s.name}`}>Edit</Button>
                <Button variant="text" disabled={!canDelete} onClick={() => remove(s)} aria-label={`Delete ${s.name}`}>Delete</Button>
              </span>
            ),
          },
        ]}
      />
      <Modal title={editing?.id ? 'Edit sample' : 'New sample'} open={!!editing} onOk={save} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={form} layout="vertical">
          <FormSection title="Sample" description="The specimen and the tube it is collected in.">
            <FieldGrid min={220}>
              <Form.Item name="name" label="Sample" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name="tubeColor" label="Tube colour" getValueFromEvent={(c: { toHexString: () => string }) => c.toHexString()}><ColorPicker showText /></Form.Item>
              <Form.Item name="container" label="Container"><Input placeholder="e.g. EDTA vacutainer" /></Form.Item>
              <Form.Item name="volume" label="Volume"><Input placeholder="e.g. 3 mL" /></Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Barcode" description="Added to the sample barcode printed on labels.">
            <FieldGrid min={220}>
              <Form.Item name="barcodePrefix" label="Barcode prefix"><Input /></Form.Item>
              <Form.Item name="barcodeSuffix" label="Barcode suffix"><Input /></Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Availability">
            <SettingRow label="Active" help="An inactive sample stays on old tests but is not offered for new ones." htmlFor="smp-active"><Form.Item name="active" valuePropName="checked" noStyle><Switch id="smp-active" /></Form.Item></SettingRow>
          </FormSection>
        </Form>
      </Modal>
    </div>
  )
}

