import { useState } from 'react'
import { Input, InputNumber } from 'antd'
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '../../../design/Button'
import { mean, linearRegression } from '../lib/stats'
import { parseRows, rowsToText } from '../lib/validation'
import type { ValidationType } from '../types'

interface Layout { heads: string[]; growable: boolean; first?: string; fixed: boolean }
const LAYOUT: Record<ValidationType, Layout> = {
  carryOver: { heads: ['H1', 'H2', 'H3', 'L1', 'L2', 'L3'], growable: false, fixed: true },
  linearity: { heads: ['Expected', 'Rep 1', 'Rep 2', 'Rep 3'], growable: true, fixed: false },
  intraAssay: { heads: ['Replicate value'], growable: false, fixed: true },
  interAssay: { heads: ['Rep 1', 'Rep 2', 'Rep 3'], growable: true, fixed: false, first: 'Day' },
  interEquipment: { heads: ['Machine A', 'Machine B'], growable: false, fixed: true },
  accuracy: { heads: ['Assigned', 'Rep 1', 'Rep 2', 'Rep 3'], growable: true, fixed: false },
  referenceInterval: { heads: ['Result'], growable: false, fixed: true },
}

// Grid entry for a validation study. The value is the same text the study stores (one row per line,
// numbers separated by spaces), so existing studies and pasted data keep working.
export function StructuredRows({ type, value, onChange, disabled }: { type: ValidationType; value?: string; onChange?: (v: string) => void; disabled?: boolean }) {
  const lay = LAYOUT[type]
  const [paste, setPaste] = useState(false)
  const rows = (value ?? '').split('\n').filter((l) => l.trim() !== '').map((l) => l.split(/[\s,;]+/).filter(Boolean))
  const width = Math.max(lay.heads.length, ...rows.map((r) => r.length))
  const heads = Array.from({ length: width }, (_, i) => lay.heads[i] ?? `Rep ${i}`)
  const commit = (next: string[][]) => onChange?.(next.map((r) => r.join(' ')).join('\n'))
  const setCell = (ri: number, ci: number, v: number | null) => {
    const next = rows.map((r) => [...r])
    while (next[ri].length <= ci) next[ri].push('')
    next[ri][ci] = v == null ? '' : String(v)
    commit(next)
  }
  const blank = () => Array.from({ length: width }, () => '')
  return (
    <div>
      {paste ? (
        <Input.TextArea rows={6} style={{ fontFamily: 'monospace' }} value={value} disabled={disabled} onChange={(e) => onChange?.(e.target.value)} aria-label="Paste study data" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ padding: 4, textAlign: 'left' }}>#</th>
                {heads.map((h, i) => <th key={i} style={{ padding: 4, textAlign: 'left' }}>{h}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  <td style={{ padding: 4 }}>{ri + 1}</td>
                  {heads.map((h, ci) => (
                    <td key={ci} style={{ padding: 2 }}>
                      <InputNumber size="small" style={{ width: 92 }} disabled={disabled} aria-label={`${h} row ${ri + 1}`} value={r[ci] === undefined || r[ci] === '' ? null : Number(r[ci])} onChange={(v) => setCell(ri, ci, v)} />
                    </td>
                  ))}
                  <td><Button disabled={disabled} aria-label={`Remove row ${ri + 1}`} onClick={() => commit(rows.filter((_, j) => j !== ri))}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!paste && <Button disabled={disabled} onClick={() => commit([...rows, blank()])}>Add row</Button>}
        {!paste && lay.growable && <Button disabled={disabled || !rows.length} onClick={() => commit(rows.map((r) => [...r, ...Array(Math.max(0, width + 1 - r.length)).fill('')]))}>Add replicate column</Button>}
        <Button onClick={() => setPaste(!paste)}>{paste ? 'Back to grid' : 'Paste from a sheet'}</Button>
      </div>
    </div>
  )
}

// Linearity: expected vs measured mean with the fitted line, plus recovery per level.
export function LinearityChart({ rows }: { rows: number[][] }) {
  const lv = rows.filter((r) => r.length >= 2)
  if (lv.length < 2) return null
  const x = lv.map((r) => r[0])
  const y = lv.map((r) => mean(r.slice(1)))
  const reg = linearRegression(x, y)
  const lo = Math.min(...x)
  const hi = Math.max(...x)
  const data = lv.map((_, i) => ({ x: x[i], measured: y[i], fit: reg.intercept + reg.slope * x[i], ideal: x[i], recovery: x[i] ? Math.round((y[i] / x[i]) * 1000) / 10 : null }))
  return (
    <div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
          <CartesianGrid strokeDasharray="2 4" />
          <XAxis dataKey="x" type="number" domain={[lo, hi]} label={{ value: 'Expected', position: 'insideBottom', offset: -4, fontSize: 11 }} />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line name="Ideal (y = x)" dataKey="ideal" stroke="var(--c-outline)" strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          <Line name="Fitted line" dataKey="fit" stroke="var(--c-primary)" dot={false} isAnimationActive={false} />
          <Scatter name="Measured mean" dataKey="measured" fill="var(--c-accent)" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <table style={{ fontSize: 12, marginTop: 4 }}>
        <thead><tr><th style={{ paddingRight: 12, textAlign: 'left' }}>Expected</th><th style={{ paddingRight: 12, textAlign: 'left' }}>Measured mean</th><th style={{ textAlign: 'left' }}>Recovery %</th></tr></thead>
        <tbody>{data.map((d, i) => <tr key={i}><td>{d.x}</td><td>{d.measured.toFixed(2)}</td><td>{d.recovery ?? '-'}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

export { parseRows, rowsToText }
