import { App, Modal } from 'antd'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { ageText, GENDER_SHORT, tsDate } from '../../components/billing/helpers'
import dayjs from 'dayjs'
import { esc, labHeader, printHtml } from './print'
import type { PatientOrder } from './types'

export default function TrfModal({ order, open, onClose }: { order: PatientOrder; open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const settings = useLabSettings()
  const { testById, sampleTypeById, departmentById } = useCatalogueMaps()
  const d = tsDate(order.createdAt)
  const rows = order.items
    .filter((i) => i.status !== 'refunded')
    .map((i) => {
      const t = i.testIds.length === 1 ? testById.get(i.testIds[0]) : undefined
      return {
        name: i.name,
        urgent: i.urgent,
        sample: t ? sampleTypeById.get(t.sampleTypeId)?.name ?? '' : 'Various',
        dept: t ? departmentById.get(t.departmentId)?.name ?? '' : '',
      }
    })
  const html = () =>
    labHeader(settings, 'Test Requisition Form') +
    `<table><tr><td>Patient</td><td><b>${esc(order.patientName)}</b></td><td>Age / sex</td><td>${esc(ageText(order.ageValue, order.ageUnit))} / ${esc(GENDER_SHORT[order.gender])}</td></tr>
<tr><td>Patient no</td><td>${esc(order.patientNo)}${order.uhid ? ` (UHID ${esc(order.uhid)})` : ''}</td><td>Bill no</td><td>${esc(order.billNo)}</td></tr>
<tr><td>Referred by</td><td>${esc(order.referrerName)}</td><td>Date</td><td>${d ? dayjs(d).format('DD-MMM-YYYY HH:mm') : ''}</td></tr>
<tr><td>Barcode</td><td class="mono">${esc(order.barcode)}</td><td>Clinical notes</td><td>${esc(order.note)}</td></tr></table>
<h2>Tests requested</h2><table><thead><tr><th>#</th><th>Test</th><th>Department</th><th>Sample</th><th>Collected</th></tr></thead><tbody>${rows
      .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}${r.urgent ? ' (URGENT)' : ''}</td><td>${esc(r.dept)}</td><td>${esc(r.sample)}</td><td></td></tr>`)
      .join('')}</tbody></table>
<div class="sig"><div>Patient / representative signature</div><div>Collected by</div><div>Referring doctor signature</div></div>`
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`Test requisition form · ${order.billNo}`}
      okText="Print"
      onOk={() => (printHtml('TRF', html()) ? onClose() : message.error('Allow pop-ups to print.'))}
      destroyOnHidden
    >
      <div className="pl-preview" dangerouslySetInnerHTML={{ __html: html() }} />
    </Modal>
  )
}
