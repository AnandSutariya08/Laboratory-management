import type { Parameter, ParamValue } from '../../types'

// Static, plain-language notes (no AI). Chosen only by the value's flag.
export function plainNote(p: Parameter, v: ParamValue, range: string): { tone: 'warn' | 'bad'; label: string; text: string } {
  const r = range ? ` (usual range ${range}${p.unit ? ` ${p.unit}` : ''})` : ''
  if (v.critical)
    return {
      tone: 'bad',
      label: v.abnormal === 'high' ? 'Very high' : v.abnormal === 'low' ? 'Very low' : 'Needs urgent attention',
      text: `Your ${p.name} is far outside the safe range${r}. Please contact your doctor today.`,
    }
  if (v.abnormal === 'high')
    return { tone: 'warn', label: 'High', text: `Your ${p.name} is higher than the usual range${r}. Many everyday things can cause this. Please talk to your doctor about it.` }
  return { tone: 'warn', label: 'Low', text: `Your ${p.name} is lower than the usual range${r}. Many everyday things can cause this. Please talk to your doctor about it.` }
}
