import { Input, Select } from 'antd'
import { Button } from '../../../design/Button'
import { CYCLES, PATIENT_BLOCK_FIELDS } from '../constants'
import { PreviewButton } from '../Preview'
import { bind, Field, SectionCard, useDraft } from '../ui'
import type { PartnerInvoiceSettings } from '../../../types'

const P = bind('profile')
const D = bind('dailyReport')
const R = bind('reportDetails')
const B = bind('billDetails')
const Q = bind('quotation')
const DT = bind('docTemplates')

export function LabDetails() {
  const { draft, set } = useDraft()
  return (
    <>
      <SectionCard title="Lab details" description="Printed on reports, bills and shared links.">
        <div className="st-grid">
          <Field label="Lab name">
            <Input value={draft.name} onChange={(e) => set(['name'], e.target.value)} />
          </Field>
          <Field label="Lab contact">
            <Input value={draft.phone} onChange={(e) => set(['phone'], e.target.value)} />
          </Field>
          <Field label="Lab email">
            <Input type="email" value={draft.email} onChange={(e) => set(['email'], e.target.value)} />
          </Field>
          <P.Txt f="city" label="City" />
          <P.Txt f="website" label="Website" placeholder="https://" />
          <P.Sel
            f="dateFormat"
            label="Date format"
            options={['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY'].map((v) => ({ value: v, label: v }))}
          />
          <Field label="Address" wide>
            <Input.TextArea rows={2} value={draft.address} onChange={(e) => set(['address'], e.target.value)} />
          </Field>
          <Field label="Logo" wide>
            <P.Img f="logoDataUrl" label="logo" />
          </Field>
        </div>
      </SectionCard>
      <SectionCard title="Lab admin details" description="The person we contact about this account.">
        <div className="st-grid">
          <P.Txt f="adminName" label="Admin name" />
          <P.Txt f="adminEmail" label="Admin email" type="email" />
          <P.Txt f="adminContact" label="Admin contact" />
        </div>
      </SectionCard>
    </>
  )
}

export function DailyReport() {
  const { draft } = useDraft()
  return (
    <SectionCard title="Daily report recipient" description="A summary of the previous day's samples and collections is sent every morning at 09:30 IST to these recipients.">
      <D.Sw f="enabled" title="Send daily summary" description="Needs the email or WhatsApp provider to be configured on the server." />
      <div className="st-grid">
        <D.Txt f="email" label="Email" type="email" placeholder={draft.email || 'owner@lab.com'} />
        <D.Txt f="whatsapp" label="WhatsApp number" />
      </div>
    </SectionCard>
  )
}

const FLAG_COLOURS = [
  { value: '#1D4ED8', label: 'Blue' }, { value: '#B91C1C', label: 'Red' }, { value: '#C2410C', label: 'Orange' },
  { value: '#B45309', label: 'Amber' }, { value: '#047857', label: 'Green' }, { value: '#6D28D9', label: 'Purple' }, { value: '#111827', label: 'Black' },
]

