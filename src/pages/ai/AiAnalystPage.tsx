import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Col,
  Empty,
  Grid,
  Input,
  List,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import {
  CheckCircleOutlined,
  DashboardOutlined,
  DeleteOutlined,
  EditOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SendOutlined,
  SafetyOutlined,
  ShareAltOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { deleteDoc, query, updateDoc, where } from 'firebase/firestore'
import {
  analystChatStream,
  cancelStream,
  listAiDashboards,
  listenStream,
  newChatId,
  runAnalyticsIn,
  runDashboardIn,
  type DashboardEntry,
  type StreamDoc,
} from '../../lib/aiAnalyst'
import { useBranch } from '../../branch/BranchProvider'
import { branchParam } from '../../lib/activeBranch'
import ComputedPanel from './ComputedPanel'
import DataAccessDrawer from './DataAccessDrawer'
import PivotControl from './PivotControl'
import ShareDashboardModal from './ShareDashboardModal'
import { col, docRef } from '../../lib/db'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { useLabSettings } from '../../hooks/useCatalogue'
import { can, useAuth } from '../../auth/AuthProvider'
import AnalyticsChart, { chartKindFor, metricLabel } from '../../components/ai/AnalyticsChart'
import Markdown from '../../components/ai/Markdown'
import AiTablesTab from './AiTablesTab'
import { Card as DsCard } from '../../design/Card'
import { PageHeader } from '../../design/PageHeader'
import { Segmented as DsSegmented } from '../../design/Segmented'
import '../../features/qc/qc.css'
import { fmtDateTime } from '../../components/results/common'
import type {
  AiChat,
  AiChatMessage,
  AnalyticsQuery,
  AnalyticsResult,
  DashboardWidget,
} from '../../types'

const { Text, Title } = Typography

const SUGGESTIONS = [
  "Today's collection",
  'Pending dues',
  'Top referring doctors this month',
  'Test volume trend last 30 days',
  'Department-wise revenue',
  'Bookings funnel this week',
]

// Callable errors end with the HTTP status (e.g. "[400]"); users don't need it.
const errText = (e: unknown) =>
  e instanceof Error ? e.message.replace(/\s*\[\d+\]\s*$/, '') : 'Something went wrong'

// ---- inline result (chart/table toggle) ------------------------------------------

function ResultBlock({ result }: { result: AnalyticsResult }) {
  const auto = chartKindFor(result)
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const groupBy = result.query.groupBy
  return (
    <Card
      size="small"
      style={{ marginTop: 8 }}
      title={
        <Space size={8} wrap>
          <Text strong>{metricLabel(result)}</Text>
          {groupBy !== 'none' && <Tag color="blue">by {groupBy}</Tag>}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {result.from} to {result.to}
          </Text>
        </Space>
      }
      extra={
        auto !== 'kpi' && (
          <Segmented size="small" value={view} onChange={(v) => setView(v as 'chart' | 'table')} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
        )
      }
    >
      <AnalyticsChart result={result} kind={view === 'table' ? 'table' : auto} />
    </Card>
  )
}

function Bubble({ m, onOpenDashboard }: { m: AiChatMessage; onOpenDashboard: (id: string) => void }) {
  const mine = m.role === 'user'
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 16 }}>
      {!mine && <Avatar style={{ background: 'var(--c-accent)', flex: 'none' }} icon={<RobotOutlined />} />}
      <div style={{ maxWidth: mine ? '80%' : '92%', minWidth: 0 }}>
        <div
          style={{
            background: mine ? 'var(--c-primary)' : 'var(--c-surface-container-high)',
            color: mine ? 'var(--c-on-primary)' : undefined,
            border: mine ? 'none' : '1px solid var(--c-outline-variant)',
            borderRadius: 'var(--r-section)',
            padding: '8px 14px',
          }}
        >
          {mine ? <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div> : <Markdown text={m.text} />}
        </div>
        {!mine && m.results?.map((r, i) => <ResultBlock key={i} result={r} />)}
        {!mine && m.steps && <ComputedPanel steps={m.steps} />}
        {!mine && m.dashboardId && (
          <Button type="link" icon={<DashboardOutlined />} style={{ paddingLeft: 0 }} onClick={() => onOpenDashboard(m.dashboardId!)}>
            View dashboard
          </Button>
        )}
      </div>
      {mine && <Avatar style={{ background: 'var(--c-primary)', flex: 'none' }} icon={<UserOutlined />} />}
    </div>
  )
}

