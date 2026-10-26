import { useEffect, useMemo, useState } from 'react'
import { Table } from 'antd'
import { documentId, getDocs, onSnapshot, query, where } from 'firebase/firestore'
import { App } from 'antd'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { can, useAuth } from '../../auth/AuthProvider'
import { col } from '../../lib/db'
import { endSession, liveSessions, sessionsCol, type SessionDoc } from '../../features/settings/sessions'
import { downloadCsv, ExportButton, tsFull, useUsers, type Range } from './shared'
import dayjs from 'dayjs'

interface Usage { uid: string; day: string; views?: Record<string, number>; signIns?: number[] }

// Staff login details (AN-15): sign-ins in the period (from the usage counters), first sign-in time, days active, page
// views, live sessions now (users/{uid}/sessions) and last sign-in. Admins with user management can end a live session.
export default function LoginDetails({ range }: { range: Range }) {
  const { list } = useUsers()
  const { profile } = useAuth()
  const { message } = App.useApp()
  const canEnd = can(profile, 'users.manage')
  const [sessions, setSessions] = useState<Record<string, SessionDoc[]>>({})
  const [usage, setUsage] = useState<Usage[]>([])
  const [usageErr, setUsageErr] = useState(false)
  const [tick, setTick] = useState(0)
  const uidSig = list.map((u) => u.uid).join('|')

  useEffect(() => {
    const offs = list.map((u) =>
      onSnapshot(sessionsCol(u.uid), (s) => setSessions((p) => ({ ...p, [u.uid]: s.docs.map((d) => ({ ...(d.data() as Omit<SessionDoc, 'id'>), id: d.id })) })), () => undefined),
    )
    const t = window.setInterval(() => setTick((x) => x + 1), 30_000)
    return () => { offs.forEach((f) => f()); window.clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uidSig])

  const from = range[0].format('YYYY-MM-DD')
  const to = range[1].format('YYYY-MM-DD')
  useEffect(() => {
    let live = true
    setUsageErr(false)
    getDocs(query(col('usage'), where(documentId(), '>=', `${from}_`), where(documentId(), '<=', `${to}_`)))
      .then((s) => live && setUsage(s.docs.map((d) => d.data() as Usage)))
      .catch(() => live && (setUsage([]), setUsageErr(true)))
    return () => { live = false }
  }, [from, to])

  const rows = useMemo(() => {
    void tick
    return list.map((u) => {
      const mine = usage.filter((x) => x.uid === u.uid && x.day >= from && x.day <= to)
      const signIns = mine.flatMap((x) => x.signIns ?? []).sort((a, b) => a - b)
      const views = mine.reduce((s, x) => s + Object.values(x.views ?? {}).reduce((a, b) => a + b, 0), 0)
      const live = liveSessions(sessions[u.uid] ?? [])
      return { ...u, signIns: signIns.length, first: signIns[0] ?? null, days: mine.length, views, live, all: sessions[u.uid] ?? [], last: (u as unknown as { lastLoginAt?: unknown }).lastLoginAt }
    })
  }, [list, usage, sessions, from, to, tick])

  const exportCsv = () => downloadCsv('login-details.csv', [['Name', 'Role', 'Status', 'Sign-ins', 'First sign-in', 'Days active', 'Page views', 'Live sessions', 'Last sign-in'],
    ...rows.map((r) => [r.name, r.role, r.active ? 'Active' : 'Inactive', r.signIns, r.first ? dayjs(r.first).format('DD-MM-YYYY HH:mm') : '', r.days, r.views, r.live.length, tsFull(r.last)])])

  return (
    <Card>
      <div className="an-card-head">
        <h2 className="an-card-title">Staff login details</h2>
        <ExportButton onClick={exportCsv} disabled={!rows.length} />
      </div>
      <p className="an-note">
        Sign-ins, first sign-in, days active and page views cover {range[0].format('DD MMM')} to {range[1].format('DD MMM YYYY')} and are counted from the day staff first use the app after this update.
        {usageErr ? ' The usage counters could not be read; they are visible to admins only.' : ''}
      </p>
      <Table size="small" rowKey="uid" dataSource={rows} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 900 }}
        expandable={{
          rowExpandable: (r) => r.live.length > 0,
          expandedRowRender: (r) => (
            <Table size="small" rowKey="id" pagination={false} dataSource={r.live}
              columns={[
                { title: 'Device', dataIndex: 'device' },
                { title: 'Signed in', render: (_, s: SessionDoc) => dayjs(s.startedAt).format('DD-MM-YYYY HH:mm') },
                { title: 'Last seen', render: (_, s: SessionDoc) => dayjs(s.seenAt).format('HH:mm:ss') },
                ...(canEnd ? [{ title: '', render: (_: unknown, s: SessionDoc) => <Button onClick={() => endSession(r.uid, s.id).then(() => message.success('Session ended')).catch(() => message.error('Could not end the session'))}>End session</Button> }] : []),
              ]} />
          ),
        }}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Role', dataIndex: 'role' },
          { title: 'Status', render: (_, u) => <StatusChip variant={u.active ? 'success' : 'neutral'}>{u.active ? 'Active' : 'Inactive'}</StatusChip> },
          { title: 'Sign-ins', dataIndex: 'signIns', align: 'right' },
          { title: 'First sign-in', render: (_, u) => (u.first ? dayjs(u.first).format('DD-MM-YYYY HH:mm') : '') },
          { title: 'Days active', dataIndex: 'days', align: 'right' },
          { title: 'Page views', dataIndex: 'views', align: 'right' },
          { title: 'Live sessions', align: 'right', render: (_, u) => u.live.length },
          { title: 'Last sign-in', render: (_, u) => tsFull(u.last) || 'Not recorded' },
        ]} />
    </Card>
  )
}
