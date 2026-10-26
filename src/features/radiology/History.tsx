import { useMemo, useState } from 'react'
import { Modal, Select } from 'antd'
import { orderBy, query } from 'firebase/firestore'
import { useLiveQuery } from '../../hooks/useLive'
import { versionsCol } from '../../lib/db'
import { dialogWidth } from '../../design/dialog'
import { fmtDateTime } from '../../components/results/common'
import { htmlToText, wordDiff } from './diff'

interface Ver { id: string; event: string; byName: string; at: { toMillis(): number } | null; radiology?: { technique?: string; findings?: string; impression?: string } }

const SECTIONS: ['technique' | 'findings' | 'impression', string][] = [['technique', 'Technique'], ['findings', 'Findings'], ['impression', 'Impression']]
const EVENT: Record<string, string> = { saved: 'Saved', approved: 'Approved', unapproved: 'Un-approved', amended: 'Amended', autosaved: 'Autosaved' }

// Revision trail of a radiology report (RAD-11): pick two versions (or a version and the editor text) and see the words that changed.
export default function HistoryModal({ open, onClose, orderId, testId, current }: { open: boolean; onClose: () => void; orderId: string; testId: string; current: { technique: string; findings: string; impression: string } }) {
  const { data } = useLiveQuery<Ver>(open ? query(versionsCol(orderId, testId), orderBy('at', 'desc')) : null, [open, orderId, testId])
  const versions = useMemo(() => data.filter((v) => v.radiology), [data])
  const [a, setA] = useState('')
  const [b, setB] = useState('now')
  const label = (v: Ver) => `${EVENT[v.event] ?? v.event} by ${v.byName || 'system'}, ${v.at ? fmtDateTime(v.at as never) : ''}`
  const left = versions.find((v) => v.id === (a || versions[1]?.id || versions[0]?.id))
  const right = b === 'now' ? current : versions.find((v) => v.id === b)?.radiology
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={dialogWidth(760)} title="Report history" destroyOnHidden>
      {versions.length === 0 ? (
        <p className="rd-muted">No earlier versions yet. Every save and autosave adds one.</p>
      ) : (
        <>
          <div className="rd-actions" style={{ marginBottom: 'var(--s-3)' }}>
            <Select aria-label="Older version" style={{ minWidth: 260 }} value={left?.id} onChange={setA} options={versions.map((v) => ({ value: v.id, label: label(v) }))} />
            <span>compared with</span>
            <Select aria-label="Newer version" style={{ minWidth: 260 }} value={b} onChange={setB} options={[{ value: 'now', label: 'The text in the editor now' }, ...versions.map((v) => ({ value: v.id, label: label(v) }))]} />
          </div>
          {SECTIONS.map(([k, title]) => {
            const parts = wordDiff(htmlToText(left?.radiology?.[k]), htmlToText(right?.[k]))
            const same = parts.every((p) => p.t === 'same')
            return (
              <div key={k} style={{ marginBottom: 'var(--s-3)' }}>
                <b>{title}</b>{same && <span className="rd-muted"> (no change)</span>}
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {parts.map((p, i) =>
                    p.t === 'same' ? <span key={i}>{p.text}</span> : p.t === 'add'
                      ? <ins key={i} style={{ background: 'var(--c-success-wash, #dcfce7)', textDecoration: 'none' }}>{p.text}</ins>
                      : <del key={i} style={{ background: 'var(--c-urgent-wash, #fee2e2)' }}>{p.text}</del>,
                  )}
                </div>
              </div>
            )
          })}
        </>
      )}
    </Modal>
  )
}
