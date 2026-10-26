// Print-safe building blocks for the smart report (inline SVG, fixed light colours).

export const TONE = {
  ok: { fg: '#047857', bg: '#D1FAE5' },
  warn: { fg: '#B45309', bg: '#FEF3C7' },
  bad: { fg: '#B91C1C', bg: '#FEE2E2' },
} as const
export type Tone = keyof typeof TONE

export const scoreTone = (score: number): Tone => (score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'bad')

// Circular score ring. `size` in px.
export function ScoreRing({ score, size = 132, stroke = 12, label = 'Health score', colour }: { score: number; size?: number; stroke?: number; label?: string; colour?: string }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const fg = colour ?? TONE[scoreTone(score)].fg
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${score} out of 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E7ECF1" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={fg} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${(c * Math.max(0, Math.min(100, score))) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.28} fontWeight={700} fill="#0F172A">{score}</text>
      <text x="50%" y="68%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.09} fill="#64748B">out of 100</text>
    </svg>
  )
}

// Small ring used on body-system tiles.
export function MiniRing({ value, total, size = 44 }: { value: number; total: number; size?: number }) {
  const pct = total ? Math.round((value / total) * 100) : 0
  const stroke = 5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const fg = TONE[scoreTone(pct)].fg
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E7ECF1" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={fg} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${(c * pct) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="53%" textAnchor="middle" dominantBaseline="middle" fontSize={12} fontWeight={700} fill="#0F172A">{value}/{total}</text>
    </svg>
  )
}

// Range meter: low / usual / high zones with the patient's value marked in a bubble.
export function Meter({ value, low, high, unit, compact }: { value: number | null; low: number | null; high: number | null; unit?: string; compact?: boolean }) {
  if (value === null || (low === null && high === null)) return null
  const lo = low ?? (high as number) * 0.5
  const hi = high ?? (low as number) * 1.6
  if (!(hi > lo)) return null
  const span = hi - lo
  // Values that cannot go below zero never get a negative 'low' zone (e.g. a 0 - 1 % range).
  const min = low === null ? Math.min(0, value) : Math.max(lo >= 0 && value >= 0 ? 0 : -Infinity, lo - span * 0.45)
  const max = high === null ? Math.max(hi + span * 0.45, value) : hi + span * 0.45
  const at = (v: number) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))
  const pLo = low === null || low <= min ? 0 : at(lo)
  const pHi = high === null ? 100 : at(hi)
  const pos = at(value)
  const tone: Tone = (low !== null && value < low) || (high !== null && value > high) ? 'bad' : 'ok'
  return (
    <div className={`srm${compact ? ' srm--compact' : ''}`} role="img" aria-label={`Value ${value}${unit ? ' ' + unit : ''}; usual range ${low ?? 'up to'} ${low !== null && high !== null ? 'to' : ''} ${high ?? 'and above'}`}>
      {!compact && (
        <div className="srm__bubble" style={{ left: `${Math.max(9, Math.min(91, pos))}%`, background: TONE[tone].fg }}>
          {value}{unit ? <small> {unit}</small> : null}
        </div>
      )}
      <div className="srm__track">
        <span className="srm__zone srm__zone--low" style={{ width: `${pLo}%` }} />
        <span className="srm__zone srm__zone--ok" style={{ left: `${pLo}%`, width: `${pHi - pLo}%` }} />
        <span className="srm__zone srm__zone--high" style={{ left: `${pHi}%`, width: `${100 - pHi}%` }} />
        <i className="srm__mark" style={{ left: `${pos}%`, borderColor: TONE[tone].fg }} />
      </div>
      <div className="srm__labels">
        {low !== null && <span style={{ left: `${pLo}%` }}>{low}</span>}
        {high !== null && <span style={{ left: `${pHi}%` }}>{high}</span>}
      </div>
    </div>
  )
}

// ---- Body systems ---------------------------------------------------------------------------

export type SystemKey = 'blood' | 'sugar' | 'heart' | 'liver' | 'kidney' | 'thyroid' | 'vitamins' | 'urine' | 'immunity' | 'hormones' | 'other'

