import { useEffect, useState } from 'react'
import { Drawer, Select, Switch } from 'antd'
import { Button } from '../../design/Button'
import { FieldGrid, FormSection, SettingRow } from '../../design/FormLayout'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useBranch } from '../../branch/BranchProvider'
import { useLiveQuery } from '../../hooks/useLive'
import { query, orderBy } from 'firebase/firestore'
import { col, paths } from '../../lib/db'
import type { UserProfile } from '../../types'
import { EMPTY_FILTERS, useMaster } from './lib'
import type { Filters } from './types'

const opt = (xs: { id: string; name: string }[]) => xs.map((x) => ({ value: x.id, label: x.name }))
const byName = (xs: { name: string }[]) => xs.map((x) => ({ value: x.name, label: x.name }))

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="pl-field">
      <span className="pl-field__label">{label}</span>
      {children}
    </label>
  )
}

export default function FiltersDrawer({
  open,
  value,
  onClose,
  onApply,
  showBranch,
}: {
  open: boolean
  value: Filters
  onClose: () => void
  onApply: (f: Filters) => void
  showBranch: boolean
}) {
  const [f, setF] = useState<Filters>(value)
  useEffect(() => {
    if (open) setF(value)
  }, [open, value])
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v || undefined }))

  const { tests, packages, departments } = useCatalogueMaps()
  const { branches } = useBranch()
  const referrers = useMaster('referrers')
  const hospitals = useMaster('hospitals')
  const b2b = useMaster('b2bCentres')
  const centres = useMaster('collectionCentres')
  const corporates = useMaster('corporateClients')
  const pros = useMaster('marketingTeam')
  const modes = useMaster('paymentModes')
  const users = useLiveQuery<UserProfile>(query(col(paths.users), orderBy('name')), []).data

  const doctorNames = [...referrers.filter((r) => r.type !== 'hospital'), ...[]]
  const hospitalNames = [...hospitals, ...referrers.filter((r) => r.type === 'hospital')]
  const phlebs = users.filter((u) => u.role === 'phlebotomist')
  const selectProps = { allowClear: true, showSearch: true, optionFilterProp: 'label', style: { width: '100%' }, placeholder: 'Any' }
  const modeOptions = modes.length
    ? modes.map((m) => ({ value: (m.name as string).toLowerCase(), label: m.name }))
    : [
        { value: 'cash', label: 'Cash' },
        { value: 'upi', label: 'UPI' },
        { value: 'card', label: 'Card' },
      ]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Filters"
      width={520}
      destroyOnHidden
      footer={
        <div className="pl-drawer-foot">
          <Button onClick={() => setF({ ...EMPTY_FILTERS })}>Clear all</Button>
          <Button
            variant="primary"
            onClick={() => {
              onApply(f)
              onClose()
            }}
          >
            Apply
          </Button>
        </div>
      }
    >
      <div className="pl-fields">
        <FormSection title="Tests and reports" description="Narrow by what was ordered and its report status.">
          <FieldGrid min={190} style={{ rowGap: 'var(--s-4)' }}>
        {showBranch && (
          <Field label="Branch">
            <Select {...selectProps} value={f.branch} onChange={(v) => set('branch', v)} options={opt(branches)} />
          </Field>
        )}
        <Field label="Department">
          <Select {...selectProps} value={f.department} onChange={(v) => set('department', v)} options={opt(departments)} />
        </Field>
        <Field label="Test">
          <Select {...selectProps} value={f.test} onChange={(v) => set('test', v)} options={tests.map((t) => ({ value: t.id, label: `${t.code} ${t.name}` }))} />
        </Field>
        <Field label="Package">
          <Select {...selectProps} value={f.pkg} onChange={(v) => set('pkg', v)} options={opt(packages)} />
        </Field>
        <Field label="Report status">
          <Select
            {...selectProps}
            value={f.reportStatus}
            onChange={(v) => set('reportStatus', v)}
            options={[
              { value: 'pending', label: 'Pending' },
              { value: 'partial', label: 'Partial' },
              { value: 'provisional', label: 'Provisional' },
              { value: 'final', label: 'Final' },
            ]}
          />
        </Field>
          </FieldGrid>
        </FormSection>
        <FormSection title="Referral" description="Who sent the patient.">
          <FieldGrid min={190} style={{ rowGap: 'var(--s-4)' }}>
        <Field label="Referral doctor">
          <Select {...selectProps} value={f.referrer} onChange={(v) => set('referrer', v)} options={byName(doctorNames)} />
        </Field>
        <Field label="Referral hospital">
          <Select {...selectProps} value={f.hospital} onChange={(v) => set('hospital', v)} options={byName(hospitalNames)} />
        </Field>
        <Field label="Second referral">
          <Select {...selectProps} value={f.secondReferrer} onChange={(v) => set('secondReferrer', v)} options={byName([...doctorNames, ...hospitalNames])} />
        </Field>
        <Field label="PRO">
          <Select {...selectProps} value={f.pro} onChange={(v) => set('pro', v)} options={opt(pros)} />
        </Field>
          </FieldGrid>
        </FormSection>
        <FormSection title="Centre and client" description="Where the sample or bill came from.">
          <FieldGrid min={190} style={{ rowGap: 'var(--s-4)' }}>
        <Field label="B2B centre">
          <Select {...selectProps} value={f.b2b} onChange={(v) => set('b2b', v)} options={opt(b2b)} />
        </Field>
        <Field label="Collection at / centre">
          <Select {...selectProps} value={f.collectionCentre} onChange={(v) => set('collectionCentre', v)} options={opt(centres)} />
        </Field>
        <Field label="Corporate client">
          <Select {...selectProps} value={f.corporate} onChange={(v) => set('corporate', v)} options={opt(corporates)} />
        </Field>
          </FieldGrid>
        </FormSection>
        <FormSection title="Staff and payment" description="Who handled the visit and how it was paid.">
          <FieldGrid min={190} style={{ rowGap: 'var(--s-4)' }}>
        <Field label="Phlebotomist">
          <Select {...selectProps} value={f.phlebotomist} onChange={(v) => set('phlebotomist', v)} options={phlebs.map((u) => ({ value: u.uid, label: u.name }))} />
        </Field>
        <Field label="Created by">
          <Select {...selectProps} value={f.createdBy} onChange={(v) => set('createdBy', v)} options={users.map((u) => ({ value: u.uid, label: u.name }))} />
        </Field>
        <Field label="Payment mode">
          <Select {...selectProps} value={f.paymentMode} onChange={(v) => set('paymentMode', v)} options={modeOptions} />
        </Field>
        <Field label="Printed">
          <Select
            value={f.printed ?? 'any'}
            style={{ width: '100%' }}
            onChange={(v) => setF((x) => ({ ...x, printed: v }))}
            options={[
              { value: 'any', label: 'Any' },
              { value: 'yes', label: 'Printed' },
              { value: 'no', label: 'Not printed' },
            ]}
          />
        </Field>
        <Field label="Bill order">
          <Select
            value={f.billSort ?? 'desc'}
            style={{ width: '100%' }}
            onChange={(v) => setF((x) => ({ ...x, billSort: v }))}
            options={[
              { value: 'desc', label: 'Newest first' },
              { value: 'asc', label: 'Oldest first' },
            ]}
          />
        </Field>
          </FieldGrid>
        </FormSection>
        <FormSection title="Show only" description="Switch on to limit the list to these cases.">
          <SettingRow label="Urgent only"><Switch checked={!!f.urgent} onChange={(v) => set('urgent', v)} aria-label="Urgent only" /></SettingRow>
          <SettingRow label="Smart report"><Switch checked={!!f.smartReport} onChange={(v) => set('smartReport', v)} aria-label="Smart report" /></SettingRow>
          <SettingRow label="Self / walk-in patients"><Switch checked={!!f.selfWalking} onChange={(v) => set('selfWalking', v)} aria-label="Self / walk-in patients" /></SettingRow>
          <SettingRow label="ABHA linked"><Switch checked={!!f.abhaLinked} onChange={(v) => set('abhaLinked', v)} aria-label="ABHA linked" /></SettingRow>
        </FormSection>
      </div>
    </Drawer>
  )
}
