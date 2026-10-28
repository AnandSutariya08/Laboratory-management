import { Checkbox, Input, InputNumber, Select } from 'antd'
import { Link } from 'react-router-dom'
import { StatusChip } from '../../../design/StatusChip'
import { useDisplay } from '../../../design/DisplaySettings'
import { B2B_DISPATCH_MODES, CYCLES, DISPATCH_MODES, PATIENT_LIST_COLUMNS, REGISTRATION_FIELDS } from '../constants'
import CreditWallet from '../../../components/billing/CreditWallet'
import { bind, Field, Group, SectionCard, SwitchRow, useDraft } from '../ui'
import type { DispatchMode } from '../../../types'

const RG = bind('registration')
const RE = bind('reportEntry')
const IN = bind('integration')
const B2 = bind('b2bLab')
const AC = bind('accession')
const RF = bind('referrals')
const NB = bind('nabl')
const TT = bind('tat')
const PL = bind('patientList')

function Top({ f, title, description }: { f: 'finalRequiresPayment' | 'allowEmptyApproval' | 'allowSelfVerification' | 'autoSendOnFinal' | 'blockSendWhileDue' | 'qcBlocksApproval' | 'discountReasonRequired' | 'aiEnabled'; title: string; description?: string }) {
  const { draft, set } = useDraft()
  return <SwitchRow title={title} description={description} checked={draft[f]} onChange={(v) => set([f], v)} />
}

function TopSw({ f, title, description }: { f: 'allowDispatchedDueAccess' | 'b2bPriceListDisabled'; title: string; description?: string }) {
  const { draft, set } = useDraft()
  return <SwitchRow title={title} description={description} checked={draft[f] === true} onChange={(v) => set([f], v)} />
}

export function Registration() {
  const { draft, set } = useDraft()
  const reg = draft.registration
  return (
    <>
      <SectionCard title="Required fields" description="Fields the front desk must fill before saving a registration.">
        <RG.Checks f="requiredFields" options={REGISTRATION_FIELDS} />
      </SectionCard>
      <SectionCard title="Patient identity">
        <RG.Sw f="uniqueContact" title="Unique contact number" description="Warn when another patient already uses the same phone number." />
        <RG.Sw f="autoSalutationFromGender" title="Suggest salutation from gender" description="Pre-selects Mr, Ms or similar once the gender is chosen." />
        <div className="st-grid">
          <RG.Sel f="uhidMode" label="UHID" options={[{ value: 'none', label: 'Not used (no UHID)' }, { value: 'manual', label: 'Enter manually' }, { value: 'auto', label: 'Generate automatically' }]} />
          <RG.Sel f="idDisplay" label="ID shown in patient list and Enter & Verify" options={[{ value: 'patientId', label: 'Patient ID' }, { value: 'uhid', label: 'UHID' }, { value: 'daywise', label: 'Day-wise number' }]} />
          <RG.Sel f="defaultAgeUnit" label="Default age unit" options={[{ value: 'year', label: 'Years' }, { value: 'month', label: 'Months' }, { value: 'day', label: 'Days' }]} />
          <RG.Sel f="autoRateList" label="Auto-select rate list by" options={[{ value: 'all', label: 'Doctor, hospital, second referral and corporate client' }, { value: 'none', label: 'Do not auto-select' }, { value: 'referrer', label: 'Referring doctor' }, { value: 'hospital', label: 'Hospital' }, { value: 'corporate', label: 'Corporate client' }]} />
          <Field label="Salutations" wide hint="Shown in the salutation list at registration">
            <Select mode="tags" value={reg.salutations} onChange={(v) => set(['registration', 'salutations'], v)} tokenSeparators={[',']} />
          </Field>
        </div>
      </SectionCard>
      <SectionCard title="Billing defaults">
        <RG.Sw f="defaultDueBill" title="Create bills as due by default" description="New bills start with the full amount unpaid." />
        <Top f="discountReasonRequired" title="Require a reason for discounts" description="Billing staff must type a reason whenever a discount is applied." />
        <div className="st-grid">
          <RG.Sel f="defaultDiscountedBy" label="Default discounted by" options={[{ value: 'none', label: 'None' }, { value: 'staff', label: 'Logged-in staff' }]} />
        </div>
      </SectionCard>
      <SectionCard title="Extras (not part of Flabs; all off by default)" description="Additions that do not change the standard registration and billing flow unless switched on.">
        <SwitchRow title="Confirm a likely duplicate patient" description="Ask before registering a new patient with the same phone, name and a similar age." checked={reg.strongDuplicateGuard === true} onChange={(v) => set(['registration', 'strongDuplicateGuard'], v)} />
        <SwitchRow title="Separate Pre Bookings view" description="Show a Pre Bookings tab on the Bookings page. Off: Bookings is one list with status chips." checked={draft.frontDesk?.showPreBookings === true} onChange={(v) => set(['frontDesk', 'showPreBookings'], v)} />
        <SwitchRow title="Print line discount and net on the bill" description="Off: the bill prints gross line amounts and the discount once, in the totals." checked={draft.billDetails.showLineDiscount === true} onChange={(v) => set(['billDetails', 'showLineDiscount'], v)} />
      </SectionCard>
      <SectionCard title="Default report dispatch" description="Pre-selected at registration; the front desk can change them per patient.">
        <div className="st-grid" style={{ ['--st-min' as string]: '320px' }}>
          <Field label="Patients (B2C)">
            <Checkbox.Group options={DISPATCH_MODES} value={draft.dispatchDefaults} onChange={(v) => set(['dispatchDefaults'], v as DispatchMode[])} />
          </Field>
          <Field label="B2B partners">
            <Checkbox.Group options={B2B_DISPATCH_MODES} value={reg.dispatchDefaultsB2b} onChange={(v) => set(['registration', 'dispatchDefaultsB2b'], v as DispatchMode[])} />
          </Field>
        </div>
      </SectionCard>
    </>
  )
}

