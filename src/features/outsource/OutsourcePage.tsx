import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Form, Input, InputNumber, Modal, Select, Switch, Table } from 'antd'
import { DeleteOutlined, DownloadOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useAuth, can } from '../../auth/AuthProvider'
import { docRef, paths } from '../../lib/db'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { downloadText } from '../../pages/catalogue/helpers'
import { FieldGrid, FormSection } from '../../design/FormLayout'
import { CsvUpload, TatInput, commitBatch, csvLine, headerIndex, mergeOp } from '../../pages/catalogue/shared'
import { fmtTat, type OutsourceEntry, type TestExt } from '../../pages/catalogue/ext'
import { useOutsourceData } from './lib'
import { OutsourceJobs } from './OutsourceJobs'
import '../../pages/catalogue/catalogue.css'
import { dialogWidth } from '../../design/dialog'

interface RowForm {
  labId: string
  cost: number
  tatMinutes: number | null
  isDefault: boolean
}

export default function OutsourcePage() {
  const { message, modal } = App.useApp()
  const nav = useNavigate()
  const { profile } = useAuth()
  const canEdit = can(profile, 'catalogue.edit')
  const maps = useCatalogueMaps()
  const tests = maps.tests as TestExt[]
  const { labs } = useOutsourceData()
  const labList = useMemo(() => [...labs.values()].sort((a, b) => a.name.localeCompare(b.name)), [labs])
  const [tab, setTab] = useState<'test' | 'lab' | 'jobs'>('test')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<TestExt | null>(null)
  const [form] = Form.useForm<{ rows: RowForm[] }>()

  const mapped = useMemo(() => tests.filter((t) => (t.outsourceLabs ?? []).length > 0), [tests])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return mapped.filter((t) => !q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q))
  }, [mapped, search])
  const labName = (id: string) => labs.get(id)?.name ?? 'Unknown lab'

  const openEdit = (t: TestExt) => {
    setEditing(t)
    form.setFieldsValue({
      rows: (t.outsourceLabs ?? []).length
        ? t.outsourceLabs!.map((e) => ({ labId: e.labId, cost: toRupees(e.cost), tatMinutes: e.tatMinutes, isDefault: e.isDefault }))
        : [{ labId: '', cost: 0, tatMinutes: null, isDefault: true }],
    })
  }

  const save = async () => {
    const { rows } = await form.validateFields()
    if (!editing) return
    const ids = rows.map((r) => r.labId)
    if (new Set(ids).size !== ids.length) return message.error('A lab can be added once per test')
    const entries: OutsourceEntry[] = rows.map((r) => ({ labId: r.labId, cost: toPaise(r.cost ?? 0), tatMinutes: r.tatMinutes ?? null, isDefault: !!r.isDefault }))
    if (entries.length && !entries.some((e) => e.isDefault)) entries[0].isDefault = true
    let seen = false
    for (const e of entries) {
      if (e.isDefault && seen) e.isDefault = false
      if (e.isDefault) seen = true
    }
    try {
      await commitBatch([mergeOp(docRef(paths.tests, editing.id), { outsourceLabs: entries })])
      message.success('Outsource mapping saved')
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const clear = (t: TestExt) =>
    modal.confirm({
      title: `Stop outsourcing "${t.name}"?`,
      content: 'The test will be processed in-house again.',
      okButtonProps: { danger: true },
      onOk: () => commitBatch([mergeOp(docRef(paths.tests, t.id), { outsourceLabs: [] })]),
    })

  const labRows = useMemo(
    () => labList.map((l) => ({ ...l, tests: mapped.filter((t) => t.outsourceLabs!.some((e) => e.labId === l.id)) })),
    [labList, mapped],
  )

  const downloadSheet = () => {
    const lines = [csvLine(['test_code', 'test_name', 'lab_name', 'cost', 'tat_minutes', 'default'])]
    for (const t of tests) {
      const es = t.outsourceLabs ?? []
      if (!es.length) lines.push(csvLine([t.code, t.name, '', '', '', '']))
      for (const e of es) lines.push(csvLine([t.code, t.name, labName(e.labId), toRupees(e.cost), e.tatMinutes, e.isDefault ? 'yes' : '']))
    }
    downloadText('outsource-tests.csv', lines.join('\n'))
  }

  const bulkUpload = async (data: string[][]) => {
    const idx = headerIndex(data[0] ?? [])
    if (['test_code', 'lab_name', 'cost'].some((h) => idx(h) < 0)) return message.error('Needs columns test_code, lab_name, cost (optional tat_minutes, default)')
    const byCode = new Map(tests.map((t) => [t.code.toUpperCase(), t]))
    const labByName = new Map(labList.map((l) => [l.name.trim().toLowerCase(), l.id]))
    const next = new Map<string, OutsourceEntry[]>()
    const problems: string[] = []
    data.slice(1).forEach((r, i) => {
      const t = byCode.get((r[idx('test_code')] ?? '').trim().toUpperCase())
      const lab = (r[idx('lab_name')] ?? '').trim()
      if (!t || !lab) return
      const labId = labByName.get(lab.toLowerCase())
      const cost = Number(r[idx('cost')])
      if (!labId || !Number.isFinite(cost)) return void problems.push(`Row ${i + 2}: ${!labId ? `unknown lab "${lab}"` : 'bad cost'}`)
      const tat = idx('tat_minutes') >= 0 && (r[idx('tat_minutes')] ?? '').trim() !== '' ? Number(r[idx('tat_minutes')]) : null
      const def = idx('default') >= 0 && /^(y|yes|true|1)$/i.test((r[idx('default')] ?? '').trim())
      next.set(t.id, [...(next.get(t.id) ?? []), { labId, cost: toPaise(cost), tatMinutes: tat, isDefault: def }])
    })
    for (const es of next.values()) if (!es.some((e) => e.isDefault)) es[0].isDefault = true
    try {
      await commitBatch([...next].map(([id, es]) => mergeOp(docRef(paths.tests, id), { outsourceLabs: es })))
      if (problems.length) modal.warning({ title: `Updated ${next.size} test(s), skipped ${problems.length} row(s)`, content: problems.slice(0, 10).join('\n'), styles: { body: { whiteSpace: 'pre-line' } } })
      else message.success(`Updated ${next.size} test(s)`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div>
      <PageHeader
        title="Outsource"
        subtitle="Map tests to the labs that process them, with your cost and their turnaround."
        actions={tab === 'lab' ? <Button variant="primary" icon={<PlusOutlined />} disabled={!canEdit} onClick={() => nav('/processing-labs')}>Add lab</Button> : undefined}
      />
      <div className="cat-tabs">
        <Segmented<'test' | 'lab' | 'jobs'> aria-label="Outsource view" value={tab} onChange={setTab}
          options={[{ value: 'test', label: 'Test wise', count: mapped.length }, { value: 'lab', label: 'Lab wise', count: labList.length }, { value: 'jobs', label: 'Jobs' }]} />
      </div>
      <Card>
        {tab === 'jobs' ? (
          <OutsourceJobs canEdit={canEdit} />
        ) : tab === 'test' ? (
          <div className="cat-stack">
            <div className="cat-toolbar">
              <Input.Search allowClear aria-label="Search outsourced tests" placeholder="Search outsourced test" style={{ width: 260 }} onChange={(e) => setSearch(e.target.value)} />
              <Select showSearch optionFilterProp="label" aria-label="Add test to outsource" placeholder="Add a test" style={{ width: 280 }} disabled={!canEdit} value={null as unknown as string}
                options={tests.filter((t) => !(t.outsourceLabs ?? []).length).map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` }))}
                onChange={(id) => { const t = tests.find((x) => x.id === id); if (t) openEdit(t) }} />
              <span className="cat-toolbar__grow" />
              <Button icon={<DownloadOutlined />} onClick={downloadSheet}>Download sheet</Button>
              <CsvUpload disabled={!canEdit} onRows={bulkUpload}>Bulk upload</CsvUpload>
            </div>
            <Table<TestExt>
              rowKey="id"
              dataSource={shown}
              pagination={{ pageSize: 25, showSizeChanger: false }}
              locale={{ emptyText: <EmptyState title="No outsourced tests" description="Add a test above and choose which labs process it." /> }}
              columns={[
                { title: 'Sr', width: 60, render: (_, __, i) => i + 1 },
                { title: 'Test', render: (_, t) => <span>{t.name} <span className="cat-code">{t.code}</span></span> },
                {
                  title: 'Lab list',
                  render: (_, t) => (
                    <span className="cat-pkg__tests">
                      {t.outsourceLabs!.map((e) => (
                        <StatusChip key={e.labId} variant={e.isDefault ? 'info' : 'neutral'}>
                          {`${labName(e.labId)}: ${formatINR(e.cost)}, ${fmtTat(e.tatMinutes)}${e.isDefault ? ' (default)' : ''}`}
                        </StatusChip>
                      ))}
                    </span>
                  ),
                },
                {
                  title: 'Actions', width: 160,
                  render: (_, t) => (
                    <span className="cat-toolbar" style={{ margin: 0 }}>
                      <Button variant="text" disabled={!canEdit} onClick={() => openEdit(t)} aria-label={`Edit ${t.name}`}>Edit</Button>
                      <Button variant="text" icon={<DeleteOutlined />} disabled={!canEdit} onClick={() => clear(t)} aria-label={`Remove ${t.name} from outsourcing`} />
                    </span>
                  ),
                },
              ]}
            />
          </div>
        ) : (
          <Table
            rowKey="id"
            dataSource={labRows}
            pagination={false}
            locale={{ emptyText: <EmptyState title="No processing labs" description="Add labs on the Processing Labs page first." action={<Button variant="primary" onClick={() => nav('/processing-labs')}>Open processing labs</Button>} /> }}
            expandable={{ expandedRowRender: (l) => (l.tests.length ? l.tests.map((t) => { const e = t.outsourceLabs!.find((x) => x.labId === l.id)!; return <div key={t.id}>{t.name} <span className="cat-code">{t.code}</span> {formatINR(e.cost)}, {fmtTat(e.tatMinutes)}</div> }) : <span className="cat-muted">No tests mapped</span>) }}
            columns={[
              { title: 'Lab name', dataIndex: 'name' },
              { title: 'Status', width: 110, render: (_, l) => <StatusChip variant={l.active === false ? 'neutral' : 'success'}>{l.active === false ? 'Inactive' : 'Active'}</StatusChip> },
              { title: 'Total tests', width: 120, render: (_, l) => l.tests.length },
            ]}
          />
        )}
      </Card>

      <Modal title={editing ? `Outsource: ${editing.name}` : ''} open={!!editing} onCancel={() => setEditing(null)} onOk={save} okText="Save" width={dialogWidth(680)} destroyOnHidden>
        <Form form={form} layout="vertical">
          <FormSection title="Processing labs" description="Labs that can process this test, what they charge us and how long they take. The default lab is chosen on bills unless changed.">
          <Form.List name="rows">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name }) => (
                  <div key={key} className="cat-agerange">
                    <FieldGrid min={200}>
                      <Form.Item name={[name, 'labId']} label="Lab" rules={[{ required: true, message: 'Pick a lab' }]}>
                        <Select showSearch optionFilterProp="label" options={labList.map((l) => ({ value: l.id, label: l.name }))} />
                      </Form.Item>
                      <Form.Item name={[name, 'cost']} label="Our cost"><InputNumber min={0} precision={2} addonBefore="₹" style={{ width: '100%' }} /></Form.Item>
                      <Form.Item name={[name, 'tatMinutes']} label="Lab TAT"><TatInput label="Lab TAT" /></Form.Item>
                    </FieldGrid>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)', width: '100%' }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
                        <Form.Item name={[name, 'isDefault']} valuePropName="checked" noStyle>
                          <Switch onChange={(on) => on && form.setFieldValue('rows', (form.getFieldValue('rows') as RowForm[]).map((r, i) => ({ ...r, isDefault: i === name })))} />
                        </Form.Item>
                        Default lab for this test
                      </label>
                      <Button variant="text" icon={<MinusCircleOutlined />} aria-label="Remove lab row" onClick={() => remove(name)}>Remove</Button>
                    </div>
                  </div>
                ))}
                <Button icon={<PlusOutlined />} onClick={() => add({ labId: '', cost: 0, tatMinutes: null, isDefault: fields.length === 0 })}>Add lab</Button>
              </>
            )}
          </Form.List>
          </FormSection>
        </Form>
      </Modal>
    </div>
  )
}
