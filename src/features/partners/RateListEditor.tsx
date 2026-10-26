import { useEffect, useMemo, useState } from 'react'
import { Drawer, Input, InputNumber, Select, Space, Table, message } from 'antd'
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { formatINR, toPaise } from '../../lib/money'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import { SkeletonRows } from '../../design/Skeletons'
import { downloadCsv, parseCsvObjects } from './lib/csv'
import { ensureRateList, saveMaster, useRateLists } from './lib/master'
import type { RateList } from './types'
import { FileButton, Spacer, Toolbar } from './ui'

interface Row {
  id: string
  kind: 'test' | 'package'
  code: string
  name: string
  mrp: number
}

// Grid of every test and package: MRP (catalogue price) and an editable list price.
// Blank price = not in the list (falls back to the next list / MRP). Saves entries in paise.
export function RateListEditor({ rateListId, onSaved }: { rateListId: string; onSaved?: () => void }) {
  const { tests, packages } = useCatalogueMaps()
  const lists = useRateLists()
  const list = lists.data.find((l) => l.id === rateListId)
  const [draft, setDraft] = useState<Record<string, number>>({})
  const [name, setName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [q, setQ] = useState('')
  const [view, setView] = useState<'all' | 'test' | 'package' | 'custom'>('all')
  const [sel, setSel] = useState<string[]>([])
  const [pct, setPct] = useState<number | null>(null)
  const [copyFrom, setCopyFrom] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const [parentId, setParentId] = useState<string>('')
  const [policy, setPolicy] = useState<'mrp' | 'block'>('mrp')

  useEffect(() => {
    if (list && !dirty) {
      setDraft(list.entries ?? {})
      setName(list.name)
      setParentId(list.parentId ?? '')
      setPolicy(list.missingPolicy ?? 'mrp')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.id, list?.entries, dirty])

  const rows: Row[] = useMemo(
    () => [
      ...tests.filter((t) => !t.disabled).map((t) => ({ id: t.id, kind: 'test' as const, code: t.code, name: t.name, mrp: t.price })),
      ...packages.filter((p) => !p.disabled).map((p) => ({ id: p.id, kind: 'package' as const, code: p.code, name: p.name, mrp: p.price })),
    ],
    [tests, packages],
  )
  const shown = rows.filter((r) => {
    if (view === 'test' && r.kind !== 'test') return false
    if (view === 'package' && r.kind !== 'package') return false
    if (view === 'custom' && draft[r.id] === undefined) return false
    const s = q.trim().toLowerCase()
    return !s || r.name.toLowerCase().includes(s) || r.code.toLowerCase().includes(s)
  })

  const setPrice = (id: string, paise: number | null) => {
    setDirty(true)
    setDraft((d) => {
      const n = { ...d }
      if (paise === null) delete n[id]
      else n[id] = paise
      return n
    })
  }
  const targets = sel.length ? rows.filter((r) => sel.includes(r.id)) : shown

  const applyPct = () => {
    if (pct === null) return
    setDirty(true)
    setDraft((d) => {
      const n = { ...d }
      for (const r of targets) n[r.id] = Math.max(0, Math.round((r.mrp * (100 + pct)) / 100))
      return n
    })
    message.success(`Applied ${pct}% to ${targets.length} item(s) from MRP`)
  }
  const copy = () => {
    const src = lists.data.find((l) => l.id === copyFrom)
    if (!src) return
    setDirty(true)
    setDraft({ ...draft, ...src.entries })
    message.success(`Copied ${Object.keys(src.entries ?? {}).length} prices from ${src.name}`)
  }
  const exportCsv = () =>
    downloadCsv(`rate-list-${name || 'prices'}`, [
      ['code', 'name', 'type', 'mrp', 'price'],
      ...rows.map((r) => [r.code, r.name, r.kind, (r.mrp / 100).toFixed(2), draft[r.id] === undefined ? '' : (draft[r.id] / 100).toFixed(2)]),
    ])
  const importCsv = (text: string) => {
    const byCode = new Map(rows.map((r) => [r.code.toLowerCase(), r]))
    const n = { ...draft }
    let hit = 0
    for (const o of parseCsvObjects(text)) {
      const r = byCode.get((o.code ?? '').toLowerCase())
      const v = parseFloat(o.price)
      if (r && Number.isFinite(v)) {
        n[r.id] = toPaise(v)
        hit++
      }
    }
    setDraft(n)
    setDirty(true)
    message.success(`Imported ${hit} price(s)`)
  }
  const save = async () => {
    setSaving(true)
    try {
      await saveMaster('rateLists', rateListId, { name, entries: draft, parentId, missingPolicy: policy })
      setDirty(false)
      message.success('Price list saved')
      onSaved?.()
    } catch (e) {
      message.error(`Could not save: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  if (lists.loading) return <SkeletonRows rows={8} columns={4} />
  if (!list) return <p className="pt-muted">This price list no longer exists.</p>

  return (
    <div className="pt-rl-grid">
      <Space wrap style={{ marginBottom: 'var(--s-3)' }}>
        <Input aria-label="Price list name" value={name} onChange={(e) => { setName(e.target.value); setDirty(true) }} style={{ width: 240 }} />
        <Segmented
          aria-label="Show"
          size="small"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: 'All' },
            { value: 'test', label: 'Tests' },
            { value: 'package', label: 'Packages' },
            { value: 'custom', label: 'Priced', count: Object.keys(draft).length },
          ]}
        />
      </Space>
      <Space wrap style={{ marginBottom: 'var(--s-3)' }}>
        <Select
          aria-label="Parent price list"
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Parent list (fallback)"
          style={{ width: 240 }}
          value={parentId || undefined}
          onChange={(v) => { setParentId(v ?? ''); setDirty(true) }}
          options={lists.data.filter((l) => l.id !== rateListId && l.active !== false).map((l) => ({ value: l.id, label: l.name }))}
        />
        <Select
          aria-label="When an item is not priced"
          style={{ width: 280 }}
          value={policy}
          onChange={(v) => { setPolicy(v); setDirty(true) }}
          options={[{ value: 'mrp', label: 'Not priced here or in the parent: bill at MRP' }, { value: 'block', label: 'Not priced here or in the parent: cannot be billed' }]}
        />
      </Space>
      <Toolbar>
        <Input.Search allowClear placeholder="Search code or name" aria-label="Search items" value={q} onChange={(e) => setQ(e.target.value)} className="pt-toolbar__grow" />
        <InputNumber aria-label="Percent change from MRP" placeholder="% vs MRP" value={pct} onChange={setPct} step={5} style={{ width: 120 }} />
        <Button onClick={applyPct} disabled={pct === null}>
          Apply to {sel.length ? 'selected' : 'shown'}
        </Button>
        <Select
          aria-label="Copy from list"
          placeholder="Copy from list"
          style={{ width: 190 }}
          value={copyFrom}
          onChange={setCopyFrom}
          options={lists.data.filter((l) => l.id !== rateListId).map((l) => ({ value: l.id, label: l.name }))}
        />
        <Button onClick={copy} disabled={!copyFrom}>Copy</Button>
        <Spacer />
        <Button icon={<DownloadOutlined />} onClick={exportCsv}>Export CSV</Button>
        <FileButton label="Import CSV" icon={<UploadOutlined />} onText={importCsv} />
        <Button variant="text" onClick={() => { setDraft({}); setDirty(true) }}>Clear all</Button>
      </Toolbar>
      <Table<Row>
        size="small"
        rowKey="id"
        dataSource={shown}
        rowSelection={{ selectedRowKeys: sel, onChange: (k) => setSel(k as string[]) }}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        columns={[
          { title: 'Code', dataIndex: 'code', width: 110 },
          { title: 'Name', dataIndex: 'name' },
          { title: 'Type', dataIndex: 'kind', width: 90, render: (k: string) => (k === 'test' ? 'Test' : 'Package') },
          { title: 'MRP', dataIndex: 'mrp', align: 'right', render: (v: number) => <span className="pt-num">{formatINR(v)}</span> },
          {
            title: 'List price (Rs)',
            width: 160,
            render: (_: unknown, r) => (
              <InputNumber
                aria-label={`List price for ${r.name}`}
                min={0}
                step={1}
                precision={2}
                value={draft[r.id] === undefined ? null : draft[r.id] / 100}
                onChange={(v) => setPrice(r.id, v === null ? null : toPaise(v))}
              />
            ),
          },
          {
            title: 'vs MRP',
            align: 'right',
            render: (_: unknown, r) =>
              draft[r.id] === undefined || !r.mrp ? '' : <span className="pt-num">{(((draft[r.id] - r.mrp) / r.mrp) * 100).toFixed(1)}%</span>,
          },
        ]}
      />
      <div className="pt-sticky-foot">
        <Button variant="primary" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving' : 'Save price list'}
        </Button>
      </div>
    </div>
  )
}

// Drawer that makes sure the owner has a list (creating and linking one) then edits it.
export function PriceListDrawer({
  open,
  onClose,
  owner,
}: {
  open: boolean
  onClose: () => void
  owner: { collection: string; id: string; name: string; rateListId?: string; kind: RateList['kind'] } | null
}) {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setId(null)
    if (open && owner) {
      if (owner.rateListId) setId(owner.rateListId)
      else ensureRateList(owner.collection, owner.id, owner.name, owner.kind).then((x) => live && setId(x))
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, owner?.id, owner?.rateListId])
  return (
    <Drawer open={open} onClose={onClose} size="large" title={owner ? `Price list: ${owner.name}` : 'Price list'} destroyOnHidden>
      {id ? <RateListEditor rateListId={id} /> : <SkeletonRows rows={8} columns={4} />}
    </Drawer>
  )
}

export default RateListEditor
