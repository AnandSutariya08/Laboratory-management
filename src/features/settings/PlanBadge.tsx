import { useLabSettings } from '../../hooks/useCatalogue'
import { StatusChip } from '../../design/StatusChip'
import { planLabel } from './lib'

// Plan / edition chip (SH-04). Wire: render <PlanBadge /> in the sidebar header or footer. Hidden for a lab with no
// subscription record (self-hosted); pass `always` to show "Self-hosted" instead.
export function PlanBadge({ always = false }: { always?: boolean }) {
  const s = useLabSettings()
  if (!s.subscription && !always) return null
  const p = planLabel(s)
  return <StatusChip variant={p.tone}>{p.label}{p.status === 'trial' ? ' (trial)' : p.status === 'expired' ? ' (expired)' : ''}</StatusChip>
}
