import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { App, ConfigProvider } from 'antd'
import { setDoc } from 'firebase/firestore'
import { useSearchParams } from 'react-router-dom'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { Glass } from '../../design/Glass'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { mergeSettings } from '../../hooks/useCatalogue'
import { useLiveDoc } from '../../hooks/useLive'
import { labDoc } from '../../lib/db'
import type { LabSettings } from '../../types'
import { Doctors } from '../../features/settings/sections/Doctors'
import { Machines } from '../../features/settings/sections/Machines'
import { Payments } from '../../features/settings/sections/Payments'
import { Reasons } from '../../features/settings/sections/Reasons'
import { Templates } from '../../features/settings/sections/Templates'
import * as P from '../../features/settings/sections/ProfileSections'
import * as L from '../../features/settings/sections/LabSettingsSections'
import { LabFeatures, InventorySettings } from '../../features/settings/sections/FeatureSections'
import { ReportLayout, ReportLayoutFields, ReportLayoutToggles } from '../../features/settings/sections/ReportLayout'
import { ReportLayoutLetterheads } from '../../features/settings/sections/ReportLayoutLetterheads'
import { ReportLayoutSigning } from '../../features/settings/sections/ReportLayoutSigning'
import { ReportLayoutAccess } from '../../features/settings/sections/ReportLayoutAccess'
import { ReportLayoutRadiology, ReportLayoutPcpndt } from '../../features/settings/sections/ReportLayoutRadiology'
import { logActivity } from '../../layout/activity'
import { BranchOverrides, AbdmCard, RazorpayCard, SubscriptionCard, RegistrationFieldsCard, DeletedMastersCard } from '../../features/settings/sections/ExtraSections'
import { DraftContext } from '../../features/settings/ui'
import '../../features/settings/settings.css'

export type Group = 'settings' | 'profile'
export interface Section { id: string; label: string; group: Group; Comp: ComponentType; local?: boolean }

export const SECTIONS: Section[] = [
  { id: 'registration', label: 'Registration', group: 'settings', Comp: L.Registration },
  { id: 'report', label: 'Report setting', group: 'settings', Comp: L.ReportSetting },
  { id: 'features', label: 'Lab features', group: 'settings', Comp: LabFeatures },
  { id: 'inventory', label: 'Inventory & pricing', group: 'settings', Comp: InventorySettings },
  { id: 'integration', label: 'Integration', group: 'settings', Comp: L.Integration },
  { id: 'b2b', label: 'B2B lab settings', group: 'settings', Comp: L.B2bLab },
  { id: 'accession', label: 'Accession', group: 'settings', Comp: L.Accession },
  { id: 'report-entry', label: 'Report entry', group: 'settings', Comp: L.ReportEntry },
  { id: 'referrals', label: 'Referrals', group: 'settings', Comp: L.Referrals },
  { id: 'nabl', label: 'NABL audit', group: 'settings', Comp: L.NablAudit },
  { id: 'tat', label: 'TAT', group: 'settings', Comp: L.Tat },
  { id: 'payments', label: 'Payment methods', group: 'settings', Comp: Payments, local: true },
  { id: 'reasons', label: 'Reasons', group: 'settings', Comp: Reasons, local: true },
  { id: 'patient-list', label: 'Patient list', group: 'settings', Comp: L.PatientList },
  { id: 'display', label: 'Display', group: 'settings', Comp: L.Display, local: true },
  { id: 'ai', label: 'AI', group: 'settings', Comp: L.Ai },
  { id: 'qc', label: 'Quality control', group: 'settings', Comp: L.Qc },
  { id: 'registration-fields', label: 'Registration fields', group: 'settings', Comp: RegistrationFieldsCard },
  { id: 'deleted-items', label: 'Deleted items', group: 'settings', Comp: DeletedMastersCard, local: true },
  { id: 'razorpay', label: 'Online payments', group: 'settings', Comp: RazorpayCard, local: true },
  { id: 'abdm', label: 'ABDM / ABHA', group: 'settings', Comp: AbdmCard },
  { id: 'subscription', label: 'Subscription and plan', group: 'settings', Comp: SubscriptionCard, local: true },
  { id: 'branch-overrides', label: 'Branch overrides', group: 'profile', Comp: BranchOverrides },
  { id: 'details', label: 'Lab details', group: 'profile', Comp: P.LabDetails },
  { id: 'daily-report', label: 'Daily report recipient', group: 'profile', Comp: P.DailyReport },
  { id: 'report-details', label: 'Report details', group: 'profile', Comp: P.ReportDetails },
  { id: 'report-layout', label: 'Report layout', group: 'profile', Comp: ReportLayout },
  { id: 'report-fields', label: 'Report patient block', group: 'profile', Comp: ReportLayoutFields },
  { id: 'report-options', label: 'Report options', group: 'profile', Comp: ReportLayoutToggles },
  { id: 'letterheads', label: 'Letterhead library', group: 'profile', Comp: ReportLayoutLetterheads },
  { id: 'signing', label: 'Signing rules', group: 'profile', Comp: ReportLayoutSigning },
  { id: 'report-access', label: 'Report access and email sender', group: 'profile', Comp: ReportLayoutAccess },
  { id: 'radiology-config', label: 'Radiology', group: 'profile', Comp: ReportLayoutRadiology },
  { id: 'pcpndt', label: 'PCPNDT', group: 'profile', Comp: ReportLayoutPcpndt },
  { id: 'bill', label: 'Bill details', group: 'profile', Comp: P.BillDetails },
  { id: 'quotation', label: 'Quotation details', group: 'profile', Comp: P.QuotationDetails },
  { id: 'doctors', label: 'Doctor details', group: 'profile', Comp: Doctors },
  { id: 'machines', label: 'Machine list', group: 'profile', Comp: Machines, local: true },
  { id: 'b2b-invoice', label: 'B2B invoice', group: 'profile', Comp: P.B2bInvoice },
  { id: 'corporate-invoice', label: 'Corporate invoice', group: 'profile', Comp: P.CorporateInvoice },
  { id: 'templates', label: 'Message templates', group: 'profile', Comp: Templates },
  { id: 'doc-templates', label: 'Document templates', group: 'profile', Comp: P.DocTemplates },
]
const ALIASES: Record<string, string> = { messaging: 'templates', whatsapp: 'templates', profile: 'details', report_entry: 'report-entry' }

