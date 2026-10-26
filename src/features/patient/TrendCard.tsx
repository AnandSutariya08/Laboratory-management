import { useEffect, useMemo, useState } from 'react'
import { Select, Table } from 'antd'
import { getDocs } from 'firebase/firestore'
import dayjs from 'dayjs'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { resultsCol } from '../../lib/db'
import { tsDate } from '../../components/billing/helpers'
import { parseNumeric } from '../../lib/results'
import type { TestResult } from '../../types'
import type { PatientOrder } from './types'

interface Pt { date: Date; value: string; num: number | null; flag: string | null; billNo: string }

export default function TrendCard({ orders }: { orders: PatientOrder[] }) {
  const { testById } = useCatalogueMaps()
  const [results, setResults] = useState<{ order: PatientOrder; r: TestResult }[]>([])
  const [sel, setSel] = useState<string>()
  const key = orders.map((o) => o.id).join(',')

  useEffect(() => {
    let dead = false
    Promise.all(
      orders.map(async (o) => {
        try {
          const s = await getDocs(resultsCol(o.id))
          return s.docs.map((d) => ({ order: o, r: d.data() as TestResult })).filter((x) => x.r.status === 'approved' || x.r.status === 'entered')
        } catch {
          return []
        }
      }),
    ).then((all) => !dead && setResults(all.flat()))
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const series = useMemo(() => {
    const m = new Map<string, { label: string; testId: string; pkey: string; unit: string; pts: Pt[] }>()
    for (const { order, r } of results) {
      const t = testById.get(r.testId)
      for (const [pkey, v] of Object.entries(r.values ?? {})) {
        if (!v.value) continue
        const p = t?.parameters.find((x) => x.key === pkey)
        const id = `${r.testId}|${pkey}`
        const e = m.get(id) ?? { label: `${p?.name ?? pkey} (${r.testName})`, testId: r.testId, pkey, unit: p?.unit ?? '', pts: [] }
        e.pts.push({ date: tsDate(order.createdAt) ?? new Date(), value: v.value, num: parseNumeric(v.value), flag: v.abnormal, billNo: order.billNo })
        m.set(id, e)
      }
    }
    m.forEach((e) => e.pts.sort((a, b) => a.date.getTime() - b.date.getTime()))
    return [...m.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))
  }, [results, testById])

  const cur = series.find(([k]) => k === (sel ?? series[0]?.[0]))
  const param = cur && testById.get(cur[1].testId)?.parameters.find((p) => p.key === cur[1].pkey)
  const data = cur?.[1].pts.filter((p) => p.num !== null).map((p) => ({ d: dayjs(p.date).format('DD MMM YY'), v: p.num })) ?? []

  return (
    <Card padding="var(--s-5)">
      <h2 className="pl-card-title">
        Result trends
        {series.length > 0 && (
          <Select showSearch optionFilterProp="label" style={{ minWidth: 280 }} aria-label="Parameter" value={cur?.[0]} onChange={setSel} options={series.map(([k, s]) => ({ value: k, label: s.label }))} />
        )}
      </h2>
      {!cur ? (
        <EmptyState title="No results yet" description="Entered or approved results appear here per parameter." />
      ) : (
        <>
          {data.length > 1 && (
            <div style={{ height: 240 }} role="img" aria-label={`Trend of ${cur[1].label}`}>
              <ResponsiveContainer>
                <LineChart data={data}>
                  <CartesianGrid stroke="var(--c-outline-variant)" strokeDasharray="3 3" />
                  <XAxis dataKey="d" stroke="var(--c-on-surface-variant)" fontSize={12} />
                  <YAxis stroke="var(--c-on-surface-variant)" fontSize={12} domain={['auto', 'auto']} />
                  <Tooltip />
                  {param?.low != null && <ReferenceLine y={param.low} stroke="var(--c-caution)" strokeDasharray="4 4" />}
                  {param?.high != null && <ReferenceLine y={param.high} stroke="var(--c-caution)" strokeDasharray="4 4" />}
                  <Line type="monotone" dataKey="v" name={cur[1].unit || 'value'} stroke="var(--c-primary)" strokeWidth={2} dot />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <Table
            size="small"
            rowKey={(p) => `${p.billNo}-${p.date.getTime()}`}
            pagination={false}
            dataSource={[...cur[1].pts].reverse()}
            columns={[
              { title: 'Date', render: (_, p) => dayjs(p.date).format('DD MMM YYYY') },
              { title: 'Bill', dataIndex: 'billNo' },
              { title: `Value ${cur[1].unit}`, render: (_, p) => (p.flag ? `${p.value} (${p.flag === 'high' ? 'High' : 'Low'})` : p.value) },
            ]}
          />
        </>
      )}
    </Card>
  )
}
