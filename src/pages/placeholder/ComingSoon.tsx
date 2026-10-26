import { useLocation } from 'react-router-dom'
import { ToolOutlined } from '@ant-design/icons'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { PageHeader } from '../../design/PageHeader'
import { StatusChip } from '../../design/StatusChip'

// One reusable placeholder for modules whose pages are still being built.
// Other work replaces the route in App.tsx with the real page.
const MODULES: Record<string, { name: string; description: string }> = {
  '/quotations': { name: 'Quotations', description: 'Prepare price estimates for patients and corporate clients and convert an accepted quote into a bill.' },
  '/bulk-registration': { name: 'Bulk Registration', description: 'Register many patients at once for camps and corporate drives from a spreadsheet.' },
  '/radiology': { name: 'Radiology', description: 'Enter findings and verify imaging reports alongside pathology results.' },
  '/tat': { name: 'TAT Analysis', description: 'Turnaround-time analysis from collection to report, by test, department and branch.' },
  '/outsource': { name: 'Outsource', description: 'Track tests sent to processing labs, with rates and result return.' },
  '/smart-report': { name: 'Smart Report', description: 'Trend-aware reports with historical comparison and interpretation.' },
  '/referrals': { name: 'Referral List', description: 'Manage referring doctors, their commissions and referral performance.' },
  '/marketing': { name: 'Marketing Team', description: 'Manage marketing executives, targets and the referrers they handle.' },
  '/processing-labs': { name: 'Processing Labs', description: 'Partner labs that process outsourced tests for this lab.' },
  '/b2b': { name: 'B2B Labs', description: 'Partner labs and collection partners billed on negotiated rates.' },
  '/collection-centres': { name: 'Collection Centres', description: 'Franchise and satellite collection centres and their billing.' },
  '/corporate': { name: 'Corporate Clients', description: 'Corporate accounts with negotiated price lists and consolidated invoicing.' },
}

export default function ComingSoon({ name, description }: { name?: string; description?: string }) {
  const { pathname } = useLocation()
  const m = MODULES[pathname] ?? { name: name ?? 'This module', description: description ?? 'This module is being built.' }
  return (
    <div className="coming-soon">
      <PageHeader title={name ?? m.name} subtitle={<StatusChip variant="info">Coming soon</StatusChip>} />
      <Card>
        <EmptyState
          icon={<ToolOutlined />}
          title={`${name ?? m.name} is on the way`}
          description={description ?? m.description}
        />
      </Card>
    </div>
  )
}
