import { useEffect, useMemo, useState } from 'react'
import { App, InputNumber, Modal, Radio, Select, Table } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import { addDoc, deleteField, FieldPath, orderBy, query, serverTimestamp, updateDoc, limit } from 'firebase/firestore'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { useAuth } from '../../auth/AuthProvider'
import { useRateLists } from '../../features/partners/lib/master'
import { auditBulkPriceChange } from '../../features/settings/audit'
import { col, docRef, paths } from '../../lib/db'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { dialogWidth } from '../../design/dialog'
import { downloadText } from './helpers'
import { CsvUpload, commitBatch, csvLine, headerIndex, mergeOp } from './shared'

// Mass price wizard (CAT-08): rule (percent / amount / absolute), rounding (none, 1, 5, 10 rupees), department scope,
// target (test MRP or one rate list), CSV price sheet, preview, a recorded batch and a 24 hour revert.

type Rule = 'percent' | 'flat' | 'absolute'
type Rounding = 0 | 1 | 5 | 10
interface Change { id: string; code: string; name: string; from: number | null; to: number }
interface Batch {
  id: string
  at?: { toMillis: () => number }
  byName: string
  target: string // 'mrp' or a rate list id
  targetName: string
  summary: string
  changes: { id: string; from: number | null; to: number }[]
  revertedAt?: unknown
}
const REVERT_MS = 24 * 3600 * 1000
const MAX_CHANGES = 8000

export const roundPrice = (paise: number, step: Rounding): number => {
  const v = Math.max(0, paise)
  return step === 0 ? Math.round(v) : Math.round(v / (step * 100)) * step * 100
}

