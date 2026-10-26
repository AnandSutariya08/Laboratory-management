import { useEffect, useState } from 'react'
import { App, Drawer } from 'antd'
import { limit, query, where } from 'firebase/firestore'
import { useAuth } from '../auth/AuthProvider'
import { col } from '../lib/db'
import { useLiveQuery } from '../hooks/useLive'
import { useBranchScope } from '../lib/branchScope'
import { Segmented } from '../design/Segmented'
import { StatusChip } from '../design/StatusChip'
import { Button } from '../design/Button'
import { RELEASE_NOTES } from './releaseNotes'
import { Surveys, Comments, IdeaVotes } from './Surveys'
import { AnnouncementList, useAnnouncements } from './Announcements'
import { createTicket, type TicketType } from './SupportTicketModal'

interface Ticket {
  id: string
  subject: string
  description: string
  createdByName: string
}

function Submit({ type }: { type: Exclude<TicketType, 'ticket'> }) {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const scope = useBranchScope()
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const list = useLiveQuery<Ticket>(query(col('supportTickets'), ...scope.constraints, where('type', '==', type), limit(20)), [scope.key, type])
  const label = type === 'idea' ? 'idea' : 'feedback'
  const send = async () => {
    setBusy(true)
    try {
      await createTicket({ subject: subject || (type === 'idea' ? 'Idea' : 'Feedback'), description: text, type, uid: user?.uid ?? '', name: profile?.name ?? '' })
      setSubject('')
      setText('')
      message.success(`Thanks, your ${label} was recorded.`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      {type === 'idea' && (
        <div className="field-row">
          <label htmlFor="idea-title">Idea title</label>
          <input id="idea-title" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
      )}
      <div className="field-row">
        <label htmlFor={`${type}-text`}>{type === 'idea' ? 'What should we build?' : 'Tell us what works and what does not'}</label>
        <textarea id={`${type}-text`} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <Button variant="primary" disabled={!text.trim() || busy} onClick={send}>Submit {label}</Button>
      {type === 'idea' && list.data.length > 0 && (
        <>
          <h3 className="panel-title">Ideas from your branch</h3>
          <ul className="ideas-list">
            {list.data.map((i) => (
              <li key={i.id}>
                <strong>{i.subject}</strong>
                <div>{i.description}</div>
                <small>{i.createdByName}</small>
                <div><IdeaVotes id={i.id} /><Comments parent="supportTickets" id={i.id} /></div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default function NewsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'updates' | 'announcements' | 'surveys' | 'ideas' | 'feedback'>('updates')
  const ann = useAnnouncements()
  useEffect(() => {
    if (open && tab === 'announcements' && ann.unread > 0) {
      const t = window.setTimeout(ann.markSeen, 1500)
      return () => window.clearTimeout(t)
    }
  }, [open, tab, ann.unread, ann.markSeen])
  return (
    <Drawer title="What's new" open={open} onClose={onClose} size={460} placement="right">
      <Segmented aria-label="What's new sections" value={tab} onChange={setTab} options={[{ value: 'updates', label: 'Updates' }, { value: 'announcements', label: ann.unread ? `Announcements (${ann.unread})` : 'Announcements' }, { value: 'surveys', label: 'Surveys' }, { value: 'ideas', label: 'Ideas' }, { value: 'feedback', label: 'Feedback' }]} />
      <div style={{ marginTop: 'var(--s-4)' }}>
        {tab === 'updates' &&
          RELEASE_NOTES.map((r) => (
            <section key={r.version} className="release">
              <div className="release__head">
                <h3 className="panel-title" style={{ margin: 0 }}>{r.title}</h3>
                <StatusChip variant="info">v{r.version}</StatusChip>
              </div>
              <time dateTime={r.date} className="release__date">{r.date}</time>
              <ul>{r.items.map((i) => <li key={i}>{i}</li>)}</ul>
            </section>
          ))}
        {tab === 'announcements' && <AnnouncementList list={ann} withComposer />}
        {tab === 'surveys' && <Surveys />}
        {tab === 'ideas' && <Submit type="idea" />}
        {tab === 'feedback' && <Submit type="feedback" />}
      </div>
    </Drawer>
  )
}
