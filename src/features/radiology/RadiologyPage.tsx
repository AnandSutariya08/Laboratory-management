import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Checkbox, DatePicker, Drawer, Input, Select, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { DownloadOutlined, FileTextOutlined, FilterOutlined, PictureOutlined, PrinterOutlined, SendOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { can, useAuth } from '../../auth/AuthProvider'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import { StatusChip, type StatusVariant } from '../../design/StatusChip'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonRows } from '../../design/Skeletons'
import { downloadCsv, fmtDateTime } from '../../components/results/common'
import { useLabSettings } from '../../hooks/useCatalogue'
import { tatHoursOf } from './lib'
import { useRadConfig } from './config'
import SendReportModal from '../../components/messaging/SendReportModal'
import { FormFChip } from '../pcpndt/FormFAction'
import MacrosModal from './MacrosModal'
import { useRadRows, type RadRow } from './useRadRows'
import TemplatesModal from './TemplatesModal'
import type { RadStatus } from './types'
import './radiology.css'

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'custom'
type Tab = 'all' | RadStatus

export const RAD_IDS_KEY = 'hcl.radiology.ids'
const STATUS: Record<RadStatus, { label: string; variant: StatusVariant }> = {
  pending: { label: 'Pending', variant: 'neutral' },
  hold: { label: 'On hold', variant: 'caution' },
  second: { label: 'Second opinion', variant: 'info' },
  completed: { label: 'Completed', variant: 'success' },
  delivered: { label: 'Delivered', variant: 'success' },
}
const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'hold', label: 'Hold' },
  { value: 'second', label: 'Second opinion' },
  { value: 'completed', label: 'Completed' },
  { value: 'delivered', label: 'Delivered' },
]

function presetRange(p: Preset): [Dayjs, Dayjs] {
  const now = dayjs()
  if (p === 'yesterday') return [now.subtract(1, 'day').startOf('day'), now.subtract(1, 'day').endOf('day')]
  if (p === '7d') return [now.subtract(6, 'day').startOf('day'), now.endOf('day')]
  if (p === '30d') return [now.subtract(29, 'day').startOf('day'), now.endOf('day')]
  return [now.startOf('day'), now.endOf('day')]
}

