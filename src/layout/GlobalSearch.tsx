import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { SearchOutlined, FileTextOutlined, UserOutlined } from '@ant-design/icons'
import { getDocs, limit, orderBy, query, where, type QueryConstraint } from 'firebase/firestore'
import { col } from '../lib/db'
import { useBranchScope } from '../lib/branchScope'
import type { Order, Patient } from '../types'

interface Hit {
  key: string
  kind: 'patient' | 'bill'
  title: string
  detail: string
  to: string
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
const prefix = (field: string, v: string): QueryConstraint[] => [orderBy(field), where(field, '>=', v), where(field, '<=', v + ''), limit(5)]

// Search box in the top bar: matches name, phone, patient no, UHID, bill number and barcode,
// and shows Patient / Bill hits in a popover instead of only navigating.
export default function GlobalSearch({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const navigate = useNavigate()
  const scope = useBranchScope()
  const listId = useId()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(-1)
  const seq = useRef(0)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setHits([])
      setBusy(false)
      return
    }
    const id = ++seq.current
    setBusy(true)
    const t = setTimeout(async () => {
      const patients = new Map<string, Patient>()
      const orders = new Map<string, Order>()
      const run = async <T,>(qq: ReturnType<typeof query>, into: Map<string, T>) => {
        try {
          const s = await getDocs(qq)
          s.docs.forEach((d) => into.set(d.id, { ...(d.data() as object), id: d.id } as T))
        } catch {
          /* a missing index or rule only drops that source */
        }
      }
      const isNum = /^[0-9+ ]+$/.test(term)
      const tasks: Promise<void>[] = []
      const pq = (f: string, v: string) => tasks.push(run(query(col('patients'), ...prefix(f, v)), patients))
      if (isNum) pq('phone', term.replace(/\s/g, ''))
      pq('patientNo', term)
      pq('uhid', term)
      if (!isNum) [term, cap(term)].forEach((v) => pq('firstName', v))
      const oq = (f: string, v: string) => tasks.push(run(query(col('orders'), ...scope.constraints, where(f, '==', v), limit(5)), orders))
      oq('barcode', term)
      oq('billNo', term)
      oq('billNo', term.toUpperCase())
      oq('uhid', term)
      await Promise.all(tasks)
      if (id !== seq.current) return
      const out: Hit[] = [
        ...[...patients.values()].map((p): Hit => ({
          key: `p${p.id}`,
          kind: 'patient',
          title: `${p.salutation ?? ''} ${p.firstName} ${p.lastName ?? ''}`.replace(/\s+/g, ' ').trim(),
          detail: [p.patientNo, p.uhid && `UHID ${p.uhid}`, p.phone].filter(Boolean).join(' · '),
          to: `/patients/${p.id}`,
        })),
        ...[...orders.values()]
          .filter((o) => !o.deleted)
          .map((o): Hit => ({ key: `o${o.id}`, kind: 'bill', title: `${o.billNo} · ${o.patientName}`, detail: [o.barcode && `Barcode ${o.barcode}`, o.patientNo].filter(Boolean).join(' · '), to: `/patients?q=${encodeURIComponent(o.billNo)}` })),
      ]
      setHits(out)
      setBusy(false)
      setHi(-1)
    }, 250)
    return () => clearTimeout(t)
  }, [q, scope.key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', on)
    return () => document.removeEventListener('mousedown', on)
  }, [])

  const go = (to: string) => {
    setOpen(false)
    setQ('')
    navigate(to)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((h) => Math.min(h + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((h) => Math.max(h - 1, -1))
    } else if (e.key === 'Escape') setOpen(false)
    else if (e.key === 'Enter') {
      if (hits[hi]) go(hits[hi].to)
      else if (q.trim()) go(`/patients?q=${encodeURIComponent(q.trim())}`)
    }
  }
  const show = open && q.trim().length >= 2
  const group = (kind: Hit['kind'], label: string) => {
    const list = hits.filter((h) => h.kind === kind)
    if (!list.length) return null
    return (
      <li role="presentation" key={kind}>
        <div className="gs__group">{label}</div>
        <ul role="presentation" className="gs__list">
          {list.map((h) => {
            const i = hits.indexOf(h)
            return (
              <li key={h.key} id={`${listId}-${i}`} role="option" aria-selected={i === hi} className={`gs__hit ${i === hi ? 'gs__hit--hi' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => go(h.to)}>
                {kind === 'patient' ? <UserOutlined aria-hidden="true" /> : <FileTextOutlined aria-hidden="true" />}
                <span>
                  <strong>{h.title}</strong>
                  <small>{h.detail}</small>
                </span>
              </li>
            )
          })}
        </ul>
      </li>
    )
  }

  return (
    <div className="gs" ref={box}>
      <label className="topbar__search">
        <SearchOutlined aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={show}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={hi >= 0 ? `${listId}-${hi}` : undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder="Name, phone, patient ID, UHID or bill"
          aria-label="Search by name, phone number, patient ID, UHID, bill number or barcode"
          autoComplete="off"
        />
      </label>
      {show && (
        <div className="gs__pop glass" role="region" aria-label="Search results">
          <ul id={listId} role="listbox" className="gs__list">
            {busy && hits.length === 0 && <li className="gs__empty">Searching…</li>}
            {!busy && hits.length === 0 && <li className="gs__empty">No patient or bill found. Press Enter to open the patient list with this search.</li>}
            {group('patient', 'Patient')}
            {group('bill', 'Bill')}
          </ul>
        </div>
      )}
    </div>
  )
}
