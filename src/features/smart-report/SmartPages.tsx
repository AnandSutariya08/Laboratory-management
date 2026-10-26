import type { CSSProperties, ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import CoverPage, { type CoverData } from './CoverPage'
import { themeOf, type SmartReportSettings } from './types'
import { MiniRing, Meter, ScoreRing, SystemIcon, SYSTEMS, TONE, type SystemKey, type Tone } from './visuals'

// Everything the smart report shows, already worked out (real bill or designer sample).
export interface SmartItem {
  key: string
  testName: string
  name: string
  value: string
  unit: string
  num: number | null
  flag: 'low' | 'high' | 'abnormal' | null
  critical: boolean
  range: string
  low: number | null
  high: number | null
  note: string // plain-language explanation
  system: SystemKey
}
export interface SmartTrend { key: string; name: string; unit: string; low: number | null; high: number | null; data: { label: string; v: number }[] }
export interface SmartModel {
  cover: CoverData
  firstName: string
  items: SmartItem[]
  trends: SmartTrend[]
  doctorNote: string
  ai: { title: string; text: string }[]
}

export const statusOf = (i: Pick<SmartItem, 'flag' | 'critical'>): { tone: Tone; label: string } =>
  i.critical
    ? { tone: 'bad', label: i.flag === 'high' ? 'Very high' : i.flag === 'low' ? 'Very low' : 'Urgent' }
    : i.flag === 'high' ? { tone: 'warn', label: 'High' }
    : i.flag === 'low' ? { tone: 'warn', label: 'Low' }
    : i.flag === 'abnormal' ? { tone: 'warn', label: 'Abnormal' }
    : { tone: 'ok', label: 'Normal' }

// Y axis always shows the usual range band as well as every value.
const yDomain = (g: SmartTrend): [number, number] => {
  const vals = [...g.data.map((d) => d.v), ...(g.low !== null ? [g.low] : []), ...(g.high !== null ? [g.high] : [])]
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12
  return [+(lo - pad).toFixed(2), +(hi + pad).toFixed(2)]
}

// Axis labels rounded to suit the scale of the test (0.8 mg/dL vs 7200 /cumm).
const tickText = (v: number, g: SmartTrend) => {
  const [lo, hi] = yDomain(g)
  const span = hi - lo
  return String(+v.toFixed(span >= 20 ? 0 : span >= 2 ? 1 : 2))
}

export const Pill = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <span className="sr-pill" style={{ color: TONE[tone].fg, background: TONE[tone].bg }}>{children}</span>
)

