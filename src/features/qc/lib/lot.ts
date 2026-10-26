import dayjs from 'dayjs'
import type { LotLifecycle, QcMaterial, TargetSource } from '../types'

export const LOT_LABEL: Record<LotLifecycle, string> = { planned: 'Planned', active: 'Active', expired: 'Expired', retired: 'Retired' }
export const SOURCE_LABEL: Record<TargetSource, string> = { manufacturer: 'Manufacturer insert', established: 'Established from our data', peer: 'Peer group', imported: 'Imported' }

// Effective lifecycle of a lot: retired (set by hand) > expired (date) > planned (start date ahead or set planned) > active.
export function lotStatus(m: Partial<Pick<QcMaterial, 'lifecycle' | 'expiry' | 'startDate' | 'active'>>, now = dayjs()): LotLifecycle {
  if (m.lifecycle === 'retired') return 'retired'
  if (m.expiry && dayjs(m.expiry).endOf('day').isBefore(now)) return 'expired'
  if (m.lifecycle === 'planned' || (m.startDate && dayjs(m.startDate).isAfter(now, 'day'))) return 'planned'
  if (m.active === false && !m.lifecycle) return 'retired'
  return 'active'
}
export const lotUsable = (m: QcMaterial) => lotStatus(m) === 'active'

// Other lots with the same material name whose in-use windows overlap this one (neither retired).
export function overlapping(m: QcMaterial, all: QcMaterial[]): QcMaterial[] {
  const from = (x: QcMaterial) => dayjs(x.startDate || x.openedDate || '1970-01-01')
  return all.filter((o) => o.id !== m.id && o.name.trim().toLowerCase() === m.name.trim().toLowerCase() && lotStatus(o) !== 'retired' && lotStatus(m) !== 'retired' && !from(o).isAfter(dayjs(m.expiry)) && !from(m).isAfter(dayjs(o.expiry)))
}