export const SYSTEMS: Record<SystemKey, { label: string; hint: string }> = {
  blood: { label: 'Blood', hint: 'Cells that carry oxygen and fight infection' },
  sugar: { label: 'Blood sugar', hint: 'How your body handles sugar' },
  heart: { label: 'Heart & lipids', hint: 'Cholesterol and fats in the blood' },
  liver: { label: 'Liver', hint: 'Filters blood and helps digestion' },
  kidney: { label: 'Kidneys', hint: 'Clean the blood and balance fluids' },
  thyroid: { label: 'Thyroid', hint: 'Controls energy and metabolism' },
  vitamins: { label: 'Vitamins & minerals', hint: 'Nutrients your body needs' },
  urine: { label: 'Urine', hint: 'Signs from the urinary system' },
  immunity: { label: 'Infection & inflammation', hint: 'Signs of infection or swelling' },
  hormones: { label: 'Hormones', hint: 'Chemical messengers in the body' },
  other: { label: 'Other tests', hint: 'Other results in this report' },
}

const RULES: [SystemKey, RegExp][] = [
  ['sugar', /glucose|sugar|hba1c|glycated|insulin|gtt/i],
  ['heart', /lipid|cholesterol|triglycer|hdl|ldl|vldl|cardiac|troponin|ck-?mb|apolipo/i],
  ['liver', /liver|lft|bilirubin|sgot|sgpt|\balt\b|\bast\b|alkaline phosph|\balp\b|ggt|albumin|globulin|protein/i],
  ['kidney', /kidney|kft|rft|renal|creatinine|urea|\bbun\b|uric|electrolyte|sodium|potassium|chloride|egfr/i],
  ['thyroid', /thyroid|tsh|\bt3\b|\bt4\b|ft3|ft4/i],
  ['vitamins', /vitamin|b12|d3|25-?oh|iron|ferritin|folate|folic|calcium|magnesium|phosph|zinc|tibc/i],
  ['urine', /urine|urinalysis|routine examination|microalbumin/i],
  ['immunity', /crp|esr|widal|dengue|malaria|typhoid|hiv|hbsag|hcv|vdrl|serology|culture|procalcitonin|rheumat|aso/i],
  ['hormones', /hormone|testosterone|estradiol|oestradiol|progesterone|prolactin|lh\b|fsh|cortisol|beta hcg|amh/i],
  ['blood', /haemat|hemat|blood count|\bcbc\b|haemoglobin|hemoglobin|platelet|wbc|rbc|leucocyte|leukocyte|neutrophil|lymphocyte|esr|pcv|mcv|mch|blood group|coagul|prothrombin|\binr\b/i],
]

export function systemOf(...names: string[]): SystemKey {
  const hay = names.join(' ')
  for (const [k, re] of RULES) if (re.test(hay)) return k
  return 'other'
}

// Simple line icons, 24px grid, stroke = currentColor.
const ICON_PATHS: Record<SystemKey, string> = {
  blood: 'M12 3c3 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 3-6.8 6-11z',
  sugar: 'M5 8l7-4 7 4v8l-7 4-7-4zM5 8l7 4 7-4M12 12v8',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  liver: 'M4 10c0-3 3-5 8-5s8 1.5 8 4c0 4-4 9-9 9-3 0-7-3-7-8z',
  kidney: 'M9 4c-3 0-5 3-5 7s2 9 5 9 3-3 2-5-1-3 0-5-1-6-2-6zM15 4c3 0 5 3 5 7s-2 9-5 9',
  thyroid: 'M12 6v4M12 10c-2-3-6-3-7 0s0 7 3 7 4-3 4-7zM12 10c2-3 6-3 7 0s0 7-3 7-4-3-4-7z',
  vitamins: 'M8 4h8l1 4v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8zM7 8h10M10 13h4M12 11v4',
  urine: 'M9 3h6M10 3v6L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3M7.5 14h9',
  immunity: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM9 12l2 2 4-4',
  hormones: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 12v8M9 17h6',
  other: 'M9 3h6M10 3v6L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3',
}

export function SystemIcon({ k, size = 22 }: { k: SystemKey; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICON_PATHS[k]} />
    </svg>
  )
}
