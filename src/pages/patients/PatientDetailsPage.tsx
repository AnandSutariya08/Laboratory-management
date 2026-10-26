import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Table } from 'antd'
import { useNavigate, useParams } from 'react-router-dom'
import dayjs from 'dayjs'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { PageHeader } from '../../design/PageHeader'
import { Skeleton } from 'antd'
import { StatusChip } from '../../design/StatusChip'
import { useLiveDoc } from '../../hooks/useLive'
import { docRef, paths } from '../../lib/db'
import { formatINR } from '../../lib/money'
import BillReceipt from '../../components/billing/BillReceipt'
import { PaymentStatusChip } from '../../components/billing/PaymentStatusChip'
import ClearDueModal from '../../components/billing/ClearDueModal'
import { ageText, GENDER_SHORT, tsDate } from '../../components/billing/helpers'
import DocumentsCard from '../../features/patient/DocumentsCard'
import EditPatientModal from '../../features/patient/EditPatientModal'
import MergePatientModal, { restoreMerge } from '../../features/patient/MergePatientModal'
import TrendCard from '../../features/patient/TrendCard'
import { fetchPatientOrders } from '../../features/patient/lib'
import type { PatientDoc, PatientOrder } from '../../features/patient/types'
import '../../features/patient/patient.css'

