// Worked examples for the Westgard evaluator. Run with `npm run check:qc`
// (Node strips the types natively). Mean 100, SD 2 unless noted.
import { evaluateWestgard, type QcPoint, type Target } from './westgard.ts'
import { linearRegression, mean, sd } from './stats.ts'
import { computeValidation } from './validation.ts'

const T: Record<'L1' | 'L2', Target> = { L1: { mean: 100, sd: 2 }, L2: { mean: 100, sd: 2 } }
const pt = (value: number, level: 'L1' | 'L2', at: number): QcPoint => ({ value, level, at })

export interface Example {
  name: string
  points: QcPoint[]
  expectStatus: 'pass' | 'warning' | 'fail'
  expectRules: string[]
}

export const EXAMPLES: Example[] = [
  { name: 'all within limits', points: [pt(101, 'L1', 1), pt(99, 'L2', 1)], expectStatus: 'pass', expectRules: [] },
  // z = +2.25 on L1 (1-2s); L2 is exactly -2.00 which is NOT beyond 2SD.
  { name: '1-2s warning only', points: [pt(104.5, 'L1', 1), pt(96, 'L2', 1)], expectStatus: 'warning', expectRules: ['1-2s'] },
  // z = +3.5 -> 1-2s and 1-3s.
  { name: '1-3s reject', points: [pt(107, 'L1', 1), pt(100, 'L2', 1)], expectStatus: 'fail', expectRules: ['1-2s', '1-3s'] },
  // +2.25 and -2.5: range 4.75 > 4 -> R-4s.
  { name: 'R-4s within run', points: [pt(104.5, 'L1', 1), pt(95, 'L2', 1)], expectStatus: 'fail', expectRules: ['1-2s', 'R-4s'] },
  // both levels > +2SD in the same run.
  { name: '2-2s across levels', points: [pt(104.5, 'L1', 1), pt(105, 'L2', 1)], expectStatus: 'fail', expectRules: ['1-2s', '2-2s'] },
  // L1 > +2SD in two consecutive runs.
  { name: '2-2s across runs', points: [pt(104.5, 'L1', 1), pt(104.2, 'L1', 2)], expectStatus: 'fail', expectRules: ['1-2s', '2-2s'] },
  // four consecutive runs of L1 > +1SD (z 1.5) but never beyond 2SD.
  { name: '4-1s', points: [1, 2, 3, 4].map((i) => pt(103, 'L1', i)), expectStatus: 'fail', expectRules: ['4-1s'] },
  // ten consecutive below the mean (z -0.5).
  { name: '10x', points: Array.from({ length: 10 }, (_, i) => pt(99, 'L1', i + 1)), expectStatus: 'fail', expectRules: ['10x'] },
  // nine below then one above: no 10x.
  { name: '10x not met', points: [...Array.from({ length: 9 }, (_, i) => pt(99, 'L1', i + 1)), pt(101, 'L1', 10)], expectStatus: 'pass', expectRules: [] },
]

export function runChecks(): string[] {
  const failures: string[] = []
  for (const ex of EXAMPLES) {
    const r = evaluateWestgard(ex.points, T)
    const rules = [...new Set(r.violations.map((v) => v.rule))].sort()
    const want = [...ex.expectRules].sort()
    if (r.status !== ex.expectStatus || rules.join() !== want.join()) {
      failures.push(`${ex.name}: got ${r.status} [${rules}] expected ${ex.expectStatus} [${want}]`)
    }
  }
  // disabled rule is not reported
  const off = evaluateWestgard([pt(107, 'L1', 1)], T, ['1-2s'])
  if (off.violations.some((v) => v.rule === '1-3s')) failures.push('disabled 1-3s still reported')
  // stats
  if (Math.abs(sd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) > 0.001) failures.push('sd wrong')
  if (mean([1, 2, 3]) !== 2) failures.push('mean wrong')
  const reg = linearRegression([1, 2, 3, 4], [2, 4, 6, 8])
  if (Math.abs(reg.slope - 2) > 1e-9 || Math.abs(reg.r2 - 1) > 1e-9) failures.push('regression wrong')
  // validation: perfect linearity passes, bad slope fails
  const lin = computeValidation('linearity', [[10, 10, 10], [20, 20, 20], [40, 40, 40], [80, 80, 80]], {})
  if (lin.outcome !== 'pass') failures.push('linearity ideal should pass')
  const lin2 = computeValidation('linearity', [[10, 5], [20, 10], [40, 20], [80, 40]], {})
  if (lin2.outcome !== 'fail') failures.push('linearity slope 0.5 should fail')
  return failures
}

const failures = runChecks()
if (failures.length) {
  console.error('QC checks FAILED:\n' + failures.join('\n'))
  throw new Error('QC checks failed')
}
console.log(`QC checks passed (${EXAMPLES.length} Westgard examples + stats + validation)`)
