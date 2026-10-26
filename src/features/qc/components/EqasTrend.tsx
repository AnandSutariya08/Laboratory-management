import { useMemo, useState } from 'react'
import { Select } from 'antd'
import dayjs from 'dayjs'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { EqasRound } from '../types'
import { Panel } from '../ui'
import type { EqasLimits } from './EqasSection'

// EQAS trend: SDI (or % deviation when the lab judges by percent) per round for one parameter.
export default function EqasTrend({ rounds, limits }: { rounds: EqasRound[]; limits: EqasLimits }) {
  const opts = useMemo(() => {
    const m = new Map<string, string>()
    rounds.forEach((r) => m.set(`${r.testId}|${r.paramKey}`, `${r.testName} / ${r.paramName}`))
    return [...m].map(([value, label]) => ({ value, label }))
  }, [rounds])
  const [pick, setPick] = useState<string>()
  const key = pick ?? opts[0]?.value
  const pct = limits.mode === 'percent'
  const data = rounds
    .filter((r) => `${r.testId}|${r.paramKey}` === key)
    .map((r) => ({ at: (r.date?.toMillis?.() ?? 0), label: `${dayjs(r.date?.toMillis?.() ?? 0).format('DD MMM YY')} ${r.round}`, v: pct ? r.devPct : r.sdi }))
    .filter((d) => d.v != null)
    .sort((a, b) => a.at - b.at)
  if (!opts.length) return null
  const warn = pct ? (limits.pct ?? 10) : (limits.warn ?? 2)
  const fail = pct ? (limits.pct ?? 10) * 1.5 : (limits.fail ?? 3)
  return (
    <Panel title={pct ? 'EQAS trend: % deviation' : 'EQAS trend: SDI'} extra={<Select showSearch optionFilterProp="label" style={{ width: 260 }} value={key} onChange={setPick} options={opts} aria-label="Trend parameter" />} style={{ marginBottom: 'var(--s-4)' }}>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 10, right: 40, left: 0, bottom: 10 }}>
          <CartesianGrid strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" fontSize={11} />
          <YAxis domain={[-(fail + 1), fail + 1]} />
          <Tooltip formatter={(v) => [Number(v).toFixed(2), pct ? 'Deviation %' : 'SDI']} />
          {[0, warn, -warn, fail, -fail].map((y) => (
            <ReferenceLine key={y} y={y} stroke={y === 0 ? 'var(--c-primary)' : Math.abs(y) === warn ? 'var(--c-caution)' : 'var(--c-urgent)'} strokeDasharray={y === 0 ? undefined : '4 3'} />
          ))}
          <Line dataKey="v" stroke="var(--c-accent)" strokeWidth={1.5} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </Panel>
  )
}
