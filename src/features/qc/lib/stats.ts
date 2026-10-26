// Pure statistics helpers used by QC, EQAS, ILC and validation studies.

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

export const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : NaN)

// Sample standard deviation (n - 1). NaN for fewer than 2 points.
export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1))
}

// Coefficient of variation in percent.
export const cv = (xs: number[]): number => (sd(xs) / mean(xs)) * 100

// z-score of a value against a target: (x - mean) / SD.
export const zScore = (x: number, targetMean: number, targetSd: number): number =>
  targetSd > 0 ? (x - targetMean) / targetSd : NaN

// Standard deviation index: (observed mean - target mean) / target SD.
export const sdi = (observed: number, targetMean: number, targetSd: number): number =>
  targetSd > 0 ? (observed - targetMean) / targetSd : NaN

// Bias as percent of the target mean.
export const biasPct = (observed: number, target: number): number =>
  target !== 0 ? ((observed - target) / target) * 100 : NaN

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const idx = (p / 100) * (s.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

export const median = (xs: number[]) => percentile(xs, 50)

export interface Regression {
  slope: number
  intercept: number
  r: number
  r2: number
  n: number
}

// Ordinary least squares y = intercept + slope * x with Pearson r.
export function linearRegression(x: number[], y: number[]): Regression {
  const n = Math.min(x.length, y.length)
  if (n < 2) return { slope: NaN, intercept: NaN, r: NaN, r2: NaN, n }
  const xs = x.slice(0, n)
  const ys = y.slice(0, n)
  const mx = mean(xs)
  const my = mean(ys)
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
    sxy += (xs[i] - mx) * (ys[i] - my)
  }
  const slope = sxx === 0 ? NaN : sxy / sxx
  const intercept = my - slope * mx
  const r = sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy)
  return { slope, intercept, r, r2: r * r, n }
}

export const round = (x: number, dp = 2): number =>
  Number.isFinite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : x

// Format for display; "-" for NaN / null.
export const fmt = (x: number | null | undefined, dp = 2): string =>
  x == null || !Number.isFinite(x) ? '-' : x.toFixed(dp)
