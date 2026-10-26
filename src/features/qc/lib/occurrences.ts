import { type Dayjs } from 'dayjs'
import { doc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { useEffect, useRef } from 'react'
import { db, LAB_ID } from '../../../firebase'
import { QC, type Capa, type QcMachine, type QcOccurrence, type QcOccurrenceStatus, type QcRun, type QcSchedule, type QcSettings, type QcShift } from '../types'

// ---------------------------------------------------------------------------------------------
// Scheduled QC slots (occurrences). A schedule on a machine expands into slots per day:
//   time         one slot per listed time (matched to a run within the "machine reading match window")
//   perShift     one slot per lab shift (a run inside the shift window satisfies it)
//   perNPatients not calendar based: see patientsDue()
// Each slot is persisted (qcOccurrences) so SCHEDULED / MISSED / NOT_APPLICABLE and the downstream
// states are an audit record, not just a dashboard calculation. Status is DERIVED from runs and
// CAPAs by occurrenceStatus(); syncOccurrences() only writes what changed.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_SHIFTS: QcShift[] = [
  { id: 'morning', name: 'Morning', start: '06:00', end: '14:00' },
  { id: 'evening', name: 'Evening', start: '14:00', end: '22:00' },
  { id: 'night', name: 'Night', start: '22:00', end: '06:00' },
]

export interface Slot {
  id: string
  machine: QcMachine
  schedule: QcSchedule
  day: string
  slotKey: string
  slotLabel: string
  dueAt: number
  endAt: number
  missAfter: number // ms: missed once now passes this
  windowFrom: number // a run at or after this (and before windowTo) can satisfy the slot
  windowTo: number
}

export const slotId = (machineId: string, scheduleId: string, day: string, slotKey: string) => `${machineId}__${scheduleId}__${day}__${slotKey}`
const at = (day: Dayjs, t: string) => {
  const [h, m] = t.split(':').map(Number)
  return day.startOf('day').hour(h || 0).minute(m || 0).valueOf()
}

export const shiftsOf = (settings?: Pick<QcSettings, 'shifts'>): QcShift[] => (settings?.shifts?.length ? settings.shifts : DEFAULT_SHIFTS)

/** Is the schedule due on this calendar day (frequency + days)? */
export function dueOnDay(s: QcSchedule, d: Dayjs): boolean {
  if (!s.active) return false
  if (s.frequency === 'daily') return true
  if (s.frequency === 'weekly') return s.days.includes(d.day())
  return s.days.includes(d.date())
}

/** Slots of one schedule on one day. */
export function slotsOn(machine: QcMachine, s: QcSchedule, d: Dayjs, settings: Pick<QcSettings, 'shifts' | 'graceMinutes' | 'matchWindowHours'>): Slot[] {
  if (!dueOnDay(s, d) || s.recurrence === 'perNPatients') return []
  const grace = (s.graceMinutes ?? settings.graceMinutes ?? 30) * 60_000
  const win = Math.max(1, settings.matchWindowHours ?? 24) * 3_600_000
  const day = d.format('YYYY-MM-DD')
  if (s.recurrence === 'perShift') {
    const all = shiftsOf(settings)
    const chosen = s.shiftIds?.length ? all.filter((x) => s.shiftIds!.includes(x.id)) : all
    return chosen.map((sh) => {
      const dueAt = at(d, sh.start)
      let endAt = at(d, sh.end)
      if (endAt <= dueAt) endAt += 86_400_000
      return { id: slotId(machine.id, s.id, day, sh.id), machine, schedule: s, day, slotKey: sh.id, slotLabel: sh.name, dueAt, endAt, missAfter: endAt + grace, windowFrom: dueAt, windowTo: endAt }
    })
  }
  return s.times.map((t) => {
    const dueAt = at(d, t)
    return { id: slotId(machine.id, s.id, day, t), machine, schedule: s, day, slotKey: t, slotLabel: t, dueAt, endAt: dueAt, missAfter: dueAt + grace, windowFrom: dueAt - win, windowTo: dueAt + win }
  })
}