export default function PatientDetailsPage() {
  const { patientId = '' } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { data: patient, loading } = useLiveDoc<PatientDoc>(patientId ? docRef<PatientDoc>(paths.patients, patientId) : null, [patientId])
  const [orders, setOrders] = useState<PatientOrder[] | null>(null)
  const [edit, setEdit] = useState(false)
  const [merge, setMerge] = useState(false)
  const [bill, setBill] = useState<string | null>(null)
  const [dueFor, setDueFor] = useState<string | null>(null)
  const isAdmin = profile?.role === 'labAdmin' || profile?.role === 'admin'

  const { message } = App.useApp()
  const restore = async () => {
    if (!profile || !patient) return
    try {
      await restoreMerge(patient, profile)
      message.success('Merge restored')
      reload()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const reload = useCallback(() => {
    fetchPatientOrders(patientId, profile)
      .then((o) => setOrders(o.sort((a, b) => (tsDate(b.createdAt)?.getTime() ?? 0) - (tsDate(a.createdAt)?.getTime() ?? 0))))
      .catch(() => setOrders([]))
  }, [patientId, profile])
  useEffect(reload, [reload])

  if (loading) return <Skeleton active />
  if (!patient) return <EmptyState title="Patient not found" action={<Button onClick={() => navigate('/patients')}>Back to Patient List</Button>} />

  const list = orders ?? []
  const billed = list.reduce((s, o) => s + o.net, 0)
  const paid = list.reduce((s, o) => s + o.paid, 0)
  const due = list.reduce((s, o) => s + o.due, 0)
  const dueOrder = list.find((o) => o.id === dueFor) ?? null

  return (
    <div className="pl-stack">
      <PageHeader
        title={`${patient.salutation} ${patient.firstName} ${patient.lastName}`.replace(/\s+/g, ' ')}
        subtitle={`${patient.patientNo} · ${ageText(patient.ageValue, patient.ageUnit)} / ${GENDER_SHORT[patient.gender]}${patient.uhid ? ` · UHID ${patient.uhid}` : ''}`}
        actions={
          <>
            <Button onClick={() => navigate('/patients')}>Patient List</Button>
            {can(profile, 'patients.merge') && !patient.merged && <Button onClick={() => setMerge(true)}>Merge patient</Button>}
            {isAdmin && patient.merged && <Button onClick={() => void restore()}>Restore merge</Button>}
            {can(profile, 'patients.edit') && <Button variant="primary" onClick={() => setEdit(true)}>Edit patient</Button>}
          </>
        }
      />
      {patient.merged && (
        <Alert type="info" showIcon message="This patient was merged into another record." action={patient.mergedInto && <Button onClick={() => navigate(`/patients/${patient.mergedInto}`)}>Open</Button>} />
      )}

      <div className="pl-kpis">
        <Card className="pl-kpi"><span className="pl-sub">Visits</span><b>{list.length}</b></Card>
        <Card className="pl-kpi"><span className="pl-sub">Billed</span><b>{formatINR(billed)}</b></Card>
        <Card className="pl-kpi"><span className="pl-sub">Paid</span><b>{formatINR(paid)}</b></Card>
        <Card className="pl-kpi"><span className="pl-sub">Dues</span><b style={due > 0 ? { color: 'var(--c-urgent)' } : undefined}>{formatINR(due)}</b></Card>
      </div>

      <Card padding="var(--s-5)">
        <h2 className="pl-card-title">Demographics</h2>
        <div className="pl-grid2">
          <div><span className="pl-sub">Phone</span><div>{patient.phone || '-'}</div></div>
          <div><span className="pl-sub">Email</span><div>{patient.email || '-'}</div></div>
          <div><span className="pl-sub">Referring doctor</span><div>{patient.referrerName || 'Self'}</div></div>
          <div><span className="pl-sub">Referring hospital</span><div>{patient.referrerHospital || '-'}</div></div>
          <div><span className="pl-sub">Dispatch methods</span><div>{patient.dispatchModes.join(', ') || '-'}</div></div>
          <div><span className="pl-sub">ABHA</span><div>{patient.abhaNumber || '-'}</div></div>
          <div><span className="pl-sub">Address</span><div>{[patient.address, patient.town, patient.city, patient.district, patient.pincode].filter(Boolean).join(', ') || '-'}</div></div>
          <div><span className="pl-sub">Insurance no.</span><div>{patient.insuranceNo || '-'}</div></div>
          <div><span className="pl-sub">Weight / height</span><div>{patient.weight ? `${patient.weight} kg` : '-'} / {patient.height ? `${patient.height} cm` : '-'}</div></div>
          <div><span className="pl-sub">Clinical history</span><div>{patient.clinicalHistory || '-'}</div></div>
          <div><span className="pl-sub">Corporate user</span><div>{patient.corporateUser || '-'}</div></div>
          {(patient.species || patient.breed || patient.ownerName) && <div><span className="pl-sub">Animal</span><div>{[patient.species, patient.breed, patient.ownerName && `owner ${patient.ownerName}`].filter(Boolean).join(' · ')}</div></div>}
          <div><span className="pl-sub">Aadhaar</span><div>{patient.aadhaar ? `XXXX XXXX ${patient.aadhaar.slice(-4)}` : '-'}</div></div>
        </div>
      </Card>

      <Card padding="var(--s-5)">
        <h2 className="pl-card-title">Lab report history</h2>
        <Table<PatientOrder>
          size="small"
          rowKey="id"
          loading={orders === null}
          dataSource={list}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 900 }}
          locale={{ emptyText: <EmptyState title="No visits yet" /> }}
          columns={[
            { title: 'Bill date', render: (_, o) => dayjs(tsDate(o.createdAt)).format('DD MMM YYYY'), width: 110 },
            { title: 'Bill ID', dataIndex: 'billNo', width: 110 },
            { title: 'Tests', render: (_, o) => o.items.map((i) => i.name).join(', ') },
            { title: 'Referral', dataIndex: 'referrerName', width: 130 },
            { title: 'Amount', align: 'right', render: (_, o) => formatINR(o.net), width: 100 },
            { title: 'Due', align: 'right', render: (_, o) => (o.due > 0 ? <span className="pl-money-due">{formatINR(o.due)}</span> : '-'), width: 90 },
            { title: 'Payment', width: 120, render: (_, o) => <PaymentStatusChip order={o} /> },
            { title: 'Status', width: 120, render: (_, o) => <StatusChip variant={o.reportStatus === 'final' ? 'success' : o.reportStatus === 'pending' ? 'neutral' : 'caution'}>{o.reportStatus === 'final' ? 'Completed' : o.reportStatus === 'pending' ? 'Pending' : o.reportStatus}</StatusChip> },
            { title: 'Branch', render: (_, o) => o.branchId || 'main', width: 90 },
            {
              title: 'Action', width: 230,
              render: (_, o) => (
                <div className="pl-actions">
                  <Button onClick={() => setBill(o.id)}>Bill</Button>
                  <Button onClick={() => window.open(`/report/${o.id}`, '_blank')}>Report</Button>
                  {o.due > 0 && can(profile, 'billing.clearDue') && can(profile, 'payment.collect') && <Button onClick={() => setDueFor(o.id)}>Clear due</Button>}
                </div>
              ),
            },
          ]}
        />
      </Card>

      <TrendCard orders={list} />
      <DocumentsCard patientId={patient.id} />

      <EditPatientModal patient={patient} open={edit} onClose={() => { setEdit(false); reload() }} />
      <MergePatientModal source={patient} open={merge} onClose={() => { setMerge(false); reload() }} />
      <BillReceipt open={!!bill} orderId={bill} onClose={() => setBill(null)} />
      {dueOrder && <ClearDueModal order={dueOrder} open onClose={() => { setDueFor(null); reload() }} />}
    </div>
  )
}
