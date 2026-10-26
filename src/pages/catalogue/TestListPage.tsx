import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Dropdown, Input, InputNumber, Select, Switch, Table } from 'antd'
import { getDocs, query, updateDoc, where } from 'firebase/firestore'
import { MoreOutlined, DownloadOutlined, PlusOutlined, SwapOutlined, OrderedListOutlined, DollarOutlined, SyncOutlined } from '@ant-design/icons'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useAuth, can } from '../../auth/AuthProvider'
import { col, docRef, paths } from '../../lib/db'
import { toPaise, toRupees } from '../../lib/money'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Segmented } from '../../design/Segmented'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonRows } from '../../design/Skeletons'
import { downloadText } from './helpers'
import type { TestExt } from './ext'
import { csvLine } from './shared'
import { DepartmentsTab, ParameterMappingTab, SamplesTab, TatTab, TestMappingTab } from './CatalogueTabs'
import AiTestModal from './AiTestModal'
import MasterSyncModal from './MasterSyncModal'
import { CopyToBranchesModal } from './CopyToBranches'
import { DeletedItemsModal } from './DeletedItems'
import { auditPriceChange } from '../../features/settings/audit'
import { MassPriceModal, SequenceModal } from './ListModals'
import './catalogue.css'

type Tab = 'tests' | 'departments' | 'mapping' | 'params' | 'tat' | 'samples'

