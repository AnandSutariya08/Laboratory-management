import { FieldGrid, FormSection, SettingRow } from '../../design/FormLayout'
import { useMemo, useState } from 'react'
import { Alert, App, Drawer, Form, Input, InputNumber, Modal, Select, Switch, Tree, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined, LinkOutlined, PlusOutlined, ProfileOutlined } from '@ant-design/icons'
import { writeBatch } from 'firebase/firestore'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { db } from '../../firebase'
import { docRef } from '../../lib/db'
import { formatINR, toPaise } from '../../lib/money'
import { useLabSettings } from '../../hooks/useCatalogue'
import { commissionLabel, marketingCommissionForOrder, totalsFor } from './lib/commission'
import CommissionLedger from './CommissionLedger'
import { downloadCsv } from './lib/csv'
import { removeMaster, saveMaster, useMaster } from './lib/master'
import { usePartnerOrders, type Range } from './lib/orders'
import { PriceListDrawer } from './RateListEditor'
import type { CommissionType, MarketingMember, MarketingRole, Referrer } from './types'
import { ActiveChip, DataTable, Kpis, RangeField, Spacer, thisMonth, Toolbar } from './ui'

// Members below `id` in the reporting tree (cycle safe).
export function descendantsOf(id: string, team: Pick<MarketingMember, 'id' | 'parentId'>[]): Set<string> {
  const kids = new Map<string, string[]>()
  for (const m of team) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m.id])
  const out = new Set<string>()
  const walk = (x: string) => { for (const k of kids.get(x) ?? []) if (!out.has(k) && k !== id) { out.add(k); walk(k) } }
  walk(id)
  return out
}

const ROLES: { value: MarketingRole; label: string }[] = [
  { value: 'pro', label: 'PRO' },
  { value: 'area', label: 'Area manager' },
  { value: 'district', label: 'District manager' },
  { value: 'state', label: 'State manager' },
  { value: 'zone', label: 'Zone head' },
  { value: 'cmo', label: 'CMO' },
]