// ---- chat pane --------------------------------------------------------------------

const EDIT_KEY = 'hcl.ai.editDashboard'

function ChatPane({ chatId, onOpenDashboard }: { chatId?: string; onOpenDashboard: (id: string) => void }) {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const { data: chat, loading } = useLiveDoc<AiChat>(chatId ? docRef('aiChats', chatId) : null, [chatId])
  const [text, setText] = useState(() => {
    try {
      const p = sessionStorage.getItem('hcl.ai.prefill')
      if (p) sessionStorage.removeItem('hcl.ai.prefill')
      return p ?? ''
    } catch {
      return ''
    }
  })
  // Set by "Edit in chat" on a dashboard: the assistant may then update that dashboard (owner or admin only).
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(() => {
    try {
      const raw = sessionStorage.getItem(EDIT_KEY)
      if (raw) sessionStorage.removeItem(EDIT_KEY)
      return raw ? (JSON.parse(raw) as { id: string; title: string }) : null
    } catch {
      return null
    }
  })
  const fileRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [stream, setStream] = useState<StreamDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const activeChat = useRef<string | undefined>(undefined)

  const messages = chat?.messages ?? []
  const last = messages[messages.length - 1]
  const showPending = pending !== null && !(last?.role === 'user' && last.text === pending)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, pending, stream?.text, stream?.steps.length])

  useEffect(() => {
    setError(null)
    setPending(null)
    setStream(null)
  }, [chatId])

  const send = async (override?: string) => {
    const msg = (override ?? text).trim()
    if (!msg || pending !== null) return
    const id = chatId ?? newChatId()
    const turnId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    setText('')
    setError(null)
    setPending(msg)
    setStream(null)
    activeChat.current = id
    const unsub = listenStream(id, (s) => {
      if (s && s.turnId === turnId) setStream(s)
    })
    try {
      const res = await analystChatStream({ chatId: id, message: msg, turnId, ...(editing ? { editDashboardId: editing.id } : {}) })
      if (!chatId) navigate(`/ai/${res.chatId}`)
    } catch (e) {
      setError(errText(e))
      setText(msg)
    } finally {
      unsub()
      activeChat.current = undefined
      setPending(null)
      setStream(null)
    }
  }

  const stop = async () => {
    if (!activeChat.current) return
    try {
      await cancelStream(activeChat.current)
    } catch {
      /* the turn may have just finished */
    }
  }

  if (!settings.aiEnabled) {
    return (
      <Card>
        <Empty
          image={<RobotOutlined style={{ fontSize: 48, color: 'var(--c-accent)' }} />}
          description={
            <div>
              <Title level={5}>AI is turned off for this lab</Title>
              <Text type="secondary">
                A lab admin can enable it under Lab Profile (Settings), AI section, and add the ANTHROPIC_API_KEY secret on the server.
              </Text>
              {can(profile, 'mcp.manage') && (
                <div style={{ marginTop: 12 }}>
                  <Link to="/settings">
                    <Button type="primary">Open Lab Profile</Button>
                  </Link>
                </div>
              )}
            </div>
          }
        />
      </Card>
    )
  }

  const thinking = pending !== null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 4px 8px' }}>
        {editing && (
          <Alert
            type="info"
            showIcon
            closable
            onClose={() => setEditing(null)}
            style={{ marginBottom: 8 }}
            message={`Editing dashboard "${editing.title}". Describe the changes and the assistant will update it.`}
          />
        )}
        {chatId && loading && <Spin style={{ display: 'block', margin: 40 }} />}
        {!messages.length && !showPending && !(chatId && loading) && (
          <div style={{ textAlign: 'center', padding: '48px 12px' }}>
            <Avatar size={56} style={{ background: 'var(--c-primary-container)', color: 'var(--c-primary)' }} icon={<RobotOutlined />} />
            <Title level={4} style={{ marginTop: 12 }}>
              What would you like to know about your lab?
            </Title>
            <Text type="secondary">I answer from aggregated numbers. Patients only ever appear as initials, never names or contacts.</Text>
            <div style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {SUGGESTIONS.map((s) => (
                <Button key={s} shape="round" onClick={() => send(s)} disabled={thinking}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <Bubble key={i} m={m} onOpenDashboard={onOpenDashboard} />
        ))}
        {showPending && <Bubble m={{ role: 'user', text: pending!, at: undefined as never }} onOpenDashboard={onOpenDashboard} />}
        {thinking && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <Avatar style={{ background: 'var(--c-accent)', flex: 'none' }} icon={<RobotOutlined />} />
            <div style={{ minWidth: 0, flex: 1 }} aria-live="polite">
              {stream?.steps?.length ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {stream.steps.map((s, i) => (
                    <Tag key={i} icon={<CheckCircleOutlined />} color="blue" style={{ margin: 0 }}>
                      {s.summary}
                    </Tag>
                  ))}
                </div>
              ) : null}
              {stream?.text ? (
                <div style={{ background: 'var(--c-surface-container-high)', border: '1px solid var(--c-outline-variant)', borderRadius: 'var(--r-section)', padding: '8px 14px' }}>
                  <Markdown text={stream.text} />
                </div>
              ) : (
                <Space>
                  <Spin size="small" />
                  <Text type="secondary">{stream?.steps?.length ? 'working on the answer…' : 'thinking…'}</Text>
                </Space>
              )}
              <div style={{ marginTop: 6 }}>
                <Button size="small" icon={<StopOutlined />} onClick={stop}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 8 }}
          message={error}
          action={
            can(profile, 'mcp.manage') ? (
              <Link to="/settings">
                <Button size="small">Lab Profile</Button>
              </Link>
            ) : undefined
          }
        />
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <Input.TextArea
          value={text}
          autoSize={{ minRows: 1, maxRows: 6 }}
          placeholder="Ask about collections, dues, referrers, turnaround… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setText(e.target.value)}
          disabled={thinking}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <input ref={fileRef} type="file" accept=".txt,.csv,.md,text/plain,text/csv" hidden aria-label="Attach a text or CSV file" onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          const body = (await f.text()).slice(0, 8000)
          setText((t) => `${t}${t ? '\n\n' : ''}[Attached ${f.name}]\n${body}`)
        }} />
        <Button aria-label="Attach a file" icon={<PlusOutlined />} disabled={thinking} onClick={() => fileRef.current?.click()} />
        <Button type="primary" icon={<SendOutlined />} loading={thinking} disabled={!text.trim()} onClick={() => send()}>
          Send
        </Button>
      </div>
    </div>
  )
}

