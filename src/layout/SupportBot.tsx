import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Avatar, Button, Drawer, Input, Space, Spin, Typography } from 'antd'
import { QuestionCircleOutlined, RobotOutlined, SendOutlined, UserOutlined } from '@ant-design/icons'
import Markdown from '../components/ai/Markdown'
import { supportChat, type SupportAnswer } from '../lib/support'

const { Text } = Typography

interface Msg {
  role: 'user' | 'assistant'
  text: string
  answer?: SupportAnswer
}

const SUGGESTIONS = [
  'How do I register a patient and create a bill?',
  'How do I send a report on WhatsApp?',
  'How do I clear a due on a bill?',
  'How do I run internal QC?',
  'Why can I not see a menu item?',
]

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/\s*\[\d+\]\s*$/, '') : 'Something went wrong')

// Pages a topic's "screen" label can link to (best effort; only the first match is linked).
const SCREEN_LINKS: [string, string][] = [
  ['New Registration', '/registration'],
  ['Bookings', '/bookings'],
  ['Patient List', '/patients'],
  ['Pending Dispatch', '/dispatch'],
  ['Accession', '/accession'],
  ['Pathology', '/worklist'],
  ['Radiology', '/radiology'],
  ['Financial Analysis', '/finance'],
  ['TAT Analysis', '/tat'],
  ['Analysis', '/analysis'],
  ['Test List', '/tests'],
  ['Packages', '/packages'],
  ['Import Catalogue', '/catalogue-import'],
  ['Run QC', '/qc/run'],
  ['Quality Control', '/qc'],
  ['NABL Audit', '/nabl'],
  ['Inventory', '/inventory'],
  ['Manage Users', '/users'],
  ['Roles & Permissions', '/roles'],
  ['Branches', '/branches'],
  ['Referral List', '/referrals'],
  ['Lab Profile', '/settings'],
  ['Connect AI', '/connect-ai'],
  ['Labby AI', '/ai'],
  ['Smart Report', '/smart-report'],
]
const linkFor = (screen: string) => SCREEN_LINKS.find(([k]) => screen.includes(k))?.[1]

// Help chat drawer. Answers come from the server's help topics (supportChat); it works for any staff
// role. Opened from the Help menu in the top bar.
export default function SupportBot({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [msgs.length, busy])

  const send = async (override?: string) => {
    const q = (override ?? text).trim()
    if (!q || busy) return
    setText('')
    setError(null)
    const history = msgs.map((m) => ({ role: m.role, text: m.text }))
    setMsgs((m) => [...m, { role: 'user', text: q }])
    setBusy(true)
    try {
      const a = await supportChat(q, history)
      setMsgs((m) => [...m, { role: 'assistant', text: a.answer, answer: a }])
    } catch (e) {
      setError(errText(e))
      setText(q)
      setMsgs((m) => m.slice(0, -1))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={420}
      title={
        <Space>
          <QuestionCircleOutlined />
          Help assistant
        </Space>
      }
      styles={{ body: { display: 'flex', flexDirection: 'column', padding: 12, minHeight: 0 } }}
    >
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }} aria-live="polite">
        {msgs.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 4px' }}>
            <Avatar size={48} style={{ background: 'var(--c-primary-container)', color: 'var(--c-primary)' }} icon={<RobotOutlined />} />
            <div style={{ marginTop: 10, fontWeight: 600 }}>How can I help?</div>
            <Text type="secondary">Ask how to do something in the app. I answer only from the help topics.</Text>
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SUGGESTIONS.map((s) => (
                <Button key={s} shape="round" onClick={() => send(s)} disabled={busy}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => {
          const mine = m.role === 'user'
          return (
            <div key={i} style={{ display: 'flex', gap: 8, justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
              {!mine && <Avatar size={28} style={{ background: 'var(--c-accent)', flex: 'none' }} icon={<RobotOutlined />} />}
              <div style={{ maxWidth: '86%', minWidth: 0 }}>
                <div
                  style={{
                    background: mine ? 'var(--c-primary)' : 'var(--c-surface-container-high)',
                    color: mine ? 'var(--c-on-primary)' : undefined,
                    border: mine ? 'none' : '1px solid var(--c-outline-variant)',
                    borderRadius: 'var(--r-section)',
                    padding: '6px 12px',
                  }}
                >
                  {mine ? <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div> : <Markdown text={m.text} />}
                </div>
                {m.answer?.reason && (
                  <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    {m.answer.reason}
                  </Text>
                )}
                {m.answer && m.answer.topics.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    <Text type="secondary">{m.answer.found ? 'Based on: ' : 'Related topics: '}</Text>
                    {m.answer.topics.map((t, k) => {
                      const link = linkFor(t.screen)
                      return (
                        <span key={t.id}>
                          {k > 0 && ', '}
                          {link ? (
                            <Link to={link} onClick={onClose} title={t.screen}>
                              {t.title}
                            </Link>
                          ) : (
                            t.title
                          )}
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
              {mine && <Avatar size={28} style={{ background: 'var(--c-primary)', flex: 'none' }} icon={<UserOutlined />} />}
            </div>
          )
        })}
        {busy && (
          <Space style={{ marginBottom: 12 }}>
            <Spin size="small" />
            <Text type="secondary">Looking through the help topics…</Text>
          </Space>
        )}
        <div ref={endRef} />
      </div>
      {error && <Alert type="error" showIcon closable onClose={() => setError(null)} message={error} style={{ marginBottom: 8 }} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <Input.TextArea
          value={text}
          autoSize={{ minRows: 1, maxRows: 4 }}
          maxLength={600}
          placeholder="Ask how to do something… (Enter to send)"
          aria-label="Your question"
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <Button type="primary" icon={<SendOutlined />} loading={busy} disabled={!text.trim()} onClick={() => send()} aria-label="Send" />
      </div>
    </Drawer>
  )
}
