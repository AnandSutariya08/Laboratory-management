import type { ValidationCriteria, ValidationType } from '../types.ts'
import { cv, linearRegression, mean, sd, sum } from './stats.ts'

// Equipment validation computations. Input rows are plain number arrays:
//   carryOver      [H1 H2 H3 L1 L2 L3] per cycle
//   linearity      [expected, replicate1, replicate2, ...] per level
//   intraAssay     replicates of one sample in one run (all rows are pooled)
//   interAssay     one row per day holding that day's replicates
//   interEquipment [machine A, machine B] per paired sample
export interface ValidationComputation {
  computed: Record<string, number | null>
  checks: { label: string; pass: boolean; detail: string }[]
  outcome: 'pass' | 'fail' | 'inconclusive'
}

export const VALIDATION_LABEL: Record<ValidationType, string> = {
  carryOver: 'Carry-over',
  linearity: 'Linearity',
  intraAssay: 'Intra-assay precision',
  interAssay: 'Inter-assay precision',
  interEquipment: 'Inter-equipment comparison',
  accuracy: 'Accuracy (bias)',
  referenceInterval: 'Reference interval verification',
}

export const DEFAULT_CRITERIA: Record<ValidationType, ValidationCriteria> = {
  carryOver: { limitPct: 1 },
  linearity: { minR2: 0.99, slopeMin: 0.9, slopeMax: 1.1, recoveryMin: 90, recoveryMax: 110 },
  intraAssay: { maxCv: 5, teaPct: 0, claimCv: 0 },
  interAssay: { maxCv: 8, teaPct: 0, claimCv: 0 },
  interEquipment: { limitPct: 10, minPairsWithinPct: 100, meanBiasLimitPct: 5, slopeMin: 0.9, slopeMax: 1.1 },
  accuracy: { maxBiasPct: 5 },
  referenceInterval: { refLow: 0, refHigh: 0, maxOutsidePct: 10, minSamples: 20 },
}

export const CRITERIA_LABEL: Record<string, string> = {
  limitPct: 'Limit (%)',
  minR2: 'Min R²',
  slopeMin: 'Slope min',
  slopeMax: 'Slope max',
  maxCv: 'Allowable CV (%)',
  teaPct: 'TEa (%): CV limit taken from it',
  claimCv: 'Manufacturer claim CV (%)',
  recoveryMin: 'Recovery min (%)',
  recoveryMax: 'Recovery max (%)',
  maxBiasPct: 'Allowable bias (%)',
  refLow: 'Reference low',
  refHigh: 'Reference high',
  maxOutsidePct: 'Max outside interval (%)',
  minSamples: 'Min samples',
  minPairsWithinPct: 'Pairs within limit (%)',
  meanBiasLimitPct: 'Mean bias limit (%)',
}

export const ROW_HELP: Record<ValidationType, string> = {
  carryOver: 'One cycle per line: H1 H2 H3 L1 L2 L3 (high sample x3 then low sample x3). carry-over % = (L1 - L3) / (H3 - L3) x 100.',
  linearity: 'One level per line: expected value, then the measured replicates, e.g. "50 49.5 50.2".',
  intraAssay: 'Replicates of one sample from a single run (10 to 20 values), separated by spaces, commas or new lines.',
  interAssay: 'One day per line, each line holding that day\'s replicate values.',
  interEquipment: 'One paired sample per line: value on machine A, value on machine B.',
  accuracy: 'One reference sample per line: assigned value, then the measured replicates.',
  referenceInterval: 'One healthy-donor result per line (at least 20). Enter the reference interval below.',
}

export function parseRows(text: string): number[][] {
  return text
    .split(/\n/)
    .map((l) => l.split(/[\s,;]+/).filter(Boolean).map(Number))
    .filter((r) => r.length > 0 && r.every(Number.isFinite))
}

export const rowsToText = (rows: { v: number[] }[]) => rows.map((r) => r.v.join(' ')).join('\n')

const chk = (label: string, pass: boolean, detail: string) => ({ label, pass, detail })
const f = (x: number, dp = 2) => (Number.isFinite(x) ? x.toFixed(dp) : '-')
const num = (x: number): number | null => (Number.isFinite(x) ? x : null)
const finish = (computed: Record<string, number | null>, checks: ValidationComputation['checks'], inconclusive = false): ValidationComputation => ({
  computed,
  checks,
  outcome: inconclusive ? 'inconclusive' : checks.every((c) => c.pass) ? 'pass' : 'fail',
})

