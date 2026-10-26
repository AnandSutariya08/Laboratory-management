import { useEffect, useState } from 'react'
import { Modal, Skeleton } from 'antd'
import { getDocs, orderBy, query } from 'firebase/firestore'
import { StatusChip, type StatusVariant } from '../../design/StatusChip'
import { useLiveQuery } from '../../hooks/useLive'
import { col, deliveriesCol, paths, resultsCol, versionsCol } from '../../lib/db'
import { tsDate } from '../../components/billing/helpers'
import { fmtDateTime } from '../../components/results/common'
import type { Delivery, ResultVersion, TestResult, UserProfile } from '../../types'
import type { PatientOrder } from './types'
import { dialogWidth } from '../../design/dialog'

interface Ev {
  at: Date | null
  label: string
  by: string
  variant: StatusVariant
}
const CH: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', manualWhatsapp: 'WhatsApp (manual)', hardcopy: 'Hard copy' }

export default function ReportTrackingModal({ order, open, onClose }: { order: PatientOrder; open: boolean; onClose: () => void }) {
  const users = useLiveQuery<UserProfile>(query(col(paths.users)), []).data
  const [events, setEvents] = useState<Ev[] | null>(null)

  useEffect(() => {
    if (!open) return
    let dead = false
    setEvents(null)
    const name = (uid: string) => users.find((u) => u.uid === uid)?.name ?? ''
    ;(async () => {
      const ev: Ev[] = [
        { at: tsDate(order.createdAt), label: 'Billed', by: order.createdByName || name(order.createdBy), variant: 'info' },
        { at: tsDate(order.collectedAt), label: 'Sample collected', by: '', variant: 'info' },
        { at: tsDate(order.receivedAt), label: 'Sample received in lab', by: '', variant: 'info' },
        { at: tsDate(order.reportedAt), label: 'Report final', by: '', variant: 'success' },
      ]
      try {
        const rs = await getDocs(resultsCol(order.id))
        for (const r of rs.docs.map((d) => d.data() as TestResult)) {
          const vs = await getDocs(query(versionsCol(order.id, r.testId), orderBy('at')))
          const versions = vs.docs.map((d) => d.data() as ResultVersion)
          const firstSave = versions.find((v) => v.event === 'saved')
          if (firstSave) ev.push({ at: tsDate(firstSave.at), label: `Result entered: ${r.testName}`, by: firstSave.byName, variant: 'caution' })
          versions.filter((v) => v.event === 'approved').forEach((v) => ev.push({ at: tsDate(v.at), label: `Approved: ${r.testName}`, by: v.byName, variant: 'success' }))
          versions.filter((v) => v.event === 'unapproved').forEach((v) => ev.push({ at: tsDate(v.at), label: `Approval withdrawn: ${r.testName}`, by: v.byName, variant: 'urgent' }))
          if (!versions.length && r.updatedAt) ev.push({ at: tsDate(r.updatedAt), label: `${r.status === 'approved' ? 'Approved' : 'Entered'}: ${r.testName}`, by: r.approvedByName || name(r.enteredBy), variant: 'caution' })
        }
        const ds = await getDocs(query(deliveriesCol(order.id), orderBy('at')))
        ds.docs.map((d) => d.data() as Delivery).forEach((d) =>
          ev.push({ at: tsDate(d.at), label: `Dispatched via ${CH[d.channel] ?? d.channel} to ${d.to || 'patient'}: ${d.status}`, by: d.sentByName, variant: d.status === 'failed' ? 'urgent' : 'success' }),
        )
      } catch (e) {
        console.warn(e)
      }
      order.dispatch.filter((x) => x.delivered && x.deliveredAt).forEach((x) =>
        ev.push({ at: tsDate(x.deliveredAt), label: `Marked delivered: ${CH[x.mode] ?? x.mode}`, by: '', variant: 'success' }),
      )
      if (order.printedAt) ev.push({ at: tsDate(order.printedAt), label: 'Printed', by: name(order.printedBy ?? ''), variant: 'neutral' })
      ev.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))
      if (!dead) setEvents(ev.filter((e) => e.at))
    })()
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.id, users.length])

  return (
    <Modal open={open} onCancel={onClose} footer={null} title={`Report tracking · ${order.billNo}`} width={dialogWidth(640)} destroyOnHidden>
      {events === null ? (
        <Skeleton active />
      ) : events.length === 0 ? (
        <p>No tracking events yet.</p>
      ) : (
        <ol className="pl-timeline">
          {events.map((e, i) => (
            <li key={i}>
              <time>{fmtDateTime(e.at)}</time>
              <div>
                <StatusChip variant={e.variant}>{e.label}</StatusChip>
                {e.by && <div className="pl-sub">by {e.by}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  )
}