// ---- dashboards ---------------------------------------------------------------------

type WidgetState = DashboardWidget & { result: AnalyticsResult | null; error?: string }
type Preset = Extract<AnalyticsQuery['range'], { preset: string }>['preset']
const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'thisYear', label: 'This year' },
]

function DashboardView({ dash, onBack, onChanged }: { dash: DashboardEntry; onBack: () => void; onChanged: () => void }) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { branches } = useBranch()
  const [widgets, setWidgets] = useState<WidgetState[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [override, setOverride] = useState<Preset | 'saved'>('saved')
  const [branch, setBranch] = useState<string>(() => branchParam())
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [pivotOpen, setPivotOpen] = useState<Record<string, boolean>>({})
  const [title, setTitle] = useState(dash.title)
  const widgetKey = useMemo(() => JSON.stringify(dash.widgets), [dash.widgets])

  const load = async (preset: Preset | 'saved', branchId: string) => {
    setLoading(true)
    setError(null)
    try {
      if (preset === 'saved') {
        const res = await runDashboardIn({ dashboardId: dash.id, branchId })
        setWidgets(res.widgets)
      } else {
        const out = await Promise.all(
          dash.widgets.map(async (w): Promise<WidgetState> => {
            try {
              const result = await runAnalyticsIn({ query: { ...w.query, range: { preset } }, branchId })
              return { ...w, result }
            } catch (e) {
              return { ...w, result: null, error: errText(e) }
            }
          }),
        )
        setWidgets(out)
      }
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(override, branch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dash.id, override, branch, widgetKey])

  const rename = async () => {
    const t = title.trim()
    setEditing(false)
    if (!t || t === dash.title) return setTitle(dash.title)
    try {
      await updateDoc(docRef('aiDashboards', dash.id), { title: t })
      onChanged()
    } catch (e) {
      message.error(errText(e))
    }
  }
  const remove = async () => {
    try {
      await deleteDoc(docRef('aiDashboards', dash.id))
      onChanged()
      onBack()
    } catch (e) {
      message.error(errText(e))
    }
  }
  const editInChat = () => {
    try {
      sessionStorage.setItem(EDIT_KEY, JSON.stringify({ id: dash.id, title: dash.title }))
      sessionStorage.setItem('hcl.ai.prefill', `About the dashboard "${dash.title}": `)
    } catch {
      /* ignore */
    }
    navigate('/ai')
  }
  const canAll = !!profile?.allBranches
  const branchOptions = [...branches.map((b) => ({ value: b.id, label: b.name })), ...(canAll ? [{ value: 'all', label: 'All branches' }] : [])]

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
        <Space wrap>
          <Button onClick={onBack}>All dashboards</Button>
          {editing ? (
            <Input
              autoFocus
              value={title}
              style={{ width: 260 }}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={rename}
              onPressEnter={rename}
            />
          ) : (
            <Title level={4} style={{ margin: 0 }}>
              {dash.title}
            </Title>
          )}
          {dash.canEdit && !editing && <Button type="text" icon={<EditOutlined />} aria-label="Rename dashboard" onClick={() => { setTitle(dash.title); setEditing(true) }} />}
        </Space>
        <Space wrap>
          {branchOptions.length > 1 && (
            <Select<string> value={branch} style={{ width: 170 }} onChange={setBranch} options={branchOptions} aria-label="Branch" />
          )}
          <Select<Preset | 'saved'>
            value={override}
            style={{ width: 170 }}
            onChange={setOverride}
            options={[{ value: 'saved', label: 'Saved date ranges' }, ...PRESETS]}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(override, branch)}>
            Refresh
          </Button>
          {dash.canEdit && <Button onClick={editInChat}>Edit in chat</Button>}
          <Button icon={<ShareAltOutlined />} onClick={() => (dash.canEdit ? setSharing(true) : navigator.clipboard?.writeText(`${window.location.origin}/ai?tab=dashboards&d=${dash.id}`).then(() => message.success('Link copied.')))}>
            Share
          </Button>
          {dash.canEdit && (
            <Popconfirm title="Delete this dashboard?" okText="Delete" okButtonProps={{ danger: true }} onConfirm={remove}>
              <Button danger icon={<DeleteOutlined />} aria-label="Delete dashboard" />
            </Popconfirm>
          )}
        </Space>
      </Space>
      {dash.description && <Text type="secondary">{dash.description}</Text>}
      {error && <Alert type="error" showIcon message={error} style={{ margin: '12px 0' }} />}
      {loading && !widgets.length ? (
        <Spin style={{ display: 'block', margin: 60 }} />
      ) : (
        <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
          {widgets.map((w) => (
            <Col key={w.id} xs={24} md={w.kind === 'kpi' ? 8 : 12} xl={w.kind === 'kpi' ? 6 : w.kind === 'table' ? 12 : 12}>
              <Card
                size="small"
                title={w.title}
                loading={loading}
                style={{ height: '100%' }}
                extra={
                  w.kind === 'table' && w.result ? (
                    <Button size="small" type={pivotOpen[w.id] ? 'primary' : 'default'} onClick={() => setPivotOpen((p) => ({ ...p, [w.id]: !p[w.id] }))}>
                      Pivot
                    </Button>
                  ) : undefined
                }
              >
                {w.error ? (
                  <Alert type="warning" message={w.error} />
                ) : w.result ? (
                  <>
                    <AnalyticsChart result={w.result} kind={w.kind} height={240} />
                    {w.kind === 'table' && pivotOpen[w.id] && <PivotControl base={w.result} branchId={branch} />}
                  </>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Card>
            </Col>
          ))}
        </Row>
      )}
      <ShareDashboardModal open={sharing} dashboardId={dash.id} title={dash.title} roles={dash.sharedWithRoles} onClose={() => setSharing(false)} onSaved={onChanged} />
    </div>
  )
}

function DashboardsTab({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const [data, setData] = useState<DashboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reload = () => {
    listAiDashboards()
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false))
  }
  useEffect(reload, [])
  const dash = selected ? data.find((d) => d.id === selected) : undefined
  if (selected && dash) return <DashboardView dash={dash} onBack={() => onSelect(null)} onChanged={reload} />
  if (selected && loading) return <Spin style={{ display: 'block', margin: 60 }} />
  return (
    <div>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {selected && !error && <Alert type="warning" showIcon message="That dashboard no longer exists or is not shared with you." style={{ marginBottom: 12 }} />}
      <List
        loading={loading}
        grid={{ gutter: 16, xs: 1, sm: 2, lg: 3 }}
        dataSource={data}
        locale={{
          emptyText: <Empty description="No dashboards yet. Ask the analyst in Chat to build one, e.g. 'Create a dashboard of revenue by department and daily bookings'." />,
        }}
        renderItem={(d) => (
          <List.Item>
            <Card hoverable size="small" onClick={() => onSelect(d.id)}>
              <Card.Meta
                avatar={<Avatar style={{ background: 'var(--c-primary-container)', color: 'var(--c-primary)' }} icon={<DashboardOutlined />} />}
                title={d.title}
                description={
                  <div>
                    <div style={{ minHeight: 40 }}>{d.description}</div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {d.widgets.length} widgets · {d.createdByName} · {fmtDateTime(d.updatedAt)}
                      {d.sharedWithRoles && d.sharedWithRoles.length === 0 ? ' · Private' : ''}
                    </Text>
                  </div>
                }
              />
            </Card>
          </List.Item>
        )}
      />
    </div>
  )
}