// The 11 tabs of the Lab Settings modal; each lists the section ids it shows (LS: Lab Settings modal from the gear).
export const MODAL_TABS: { key: string; label: string; ids: string[] }[] = [
  { key: 'general', label: 'General', ids: ['details', 'registration', 'registration-fields', 'display'] },
  { key: 'reports', label: 'Reports', ids: ['report', 'report-details', 'report-layout', 'report-fields', 'report-options', 'letterheads', 'signing', 'report-access'] },
  { key: 'billing', label: 'Billing', ids: ['bill', 'quotation', 'payments', 'inventory'] },
  { key: 'samples', label: 'Samples and machines', ids: ['accession', 'machines', 'integration'] },
  { key: 'results', label: 'Results', ids: ['report-entry', 'tat', 'nabl', 'qc'] },
  { key: 'partners', label: 'Partners', ids: ['b2b', 'referrals', 'b2b-invoice', 'corporate-invoice'] },
  { key: 'messaging', label: 'Messaging', ids: ['templates', 'doc-templates', 'daily-report'] },
  { key: 'radiology', label: 'Radiology', ids: ['radiology-config', 'pcpndt'] },
  { key: 'branches', label: 'Branches', ids: ['branch-overrides'] },
  { key: 'modules', label: 'Modules and AI', ids: ['features', 'ai', 'patient-list', 'reasons', 'doctors'] },
  { key: 'account', label: 'Account', ids: ['subscription', 'razorpay', 'abdm', 'deleted-items'] },
]

interface WorkspaceProps {
  sectionId: string | null
  onSection: (id: string) => void
  ids?: string[] // limit the left nav to these sections (modal tabs)
  header?: (info: { group: Group; canEdit: boolean }) => ReactNode
}

