import { useMemo, useState } from 'react'
import { Alert, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Switch, Table, message } from 'antd'
import { MinusCircleOutlined } from '@ant-design/icons'
import { DeleteOutlined, DownloadOutlined, EditOutlined, MergeOutlined, PlusOutlined, PrinterOutlined, ProfileOutlined, UploadOutlined } from '@ant-design/icons'
import { getDocs, query, where, writeBatch } from 'firebase/firestore'
import { Button } from '../../design/Button'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { db } from '../../firebase'
import { col, docRef, paths } from '../../lib/db'
import { formatINR, toPaise } from '../../lib/money'
import { useBranchScope } from '../../lib/branchScope'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import CommissionLedger from './CommissionLedger'
import SharedRateLists from './SharedRateLists'
import { commissionForReferrer, commissionLabel, orderMatchesReferrer, totalsFor } from './lib/commission'
import { downloadCsv, parseCsvObjects } from './lib/csv'
import { removeMaster, saveMaster, useMaster, useRateLists } from './lib/master'
import { usePartnerOrders, orderDate, type Range } from './lib/orders'
import { esc, printHtml } from './lib/print'
import { FieldGrid, FormSection, SettingRow } from '../../design/FormLayout'
import { PriceListDrawer } from './RateListEditor'
import type { CommissionRule, CommissionType, GovPanel, MarketingMember, PartnerOrder, Referrer, Tpa } from './types'
import { ActiveChip, DataTable, FileButton, fmtDate, Kpis, RangeField, Spacer, thisMonth, Toolbar } from './ui'
import { dialogWidth } from '../../design/dialog'

type Tab = 'doctor' | 'hospital' | 'second' | 'tpa' | 'gov' | 'phlebo' | 'lists'

// Sample collectors paid per visit / percent (REF-01): a small master of its own.
interface Phlebo { id: string; name: string; gender: string; phone: string; email: string; commissionType: CommissionType; commissionValue: number; active: boolean }

const COMMISSION_OPTS = [
  { value: 'percent', label: 'Percent of net' },
  { value: 'flat', label: 'Flat per bill' },
  { value: 'none', label: 'No commission' },
]