export default function RadiologyPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const radCfg = useRadConfig()
  const [sendRow, setSendRow] = useState<RadRow | null>(null)
  const [preset, setPreset] = useState<Preset>('7d')
  const [range, setRange] = useState<[Dayjs, Dayjs]>(presetRange('7d'))
  const [tab, setTab] = useState<Tab>('all')
  const [modality, setModality] = useState('')
  const [search, setSearch] = useState('')
  const [fOpen, setFOpen] = useState(false)
  const [tplOpen, setTplOpen] = useState(false)
  const [macroOpen, setMacroOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])
  const [f, setF] = useState({ referrer: '', urgent: false, doctor: '', secondPending: false })
  const { rows, loading } = useRadRows(range)

  const q = search.trim().toLowerCase()
  const base = useMemo(
    () =>
      rows.filter((r) => {
        if (modality && r.modality !== modality) return false
        if (q && !(r.order.patientName.toLowerCase().includes(q) || r.order.billNo.toLowerCase().includes(q) || r.order.barcode.toLowerCase().includes(q) || r.test.name.toLowerCase().includes(q))) return false
        if (f.referrer && !(r.order.referrerName || 'Self').toLowerCase().includes(f.referrer.toLowerCase())) return false
        if (f.urgent && !r.item.urgent) return false
        if (f.doctor && r.rad?.signatoryId !== f.doctor) return false
        if (f.secondPending && r.status !== 'second') return false
        return true
      }),
    [rows, modality, q, f],
  )
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: base.length, pending: 0, hold: 0, second: 0, completed: 0, delivered: 0 }
    base.forEach((r) => {
      c[r.status]++
      if (r.status === 'delivered') c.completed++ // delivered reports are also completed
    })
    return c
  }, [base])
  const shown = useMemo(
    () =>
      base
        .filter((r) => tab === 'all' || r.status === tab || (tab === 'completed' && r.status === 'delivered'))
        .map((r, i) => ({ r, i }))
        .sort((a, b) => Number(!!b.r.item.urgent) - Number(!!a.r.item.urgent) || a.i - b.i) // urgent first, otherwise keep order
        .map((x) => x.r),
    [base, tab],
  )

  useEffect(() => {
    try {
      sessionStorage.setItem(RAD_IDS_KEY, JSON.stringify(shown.map((r) => `${r.order.id}|${r.test.id}`)))
    } catch {
      /* storage unavailable */
    }
  }, [shown])

  const open = (r: RadRow, extra = '') => navigate(`/radiology/${r.order.id}?test=${r.test.id}${extra}`)
  const tat = (r: RadRow) => {
    const created = r.order.createdAt?.toMillis?.() ?? 0
    if (!created) return null
    const done = r.status === 'completed' || r.status === 'delivered'
    const mins = Math.max(0, Math.round(((done ? (r.result?.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? now : now) - created) / 60000))
    const target = tatHoursOf(r.modality)
    return { text: `${Math.floor(mins / 60)}h ${mins % 60}m`, target, over: !done && mins > target * 60 }
  }
  const exportCsv = () =>
    downloadCsv(`radiology-${dayjs().format('YYYYMMDD')}.csv`, [
      ['Bill date', 'Bill no', 'Patient', 'Age', 'Gender', 'Referral', 'Test', 'Modality', 'Status'],
      ...shown.map((r) => [fmtDateTime(r.order.createdAt), r.order.billNo, r.order.patientName, `${r.order.ageValue} ${r.order.ageUnit}`, r.order.gender, r.order.referrerName || 'Self', r.test.name, r.modality, STATUS[r.status].label]),
    ])

  const columns: ColumnsType<RadRow> = [
    { title: 'Bill date', width: 150, render: (_, r) => fmtDateTime(r.order.createdAt) },
    { title: 'ID', width: 130, render: (_, r) => (<div>{r.order.billNo}<div className="rd-muted">{radCfg.accessionBarcode && r.order.barcode ? `Acc. ${r.order.barcode}` : ''}</div></div>) },
    {
      title: 'Patient info',
      render: (_, r) => (
        <div>
          <Link to={`/radiology/${r.order.id}?test=${r.test.id}`} style={{ color: 'var(--c-primary)', fontWeight: 600 }}>{r.order.patientName}</Link>
          <div className="rd-muted">{r.order.ageValue} {r.order.ageUnit}{r.order.ageValue === 1 ? '' : 's'} / {r.order.gender} / {r.order.patientNo}</div>
        </div>
      ),
    },
    { title: 'Referral', render: (_, r) => r.order.referrerName || 'Self' },
    { title: 'Test', render: (_, r) => {
        const t = tat(r)
        return (<span>{r.test.name}{r.item.urgent && <> <StatusChip variant="urgent">Urgent</StatusChip></>}{t && <div className="rd-muted">{t.text} / TAT {t.target}h{t.over && <> <StatusChip variant="urgent">Overdue</StatusChip></>}</div>}</span>)
      } },
    { title: 'Modality type', width: 130, render: (_, r) => r.modality },
    { title: 'Status', width: 150, render: (_, r) => (<span><StatusChip variant={STATUS[r.status].variant}>{STATUS[r.status].label}</StatusChip>{r.rad?.amended && <> <StatusChip variant="info">Amended</StatusChip></>}</span>) },
    {
      title: 'Action',
      width: 330,
      render: (_, r) => (
        <span className="rd-actions">
        <Button variant={r.status === 'completed' || r.status === 'delivered' ? 'default' : 'primary'} icon={<FileTextOutlined />} onClick={() => open(r)}>
          {r.status === 'completed' || r.status === 'delivered' ? 'View report' : 'Enter report'}
        </Button>
        <Button icon={<PrinterOutlined />} aria-label={`Print report for ${r.order.patientName}`} onClick={() => open(r, '&print=1')}>Print</Button>
        {(r.status === 'completed' || r.status === 'delivered') && can(profile, 'reports.send') && <Button icon={<SendOutlined />} aria-label={`Send report of ${r.order.patientName}`} onClick={() => setSendRow(r)}>Send</Button>}
        <Button icon={<PictureOutlined />} aria-label={`View images for ${r.order.patientName}`} onClick={() => open(r, '&view=images')}>Images</Button>
        <FormFChip order={r.order} />
        </span>
      ),
    },
  ]
  const activeF = (f.referrer ? 1 : 0) + (f.urgent ? 1 : 0) + (f.doctor ? 1 : 0) + (f.secondPending ? 1 : 0)

  return (
    <div>
      <PageHeader
        title="Radiology"
        subtitle="Imaging worklist and reports"
        actions={
          <>
            <Button onClick={() => setTplOpen(true)}>Report templates</Button>
            <Button onClick={() => setMacroOpen(true)}>Macros</Button>
            <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export</Button>
          </>
        }
      />
      <div className="rd-toolbar">
        <Segmented<Preset>
          aria-label="Date range"
          value={preset}
          onChange={(p) => { setPreset(p); if (p !== 'custom') setRange(presetRange(p)) }}
          options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: 'custom', label: 'Custom' }]}
        />
        {preset === 'custom' && <DatePicker.RangePicker aria-label="Custom date range" value={range} allowClear={false} onChange={(v) => v && v[0] && v[1] && setRange([v[0].startOf('day'), v[1].endOf('day')])} />}
      </div>
      <div className="rd-toolbar">
        <Input.Search allowClear aria-label="Search radiology worklist" placeholder="Search patient, bill, barcode, test" className="search-wide" onChange={(e) => setSearch(e.target.value)} />
        <Select aria-label="Modality" style={{ width: 170 }} value={modality} onChange={setModality} options={[{ value: '', label: 'All modalities' }, ...radCfg.modalities.map((m) => ({ value: m.label, label: `${m.label} (${m.code})` }))]} />
        <Button icon={<FilterOutlined />} onClick={() => setFOpen(true)}>Filters{activeF ? ` (${activeF})` : ''}</Button>
      </div>
      <div style={{ marginBottom: 'var(--s-4)' }}>
        <Segmented<Tab> aria-label="Radiology status" value={tab} onChange={setTab} options={TABS.map((t) => ({ ...t, count: counts[t.value] }))} />
      </div>
      <Card padding={0}>
        {loading ? (
          <SkeletonRows rows={8} columns={6} />
        ) : shown.length === 0 ? (
          <EmptyState title="No imaging studies here" description="Studies appear when a bill contains a radiology test. Change the tab, dates or filters to see others." />
        ) : (
          <Table<RadRow> rowKey="key" rowClassName={(r) => (r.item.urgent && r.status !== 'completed' && r.status !== 'delivered' ? 'rd-urgent-row' : '')} columns={columns} dataSource={shown} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 'max-content' }} />
        )}
      </Card>
      <Drawer open={fOpen} onClose={() => setFOpen(false)} title="Filters" width={360} footer={<Button onClick={() => setF({ referrer: '', urgent: false, doctor: '', secondPending: false })}>Reset filters</Button>}>
        <div className="rd-field"><label htmlFor="rf-ref">Referral doctor or hospital</label><Input id="rf-ref" value={f.referrer} onChange={(e) => setF({ ...f, referrer: e.target.value })} /></div>
        <div className="rd-field"><label htmlFor="rf-doc">Reporting doctor</label>
          <Select id="rf-doc" allowClear value={f.doctor || undefined} onChange={(v) => setF({ ...f, doctor: v ?? '' })} options={settings.signatories.map((s) => ({ value: s.id, label: s.name }))} /></div>
        <div className="rd-field"><Checkbox checked={f.urgent} onChange={(e) => setF({ ...f, urgent: e.target.checked })}>Urgent only</Checkbox></div>
        <div className="rd-field"><Checkbox checked={f.secondPending} onChange={(e) => setF({ ...f, secondPending: e.target.checked })}>Second opinion pending</Checkbox></div>
      </Drawer>
      {sendRow && <SendReportModal order={sendRow.order} open onClose={() => setSendRow(null)} tests={[{ id: sendRow.test.id, name: sendRow.test.name }]} defaultTestIds={[sendRow.test.id]} />}
      <MacrosModal open={macroOpen} onClose={() => setMacroOpen(false)} canEdit={can(profile, 'catalogue.edit')} />
      <TemplatesModal open={tplOpen} onClose={() => setTplOpen(false)} canEdit={can(profile, 'catalogue.edit')} />
    </div>
  )
}
