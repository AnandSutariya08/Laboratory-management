import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Dropdown, Input, Select, Table, Tag } from 'antd'
import { DownloadOutlined, EditOutlined, PlusOutlined, ReloadOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { query, where } from 'firebase/firestore'
import { clearLocalPins, loadPins, runAnalyticsIn, savePins, takeLocalPins, type ColumnKind, type ExtraColumn, type PinsDoc } from '../../lib/aiAnalyst'
import { col } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { useAuth } from '../../auth/AuthProvider'
import { downloadCsv } from '../../components/billing/helpers'
import { formatValue, metricLabel } from '../../components/ai/AnalyticsChart'
import { fmtDateTime } from '../../components/results/common'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonRows } from '../../design/Skeletons'
import type { AiChat, AnalyticsQuery, AnalyticsResult } from '../../types'

interface SavedTable {
  key: string
  chatId: string
  chatTitle: string
  at: number
  result: AnalyticsResult | null // null: a pinned table whose chat answer is gone; it is re-run on open
  query: AnalyticsQuery
  columns: ExtraColumn[]
}

const METRIC_OPTIONS: { value: AnalyticsQuery['metric']; label: string }[] = [
  { value: 'revenue', label: 'Revenue' },
  { value: 'collections', label: 'Collections' },
  { value: 'dues', label: 'Dues' },
  { value: 'refunds', label: 'Refunds' },
  { value: 'discounts', label: 'Discounts' },
  { value: 'bills', label: 'Bills' },
  { value: 'patients', label: 'Patients' },
  { value: 'tests', label: 'Tests' },
  { value: 'tat', label: 'Turnaround' },
  { value: 'bookings', label: 'Bookings' },
]
const KIND_LABEL: Record<Exclude<ColumnKind, 'metric'>, string> = { shareOfTotal: 'Share of total (%)', rank: 'Rank', cumulative: 'Running total' }

const titleOf = (q: AnalyticsQuery, r?: AnalyticsResult | null) => `${r ? metricLabel(r) : q.metric} by ${q.groupBy}`