export default function ReferralsPage() {
  const [tab, setTab] = useState<Tab>('doctor')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Partial<Referrer> | null>(null)
  const [editTpa, setEditTpa] = useState<Partial<Tpa> | null>(null)
  const [editGov, setEditGov] = useState<Partial<GovPanel> | null>(null)
  const [bulk, setBulk] = useState(false)
  const [merge, setMerge] = useState<Referrer | null>(null)
  const [stmt, setStmt] = useState(false)
  const [ledger, setLedger] = useState(false)
  const [pl, setPl] = useState<{ id: string; name: string; rateListId?: string; collection: string; kind: 'doctor' | 'hospital' | 'govPanel' } | null>(null)

  const phlebos = useMaster<Phlebo>('phlebotomists')
  const [editPh, setEditPh] = useState<Partial<Phlebo> | null>(null)
  const referrers = useMaster<Referrer>('referrers')
  const tpas = useMaster<Tpa>('tpas')
  const gov = useMaster<GovPanel>('govPanels')
  const pros = useMaster<MarketingMember>('marketingTeam')
  const rates = useRateLists()
  const settings = useLabSettings()
  const month = useMemo(() => thisMonth(), [])
  const monthOrders = usePartnerOrders(month)

  const rlName = (id?: string) => rates.data.find((r) => r.id === id)?.name ?? ''
  const proName = (id?: string) => pros.data.find((r) => r.id === id)?.name ?? ''
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase())

  const refRows = referrers.data.filter((r) => r.type === tab && !r.mergedInto && match(`${r.name} ${r.phone} ${r.speciality} ${r.email}`))
  const billsOf = (r: Referrer) => monthOrders.data.filter((o) => orderMatchesReferrer(o, r)).length

  const toggleActive = (c: string, id: string, active: boolean) => saveMaster(c, id, { active })
  const del = async (c: string, id: string) => {
    try {
      await removeMaster(c, id)
      message.success('Deleted')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const actions = (collection: string, row: { id: string; name: string; rateListId?: string }, edit: () => void, kind?: 'doctor' | 'hospital' | 'govPanel') => (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <Button variant="text" icon={<EditOutlined />} aria-label={`Edit ${row.name}`} onClick={edit} />
      {kind && (
        <Button variant="text" icon={<ProfileOutlined />} aria-label={`Price list for ${row.name}`} onClick={() => setPl({ ...row, collection, kind })} />
      )}
      <Popconfirm title={`Delete ${row.name}?`} okText="Delete" onConfirm={() => del(collection, row.id)}>
        <Button variant="text" icon={<DeleteOutlined />} aria-label={`Delete ${row.name}`} />
      </Popconfirm>
    </span>
  )

  const addLabel = { doctor: 'Add doctor', hospital: 'Add hospital', second: 'Add second referral', tpa: 'Add TPA', gov: 'Add government panel', phlebo: 'Add phlebotomist', lists: '' }[tab]
  const onAdd = () => {
    if (tab === 'tpa') setEditTpa({ active: true, commissionType: 'none', commissionValue: 0 })
    else if (tab === 'phlebo') setEditPh({ active: true, commissionType: 'none', commissionValue: 0, gender: 'male' })
    else if (tab === 'gov') setEditGov({ active: true, panelType: 'central' })
    else if (tab !== 'lists') setEditing({ type: tab, active: true, temporary: false, commissionType: 'percent', commissionValue: 0 })
  }

  const exportCsv = () => {
    if (tab === 'tpa')
      downloadCsv('tpa', [['name', 'phone', 'email', 'commission', 'active'], ...tpas.data.map((t) => [t.name, t.phone, t.email, commissionLabel(t), t.active])])
    else if (tab === 'gov')
      downloadCsv('government-panels', [['name', 'type', 'recipient address', 'price list'], ...gov.data.map((g) => [g.name, g.panelType, g.recipientAddress, rlName(g.rateListId)])])
    else
      downloadCsv(`referrers-${tab}`, [
        ['name', 'phone', 'email', 'speciality', 'commission', 'price list', 'PRO', 'temporary', 'active', 'bills this month'],
        ...refRows.map((r) => [r.name, r.phone, r.email, r.speciality, commissionLabel(r), rlName(r.rateListId), proName(r.proManagerId), r.temporary, r.active, billsOf(r)]),
      ])
  }

  const loading = referrers.loading || tpas.loading || gov.loading

  return (
    <div>
      <PageHeader
        title="Referral List"
        subtitle="Doctors, hospitals, TPAs and government panels with commission and price lists"
        actions={
          <>
            <Button icon={<PrinterOutlined />} onClick={() => setStmt(true)}>Commission statement</Button>
            <Button onClick={() => setLedger(true)}>Commission ledger</Button>
            {tab !== 'lists' && <Button variant="primary" icon={<PlusOutlined />} onClick={onAdd}>{addLabel}</Button>}
          </>
        }
      />
      <div className="pt-tabs">
        <Segmented<Tab>
          aria-label="Referral type"
          value={tab}
          onChange={(v) => { setTab(v); setQ('') }}
          options={[
            { value: 'doctor', label: 'Doctors', count: referrers.data.filter((r) => r.type === 'doctor' && !r.mergedInto).length },
            { value: 'hospital', label: 'Hospitals', count: referrers.data.filter((r) => r.type === 'hospital' && !r.mergedInto).length },
            { value: 'second', label: 'Second referral' },
            { value: 'tpa', label: 'TPA', count: tpas.data.length },
            { value: 'gov', label: 'Government panel', count: gov.data.length },
            { value: 'phlebo', label: 'Phlebotomist', count: phlebos.data.length },
            { value: 'lists', label: 'Price lists', count: rates.data.length },
          ]}
        />
      </div>

      {tab === 'lists' && <SharedRateLists />}

      {tab !== 'tpa' && tab !== 'gov' && tab !== 'phlebo' && tab !== 'lists' && (
        <DataTable<Referrer>
          loading={loading}
          dataSource={refRows}
          emptyTitle="No referrers yet"
          emptyHint="Add one, or bulk upload a CSV."
          toolbar={
            <Toolbar>
              <Input.Search allowClear aria-label="Search referrers" placeholder="Search name, phone, speciality" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
              <Spacer />
              <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export CSV</Button>
              <Button icon={<UploadOutlined />} onClick={() => setBulk(true)}>Bulk upload</Button>
            </Toolbar>
          }
          columns={[
            {
              title: 'Name',
              render: (_, r) => (
                <span>
                  {r.name} {r.degree ? <span className="pt-muted">({r.degree})</span> : null}{' '}
                  {r.temporary && <StatusChip variant="caution">Temporary</StatusChip>}
                </span>
              ),
            },
            { title: 'Contact', render: (_, r) => <span>{r.phone}<br /><span className="pt-muted">{r.email}</span></span> },
            { title: 'Speciality', dataIndex: 'speciality' },
            { title: 'Commission', render: (_, r) => <span className="pt-num">{commissionLabel(r)}</span> },
            { title: 'Rate list', render: (_, r) => rlName(r.rateListId) || <span className="pt-muted">MRP</span> },
            { title: 'PRO', render: (_, r) => proName(r.proManagerId) },
            { title: 'Bills (month)', align: 'right', render: (_, r) => <span className="pt-num">{billsOf(r)}</span> },
            { title: 'Active', render: (_, r) => <Switch size="small" aria-label={`Active: ${r.name}`} checked={r.active} onChange={(v) => toggleActive('referrers', r.id, v)} /> },
            {
              title: 'Actions',
              render: (_, r) => (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  {actions('referrers', r, () => setEditing(r), r.type === 'hospital' ? 'hospital' : 'doctor')}
                  {r.temporary && <Button variant="text" icon={<MergeOutlined />} aria-label={`Merge ${r.name} into an existing referrer`} onClick={() => setMerge(r)} />}
                </span>
              ),
            },
          ]}
        />
      )}

      {tab === 'tpa' && (
        <DataTable<Tpa>
          loading={loading}
          dataSource={tpas.data.filter((t) => match(`${t.name} ${t.phone} ${t.email}`))}
          emptyTitle="No TPAs yet"
          toolbar={
            <Toolbar>
              <Input.Search allowClear aria-label="Search TPAs" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
              <Spacer />
              <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export CSV</Button>
            </Toolbar>
          }
          columns={[
            { title: 'Name', dataIndex: 'name' },
            { title: 'Phone', dataIndex: 'phone' },
            { title: 'Email', dataIndex: 'email' },
            { title: 'Commission', render: (_, r) => commissionLabel(r) },
            { title: 'Rate list', render: (_, r) => rlName(r.rateListId) },
            { title: 'Active', render: (_, r) => <ActiveChip active={r.active} /> },
            { title: 'Actions', render: (_, r) => actions('tpas', r, () => setEditTpa(r)) },
          ]}
        />
      )}

      {tab === 'phlebo' && (
        <DataTable<Phlebo>
          loading={phlebos.loading}
          dataSource={phlebos.data.filter((t) => match(`${t.name} ${t.phone}`))}
          emptyTitle="No phlebotomists yet"
          toolbar={<Toolbar><Input.Search allowClear aria-label="Search phlebotomists" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" /><Spacer /></Toolbar>}
          columns={[
            { title: 'Name', dataIndex: 'name' },
            { title: 'Gender', dataIndex: 'gender', render: (v: string) => (v ? v[0].toUpperCase() + v.slice(1) : '') },
            { title: 'Phone', dataIndex: 'phone' },
            { title: 'Email', dataIndex: 'email' },
            { title: 'Commission', render: (_, r) => commissionLabel(r) },
            { title: 'Active', render: (_, r) => <ActiveChip active={r.active} /> },
            { title: 'Actions', render: (_, r) => actions('phlebotomists', r, () => setEditPh(r)) },
          ]}
        />
      )}

      {tab === 'gov' && (
        <DataTable<GovPanel>
          loading={loading}
          dataSource={gov.data.filter((t) => match(t.name))}
          emptyTitle="No government panels yet"
          toolbar={
            <Toolbar>
              <Input.Search allowClear aria-label="Search panels" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
              <Spacer />
              <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export CSV</Button>
            </Toolbar>
          }
          columns={[
            { title: 'Panel name', dataIndex: 'name' },
            { title: 'Panel type', dataIndex: 'panelType', render: (v: string) => v[0].toUpperCase() + v.slice(1) },
            { title: 'Recipient address', dataIndex: 'recipientAddress' },
            { title: 'Price list', render: (_, r) => rlName(r.rateListId) || <span className="pt-muted">MRP</span> },
            { title: 'Active', render: (_, r) => <ActiveChip active={r.active} /> },
            { title: 'Actions', render: (_, r) => actions('govPanels', r, () => setEditGov(r), 'govPanel') },
          ]}
        />
      )}

      <ReferrerDrawer value={editing} onClose={() => setEditing(null)} pros={pros.data} />
      <TpaDrawer value={editTpa} onClose={() => setEditTpa(null)} />
      <GovDrawer value={editGov} onClose={() => setEditGov(null)} />
      <Modal title={editPh?.id ? 'Edit phlebotomist' : 'Add phlebotomist'} open={!!editPh} onCancel={() => setEditPh(null)} destroyOnHidden okText="Save"
        onOk={async () => {
          if (!editPh?.name?.trim()) return void message.warning('Name is required')
          await saveMaster('phlebotomists', editPh.id ?? null, { name: editPh.name.trim(), gender: editPh.gender ?? '', phone: editPh.phone ?? '', email: editPh.email ?? '', commissionType: editPh.commissionType ?? 'none', commissionValue: editPh.commissionValue ?? 0, active: editPh.active !== false })
          setEditPh(null)
        }}>
        <Form layout="vertical" component="div">
          <FormSection title="Phlebotomist" description="Who they are and how to reach them.">
            <FieldGrid min={220}>
              <Form.Item label="Name" required><Input aria-label="Name" value={editPh?.name} onChange={(e) => setEditPh({ ...editPh, name: e.target.value })} /></Form.Item>
              <Form.Item label="Gender"><Select aria-label="Gender" value={editPh?.gender} onChange={(v) => setEditPh({ ...editPh, gender: v })} options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} /></Form.Item>
              <Form.Item label="Phone"><Input aria-label="Phone" value={editPh?.phone} onChange={(e) => setEditPh({ ...editPh, phone: e.target.value })} /></Form.Item>
              <Form.Item label="Email"><Input aria-label="Email" value={editPh?.email} onChange={(e) => setEditPh({ ...editPh, email: e.target.value })} /></Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Commission" description="Percent of the bill, or paise per bill when flat.">
            <FieldGrid min={220}>
              <Form.Item label="Commission type"><Select aria-label="Commission type" value={editPh?.commissionType} onChange={(v) => setEditPh({ ...editPh, commissionType: v })} options={COMMISSION_OPTS} /></Form.Item>
              <Form.Item label="Commission value"><InputNumber aria-label="Commission value" style={{ width: '100%' }} min={0} value={editPh?.commissionValue} onChange={(v) => setEditPh({ ...editPh, commissionValue: v ?? 0 })} /></Form.Item>
            </FieldGrid>
          </FormSection>
        </Form>
      </Modal>
      <BulkUpload open={bulk} onClose={() => setBulk(false)} type={tab === 'hospital' ? 'hospital' : tab === 'second' ? 'second' : 'doctor'} />
      <MergeModal source={merge} onClose={() => setMerge(null)} referrers={referrers.data} />
      <CommissionLedger
        open={ledger}
        onClose={() => setLedger(false)}
        kind="referrer"
        title="Commission ledger: referrers"
        partners={referrers.data.filter((r) => !r.mergedInto)}
        accruedFor={(id, os) => {
          const r = referrers.data.find((x) => x.id === id)
          return r ? totalsFor(r, os, settings.referrals.commissionBasis).commission : 0
        }}
      />
      <StatementModal open={stmt} onClose={() => setStmt(false)} referrers={referrers.data} />
      <PriceListDrawer open={!!pl} onClose={() => setPl(null)} owner={pl && { collection: pl.collection, id: pl.id, name: pl.name, rateListId: pl.rateListId, kind: pl.kind }} />
    </div>
  )
}

// ---- Add / edit referrer ---------------------------------------------------

function CommissionFields({ rupeesFlat }: { rupeesFlat?: boolean }) {
  const type = Form.useWatch('commissionType') as CommissionType | undefined
  return (
    <div className="pt-grid2">
      <Form.Item name="commissionType" label="Commission type"><Select options={COMMISSION_OPTS} /></Form.Item>
      {type !== 'none' && (
        <Form.Item name="commissionValue" label={type === 'flat' ? 'Commission per bill (Rs)' : 'Commission (%)'}>
          <InputNumber min={0} max={type === 'percent' ? 100 : undefined} precision={2} style={{ width: '100%' }} disabled={rupeesFlat === false} />
        </Form.Item>
      )}
    </div>
  )
}

type RuleForm = { scope?: CommissionRule['scope']; refId?: string; refName?: string; type?: CommissionType; value?: number }
type WithRules = { commissionType?: CommissionType; commissionValue?: number; commissionRules?: RuleForm[] }
const toForm = <T extends WithRules>(v: T) => ({
  ...v,
  commissionValue: v.commissionType === 'flat' ? (v.commissionValue ?? 0) / 100 : (v.commissionValue ?? 0),
  commissionRules: v.commissionRules?.map((r) => ({ ...r, value: r.type === 'flat' ? (r.value ?? 0) / 100 : (r.value ?? 0) })),
})
const fromForm = <T extends WithRules>(v: T) => ({
  ...v,
  commissionValue: v.commissionType === 'flat' ? toPaise(v.commissionValue ?? 0) : v.commissionType === 'none' ? 0 : (v.commissionValue ?? 0),
  commissionRules: (v.commissionRules ?? [])
    .filter((r) => r.scope && r.refId && r.type)
    .map((r) => ({ scope: r.scope!, refId: r.refId!, refName: r.refName ?? '', type: r.type!, value: r.type === 'flat' ? toPaise(r.value ?? 0) : r.type === 'none' ? 0 : (r.value ?? 0) })),
})

// Per-test / package / department commission overrides, plus the rate-list-difference mode.
function CommissionRulesFields({ form }: { form: ReturnType<typeof Form.useForm>[0] }) {
  const { tests, packages, departments } = useCatalogueMaps()
  const rates = useRateLists()
  const mode = Form.useWatch('commissionMode', form) as string | undefined
  const options = (scope?: string) =>
    (scope === 'test' ? tests : scope === 'package' ? packages : scope === 'department' ? departments : []).map((x) => ({ value: x.id, label: x.name }))
  return (
    <>
      <div className="pt-grid2">
        <Form.Item name="commissionMode" label="Commission method" tooltip="Rate-list difference: the lab bills at the line price and the referrer keeps the gap above the price in the cost list.">
          <Select options={[{ value: 'standard', label: 'Standard (type and value above)' }, { value: 'rateListDiff', label: 'Rate-list difference' }]} />
        </Form.Item>
        {mode === 'rateListDiff' && (
          <Form.Item name="commissionListId" label="Cost price list" tooltip="Prices the lab keeps per test. Lines not in this list use the standard commission.">
            <Select allowClear showSearch optionFilterProp="label" options={rates.data.filter((r) => r.active).map((r) => ({ value: r.id, label: r.name }))} />
          </Form.Item>
        )}
      </div>
      <Form.List name="commissionRules">
        {(fields, { add, remove }) => (
          <div style={{ marginBottom: 12 }}>
            <div className="pt-muted" style={{ marginBottom: 6 }}>Overrides by test, package or department (the most specific one wins).</div>
            {fields.map((f) => (
              <div key={f.key} className="pt-rule">
                <Form.Item name={[f.name, 'scope']} rules={[{ required: true }]}>
                  <Select aria-label="Rule applies to" placeholder="Applies to" options={[{ value: 'test', label: 'Test' }, { value: 'package', label: 'Package' }, { value: 'department', label: 'Department' }]} onChange={() => form.setFieldValue(['commissionRules', f.name, 'refId'], undefined)} />
                </Form.Item>
                <Form.Item noStyle shouldUpdate>
                  {({ getFieldValue }) => (
                    <Form.Item name={[f.name, 'refId']} rules={[{ required: true }]}>
                      <Select
                        aria-label="Rule item"
                        showSearch
                        optionFilterProp="label"
                        placeholder="Pick one"
                        options={options(getFieldValue(['commissionRules', f.name, 'scope']))}
                        onChange={(_, o) => form.setFieldValue(['commissionRules', f.name, 'refName'], (o as { label?: string })?.label ?? '')}
                      />
                    </Form.Item>
                  )}
                </Form.Item>
                <Form.Item name={[f.name, 'refName']} hidden><Input /></Form.Item>
                <Form.Item name={[f.name, 'type']} rules={[{ required: true }]}>
                  <Select aria-label="Rule commission type" placeholder="Type" options={COMMISSION_OPTS} />
                </Form.Item>
                <Form.Item name={[f.name, 'value']}>
                  <InputNumber aria-label="Rule value" min={0} precision={2} placeholder="% or Rs" style={{ width: '100%' }} />
                </Form.Item>
                <Button variant="text" aria-label="Remove rule" icon={<MinusCircleOutlined />} onClick={() => remove(f.name)} />
              </div>
            ))}
            <Button icon={<PlusOutlined />} onClick={() => add({ scope: 'test', type: 'percent', value: 0 })}>Add override</Button>
          </div>
        )}
      </Form.List>
    </>
  )
}

function ReferrerDrawer({ value, onClose, pros }: { value: Partial<Referrer> | null; onClose: () => void; pros: MarketingMember[] }) {
  const [form] = Form.useForm()
  const rates = useRateLists()
  const [busy, setBusy] = useState(false)
  const isHospital = value?.type === 'hospital'
  const submit = async () => {
    const v = await form.validateFields()
    setBusy(true)
    try {
      await saveMaster('referrers', value?.id ?? null, { ...fromForm(v), type: value?.type ?? 'doctor', rateListId: v.rateListId ?? '', proManagerId: v.proManagerId ?? '', commissionMode: v.commissionMode ?? 'standard', commissionListId: v.commissionMode === 'rateListDiff' ? (v.commissionListId ?? '') : '' })
      message.success('Saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer
      open={!!value}
      onClose={onClose}
      size="large"
      destroyOnHidden
      title={value?.id ? `Edit ${isHospital ? 'hospital' : 'referrer'}` : `Add ${isHospital ? 'hospital' : value?.type === 'second' ? 'second referral' : 'doctor'}`}
      footer={<div className="pt-sticky-foot"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy}>Save</Button></div>}
    >
      <Form form={form} layout="vertical" initialValues={toForm({ active: true, temporary: false, commissionType: 'percent', commissionValue: 0, commissionMode: 'standard', countryCode: '+91', ...value } as Referrer)}>
        <FormSection title="Contact details" description="Who the referrer is and how to reach them.">
          <FieldGrid min={220}>
            <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}><Input /></Form.Item>
            {!isHospital && <Form.Item name="degree" label="Degree"><Input /></Form.Item>}
            <Form.Item name="speciality" label="Speciality"><Input /></Form.Item>
            <Form.Item name="countryCode" label="Country code"><Select showSearch options={['+91', '+1', '+44', '+971', '+966', '+977', '+880', '+94', '+65', '+61'].map((c) => ({ value: c, label: c }))} /></Form.Item>
            <Form.Item name="phone" label="Phone"><Input inputMode="tel" /></Form.Item>
            <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Enter a valid email' }]}><Input /></Form.Item>
            <Form.Item name="proManagerId" label="PRO / marketing manager">
              <Select allowClear showSearch optionFilterProp="label" options={pros.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))} />
            </Form.Item>
          </FieldGrid>
          <Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item>
        </FormSection>
        <FormSection title="Commission" description="How much this referrer earns on the bills they send.">
          <CommissionFields />
          <CommissionRulesFields form={form} />
          <FieldGrid min={240}>
            <Form.Item name="discountBearer" label="Discount borne by" tooltip="Who absorbs a bill discount when commission is calculated. Blank = plain commission basis.">
              <Select allowClear placeholder="Not adjusted" options={[{ value: 'lab', label: 'Lab only' }, { value: 'referrer', label: 'Referrer' }, { value: 'split', label: 'Split' }]} />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(a, b) => a.discountBearer !== b.discountBearer}>
              {({ getFieldValue }) => getFieldValue('discountBearer') === 'split' && <Form.Item name="discountSplitReferrerPct" label="Referrer's share of discount"><InputNumber min={0} max={100} addonAfter="%" style={{ width: '100%' }} /></Form.Item>}
            </Form.Item>
          </FieldGrid>
        </FormSection>
        <FormSection title="Pricing" description="Which prices this referrer's bills use.">
          <Form.Item name="rateListId" label="Rate list">
            <Select allowClear showSearch optionFilterProp="label" placeholder="MRP (no list)" options={rates.data.filter((r) => r.active).map((r) => ({ value: r.id, label: r.name }))} />
          </Form.Item>
        </FormSection>
        <FormSection title="Settings">
          <SettingRow label="Auto-send paid reports" help="Reports are sent to the referrer once the bill is paid." htmlFor="rf-auto"><Form.Item name="autoSendReports" valuePropName="checked" noStyle><Switch id="rf-auto" /></Form.Item></SettingRow>
          <SettingRow label="Temporary referrer" help="Quick-added at billing; merge later." htmlFor="rf-temp"><Form.Item name="temporary" valuePropName="checked" noStyle><Switch id="rf-temp" /></Form.Item></SettingRow>
          <SettingRow label="B2B" help="Treat this referrer as a business account." htmlFor="rf-b2b"><Form.Item name="b2b" valuePropName="checked" noStyle><Switch id="rf-b2b" /></Form.Item></SettingRow>
          <SettingRow label="Login access" help="Allow this referrer to sign in to the portal." htmlFor="rf-login"><Form.Item name="loginAccess" valuePropName="checked" noStyle><Switch id="rf-login" /></Form.Item></SettingRow>
          <SettingRow label="Active" help="Inactive referrers are hidden when billing." htmlFor="rf-active"><Form.Item name="active" valuePropName="checked" noStyle><Switch id="rf-active" /></Form.Item></SettingRow>
        </FormSection>
      </Form>
    </Drawer>
  )
}

