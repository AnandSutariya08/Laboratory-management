import type { QcLevel, QcSettings } from '../types'

// Allowable total error (percent): per-level value wins over the parameter value.
export const teaFor = (s: Pick<QcSettings, 'tea'>, testId: string, paramKey: string, level?: QcLevel): number | null => {
  const t = s.tea ?? {}
  const v = (level ? t[`${testId}|${paramKey}|${level}`] : undefined) ?? t[`${testId}|${paramKey}`]
  return v != null && v > 0 ? v : null
}

// Sigma metric = (TEa% - |bias%|) / CV%. Null when any input is missing.
export function sigmaMetric(teaPct: number | null, biasPct: number, cvPct: number): number | null {
  if (teaPct == null || !Number.isFinite(biasPct) || !Number.isFinite(cvPct) || cvPct <= 0) return null
  return (teaPct - Math.abs(biasPct)) / cvPct
}

export type SigmaBand = 'world class' | 'excellent' | 'good' | 'marginal' | 'poor'
export function sigmaBand(s: number | null): SigmaBand | null {
  if (s == null) return null
  return s >= 6 ? 'world class' : s >= 5 ? 'excellent' : s >= 4 ? 'good' : s >= 3 ? 'marginal' : 'poor'
}
