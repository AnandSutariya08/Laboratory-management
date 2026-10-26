import { useEffect, useMemo, useState } from 'react'
import { Checkbox, Modal } from 'antd'
import { BarcodeOutlined, DownloadOutlined, FileTextOutlined, PrinterOutlined, SendOutlined, ExperimentOutlined } from '@ant-design/icons'
import qrcode from 'qrcode-generator'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { orderBy, query } from 'firebase/firestore'
import { displayId, lineNet } from '../../lib/billing'
import { countBillPrint } from '../../lib/orders'
import { createReportShare } from '../../lib/messaging'
import { docRef, ledgerCol, paths } from '../../lib/db'
import { useMasters } from '../../lib/masters'
import { modeLabel } from '../../lib/masters'
import { formatINR, rupeesInWords } from '../../lib/money'
import { esc, printHtml } from '../../features/partners/lib/print'
import { billTax, formatLabDate, labContactLine, showCommissionOnBills, upiPayLink } from '../../features/settings/lib'
import { ensureBillPin } from '../../features/report/api'
import { useReportLayout } from '../../features/report/layout'
import { commissionForReferrer } from '../../features/partners/lib/commission'
import { can, useAuth } from '../../auth/AuthProvider'
import { showPackageTestsOnBill } from '../../pages/catalogue/behaviour'
import { preCollectionGuidelines } from '../../pages/catalogue/flags'
import type { LedgerEntry, Order } from '../../types'
import SendReportModal from '../messaging/SendReportModal'
import { ageText, DISPATCH_LABEL, GENDER_SHORT, tsDate } from './helpers'
import './billing.css'
import { dialogWidth } from '../../design/dialog'

interface Props {
  open: boolean
  orderId: string | null
  onClose: () => void
}

function qrDataUrl(text: string): string {
  try {
    const q = qrcode(0, 'M')
    q.addData(text)
    q.make()
    return q.createDataURL(3, 0)
  } catch {
    return ''
  }
}

type Layout = 'a4' | 'thermal'

