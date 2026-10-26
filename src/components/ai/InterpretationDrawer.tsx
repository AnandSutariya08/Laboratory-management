import { useEffect, useState } from 'react'
import { App, Collapse, Drawer, Input } from 'antd'
import { Button } from '../../design/Button'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonCard } from '../../design/Skeletons'
import { StatusChip } from '../../design/StatusChip'
import { updateDoc } from 'firebase/firestore'
import { resultDoc } from '../../lib/db'
import { fmtDateTime } from '../results/common'
import '../results/results.css'
import type { AiInterpretation } from '../../types'


export function formatInterpretation(i: AiInterpretation): string {
  const parts: string[] = []
  if (i.summary) parts.push(i.summary.trim())
  if (i.findings?.length) parts.push(i.findings.map((f) => `- ${f.parameter}: ${f.note}`).join('\n'))
  if (i.suggestions) parts.push(`Suggestions: ${i.suggestions.trim()}`)
  return parts.join('\n\n')
}

interface Props {
  open: boolean
  orderId: string
  testId: string
  testName: string
  // Draft being generated (loading) or the latest draft from the result doc.
  loading: boolean
  error?: string | null
  draft: AiInterpretation | null
  locked: boolean
  onClose: () => void
  // Writes the text into the test comment (same path as manual comment edits).
  onInsert: (text: string) => Promise<void>
}

export default function InterpretationDrawer(p: Props) {
  const { message } = App.useApp()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  // Re-seed the editor whenever a different draft arrives.
  const stamp = p.draft ? `${p.draft.generatedAt?.toMillis?.() ?? 0}:${p.draft.summary}` : ''
  useEffect(() => {
    setText(p.draft ? formatInterpretation(p.draft) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])

  const setStatus = (status: 'accepted' | 'discarded') =>
    updateDoc(resultDoc(p.orderId, p.testId), { 'aiInterpretation.status': status })

  const insert = async () => {
    setBusy(true)
    try {
      await p.onInsert(text.trim())
      await setStatus('accepted')
      message.success('Inserted into the test comment. Save the results to keep it.')
      p.onClose()
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not insert')
    } finally {
      setBusy(false)
    }
  }
  const discard = async () => {
    setBusy(true)
    try {
      await setStatus('discarded')
      p.onClose()
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not discard')
    } finally {
      setBusy(false)
    }
  }

  const d = p.draft
  return (
    <Drawer open={p.open} onClose={p.onClose} width={560} title={`AI interpretation: ${p.testName}`} destroyOnHidden>
      <div className="re-notice re-notice--warn" role="note">
        <b>AI draft, review before use.</b> Generated from de-identified values (age, gender, results). It is not a diagnosis. A qualified person must verify it before it goes on a report.
      </div>
      {p.loading ? (
        <SkeletonCard lines={4} />
      ) : p.error ? (
        <div className="re-notice re-notice--crit" role="alert">{p.error}</div>
      ) : !d ? (
        <EmptyState title="No interpretation yet" />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', marginBottom: 'var(--s-3)', flexWrap: 'wrap' }}>
            <StatusChip variant={d.status === 'draft' ? 'info' : d.status === 'accepted' ? 'success' : 'neutral'}>{d.status}</StatusChip>
            <span className="wl-muted">{d.model} - {fmtDateTime(d.generatedAt)}</span>
          </div>
          <Collapse
            size="small"
            defaultActiveKey={['s']}
            items={[
              {
                key: 's',
                label: 'Draft',
                children: (
                  <div>
                    <p>{d.summary}</p>
                    {d.findings?.map((f, i) => (
                      <div key={i} style={{ marginBottom: 'var(--s-1)' }}>
                        <b>{f.parameter}: </b>
                        {f.note}
                      </div>
                    ))}
                    {d.suggestions && (
                      <p>
                        <b>Suggestions: </b>
                        {d.suggestions}
                      </p>
                    )}
                  </div>
                ),
              },
            ]}
          />
          <div className="re-field" style={{ marginTop: 'var(--s-4)' }}>
            <label htmlFor="ai-text">Text to insert (editable)</label>
            <Input.TextArea id="ai-text" rows={9} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          {p.locked && <div className="re-notice re-notice--info">This test is approved. Un-approve it to edit its comment.</div>}
          <div className="re-actions">
            <Button variant="primary" disabled={busy || !text.trim() || p.locked} onClick={insert}>Insert into test comment</Button>
            <Button disabled={busy} onClick={discard}>Discard</Button>
          </div>
        </>
      )}
    </Drawer>
  )
}
