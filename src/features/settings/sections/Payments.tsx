import { useState } from 'react'
import { App, Input, Switch } from 'antd'
import { addDoc, deleteDoc, updateDoc } from 'firebase/firestore'
import { Button } from '../../../design/Button'
import { StatusChip } from '../../../design/StatusChip'
import { useLiveQuery } from '../../../hooks/useLive'
import { col, docRef } from '../../../lib/db'
import { SectionCard, useDraft } from '../ui'

interface PaymentMode { id: string; name: string; active: boolean; builtIn?: boolean }
const BUILT_IN = [
  { id: 'cash', name: 'Cash', note: '' }, { id: 'upi', name: 'UPI', note: '' },
  { id: 'card', name: 'Card', note: '' }, { id: 'wallet', name: 'Wallet', note: 'B2B only' },
]

export function Payments() {
  const { message } = App.useApp()
  const { canEdit } = useDraft()
  const { data } = useLiveQuery<PaymentMode>(col('paymentModes'), [])
  const [name, setName] = useState('')
  const custom = data.filter((m) => !BUILT_IN.some((b) => b.id === m.id))
  const run = (p: Promise<unknown>) => p.catch((e: Error) => message.error(e.message))

  const add = async () => {
    const n = name.trim()
    if (!n) return
    if (custom.length >= 10) return message.error('You can add up to 10 custom methods')
    if ([...BUILT_IN, ...custom].some((m) => m.name.toLowerCase() === n.toLowerCase())) return message.error('That method already exists')
    await run(addDoc(col('paymentModes'), { name: n, active: true, builtIn: false }))
    setName('')
  }
  return (
    <SectionCard title="Payment methods" description="Methods offered when collecting payment (on the bill, clear due and reports). Cash, UPI and Card are always on; Wallet is settled by the B2B system. Removing a custom method never changes past payments.">
      {BUILT_IN.map((b) => {
        // Default methods cannot be renamed, removed or switched off (Flabs); Wallet is settled by B2B billing, never offered on patient bills.
        const active = b.id !== 'wallet'
        return (
          <div className="st-row" key={b.id}>
            <div className="st-row__text">
              <div className="st-row__title">{b.name}</div>
              {b.note && <div className="st-row__desc">{b.note}</div>}
            </div>
            <div className="st-actions">
              <StatusChip>Built in</StatusChip>
              <Switch checked={active} disabled aria-label={`${b.name} enabled`} />
            </div>
          </div>
        )
      })}
      {custom.map((m) => (
        <div className="st-row" key={m.id}>
          <div className="st-row__title">{m.name}</div>
          <div className="st-actions">
            <Switch checked={m.active} disabled={!canEdit} onChange={(v) => run(updateDoc(docRef('paymentModes', m.id), { active: v }))} aria-label={`${m.name} enabled`} />
            {canEdit && <Button variant="text" onClick={() => run(deleteDoc(docRef('paymentModes', m.id)))}>Delete</Button>}
          </div>
        </div>
      ))}
      {canEdit && (
        <div className="st-actions" style={{ marginTop: 'var(--s-4)' }}>
          <Input style={{ maxWidth: 260 }} value={name} onChange={(e) => setName(e.target.value)} onPressEnter={add} placeholder="New method name" aria-label="New payment method name" />
          <Button onClick={add}>Add method</Button>
          <span className="st-field__hint">{custom.length} of 10 custom methods</span>
        </div>
      )}
    </SectionCard>
  )
}
