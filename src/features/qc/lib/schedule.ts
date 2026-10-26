import dayjs, { type Dayjs } from 'dayjs'
import type { QcMachine, QcRun, QcSchedule, QcSettings, QcShift } from '../types'
import { shiftsOf, slotViews, slotsOn } from './occurrences'

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const scheduleDueToday = (s: QcSchedule, now: Dayjs = dayjs()) => {
  if (!s.active) return false
  if (s.frequency === 'daily') return true
  if (s.frequency === 'weekly') return s.days.includes(now.day())
  return s.days.includes(now.date())
}

export const scheduleText = (s: QcSchedule, shifts?: QcShift[]) => {
  const when = s.frequency === 'daily' ? 'Daily' : s.frequency === 'weekly' ? `Weekly on ${s.days.map((d) => WEEKDAYS[d]).join(', ')}` : `Monthly on day ${s.days.join(', ')}`
  if (s.recurrence === 'perShift') {
    const all = shiftsOf({ shifts })
    const chosen = s.shiftIds?.length ? all.filter((x) => s.shiftIds!.includes(x.id)) : all
    return `${when}, once per shift (${chosen.map((x) => x.name).join(', ')})`
  }
  if (s.recurrence === 'perNPatients') return `${when}, after every ${s.everyNPatients ?? '?'} patients`
  return `${when} at ${s.times.join(', ')}`
}

export interface MissedQc {
  machine: QcMachine
  schedule: QcSchedule
  day: string // YYYY-MM-DD
  times: string[] // missed slot keys (HH:mm or shift id)
  labels: string[] // what to show for them (HH:mm or shift name)
  count: number
}

export const naKey = (machineId: string, scheduleId: string, day: string, time: string) => `${machineId}|${scheduleId}|${day}|${time}`

/**
 * Missed QC over a date range, from the same slot matching that persists the occurrences: a slot is missed
 * once its time (a shift: its end) plus the grace period has passed with no run matched to it. Slots excused
 * as "not applicable" are not counted. A run entered late still counts if it falls in the slot's window.
 */
export function missedInRange(
  machines: QcMachine[],
  runs: QcRun[],
  from: Dayjs,
  to: Dayjs,
  defaultGrace = 30,
  now: Dayjs = dayjs(),
  settings: Partial<Pick<QcSettings, 'shifts' | 'matchWindowHours'>> = {},
): MissedQc[] {
  const views = slotViews(machines, runs, [], from, to, { graceMinutes: defaultGrace, shifts: settings.shifts, matchWindowHours: settings.matchWindowHours ?? 24 }, now.valueOf())
  const groups = new Map<string, MissedQc>()
  for (const v of views) {
    if (v.status !== 'missed') continue
    const k = `${v.slot.machine.id}|${v.slot.schedule.id}|${v.slot.day}`
    const g = groups.get(k) ?? { machine: v.slot.machine, schedule: v.slot.schedule, day: v.slot.day, times: [], labels: [], count: 0 }
    g.times.push(v.slot.slotKey)
    g.labels.push(v.slot.slotLabel)
    g.count++
    groups.set(k, g)
  }
  return [...groups.values()].sort((a, b) => b.day.localeCompare(a.day))
}

/** Next occurrences of a schedule (for the preview in Setup). */
export function nextOccurrences(s: QcSchedule, n = 5, now: Dayjs = dayjs(), settings: Partial<Pick<QcSettings, 'shifts' | 'matchWindowHours'>> = {}): string[] {
  const out: string[] = []
  const m = { id: 'x', name: '', departmentId: '', serial: '', testIds: [], active: true } as QcMachine
  for (let i = 0; i < 400 && out.length < n; i++) {
    const d = now.add(i, 'day')
    for (const sl of slotsOn(m, s, d, { shifts: settings.shifts, matchWindowHours: settings.matchWindowHours ?? 24 })) if (sl.dueAt > now.valueOf() && out.length < n) out.push(`${dayjs(sl.dueAt).format('ddd DD MMM, HH:mm')}${s.recurrence === 'perShift' ? ` (${sl.slotLabel})` : ''}`)
  }
  return out
}