export function ReportSetting() {
  const { draft, set } = useDraft()
  return (
    <>
      <SectionCard title="Approval and finalisation">
        <Top f="finalRequiresPayment" title="Final report requires full payment" description='A report stays "Provisional" until the bill has no balance due.' />
        <Top f="allowEmptyApproval" title="Allow approving tests with no values" />
        <Top f="allowSelfVerification" title="Allow self verification" description="When off, the person who entered a result cannot approve it (maker-checker)." />
      </SectionCard>
      <SectionCard title="Sending">
        <Top f="autoSendOnFinal" title="Auto-send when report becomes Final" />
        <Top f="blockSendWhileDue" title="Block sending while a balance is due" />
        <div className="st-grid">
          <Field label="Report link valid for (days)">
            <InputNumber min={1} max={365} style={{ width: '100%' }} value={draft.reportLinkDays} onChange={(v) => set(['reportLinkDays'], v ?? 30)} />
          </Field>
        </div>
      </SectionCard>
    </>
  )
}

export function Integration() {
  const { draft, set } = useDraft()
  return (
    <>
      <SectionCard title="Machine interface">
        <IN.Sw f="machineInterface" title="Enable machine interface" description="Accept results pushed from connected analysers. Set up machines under Lab Profile, Machine list." />
      </SectionCard>
      <SectionCard title="Messaging providers" description="Provider keys are Firebase secrets on the server, not stored here. Without them, messages are written to the outbox.">
        <div className="st-actions" style={{ marginBottom: 'var(--s-4)' }}>
          <StatusChip variant="neutral">WhatsApp: configured on server</StatusChip>
          <StatusChip variant="neutral">SMS: configured on server</StatusChip>
          <StatusChip variant="neutral">Email: configured on server</StatusChip>
        </div>
        <div className="st-grid">
          <Field label="Public app URL" hint="Base address used in report links, e.g. https://lab.example.com" wide>
            <Input value={draft.publicAppUrl} placeholder="https://lab.example.com" onChange={(e) => set(['publicAppUrl'], e.target.value)} />
          </Field>
        </div>
      </SectionCard>
      <SectionCard title="AI connections">
        <p className="st-card-desc">Let Claude read your aggregated data through MCP. <Link to="/connect-ai">Open Connect AI</Link></p>
      </SectionCard>
    </>
  )
}

export function B2bLab() {
  return (
    <SectionCard title="B2B lab settings">
      <div className="st-grid">
        <B2.Sel f="creditLimitBehaviour" label="When a partner exceeds the credit limit" options={[{ value: 'warn', label: 'Warn and allow' }, { value: 'block', label: 'Block new bills' }]} />
        <B2.Sel f="invoiceCycle" label="Default invoice cycle" options={CYCLES} />
      </div>
      <B2.Sw f="showDispatchedInUnit" title="Show dispatched status in B2B unit" />
      <TopSw f="b2bPriceListDisabled" title="Disable B2B price lists" description="B2B centres are billed at the test price (MRP); their rate lists are ignored." />
    </SectionCard>
  )
}

function BarcodeTypeField() {
  const { draft, set } = useDraft()
  return (
    <Field label="Barcode type" hint="One barcode per bill, per patient (all bills of a patient share it) or per department.">
      <Select value={draft.barcode?.type ?? 'bill'} onChange={(v) => set(['barcode', 'type'], v)}
        options={[{ value: 'bill', label: 'Bill wise' }, { value: 'patient', label: 'Patient wise' }, { value: 'department', label: 'Department wise' }]} />
    </Field>
  )
}