function TpaDrawer({ value, onClose }: { value: Partial<Tpa> | null; onClose: () => void }) {
  const [form] = Form.useForm()
  const rates = useRateLists()
  const submit = async () => {
    const v = await form.validateFields()
    try {
      await saveMaster('tpas', value?.id ?? null, { ...fromForm(v), rateListId: v.rateListId ?? '' })
      message.success('Saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Drawer open={!!value} onClose={onClose} destroyOnHidden title={value?.id ? 'Edit TPA' : 'Add TPA'}
      footer={<div className="pt-sticky-foot"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save</Button></div>}>
      <Form form={form} layout="vertical" initialValues={toForm({ active: true, commissionType: 'none', commissionValue: 0, ...value })}>
        <FormSection title="Contact details">
          <FieldGrid min={220}>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="phone" label="Phone"><Input /></Form.Item>
            <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input /></Form.Item>
          </FieldGrid>
        </FormSection>
        <FormSection title="Commission and pricing" description="Commission earned and the price list used for this TPA's bills.">
          <CommissionFields />
          <Form.Item name="rateListId" label="Rate list"><Select allowClear options={rates.data.map((r) => ({ value: r.id, label: r.name }))} /></Form.Item>
        </FormSection>
        <FormSection title="Settings">
          <SettingRow label="Active" help="Inactive TPAs are hidden when billing." htmlFor="tpa-active"><Form.Item name="active" valuePropName="checked" noStyle><Switch id="tpa-active" /></Form.Item></SettingRow>
        </FormSection>
      </Form>
    </Drawer>
  )
}

function GovDrawer({ value, onClose }: { value: Partial<GovPanel> | null; onClose: () => void }) {
  const [form] = Form.useForm()
  const rates = useRateLists()
  const submit = async () => {
    const v = await form.validateFields()
    try {
      await saveMaster('govPanels', value?.id ?? null, { ...v, rateListId: v.rateListId ?? '' })
      message.success('Saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Drawer open={!!value} onClose={onClose} destroyOnHidden title={value?.id ? 'Edit government panel' : 'Add government panel'}
      footer={<div className="pt-sticky-foot"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save</Button></div>}>
      <Form form={form} layout="vertical" initialValues={{ active: true, panelType: 'central', ...value }}>
        <FormSection title="Panel details">
          <FieldGrid min={220}>
            <Form.Item name="name" label="Panel name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="panelType" label="Panel type"><Select options={['central', 'state', 'municipal', 'other'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} /></Form.Item>
          </FieldGrid>
          <Form.Item name="recipientAddress" label="Recipient address"><Input.TextArea rows={3} /></Form.Item>
        </FormSection>
        <FormSection title="Pricing and status">
          <Form.Item name="rateListId" label="Price list"><Select allowClear options={rates.data.map((r) => ({ value: r.id, label: r.name }))} /></Form.Item>
          <SettingRow label="Active" help="Inactive panels are hidden when billing." htmlFor="gov-active"><Form.Item name="active" valuePropName="checked" noStyle><Switch id="gov-active" /></Form.Item></SettingRow>
        </FormSection>
      </Form>
    </Drawer>
  )
}

// ---- Bulk upload -------------------------------------------------------------

const TEMPLATE = [
  ['name', 'degree', 'phone', 'email', 'speciality', 'commissionType', 'commissionValue', 'temporary'],
  ['Dr Example', 'MBBS', '9999999999', 'dr@example.com', 'Physician', 'percent', '10', 'no'],
]

function BulkUpload({ open, onClose, type }: { open: boolean; onClose: () => void; type: Referrer['type'] }) {
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [busy, setBusy] = useState(false)
  const valid = rows.filter((r) => r.name)
  const run = async () => {
    setBusy(true)
    try {
      for (const r of valid) {
        const ct = (['percent', 'flat', 'none'].includes(r.commissiontype) ? r.commissiontype : 'none') as CommissionType
        const val = parseFloat(r.commissionvalue) || 0
        await saveMaster('referrers', null, {
          name: r.name, degree: r.degree ?? '', type, phone: r.phone ?? '', email: r.email ?? '', address: r.address ?? '',
          speciality: r.speciality ?? '', commissionType: ct, commissionValue: ct === 'flat' ? toPaise(val) : val,
          rateListId: '', proManagerId: '', temporary: /^(y|yes|true|1)$/i.test(r.temporary ?? ''), active: true,
        })
      }
      message.success(`Imported ${valid.length} referrer(s)`)
      setRows([])
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onCancel={onClose} title="Bulk upload referrers" okText={`Import ${valid.length}`} onOk={run} okButtonProps={{ disabled: !valid.length, loading: busy }} destroyOnHidden>
      <p className="pt-muted">Upload a CSV with the columns of the template. Commission value is a percent, or rupees for flat.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('referrer-template', TEMPLATE)}>Download template</Button>
        <FileButton label="Choose CSV" icon={<UploadOutlined />} onText={(t) => setRows(parseCsvObjects(t))} />
      </div>
      {rows.length > 0 && <Alert type="info" showIcon message={`${valid.length} valid row(s) of ${rows.length}`} />}
    </Modal>
  )
}

// ---- Merge temporary referrer -----------------------------------------------

function MergeModal({ source, onClose, referrers }: { source: Referrer | null; onClose: () => void; referrers: Referrer[] }) {
  const [target, setTarget] = useState<string>()
  const [busy, setBusy] = useState(false)
  const { branchId } = useBranchScope()
  const targets = referrers.filter((r) => source && r.id !== source.id && r.type === source.type && !r.temporary && !r.mergedInto)
  const run = async () => {
    const t = referrers.find((r) => r.id === target)
    if (!source || !t) return
    setBusy(true)
    try {
      // Re-point this branch's bills (by id, and by free-text name) to the real referrer.
      const [byId, byName] = await Promise.all([
        getDocs(query(col(paths.orders), where('referrerId', '==', source.id))),
        getDocs(query(col(paths.orders), where('referrerName', '==', source.name))),
      ])
      const seen = new Set<string>()
      const batch = writeBatch(db)
      let n = 0
      for (const d of [...byId.docs, ...byName.docs]) {
        const o = d.data() as PartnerOrder
        if (seen.has(d.id) || (o.branchId ?? 'main') !== branchId) continue
        seen.add(d.id)
        batch.update(docRef(paths.orders, d.id), { referrerId: t.id, referrerName: t.name })
        if (++n >= 450) break
      }
      batch.update(docRef('referrers', source.id), { active: false, mergedInto: t.id })
      await batch.commit()
      message.success(`Merged into ${t.name}; ${n} bill(s) updated in this branch`)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={!!source} onCancel={onClose} title={`Merge ${source?.name ?? ''}`} okText="Merge" onOk={run} okButtonProps={{ disabled: !target, loading: busy }} destroyOnHidden>
      <p>The temporary referrer is hidden and its bills in this branch are moved to the referrer you choose.</p>
      <Select style={{ width: '100%' }} showSearch optionFilterProp="label" aria-label="Merge into" placeholder="Merge into" value={target} onChange={setTarget} options={targets.map((r) => ({ value: r.id, label: `${r.name}${r.phone ? ` (${r.phone})` : ''}` }))} />
    </Modal>
  )
}

// ---- Commission statement ---------------------------------------------------

function StatementModal({ open, onClose, referrers }: { open: boolean; onClose: () => void; referrers: Referrer[] }) {
  const [range, setRange] = useState<Range>(thisMonth())
  const [rid, setRid] = useState<string>('all')
  const basis = useLabSettings().referrals.commissionBasis
  const orders = usePartnerOrders(range)
  const list = referrers.filter((r) => (rid === 'all' || r.id === rid))
  const rows = list
    .map((r) => ({ r, t: totalsFor(r, orders.data, basis) }))
    .filter((x) => x.t.bills > 0)
  const detail = rid === 'all' ? [] : orders.data.filter((o) => referrers.find((r) => r.id === rid) && orderMatchesReferrer(o, referrers.find((r) => r.id === rid)!))
  const total = rows.reduce((s, x) => s + x.t.commission, 0)
  const sel = referrers.find((r) => r.id === rid)
  const period = `${range[0].format('DD MMM YYYY')} to ${range[1].format('DD MMM YYYY')}`

  const exportCsv = () =>
    rid === 'all'
      ? downloadCsv('commission-statement', [['referrer', 'bills', 'gross', 'net', 'commission'], ...rows.map(({ r, t }) => [r.name, t.bills, t.gross / 100, t.net / 100, t.commission / 100])])
      : downloadCsv(`commission-${sel?.name}`, [['bill', 'date', 'patient', 'net', 'commission'], ...detail.map((o) => [o.billNo, fmtDate(orderDate(o)), o.patientName, o.net / 100, commissionForReferrer(o, sel!, basis) / 100])])
  const print = () =>
    printHtml('Commission statement', `<h1>Commission statement</h1><div class="muted">${esc(period)}</div>
<table><tr><th>${rid === 'all' ? 'Referrer' : 'Bill'}</th><th class="n">${rid === 'all' ? 'Bills' : 'Net'}</th><th class="n">Commission</th></tr>
${rid === 'all' ? rows.map(({ r, t }) => `<tr><td>${esc(r.name)}</td><td class="n">${t.bills}</td><td class="n">${formatINR(t.commission)}</td></tr>`).join('') : detail.map((o) => `<tr><td>${esc(o.billNo)} ${esc(o.patientName)}</td><td class="n">${formatINR(o.net)}</td><td class="n">${formatINR(commissionForReferrer(o, sel!, basis))}</td></tr>`).join('')}
<tr><th>Total</th><th></th><th class="n">${formatINR(total)}</th></tr></table>`)

  return (
    <Modal open={open} onCancel={onClose} title="Commission statement" width={dialogWidth(760)} destroyOnHidden footer={<><Button icon={<DownloadOutlined />} onClick={exportCsv}>Export CSV</Button><Button icon={<PrinterOutlined />} onClick={print}>Print</Button></>}>
      <Toolbar>
        <RangeField value={range} onChange={setRange} />
        <Select aria-label="Referrer" showSearch optionFilterProp="label" style={{ minWidth: 220 }} value={rid} onChange={setRid} options={[{ value: 'all', label: 'All referrers' }, ...referrers.map((r) => ({ value: r.id, label: r.name }))]} />
      </Toolbar>
      <Kpis items={[{ label: 'Referrers with bills', value: rows.length }, { label: 'Bills', value: rows.reduce((s, x) => s + x.t.bills, 0) }, { label: 'Commission payable', value: formatINR(total) }]} />
      {rid === 'all' ? (
        <Table size="small" rowKey={(x) => x.r.id} loading={orders.loading} dataSource={rows} pagination={{ pageSize: 10, hideOnSinglePage: true }}
          columns={[
            { title: 'Referrer', render: (_, x) => x.r.name },
            { title: 'Commission terms', render: (_, x) => commissionLabel(x.r) },
            { title: 'Bills', align: 'right', render: (_, x) => x.t.bills },
            { title: 'Net billed', align: 'right', render: (_, x) => <span className="pt-num">{formatINR(x.t.net)}</span> },
            { title: 'Commission', align: 'right', render: (_, x) => <span className="pt-num">{formatINR(x.t.commission)}</span> },
          ]} />
      ) : (
        <Table size="small" rowKey="id" loading={orders.loading} dataSource={detail} pagination={{ pageSize: 10, hideOnSinglePage: true }}
          columns={[
            { title: 'Bill', dataIndex: 'billNo' },
            { title: 'Date', render: (_, o) => fmtDate(orderDate(o)) },
            { title: 'Patient', dataIndex: 'patientName' },
            { title: 'Net', align: 'right', render: (_, o) => <span className="pt-num">{formatINR(o.net)}</span> },
            { title: 'Commission', align: 'right', render: (_, o) => <span className="pt-num">{formatINR(commissionForReferrer(o, sel!, basis))}</span> },
          ]} />
      )}
    </Modal>
  )
}
