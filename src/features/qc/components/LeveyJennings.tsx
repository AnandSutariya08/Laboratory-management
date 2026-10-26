import type React from 'react'
import { useRef, useState } from 'react'
import { Segmented } from '../../../design/Segmented'
import { Button } from '../../../design/Button'
import { exportChart } from '../lib/chartExport'
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import dayjs from 'dayjs'
import type { QcStatus } from '../types'

export interface LjPoint {
  at: number
  value: number
  z: number
  status: QcStatus
  by: string
  rules?: string[] // Westgard rules that fired for this point
}

const DOT: Record<QcStatus, string> = { pass: 'var(--c-success)', warning: 'var(--c-caution)', fail: 'var(--c-urgent)' }

interface DotProps {
  cx?: number
  cy?: number
  payload?: LjPoint
}

// Levey-Jennings chart: measured values against mean and +/-1, 2, 3 SD limits.
export default function LeveyJennings({ points, mean, sd }: { points: LjPoint[]; mean: number; sd: number }) {
  const data = points.map((p, i) => ({ ...p, n: i + 1, label: dayjs(p.at).format('DD MMM HH:mm') }))
  const vals = data.map((d) => d.value)
  const lo = Math.min(mean - 3.5 * sd, ...vals)
  const hi = Math.max(mean + 3.5 * sd, ...vals)
  const lines = [
    { y: mean, color: 'var(--c-primary)', dash: undefined, label: 'mean' },
    ...[1, 2, 3].flatMap((k) => {
      const color = k === 1 ? 'var(--c-outline)' : k === 2 ? 'var(--c-caution)' : 'var(--c-urgent)'
      return [
        { y: mean + k * sd, color, dash: '4 3', label: `+${k}SD` },
        { y: mean - k * sd, color, dash: '4 3', label: `-${k}SD` },
      ]
    }),
  ]
  return (
    <ResponsiveContainer width="100%" height={340}>
      <LineChart data={data} margin={{ top: 10, right: 40, left: 0, bottom: 10 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="n" tickFormatter={(n) => `#${n}`} />
        <YAxis domain={[lo, hi]} tickFormatter={(v: number) => String(Number(v.toFixed(2)))} />
        <Tooltip
          formatter={(v) => [String(v), 'Value']}
          labelFormatter={(_, p) => {
            const d = p?.[0]?.payload as (LjPoint & { label: string }) | undefined
            return d ? `${d.label} | z ${d.z.toFixed(2)} | ${d.by}` : ''
          }}
        />
        {lines.map((l) => (
          <ReferenceLine key={l.label} y={l.y} stroke={l.color} strokeDasharray={l.dash} label={{ value: l.label, position: 'right', fontSize: 10, fill: l.color }} />
        ))}
        <Line
          dataKey="value"
          stroke="var(--c-accent)"
          strokeWidth={1.5}
          isAnimationActive={false}
          dot={(p: DotProps & { key?: React.Key | null }) =>
            p.cx == null || p.cy == null || !p.payload ? <g key={p.key ?? undefined} /> : <circle key={p.key ?? undefined} cx={p.cx} cy={p.cy} r={5} fill={DOT[p.payload.status]} stroke="var(--c-surface-container-high)" strokeWidth={1} />
          }
        />
      </LineChart>
    </ResponsiveContainer>
  )
}


export interface LevelSeries {
  level: string
  mean: number
  sd: number
  points: LjPoint[]
}
const LEVEL_COLOR: Record<string, string> = { L1: 'var(--c-primary)', L2: 'var(--c-accent)', L3: 'var(--c-caution)' }

interface Row {
  at: number
  n: number
  label: string
  [k: string]: number | string | LjPoint | undefined
}

// Several control levels on one chart in z-score units (so levels with different means share an axis).
// The tooltip lists value, z and the Westgard rules that fired for each level. `mode` 'lj' adds a
// right-hand axis in the first level's units; 'z' adds a date window and PNG / PDF export.
export function MultiLevelChart({ series, mode, title }: { series: LevelSeries[]; mode: 'lj' | 'z'; title: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState<'7' | '14' | '30' | '90' | 'all'>('30')
  const cutoff = mode === 'z' && win !== 'all' ? Date.now() - Number(win) * 86_400_000 : 0
  const byAt = new Map<number, Row>()
  for (const s of series)
    for (const p of s.points) {
      if (p.at < cutoff) continue
      const r = byAt.get(p.at) ?? { at: p.at, n: 0, label: dayjs(p.at).format('DD MMM HH:mm') }
      r[s.level] = Math.round(p.z * 100) / 100
      r[`${s.level}:p`] = p
      byAt.set(p.at, r)
    }
  const data = [...byAt.values()].sort((a, b) => a.at - b.at).map((r, i): Row => ({ ...r, n: i + 1 }))
  const first = series[0]
  const zs = data.flatMap((d) => series.map((s) => d[s.level]).filter((x): x is number => typeof x === 'number'))
  const lim = Math.max(3.5, ...zs.map((z) => Math.abs(z) + 0.2))
  return (
    <div>
      {mode === 'z' && (
        <div className="qc-toolbar">
          <Segmented aria-label="Z-score date window" size="small" value={win} onChange={setWin} options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'all', label: 'All' }]} />
          <span className="qc-toolbar__spacer" />
          <Button onClick={() => exportChart(host.current, title, 'png')}>PNG</Button>
          <Button onClick={() => exportChart(host.current, title, 'pdf')}>PDF (print)</Button>
        </div>
      )}
      <div ref={host}>
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={data} margin={{ top: 10, right: 50, left: 0, bottom: 10 }}>
            <CartesianGrid strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="n" tickFormatter={(n) => `#${n}`} />
            <YAxis yAxisId="z" domain={[-lim, lim]} tickFormatter={(v: number) => (v > 0 ? `+${v}` : String(v))} label={{ value: 'z (SD)', angle: -90, position: 'insideLeft', fontSize: 10 }} />
            {mode === 'lj' && first && (
              <YAxis yAxisId="v" orientation="right" domain={[-lim, lim]} tickFormatter={(z: number) => String(Number((first.mean + z * first.sd).toFixed(2)))} label={{ value: first.level, angle: 90, position: 'insideRight', fontSize: 10 }} />
            )}
            <Legend />
            <Tooltip
              content={({ payload }) => {
                const row = payload?.[0]?.payload as Row | undefined
                if (!row) return null
                return (
                  <div style={{ background: 'var(--c-surface-container-high)', border: '1px solid var(--c-outline)', padding: 8, fontSize: 12, borderRadius: 6 }}>
                    <strong>{row.label}</strong>
                    {series.map((s) => {
                      const p = row[`${s.level}:p`] as LjPoint | undefined
                      return p ? (
                        <div key={s.level}>
                          {s.level}: {p.value} (z {p.z.toFixed(2)}) {p.rules?.length ? `| rules: ${p.rules.join(', ')}` : '| no rule'} | {p.by}
                        </div>
                      ) : null
                    })}
                  </div>
                )
              }}
            />
            {[0, 1, -1, 2, -2, 3, -3].map((k) => (
              <ReferenceLine key={k} yAxisId="z" y={k} stroke={k === 0 ? 'var(--c-primary)' : Math.abs(k) === 1 ? 'var(--c-outline)' : Math.abs(k) === 2 ? 'var(--c-caution)' : 'var(--c-urgent)'} strokeDasharray={k === 0 ? undefined : '4 3'} label={{ value: k === 0 ? 'mean' : `${k > 0 ? '+' : ''}${k}SD`, position: 'right', fontSize: 10 }} />
            ))}
            {series.map((s) => (
              <Line
                key={s.level}
                yAxisId="z"
                name={s.level}
                dataKey={s.level}
                connectNulls
                stroke={LEVEL_COLOR[s.level] ?? 'var(--c-accent)'}
                strokeWidth={1.5}
                isAnimationActive={false}
                dot={(p: DotProps & { key?: React.Key | null; payload?: Row }) => {
                  const pt = p.payload?.[`${s.level}:p`] as LjPoint | undefined
                  return p.cx == null || p.cy == null || !pt ? <g key={p.key ?? undefined} /> : <circle key={p.key ?? undefined} cx={p.cx} cy={p.cy} r={4.5} fill={DOT[pt.status]} stroke={LEVEL_COLOR[s.level] ?? 'var(--c-accent)'} strokeWidth={1.5} />
                }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