// ---- chat history side panel ----------------------------------------------------------

function ChatList({ activeId, onNew, onPick }: { activeId?: string; onNew: () => void; onPick: (id: string) => void }) {
  const { message } = App.useApp()
  const { user } = useAuth()
  const navigate = useNavigate()
  const uid = user?.uid ?? ''
  const { data, loading } = useLiveQuery<AiChat>(uid ? query(col('aiChats'), where('userId', '==', uid)) : null, [uid])
  const [search, setSearch] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const sorted = useMemo(() => {
    const ms = (c: AiChat) => c.updatedAt?.toMillis?.() ?? 0
    return [...data].sort((a, b) => ms(b) - ms(a)).filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
  }, [data, search])

  const rename = async (c: AiChat) => {
    const t = draft.trim()
    setRenaming(null)
    if (!t || t === c.title) return
    try {
      await updateDoc(docRef('aiChats', c.id), { title: t })
    } catch (e) {
      message.error(errText(e))
    }
  }
  const remove = async (c: AiChat) => {
    try {
      await deleteDoc(docRef('aiChats', c.id))
      if (c.id === activeId) navigate('/ai')
    } catch (e) {
      message.error(errText(e))
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Button type="primary" icon={<PlusOutlined />} block onClick={onNew}>
        New chat
      </Button>
      <Input.Search allowClear placeholder="Search chats" style={{ margin: '10px 0' }} value={search} onChange={(e) => setSearch(e.target.value)} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <List
          size="small"
          loading={loading}
          dataSource={sorted}
          locale={{ emptyText: <Text type="secondary">No chats yet</Text> }}
          renderItem={(c) => (
            <List.Item
              style={{ cursor: 'pointer', background: c.id === activeId ? 'var(--c-primary-container)' : undefined, borderRadius: 8, padding: '6px 8px', border: 'none' }}
              onClick={() => renaming !== c.id && onPick(c.id)}
              actions={
                renaming === c.id
                  ? undefined
                  : [
                      <Button key="e" size="small" type="text" icon={<EditOutlined />} aria-label="Rename" onClick={(e) => { e.stopPropagation(); setDraft(c.title); setRenaming(c.id) }} />,
                      <span key="d" onClick={(e) => e.stopPropagation()}>
                        <Popconfirm title="Delete this chat?" okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => remove(c)}>
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="Delete" />
                        </Popconfirm>
                      </span>,
                    ]
              }
            >
              {renaming === c.id ? (
                <Input
                  autoFocus
                  size="small"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => rename(c)}
                  onPressEnter={() => rename(c)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <Text ellipsis style={{ maxWidth: 140 }} strong={c.id === activeId}>
                  <MessageOutlined style={{ marginRight: 6, color: 'var(--c-accent)' }} />
                  {c.title || 'New chat'}
                </Text>
              )}
            </List.Item>
          )}
        />
      </div>
    </div>
  )
}