export function Accession() {
  return (
    <SectionCard title="Accession and barcodes">
      <AC.Sw f="enabled" title="Enable accession" description="Samples must be received before results can be entered." />
      <AC.Sw f="autoGenerateBarcode" title="Generate barcodes automatically" description="Creates a barcode for each bill or sample as soon as it is registered." />
      <div className="st-grid">
        <AC.Sel f="mode" label="Accession mode" options={[{ value: 'patient', label: 'Patient wise' }, { value: 'sample', label: 'Sample wise' }, { value: 'department', label: 'Department wise' }]} />
        <AC.Sel f="barcodePer" label="Barcode per" options={[{ value: 'bill', label: 'Bill' }, { value: 'sample', label: 'Sample' }]} />
 <BarcodeTypeField />
        <AC.Sel f="labelSize" label="Label size (mm)" options={[{ value: '50x25', label: '50 x 25' }, { value: '38x25', label: '38 x 25' }, { value: '75x38', label: '75 x 38' }]} />
      </div>
    </SectionCard>
  )
}

export function ReportEntry() {
  const { draft, set } = useDraft()
  const signatories = draft.signatories.filter((s) => s.active)
  return (
    <SectionCard title="Report entry" description="How technicians enter results and what the system checks before a result is approved.">
      <Group title="Result entry">
        <RE.Sw f="showPreviousResults" title="Show previous results" description="Show the patient's earlier values beside the result being entered." />
        <RE.Sw f="colourCodedBackground" title="Colour-coded result background" description="Tint the result cell when a value is outside its reference range." />
        <RE.Sw f="holdReasonModal" title="Ask for a reason when holding a result" />
      </Group>
      <Group title="Alerts and approval" description="Safety checks shown before a result can be approved.">
        <RE.Sw f="abnormalAlertBeforeApproval" title="Abnormal-value alert before approval" />
        <RE.Sw f="criticalAckRequired" title="Require critical value acknowledgement" description="Approval needs a note that the critical value was communicated." />
        <RE.Sw f="criticalWhatsappAlert" title="WhatsApp alert for critical values" description="Messages the patient (and the B2B / collection centre) to contact the lab when a critical value is entered. The value itself is never sent." />
        <RE.Sw f="notifyOnRejection" title="Notify on sample rejection" description="Messages the patient (and centre) that a fresh sample is needed." />
      </Group>
      <Group title="Checks and defaults">
        <div className="st-grid">
          <RE.Num f="deltaCheckPercent" label="Delta check threshold (%)" hint="0 turns delta check off" max={1000} />
          <RE.Num f="formulaDecimals" label="Decimals on calculated values" hint="Used for every formula unless the parameter sets its own. Default 2." max={6} />
          <Field label="Default signatory">
            <Select allowClear value={draft.reportEntry.defaultSignatoryId || undefined} onChange={(v) => set(['reportEntry', 'defaultSignatoryId'], v ?? '')} options={signatories.map((s) => ({ value: s.id, label: s.name || 'Unnamed' }))} placeholder="Add doctors in Lab Profile" />
          </Field>
        </div>
      </Group>
    </SectionCard>
  )
}

export function Referrals() {
  return (
    <SectionCard title="Referrals">
      <Group title="Commission">
      <div className="st-grid">
        <RF.Sel f="commissionBasis" label="Commission calculated on" options={[{ value: 'net', label: 'Total amount (after discount)' }, { value: 'paid', label: 'Paid amount' }, { value: 'gross', label: 'Gross amount (before discount)' }]} />
        <RF.Sel f="commissionTrigger" label="Commission is earned when" options={[{ value: 'billing', label: 'The bill is created' }, { value: 'reportFinal', label: 'The report is final' }, { value: 'fullyPaid', label: 'The bill is fully paid' }]} />
      </div>
      </Group>
      <Group title="Bills and reports">
      <RF.Sw f="showCommissionOnBills" title="Show commission on bills" description="Visible to staff on the bill, never on the patient copy." />
      <RF.Sw f="govPanelSendDueReport" title="Send due reports for government panel bills" description="Lets the front desk send a report even if the panel bill has a balance due." />
      </Group>
    </SectionCard>
  )
}