export function ReportDetails() {
  const { draft, set } = useDraft()
  const rd = draft.reportDetails
  return (
    <>
      <SectionCard title="Header, footer and letterhead" extra={<PreviewButton kind="report" />}>
        <R.Sw f="useLetterhead" title="Print on pre-printed letterhead" description="Leaves header and footer space blank." />
        <R.Sw f="showHeader" title="Show header" />
        <R.Sw f="showFooter" title="Show footer" />
        <div className="st-grid" style={{ marginTop: 'var(--s-3)' }}>
          <Field label="Header image" wide>
            <R.Img f="headerImage" label="header image" />
          </Field>
          <R.Txt f="footerText" label="Footer text" area />
          <R.Txt f="endOfReportText" label="End-of-report text" />
        </div>
      </SectionCard>
      <SectionCard title="Page layout">
        <div className="st-grid">
          <R.Sel f="pageSize" label="Page size" options={['A4', 'A5', 'Letter'].map((v) => ({ value: v, label: v }))} />
          <R.Num f="marginTop" label="Top margin (mm)" max={60} />
          <R.Num f="marginBottom" label="Bottom margin (mm)" max={60} />
          <R.Num f="marginLeft" label="Left margin (mm)" max={60} />
          <R.Num f="marginRight" label="Right margin (mm)" max={60} />
          <R.Sel
            f="signaturePlacement"
            label="Signature placement"
            options={[{ value: 'end', label: 'End of report' }, { value: 'everyPage', label: 'Every page' }]}
          />
          <R.Sel
            f="abnormalStyle"
            label="Abnormal values"
            options={[
              { value: 'both', label: 'Bold and colour' }, { value: 'bold', label: 'Bold' },
              { value: 'colour', label: 'Colour' }, { value: 'none', label: 'No emphasis' },
            ]}
          />
        </div>
      </SectionCard>
      <SectionCard title="Content">
        <R.Sw f="showQr" title="Show QR code" description="Links to the online copy of the report." />
        <R.Sw f="showBarcode" title="Show barcode" />
        <R.Sw f="showReferenceRanges" title="Show reference ranges" />
        <R.Sw f="showFlagArrows" title="Show high/low arrows" />
        <R.Sw f="pageBreakPerDepartment" title="Start each department on a new page" />
        <R.Sw f="showSampleTypePerTest" title="Show sample type under each test" />
        <R.Sw f="duplicateWatermark" title="DUPLICATE watermark after the first print" />
      </SectionCard>
      <SectionCard title="Provisional reports and sending">
        <R.Sw f="provisionalShowSign" title="Print the signature on provisional reports" />
        <R.Sw f="reportBlockPartial" title="Block printing and sending while any test is pending" />
        <R.Sw f="allowProvisionalSend" title="Allow sending provisional reports" description="On by default." />
      </SectionCard>
      <SectionCard title="Radiology and flag colours">
        <R.Sw f="radiologyRequireImage" title="Radiology sign-off needs an attached image" />
        <R.Sw f="radiologyRequireImpression" title="Radiology sign-off needs an impression" />
        <div className="st-grid" style={{ marginTop: 'var(--s-3)' }}>
          <Field label="Low value colour">
            <Select value={rd.lowColour ?? '#1D4ED8'} onChange={(v) => set(['reportDetails', 'lowColour'], v)} options={FLAG_COLOURS} />
          </Field>
          <Field label="High value colour">
            <Select value={rd.highColour ?? '#B91C1C'} onChange={(v) => set(['reportDetails', 'highColour'], v)} options={FLAG_COLOURS} />
          </Field>
        </div>
      </SectionCard>
      <SectionCard title="Patient block fields" description="Fields shown in the patient details block of the report.">
        <R.Checks f="patientFields" options={PATIENT_BLOCK_FIELDS} />
        <span className="st-field__hint">{rd.patientFields.length} selected</span>
        <div className="st-actions" style={{ marginTop: 'var(--s-3)' }}>
          <Button onClick={() => set(['reportDetails', 'patientFields'], PATIENT_BLOCK_FIELDS.map((f) => f.value))}>Select all</Button>
        </div>
      </SectionCard>
    </>
  )
}

