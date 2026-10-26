import type { QcLevel, WestgardRule } from '../types.ts'
import { zScore } from './stats.ts'

/*
 * Westgard multirule evaluation.
 *
 * Notation: z = (x - mean) / SD using the target of the point's level. All limit
 * comparisons are STRICT (|z| exactly 2.00 does not exceed 2SD). "Same side" = same
 * sign of z. A "run" is the set of points sharing the same `at` value; the run being
 * evaluated is the one with the latest `at` (the end of the history). Violations are
 * only reported for that latest run.
 *
 *  1-2s  WARNING  A control observation in the current run exceeds mean +/- 2SD (|z| > 2).
 *                 Alert only; no rejection by itself.
 *  1-3s  REJECT   A control observation in the current run exceeds mean +/- 3SD (|z| > 3).
 *                 Random error (or a large systematic shift).
 *  2-2s  REJECT   Two consecutive control observations exceed the same limit (+2SD or -2SD).
 *                 Checked (a) across levels within the current run, and (b) across the previous
 *                 and current run for the same level. Systematic error.
 *  R-4s  REJECT   Within the current run, one observation exceeds +2SD and another exceeds
 *                 -2SD (range of z across levels > 4, max z > 2, min z < -2). Random error.
 *  4-1s  REJECT   Four consecutive observations exceed the same limit (+1SD or -1SD), checked
 *                 across levels/runs (time-ordered sequence) and per level across runs.
 *  10x   REJECT   Ten consecutive observations fall on the same side of the mean, checked
 *                 across levels/runs and per level across runs.
 *
 * Historical rules need enough points: 2-2s >= 2, 4-1s >= 4, 10x >= 10. With fewer the rule
 * is skipped (not failed). Severity of each rule can be overridden via `severity`.
 * Evaluation order: 1-2s, 1-3s, 2-2s, R-4s, 4-1s, 10x; every rule that fires is recorded.
 */

export interface QcPoint {
  value: number
  level: QcLevel
  at: number // run time (ms); points of one run share the same value
}

export type Target = { mean: number; sd: number }

export interface WgViolation {
  rule: WestgardRule
  level: QcLevel | 'all'
  message: string
  severity: 'warning' | 'fail'
}

export interface WgResult {
  status: 'pass' | 'warning' | 'fail'
  violations: WgViolation[]
}

export const DEFAULT_SEVERITY: Record<WestgardRule, 'warning' | 'fail'> = {
  '1-2s': 'warning',
  '1-3s': 'fail',
  '2-2s': 'fail',
  'R-4s': 'fail',
  '4-1s': 'fail',
  '10x': 'fail',
}

export const DEFAULT_RULES: WestgardRule[] = ['1-2s', '1-3s', '2-2s', 'R-4s', '4-1s', '10x']

export function evaluateWestgard(
  points: QcPoint[],
  targets: Partial<Record<QcLevel, Target>>,
  enabled: WestgardRule[] = DEFAULT_RULES,
  severity: Partial<Record<WestgardRule, 'warning' | 'fail'>> = {},
  scope: { acrossLevels?: boolean; acrossRuns?: boolean } = {},
): WgResult {
  const acrossLevels = scope.acrossLevels !== false
  const acrossRuns = scope.acrossRuns !== false
  const on = new Set(enabled)
  const sev = (r: WestgardRule) => severity[r] ?? DEFAULT_SEVERITY[r]
  const violations: WgViolation[] = []
  const add = (rule: WestgardRule, level: QcLevel | 'all', message: string) => {
    if (!on.has(rule)) return
    if (violations.some((v) => v.rule === rule && v.level === level)) return
    violations.push({ rule, level, message, severity: sev(rule) })
  }

  // Attach z to every point that has a usable target; chronological, stable.
  const zp = points
    .map((p, i) => {
      const t = targets[p.level]
      return t && t.sd > 0 && Number.isFinite(p.value) ? { ...p, i, z: zScore(p.value, t.mean, t.sd) } : null
    })
    .filter((p): p is QcPoint & { i: number; z: number } => !!p)
    .sort((a, b) => a.at - b.at || a.i - b.i)
  if (!zp.length) return { status: 'pass', violations }

  const lastAt = zp[zp.length - 1].at
  const cur = zp.filter((p) => p.at === lastAt)
  const fmtZ = (z: number) => (z > 0 ? '+' : '') + z.toFixed(2)

  // 1-2s and 1-3s
  for (const p of cur) {
    if (Math.abs(p.z) > 2) add('1-2s', p.level, `${p.level} exceeds 2SD (z ${fmtZ(p.z)})`)
    if (Math.abs(p.z) > 3) add('1-3s', p.level, `${p.level} exceeds 3SD (z ${fmtZ(p.z)})`)
  }

  // 2-2s across levels within the run
  const hi = cur.filter((p) => p.z > 2)
  const lo = cur.filter((p) => p.z < -2)
  for (const grp of [hi, lo]) {
    if (acrossLevels && grp.length >= 2) {
      add('2-2s', 'all', `${grp.map((p) => p.level).join(' and ')} both exceed ${grp[0].z > 0 ? '+' : '-'}2SD within the run`)
    }
  }
  // 2-2s across runs for the same level
  const levelsNow = [...new Set(cur.map((p) => p.level))]
  const series = (lv: QcLevel) => zp.filter((p) => p.level === lv)
  for (const lv of acrossRuns ? levelsNow : []) {
    const s = series(lv)
    if (s.length >= 2) {
      const [a, b] = s.slice(-2)
      if ((a.z > 2 && b.z > 2) || (a.z < -2 && b.z < -2)) {
        add('2-2s', lv, `${lv} exceeded ${b.z > 0 ? '+' : '-'}2SD in two consecutive runs`)
      }
    }
  }

  // R-4s within the run
  if (acrossLevels && cur.length >= 2) {
    const zs = cur.map((p) => p.z)
    const mx = Math.max(...zs)
    const mn = Math.min(...zs)
    if (mx > 2 && mn < -2 && mx - mn > 4) {
      add('R-4s', 'all', `Range of z across levels is ${(mx - mn).toFixed(2)} (+2SD and -2SD both exceeded)`)
    }
  }

  // Consecutive-run helpers: last n points of a sequence all satisfy a predicate.
  const lastN = <T,>(s: T[], n: number, f: (p: T) => boolean) => s.length >= n && s.slice(-n).every(f)
  const check = (rule: WestgardRule, n: number, f: (z: number) => boolean, what: string) => {
    const seq = acrossRuns ? zp : cur
    if (acrossLevels && lastN(seq, n, (p) => f(p.z))) add(rule, 'all', `Last ${n} observations across levels ${what}`)
    for (const lv of acrossRuns ? levelsNow : []) {
      if (lastN(series(lv), n, (p) => f(p.z))) add(rule, lv, `Last ${n} ${lv} observations ${what}`)
    }
  }
  check('4-1s', 4, (z) => z > 1, 'exceed +1SD')
  check('4-1s', 4, (z) => z < -1, 'exceed -1SD')
  check('10x', 10, (z) => z > 0, 'are above the mean')
  check('10x', 10, (z) => z < 0, 'are below the mean')

  const status = violations.some((v) => v.severity === 'fail') ? 'fail' : violations.length ? 'warning' : 'pass'
  return { status, violations }
}