export default function SmartPages({ s, model, aiTag, pageStyle, afterCover }: { s: SmartReportSettings; model: SmartModel; aiTag?: boolean; pageStyle?: CSSProperties; afterCover?: ReactNode }) {
  const th = themeOf(s.themeColour)
  const rootStyle = {
    '--sr-c': th.main, '--sr-deep': th.deep, '--sr-soft': th.soft, '--sr-tint': th.tint,
    ...pageStyle,
  } as CSSProperties
  const items = model.items
  const total = items.length
  const attention = items.filter((i) => i.flag || i.critical).sort((a, b) => Number(b.critical) - Number(a.critical))
  const normal = total - attention.length
  const critical = items.filter((i) => i.critical).length
  const score = total ? Math.round((normal / total) * 100) : 0

  const systems = (Object.keys(SYSTEMS) as SystemKey[])
    .map((k) => {
      const list = items.filter((i) => i.system === k)
      return { k, list, ok: list.filter((i) => !i.flag && !i.critical).length }
    })
    .filter((x) => x.list.length > 0)

  // Page numbers (the cover is page 1).
  const showAll = s.showAllResults && total > 0
  const showTrends = s.showHistoryGraph && model.trends.length > 0
  const pageNo = { glance: 2, all: 3, trends: showAll ? 4 : 3, notes: 3 + Number(showAll) }
  const Header = ({ title }: { title: string }) =>
    s.showPageHeader ? (
      <header className="sr-phead">
        <div className="sr-phead__lab">
          {s.logoDataUrl ? <img src={s.logoDataUrl} alt="" /> : <span className="sr-phead__dot" />}
          <span>{s.labName}</span>
        </div>
        <div className="sr-phead__meta"><b>{title}</b><span>{model.cover.name} · {model.cover.date}</span></div>
      </header>
    ) : null
  const Footer = ({ n }: { n: number }) => (
    <footer className="sr-pfoot">
      <span>{s.footerText || s.labName}</span>
      <span>{s.email}</span>
      <span>Page {n}</span>
    </footer>
  )
  const lh = s.letterheadDataUrl ? <div className="sr-lhbar" style={{ backgroundImage: `url(${s.letterheadDataUrl})` }} /> : null

  const questions = attention.slice(0, 4).map((i) => {
    const st = statusOf(i)
    return st.tone === 'bad'
      ? `My ${i.name} is ${st.label.toLowerCase()}. What should I do today?`
      : `What could make my ${i.name} ${i.flag === 'abnormal' ? 'abnormal' : st.label.toLowerCase()}, and do I need a repeat test?`
  })

  const notes = (
    <>
          {s.showDoctorNote && model.doctorNote && (
            <>
              <h3 className="sr-h">A note from your doctor</h3>
              <blockquote className="sr-card sr-quote">{model.doctorNote}</blockquote>
            </>
          )}
          {model.ai.length > 0 && (
            <>
              <h3 className="sr-h">Summary <span className="sr-pill sr-pill--ai">AI generated</span></h3>
              <div className="sr-attn">
                {model.ai.map((a) => (
                  <div key={a.title} className="sr-card sr-ai"><b>{a.title}</b><p>{a.text}</p></div>
                ))}
              </div>
            </>
          )}
          {questions.length > 0 && (
            <>
              <h3 className="sr-h">Questions you may want to ask your doctor</h3>
              <ol className="sr-card sr-questions">{questions.map((q) => <li key={q}>{q}</li>)}</ol>
            </>
          )}
          <h3 className="sr-h">Everyday tips</h3>
          <div className="sr-tips">
            {[
              ['Stay hydrated', 'Drink water through the day unless your doctor has advised otherwise.'],
              ['Move every day', 'Aim for about 30 minutes of walking or other activity.'],
              ['Keep your reports', 'Bring this report to your next doctor visit to track changes.'],
            ].map(([t, d]) => (
              <div key={t} className="sr-card sr-tip"><b>{t}</b><span>{d}</span></div>
            ))}
          </div>
          <p className="sr-disclaimer">{s.disclaimer}</p>
            </>
  )

  return (
    <div className={`sr-root sr-root--${s.cardStyle} sr-font--${s.fontStyle}`} style={rootStyle}>
      <CoverPage s={s} data={model.cover} aiTag={aiTag} />
      {afterCover && (
        <section className="sr-sheet">
          {lh}
          <Header title="Your fertility results" />
          <div className="sr-pad">{afterCover}</div>
          <Footer n={2} />
        </section>
      )}

      {/* At a glance */}
      <section className="sr-sheet">
        {lh}
        <Header title="At a glance" />
        <div className="sr-pad">
          <div className="sr-hero">
            {s.showHealthScore && total > 0 && <ScoreRing score={score} />}
            <div className="sr-hero__text">
              <h2>Hello {model.firstName || 'there'},</h2>
              {total === 0 ? (
                <p>Your results are not ready yet. We will share them as soon as they are approved.</p>
              ) : attention.length === 0 ? (
                <p>Good news: all <b>{total}</b> values in this report are within the usual range.</p>
              ) : (
                <p><b>{normal}</b> of <b>{total}</b> values are within the usual range. <b>{attention.length}</b> {attention.length === 1 ? 'value needs' : 'values need'} your attention{critical ? <>, including <b className="sr-txt-bad">{critical} urgent</b></> : null}.</p>
              )}
              {s.showSummaryCounts && total > 0 && (
                <div className="sr-counts">
                  <div><b>{total}</b><span>Tested</span></div>
                  <div className="is-ok"><b>{normal}</b><span>Normal</span></div>
                  <div className="is-warn"><b>{attention.length - critical}</b><span>Outside range</span></div>
                  <div className="is-bad"><b>{critical}</b><span>Urgent</span></div>
                </div>
              )}
            </div>
          </div>

          {s.showWellness && systems.length > 0 && (
            <>
              <h3 className="sr-h">Your body systems</h3>
              <div className="sr-systems">
                {systems.map(({ k, list, ok }) => {
                  const bad = list.length - ok
                  return (
                    <div key={k} className="sr-card sr-sys">
                      <div className="sr-sys__icon"><SystemIcon k={k} /></div>
                      <div className="sr-sys__body">
                        <b>{SYSTEMS[k].label}</b>
                        <small>{SYSTEMS[k].hint}</small>
                        {bad === 0 ? <Pill tone="ok">All normal</Pill> : <Pill tone={list.some((i) => i.critical) ? 'bad' : 'warn'}>{bad} to review</Pill>}
                      </div>
                      <MiniRing value={ok} total={list.length} />
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {total > 0 && (
            <>
              <h3 className="sr-h">What needs your attention</h3>
              {attention.length === 0 ? (
                <div className="sr-card sr-allgood"><Pill tone="ok">All clear</Pill> Every value is in its usual range. Keep up your healthy habits.</div>
              ) : (
                <div className="sr-attn">
                  {attention.map((i) => {
                    const st = statusOf(i)
                    return (
                      <article key={i.key} className="sr-card sr-attn__item" style={{ borderLeftColor: TONE[st.tone].fg }}>
                        <div className="sr-attn__top">
                          <div>
                            <h4>{i.name}</h4>
                            <small>{i.testName}</small>
                          </div>
                          <Pill tone={st.tone}>{st.label}</Pill>
                        </div>
                        <div className="sr-attn__val" style={{ color: TONE[st.tone].fg }}>
                          {i.value}<span>{i.unit}</span>
                          {i.range && <em>usual {i.range}{i.unit ? ` ${i.unit}` : ''}</em>}
                        </div>
                        {s.showRangeBar && <Meter value={i.num} low={i.low} high={i.high} unit={i.unit} />}
                        <p>{i.note}</p>
                      </article>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <Footer n={pageNo.glance} />
      </section>

      {/* Every result, grouped by body system */}
      {showAll && (
        <section className="sr-sheet">
          {lh}
          <Header title="All your results" />
          <div className="sr-pad">
            {systems.map(({ k, list }) => (
              <div key={k} className="sr-group">
                <div className="sr-group__head">
                  <span className="sr-group__icon"><SystemIcon k={k} size={18} /></span>
                  <h3>{SYSTEMS[k].label}</h3>
                </div>
                <div className="sr-rows">
                  {list.map((i) => {
                    const st = statusOf(i)
                    return (
                      <div key={i.key} className="sr-row">
                        <div className="sr-row__name"><b>{i.name}</b><small>{i.testName}</small></div>
                        <div className="sr-row__val" style={{ color: st.tone === 'ok' ? '#0F172A' : TONE[st.tone].fg }}>{i.value} <small>{i.unit}</small></div>
                        <div className="sr-row__meter">
                          {s.showRangeBar && i.num !== null ? <Meter compact value={i.num} low={i.low} high={i.high} /> : <small>{i.range ? `Usual ${i.range}` : ''}</small>}
                        </div>
                        <Pill tone={st.tone}>{st.label}</Pill>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <Footer n={pageNo.all} />
        </section>
      )}

      {/* Trends */}
      {showTrends && (
        <section className="sr-sheet">
          {lh}
          <Header title="Trends and next steps" />
          <div className="sr-pad">
            <p className="sr-lead">Your earlier results compared with this report. The shaded band is the usual range.</p>
            <div className="sr-trends">
              {model.trends.map((g) => (
                <div key={g.key} className="sr-card sr-trend">
                  <div className="sr-trend__head">
                    <b>{g.name}</b>{g.unit && <small>{g.unit}</small>}
                    {g.data.length > 1 && (() => {
                      const d = +(g.data[g.data.length - 1].v - g.data[0].v).toFixed(2)
                      const last = g.data[g.data.length - 1].v
                      const inRange = (g.low === null || last >= g.low) && (g.high === null || last <= g.high)
                      return <span className="sr-delta" style={{ color: TONE[inRange ? 'ok' : 'warn'].fg, background: TONE[inRange ? 'ok' : 'warn'].bg }}>{d > 0 ? '▲' : d < 0 ? '▼' : '■'} {Math.abs(d)} since {g.data[0].label}</span>
                    })()}
                  </div>
                  <div style={{ height: 150 }} role="img" aria-label={`Trend of ${g.name}: ${g.data.map((d) => d.v).join(', ')}`}>
                    <ResponsiveContainer>
                      <AreaChart data={g.data} margin={{ top: 8, right: 10, bottom: 0, left: -12 }}>
                        <defs>
                          <linearGradient id={`srg-${g.key}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={th.main} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={th.main} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="#EEF2F6" vertical={false} />
                        {g.low !== null && g.high !== null && <ReferenceArea y1={g.low} y2={g.high} fill="#10B981" fillOpacity={0.1} stroke="none" />}
                        <XAxis dataKey="label" fontSize={10} tickLine={false} axisLine={false} />
                        <YAxis fontSize={10} domain={yDomain(g)} width={44} tickLine={false} axisLine={false} tickCount={4} tickFormatter={(v: number) => tickText(v, g)} />
                        <Tooltip />
                        <Area type="monotone" dataKey="v" stroke={th.main} strokeWidth={2.5} fill={`url(#srg-${g.key})`} dot={{ r: 3.5, fill: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ))}
            </div>
            {notes}
          </div>
          <Footer n={pageNo.trends} />
        </section>
      )}

      {/* Notes and next steps (own page only when there are no trends) */}
      {!showTrends && (
        <section className="sr-sheet">
          {lh}
          <Header title="Notes and next steps" />
          <div className="sr-pad">{notes}</div>
          <Footer n={pageNo.notes} />
        </section>
      )}
    </div>
  )
}