export function BillDetails() {
  const { draft, set } = useDraft()
  return (
    <>
      <SectionCard title="Bill header and footer" extra={<PreviewButton kind="bill" />}>
        <div className="st-grid">
          <Field label="Bill number prefix" hint="New bills are numbered prefix + running number, e.g. HCL1042">
            <Input value={draft.billPrefix} onChange={(e) => set(['billPrefix'], e.target.value)} />
          </Field>
          <B.Sel f="defaultPrint" label="Default print" options={[{ value: 'a4', label: 'A4 / A5 page' }, { value: 'thermal', label: 'Thermal receipt' }]} />
          <B.Txt f="header" label="Header text" area />
          <B.Txt f="footer" label="Footer text" area />
          <B.Txt f="terms" label="Terms and conditions" area />
        </div>
      </SectionCard>
      <SectionCard title="Show on bill">
        <B.Sw f="showPaymentBreakup" title="Payment breakup" description="Cash, UPI, card split per payment." />
        <B.Sw f="showTestCode" title="Test code" />
        <B.Sw f="showBarcode" title="Barcode" />
        <B.Sw f="showBilledBy" title="Billed by" />
        <B.Sw f="showReportDelivery" title="Report delivery" />
        <B.Sw f="thermalEnabled" title="Enable thermal printing" />
      </SectionCard>
      <SectionCard title="Tax and UPI">
        <B.Sw f="gstEnabled" title="Show GST on bills" />
        <div className="st-grid">
          <B.Txt f="gstin" label="GSTIN" />
          <B.Num f="gstPercent" label="GST %" max={100} />
          <B.Txt f="hsnCode" label="HSN / SAC code" />
          <B.Txt f="upiId" label="UPI ID for bill QR" />
        </div>
      </SectionCard>
    </>
  )
}

export function QuotationDetails() {
  return (
    <SectionCard title="Quotation details" extra={<PreviewButton kind="quotation" />}>
      <div className="st-grid">
        <Q.Txt f="prefix" label="Quotation prefix" />
        <Q.Num f="validityDays" label="Validity (days)" min={1} max={365} />
        <Q.Txt f="header" label="Header" area />
        <Q.Txt f="terms" label="Terms and conditions" area />
      </div>
    </SectionCard>
  )
}

function PartnerInvoice({ group, title }: { group: 'b2bInvoice' | 'corporateInvoice'; title: string }) {
  const { draft, set } = useDraft()
  const v: PartnerInvoiceSettings = draft[group]
  const put = <K extends keyof PartnerInvoiceSettings>(k: K, val: PartnerInvoiceSettings[K]) => set([group, k], val)
  const txt = (k: keyof PartnerInvoiceSettings, label: string, area = false) => (
    <Field label={label} wide={area}>
      {area ? (
        <Input.TextArea rows={3} value={v[k]} onChange={(e) => put(k, e.target.value as never)} />
      ) : (
        <Input value={v[k]} onChange={(e) => put(k, e.target.value as never)} />
      )}
    </Field>
  )
  return (
    <SectionCard title={title}>
      <div className="st-grid">
        {txt('prefix', 'Invoice prefix')}
        <Field label="Invoice cycle">
          <Select value={v.cycle} options={CYCLES} onChange={(x) => put('cycle', x)} />
        </Field>
        <Field label="Detailed view">
          <Select value={v.detailedView} options={[{ value: 'patient', label: 'Patient wise' }, { value: 'test', label: 'Test wise' }]} onChange={(x) => put('detailedView', x)} />
        </Field>
        {txt('bankName', 'Bank name')}
        {txt('bankAccountName', 'Account holder')}
        {txt('bankAccountNo', 'Account number')}
        {txt('bankIfsc', 'IFSC')}
        {txt('upiId', 'UPI ID')}
        {txt('terms', 'Terms and conditions', true)}
      </div>
    </SectionCard>
  )
}
export const B2bInvoice = () => <PartnerInvoice group="b2bInvoice" title="B2B invoice" />
export const CorporateInvoice = () => <PartnerInvoice group="corporateInvoice" title="Corporate invoice" />

export function DocTemplates() {
  return (
    <SectionCard title="Document templates" description="Text blocks printed on the test request form (TRF) and worksheets.">
      <div className="st-grid">
        <DT.Txt f="trfText" label="TRF instructions" area />
        <DT.Txt f="worksheetHeader" label="Worksheet header" area />
        <DT.Txt f="worksheetFooter" label="Worksheet footer" area />
      </div>
    </SectionCard>
  )
}
