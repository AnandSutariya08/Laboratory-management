import { useEffect, useState } from 'react'
import { App, Input, Select, Switch, Table } from 'antd'
import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../../../firebase'
import { Button } from '../../../design/Button'
import { StatusChip } from '../../../design/StatusChip'
import { useLiveQuery } from '../../../hooks/useLive'
import { col } from '../../../lib/db'
import { restoreMaster } from '../../partners/lib/master'
import type { Branch } from '../../../branch/BranchProvider'
import { REGISTRATION_FIELDS } from '../constants'
import { planLabel } from '../lib'
import { Field, SectionCard, SwitchRow, useDraft } from '../ui'

// ---- Branch overrides (USR-17) -----------------------------------------------------------------------------
// Per-branch report and bill settings laid over the lab-wide ones (effectiveSettings in settings/lib.ts).
export function BranchOverrides() {
  const { draft, set } = useDraft()
  const branches = useLiveQuery<Branch>(col('branches'), []).data
  const [id, setId] = useState<string | undefined>()
  const branch = id ?? branches[0]?.id
  const o = (branch && draft.branchOverrides?.[branch]) || {}
  const put = (path: string[], v: unknown) => branch && set(['branchOverrides', branch, ...path], v)
  const reset = () => {
    if (!branch) return
    const next = { ...(draft.branchOverrides ?? {}) }
    delete next[branch]
    set(['branchOverrides'], next)
  }
  return (
    <SectionCard title="Branch overrides" description="Each branch can print its own name, address, header, footer and bill terms. Blank fields use the lab-wide value.">
      <div className="st-grid">
        <Field label="Branch">
          <Select value={branch} onChange={setId} placeholder="No branches yet" options={branches.map((b) => ({ value: b.id, label: `${b.name} (${b.code})` }))} />
        </Field>
      </div>
      {branch && (
        <>
          <div className="st-grid" style={{ marginTop: 'var(--s-3)' }}>
            <Field label="Lab name on this branch's papers"><Input value={o.name ?? ''} onChange={(e) => put(['name'], e.target.value)} /></Field>
            <Field label="Phone"><Input value={o.phone ?? ''} onChange={(e) => put(['phone'], e.target.value)} /></Field>
            <Field label="Address" wide><Input.TextArea rows={2} value={o.address ?? ''} onChange={(e) => put(['address'], e.target.value)} /></Field>
            <Field label="Report footer text" wide><Input.TextArea rows={2} value={o.reportDetails?.footerText ?? ''} onChange={(e) => put(['reportDetails', 'footerText'], e.target.value)} /></Field>
            <Field label="End of report text"><Input value={o.reportDetails?.endOfReportText ?? ''} onChange={(e) => put(['reportDetails', 'endOfReportText'], e.target.value)} /></Field>
            <Field label="Bill header" wide><Input.TextArea rows={2} value={o.billDetails?.header ?? ''} onChange={(e) => put(['billDetails', 'header'], e.target.value)} /></Field>
            <Field label="Bill footer" wide><Input.TextArea rows={2} value={o.billDetails?.footer ?? ''} onChange={(e) => put(['billDetails', 'footer'], e.target.value)} /></Field>
            <Field label="Bill terms" wide><Input.TextArea rows={2} value={o.billDetails?.terms ?? ''} onChange={(e) => put(['billDetails', 'terms'], e.target.value)} /></Field>
            <Field label="GSTIN for this branch"><Input value={o.billDetails?.gstin ?? ''} onChange={(e) => put(['billDetails', 'gstin'], e.target.value)} /></Field>
          </div>
          <div className="st-actions" style={{ marginTop: 'var(--s-3)' }}><Button onClick={reset}>Clear this branch's overrides</Button></div>
        </>
      )}
    </SectionCard>
  )
}

// ---- ABDM (PRO-03) ----------------------------------------------------------------------------------------------
export function AbdmCard() {
  const { draft, set } = useDraft()
  const a = draft.abdm ?? { hfrId: '', hipId: '', abhaLinking: false }
  return (
    <SectionCard title="ABDM / ABHA" description="Ayushman Bharat Digital Mission identifiers of this facility. ABHA linking is offered at registration once a Health Facility Registry id is entered.">
      <div className="st-grid">
        <Field label="Health Facility Registry (HFR) id"><Input value={a.hfrId} onChange={(e) => set(['abdm', 'hfrId'], e.target.value.trim())} /></Field>
        <Field label="Health Information Provider (HIP) id"><Input value={a.hipId} onChange={(e) => set(['abdm', 'hipId'], e.target.value.trim())} /></Field>
      </div>
      <SwitchRow title="ABHA linking" description="Show the ABHA number field and a link action when registering a patient." checked={!!a.abhaLinking} onChange={(v) => set(['abdm', 'abhaLinking'], v)} />
    </SectionCard>
  )
}