export function MassPriceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message, modal } = App.useApp()
  const { profile } = useAuth()
  const { tests, departments } = useCatalogueMaps()
  const lists = useRateLists().data
  const batches = useLiveQuery<Batch>(query(col('priceBatches'), orderBy('at', 'desc'), limit(8)), []).data
  const [rule, setRule] = useState<Rule>('percent')
  const [amount, setAmount] = useState<number>(0)
  const [dept, setDept] = useState<string | undefined>()
  const [round, setRound] = useState<Rounding>(1)
  const [target, setTarget] = useState<string>('mrp')
  const [sheet, setSheet] = useState<Map<string, number> | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setSheet(null); setAmount(0) } }, [open])

  const list = target === 'mrp' ? null : lists.find((l) => l.id === target)
  const baseOf = (id: string, mrp: number): number | null => (list ? (list.entries?.[id] ?? null) : mrp)

  const preview = useMemo(() => {
    const out: Change[] = []
    for (const t of tests) {
      if ((t as { deleted?: boolean }).deleted) continue
      const cur = baseOf(t.id, t.price)
      if (sheet) {
        const p = sheet.get(t.id)
        if (p !== undefined && p !== cur) out.push({ id: t.id, code: t.code, name: t.name, from: cur, to: p })
        continue
      }
      if (dept && t.departmentId !== dept) continue
      // A rate list that does not price the test yet starts from the MRP for percent / amount rules.
      const base = cur ?? t.price
      const raw = rule === 'absolute' ? toPaise(amount) : rule === 'percent' ? base * (1 + amount / 100) : base + toPaise(amount)
      const next = roundPrice(raw, round)
      if (next !== cur) out.push({ id: t.id, code: t.code, name: t.name, from: cur, to: next })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tests, sheet, dept, rule, amount, round, target, lists])

  const apply = async () => {
    if (preview.length > MAX_CHANGES) return message.error(`Too many changes at once (limit ${MAX_CHANGES}). Narrow by department.`)
    setBusy(true)
    try {
      const summary = sheet ? 'price sheet' : `${rule === 'percent' ? `${amount}%` : rule === 'flat' ? `${amount >= 0 ? '+' : ''}${amount} rupees` : `set to ${amount} rupees`}, round ${round || 'none'}${dept ? `, ${departments.find((d) => d.id === dept)?.name}` : ''}`
      const ref = await addDoc(col('priceBatches'), {
        at: serverTimestamp(), by: profile?.uid ?? '', byName: profile?.name ?? '', target, targetName: list?.name ?? 'Test MRP', summary,
        changes: preview.map((c) => ({ id: c.id, from: c.from, to: c.to })),
      })
      if (list) {
        await commitBatch(preview.map((c) => (b) => b.set(docRef('rateLists', list.id), { entries: { [c.id]: c.to } }, { merge: true })))
      } else {
        await commitBatch(preview.map((r) => mergeOp(docRef(paths.tests, r.id), { price: r.to })))
      }
      void auditBulkPriceChange(`${list?.name ?? 'Test MRP'}: ${summary}`, preview.length, ref.id)
      message.success(`Updated ${preview.length} price(s). You can revert this for 24 hours.`)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const revert = (b: Batch) =>
    modal.confirm({
      title: 'Revert this price update?',
      content: `Restores ${b.changes.length} price(s) changed by ${b.byName}. A price edited again since then is left alone.`,
      okText: 'Revert',
      onOk: async () => {
        try {
          const isMrp = b.target === 'mrp'
          const skipped: string[] = []
          const rl = isMrp ? null : lists.find((l) => l.id === b.target)
          if (!isMrp && !rl) throw new Error('That rate list no longer exists')
          for (const c of b.changes) {
            const cur = isMrp ? tests.find((t) => t.id === c.id)?.price : rl!.entries?.[c.id]
            if (cur !== c.to) { skipped.push(c.id); continue }
            if (isMrp) await updateDoc(docRef(paths.tests, c.id), { price: c.from ?? c.to })
            else await updateDoc(docRef('rateLists', rl!.id), new FieldPath('entries', c.id), c.from === null ? deleteField() : c.from)
          }
          await updateDoc(docRef('priceBatches', b.id), { revertedAt: serverTimestamp() })
          void auditBulkPriceChange(`REVERT ${b.targetName}: ${b.summary}`, b.changes.length - skipped.length, b.id)
          message.success(`Reverted ${b.changes.length - skipped.length} price(s)${skipped.length ? `, ${skipped.length} changed since and were kept` : ''}`)
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })

  const download = () =>
    downloadText('test-prices.csv', [csvLine(['test_code', 'test_name', 'price']), ...tests.map((t) => csvLine([t.code, t.name, toRupees(baseOf(t.id, t.price) ?? t.price)]))].join('\n'))
  const upload = (rows: string[][]) => {
    const idx = headerIndex(rows[0] ?? [])
    if (idx('test_code') < 0 || idx('price') < 0) return message.error('Needs columns test_code and price')
    const byCode = new Map(tests.map((t) => [t.code.toUpperCase(), t.id]))
    const m = new Map<string, number>()
    for (const r of rows.slice(1)) {
      const id = byCode.get((r[idx('test_code')] ?? '').trim().toUpperCase())
      const n = Number(r[idx('price')])
      if (id && Number.isFinite(n) && n >= 0) m.set(id, toPaise(n))
    }
    setSheet(m)
  }

  const now = Date.now()
  return (
    <Modal title="Mass update price" open={open} onCancel={onClose} onOk={apply} okText={`Apply to ${preview.length} test(s)`} okButtonProps={{ disabled: preview.length === 0 }} confirmLoading={busy} width={dialogWidth(780)} destroyOnHidden>
      <div className="cat-toolbar">
        <Select aria-label="Price target" style={{ width: 220 }} value={target} onChange={setTarget}
          options={[{ value: 'mrp', label: 'Test price (MRP)' }, ...lists.filter((l) => l.active !== false).map((l) => ({ value: l.id, label: `Rate list: ${l.name}` }))]} />
        <Select aria-label="Department" allowClear disabled={!!sheet} placeholder="All departments" style={{ width: 200 }} value={dept} onChange={setDept} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
      </div>
      <div className="cat-toolbar">
        <Radio.Group disabled={!!sheet} value={rule} onChange={(e) => setRule(e.target.value)} optionType="button"
          options={[{ value: 'percent', label: 'By percent' }, { value: 'flat', label: 'By amount (₹)' }, { value: 'absolute', label: 'Set to amount (₹)' }]} />
        <InputNumber aria-label="Change value (negative to reduce)" disabled={!!sheet} value={amount} onChange={(v) => setAmount(v ?? 0)} suffix={rule === 'percent' ? '%' : '₹'} />
        <Select aria-label="Rounding" disabled={!!sheet} style={{ width: 170 }} value={round} onChange={setRound}
          options={[{ value: 0, label: 'No rounding' }, { value: 1, label: 'Round to ₹1' }, { value: 5, label: 'Round to ₹5' }, { value: 10, label: 'Round to ₹10' }]} />
      </div>
      <div className="cat-toolbar">
        <Button icon={<DownloadOutlined />} onClick={download}>Download price sheet</Button>
        <CsvUpload onRows={upload}>Upload price sheet</CsvUpload>
        {sheet && <Button variant="text" onClick={() => setSheet(null)}>Clear sheet</Button>}
      </div>
      <Table
        size="small" rowKey="id" dataSource={preview} pagination={{ pageSize: 8, showSizeChanger: false }}
        locale={{ emptyText: 'No price would change. Enter a change or upload a sheet.' }}
        columns={[
          { title: 'Test', render: (_, r) => <span>{r.name} <span className="cat-code">{r.code}</span></span> },
          { title: 'Current', width: 110, render: (_, r) => (r.from === null ? 'not priced' : formatINR(r.from)) },
          { title: 'New', width: 110, render: (_, r) => formatINR(r.to) },
          { title: 'Change', width: 110, render: (_, r) => (r.from === null ? '' : <span className={r.to > r.from ? 'cat-diff-up' : 'cat-diff-down'}>{r.to > r.from ? '+' : '-'}{formatINR(Math.abs(r.to - r.from))}</span>) },
        ]}
      />
      <h3 className="cat-section-title" style={{ marginTop: 16 }}>Recent updates</h3>
      <Table
        size="small" rowKey="id" dataSource={batches} pagination={false} locale={{ emptyText: 'No updates yet' }}
        columns={[
          { title: 'When', width: 150, render: (_, b) => (b.at ? new Date(b.at.toMillis()).toLocaleString() : '') },
          { title: 'Update', render: (_, b) => <span>{b.targetName}: {b.summary} <span className="cat-muted">({b.changes.length}, {b.byName})</span></span> },
          {
            title: '', width: 120,
            render: (_, b) => {
              if (b.revertedAt) return <StatusChip>Reverted</StatusChip>
              const fresh = b.at ? now - b.at.toMillis() < REVERT_MS : true
              return fresh ? <Button variant="text" onClick={() => revert(b)}>Revert</Button> : <span className="cat-muted">Revert window over</span>
            },
          },
        ]}
      />
    </Modal>
  )
}
