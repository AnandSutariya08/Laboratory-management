import { useEffect, useMemo, useState } from 'react'
import { formulaDecimals } from '../../features/settings/lib'
import { withRangeSnapshot } from '../../pages/catalogue/behaviour'
import { App, Input, Modal, Select, Table } from 'antd'
import { serverTimestamp } from 'firebase/firestore'
import { applyFormulas, ageDaysAtCollection, flagValue } from '../../lib/results'
import { useLabSettings } from '../../hooks/useCatalogue'
import { dialogWidth } from '../../design/dialog'
import type { Parameter, Test } from '../../types'
import { FlagMark } from './TestCard'
import { addVersion, cleanValues, loadResults, syncItems, writeResult } from './resultOps'
import type { OrderExt, ResultExt, Values } from './types'

export interface BatchRow {
  order: OrderExt
  lineId: string
}

const SIMPLE = (p: Parameter) => p.structure !== 'group' && !p.formula && ['numeric', 'numericUnbound', 'options', 'text'].includes(p.dataType)

// Test-wise batch entry: one test, many patients, one row per bill. Enter moves down the same column so a
// whole run from the analyser sheet can be typed in a pass. Saving writes drafts (nothing is approved here).
export default function BatchEntryModal({
  open,
  tests,
  rowsFor,
  who,
  onClose,
  onSaved,
}: {
  open: boolean
  tests: Test[]
  rowsFor: (testId: string) => BatchRow[]
  who: { uid: string; name: string }
  onClose: () => void
  onSaved: () => void
}) {
  const { message } = App.useApp()
  const settings = useLabSettings()
  const [testId, setTestId] = useState<string>()
  const [vals, setVals] = useState<Record<string, Record<string, string>>>({})
  const [existing, setExisting] = useState<Record<string, ResultExt | undefined>>({})
  const [busy, setBusy] = useState(false)
  const test = tests.find((t) => t.id === testId)
  const rows = useMemo(() => (testId ? rowsFor(testId) : []), [testId, rowsFor])
  const params = (test?.parameters ?? []).filter(SIMPLE).slice(0, 8)

  useEffect(() => {
    if (open) {
      setVals({})
      setTestId((c) => c ?? tests[0]?.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open || !testId) return
    let cancelled = false
    ;(async () => {
      const out: Record<string, ResultExt | undefined> = {}
      for (const r of rows) out[r.order.id] = (await loadResults(r.order.id)).find((x) => x.testId === testId)
      if (!cancelled) setExisting(out)
    })().catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, testId, rows.map((r) => r.order.id).join('|')])

  const typed = (orderId: string, p: Parameter) => vals[orderId]?.[p.key] ?? existing[orderId]?.values?.[p.key]?.value ?? ''
  const set = (orderId: string, key: string, v: string) => setVals((m) => ({ ...m, [orderId]: { ...(m[orderId] ?? {}), [key]: v } }))

  const moveDown = (e: React.KeyboardEvent<HTMLInputElement>, key: string) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const col = Array.from(document.querySelectorAll<HTMLInputElement>(`.re-batch input[data-col="${key}"]`))
    const i = col.indexOf(e.currentTarget)
    col[Math.min(col.length - 1, Math.max(0, i + (e.shiftKey ? -1 : 1)))]?.focus()
  }

  const save = async () => {
    if (!test) return
    setBusy(true)
    let n = 0
    try {
      for (const row of rows) {
        const o = row.order
        const r = existing[o.id]
        if (r?.status === 'approved' || r?.status === 'rejected') continue
        const entered = vals[o.id]
        if (!entered || !Object.values(entered).some((v) => v.trim())) continue
        const age = ageDaysAtCollection(o)
        let values: Values = { ...(r?.values ?? {}) }
        for (const p of params) {
          const raw = entered[p.key]
          if (raw === undefined) continue
          values[p.key] = { value: raw, overridden: false, ...(values[p.key]?.rangeOverride ? { rangeOverride: values[p.key].rangeOverride } : {}), ...flagValue(p, raw, age, o.gender, o.patientCondition, values[p.key]?.rangeOverride) }
        }
        values = cleanValues(applyFormulas(test.parameters, values, age, o.gender, { condition: o.patientCondition, decimals: formulaDecimals(settings) }))
        for (const p of test.parameters) if (values[p.key]) values[p.key] = withRangeSnapshot(p, values[p.key], age, o.gender, o.patientCondition)
        const status = r?.status === 'hold' ? 'hold' : r?.status === 'entered' ? 'entered' : 'pending'
        await writeResult(o.id, test.id, {
          ...(r ? {} : { id: test.id, orderId: o.id, testId: test.id, testName: test.name, comment: '', approvedBy: '', approvedByName: '' }),
          values: JSON.parse(JSON.stringify(values)),
          status,
          enteredBy: who.uid,
          draft: null,
          updatedAt: serverTimestamp(),
        })
        await addVersion(o.id, test.id, 'saved', values, who)
        await syncItems(o, (t) => (t === test.id ? status : undefined))
        n++
      }
      message.success(n ? `Saved results for ${n} patient${n === 1 ? '' : 's'}` : 'Nothing to save')
      if (n) {
        setVals({})
        onSaved()
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="Batch entry: one test across patients"
      width={dialogWidth(1100)}
      okText="Save all"
      okButtonProps={{ loading: busy, disabled: !test }}
      onOk={save}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="re-field">
        <label htmlFor="batch-test">Test</label>
        <Select id="batch-test" showSearch optionFilterProp="label" style={{ maxWidth: 360 }} value={testId} onChange={(v) => { setTestId(v); setVals({}) }} options={tests.map((t) => ({ value: t.id, label: t.name }))} />
      </div>
      {test && (test.parameters.filter(SIMPLE).length > 8 || test.parameters.some((p) => p.formula)) && (
        <p className="wl-muted">Showing the first 8 typed parameters. Calculated and rich-text parameters are filled in the full result entry screen.</p>
      )}
      <Table<BatchRow>
        className="re-batch"
        size="small"
        rowKey={(r) => r.order.id}
        pagination={false}
        scroll={{ x: 'max-content', y: 420 }}
        dataSource={rows}
        locale={{ emptyText: 'No patient is waiting for this test.' }}
        columns={[
          { title: 'Bill', width: 100, render: (_v, r) => r.order.billNo },
          { title: 'Patient', render: (_v, r) => `${r.order.patientName} (${r.order.ageValue}${r.order.ageUnit[0]} ${r.order.gender[0]?.toUpperCase() ?? ''})` },
          ...params.map((p) => ({
            title: `${p.name}${p.unit ? ` (${p.unit})` : ''}`,
            width: 150,
            render: (_v: unknown, r: BatchRow) => {
              const raw = typed(r.order.id, p)
              const locked = existing[r.order.id]?.status === 'approved' || existing[r.order.id]?.status === 'rejected'
              const f = raw ? flagValue(p, raw, ageDaysAtCollection(r.order), r.order.gender, r.order.patientCondition) : undefined
              return (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Input data-col={p.key} aria-label={`${p.name} for ${r.order.patientName}`} style={{ width: 100 }} disabled={locked} value={raw} onChange={(e) => set(r.order.id, p.key, e.target.value)} onKeyDown={(e) => moveDown(e, p.key)} />
                  {f && <FlagMark v={{ value: raw, overridden: false, ...f }} />}
                </span>
              )
            },
          })),
          { title: 'Status', width: 110, render: (_v, r) => existing[r.order.id]?.status ?? 'pending' },
        ]}
      />
    </Modal>
  )
}