export default function MarketingTeamPage() {
  const { modal } = App.useApp()
  const settings = useLabSettings()
  const [role, setRole] = useState<MarketingRole>('pro')
  const [q, setQ] = useState('')
  const [range, setRange] = useState<Range>(thisMonth())
  const [edit, setEdit] = useState<Partial<MarketingMember> | null>(null)
  const [assign, setAssign] = useState<MarketingMember | null>(null)
  const [pl, setPl] = useState<MarketingMember | null>(null)
  const { profile } = useAuth()
  const [view, setView] = useState<'list' | 'tree'>('list')
  const [ledger, setLedger] = useState(false)
  const [del, setDel] = useState<MarketingMember | null>(null)
  const [reassign, setReassign] = useState<string | undefined>()
  const team = useMaster<MarketingMember>('marketingTeam')
  const refs = useMaster<Referrer>('referrers')
  const orders = usePartnerOrders(range)

  const basis = settings.referrals.commissionBasis
  const mappedPro = useMemo(() => {
    const byRef = new Map(refs.data.map((r) => [r.id, r.proManagerId]))
    return (o: { referrerId?: string; hospitalId?: string }) => (o.referrerId && byRef.get(o.referrerId)) || (o.hospitalId && byRef.get(o.hospitalId)) || undefined
  }, [refs.data])
  const perf = useMemo(() => {
    const m = new Map<string, { referrers: number; bills: number; revenue: number; commission: number; own: number; teamBills: number; teamRevenue: number; teamOwn: number }>()
    for (const p of team.data) {
      const mine = refs.data.filter((r) => r.proManagerId === p.id)
      let bills = 0, revenue = 0, commission = 0
      for (const r of mine) {
        const t = totalsFor(r, orders.data, basis)
        bills += t.bills; revenue += t.net; commission += t.commission
      }
      const own = orders.data.reduce((n, o) => n + marketingCommissionForOrder(o, p, basis, mappedPro), 0)
      m.set(p.id, { referrers: mine.length, bills, revenue, commission, own, teamBills: bills, teamRevenue: revenue, teamOwn: own })
    }
    // the subtree view: a manager's figures include everyone below them
    for (const p of team.data) {
      const x = m.get(p.id)!
      for (const d of descendantsOf(p.id, team.data)) {
        const y = m.get(d)
        if (y) { x.teamBills += y.bills; x.teamRevenue += y.revenue; x.teamOwn += y.own }
      }
    }
    return m
  }, [team.data, refs.data, orders.data, basis, mappedPro])

  const kidsOf = (id: string) => team.data.filter((m) => m.parentId === id)
  const tryDelete = (p: MarketingMember) => {
    const kids = kidsOf(p.id)
    const mapped = refs.data.filter((r) => r.proManagerId === p.id)
    if (kids.length === 0 && mapped.length === 0) {
      removeMaster('marketingTeam', p.id).then(() => message.success('Deleted'), (e) => message.error(e.message))
      return
    }
    setReassign(undefined)
    setDel(p)
  }
  const confirmDelete = async () => {
    if (!del) return
    try {
      const b = writeBatch(db)
      for (const k of kidsOf(del.id)) b.update(docRef('marketingTeam', k.id), { parentId: reassign ?? del.parentId ?? '' })
      for (const r of refs.data.filter((x) => x.proManagerId === del.id)) b.update(docRef('referrers', r.id), { proManagerId: reassign ?? '' })
      b.delete(docRef('marketingTeam', del.id))
      await b.commit()
      message.success('Deleted')
      setDel(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const treeData = useMemo(() => {
    const ids = new Set(team.data.map((m) => m.id))
    const node = (m: MarketingMember, seen: Set<string>): { key: string; title: React.ReactNode; children: unknown[] } => {
      const x = perf.get(m.id)
      const next = new Set(seen).add(m.id)
      return {
        key: m.id,
        title: (
          <span>
            <b>{m.name}</b> <span className="pt-muted">{ROLES.find((r) => r.value === m.role)?.label} · team bills {x?.teamBills ?? 0} · team revenue {formatINR(x?.teamRevenue ?? 0)}{!m.active ? ' · inactive' : ''}</span>
          </span>
        ),
        children: kidsOf(m.id).filter((k) => !next.has(k.id)).map((k) => node(k, next)),
      }
    }
    return team.data.filter((m) => !m.parentId || !ids.has(m.parentId)).map((m) => node(m, new Set()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.data, perf])

  const rows = team.data.filter((p) => p.role === role && (!q.trim() || `${p.name} ${p.phone} ${p.area}`.toLowerCase().includes(q.toLowerCase())))
  const exportCsv = () =>
    downloadCsv(`marketing-${role}`, [
      ['name', 'phone', 'email', 'area', 'referrers', 'target bills', 'bills', 'target revenue', 'revenue'],
      ...rows.map((p) => { const x = perf.get(p.id)!; return [p.name, p.phone, p.email, p.area, x.referrers, p.targetBills, x.bills, p.targetRevenue / 100, x.revenue / 100] }),
    ])
  const label = ROLES.find((r) => r.value === role)!.label

  return (
    <div>
      <PageHeader title="Marketing Team" subtitle="PRO and marketing staff, their referrers, targets and performance"
        actions={<><Button onClick={() => setLedger(true)}>Commission ledger</Button><Button variant="primary" icon={<PlusOutlined />} onClick={() => setEdit({ role, active: true, referrerIds: [], commissionType: 'none', commissionValue: 0 })}>Add {label}</Button></>} />
      <div className="pt-tabs">
        <Segmented<'list' | 'tree'> aria-label="Team view" value={view} onChange={setView} options={[{ value: 'list', label: 'By role' }, { value: 'tree', label: 'Hierarchy' }]} />
        {view === 'list' && (
          <Segmented<MarketingRole> aria-label="Team role" value={role} onChange={setRole}
            options={ROLES.map((r) => ({ ...r, count: team.data.filter((p) => p.role === r.value).length }))} />
        )}
      </div>
      {view === 'tree' && (
        <div className="pt-card" style={{ padding: 'var(--s-4)' }}>
          <RangeField value={range} onChange={setRange} />
          {treeData.length === 0 ? <p className="pt-muted">No team members yet.</p> : <Tree showLine defaultExpandAll treeData={treeData as never} selectable={false} style={{ marginTop: 12 }} />}
        </div>
      )}
      {view === 'list' && <>
      <Kpis items={[
        { label: `${label}s`, value: rows.length },
        { label: 'Bills (range)', value: rows.reduce((s, p) => s + perf.get(p.id)!.bills, 0) },
        { label: 'Revenue (range)', value: formatINR(rows.reduce((s, p) => s + perf.get(p.id)!.revenue, 0)) },
      ]} />
      <DataTable<MarketingMember>
        loading={team.loading}
        dataSource={rows}
        emptyTitle={`No ${label} yet`}
        toolbar={
          <Toolbar>
            <Input.Search allowClear aria-label="Search team" placeholder="Search name, phone, area" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
            <RangeField value={range} onChange={setRange} />
            <Spacer />
            <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export CSV</Button>
          </Toolbar>
        }
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Contact', render: (_, p) => <span>{p.phone}<br /><span className="pt-muted">{p.email}</span></span> },
          { title: 'Area', dataIndex: 'area' },
          { title: 'Commission', render: (_, p) => commissionLabel({ commissionType: p.commissionType ?? 'none', commissionValue: p.commissionValue ?? 0 }) },
          { title: 'Reports to', render: (_, p) => team.data.find((m) => m.id === p.parentId)?.name ?? <span className="pt-muted">-</span> },
          { title: 'Referrers', align: 'right', render: (_, p) => <span className="pt-num">{perf.get(p.id)?.referrers}</span> },
          { title: 'Team bills', align: 'right', render: (_, p) => <span className="pt-num">{perf.get(p.id)?.teamBills}</span> },
          { title: 'Commission earned', align: 'right', render: (_, p) => <span className="pt-num">{formatINR(perf.get(p.id)?.own ?? 0)}</span> },
          { title: 'Bills / target', align: 'right', render: (_, p) => <span className="pt-num">{perf.get(p.id)?.bills} / {p.targetBills || '-'}</span> },
          { title: 'Revenue / target', align: 'right', render: (_, p) => <span className="pt-num">{formatINR(perf.get(p.id)?.revenue ?? 0)} / {p.targetRevenue ? formatINR(p.targetRevenue) : '-'}</span> },
          { title: 'Active', render: (_, p) => <ActiveChip active={p.active} /> },
          {
            title: 'Actions',
            render: (_, p) => (
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <Button variant="text" icon={<EditOutlined />} aria-label={`Edit ${p.name}`} onClick={() => setEdit(p)} />
                <Button variant="text" icon={<LinkOutlined />} aria-label={`Assign referrers to ${p.name}`} onClick={() => setAssign(p)} />
                <Button variant="text" icon={<ProfileOutlined />} aria-label={`Commission price list for ${p.name}`} onClick={() => setPl(p)} />
                <Button variant="text" icon={<DeleteOutlined />} aria-label={`Delete ${p.name}`} onClick={() => modal.confirm({ title: `Delete ${p.name}?`, okText: 'Delete', onOk: () => tryDelete(p) })} />
              </span>
            ),
          },
        ]}
      />
      </>}
      <MemberDrawer value={edit} onClose={() => setEdit(null)} team={team.data} />
      <CommissionLedger
        open={ledger}
        onClose={() => setLedger(false)}
        kind="marketing"
        title="Commission ledger: marketing team"
        partners={team.data}
        accruedFor={(id, os) => {
          const m = team.data.find((x) => x.id === id)
          return m ? os.reduce((n, o) => n + marketingCommissionForOrder(o, m, basis, mappedPro), 0) : 0
        }}
      />
      <Modal open={!!del} title={`Delete ${del?.name ?? ''}`} onCancel={() => setDel(null)} onOk={confirmDelete} okText="Delete" okButtonProps={{ danger: true, disabled: !can(profile, 'marketing.manage') }} destroyOnHidden>
        <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`${del ? kidsOf(del.id).length : 0} team member(s) report to ${del?.name} and ${del ? refs.data.filter((r) => r.proManagerId === del.id).length : 0} referrer(s) are mapped to them.`} description="Pick who takes them over. Without a pick the members move up to this person's own manager and the referrers become unassigned." />
        <Select allowClear showSearch optionFilterProp="label" aria-label="Reassign to" placeholder="Reassign to" style={{ width: '100%' }} value={reassign} onChange={setReassign}
          options={team.data.filter((m) => m.id !== del?.id && !descendantsOf(del?.id ?? '', team.data).has(m.id)).map((m) => ({ value: m.id, label: `${m.name} (${ROLES.find((r) => r.value === m.role)?.label})` }))} />
        {!can(profile, 'marketing.manage') && <p className="pt-muted" style={{ marginTop: 8 }}>Only a manager with the marketing permission can delete a member who has a team or referrers.</p>}
      </Modal>
      <AssignModal pro={assign} onClose={() => setAssign(null)} referrers={refs.data} />
      <PriceListDrawer open={!!pl} onClose={() => setPl(null)} owner={pl && { collection: 'marketingTeam', id: pl.id, name: pl.name, rateListId: pl.rateListId, kind: 'custom' }} />
    </div>
  )
}

function MemberDrawer({ value, onClose, team }: { value: Partial<MarketingMember> | null; onClose: () => void; team: MarketingMember[] }) {
  const [form] = Form.useForm()
  const type = Form.useWatch('commissionType', form) as CommissionType | undefined
  const submit = async () => {
    const v = await form.validateFields()
    try {
      await saveMaster('marketingTeam', value?.id ?? null, {
        ...v,
        role: value?.role ?? v.role,
        targetRevenue: toPaise(v.targetRevenueRs ?? 0),
        targetRevenueRs: undefined,
        commissionValue: v.commissionType === 'flat' ? toPaise(v.commissionValue ?? 0) : (v.commissionValue ?? 0),
        parentId: v.parentId ?? '',
        referrerIds: value?.referrerIds ?? [],
        rateListId: value?.rateListId ?? '',
      })
      message.success('Saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const init = { active: true, commissionType: 'none', targetBills: 0, ...value,
    targetRevenueRs: (value?.targetRevenue ?? 0) / 100,
    commissionValue: value?.commissionType === 'flat' ? (value.commissionValue ?? 0) / 100 : (value?.commissionValue ?? 0) }
  return (
    <Drawer open={!!value} onClose={onClose} destroyOnHidden title={value?.id ? 'Edit team member' : 'Add team member'}
      footer={<div className="pt-sticky-foot"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save</Button></div>}>
      <Form form={form} layout="vertical" initialValues={init}>
        <FormSection title="Team member" description="Who they are, their role and who they report to.">
          <FieldGrid min={220}>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="role" label="Role"><Select options={ROLES} /></Form.Item>
            <Form.Item name="phone" label="Phone"><Input /></Form.Item>
            <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input /></Form.Item>
            <Form.Item name="area" label="Area / territory"><Input /></Form.Item>
          </FieldGrid>
          <Form.Item name="parentId" label="Reports to" tooltip="The manager above this person. Their figures roll up into that manager's team view.">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Nobody (top of the tree)"
              options={team.filter((m) => m.id !== value?.id && !descendantsOf(value?.id ?? '', team).has(m.id)).map((m) => ({ value: m.id, label: `${m.name} (${ROLES.find((r) => r.value === m.role)?.label})` }))}
            />
          </Form.Item>
        </FormSection>
        <FormSection title="Targets" description="Monthly goals used in the team performance view.">
          <FieldGrid min={220}>
            <Form.Item name="targetBills" label="Target bills / month"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="targetRevenueRs" label="Target revenue / month"><InputNumber min={0} addonBefore="₹" style={{ width: '100%' }} /></Form.Item>
          </FieldGrid>
        </FormSection>
        <FormSection title="Commission" description="What this person earns on the bills they bring in.">
          <FieldGrid min={220}>
            <Form.Item name="commissionType" label="Commission type"><Select options={[{ value: 'none', label: 'None' }, { value: 'percent', label: 'Percent of net' }, { value: 'flat', label: 'Flat per bill' }]} /></Form.Item>
            {type !== 'none' && <Form.Item name="commissionValue" label={type === 'flat' ? 'Per bill' : 'Percent'}><InputNumber min={0} {...(type === 'flat' ? { addonBefore: '₹' } : { addonAfter: '%' })} style={{ width: '100%' }} /></Form.Item>}
          </FieldGrid>
        </FormSection>
        <FormSection title="Status">
          <SettingRow label="Active" help="Inactive members are hidden from assignment lists." htmlFor="mt-active"><Form.Item name="active" valuePropName="checked" noStyle><Switch id="mt-active" /></Form.Item></SettingRow>
        </FormSection>
      </Form>
    </Drawer>
  )
}

// Mapping: choose which referrers belong to this PRO. proManagerId on the referrer is the
// source of truth; referrerIds on the member mirrors it.
function AssignModal({ pro, onClose, referrers }: { pro: MarketingMember | null; onClose: () => void; referrers: Referrer[] }) {
  const [ids, setIds] = useState<string[] | null>(null)
  const current = ids ?? referrers.filter((r) => r.proManagerId === pro?.id).map((r) => r.id)
  const run = async () => {
    if (!pro) return
    try {
      const b = writeBatch(db)
      for (const r of referrers) {
        const should = current.includes(r.id)
        if (should && r.proManagerId !== pro.id) b.update(docRef('referrers', r.id), { proManagerId: pro.id })
        if (!should && r.proManagerId === pro.id) b.update(docRef('referrers', r.id), { proManagerId: '' })
      }
      b.update(docRef('marketingTeam', pro.id), { referrerIds: current })
      await b.commit()
      message.success('Referrers assigned')
      setIds(null)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Modal open={!!pro} onCancel={() => { setIds(null); onClose() }} onOk={run} okText="Save mapping" title={`Assign referrers to ${pro?.name ?? ''}`} destroyOnHidden>
      <Select mode="multiple" style={{ width: '100%' }} aria-label="Referrers" optionFilterProp="label" value={current} onChange={setIds}
        options={referrers.filter((r) => !r.mergedInto).map((r) => ({ value: r.id, label: `${r.name}${r.proManagerId && r.proManagerId !== pro?.id ? ' (mapped elsewhere)' : ''}` }))} />
    </Modal>
  )
}
