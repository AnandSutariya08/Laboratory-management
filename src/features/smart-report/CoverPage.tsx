import type { CSSProperties, ReactNode } from 'react'
import { COVER_FIELD_LABEL, themeOf, type CoverField, type SmartReportSettings } from './types'

export interface CoverData {
  name: string
  ageGender: string
  patientId: string
  billNo: string
  referrer: string
  date: string
}

const INSIDE: [string, string][] = [
  ['At a glance', 'Your health score and how each body system is doing'],
  ['What needs attention', 'Values outside the usual range, explained simply'],
  ['All your results', 'Every value with where it sits in the usual range'],
  ['Trends and next steps', 'How values changed, and questions for your doctor'],
]

// Six cover layouts in one component so the designer preview and the real report match.
export default function CoverPage({ s, data, aiTag }: { s: SmartReportSettings; data: CoverData; aiTag?: boolean }) {
  const th = themeOf(s.themeColour)
  const vars = { '--sr-c': th.main, '--sr-deep': th.deep, '--sr-soft': th.soft, '--sr-tint': th.tint } as CSSProperties
  const fields = (Object.keys(COVER_FIELD_LABEL) as CoverField[]).filter((k) => s.coverFields.includes(k))
  const title = s.coverTitle || 'Your health report'
  const subtitle = s.coverSubtitle
  const details: ReactNode = (
    <dl className="sr-cdl">
      {fields.map((k) => (
        <div key={k}>
          <dt>{COVER_FIELD_LABEL[k]}</dt>
          <dd>{data[k]}</dd>
        </div>
      ))}
    </dl>
  )
  const logo = s.logoDataUrl ? <img className="sr-logo" src={s.logoDataUrl} alt={`${s.labName} logo`} /> : null
  const lab = (
    <div className="sr-clab">
      <div className="sr-lab">{s.labName}</div>
      {s.labAddress && <div className="sr-addr">{s.labAddress}</div>}
    </div>
  )
  const lh = s.letterheadDataUrl ? { backgroundImage: `url(${s.letterheadDataUrl})`, backgroundSize: '100% auto', backgroundRepeat: 'no-repeat' as const } : undefined
  const tag = aiTag ? <span className="sr-pill sr-pill--ai">Includes an AI generated summary</span> : null
  const cls = `sr-sheet sr-cover sr-cover--${s.coverStyle} sr-font--${s.fontStyle}`

  if (s.coverStyle === 'gradient' || s.coverStyle === 'wave')
    return (
      <div className={cls} style={{ ...vars, ...lh }}>
        <div className="sr-hero-band">
          {s.coverStyle === 'gradient' && (
            <svg className="sr-blobs" viewBox="0 0 400 300" preserveAspectRatio="none" aria-hidden>
              <circle cx="340" cy="40" r="120" fill="#fff" fillOpacity="0.08" />
              <circle cx="60" cy="260" r="90" fill="#fff" fillOpacity="0.07" />
              <circle cx="250" cy="200" r="50" fill="#fff" fillOpacity="0.06" />
            </svg>
          )}
          <div className="sr-hero-band__top">
            {logo ? <div className="sr-logochip">{logo}</div> : null}
            {lab}
          </div>
          <div className="sr-hero-band__title">
            <h1 className="sr-title">{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {s.coverStyle === 'wave' && (
            <svg className="sr-wave" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden>
              <path d="M0 20 C 80 45, 160 0, 240 18 S 360 40, 400 12 L400 40 L0 40 Z" fill="#fff" />
            </svg>
          )}
        </div>
        <div className="sr-cbody">
          <div className="sr-ccard">
            <div className="sr-ccard__label">Prepared for</div>
            {details}
          </div>
          {tag}
          <div className="sr-inside">
            <div className="sr-ccard__label">Inside this report</div>
            <ul>
              {INSIDE.map(([t, d]) => (
                <li key={t}><span className="sr-inside__dot" /><div><b>{t}</b><small>{d}</small></div></li>
              ))}
            </ul>
          </div>
          <div className="sr-ccontact">
            <b>{s.labName}</b>
            {s.email && <span>{s.email}</span>}
          </div>
        </div>
      </div>
    )
  if (s.coverStyle === 'split')
    return (
      <div className={cls} style={{ ...vars, ...lh }}>
        <div className="sr-panel">
          {logo ? <div className="sr-logochip">{logo}</div> : null}
          {lab}
        </div>
        <div className="sr-cbody">
          <h1 className="sr-title" style={{ color: th.main }}>{title}</h1>
          {subtitle && <p className="sr-csub">{subtitle}</p>}
          <div className="sr-ccard">{details}</div>
          {tag}
        </div>
      </div>
    )
  if (s.coverStyle === 'frame')
    return (
      <div className={cls} style={{ ...vars, ...lh }}>
        <div className="sr-frame">
          {logo}
          {lab}
          <h1 className="sr-title" style={{ color: th.main }}>{title}</h1>
          {subtitle && <p className="sr-csub">{subtitle}</p>}
          {details}
          {tag}
        </div>
      </div>
    )
  if (s.coverStyle === 'minimal')
    return (
      <div className={cls} style={{ ...vars, ...lh }}>
        {logo}
        <div style={{ flex: 1 }} />
        <h1 className="sr-title sr-title--xl">{title}</h1>
        <div className="sr-rule" />
        {subtitle && <p className="sr-csub">{subtitle}</p>}
        {details}
        <div style={{ flex: 1 }} />
        {lab}
        <div style={{ marginTop: 8 }}>{tag}</div>
      </div>
    )
  return (
    <div className={cls} style={{ ...vars, ...lh }}>
      <div className="sr-band">
        {logo && <div className="sr-logochip">{logo}</div>}
        {lab}
      </div>
      <div className="sr-cbody">
        <h1 className="sr-title" style={{ color: th.main }}>{title}</h1>
        {subtitle && <p className="sr-csub">{subtitle}</p>}
        <div className="sr-ccard">{details}</div>
        {tag}
      </div>
    </div>
  )
}
