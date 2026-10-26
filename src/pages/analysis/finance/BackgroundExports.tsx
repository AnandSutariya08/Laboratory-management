import { useState } from 'react'
import { App, Table } from 'antd'
import dayjs from 'dayjs'
import { addDoc, doc, orderBy, query, serverTimestamp, updateDoc, increment } from 'firebase/firestore'
import { getDownloadURL, ref } from 'firebase/storage'
import { Button } from '../../../design/Button'
import { Card } from '../../../design/Card'
import { StatusChip } from '../../../design/StatusChip'
import { useAuth } from '../../../auth/AuthProvider'
import { useLiveQuery } from '../../../hooks/useLive'
import { col } from '../../../lib/db'
import { branchParam } from '../../../lib/activeBranch'
import { storage } from '../../../firebase'
import type { ExportJob, ExportKind } from '../../../lib/analysisServer'
import type { Range } from '../shared'

export const JOB_KINDS: { kind: ExportKind; title: string; desc: string }[] = [
  { kind: 'billing', title: 'Billing wise', desc: 'One row per bill.' },
  { kind: 'collection', title: 'Collection wise', desc: 'One row per payment, by payment date.' },
  { kind: 'test', title: 'Test wise', desc: 'One row per test billed.' },
  { kind: 'outsource', title: 'Outsource wise', desc: 'Outsourced tests with lab price and margin.' },
  { kind: 'fullLedger', title: 'Full billing with payment modes', desc: 'Every billing column including the payment mode split.' },
]

export interface JobExtra { columns?: string[]; base?: string; filters?: unknown; groupBy?: string; sortBy?: string; sortDir?: 'asc' | 'desc'; exportSettings?: unknown }

// Request a server-built CSV for the dates; it is stored in Cloud Storage and listed under "Background exports".
export function useRequestExport(range: Range) {
  const { profile } = useAuth()
  const { message } = App.useApp()
  return async (kind: ExportKind, name: string, extra: JobExtra = {}) => {
    if (!profile) return
    try {
      await addDoc(col('exportJobs'), {
        kind, name, from: range[0].startOf('day').valueOf(), to: range[1].endOf('day').valueOf() + 1, branchId: branchParam(),
        status: 'queued', requestedBy: profile.uid, requestedByName: profile.name, requestedAt: serverTimestamp(),
        ...JSON.parse(JSON.stringify(extra)),
      })
      message.success('Export queued. It appears in the list below when ready.')
    } catch {
      message.error('Could not queue the export.')
    }
  }
}

const tone = { queued: 'neutral', processing: 'info', completed: 'success', failed: 'urgent' } as const

export default function BackgroundExports({ range }: { range: Range }) {
  const { profile } = useAuth()
  const { message } = App.useApp()
  const request = useRequestExport(range)
  const { data, loading } = useLiveQuery<ExportJob>(query(col('exportJobs'), orderBy('requestedAt', 'desc')), [])
  const [busy, setBusy] = useState('')
  const mine = data.filter((j) => j.requestedBy === profile?.uid || profile?.role === 'labAdmin' || profile?.role === 'admin').slice(0, 50)

  const download = async (j: ExportJob) => {
    if (!j.storagePath) return
    setBusy(j.id)
    try {
      const url = await getDownloadURL(ref(storage, j.storagePath))
      const a = document.createElement('a')
      a.href = url
      a.download = `${j.name.replace(/[^\w.-]+/g, '-')}.csv`
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch {
      message.error('The file could not be downloaded.')
    } finally {
      setBusy('')
    }
  }
  const retry = (j: ExportJob) => updateDoc(doc(col('exportJobs'), j.id), { status: 'queued', retryCount: increment(1) }).catch(() => message.error('Could not retry.'))

  return (
    <div className="an-stack">
      <Card>
        <h2 className="an-card-title">Background exports</h2>
        <p className="an-note">For large periods. The server builds the file for {range[0].format('DD MMM YYYY')} to {range[1].format('DD MMM YYYY')} and keeps it for download; you can leave this page meanwhile.</p>
        <div className="an-grid">
          {JOB_KINDS.map((k) => (
            <Card key={k.kind}>
              <h3 className="an-card-title">{k.title}</h3>
              <p className="an-note">{k.desc}</p>
              <Button aria-label={`Queue ${k.title} export`} onClick={() => request(k.kind, `${k.title} ${range[0].format('YYYYMMDD')}-${range[1].format('YYYYMMDD')}`)}>Queue export</Button>
            </Card>
          ))}
        </div>
      </Card>
      <Card>
        <h2 className="an-card-title">Export downloads</h2>
        <Table<ExportJob> size="small" rowKey="id" loading={loading} dataSource={mine} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'No exports yet' }} scroll={{ x: 760 }}
          columns={[
            { title: 'Export', dataIndex: 'name' },
            { title: 'Requested', render: (_, j) => (j.requestedAt ? dayjs(j.requestedAt.toMillis()).format('DD-MM-YYYY HH:mm') : '') },
            { title: 'By', dataIndex: 'requestedByName' },
            { title: 'Status', render: (_, j) => <StatusChip variant={tone[j.status]}>{j.status === 'completed' ? 'Ready' : j.status}</StatusChip> },
            { title: 'Rows', align: 'right', render: (_, j) => j.rows ?? '' },
            { title: 'Size', align: 'right', render: (_, j) => (j.bytes ? `${Math.max(1, Math.round(j.bytes / 1024))} KB` : '') },
            { title: '', render: (_, j) => (j.status === 'completed' ? <Button disabled={busy === j.id} onClick={() => download(j)} aria-label={`Download ${j.name}`}>Download</Button> : j.status === 'failed' ? <span>{j.error} <Button onClick={() => retry(j)}>Retry</Button></span> : null) },
          ]} />
      </Card>
    </div>
  )
}
