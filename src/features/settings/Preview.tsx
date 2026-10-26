import { useState } from 'react'
import { Modal } from 'antd'
import { Button } from '../../design/Button'
import { formatINR } from '../../lib/money'
import { billTax, formatLabDate, labContactLine, upiPayLink } from './lib'
import { useDraft } from './ui'
import type { LabSettings } from '../../types'
import { dialogWidth } from '../../design/dialog'

// PRO-13: previews built from the CURRENT (unsaved) settings and made-up sample data. Nothing is written anywhere.
type Kind = 'bill' | 'report' | 'quotation'

const SAMPLE_ITEMS = [
  { code: 'CBC', name: 'Complete blood count', price: 35000 },
  { code: 'LFT', name: 'Liver function test', price: 60000 },
  { code: 'TSH', name: 'Thyroid stimulating hormone', price: 40000 },
]
const NET = SAMPLE_ITEMS.reduce((s, i) => s + i.price, 0)

const paper: React.CSSProperties = { background: '#fff', color: '#111', border: '1px solid var(--line, #ddd)', padding: 20, fontSize: 12, lineHeight: 1.5 }

function Head({ s }: { s: LabSettings }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 8 }}>
      {s.profile.logoDataUrl && <img src={s.profile.logoDataUrl} alt="" style={{ maxHeight: 48 }} />}
      <div style={{ fontSize: 17, fontWeight: 700 }}>{s.name || 'Your lab name'}</div>
      <div>{[s.address, s.profile.city].filter(Boolean).join(', ')}</div>
      <div>{labContactLine(s)}</div>
    </div>
  )
}

function Bill({ s }: { s: LabSettings }) {
  const b = s.billDetails
  const tax = billTax(s, NET)
  const upi = upiPayLink(s, 0, 'Sample bill')
  return (
    <div style={paper}>
      <Head s={s} />
      {b.gstEnabled && b.gstin && <div style={{ textAlign: 'center' }}>GSTIN {b.gstin}{b.hsnCode ? ` | HSN/SAC ${b.hsnCode}` : ''}</div>}
      {b.header && <div style={{ textAlign: 'center', whiteSpace: 'pre-line' }}>{b.header}</div>}
      <div style={{ textAlign: 'center', fontWeight: 600, margin: '8px 0' }}>BILL RECEIPT (SAMPLE)</div>
      <div>Bill no <b>{s.billPrefix || 'BILL'}1001</b> &nbsp; Date {formatLabDate(s, new Date(), true)}</div>
      <div>Name <b>Sample Patient</b> &nbsp; 34 years / M</div>
      {b.showBilledBy && <div>Billed by Front desk</div>}
      {b.showReportDelivery && <div>Report via WhatsApp, Email</div>}
      <hr />
      {SAMPLE_ITEMS.map((i) => (
        <div key={i.code} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{i.name}{b.showTestCode ? ` (${i.code})` : ''}</span><span>{formatINR(i.price)}</span>
        </div>
      ))}
      <hr />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Net amount</b><b>{formatINR(NET)}</b></div>
      {tax.tax > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>incl. GST {tax.percent}% (taxable {formatINR(tax.taxable)})</span><span>{formatINR(tax.tax)}</span></div>}
      {b.showPaymentBreakup && <div>Cash {formatINR(NET - 20000)} / UPI {formatINR(20000)}</div>}
      {b.showBarcode && <div style={{ fontFamily: 'monospace', letterSpacing: 2, marginTop: 6 }}>||| |||| | ||| ||||</div>}
      {upi && <div style={{ marginTop: 6 }}>UPI QR will print for dues ({b.upiId})</div>}
      {(b.footer || b.terms) && <div style={{ marginTop: 8, whiteSpace: 'pre-line', fontSize: 11 }}>{[b.footer, b.terms].filter(Boolean).join('\n')}</div>}
    </div>
  )
}