export function NablAudit() {
  return (
    <SectionCard title="NABL audit" description="Extra records that an accreditation audit asks for.">
      <Group title="Features">
        <NB.Sw f="enabled" title="Enable NABL features" description="Turns on the audit trail, EQAS records and the prompts below." />
      </Group>
      <Group title="Required remarks" description="Staff must type a reason or remark before continuing.">
        <NB.Sw f="rerunReasonModal" title="Ask for a reason when re-running a test" />
        <NB.Sw f="urgentRemarkModal" title="Ask for a remark on urgent tests" />
        <NB.Sw f="criticalRemarkModal" title="Ask for a remark on critical values" />
      </Group>
      <Group title="Retention and matching">
        <div className="st-grid">
          <NB.Num f="retentionDays" label="Retain samples before discarding (days)" min={1} max={365} />
          <NB.Num f="eqasMatchDays" label="EQAS match window (+/- days)" min={1} max={30} />
        </div>
      </Group>
    </SectionCard>
  )
}

export function Tat() {
  return (
    <>
      <SectionCard title="Turnaround time">
        <div className="st-grid">
          <TT.Sel f="clockStart" label="TAT clock starts at" options={[{ value: 'registration', label: 'Registration' }, { value: 'collection', label: 'Sample collection' }, { value: 'receipt', label: 'Sample receipt' }]} />
          <TT.Num f="nearbyThresholdPercent" label="Nearing-breach threshold (% of TAT used)" min={1} max={100} />
          <TT.Num f="urgentTatPercent" label="Urgent tests get this % of normal TAT" min={1} max={100} />
        </div>
      </SectionCard>
      <SectionCard title="Show TAT status in">
        <TT.Sw f="showInAccession" title="Accession" />
        <TT.Sw f="showInEnterVerify" title="Enter & Verify" />
        <TT.Sw f="showInBilling" title="Billing" />
        <TT.Sw f="showInPatientList" title="Patient list" />
      </SectionCard>
    </>
  )
}

export function PatientList() {
  return (
    <SectionCard title="Patient list" description="What staff see when they open the patient list.">
      <Group title="Defaults">
        <div className="st-grid">
          <PL.Sel f="defaultRange" label="Default date range" options={[{ value: 'today', label: 'Today' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }, { value: 'month', label: 'This month' }]} />
          <PL.Sel f="defaultTab" label="Default tab" options={[{ value: 'all', label: 'All' }, { value: 'pending', label: 'Pending' }, { value: 'final', label: 'Final' }, { value: 'due', label: 'Due' }]} />
        </div>
        <PL.Sw f="newestFirst" title="Newest first" description="Sort the list with the latest bills at the top." />
      </Group>
      <Group title="Voids and dispatched bills">
        <PL.Sw f="voidReasonRequired" title="Require a reason when deleting or voiding a bill" />
        <TopSw f="allowDispatchedDueAccess" title="Allow report access for dispatched bills with a due" description="Staff can open the report of a bill that was dispatched but still has a balance due." />
      </Group>
      <Group title="Columns" description="Columns shown in the patient list table.">
        <PL.Checks f="columns" options={PATIENT_LIST_COLUMNS} />
      </Group>
    </SectionCard>
  )
}

export function Display() {
  const { prefs, set } = useDisplay()
  return (
    <SectionCard title="Display" description="Saved on this device only.">
      <div className="st-grid">
        <Field label="Theme">
          <Select value={prefs.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </Field>
      </div>
      <SwitchRow title="Increase contrast" description="Stronger borders and text colours." checked={prefs.increaseContrast} onChange={(v) => set({ increaseContrast: v })} />
      <SwitchRow title="Reduce motion" description="Turn off animations and transitions." checked={prefs.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
      <SwitchRow title="Reduce transparency" description="Use solid backgrounds instead of frosted glass." checked={prefs.reduceTransparency} onChange={(v) => set({ reduceTransparency: v })} />
    </SectionCard>
  )
}

export function Ai() {
  const { draft, set } = useDraft()
  return (
    <SectionCard title="AI" description="The API key is a Firebase secret (ANTHROPIC_API_KEY) on the server. Analyst and MCP use aggregated numbers; result interpretation sends de-identified values only.">
      <Group title="AI features">
      <Top f="aiEnabled" title="Enable AI features" description="Analyst, dashboards and result interpretation." />
      <div className="st-grid" style={{ ['--st-min' as string]: '320px' }}>
        <Field label="Model">
          <Select
            value={draft.aiModel}
            onChange={(v) => set(['aiModel'], v)}
            options={[
              { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 - default, most capable' },
              { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 - faster, lower cost' },
              { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 - lowest cost' },
            ]}
          />
        </Field>
      </div>
      </Group>
      <Group title="AI credits">
        <div className="st-table-wrap"><CreditWallet /></div>
      </Group>
    </SectionCard>
  )
}

export function Qc() {
  return (
    <SectionCard title="Quality control">
      <Top f="qcBlocksApproval" title="Block approval when QC has failed or not been run" description="When off, a warning is shown instead." />
    </SectionCard>
  )
}