/**
 * Assign runs to slots. Each run satisfies at most one slot; a run may satisfy a timed slot when it is
 * within the match window of it (Setting: machine-reading match window, hours), a shift slot when it
 * falls inside the shift. The closest (slot, run) pairs are assigned first.
 */
export function matchRuns(slots: Slot[], runs: QcRun[]): Map<string, QcRun> {
  const out = new Map<string, QcRun>()
  const used = new Set<string>()
  const pairs: { slot: Slot; run: QcRun; dist: number }[] = []
  for (const sl of slots) {
    for (const r of runs) {
      if (r.deleted || r.machineId !== sl.machine.id || (sl.schedule.materialId && r.materialId !== sl.schedule.materialId)) continue
      const t = r.runAt?.toMillis()
      if (t == null || t < sl.windowFrom || t > sl.windowTo) continue
      pairs.push({ slot: sl, run: r, dist: sl.schedule.recurrence === 'perShift' ? t - sl.dueAt : Math.abs(t - sl.dueAt) })
    }
  }
  pairs.sort((a, b) => a.dist - b.dist)
  for (const p of pairs) {
    if (out.has(p.slot.id) || used.has(`${p.slot.schedule.id}|${p.run.id}`)) continue
    out.set(p.slot.id, p.run)
    used.add(`${p.slot.schedule.id}|${p.run.id}`)
  }
  return out
}

/** Status of a slot derived from its run, CAPAs and the clock (the persisted state machine). */
export function occurrenceStatus(slot: Slot, run: QcRun | undefined, capas: Capa[], na: boolean, now: number, current?: QcOccurrenceStatus): QcOccurrenceStatus {
  if (na) return 'notApplicable'
  if (run) {
    if (run.status === 'fail') return capas.some((c) => c.runId === run.id && c.status !== 'closed') ? 'capaOpen' : 'failed'
    if (run.approval === 'pending') return 'submitted'
    if (run.approval === 'approved') return 'approved'
    return run.status === 'warning' ? 'warning' : 'passed'
  }
  if (now >= slot.missAfter) return 'missed'
  return current === 'inProgress' ? 'inProgress' : 'scheduled'
}

export interface SlotView {
  slot: Slot
  status: QcOccurrenceStatus
  run?: QcRun
}

/** Every slot of the machines in [from, to] (not after `now`), with its derived status. */
export function slotViews(
  machines: QcMachine[],
  runs: QcRun[],
  capas: Capa[],
  from: Dayjs,
  to: Dayjs,
  settings: Pick<QcSettings, 'shifts' | 'graceMinutes' | 'matchWindowHours'>,
  now: number = Date.now(),
  existing: Map<string, QcOccurrence> = new Map(),
): SlotView[] {
  const out: SlotView[] = []
  for (const m of machines) {
    if (m.active === false) continue
    const na = new Set((m.notApplicable ?? []).map((x) => `${x.scheduleId}|${x.day}|${x.time}`))
    for (const s of m.schedules ?? []) {
      const slots: Slot[] = []
      for (let d = from.startOf('day'); !d.isAfter(to.endOf('day')) && d.valueOf() <= now; d = d.add(1, 'day')) slots.push(...slotsOn(m, s, d, settings))
      const matched = matchRuns(slots, runs)
      for (const sl of slots) {
        const run = matched.get(sl.id)
        const isNa = na.has(`${s.id}|${sl.day}|${sl.slotKey}`)
        out.push({ slot: sl, run, status: occurrenceStatus(sl, run, capas, isNa, now, existing.get(sl.id)?.status) })
      }
    }
  }
  return out
}