// ---- page -------------------------------------------------------------------------------

export default function AiAnalystPage() {
  const { chatId } = useParams()
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const screens = Grid.useBreakpoint()
  const t = sp.get('tab')
  const tab: 'chat' | 'dashboards' | 'tables' = t === 'dashboards' ? 'dashboards' : t === 'tables' ? 'tables' : 'chat'
  const dashId = sp.get('d')
  const { profile } = useAuth()
  const [accessOpen, setAccessOpen] = useState(false)
  const isAdmin = profile?.role === 'labAdmin' || profile?.role === 'admin'

  const setTab = (k: string) => setSp(k === 'chat' ? {} : { tab: k }, { replace: true })
  const selectDash = (id: string | null) => setSp(id ? { tab: 'dashboards', d: id } : { tab: 'dashboards' })

  return (
    <div>
      <PageHeader
        title="Labby AI"
        subtitle="Ask questions in plain words; answers use aggregated numbers only."
        actions={
          <Space wrap>
            {isAdmin && (
              <Button icon={<SafetyOutlined />} onClick={() => setAccessOpen(true)}>
                Data access
              </Button>
            )}
            <DsSegmented aria-label="Labby AI sections" value={tab} onChange={setTab} options={[{ value: 'chat', label: 'Create' }, { value: 'dashboards', label: 'AI Dashboards' }, { value: 'tables', label: 'AI Tables' }]} />
          </Space>
        }
      />
      {isAdmin && <DataAccessDrawer open={accessOpen} onClose={() => setAccessOpen(false)} />}
      <div style={{ display: 'flex', gap: 'var(--s-4)', height: 'calc(100vh - 220px)', minHeight: 480, flexWrap: screens.md ? 'nowrap' : 'wrap' }}>
        {tab === 'chat' && (
          <DsCard padding="var(--s-3)" style={{ width: screens.md ? 260 : '100%', flex: 'none', height: screens.md ? '100%' : 240 }}>
            <ChatList activeId={chatId} onNew={() => navigate('/ai')} onPick={(id) => navigate(`/ai/${id}`)} />
          </DsCard>
        )}
        <DsCard padding="var(--s-4)" style={{ flex: 1, minWidth: 0, height: screens.md ? '100%' : 'auto', minHeight: 420, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: tab === 'chat' ? 'hidden' : 'auto' }}>
            {tab === 'chat' ? <ChatPane chatId={chatId} onOpenDashboard={selectDash} /> : tab === 'dashboards' ? <DashboardsTab selected={dashId} onSelect={selectDash} /> : <AiTablesTab />}
          </div>
        </DsCard>
      </div>
    </div>
  )
}
