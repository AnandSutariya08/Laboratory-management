import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Checkbox, Input, Modal, Select } from 'antd'
import { addDoc, deleteDoc, doc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { Button } from '../../../design/Button'
import { Card } from '../../../design/Card'
import { EmptyState } from '../../../design/EmptyState'
import { Segmented } from '../../../design/Segmented'
import { StatusChip } from '../../../design/StatusChip'
import { useAuth } from '../../../auth/AuthProvider'
import { useLiveQuery } from '../../../hooks/useLive'
import { col } from '../../../lib/db'
import { type MasterDoc, type Range } from '../shared'
import { BASE_LABEL, buildRows, COLUMNS, outsourceCols, type BaseTab, type ColDef, type Ctx, type FRow } from './model'
import { applyFilters, FilterBar, resolveCols, RowsTable, type ExportSettings, type TabFilters } from './RowsTable'
import { useRequestExport } from './BackgroundExports'
import { dialogWidth } from '../../../design/dialog'

// Custom finance tabs, saved to Firestore (labs/{lab}/financeTabs) so they follow the user across browsers and can be
// shared to roles. The owner (or an admin) edits; people the tab is shared with can open it and filter it.
export interface CustomTabDef {
  id: string
  name: string
  base: BaseTab
  columns: string[]
  pinned: string[]
  filters: TabFilters
  groupBy?: string // column key; money columns are summed per group
  sortBy?: string
  sortDir?: 'asc' | 'desc'
  exportSettings?: ExportSettings
  sharedWithRoles?: string[]
  ownerId?: string
  ownerName?: string
}

export const SHARE_ROLES = [
  { value: 'admin', label: 'Admin' }, { value: 'manager', label: 'Manager' }, { value: 'reception', label: 'Reception' },
  { value: 'technician', label: 'Technician' }, { value: 'doctor', label: 'Doctor' }, { value: 'phlebotomist', label: 'Phlebotomist' },
]

const legacyKey = (uid: string) => `hcl.finance.customTabs.${uid || 'anon'}`
const clean = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export default function CustomTab({ ctxFor, users, range }: { uid?: string; ctxFor: (base: BaseTab) => { ctx: Ctx; labs: MasterDoc[] }; users: { uid: string; name: string }[]; range: Range }) {
  const { profile } = useAuth()
  const { message, modal } = App.useApp()
  const uid = profile?.uid ?? ''
  const isAdmin = profile?.role === 'labAdmin' || profile?.role === 'admin'
  const { data: all, loading } = useLiveQuery<CustomTabDef>(col('financeTabs'), [])
  const tabs = useMemo(
    () => all.filter((t) => t.ownerId === uid || isAdmin || (t.sharedWithRoles ?? []).includes(profile?.role ?? '')).sort((a, b) => a.name.localeCompare(b.name)),
    [all, uid, isAdmin, profile?.role],
  )
  const [activeId, setActiveId] = useState('')
  const [editing, setEditing] = useState<CustomTabDef | null>(null)
  const [filters, setFilters] = useState<TabFilters>({})
  const request = useRequestExport(range)

  // One-time import of tabs kept in this browser before they were saved to the lab.
  const migrated = useRef(false)
  useEffect(() => {
    if (migrated.current || !uid || loading) return
    migrated.current = true
    try {
      const old = JSON.parse(localStorage.getItem(legacyKey(uid)) ?? '[]') as CustomTabDef[]
      if (!old.length) return
      Promise.all(old.map((t) => addDoc(col('financeTabs'), clean({ ...t, id: undefined, ownerId: uid, ownerName: profile?.name ?? '', sharedWithRoles: [], createdAt: serverTimestamp() }))))
        .then(() => { try { localStorage.removeItem(legacyKey(uid)) } catch { /* ignore */ } })
        .catch(() => undefined)
    } catch { /* ignore */ }
  }, [uid, loading, profile?.name])

  useEffect(() => { if (!tabs.some((t) => t.id === activeId)) setActiveId(tabs[0]?.id ?? '') }, [tabs, activeId])
  const active = tabs.find((t) => t.id === activeId)
  const mine = !!active && (active.ownerId === uid || isAdmin)
  useEffect(() => { if (active) setFilters(active.filters ?? {}) }, [active?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const persistFilters = (f: TabFilters) => {
    setFilters(f)
    if (active && mine) void updateDoc(doc(col('financeTabs'), active.id), { filters: clean(f) }).catch(() => undefined)
  }
  const del = () => {
    if (!active) return
    modal.confirm({ title: `Delete "${active.name}"?`, content: active.sharedWithRoles?.length ? 'It is shared with other roles; they lose access.' : undefined, okText: 'Delete', okButtonProps: { danger: true }, onOk: () => deleteDoc(doc(col('financeTabs'), active.id)).catch(() => message.error('Could not delete the tab.')) })
  }
  const upsert = async (d: CustomTabDef) => {
    try {
      const { id, ...rest } = d
      const data = clean({ ...rest, ownerId: d.ownerId || uid, ownerName: d.ownerName || profile?.name || '', sharedWithRoles: d.sharedWithRoles ?? [], updatedAt: serverTimestamp() })
      if (all.some((t) => t.id === id)) await updateDoc(doc(col('financeTabs'), id), data)
      else { const r = await addDoc(col('financeTabs'), { ...data, createdAt: serverTimestamp() }); setActiveId(r.id) }
      setEditing(null)
    } catch {
      message.error('Could not save the tab.')
    }
  }

  const view = useMemo(() => {
    if (!active) return null
    const { ctx, labs: l } = ctxFor(active.base)
    let rows: FRow[] = applyFilters(buildRows(active.base, ctx, l), filters, ctx, l)
    let cols: ColDef[] = resolveCols(active.columns, l)
    const group = active.groupBy && cols.find((c) => c.key === active.groupBy) ? active.groupBy : ''
    if (group) {
      const g = new Map<string, FRow>()
      const gc = cols.find((c) => c.key === group)!
      for (const r of rows) {
        const k = String(gc.get(r, ctx))
        let x = g.get(k)
        if (!x) { x = { key: `g:${k}`, o: r.o, frac: 1, grp: Object.fromEntries(cols.map((c) => [c.key, c.money ? 0 : c.key === group ? k : ''])) }; g.set(k, x) }
        for (const c of cols) if (c.money) x.grp![c.key] = Number(x.grp![c.key]) + Number(c.get(r, ctx) || 0)
      }
      rows = [...g.values()]
      cols = cols.map((c) => ({ ...c, get: (r: FRow) => r.grp?.[c.key] ?? '' }))
    }
    const sc = active.sortBy ? cols.find((c) => c.key === active.sortBy) : undefined
    if (sc) {
      const dir = active.sortDir === 'asc' ? 1 : -1
      rows = [...rows].sort((a, b) => {
        const x = sc.get(a, ctx), y = sc.get(b, ctx)
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir
      })
    }
    return { ctx, rows, cols, l }
  }, [active, filters, ctxFor])

  const blank = (): CustomTabDef => ({ id: '', name: '', base: 'billing', columns: ['billDate', 'billId', 'patientInfo', 'amount', 'paid', 'due'], pinned: [], filters: {}, exportSettings: { includeTotals: true, includeHeader: true, delimiter: ',' }, sharedWithRoles: [] })

  return (
    <div className="an-stack">
      <Card>
        <div className="an-pill-row">
          {tabs.length > 0 && <Segmented aria-label="Custom tabs" size="small" value={activeId} onChange={setActiveId} options={tabs.map((t) => ({ value: t.id, label: t.name }))} />}
          <span className="an-toolbar__spacer" />
          {active && mine && <Button onClick={() => setEditing({ ...active })}>Edit tab</Button>}
          {active && mine && <Button onClick={del}>Delete tab</Button>}
          <Button variant="primary" onClick={() => setEditing(blank())}>Add tab</Button>
        </div>
        <p className="an-note">
          Custom tabs are saved to the lab, so they follow you to any browser.
          {active && active.ownerId !== uid ? ` Shared by ${active.ownerName || 'a colleague'}; you can filter it but only they or an admin can change it.` : ''}
          {active && mine && active.sharedWithRoles?.length ? <> Shared with <StatusChip variant="info">{active.sharedWithRoles.join(', ')}</StatusChip>.</> : ''}
        </p>
      </Card>
      {!active || !view ? (
        <Card><EmptyState title={loading ? 'Loading tabs' : 'No custom tabs yet'} description="Pick a base tab, name it and choose the columns you want, in the order you want them." /></Card>
      ) : (
        <>
          <FilterBar base={active.base} filters={filters} onChange={persistFilters} ctx={view.ctx} labs={view.l} users={users} />
          <RowsTable rows={view.rows} cols={view.cols} ctx={view.ctx} pinned={active.pinned} fileName={`custom-${active.name}`} settings={active.exportSettings}
            actions={<Button aria-label="Export in the background" onClick={() => request('custom', active.name, { base: active.base, columns: active.columns, filters, groupBy: active.groupBy, sortBy: active.sortBy, sortDir: active.sortDir, exportSettings: active.exportSettings })}>Run in background</Button>} />
        </>
      )}
      {editing && <Builder def={editing} labs={view?.l ?? []} onCancel={() => setEditing(null)} onSave={upsert} canShare={editing.ownerId ? editing.ownerId === uid || isAdmin : true} />}
    </div>
  )
}

const DELIMS = [{ value: ',', label: 'Comma (,)' }, { value: ';', label: 'Semicolon (;)' }, { value: '\t', label: 'Tab' }, { value: '|', label: 'Pipe (|)' }]

function Builder({ def, labs, onSave, onCancel, canShare }: { def: CustomTabDef; labs: MasterDoc[]; onSave: (d: CustomTabDef) => void; onCancel: () => void; canShare: boolean }) {
  const [d, setD] = useState(def)
  const all = [...COLUMNS.map((c) => ({ key: c.key, title: c.title })), ...outsourceCols(labs).map((c) => ({ key: c.key, title: c.title }))]
  const title = (k: string) => all.find((c) => c.key === k)?.title ?? k
  const move = (i: number, dir: -1 | 1) => setD((x) => { const c = [...x.columns]; const j = i + dir; if (j < 0 || j >= c.length) return x; [c[i], c[j]] = [c[j], c[i]]; return { ...x, columns: c } })
  const toggle = (k: string, on: boolean) => setD((x) => ({
    ...x, columns: on ? [...x.columns, k] : x.columns.filter((c) => c !== k), pinned: on ? x.pinned : x.pinned.filter((c) => c !== k),
    groupBy: !on && x.groupBy === k ? '' : x.groupBy, sortBy: !on && x.sortBy === k ? '' : x.sortBy,
  }))
  const ex = d.exportSettings ?? {}
  const setEx = (p: Partial<ExportSettings>) => setD({ ...d, exportSettings: { ...ex, ...p } })
  const colOpts = d.columns.map((k) => ({ value: k, label: title(k) }))
  return (
    <Modal open title={def.id ? 'Edit tab' : 'Add tab'} onCancel={onCancel} width={dialogWidth(760)} onOk={() => d.name.trim() && d.columns.length && onSave({ ...d, name: d.name.trim() })} okText="Save tab" okButtonProps={{ disabled: !d.name.trim() || !d.columns.length }}>
      <div className="an-stack">
        <div className="an-pill-row">
          <Input placeholder="Tab name" aria-label="Tab name" style={{ width: 240 }} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          <Select aria-label="Base tab" style={{ width: 180 }} value={d.base} onChange={(v) => setD({ ...d, base: v })} options={(Object.keys(BASE_LABEL) as BaseTab[]).map((v) => ({ value: v, label: BASE_LABEL[v] }))} />
        </div>
        <div className="an-pill-row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <h3 className="an-card-title">Available columns</h3>
            <div className="an-colpick">
              {all.map((c) => <Checkbox key={c.key} checked={d.columns.includes(c.key)} onChange={(e) => toggle(c.key, e.target.checked)}>{c.title}</Checkbox>)}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <h3 className="an-card-title">Selected, in order</h3>
            <div className="an-colpick">
              {d.columns.map((k, i) => (
                <div className="an-colpick__row" key={k}>
                  <span>{i + 1}. {title(k)}</span>
                  <Button aria-label={`Move ${title(k)} up`} onClick={() => move(i, -1)} disabled={i === 0}>Up</Button>
                  <Button aria-label={`Move ${title(k)} down`} onClick={() => move(i, 1)} disabled={i === d.columns.length - 1}>Down</Button>
                  <Checkbox checked={d.pinned.includes(k)} onChange={(e) => setD({ ...d, pinned: e.target.checked ? [...d.pinned, k] : d.pinned.filter((p) => p !== k) })} aria-label={`Pin ${title(k)}`}>Pin</Checkbox>
                </div>
              ))}
              {!d.columns.length && <span className="an-note">Choose at least one column.</span>}
            </div>
          </div>
        </div>

        <h3 className="an-card-title">Group and sort</h3>
        <div className="an-pill-row">
          <Select allowClear placeholder="Group by" aria-label="Group by column" style={{ width: 200 }} value={d.groupBy || undefined} onChange={(v) => setD({ ...d, groupBy: v ?? '' })} options={colOpts} />
          <Select allowClear placeholder="Sort by" aria-label="Sort by column" style={{ width: 200 }} value={d.sortBy || undefined} onChange={(v) => setD({ ...d, sortBy: v ?? '' })} options={colOpts} />
          <Segmented aria-label="Sort direction" size="small" value={d.sortDir ?? 'desc'} onChange={(v) => setD({ ...d, sortDir: v })} options={[{ value: 'desc', label: 'High to low' }, { value: 'asc', label: 'Low to high' }]} />
        </div>
        {d.groupBy && <p className="an-note">Grouped rows show the total of every amount column for each {title(d.groupBy)}.</p>}

        <h3 className="an-card-title">Export settings</h3>
        <div className="an-pill-row">
          <Input placeholder="File name (default: tab name)" aria-label="Export file name" style={{ width: 240 }} value={ex.fileName ?? ''} onChange={(e) => setEx({ fileName: e.target.value })} />
          <Select aria-label="Delimiter" style={{ width: 160 }} value={ex.delimiter ?? ','} onChange={(v) => setEx({ delimiter: v })} options={DELIMS} />
          <Checkbox checked={ex.includeHeader !== false} onChange={(e) => setEx({ includeHeader: e.target.checked })}>Header row</Checkbox>
          <Checkbox checked={ex.includeTotals !== false} onChange={(e) => setEx({ includeTotals: e.target.checked })}>Totals row</Checkbox>
        </div>

        <h3 className="an-card-title">Sharing</h3>
        {canShare ? (
          <Select mode="multiple" allowClear placeholder="Share with roles (private if empty)" aria-label="Share with roles" style={{ width: '100%' }} value={d.sharedWithRoles ?? []} onChange={(v) => setD({ ...d, sharedWithRoles: v })} options={SHARE_ROLES} />
        ) : <p className="an-note">Only the owner or an admin can change sharing.</p>}
      </div>
    </Modal>
  )
}