/** Patient-count schedules: samples run on the machine since its last QC run, and whether a run is due. */
export interface PatientDue { machine: QcMachine; schedule: QcSchedule; since: number; count: number; every: number; due: boolean }
export function patientsDue(
  machines: QcMachine[],
  runs: QcRun[],
  orders: { createdAt?: { toMillis?: () => number } | null; items: { testIds: string[]; status: string; isCharge?: boolean }[]; deleted?: boolean }[],
): PatientDue[] {
  const out: PatientDue[] = []
  for (const m of machines) {
    if (m.active === false) continue
    for (const s of m.schedules ?? []) {
      if (!s.active || s.recurrence !== 'perNPatients' || !s.everyNPatients) continue
      const last = runs.filter((r) => !r.deleted && r.machineId === m.id && (!s.materialId || r.materialId === s.materialId)).reduce((mx, r) => Math.max(mx, r.runAt?.toMillis() ?? 0), 0)
      const ids = new Set(m.testIds ?? [])
      const count = orders.filter((o) => !o.deleted && (o.createdAt?.toMillis?.() ?? 0) > last && o.items.some((i) => !i.isCharge && i.status !== 'refunded' && i.testIds.some((t) => ids.has(t)))).length
      out.push({ machine: m, schedule: s, since: last, count, every: s.everyNPatients, due: count >= s.everyNPatients })
    }
  }
  return out
}

/**
 * Persist the slot states. Writes only new slots and changed statuses; never moves a slot backwards
 * out of a terminal state it was derived into (e.g. a run later deleted re-derives to scheduled/missed,
 * which is correct). Needs qc.run rights; callers ignore failures (read-only users just see derived state).
 */
export async function syncOccurrences(views: SlotView[], existing: Map<string, QcOccurrence>, branchId: string, assignees: Record<string, string> = {}): Promise<number> {
  const changes = views.filter((v) => {
    const cur = existing.get(v.slot.id)
    return !cur || cur.status !== v.status || (v.run && cur.runId !== v.run.id) || (!v.run && !!cur.runId)
  })
  if (!changes.length) return 0
  for (let i = 0; i < changes.length; i += 400) {
    const batch = writeBatch(db)
    for (const v of changes.slice(i, i + 400)) {
      const s = v.slot
      batch.set(doc(db, 'labs', LAB_ID, QC.occurrences, s.id), {
        branchId,
        machineId: s.machine.id,
        machineName: s.machine.name,
        scheduleId: s.schedule.id,
        materialId: s.schedule.materialId ?? '',
        day: s.day,
        slotKey: s.slotKey,
        slotLabel: s.slotLabel,
        dueAt: s.dueAt,
        endAt: s.endAt,
        status: v.status,
        runId: v.run?.id ?? '',
        runNo: v.run?.runNo ?? '',
        assignedTo: s.schedule.assignedTo ?? assignees[s.schedule.id] ?? '',
        updatedAt: serverTimestamp(),
      })
    }
    await batch.commit()
  }
  return changes.length
}

/** Keep qcOccurrences in step with the dashboard's range; one write pass per change of inputs. */
export function useOccurrenceSync(enabled: boolean, views: SlotView[], existing: Map<string, QcOccurrence>, branchId: string) {
  const last = useRef('')
  useEffect(() => {
    if (!enabled || !views.length) return
    const sig = views.map((v) => `${v.slot.id}:${v.status}:${v.run?.id ?? ''}`).join('|') + '#' + [...existing.values()].map((e) => `${e.id}:${e.status}`).join('|')
    if (sig === last.current) return
    last.current = sig
    void syncOccurrences(views, existing, branchId).catch(() => {
      /* read-only user or offline: the derived view still works */
    })
  }, [enabled, views, existing, branchId])
}

export const OCC_LABEL: Record<QcOccurrenceStatus, string> = {
  scheduled: 'Scheduled', inProgress: 'In progress', submitted: 'Submitted', passed: 'Passed', warning: 'Warning', failed: 'Failed',
  capaOpen: 'CAPA open', approved: 'Approved', missed: 'Missed', notApplicable: 'Not applicable',
}