export function SettingsWorkspace({ sectionId, onSection, ids, header }: WorkspaceProps) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const { data, loading } = useLiveDoc<Partial<LabSettings>>(labDoc(), [])
  const [draft, setDraft] = useState<LabSettings | null>(null)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  // Fill once from the live doc so later snapshots don't clobber edits.
  useEffect(() => {
    if (!draft && !loading) setDraft(mergeSettings(data))
  }, [data, loading, draft])

  const raw = sectionId ?? 'registration'
  const section = SECTIONS.find((s) => s.id === (ALIASES[raw] ?? raw)) ?? SECTIONS[0]
  const group = section.group
  // PRO-15: Lab profile and Lab settings are separate permissions.
  const canEdit = can(profile, group === 'profile' ? 'labprofile.edit' : 'settings.manage')

  const ctx = useMemo(
    () =>
      draft && {
        draft,
        canEdit,
        set: (path: (string | number)[], value: unknown) => {
          setDraft((cur) => {
            if (!cur) return cur
            const next = structuredClone(cur) as unknown as Record<string, unknown>
            let o = next
            // Groups that were never saved (optional settings) are created on the way down.
            path.slice(0, -1).forEach((k) => {
              if (o[k as string] == null || typeof o[k as string] !== 'object') o[k as string] = {}
              o = o[k as string] as Record<string, unknown>
            })
            o[path[path.length - 1] as string] = value
            return next as unknown as LabSettings
          })
          setDirty((d) => new Set(d).add(String(path[0])))
        },
      },
    [draft, canEdit],
  )

  const save = async () => {
    if (!draft) return
    if (!draft.name.trim()) return message.error('Lab name is required')
    if (!draft.billPrefix.trim()) return message.error('Bill number prefix is required')
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {}
      dirty.forEach((k) => (patch[k] = (draft as unknown as Record<string, unknown>)[k]))
      if ('billPrefix' in patch) patch.billPrefix = draft.billPrefix.trim()
      // Image data URLs would bloat the audit entry: keep only their presence.
      const slim = (o: unknown) => JSON.parse(JSON.stringify(o ?? null, (_k, v) => (typeof v === 'string' && v.length > 300 ? `[${v.length} chars]` : v)))
      const beforeSnap = slim(Object.fromEntries([...dirty].map((k) => [k, (data as Record<string, unknown>)[k]])))
      await setDoc(labDoc(), patch, { merge: true })
      void logActivity('settings', `Settings changed: ${[...dirty].join(', ')} by ${profile?.name ?? 'user'}`, 'labs', { category: 'SETTINGS', before: beforeSnap, after: slim(patch) })
      setDirty(new Set())
      message.success('Settings saved')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const Comp = section.Comp
  const navItems = ids ? SECTIONS.filter((s) => ids.includes(s.id)) : SECTIONS.filter((s) => s.group === group)
  return (
    <>
      {header?.({ group, canEdit })}
      <div className="st-layout">
        <Card as="div" className="st-nav" aria-label="Sections" padding="var(--s-2)">
          <nav aria-label={group === 'settings' ? 'Lab settings sections' : 'Lab profile sections'} style={{ display: 'contents' }}>
            {navItems.map((s) => (
              <button key={s.id} type="button" className="st-nav__item" aria-current={s.id === section.id ? 'page' : undefined} onClick={() => onSection(s.id)}>
                {s.label}
              </button>
            ))}
          </nav>
        </Card>
        <div className="st-body">
          {ctx ? (
            <DraftContext.Provider value={ctx}>
              <ConfigProvider componentDisabled={!canEdit}>
                <Comp />
              </ConfigProvider>
            </DraftContext.Provider>
          ) : (
            <Card padding="var(--s-5)">Loading settings...</Card>
          )}
          {canEdit && !section.local && dirty.size > 0 && (
            <Glass className="st-savebar" radius="var(--r-lg, 20px)" role="region" aria-label="Unsaved changes">
              <span>You have unsaved changes.</span>
              <div className="st-actions">
                <Button onClick={() => { setDraft(null); setDirty(new Set()) }}>Discard</Button>
                <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button>
              </div>
            </Glass>
          )}
        </div>
      </div>
    </>
  )
}

export default function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const goto = (id: string) => setParams({ tab: id }, { replace: true })
  return (
    <SettingsWorkspace
      sectionId={params.get('tab')}
      onSection={goto}
      header={({ group, canEdit }) => (
        <PageHeader
          title={group === 'settings' ? 'Lab settings' : 'Lab profile'}
          subtitle={canEdit ? 'Changes apply to the whole lab once saved.' : 'You can view these settings but not change them.'}
          actions={
            <Segmented
              aria-label="Settings area"
              value={group}
              onChange={(g) => goto(SECTIONS.find((s) => s.group === g)!.id)}
              options={[{ value: 'settings', label: 'Lab settings' }, { value: 'profile', label: 'Lab profile' }]}
            />
          }
        />
      )}
    />
  )
}
