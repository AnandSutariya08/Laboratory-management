import { App, Popconfirm, Table, Upload } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import { addDoc, collection, deleteDoc, doc, orderBy, query, serverTimestamp } from 'firebase/firestore'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { EmptyState } from '../../design/EmptyState'
import { useAuth } from '../../auth/AuthProvider'
import { db, LAB_ID } from '../../firebase'
import { useLiveQuery } from '../../hooks/useLive'
import { fmtDateTime } from '../../components/results/common'
import type { PatientDocument } from './types'

const MAX = 500 * 1024
const docsCol = (pid: string) => collection(db, 'labs', LAB_ID, 'patients', pid, 'documents')

export default function DocumentsCard({ patientId }: { patientId: string }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const { data, loading } = useLiveQuery<PatientDocument>(query(docsCol(patientId), orderBy('uploadedAt', 'desc')), [patientId])
  const isAdmin = profile?.role === 'labAdmin' || profile?.role === 'admin'

  const upload = (file: File) => {
    if (file.size > MAX) {
      message.error('File is larger than 500 KB.')
      return false
    }
    const r = new FileReader()
    r.onload = async () => {
      try {
        await addDoc(docsCol(patientId), {
          name: file.name,
          mime: file.type,
          size: file.size,
          note: '',
          dataUrl: String(r.result),
          uploadedBy: profile?.uid ?? '',
          uploadedByName: profile?.name ?? '',
          uploadedAt: serverTimestamp(),
        })
        message.success('Document uploaded')
      } catch (e) {
        message.error((e as Error).message)
      }
    }
    r.readAsDataURL(file)
    return false
  }

  return (
    <Card padding="var(--s-5)">
      <h2 className="pl-card-title">
        Documents
        <Upload accept="image/*,application/pdf" showUploadList={false} beforeUpload={upload}>
          <Button icon={<UploadOutlined />}>Upload (max 500 KB)</Button>
        </Upload>
      </h2>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={data}
        pagination={false}
        locale={{ emptyText: <EmptyState title="No documents" description="Upload prescriptions, ID or earlier reports." /> }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: (n: string, d) => <a href={d.dataUrl} download={n} target="_blank" rel="noreferrer">{n}</a> },
          { title: 'Size', dataIndex: 'size', width: 90, render: (s: number) => `${Math.ceil(s / 1024)} KB` },
          { title: 'Uploaded', width: 200, render: (_, d) => `${fmtDateTime(d.uploadedAt)} · ${d.uploadedByName}` },
          {
            title: '',
            width: 90,
            render: (_, d) =>
              isAdmin ? (
                <Popconfirm title="Delete this document?" onConfirm={() => deleteDoc(doc(docsCol(patientId), d.id))}>
                  <Button variant="text" aria-label={`Delete ${d.name}`}>Delete</Button>
                </Popconfirm>
              ) : null,
          },
        ]}
      />
    </Card>
  )
}
