import { useMemo, useState } from 'react'
import { Alert, App, Button, DatePicker, Form, InputNumber, Modal, Select, Space, Table, Typography } from 'antd'
import dayjs from 'dayjs'
import { addDoc, updateDoc, limit, orderBy, query, serverTimestamp, Timestamp, where } from 'firebase/firestore'
import { col, docRef } from '../../../lib/db'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { Segmented } from '../../../design/Segmented'
import { Button as DsButton } from '../../../design/Button'
import { Chip } from '../ui'
import { useAuth } from '../../../auth/AuthProvider'
import { useLiveQuery } from '../../../hooks/useLive'
import { fmtDate, fmtDateTime, tsToDate } from '../../../components/results/common'
import type { Order } from '../../../types'
import { QC, type SampleDiscard } from '../types'
import { useBranchScope } from '../../../lib/branchScope'
import { branchStamp } from '../../../lib/activeBranch'
import { Panel } from '../ui'

const { Text } = Typography
const METHODS = ['Autoclave', 'Incineration', 'Chemical disinfection', 'Other']

export const useDiscards = () => {
  const scope = useBranchScope()
  return useLiveQuery<SampleDiscard>(query(col(QC.discards), ...scope.constraints, orderBy('discardedAt', 'desc')), [scope.key])
}

export const retentionMin = (t: { discardDays?: number; discardHours?: number; discardMinutes?: number }) =>
  (t.discardDays ?? 0) * 1440 + (t.discardHours ?? 0) * 60 + (t.discardMinutes ?? 0)

type DiscardTab = 'setup' | 'discard' | 'verify'