export default function BillReceipt({ open, orderId, onClose }: Props) {
  const settings = useLabSettings()
  const bd = settings.billDetails
  const navigate = useNavigate()
  const [layout, setLayout] = useState<Layout | null>(null)
  const [showHeader, setShowHeader] = useState(true)
  const [showFooter, setShowFooter] = useState(true)
  const [sendOpen, setSendOpen] = useState(false)
  const thermal = (layout ?? (bd.thermalEnabled && bd.defaultPrint === 'thermal' ? 'thermal' : 'a4')) === 'thermal'
  const { data: order } = useLiveDoc<Order>(orderId ? docRef<Order>(paths.orders, orderId) : null, [orderId])
  const { data: ledger } = useLiveQuery<LedgerEntry>(orderId ? query(ledgerCol(orderId), orderBy('postedAt')) : null, [orderId])

  const cat = useCatalogueMaps()
  const { profile } = useAuth()
  const masters = useMasters()
  const layoutCfg = useReportLayout()

  // Bill PIN: the patient types it on the public report page instead of waiting for a code. Printed on the bill.
  const [pin, setPin] = useState('')
  const pinOrderId = order?.id
  useEffect(() => {
    setPin('')
    if (!open || !pinOrderId || layoutCfg.publicBillPin === false) return
    let dead = false
    ensureBillPin(pinOrderId).then((p) => !dead && setPin(p)).catch(() => undefined)
    return () => {
      dead = true
    }
  }, [open, pinOrderId, layoutCfg.publicBillPin])

  // Settings > Referrals > show commission on bills: a staff-only line, never on the printed copy.
  const commissionParts = useMemo(() => {
    if (!order || !showCommissionOnBills(settings) || !can(profile, 'referrals.view')) return []
    const ids = [order.referrerId, order.hospitalId, order.secondReferrerId].filter((x): x is string => !!x)
    const bearerSrc = order.referrerId ? masters.referrerById.get(order.referrerId) : undefined
    const co = { gross: order.gross, net: order.net, paid: order.paid, discount: order.discount, items: order.items, referrerId: order.referrerId, hospitalId: order.hospitalId, secondReferrerId: order.secondReferrerId, discountBearer: order.discountBearer ?? bearerSrc?.discountBearer, discountSplitReferrerPct: order.discountSplitReferrerPct ?? bearerSrc?.discountSplitReferrerPct }
    return ids.flatMap((id) => {
      const r = masters.referrerById.get(id)
      return r ? [{ name: r.name, amount: commissionForReferrer(co as never, r, settings.referrals.commissionBasis) }] : []
    })
  }, [order, settings, profile, masters.referrerById])
  // Money in per mode: payments and due clearances less reversals (refunds are shown separately).
  const modes = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of ledger.filter((x) => x.type !== 'refund')) m.set(l.mode, (m.get(l.mode) ?? 0) + l.amount)
    return Array.from(m.entries()).filter(([, v]) => v !== 0)
  }, [ledger])

  // The bill QR opens the secure report-status page (/r/{token}); the token is created server-side on demand.
  const [qrToken, setQrToken] = useState('')
  const orderIdLive = order?.id
  useEffect(() => {
    setQrToken('')
    if (!orderIdLive) return
    let dead = false
    createReportShare(orderIdLive).then((t) => !dead && setQrToken(t)).catch(() => undefined)
    return () => {
      dead = true
    }
  }, [orderIdLive])
  const qr = useMemo(
    () => (qrToken ? qrDataUrl(`${(settings.publicAppUrl || window.location.origin).replace(/\/+$/, '')}/r/${qrToken}`) : ''),
    [qrToken, settings.publicAppUrl],
  )

  // UPI QR (lab UPI id from Bill settings) so the patient can pay the balance on the spot.
  // A collection centre's own bill pays to the centre's UPI id when it has one (Collection centre > UPI ID).
  const centreUpi = useMasters().collectionCentres.find((c) => c.id === order?.collectionCentreId)
  const upiQr = useMemo(() => {
    const own = centreUpi?.upiId?.trim()
    if (!order || !(own || bd.upiId?.trim()) || order.due <= 0) return ''
    return qrDataUrl(upiPayLink({ ...settings, billDetails: { ...settings.billDetails, upiId: own || settings.billDetails.upiId } }, order.due, order.billNo))
  }, [order, bd.upiId, settings, centreUpi?.upiId])
  const prints = order?.billPrints ?? 0
  const tax = billTax(settings, order?.net ?? 0)
  const guidelines = order ? preCollectionGuidelines(order.items.filter((i) => i.status !== 'refunded').flatMap((i) => i.testIds.map((t) => cat.testById.get(t)))) : []
  const receiptNos = Array.from(new Set(ledger.filter((l) => l.type !== 'refund' && l.receiptNo).map((l) => l.receiptNo as string)))
  // The browser's print dialog saves a PDF: name the document after the bill so the file is named well.
  const downloadPdf = () => {
    if (!order) return
    const prev = document.title
    document.title = `Bill-${order.billNo}`
    window.print()
    document.title = prev
    void countBillPrint(order).catch(() => undefined)
  }
  const printBill = () => {
    if (!order) return
    window.print()
    void countBillPrint(order).catch(() => undefined)
  }

  const width = thermal ? '80mm' : '190mm'
  const fs = thermal ? 11 : 13
  const created = tsDate(order?.billDate) ?? tsDate(order?.createdAt) ?? new Date()
  const logo = settings.profile?.logoDataUrl

  const printTrf = () => {
    if (!order) return
    const rows = order.items.filter((i) => !i.isCharge && i.status !== 'refunded').map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.name)}</td><td>${esc(i.code)}</td></tr>`).join('')
    printHtml(
      `TRF ${order.billNo}`,
      `<h1>${esc(settings.name)} - Test Request Form</h1>
       <div class="meta"><div><b>${esc(order.patientName)}</b><br>${esc(ageText(order.ageValue, order.ageUnit))} / ${GENDER_SHORT[order.gender]}<br>Patient ${esc(order.patientNo)}${order.uhid ? ` · UHID ${esc(order.uhid)}` : ''}</div>
       <div>Bill ${esc(order.billNo)}<br>${formatLabDate(settings, created, true)}<br>Referred by ${esc(order.referrerName)}</div></div>
       <table><tr><th>#</th><th>Test</th><th>Code</th></tr>${rows}</table>
       <p>${esc(settings.docTemplates?.trfText ?? '')}</p>
       <p style="margin-top:48px">Patient / guardian signature: ____________________ &nbsp; Collected by: ____________________</p>`,
    )
  }
  const printBarcode = () => {
    if (!order) return
    printHtml(
      `Label ${order.barcode}`,
      `<div style="text-align:center;font-family:monospace"><div style="font-size:22px;letter-spacing:4px">*${esc(order.barcode)}*</div><div>${esc(order.patientName)}</div><div>${esc(order.billNo)}</div></div>`,
    )
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={typeof (thermal ? 460 : 860) === 'number' ? dialogWidth(thermal ? 460 : 860) : (thermal ? 460 : 860)}
      title="Bill receipt"
      destroyOnHidden
      footer={
        <div className="bill-actions" style={{ alignItems: 'center' }}>
          <Segmented<Layout>
            size="small"
            aria-label="Receipt layout"
            value={thermal ? 'thermal' : 'a4'}
            onChange={setLayout}
            options={[{ value: 'a4', label: 'A4' }, { value: 'thermal', label: 'Thermal 80mm' }]}
          />
          <Checkbox checked={showHeader} onChange={(e) => setShowHeader(e.target.checked)}>Header</Checkbox>
          <Checkbox checked={showFooter} onChange={(e) => setShowFooter(e.target.checked)}>Footer</Checkbox>
          <Button icon={<BarcodeOutlined />} disabled={!order} onClick={printBarcode}>Barcode</Button>
          <Button icon={<FileTextOutlined />} disabled={!order} onClick={printTrf}>TRF</Button>
          <Button icon={<ExperimentOutlined />} disabled={!order} onClick={() => order && navigate(`/results/${order.id}`)}>Enter results</Button>
          <Button icon={<SendOutlined />} disabled={!order} onClick={() => setSendOpen(true)}>Send</Button>
          <Button icon={<DownloadOutlined />} disabled={!order} onClick={downloadPdf}>Download PDF</Button>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<PrinterOutlined />} onClick={printBill} disabled={!order}>
            Print
          </Button>
        </div>
      }
    >
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #bill-receipt-print, #bill-receipt-print * { visibility: visible !important; }
          #bill-receipt-print { position: absolute; left: 0; top: 0; width: ${width}; border: none !important; }
          @page { size: ${thermal ? '80mm auto' : 'A4'}; margin: ${thermal ? '3mm' : '12mm'}; }
        }
      `}</style>
      {!order ? (
        <p className="bill-muted">Loading bill...</p>
      ) : (
        <div
          id="bill-receipt-print"
          className="bill-paper"
          style={{ width, padding: thermal ? 8 : 20, fontSize: fs, fontFamily: thermal ? 'monospace' : 'inherit' }}
        >
          {showHeader && (
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              {logo && <img src={logo} alt="" style={{ maxHeight: 48, maxWidth: '100%' }} />}
              <div style={{ fontSize: fs + 5, fontWeight: 700 }}>{settings.name}</div>
              <div>{[settings.address, settings.profile.city].filter(Boolean).join(', ')}</div>
              <div>{labContactLine(settings)}</div>
              {bd.gstEnabled && bd.gstin && <div>GSTIN {bd.gstin}{bd.hsnCode ? `  |  HSN/SAC ${bd.hsnCode}` : ''}</div>}
              {bd.header && <div style={{ whiteSpace: 'pre-line' }}>{bd.header}</div>}
            </div>
          )}
          <div style={{ textAlign: 'center', fontWeight: 600 }}>
            BILL RECEIPT{prints >= 1 && <span style={{ marginLeft: 8, border: '1px solid currentColor', padding: '0 6px', letterSpacing: 2 }}>DUPLICATE</span>}
          </div>
          <hr />
          <table style={{ fontSize: fs }}>
            <tbody>
              <tr><td>Bill No</td><td><b>{order.billNo}</b></td><td>Date</td><td>{formatLabDate(settings, created, true)}</td></tr>
              <tr><td>{settings.registration.idDisplay === 'uhid' ? 'UHID' : 'Patient No'}</td><td>{displayId(order, settings.registration.idDisplay)}</td><td>Age / Sex</td><td>{ageText(order.ageValue, order.ageUnit)} / {GENDER_SHORT[order.gender]}</td></tr>
              {order.uhid && settings.registration.idDisplay !== 'uhid' && <tr><td>UHID</td><td colSpan={3}>{order.uhid}</td></tr>}
              <tr><td>Name</td><td colSpan={3}><b>{order.patientName}</b></td></tr>
              <tr><td>Referred by</td><td colSpan={3}>{order.referrerName}{order.secondReferrerName ? `, ${order.secondReferrerName}` : ''}</td></tr>
              {bd.showReportDelivery && order.dispatch.length > 0 && <tr><td>Report via</td><td colSpan={3}>{order.dispatch.map((d) => DISPATCH_LABEL[d.mode] ?? d.mode).join(', ')}</td></tr>}
              {order.priority === 'urgent' && <tr><td>Priority</td><td colSpan={3}><b>URGENT</b></td></tr>}
              {pin && <tr><td>Bill PIN</td><td colSpan={3}><b style={{ letterSpacing: 3 }}>{pin}</b> <span style={{ fontSize: fs - 3 }}>(for the online report)</span></td></tr>}
              {modes.length > 0 && <tr><td>Payment mode</td><td colSpan={3}>{modes.map(([m]) => modeLabel(m)).join(', ')}</td></tr>}
              {receiptNos.length > 0 && <tr><td>Receipt no</td><td colSpan={3}>{receiptNos.join(', ')}</td></tr>}
              {bd.showBilledBy && ledger[0] && <tr><td>Billed by</td><td colSpan={3}>{ledger[0].postedByName}</td></tr>}
            </tbody>
          </table>
          <hr />
          <table style={{ fontSize: fs }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th>#</th>
                <th>Test / Package</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                {bd.showLineDiscount && <th style={{ textAlign: 'right' }}>Disc.</th>}
                {bd.showLineDiscount && <th style={{ textAlign: 'right' }}>Net</th>}
              </tr>
            </thead>
            <tbody>
              {/* Packages first, refunded lines are not printed, line amounts are the gross prices (the discount is in the totals). */}
              {order.items.filter((i) => !(i.isCharge && i.showOnBill === false) && i.status !== 'refunded').sort((a, b) => Number(b.kind === 'package') - Number(a.kind === 'package')).map((i, n) => {
                return (
                  <tr key={i.lineId}>
                    <td>{n + 1}</td>
                    <td>
                      {i.name}
                      {bd.showTestCode && !i.isCharge ? ` (${i.code})` : ''}
                      {i.urgent ? ' (Urgent)' : ''}
                      {i.kind === 'package' && !i.isCharge && showPackageTestsOnBill(cat.packageById.get(i.refId) as never) && (
                        <div style={{ fontSize: fs - 2, color: '#555' }}>({i.testIds.map((t) => cat.testById.get(t)?.name ?? '').filter(Boolean).join(', ')})</div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatINR(i.price)}</td>
                    {bd.showLineDiscount && <td style={{ textAlign: 'right' }}>{formatINR(i.discount)}</td>}
                    {bd.showLineDiscount && <td style={{ textAlign: 'right' }}>{formatINR(lineNet(i))}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <hr />
          <table style={{ fontSize: fs }}>
            <tbody>
              <Row label="Sub total" value={formatINR(order.gross)} />
              <Row label="Discount" value={`- ${formatINR(order.discount)}`} />
              <Row label="Total" value={formatINR(order.net)} bold />
              {tax.tax > 0 && <Row label={`  incl. GST ${tax.percent}% (taxable ${formatINR(tax.taxable)})`} value={formatINR(tax.tax)} />}
              {order.payer && <Row label={`Paid by ${order.payer.name}`} value={formatINR(order.payer.amount)} />}
              <Row label="Payment made" value={formatINR(order.paid)} />
              <Row label="Balance due" value={formatINR(order.due)} bold />
              {bd.showPaymentBreakup && modes.map(([m, a]) => <Row key={m} label={`  ${modeLabel(m)}`} value={formatINR(a)} />)}
            </tbody>
          </table>
          <div style={{ marginTop: 6 }}>
            <b>In words:</b> Rupees {rupeesInWords(order.net)}
          </div>
          {commissionParts.length > 0 && (
            <div className="no-print" style={{ marginTop: 4, fontSize: fs - 1, color: '#555' }}>
              Commission (staff only): {commissionParts.map((c) => `${c.name} ${formatINR(c.amount)}`).join(', ')}
            </div>
          )}
          {order.corporatePlan && !order.hidePlan && <div style={{ marginTop: 4 }}>Plan: {order.corporatePlan}</div>}
          {order.note && <div style={{ marginTop: 4 }}>Note: {order.note}</div>}
          {guidelines.length > 0 && (
            <div style={{ marginTop: 6, fontSize: fs - 1 }}>
              <b>Pre-collection guidelines</b>
              {guidelines.map((g) => <div key={g.text}>{g.name}: {g.text}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 8 }}>
            {bd.showBarcode !== false && (
              <div style={{ textAlign: 'center', flex: 1 }}>
                <div style={{ fontFamily: 'monospace', letterSpacing: 4, fontSize: fs + 3 }}>*{order.barcode}*</div>
                <div style={{ fontSize: fs - 2 }}>Sample ID {order.barcode}</div>
              </div>
            )}
            {upiQr && (
              <div style={{ textAlign: 'center' }}>
                <img src={upiQr} alt={`UPI QR to pay ${formatINR(order.due)}`} width={centreUpi?.qrWidth || (thermal ? 70 : 84)} height={centreUpi?.qrHeight || (thermal ? 70 : 84)} />
                <div style={{ fontSize: fs - 3 }}>Pay {formatINR(order.due)} by UPI</div>
              </div>
            )}
            {qr && (
              <div style={{ textAlign: 'center' }}>
                <img src={qr} alt={`QR code for bill ${order.billNo}`} width={thermal ? 70 : 84} height={thermal ? 70 : 84} />
                <div style={{ fontSize: fs - 3 }}>Scan to download report</div>
              </div>
            )}
          </div>
          {prints > 0 && <div style={{ marginTop: 6, fontSize: fs - 3, textAlign: 'center' }}>Printed {prints} time{prints > 1 ? 's' : ''}</div>}
          {showFooter && (bd.footer || bd.terms) && (
            <div style={{ marginTop: 10, fontSize: fs - 2, whiteSpace: 'pre-line', textAlign: 'center' }}>
              {[bd.footer, bd.terms].filter(Boolean).join('\n')}
            </div>
          )}
        </div>
      )}
      {order && <SendReportModal order={order} open={sendOpen} onClose={() => setSendOpen(false)} />}
    </Modal>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <tr style={bold ? { fontWeight: 700 } : undefined}>
      <td style={{ whiteSpace: 'pre' }}>{label}</td>
      <td style={{ textAlign: 'right' }}>{value}</td>
    </tr>
  )
}
