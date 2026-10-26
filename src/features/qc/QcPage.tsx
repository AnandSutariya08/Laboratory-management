import { Suspense } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { SkeletonRows } from '../../design/Skeletons'
import './qc.css'
import DashboardSection from './components/DashboardSection'
import DiscardSection from './components/DiscardSection'
import EqasSection from './components/EqasSection'
import IlcSection from './components/IlcSection'
import RunSection from './components/RunSection'
import SetupSection from './components/SetupSection'
import ValidationSection from './components/ValidationSection'
import { can, useAuth } from '../../auth/AuthProvider'

const ALL_SECTIONS = [
  { key: 'dashboard', path: '/qc', label: 'Dashboard', perm: 'qc.view', el: <DashboardSection /> },
  { key: 'run', path: '/qc/run', label: 'Run QC', perm: 'qc.run', el: <RunSection /> },
  { key: 'setup', path: '/qc/setup', label: 'QC Setup', perm: 'qc.setup', el: <SetupSection /> },
  { key: 'eqas', path: '/qc/eqas', label: 'EQAS', perm: 'qc.run', el: <EqasSection /> },
  { key: 'ilc', path: '/qc/ilc', label: 'ILC', perm: 'qc.run', el: <IlcSection /> },
  { key: 'validation', path: '/qc/validation', label: 'Equipment Validation', perm: 'qc.setup', el: <ValidationSection /> },
  { key: 'discard', path: '/qc/discard', label: 'Sample Discarding', perm: 'qc.run', el: <DiscardSection /> },
] as const

export default function QcPage() {
  const { section } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const SECTIONS = ALL_SECTIONS.filter((s) => can(profile, s.perm))
  const active = SECTIONS.find((s) => (section ? s.key === section : s.key === 'dashboard'))
  if (!active) return <Navigate to="/qc" replace />
  return (
    <div>
      <PageHeader title="Quality Control" subtitle="Internal QC, external assessment, equipment validation and sample discarding." />
      <div className="qc-subnav">
        <Segmented
          aria-label="Quality control sections"
          value={active.key}
          onChange={(k) => navigate(SECTIONS.find((s) => s.key === k)!.path)}
          options={SECTIONS.map((s) => ({ value: s.key, label: s.label }))}
        />
      </div>
      <Suspense fallback={<SkeletonRows />}>{active.el}</Suspense>
    </div>
  )
}
