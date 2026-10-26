import { useState } from 'react'
import { App } from 'antd'
import { addDoc, collection, deleteDoc, doc, orderBy, query, serverTimestamp, setDoc, updateDoc, Timestamp } from 'firebase/firestore'
import dayjs from 'dayjs'
import { db, LAB_ID } from '../firebase'
import { useAuth } from '../auth/AuthProvider'
import { col } from '../lib/db'
import { useLiveQuery } from '../hooks/useLive'
import { Button } from '../design/Button'
import { StatusChip } from '../design/StatusChip'

interface Survey { id: string; title: string; question: string; options: string[]; status: 'open' | 'closed'; createdAt?: Timestamp }
interface Vote { id: string; option: string }
interface Cmt { id: string; text: string; by: string; byName: string; at?: Timestamp }

const sub = (parent: string, id: string, name: string) => collection(db, 'labs', LAB_ID, parent, id, name)

export function Comments({ parent, id, open = true }: { parent: string; id: string; open?: boolean }) {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const isAdmin = profile?.role === 'labAdmin' || profile?.role === 'admin'
  const { data } = useLiveQuery<Cmt>(query(sub(parent, id, 'comments'), orderBy('at', 'asc')), [parent, id])
  const [text, setText] = useState('')
  const [show, setShow] = useState(false)
  const add = async () => {
    try {
      await addDoc(sub(parent, id, 'comments'), { text: text.trim(), by: user?.uid ?? '', byName: profile?.name ?? '', at: serverTimestamp() })
      setText('')
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <div>
      <Button variant="text" aria-expanded={show} onClick={() => setShow(!show)}>{`Comments (${data.length})`}</Button>
      {show && (
        <div>
          {data.map((c) => (
            <div key={c.id} className="cmt">
              {c.text} <small>{c.byName}{c.at?.toDate ? ` · ${dayjs(c.at.toDate()).format('DD MMM, h:mm A')}` : ''}</small>
              {(isAdmin || c.by === user?.uid) && <Button variant="text" onClick={() => void deleteDoc(doc(sub(parent, id, 'comments'), c.id))}>Delete</Button>}
            </div>
          ))}
          {open && (
            <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 4 }}>
              <input aria-label="Add a comment" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
              <Button disabled={!text.trim()} onClick={add}>Post</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Options with result bars; one vote per user (doc id = uid). */
export function VoteBars({ parent, id, options, open }: { parent: string; id: string; options: string[]; open: boolean }) {
  const { message } = App.useApp()
  const { user } = useAuth()
  const { data } = useLiveQuery<Vote>(query(sub(parent, id, 'votes')), [parent, id])
  const total = data.length
  const mine = data.find((v) => v.id === user?.uid)?.option
  const vote = async (option: string) => {
    if (!user || !open) return
    try {
      await setDoc(doc(sub(parent, id, 'votes'), user.uid), { option, at: serverTimestamp() })
    } catch {
      message.error('Could not record your vote.')
    }
  }
  return (
    <div>
      {options.map((o) => {
        const n = data.filter((v) => v.option === o).length
        const pct = total ? Math.round((n / total) * 100) : 0
        return (
          <div className="bar-row" key={o}>
            <span className="bar-row__fill" style={{ width: `${pct}%` }} aria-hidden="true" />
            <button type="button" aria-pressed={mine === o} disabled={!open} onClick={() => void vote(o)}>
              <span>{o}{mine === o ? ' (your vote)' : ''}</span>
              <span>{n} · {pct}%</span>
            </button>
          </div>
        )
      })}
      <small>{total} vote{total === 1 ? '' : 's'}</small>
    </div>
  )
}

export function Surveys() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'labAdmin' || profile?.role === 'admin'
  const { data } = useLiveQuery<Survey>(query(col('surveys'), orderBy('createdAt', 'desc')), [])
  const [title, setTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [opts, setOpts] = useState('')
  const create = async () => {
    const options = opts.split('\n').map((x) => x.trim()).filter(Boolean)
    if (options.length < 2) return void message.warning('Add at least two options, one per line')
    try {
      await addDoc(col('surveys'), { title: title.trim(), question: question.trim(), options, status: 'open', createdAt: serverTimestamp() })
      setTitle('')
      setQuestion('')
      setOpts('')
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <div>
      {data.length === 0 && <p style={{ color: 'var(--c-on-surface-variant)' }}>No surveys yet.</p>}
      {data.map((s) => (
        <section key={s.id} className="survey">
          <div className="release__head">
            <h3 className="panel-title" style={{ margin: 0 }}>{s.title}</h3>
            <StatusChip variant={s.status === 'open' ? 'success' : 'neutral'}>{s.status === 'open' ? 'Open' : 'Closed'}</StatusChip>
          </div>
          <p>{s.question}</p>
          <VoteBars parent="surveys" id={s.id} options={s.options} open={s.status === 'open'} />
          <Comments parent="surveys" id={s.id} />
          {isAdmin && (
            <span style={{ display: 'flex', gap: 'var(--s-2)' }}>
              <Button variant="text" onClick={() => void updateDoc(doc(col('surveys'), s.id), { status: s.status === 'open' ? 'closed' : 'open' })}>{s.status === 'open' ? 'Close survey' : 'Reopen survey'}</Button>
              <Button variant="text" onClick={() => void deleteDoc(doc(col('surveys'), s.id))}>Delete</Button>
            </span>
          )}
        </section>
      ))}
      {isAdmin && (
        <div style={{ display: 'grid', gap: 'var(--s-2)', marginTop: 'var(--s-4)' }}>
          <h3 className="panel-title">New survey</h3>
          <div className="field-row"><label htmlFor="sv-title">Survey title</label><input id="sv-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field-row"><label htmlFor="sv-q">Question</label><input id="sv-q" value={question} onChange={(e) => setQuestion(e.target.value)} /></div>
          <div className="field-row"><label htmlFor="sv-o">Options (one per line)</label><textarea id="sv-o" rows={3} value={opts} onChange={(e) => setOpts(e.target.value)} /></div>
          <Button variant="primary" disabled={!title.trim() || !question.trim()} onClick={create}>Create survey</Button>
        </div>
      )}
    </div>
  )
}

/** Idea upvote: a single 'up' option vote per user. */
export function IdeaVotes({ id }: { id: string }) {
  const { user } = useAuth()
  const { data } = useLiveQuery<Vote>(query(sub('supportTickets', id, 'votes')), [id])
  const mine = data.some((v) => v.id === user?.uid)
  const toggle = async () => {
    if (!user) return
    const ref = doc(sub('supportTickets', id, 'votes'), user.uid)
    try {
      if (mine) await deleteDoc(ref)
      else await setDoc(ref, { option: 'up', at: serverTimestamp() })
    } catch {
      /* ignore */
    }
  }
  return <Button variant="text" aria-pressed={mine} onClick={toggle}>{`${mine ? 'Voted' : 'Vote'} (${data.length})`}</Button>
}
