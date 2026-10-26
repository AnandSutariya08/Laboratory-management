import { Select } from 'antd'
import { outsourceOptions, useOutsourceLookup } from './lib'
import { formatINR } from '../../lib/money'

// Billing: pick the lab that processes an outsourced test for THIS bill. Renders nothing when
// the test is not outsourced. `value` is the chosen labId (blank = default lab).
export function OutsourceLabSelect({ testId, value, onChange, size = 'small' }: { testId: string; value?: string; onChange: (labId: string) => void; size?: 'small' | 'middle' }) {
  useOutsourceLookup() // re-render when the mapping changes
  const opts = outsourceOptions(testId)
  if (!opts.length) return null
  return (
    <Select
      size={size}
      aria-label="Processing lab"
      style={{ minWidth: 180 }}
      value={value || opts[0].labId}
      onChange={onChange}
      options={opts.map((o) => ({ value: o.labId, label: `${o.labName} (${formatINR(o.cost)})${o.isDefault ? ' - default' : ''}` }))}
    />
  )
}