// ---- Razorpay (PRO-03): status only, never a secret ---------------------------------------------------------------
export function RazorpayCard() {
  const [cfg, setCfg] = useState<{ configured: boolean; keyId: string } | null | 'error'>(null)
  useEffect(() => {
    httpsCallable<unknown, { configured: boolean; keyId: string }>(functions, 'getPaymentConfig')({ labId: LAB_ID }).then((r) => setCfg(r.data)).catch(() => setCfg('error'))
  }, [])
  const ok = !!cfg && cfg !== 'error' && cfg.configured
  return (
    <SectionCard title="Online payments (Razorpay)" description="Keys are Firebase secrets on the server (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET). They are never stored or shown here.">
      <div className="st-actions">
        {cfg === null ? <StatusChip>Checking</StatusChip> : cfg === 'error' ? <StatusChip variant="caution">Status unavailable</StatusChip> : <StatusChip variant={ok ? 'success' : 'neutral'}>{ok ? 'Keys configured' : 'Not set up'}</StatusChip>}
        {ok && typeof cfg === 'object' && cfg && <span>Key id ending {cfg.keyId.slice(-4)}</span>}
      </div>
      {!ok && cfg !== null && <p className="st-card-desc" style={{ marginTop: 'var(--s-3)' }}>Online payment is not set up. Bills can still be paid by cash, UPI, card or wallet. Ask your administrator to set the three secrets and the webhook address.</p>}
    </SectionCard>
  )
}

// ---- Subscription / plan (PRO-03, USR-18) -----------------------------------------------------------------------
export function SubscriptionCard() {
  const { draft } = useDraft()
  const s = draft.subscription
  const p = planLabel(draft)
  return (
    <SectionCard title="Subscription and plan" description="Set by the platform administrator. Contact support to change your plan.">
      <div className="st-actions"><StatusChip variant={p.tone}>{p.label}</StatusChip><span>Status: {p.status}</span></div>
      {s && (
        <div className="st-grid" style={{ marginTop: 'var(--s-3)' }}>
          <Field label="Renews on"><Input readOnly value={s.renewsOn ?? ''} /></Field>
          <Field label="Monthly bill limit"><Input readOnly value={s.billLimit ? String(s.billLimit) : 'Unlimited'} /></Field>
          <Field label="User seats"><Input readOnly value={s.seats ? String(s.seats) : 'Unlimited'} /></Field>
        </div>
      )}
      {!s && <p className="st-card-desc" style={{ marginTop: 'var(--s-3)' }}>This lab has no subscription record: every module is available.</p>}
    </SectionCard>
  )
}

// ---- Registration field rename + show / hide (SET-02) ----------------------------------------------------------
export function RegistrationFieldsCard() {
  const { draft, set } = useDraft()
  const labels = draft.frontDesk?.fieldLabels ?? {}
  const hidden = draft.frontDesk?.hiddenFields ?? []
  const required = draft.registration.requiredFields
  return (
    <SectionCard title="Registration fields" description="Rename a field or hide it from the registration form. Required fields (Registration > Required fields) cannot be hidden.">
      <Table
        size="small" rowKey="value" pagination={false} dataSource={REGISTRATION_FIELDS}
        columns={[
          { title: 'Field', dataIndex: 'label', width: 220 },
          { title: 'Label shown', render: (_, f) => <Input aria-label={`Label for ${f.label}`} placeholder={f.label} value={labels[f.value] ?? ''} onChange={(e) => set(['frontDesk', 'fieldLabels'], { ...labels, [f.value]: e.target.value })} /> },
          {
            title: 'Shown', width: 100,
            render: (_, f) => (
              <Switch aria-label={`Show ${f.label}`} disabled={required.includes(f.value)} checked={!hidden.includes(f.value) || required.includes(f.value)}
                onChange={(on) => set(['frontDesk', 'hiddenFields'], on ? hidden.filter((k) => k !== f.value) : [...hidden, f.value])} />
            ),
          },
        ]}
      />
    </SectionCard>
  )
}

// ---- Deleted items (X-02): restore soft-deleted masters ----------------------------------------------------------
const MASTERS: [string, string][] = [
  ['referrers', 'Referring doctor'], ['hospitals', 'Hospital'], ['tpas', 'TPA'], ['govPanels', 'Government panel'], ['marketingTeam', 'Marketing'],
  ['processingLabs', 'Processing lab'], ['b2bCentres', 'B2B centre'], ['collectionCentres', 'Collection centre'], ['corporateClients', 'Corporate client'],
  ['rateLists', 'Rate list'], ['departments', 'Department'], ['sampleTypes', 'Sample'], ['packages', 'Package'], ['tests', 'Test'],
]
function useDeleted(name: string) {
  return useLiveQuery<{ id: string; name?: string; code?: string; deleted?: boolean }>(col(name), [name]).data.filter((x) => x.deleted)
}
export function DeletedMastersCard() {
  const { message } = App.useApp()
  const { canEdit } = useDraft()
  const lists = MASTERS.map(([name, label]) => ({ name, label, rows: useDeleted(name) })) // fixed-length list: hook order is stable
  const rows = lists.flatMap((l) => l.rows.map((r) => ({ key: `${l.name}/${r.id}`, kind: l.label, coll: l.name, id: r.id, name: r.name ?? r.code ?? r.id })))
  return (
    <SectionCard title="Deleted items" description="Deleting a catalogue item or partner only hides it, so old bills and reports stay correct. Restore it here.">
      <Table size="small" rowKey="key" dataSource={rows} pagination={{ pageSize: 10, showSizeChanger: false }} locale={{ emptyText: 'Nothing deleted' }}
        columns={[
          { title: 'Type', dataIndex: 'kind', width: 170 },
          { title: 'Name', dataIndex: 'name' },
          { title: '', width: 100, render: (_, r) => canEdit && <Button variant="text" onClick={() => void restoreMaster(r.coll, r.id).then(() => message.success(`${r.name} restored`))}>Restore</Button> },
        ]} />
    </SectionCard>
  )
}