// Precision limit (CV %): the manufacturer claim when given, else a share of TEa (intra-assay 25%,
// inter-assay 33%), else the manual limit.
export function precisionLimit(type: 'intraAssay' | 'interAssay', c: ValidationCriteria): { maxCv: number; basis: string } {
  if (c.claimCv > 0) return { maxCv: c.claimCv, basis: 'manufacturer claim' }
  if (c.teaPct > 0) {
    const share = type === 'intraAssay' ? 0.25 : 0.33
    return { maxCv: Math.round(c.teaPct * share * 100) / 100, basis: `${share * 100}% of TEa` }
  }
  return { maxCv: c.maxCv, basis: 'manual' }
}

export function computeValidation(type: ValidationType, rows: number[][], criteria: ValidationCriteria): ValidationComputation {
  const c = { ...DEFAULT_CRITERIA[type], ...criteria }

  if (type === 'carryOver') {
    const cycles = rows.filter((r) => r.length >= 6)
    if (!cycles.length) return finish({}, [], true)
    // Guard: H3 must exceed L3 or the cycle is not interpretable.
    const bad = cycles.some((r) => r[2] <= r[5])
    const co = cycles.map((r) => ((r[3] - r[5]) / (r[2] - r[5])) * 100)
    const m = mean(co)
    const worst = Math.max(...co.map(Math.abs))
    return finish(
      { cycles: cycles.length, meanCarryOverPct: num(m), worstCarryOverPct: num(worst) },
      [chk(`Mean carry-over <= ${c.limitPct}%`, Math.abs(m) <= c.limitPct, `${f(m)}%`), chk(`Every cycle <= ${c.limitPct}%`, worst <= c.limitPct, `worst ${f(worst)}%`)],
      bad,
    )
  }

  if (type === 'linearity') {
    const lv = rows.filter((r) => r.length >= 2)
    const x = lv.map((r) => r[0])
    const y = lv.map((r) => mean(r.slice(1)))
    if (lv.length < 3) return finish({}, [], true)
    const reg = linearRegression(x, y)
    const rec = y.map((v, i) => (x[i] !== 0 ? (v / x[i]) * 100 : NaN)).filter(Number.isFinite)
    return finish(
      { levels: lv.length, slope: num(reg.slope), intercept: num(reg.intercept), r: num(reg.r), r2: num(reg.r2), minRecoveryPct: num(Math.min(...rec)), maxRecoveryPct: num(Math.max(...rec)) },
      [
        chk(`R² >= ${c.minR2}`, reg.r2 >= c.minR2, f(reg.r2, 4)),
        chk(`Slope ${c.slopeMin} to ${c.slopeMax}`, reg.slope >= c.slopeMin && reg.slope <= c.slopeMax, f(reg.slope, 3)),
        chk(`Recovery ${c.recoveryMin}% to ${c.recoveryMax}% at every level`, rec.length > 0 && Math.min(...rec) >= c.recoveryMin && Math.max(...rec) <= c.recoveryMax, rec.length ? `${f(Math.min(...rec), 1)}% to ${f(Math.max(...rec), 1)}%` : '-'),
      ],
      !Number.isFinite(reg.r2),
    )
  }

  if (type === 'intraAssay') {
    const xs = rows.flat()
    if (xs.length < 2) return finish({}, [], true)
    const cvv = cv(xs)
    const lim = precisionLimit('intraAssay', c)
    return finish(
      { n: xs.length, mean: num(mean(xs)), sd: num(sd(xs)), cvPct: num(cvv), allowableCvPct: lim.maxCv },
      [chk(`CV <= ${lim.maxCv}% (${lim.basis})`, cvv <= lim.maxCv, `${f(cvv)}%`)],
    )
  }

  if (type === 'interAssay') {
    const days = rows.filter((r) => r.length >= 1)
    const all = days.flat()
    if (days.length < 2 || all.length < 3) return finish({}, [], true)
    const grand = mean(all)
    const N = all.length
    const k = days.length
    // One-way ANOVA with days as groups (handles unequal replicate counts via n0).
    const ssWithin = sum(days.map((d) => sum(d.map((v) => (v - mean(d)) ** 2))))
    const ssBetween = sum(days.map((d) => d.length * (mean(d) - grand) ** 2))
    const msW = N - k > 0 ? ssWithin / (N - k) : NaN
    const msB = ssBetween / (k - 1)
    const n0 = (N - sum(days.map((d) => d.length ** 2)) / N) / (k - 1)
    const sR = Math.sqrt(Math.max(0, msW))
    const sB = Number.isFinite(msW) && n0 > 0 ? Math.sqrt(Math.max(0, (msB - msW) / n0)) : 0
    // With one value per day there is no within-day variance: fall back to the CV of all values.
    const sWl = Number.isFinite(msW) ? Math.sqrt(sR ** 2 + sB ** 2) : sd(all)
    const cvWl = (sWl / grand) * 100
    const lim = precisionLimit('interAssay', c)
    return finish(
      { days: k, n: N, grandMean: num(grand), sRepeatability: num(Number.isFinite(msW) ? sR : NaN), sBetweenDay: num(sB), sWithinLab: num(sWl), cvPct: num(cvWl), cvAllValuesPct: num(cv(all)), allowableCvPct: lim.maxCv },
      [chk(`Within-lab CV <= ${lim.maxCv}% (${lim.basis})`, cvWl <= lim.maxCv, `${f(cvWl)}%`)],
    )
  }

  if (type === 'accuracy') {
    const lv = rows.filter((r) => r.length >= 2 && r[0] !== 0)
    if (!lv.length) return finish({}, [], true)
    const bias = lv.map((r) => ((mean(r.slice(1)) - r[0]) / r[0]) * 100)
    const mb = mean(bias)
    const worst = Math.max(...bias.map(Math.abs))
    return finish(
      { samples: lv.length, meanBiasPct: num(mb), worstBiasPct: num(worst) },
      [chk(`|Bias| <= ${c.maxBiasPct}% on every sample`, worst <= c.maxBiasPct, `worst ${f(worst)}%`), chk(`|Mean bias| <= ${c.maxBiasPct}%`, Math.abs(mb) <= c.maxBiasPct, `${f(mb)}%`)],
    )
  }

  if (type === 'referenceInterval') {
    const xs = rows.flat()
    if (!(c.refHigh > c.refLow)) return finish({}, [], true)
    const outside = xs.filter((x) => x < c.refLow || x > c.refHigh).length
    const pct = xs.length ? (outside / xs.length) * 100 : NaN
    return finish(
      { n: xs.length, outside, outsidePct: num(pct) },
      [chk(`At least ${c.minSamples} samples`, xs.length >= c.minSamples, String(xs.length)), chk(`No more than ${c.maxOutsidePct}% outside ${c.refLow} to ${c.refHigh}`, pct <= c.maxOutsidePct, `${outside} of ${xs.length} (${f(pct, 1)}%)`)],
      xs.length === 0,
    )
  }

  // interEquipment
  const pairs = rows.filter((r) => r.length >= 2)
  if (pairs.length < 3) return finish({}, [], true)
  const A = pairs.map((r) => r[0])
  const B = pairs.map((r) => r[1])
  const diff = pairs.map((_, i) => B[i] - A[i])
  const pct = pairs.map((_, i) => (A[i] !== 0 ? (diff[i] / A[i]) * 100 : NaN)).filter(Number.isFinite)
  const meanBias = mean(diff)
  const sdDiff = sd(diff)
  const reg = linearRegression(A, B)
  const within = (pct.filter((p) => Math.abs(p) <= c.limitPct).length / pct.length) * 100
  const meanPct = mean(pct)
  return finish(
    { pairs: pairs.length, meanBias: num(meanBias), meanBiasPct: num(meanPct), sdDiff: num(sdDiff), loaLower: num(meanBias - 1.96 * sdDiff), loaUpper: num(meanBias + 1.96 * sdDiff), slope: num(reg.slope), intercept: num(reg.intercept), r2: num(reg.r2), pairsWithinPct: num(within) },
    [
      chk(`>= ${c.minPairsWithinPct}% of pairs within ±${c.limitPct}%`, within >= c.minPairsWithinPct, `${f(within, 0)}%`),
      chk(`|Mean bias| <= ${c.meanBiasLimitPct}%`, Math.abs(meanPct) <= c.meanBiasLimitPct, `${f(meanPct)}%`),
      chk(`Slope ${c.slopeMin} to ${c.slopeMax}`, reg.slope >= c.slopeMin && reg.slope <= c.slopeMax, f(reg.slope, 3)),
    ],
  )
}