function Report({ s }: { s: LabSettings }) {
  const r = s.reportDetails
  const signer = s.signatories.find((x) => x.active)
  const arrow = r.showFlagArrows
  const flagStyle = (hi: boolean): React.CSSProperties => ({
    fontWeight: r.abnormalStyle === 'bold' || r.abnormalStyle === 'both' ? 700 : 400,
    color: r.abnormalStyle === 'colour' || r.abnormalStyle === 'both' ? (hi ? r.highColour || '#b3261e' : r.lowColour || '#1d4ed8') : undefined,
  })
  return (
    <div style={paper}>
      {r.useLetterhead ? <div style={{ height: 60, border: '1px dashed #bbb', textAlign: 'center', color: '#888' }}>Pre-printed letterhead space</div> : r.showHeader && <Head s={s} />}
      <div style={{ textAlign: 'center', fontWeight: 600, margin: '8px 0' }}>LABORATORY REPORT (SAMPLE)</div>
      <div>Sample Patient &nbsp; 34 years / M &nbsp; Collected {formatLabDate(s, new Date())}</div>
      <hr />
      <table style={{ width: '100%', fontSize: 12 }}>
        <thead><tr style={{ textAlign: 'left' }}><th>Test</th><th>Result</th>{r.showReferenceRanges && <th>Reference</th>}<th>Unit</th></tr></thead>
        <tbody>
          <tr><td>Haemoglobin</td><td style={flagStyle(false)}>10.2 {arrow ? '↓' : 'L'}</td>{r.showReferenceRanges && <td>13.0 - 17.0</td>}<td>g/dL</td></tr>
          <tr><td>WBC count</td><td>7,200</td>{r.showReferenceRanges && <td>4,000 - 11,000</td>}<td>/uL</td></tr>
          <tr><td>Platelets</td><td style={flagStyle(true)}>480 {arrow ? '↑' : 'H'}</td>{r.showReferenceRanges && <td>150 - 410</td>}<td>x10^3/uL</td></tr>
        </tbody>
      </table>
      {r.endOfReportText && <div style={{ textAlign: 'center', marginTop: 8 }}>{r.endOfReportText}</div>}
      {signer && <div style={{ marginTop: 12, textAlign: signer.align ?? 'right' }}>{signer.hideNameInReport ? '' : <b>{signer.name}</b>}<div>{signer.qualification}</div></div>}
      {!r.useLetterhead && r.showFooter && r.footerText && <div style={{ marginTop: 8, textAlign: 'center', fontSize: 11 }}>{r.footerText}</div>}
    </div>
  )
}

function Quotation({ s }: { s: LabSettings }) {
  const q = s.quotation
  return (
    <div style={paper}>
      <Head s={s} />
      {q.header && <div style={{ textAlign: 'center', whiteSpace: 'pre-line' }}>{q.header}</div>}
      <div style={{ textAlign: 'center', fontWeight: 600, margin: '8px 0' }}>QUOTATION (SAMPLE)</div>
      <div>No <b>{q.prefix || 'Q'}-0001</b> &nbsp; Valid for {q.validityDays} days from {formatLabDate(s, new Date())}</div>
      <hr />
      {SAMPLE_ITEMS.map((i) => (
        <div key={i.code} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{i.name}{q.showTestCode ? ` (${i.code})` : ''}</span><span>{formatINR(i.price)}</span>
        </div>
      ))}
      <hr />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Total</b><b>{formatINR(NET)}</b></div>
      {q.terms && <div style={{ marginTop: 8, whiteSpace: 'pre-line', fontSize: 11 }}>{q.terms}</div>}
    </div>
  )
}

export function PreviewButton({ kind }: { kind: Kind }) {
  const { draft } = useDraft()
  const [open, setOpen] = useState(false)
  const label = kind === 'bill' ? 'bill' : kind === 'report' ? 'report' : 'quotation'
  return (
    <>
      <Button onClick={() => setOpen(true)}>Preview {label}</Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={dialogWidth(640)} title={`Preview ${label} (sample data, nothing is saved)`} destroyOnHidden>
        {kind === 'bill' ? <Bill s={draft} /> : kind === 'report' ? <Report s={draft} /> : <Quotation s={draft} />}
      </Modal>
    </>
  )
}
