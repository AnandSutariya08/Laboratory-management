import type { SmartItem } from './SmartPages'
import { Pill, statusOf } from './SmartPages'

// Fertility variant of the smart report: only fertility-related results, grouped into hormones, semen and
// other markers, each with its usual range and plain-language note.
const HORMONE = /\b(fsh|lh|amh|anti.?m[uü]llerian|prolactin|oestradiol|estradiol|e2|progesterone|testosterone|tsh|inhibin|dhea|shbg|17.?oh)/i
const SEMEN = /\b(semen|sperm|motility|morpholog|vitality|liquefaction|volume|concentration|count)\b/i
const OTHER = /\b(hcg|beta.?hcg|vitamin d|hba1c|glucose|thyroid|t3|t4|ft3|ft4|rubella|chlamydia|tpo)\b/i

export type FertilityGroup = 'hormones' | 'semen' | 'other'
export const fertilityGroupOf = (i: Pick<SmartItem, 'name' | 'testName'>): FertilityGroup | null =>
  HORMONE.test(i.name) || HORMONE.test(i.testName) ? 'hormones' : SEMEN.test(i.testName) || /semen|sperm/i.test(i.name) ? 'semen' : OTHER.test(i.name) || OTHER.test(i.testName) ? 'other' : null

export const isFertilityItem = (i: Pick<SmartItem, 'name' | 'testName'>) => fertilityGroupOf(i) !== null
const TITLE: Record<FertilityGroup, string> = { hormones: 'Hormones', semen: 'Semen analysis', other: 'Other markers' }

export default function FertilityPage({ items }: { items: SmartItem[] }) {
  const groups = (['hormones', 'semen', 'other'] as FertilityGroup[]).map((g) => ({ g, list: items.filter((i) => fertilityGroupOf(i) === g) })).filter((x) => x.list.length)
  if (!groups.length) return <p className="sr-disclaimer">No fertility results are on this report.</p>
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {groups.map(({ g, list }) => (
        <div key={g}>
          <h3 className="sr-h">{TITLE[g]}</h3>
          <div style={{ display: 'grid', gap: 8 }}>
            {list.map((i) => {
              const st = statusOf(i)
              return (
                <div key={i.key} className="sr-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <b>{i.name}</b>
                    <span><b>{i.value}</b> {i.unit} <Pill tone={st.tone}>{st.label}</Pill></span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>Usual range: {i.range || 'not set'}</div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>{i.note}</div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <p className="sr-disclaimer">Hormone levels change through the cycle and semen results vary between samples. Your fertility specialist reads these together with your history, so please do not draw conclusions from one value.</p>
    </div>
  )
}
