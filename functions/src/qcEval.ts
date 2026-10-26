import { getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { FIRESTORE_DB } from './secrets'

// Server-side Westgard multi-rule evaluation for machine-fed QC runs.
//
// The analyser ingest stores a run with a quick 1-2s / 1-3s check only. This trigger re-evaluates every run with
// source 'analyser' against the lot's targets and the machine's last 20 runs, using the same rules as the web app
// (src/features/qc/lib/westgard.ts and runEval.ts, ported here as pure functions): 1-2s, 1-3s, 2-2s, R-4s, 4-1s,
// 10x with the lab's rule list, severity overrides and across-levels / across-runs profile. The result overwrites
// status and violations on the run and sets multiruleChecked = true. Approval fields are left untouched.

type Level = 'L1' | 'L2' | 'L3'
type Rule = '1-2s' | '1-3s' | '2-2s' | 'R-4s' | '4-1s' | '10x'
type Sev = 'warning' | 'fail'
interface Point { value: number; level: Level; at: number }
interface Target { mean: number; sd: number }
interface Violation { rule: Rule; level: Level | 'all'; message: string; severity: Sev }

const DEFAULT_SEVERITY: Record<Rule, Sev> = { '1-2s': 'warning', '1-3s': 'fail', '2-2s': 'fail', 'R-4s': 'fail', '4-1s': 'fail', '10x': 'fail' }
const DEFAULT_RULES: Rule[] = ['1-2s', '1-3s', '2-2s', 'R-4s', '4-1s', '10x']
const HISTORY_RUNS = 20
const zScore = (x: number, mean: number, sd: number) => (sd > 0 ? (x - mean) / sd : NaN)

export function evaluateWestgard(
  points: Point[],
  targets: Partial<Record<Level, Target>>,
  enabled: Rule[] = DEFAULT_RULES,
  severity: Partial<Record<Rule, Sev>> = {},
  scope: { acrossLevels?: boolean; acrossRuns?: boolean } = {},
): { status: 'pass' | 'warning' | 'fail'; violations: Violation[] } {
  const acrossLevels = scope.acrossLevels !== false
  const acrossRuns = scope.acrossRuns !== false
  const on = new Set(enabled)
  const sev = (r: Rule) => severity[r] ?? DEFAULT_SEVERITY[r]
  const violations: Violation[] = []
  const add = (rule: Rule, level: Level | 'all', message: string) => {
    if (!on.has(rule)) return
    if (violations.some((v) => v.rule === rule && v.level === level)) return
    violations.push({ rule, level, message, severity: sev(rule) })
  }
  const zp = points
    .map((p, i) => {
      const t = targets[p.level]
      return t && t.sd > 0 && Number.isFinite(p.value) ? { ...p, i, z: zScore(p.value, t.mean, t.sd) } : null
    })
    .filter((p): p is Point & { i: number; z: number } => !!p)
    .sort((a, b) => a.at - b.at || a.i - b.i)
  if (!zp.length) return { status: 'pass', violations }
  const lastAt = zp[zp.length - 1].at
  const cur = zp.filter((p) => p.at === lastAt)
  const fmtZ = (z: number) => (z > 0 ? '+' : '') + z.toFixed(2)
  for (const p of cur) {
    if (Math.abs(p.z) > 2) add('1-2s', p.level, `${p.level} exceeds 2SD (z ${fmtZ(p.z)})`)
    if (Math.abs(p.z) > 3) add('1-3s', p.level, `${p.level} exceeds 3SD (z ${fmtZ(p.z)})`)
  }
  const hi = cur.filter((p) => p.z > 2)
  const lo = cur.filter((p) => p.z < -2)
  for (const grp of [hi, lo]) {
    if (acrossLevels && grp.length >= 2) add('2-2s', 'all', `${grp.map((p) => p.level).join(' and ')} both exceed ${grp[0].z > 0 ? '+' : '-'}2SD within the run`)
  }
  const levelsNow = [...new Set(cur.map((p) => p.level))]
  const series = (lv: Level) => zp.filter((p) => p.level === lv)
  for (const lv of acrossRuns ? levelsNow : []) {
    const s = series(lv)
    if (s.length >= 2) {
      const [a, b] = s.slice(-2)
      if ((a.z > 2 && b.z > 2) || (a.z < -2 && b.z < -2)) add('2-2s', lv, `${lv} exceeded ${b.z > 0 ? '+' : '-'}2SD in two consecutive runs`)
    }
  }
  if (acrossLevels && cur.length >= 2) {
    const zs = cur.map((p) => p.z)
    const mx = Math.max(...zs)
    const mn = Math.min(...zs)
    if (mx > 2 && mn < -2 && mx - mn > 4) add('R-4s', 'all', `Range of z across levels is ${(mx - mn).toFixed(2)} (+2SD and -2SD both exceeded)`)
  }
  const lastN = <T,>(s: T[], n: number, f: (p: T) => boolean) => s.length >= n && s.slice(-n).every(f)
  const check = (rule: Rule, n: number, f: (z: number) => boolean, what: string) => {
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

const ms = (t: unknown): number => (t as { toMillis?: () => number } | null | undefined)?.toMillis?.() ?? 0

// A machine-specific target wins over a lot-wide one.
function targetFor(material: DocumentData, machineId: string, testId: string, paramKey: string, level: Level): DocumentData | undefined {
  const all = ((material.targets ?? []) as DocumentData[]).filter((t) => t.testId === testId && t.paramKey === paramKey && t.level === level)
  return all.find((t) => machineId && t.machineId === machineId) ?? all.find((t) => !t.machineId)
}

export interface EvalOut { status: 'pass' | 'warning' | 'fail'; violations: (Violation & { testId: string; paramKey: string })[] }

// Port of runEval.evaluateRun for one stored run.
export function evaluateStoredRun(run: DocumentData, material: DocumentData, history: DocumentData[], qcSettings: DocumentData): EvalOut {
  const machineId = String(run.machineId ?? '')
  const at = ms(run.runAt) || Date.now()
  const version = Number(material.targetVersion ?? 1)
  const resetAt = ((material.seriesResets ?? []) as DocumentData[])
    .filter((x) => !x.machineId || x.machineId === machineId)
    .reduce((m, x) => (Number(x.at) <= at ? Math.max(m, Number(x.at)) : m), 0)
  const past = history
    .filter((r) => r.materialId === material.id && !r.deleted && (!machineId || r.machineId === machineId) && ms(r.runAt) < at && ms(r.runAt) >= resetAt)
    .sort((a, b) => ms(a.runAt) - ms(b.runAt))
    .slice(-HISTORY_RUNS)
  const groups = new Map<string, DocumentData[]>()
  for (const e of (run.results ?? []) as DocumentData[]) {
    const k = `${e.testId}|${e.paramKey}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  const out: EvalOut = { status: 'pass', violations: [] }
  const paramRules = (qcSettings.paramRules ?? {}) as Record<string, Rule[]>
  const severity = (qcSettings.ruleSeverity ?? {}) as Partial<Record<Rule, Sev>>
  const scope = (qcSettings.westgard ?? {}) as { acrossLevels?: boolean; acrossRuns?: boolean }
  for (const [k, es] of groups) {
    const [testId, paramKey] = k.split('|')
    const targets: Partial<Record<Level, Target>> = {}
    for (const lv of ['L1', 'L2', 'L3'] as Level[]) {
      const t = targetFor(material, machineId, testId, paramKey, lv)
      if (t) targets[lv] = { mean: Number(t.mean), sd: Number(t.sd) }
    }
    const points: Point[] = []
    for (const r of past)
      for (const res of (r.results ?? []) as DocumentData[])
        if (res.testId === testId && res.paramKey === paramKey && !res.excluded && Number(res.targetVersion ?? 1) === version) points.push({ value: Number(res.value), level: res.level, at: ms(r.runAt) })
    for (const e of es) points.push({ value: Number(e.value), level: e.level, at })
    const rules = paramRules[k]?.length ? paramRules[k] : ((material.rules as Rule[] | undefined)?.length ? (material.rules as Rule[]) : (qcSettings.rules as Rule[] | undefined) ?? DEFAULT_RULES)
    const ev = evaluateWestgard(points, targets, rules, severity, scope)
    out.violations.push(...ev.violations.map((v) => ({ ...v, testId, paramKey })))
  }
  out.status = out.violations.some((v) => v.severity === 'fail') ? 'fail' : out.violations.length ? 'warning' : 'pass'
  return out
}

export const evaluateMachineQcRun = onDocumentCreated({ document: 'labs/{labId}/qcRuns/{runId}', database: FIRESTORE_DB, region: 'asia-south1' }, async (event) => {
  const run = event.data?.data()
  if (!run || run.source !== 'analyser' || run.multiruleChecked === true) return
  if (!getApps().length) initializeApp()
  const db = getFirestore(FIRESTORE_DB)
  const { labId, runId } = event.params
  try {
    const matId = String(run.materialId ?? '')
    if (!matId) return
    const [matSnap, labSnap, histSnap] = await Promise.all([
      db.doc(`labs/${labId}/qcMaterials/${matId}`).get(),
      db.doc(`labs/${labId}`).get(),
      db.collection(`labs/${labId}/qcRuns`).where('materialId', '==', matId).where('machineId', '==', String(run.machineId ?? '')).get(),
    ])
    const material = matSnap.data()
    if (!material) return
    // Equality filters only (no composite index); the newest runs are picked here.
    const history = histSnap.docs.filter((d) => d.id !== runId).map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms((b as DocumentData).runAt) - ms((a as DocumentData).runAt)).slice(0, HISTORY_RUNS + 5)
    const ev = evaluateStoredRun(run, { ...material, id: matId }, history, (labSnap.data()?.qcSettings ?? {}) as DocumentData)
    await db.doc(`labs/${labId}/qcRuns/${runId}`).update({ status: ev.status, violations: ev.violations, multiruleChecked: true, multiruleAt: FieldValue.serverTimestamp() })
  } catch (e) {
    console.error('machine QC evaluation failed', e)
  }
})