function PriceCell({ test, disabled }: { test: TestExt; disabled: boolean }) {
  const { message } = App.useApp()
  const [value, setValue] = useState<number | null>(null)
  const commit = async () => {
    if (value === null) return
    const p = toPaise(value)
    setValue(null)
    if (p === test.price) return
    try {
      await updateDoc(docRef(paths.tests, test.id), { price: p })
      void auditPriceChange('test', `${test.code} ${test.name}`, `tests/${test.id}`, test.price, p)
      message.success(`${test.code} price updated`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <InputNumber size="small" aria-label={`Price for ${test.code}`} disabled={disabled} min={0} precision={2} prefix="₹" style={{ width: 120 }}
      value={value ?? toRupees(test.price)} onChange={(v) => setValue(v)} onBlur={commit} onPressEnter={commit} />
  )
}

export default function TestListPage() {
  const nav = useNavigate()
  const { message } = App.useApp()
  const { profile } = useAuth()
  const canEdit = can(profile, 'catalogue.edit')
  const canPrice = can(profile, 'catalogue.price')
  const canDelete = can(profile, 'catalogue.delete')
  const { modal } = App.useApp()
  const maps = useCatalogueMaps()
  const { departments, departmentById, sampleTypeById } = maps
  const tests = maps.tests as TestExt[]
  const [tab, setTab] = useState<Tab>('tests')
  const [search, setSearch] = useState('')
  const [dept, setDept] = useState<string | undefined>()
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all')
  const [seqOpen, setSeqOpen] = useState(false)
  const [priceOpen, setPriceOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [copyIds, setCopyIds] = useState<string[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tests.filter(
      (t) =>
        !t.deleted && (!dept || t.departmentId === dept) &&
        (status === 'all' || (status === 'disabled') === !!t.disabled) &&
        (!q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q)),
    )
  }, [tests, search, dept, status])

  const patch = (t: TestExt, data: Partial<TestExt>) =>
    updateDoc(docRef(paths.tests, t.id), data).catch((e) => message.error((e as Error).message))

  // Delete = soft delete (kept for old bills and reports). Blocked while the test is in a package
  // or mapped to stock; offers to disable instead.
  const del = async (t: TestExt) => {
    const [pk, sm] = await Promise.all([
      getDocs(query(col<{ name: string; testIds: string[] }>(paths.packages), where('testIds', 'array-contains', t.id))),
      getDocs(query(col<{ itemId: string }>('stockMappings'), where('testId', '==', t.id))).catch(() => null),
    ])
    const used = [...pk.docs.map((d) => `package ${d.data().name}`), ...(sm ? sm.docs.map(() => 'a stock mapping') : [])]
    if (used.length) {
      modal.warning({ title: `${t.name} is in use`, content: `Used in ${used.join(', ')}. Remove it there first, or just disable it.` })
      return
    }
    modal.confirm({
      title: `Delete test "${t.name}"?`,
      content: 'It is hidden from billing and the catalogue. Existing bills and reports keep it.',
      okButtonProps: { danger: true },
      onOk: () => patch(t, { deleted: true, disabled: true }),
    })
  }

  const exportCsv = () =>
    downloadText('tests.csv', [
      csvLine(['test_code', 'test_name', 'department', 'sample', 'price', 'gender', 'tat_minutes', 'urgent_tat_minutes', 'interpretation', 'disabled']),
      ...rows.map((t) => csvLine([t.code, t.name, departmentById.get(t.departmentId)?.name, sampleTypeById.get(t.sampleTypeId)?.name, toRupees(t.price), t.gender, t.tatMinutes, t.urgentTatMinutes, t.interpretation, t.disabled])),
    ].join('\n'))

  return (
    <div>
      <PageHeader
        title="Test catalogue"
        subtitle={`${tests.length} tests across ${departments.length} departments`}
        actions={canEdit && (<><Button onClick={() => setDelOpen(true)}>Deleted items</Button><Button onClick={() => setSyncOpen(true)}>Master sync</Button><Button onClick={() => setAiOpen(true)}>Create with AI</Button><Button variant="primary" icon={<PlusOutlined />} onClick={() => nav('/tests/new')}>New test</Button></>)}
      />
      <div className="cat-tabs">
        <Segmented<Tab>
          aria-label="Catalogue sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'tests', label: 'Test list' },
            { value: 'departments', label: 'Department list' },
            { value: 'mapping', label: 'Test mapping' },
            { value: 'params', label: 'Parameter mapping' },
            { value: 'tat', label: 'TAT' },
            { value: 'samples', label: 'Sample list' },
          ]}
        />
      </div>
      <Card>
        {tab === 'tests' && (
          <div className="cat-stack">
            <div className="cat-toolbar">
              <Input.Search allowClear aria-label="Search tests" placeholder="Search name or code" style={{ width: 260 }} onChange={(e) => setSearch(e.target.value)} />
              <Select allowClear aria-label="Department filter" placeholder="All departments" style={{ width: 200 }} value={dept} onChange={setDept} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
              <Segmented<'all' | 'active' | 'disabled'> size="small" aria-label="Status filter" value={status} onChange={setStatus}
                options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }]} />
              <span className="cat-toolbar__grow" />
              <Button icon={<SyncOutlined />} disabled={!canEdit} onClick={() => nav('/catalogue-import')}>Import tests</Button>
              <Button icon={<OrderedListOutlined />} disabled={!canEdit} onClick={() => setSeqOpen(true)}>Test sequence</Button>
              <Button icon={<DollarOutlined />} disabled={!canPrice} onClick={() => setPriceOpen(true)}>Mass update price</Button>
              <Button disabled={!canEdit || picked.length === 0} onClick={() => setCopyIds(picked)}>{`Copy to branches${picked.length ? ` (${picked.length})` : ''}`}</Button>
              <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export</Button>
            </div>
            {maps.tests.length === 0 && !maps.departments.length ? (
              <SkeletonRows rows={6} columns={6} />
            ) : (
              <Table<TestExt>
                rowKey="id"
                size="middle"
                dataSource={rows}
                scroll={{ x: 900 }}
                rowSelection={canEdit ? { selectedRowKeys: picked, onChange: (k) => setPicked(k as string[]) } : undefined}
                pagination={{ pageSize: 25, showSizeChanger: false }}
                locale={{ emptyText: <EmptyState icon={<SwapOutlined />} title="No tests match" description="Change the search or filters, or add a test." /> }}
                columns={[
                  { title: 'Test and code', sorter: (a, b) => a.name.localeCompare(b.name), render: (_, t) => <span>{t.name} <span className="cat-code">{t.code}</span></span> },
                  { title: 'Department', width: 170, render: (_, t) => departmentById.get(t.departmentId)?.name ?? '-' },
                  {
                    title: 'Sample type', width: 170,
                    render: (_, t) => {
                      const s = sampleTypeById.get(t.sampleTypeId)
                      return s ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><span className="cat-dot" style={{ background: s.tubeColor }} aria-hidden="true" />{s.name}</span> : '-'
                    },
                  },
                  { title: 'Price', width: 150, render: (_, t) => <PriceCell key={t.price} test={t} disabled={!canPrice} /> },
                  {
                    title: 'Interpretation', width: 160,
                    render: (_, t) => (
                      <span className="cat-toolbar" style={{ margin: 0 }}>
                        <Switch size="small" aria-label={`Interpretation for ${t.code}`} disabled={!canEdit} checked={t.interpretationEnabled ?? !!t.interpretation} onChange={(on) => patch(t, { interpretationEnabled: on })} />
                        <StatusChip variant={t.interpretation ? 'info' : 'neutral'}>{t.interpretation ? 'Has text' : 'Empty'}</StatusChip>
                      </span>
                    ),
                  },
                  { title: 'Enabled', width: 90, render: (_, t) => <Switch size="small" aria-label={`Enable ${t.code}`} disabled={!canEdit} checked={!t.disabled} onChange={(on) => patch(t, { disabled: !on })} /> },
                  {
                    title: 'Action', width: 130,
                    render: (_, t) => (
                      <span className="cat-toolbar" style={{ margin: 0 }}>
                        <Button variant="text" aria-label={`Edit ${t.name}`} onClick={() => nav(`/tests/${t.id}`)}>Edit</Button>
                        <Dropdown
                          trigger={['click']}
                          menu={{
                            items: [
                              { key: 'clone', label: 'Clone', disabled: !canEdit },
                              { key: 'branches', label: 'Copy to branches', disabled: !canEdit },
                              { key: 'delete', label: 'Delete', danger: true, disabled: !canDelete },
                            ],
                            onClick: ({ key }) => (key === 'clone' ? nav(`/tests/new?copy=${t.id}`) : key === 'branches' ? setCopyIds([t.id]) : void del(t)),
                          }}
                        >
                          <Button variant="text" icon={<MoreOutlined />} aria-label={`More actions for ${t.name}`} />
                        </Dropdown>
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </div>
        )}
        {tab === 'departments' && <DepartmentsTab canEdit={canEdit} canDelete={canDelete} />}
        {tab === 'mapping' && <TestMappingTab canEdit={canEdit} />}
        {tab === 'params' && <ParameterMappingTab canEdit={canEdit} />}
        {tab === 'tat' && <TatTab canEdit={canEdit} />}
        {tab === 'samples' && <SamplesTab canEdit={canEdit} canDelete={canDelete} />}
      </Card>
      <SequenceModal open={seqOpen} onClose={() => setSeqOpen(false)} />
      <MassPriceModal open={priceOpen} onClose={() => setPriceOpen(false)} />
      <AiTestModal open={aiOpen} onClose={() => setAiOpen(false)} />
      <MasterSyncModal open={syncOpen} onClose={() => setSyncOpen(false)} />
      <DeletedItemsModal open={delOpen} onClose={() => setDelOpen(false)} />
      <CopyToBranchesModal open={!!copyIds} testIds={copyIds ?? []} onClose={() => { setCopyIds(null); setPicked([]) }} />
    </div>
  )
}