export default function DiscardSection() {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const maps = useCatalogueMaps()
  const [tab, setTab] = useState<DiscardTab>('discard')
  const [days, setDays] = useState(7)
  // Retention per sample type (Setup tab); orders use the longest retention of their tests' sample types.
  const typeMin = useMemo(() => new Map(maps.sampleTypes.map((t) => [t.id, retentionMin(t)])), [maps.sampleTypes])
  const configured = [...typeMin.values()].filter((m) => m > 0)
  const shortest = configured.length ? Math.min(...configured, days * 1440) : days * 1440
  const cutoff = useMemo(() => dayjs().subtract(shortest, 'minute').startOf('minute').toDate(), [shortest])
  const scope = useBranchScope()
  const { data: fetched, loading } = useLiveQuery<Order>(
    query(col('orders'), ...scope.constraints, where('receivedAt', '<=', Timestamp.fromDate(cutoff)), orderBy('receivedAt', 'desc'), limit(500)),
    [cutoff.getTime(), scope.key],
  )
  const { data: history } = useDiscards()
  const [selected, setSelected] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm<{ method: string; date: dayjs.Dayjs }>()
  const [verifySel, setVerifySel] = useState<string[]>([])

  const retentionOf = (o: Order) => {
    const mins = o.items.flatMap((i) => i.testIds).map((id) => typeMin.get(maps.testById.get(id)?.sampleTypeId ?? '') ?? 0).filter((m) => m > 0)
    return mins.length ? Math.max(...mins) : days * 1440
  }
  const discarded = useMemo(() => new Set(history.flatMap((h) => h.orderIds ?? [])), [history])
  const due = fetched.filter((o) => !o.deleted && !discarded.has(o.id) && dayjs().diff(tsToDate(o.receivedAt), 'minute') >= retentionOf(o))
  const pending = history.filter((h) => !h.verifiedBy)

  const record = async () => {
    const v = await form.validateFields()
    const chosen = due.filter((o) => selected.includes(o.id))
    try {
      await addDoc(col(QC.discards), {
        ...branchStamp(),
        orderIds: chosen.map((o) => o.id),
        items: chosen.map((o) => ({ orderId: o.id, billNo: o.billNo, barcode: o.barcode, receivedAt: o.receivedAt })),
        count: chosen.length,
        method: v.method,
        retentionDays: days,
        discardedBy: user?.uid ?? '',
        discardedByName: profile?.name ?? '',
        // The discard is recorded first; it is verified afterwards in the Verify discard tab.
        verifiedBy: '',
        verifiedByName: '',
        verifiedAt: null,
        discardedAt: Timestamp.fromDate(v.date.toDate()),
        createdAt: serverTimestamp(),
      })
      message.success(`Recorded discard of ${chosen.length} sample(s)`)
      setSelected([])
      setOpen(false)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const verify = async (h: SampleDiscard) => {
    if (h.discardedBy === user?.uid) return void message.error('A different user must verify this discard')
    try {
      await updateDoc(docRef(QC.discards, h.id), { verifiedBy: user?.uid ?? '', verifiedByName: profile?.name ?? '', verifiedAt: Timestamp.now() })
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const verifyMany = async () => {
    const list = pending.filter((h) => verifySel.includes(h.id) && h.discardedBy !== user?.uid)
    if (!list.length) return void message.info('Nothing to verify: you cannot verify a discard you recorded yourself.')
    for (const h of list) await verify(h)
    setVerifySel([])
    message.success(`Verified ${list.length} discard record(s)`)
  }

  return (
    <>
      <div className="qc-subnav">
        <Segmented
          aria-label="Sample discarding views"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'setup', label: 'Setup' },
            { value: 'discard', label: 'Discard sample', count: due.length },
            { value: 'verify', label: 'Verify discard', count: pending.length },
          ]}
        />
      </div>

      {tab === 'setup' && (
        <Panel title="Discard time per sample type" extra={<span className="qc-muted">Samples become due for discard after this time from receipt.</span>}>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={maps.sampleTypes}
            locale={{ emptyText: 'No sample types in the catalogue yet.' }}
            columns={[
              { title: 'Sample type', dataIndex: 'name' },
              ...(['discardDays', 'discardHours', 'discardMinutes'] as const).map((f) => ({
                title: f === 'discardDays' ? 'Days' : f === 'discardHours' ? 'Hours' : 'Minutes',
                render: (_: unknown, t: (typeof maps.sampleTypes)[number]) => (
                  <InputNumber
                    min={0}
                    aria-label={`${t.name} ${f}`}
                    defaultValue={t[f] ?? 0}
                    onBlur={(e) => {
                      const n = Math.max(0, Number(e.target.value) || 0)
                      if (n !== (t[f] ?? 0)) updateDoc(docRef('sampleTypes', t.id), { [f]: n }).catch((er) => message.error(er.message))
                    }}
                  />
                ),
              })),
            ]}
          />
          <p className="qc-muted">Sample types without a time use the default of {days} days.</p>
        </Panel>
      )}

      {tab === 'discard' && (
        <div className="qc-stack">
          <Panel title="Samples due for discard" extra={<Space>Default retention (days) <InputNumber min={1} value={days} onChange={(v) => setDays(v ?? 7)} /></Space>}>
            <Table<Order>
              size="small"
              rowKey="id"
              loading={loading}
              dataSource={due}
              pagination={{ pageSize: 10 }}
              rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
              columns={[
                { title: 'Bill', dataIndex: 'billNo' },
                { title: 'Barcode', dataIndex: 'barcode' },
                { title: 'Patient', dataIndex: 'patientName' },
                { title: 'Report date', render: (_, o) => fmtDateTime(o.reportedAt) },
                { title: 'Received', render: (_, o) => fmtDateTime(o.receivedAt) },
                { title: 'Discarding time', render: (_, o) => fmtDateTime(dayjs(tsToDate(o.receivedAt)).add(retentionOf(o), 'minute').toDate()) },
              ]}
            />
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <DsButton
                variant="primary"
                disabled={!selected.length}
                onClick={() => {
                  form.resetFields()
                  form.setFieldsValue({ method: METHODS[0], date: dayjs() })
                  setOpen(true)
                }}
              >
                Record discard batch ({selected.length})
              </DsButton>
            </div>
          </Panel>
          <Panel title="Discard history">
            <Table<SampleDiscard>
              size="small"
              rowKey="id"
              dataSource={history}
              columns={[
                { title: 'Date', render: (_, h) => fmtDate(h.discardedAt) },
                { title: 'Samples', dataIndex: 'count' },
                { title: 'Bills', render: (_, h) => (h.items ?? []).map((i) => i.billNo).join(', ') },
                { title: 'Method', dataIndex: 'method' },
                { title: 'Discarded by', dataIndex: 'discardedByName' },
                { title: 'Discard date and time', render: (_, h) => fmtDateTime(h.discardedAt) },
                { title: 'Status', render: (_, h) => (h.verifiedBy ? <Chip status="pass">Verified by {h.verifiedByName}</Chip> : <Chip status="pending">Awaiting verification</Chip>) },
              ]}
            />
          </Panel>
        </div>
      )}

      {tab === 'verify' && (
        <Panel title="Discards waiting for verification" extra={<Space><span className="qc-muted">A different user confirms the disposal.</span><DsButton variant="primary" disabled={!verifySel.length} onClick={verifyMany}>Verify selected ({verifySel.length})</DsButton></Space>}>
          <Table<SampleDiscard>
            size="small"
            rowKey="id"
            dataSource={pending}
            pagination={false}
            rowSelection={{ selectedRowKeys: verifySel, onChange: (k) => setVerifySel(k as string[]), getCheckboxProps: (h) => ({ disabled: h.discardedBy === user?.uid }) }}
            locale={{ emptyText: 'Nothing waiting for verification.' }}
            columns={[
              { title: 'Discarded by', dataIndex: 'discardedByName' },
              { title: 'Discard date and time', render: (_, h) => fmtDateTime(h.discardedAt) },
              { title: 'Status', render: () => <Chip status="pending">Awaiting verification</Chip> },
              { title: 'Samples', dataIndex: 'count' },
              { title: 'Bills', render: (_, h) => (h.items ?? []).map((i) => i.billNo).join(', ') },
              { title: 'Method', dataIndex: 'method' },
              { title: '', render: (_, h) => <Button size="small" disabled={h.discardedBy === user?.uid} onClick={() => verify(h)}>Verify</Button> },
            ]}
          />
        </Panel>
      )}

      <Modal title="Record sample discard" open={open} onOk={record} onCancel={() => setOpen(false)} okText="Record discard" destroyOnHidden>
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`${selected.length} sample(s) will be recorded as discarded by ${profile?.name ?? 'you'}. A second user verifies it afterwards in the Verify discard tab.`} />
        <Form form={form} layout="vertical">
          <Form.Item name="method" label="Disposal method" rules={[{ required: true }]}>
            <Select options={METHODS.map((m) => ({ value: m, label: m }))} />
          </Form.Item>
          <Form.Item name="date" label="Discard date" rules={[{ required: true }]}>
            <DatePicker />
          </Form.Item>
        </Form>
        <Text type="secondary">Verification is recorded by name; the verifier is expected to have witnessed the disposal.</Text>
      </Modal>
    </>
  )
}