// Tables are the grouped results the analyst produced in the user's chats. Pins (and the columns added to a
// table) are saved in Firestore per user. Open, refresh against live data, add derived columns, export,
// or continue in chat.
export default function AiTablesTab() {
  const { message } = App.useApp()
  const { user } = useAuth()
  const navigate = useNavigate()
  const uid = user?.uid ?? ''
  const { data, loading } = useLiveQuery<AiChat>(uid ? query(col('aiChats'), where('userId', '==', uid)) : null, [uid])
  const [search, setSearch] = useState('')
  const [pins, setPins] = useState<PinsDoc | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [fresh, setFresh] = useState<Record<string, AnalyticsResult>>({})
  const [joined, setJoined] = useState<Record<string, AnalyticsResult>>({}) // `${tableKey}:${columnId}` -> joined metric result
  const [busy, setBusy] = useState(false)
  const migrated = useRef(false)

  useEffect(() => {
    if (!uid) return
    loadPins(uid)
      .then(setPins)
      .catch(() => setPins({ tables: {} }))
  }, [uid])

  const persist = useCallback(
    async (next: PinsDoc) => {
      setPins(next)
      try {
        await savePins(uid, next)
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Could not save pins')
      }
    },
    [uid, message],
  )

  // Chat-derived tables.
  const chatTables = useMemo(() => {
    const out: SavedTable[] = []
    for (const c of data)
      (c.messages ?? []).forEach((m, mi) =>
        (m.results ?? []).forEach((r, ri) => {
          if (r.query.groupBy !== 'none' && r.rows.length)
            out.push({ key: `${c.id}:${mi}:${ri}`, chatId: c.id, chatTitle: c.title || 'New chat', at: m.at?.toMillis?.() ?? c.updatedAt?.toMillis?.() ?? 0, result: r, query: r.query, columns: [] })
        }),
      )
    return out
  }, [data])

  // One-time move of the old browser-only pins into Firestore.
  useEffect(() => {
    if (migrated.current || !pins || loading) return
    migrated.current = true
    const local = takeLocalPins()
    if (!local.length) return
    const tables = { ...pins.tables }
    for (const key of local) {
      const t = chatTables.find((x) => x.key === key)
      if (t && !tables[key]) tables[key] = { title: titleOf(t.query, t.result), query: t.query, columns: [], pinnedAt: Date.now() }
    }
    void persist({ ...pins, tables, migratedLocal: true }).then(clearLocalPins)
  }, [pins, loading, chatTables, persist])

  const tables = useMemo<SavedTable[]>(() => {
    const pinned = pins?.tables ?? {}
    const merged: SavedTable[] = chatTables.map((t) => (pinned[t.key] ? { ...t, columns: pinned[t.key].columns } : t))
    const seen = new Set(merged.map((t) => t.key))
    for (const [key, p] of Object.entries(pinned)) {
      if (!seen.has(key)) merged.push({ key, chatId: key.split(':')[0], chatTitle: p.title, at: p.pinnedAt, result: null, query: p.query, columns: p.columns })
    }
    const q = search.trim().toLowerCase()
    return merged
      .filter((t) => !q || `${t.chatTitle} ${titleOf(t.query, t.result)}`.toLowerCase().includes(q))
      .sort((a, b) => Number(!!pinned[b.key]) - Number(!!pinned[a.key]) || b.at - a.at)
  }, [chatTables, pins, search])

  const open = tables.find((t) => t.key === openKey)
  const result = open ? (fresh[open.key] ?? open.result) : null
  const isPinned = (key: string) => !!pins?.tables[key]

  const togglePin = (t: SavedTable) => {
    if (!pins) return
    const next = { ...pins, tables: { ...pins.tables } }
    if (next.tables[t.key]) delete next.tables[t.key]
    else next.tables[t.key] = { title: titleOf(t.query, t.result), query: t.query, columns: t.columns, pinnedAt: Date.now() }
    void persist(next)
  }

  const run = useCallback(
    async (t: SavedTable) => {
      setBusy(true)
      try {
        const r = await runAnalyticsIn({ query: { ...t.query, limit: t.query.limit ?? 500 } })
        setFresh((f) => ({ ...f, [t.key]: r }))
        // Joined-metric columns re-run alongside.
        for (const c of t.columns) {
          if (c.kind === 'metric' && c.metric) {
            const jr = await runAnalyticsIn({ query: { ...t.query, metric: c.metric, limit: 500 } }).catch(() => null)
            if (jr) setJoined((j) => ({ ...j, [`${t.key}:${c.id}`]: jr }))
          }
        }
      } catch (e) {
        message.error(e instanceof Error ? e.message.replace(/\s*\[\d+\]\s*$/, '') : 'Could not refresh')
      } finally {
        setBusy(false)
      }
    },
    [message],
  )

  // Pinned tables without a stored answer, and metric columns, load when the table is opened.
  useEffect(() => {
    if (!open) return
    const needsRun = !open.result && !fresh[open.key]
    const needsJoin = open.columns.some((c) => c.kind === 'metric' && !joined[`${open.key}:${c.id}`])
    if ((needsRun || needsJoin) && !busy) void run(open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, open?.columns.length])

  const addColumn = (t: SavedTable, c: ExtraColumn) => {
    if (!pins) return
    const cur = pins.tables[t.key]
    const base = cur ?? { title: titleOf(t.query, t.result), query: t.query, columns: [], pinnedAt: Date.now() }
    void persist({ ...pins, tables: { ...pins.tables, [t.key]: { ...base, columns: [...base.columns, c] } } })
    if (!cur) message.info('Table pinned so its columns are kept.')
  }
  const removeColumn = (t: SavedTable, id: string) => {
    if (!pins?.tables[t.key]) return
    const cur = pins.tables[t.key]
    void persist({ ...pins, tables: { ...pins.tables, [t.key]: { ...cur, columns: cur.columns.filter((c) => c.id !== id) } } })
  }

  // Derived values for one added column, aligned with the rows.
  const columnValues = (t: SavedTable, r: AnalyticsResult, c: ExtraColumn): { text: string; num: number | null }[] => {
    const rows = r.rows
    if (c.kind === 'shareOfTotal') {
      const sum = rows.reduce((a, x) => a + x.value, 0)
      return rows.map((x) => {
        const v = sum ? Math.round((x.value / sum) * 1000) / 10 : 0
        return { text: `${v}%`, num: v }
      })
    }
    if (c.kind === 'rank') {
      const order = [...rows].sort((a, b) => b.value - a.value).map((x) => x.label)
      return rows.map((x) => ({ text: String(order.indexOf(x.label) + 1), num: order.indexOf(x.label) + 1 }))
    }
    if (c.kind === 'cumulative') {
      let run = 0
      return rows.map((x) => {
        run += x.value
        return { text: formatValue(run, r.unit), num: run }
      })
    }
    const jr = joined[`${t.key}:${c.id}`]
    return rows.map((x) => {
      const v = jr?.rows.find((y) => y.label === x.label)?.value
      return v === undefined ? { text: jr ? '0' : '…', num: jr ? 0 : null } : { text: formatValue(v, jr!.unit), num: v }
    })
  }

  const exportCsv = () => {
    if (!result || !open) return
    const extra = Array.from(new Set(result.rows.flatMap((r) => Object.keys(r.extra ?? {}))))
    const cols = open.columns.map((c) => ({ c, v: columnValues(open, result, c) }))
    downloadCsv(`ai-table-${metricLabel(result)}.csv`.replace(/\s+/g, '-').toLowerCase(), [
      [result.query.groupBy, metricLabel(result), ...extra, ...cols.map((x) => x.c.label)],
      ...result.rows.map((r, i) => [r.label, r.value, ...extra.map((k) => String(r.extra?.[k] ?? '')), ...cols.map((x) => x.v[i]?.num ?? '')]),
    ])
  }
  const editInChat = () => {
    if (!open) return
    try {
      sessionStorage.setItem('hcl.ai.prefill', `About the table "${titleOf(open.query, open.result)}": `)
    } catch {
      /* ignore */
    }
    navigate(open.chatId && chatTables.some((c) => c.chatId === open.chatId) ? `/ai/${open.chatId}` : '/ai')
  }

  if (loading || !pins) return <SkeletonRows />

  if (open) {
    if (!result) {
      return busy ? (
        <SkeletonRows />
      ) : (
        <EmptyState title="Could not load this table" description="The saved query did not return data." action={<Button onClick={() => run(open)}>Retry</Button>} />
      )
    }
    const extra = Array.from(new Set(result.rows.flatMap((r) => Object.keys(r.extra ?? {}))))
    const menuItems = [
      ...(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => ({ key: k, label: KIND_LABEL[k] })),
      { key: 'metric', label: 'Another metric…' },
    ]
    return (
      <div>
        <div className="qc-toolbar">
          <Button onClick={() => setOpenKey(null)}>All tables</Button>
          <strong>{titleOf(result.query, result)}</strong>
          <span className="qc-muted">{result.from} to {result.to}</span>
          <span className="qc-toolbar__spacer" />
          <Button icon={isPinned(open.key) ? <StarFilled /> : <StarOutlined />} onClick={() => togglePin(open)}>{isPinned(open.key) ? 'Pinned' : 'Pin'}</Button>
          <AddColumn
            items={menuItems}
            onPick={(key, metric) => {
              const label = key === 'metric' ? (METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? 'Metric') : KIND_LABEL[key as keyof typeof KIND_LABEL]
              addColumn(open, { id: `c${Date.now().toString(36)}`, label, kind: key as ColumnKind, ...(key === 'metric' ? { metric } : {}) })
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => run(open)} disabled={busy}>Refresh</Button>
          <Button icon={<EditOutlined />} onClick={editInChat}>Edit in chat</Button>
          <Button variant="primary" icon={<DownloadOutlined />} onClick={exportCsv}>Export CSV</Button>
        </div>
        <Table
          size="small"
          rowKey="label"
          dataSource={result.rows}
          pagination={result.rows.length > 15 ? { pageSize: 15 } : false}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: result.query.groupBy, dataIndex: 'label' },
            { title: metricLabel(result), dataIndex: 'value', align: 'right', render: (v: number) => formatValue(v, result.unit) },
            ...extra.map((k) => ({ title: k, align: 'right' as const, render: (_: unknown, r: AnalyticsResult['rows'][number]) => String(r.extra?.[k] ?? '') })),
            ...open.columns.map((c) => {
              const vals = columnValues(open, result, c)
              return {
                title: (
                  <span>
                    {c.label}{' '}
                    <Tag closable onClose={() => removeColumn(open, c.id)} style={{ marginLeft: 4 }}>
                      added
                    </Tag>
                  </span>
                ),
                align: 'right' as const,
                render: (_: unknown, _r: AnalyticsResult['rows'][number], i: number) => vals[i]?.text ?? '',
              }
            }),
          ]}
        />
      </div>
    )
  }
  return (
    <div>
      <div className="qc-toolbar">
        <Input.Search allowClear placeholder="Search tables" style={{ maxWidth: 320 }} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tables" />
      </div>
      {tables.length === 0 ? (
        <EmptyState title="No tables yet" description="Ask the analyst for a breakdown, for example revenue by department. Grouped answers appear here." />
      ) : (
        <div className="tile-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))' }}>
          {tables.map((t) => (
            <Card key={t.key} interactive padding="var(--s-4)">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className="press" style={{ all: 'unset', cursor: 'pointer', flex: 1 }} onClick={() => setOpenKey(t.key)}>
                  <strong>{titleOf(t.query, t.result)}</strong>
                  <br />
                  <small className="qc-muted">{t.result ? `${t.result.rows.length} rows · ` : ''}{t.chatTitle}{t.columns.length ? ` · +${t.columns.length} columns` : ''}</small>
                  <br />
                  <small className="qc-muted">{t.at ? fmtDateTime(new Date(t.at)) : ''}</small>
                </button>
                <Button variant="text" aria-label={isPinned(t.key) ? 'Unpin table' : 'Pin table'} icon={isPinned(t.key) ? <StarFilled /> : <StarOutlined />} onClick={() => togglePin(t)} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

// "Add column" menu; "Another metric" asks which metric to join on the row label.
function AddColumn({ items, onPick }: { items: { key: string; label: string }[]; onPick: (key: string, metric?: AnalyticsQuery['metric']) => void }) {
  const [metricPick, setMetricPick] = useState(false)
  if (metricPick) {
    return (
      <Select
        autoFocus
        open
        placeholder="Metric to add"
        style={{ width: 170 }}
        options={METRIC_OPTIONS}
        onChange={(m: AnalyticsQuery['metric']) => {
          setMetricPick(false)
          onPick('metric', m)
        }}
        onBlur={() => setMetricPick(false)}
        onOpenChange={(o) => !o && setMetricPick(false)}
      />
    )
  }
  return (
    <Dropdown
      trigger={['click']}
      menu={{ items, onClick: ({ key }) => (key === 'metric' ? setMetricPick(true) : onPick(key)) }}
    >
      <Button icon={<PlusOutlined />}>Add column</Button>
    </Dropdown>
  )
}
