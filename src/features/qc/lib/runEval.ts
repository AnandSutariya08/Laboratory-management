import type { QcLevel, QcMaterial, QcRun, QcSettings, QcStatus, QcTarget, QcViolation } from '../types'
import { zScore } from './stats'
import { evaluateWestgard, type QcPoint, type Target } from './westgard'

export interface Entry {
  testId: string
  paramKey: string
  level: QcLevel
  value: number
}

export interface RunEvaluation {
  status: QcStatus
  violations: QcViolation[]
  z: Record<string, number> // key: testId|paramKey|level
  byParam: Record<string, QcStatus> // key: testId|paramKey
  snapshot: Record<string, { mean: number; sd: number }> // target actually used, key: testId|paramKey|level
}

export const HISTORY_RUNS = 20

export const targetVersionOf = (m: QcMaterial) => m.targetVersion ?? 1

// Target for one machine: a machine-specific target wins over a lot-wide one.
export function targetFor(material: QcMaterial, machineId: string | undefined, testId: string, paramKey: string, level: QcLevel): QcTarget | undefined {
  const all = material.targets.filter((t) => t.testId === testId && t.paramKey === paramKey && t.level === level)
  return all.find((t) => machineId && t.machineId === machineId) ?? all.find((t) => !t.machineId) ?? (machineId ? undefined : all[0])
}

// Parameters (testId|paramKey) a machine can run for this lot.
export function paramsFor(material: QcMaterial, machineId: string | undefined, machineTestIds?: string[]) {
  const seen = new Set<string>()
  const out: { key: string; testId: string; paramKey: string }[] = []
  for (const t of material.targets) {
    if (t.machineId && machineId && t.machineId !== machineId) continue
    if (machineTestIds?.length && !machineTestIds.includes(t.testId)) continue
    const key = `${t.testId}|${t.paramKey}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ key, testId: t.testId, paramKey: t.paramKey })
    }
  }
  return out
}

// Evaluate a (draft) run against the lot's targets and the last 20 runs of that machine + lot.
// History ignores deleted runs, excluded points and points recorded under an older target version
// (changing the target restarts the multi-point rules). `history` may be in any order.
export function evaluateRun(
  material: QcMaterial,
  history: QcRun[],
  entries: Entry[],
  at: number,
  opts: { machineId?: string; settings?: Pick<QcSettings, 'ruleSeverity'> & Partial<Pick<QcSettings, 'westgard' | 'paramRules'>> } = {},
): RunEvaluation {
  const version = targetVersionOf(material)
  // Series reset (calibration / lot change): runs recorded before the latest applicable reset are ignored.
  const resetAt = (material.seriesResets ?? [])
    .filter((x) => !x.machineId || x.machineId === opts.machineId)
    .reduce((m, x) => (x.at <= at ? Math.max(m, x.at) : m), 0)
  const past = history
    .filter((r) => r.materialId === material.id && !r.deleted && (!opts.machineId || r.machineId === opts.machineId) && (r.runAt?.toMillis() ?? 0) < at && (r.runAt?.toMillis() ?? 0) >= resetAt)
    .sort((a, b) => (a.runAt?.toMillis() ?? 0) - (b.runAt?.toMillis() ?? 0))
    .slice(-HISTORY_RUNS)
  const groups = new Map<string, Entry[]>()
  for (const e of entries) {
    const k = `${e.testId}|${e.paramKey}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  const out: RunEvaluation = { status: 'pass', violations: [], z: {}, byParam: {}, snapshot: {} }
  for (const [k, es] of groups) {
    const [testId, paramKey] = k.split('|')
    const targets: Partial<Record<QcLevel, Target>> = {}
    for (const lv of ['L1', 'L2', 'L3'] as QcLevel[]) {
      const t = targetFor(material, opts.machineId, testId, paramKey, lv)
      if (t) targets[lv] = { mean: t.mean, sd: t.sd }
    }
    const points: QcPoint[] = []
    for (const r of past)
      for (const res of r.results)
        if (res.testId === testId && res.paramKey === paramKey && !res.excluded && (res.targetVersion ?? 1) === version)
          points.push({ value: res.value, level: res.level, at: r.runAt?.toMillis() ?? 0 })
    for (const e of es) {
      points.push({ value: e.value, level: e.level, at })
      const t = targets[e.level]
      out.z[`${k}|${e.level}`] = t ? zScore(e.value, t.mean, t.sd) : NaN
      if (t) out.snapshot[`${k}|${e.level}`] = { mean: t.mean, sd: t.sd }
    }
    const ev = evaluateWestgard(points, targets, opts.settings?.paramRules?.[k]?.length ? opts.settings.paramRules[k] : material.rules, opts.settings?.ruleSeverity ?? {}, opts.settings?.westgard)
    out.byParam[k] = ev.status
    out.violations.push(...ev.violations.map((v) => ({ ...v, testId, paramKey })))
  }
  out.status = out.violations.some((v) => v.severity === 'fail') ? 'fail' : out.violations.length ? 'warning' : 'pass'
  return out
}
