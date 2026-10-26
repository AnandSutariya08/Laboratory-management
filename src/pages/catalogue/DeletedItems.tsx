import { App, Modal, Table } from 'antd'
import { setDoc } from 'firebase/firestore'
import { useDeletedCatalogue, useTests } from '../../hooks/useCatalogue'
import { docRef, paths } from '../../lib/db'
import { Button } from '../../design/Button'
import type { TestExt } from './ext'

// Restore view for soft-deleted catalogue items (X-02): tests, packages, departments and samples.
export function DeletedItemsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const del = useDeletedCatalogue()
  const tests = (useTests().data as TestExt[]).filter((t) => t.deleted)
  const rows = [
    ...tests.map((t) => ({ key: `t${t.id}`, kind: 'Test', name: `${t.name} (${t.code})`, coll: paths.tests, id: t.id, patch: { deleted: false, disabled: false } })),
    ...del.packages.map((p) => ({ key: `p${p.id}`, kind: 'Package', name: p.name, coll: paths.packages, id: p.id, patch: { deleted: false } })),
    ...del.departments.map((d) => ({ key: `d${d.id}`, kind: 'Department', name: d.name, coll: paths.departments, id: d.id, patch: { deleted: false } })),
    ...del.sampleTypes.map((s) => ({ key: `s${s.id}`, kind: 'Sample', name: s.name, coll: paths.sampleTypes, id: s.id, patch: { deleted: false } })),
  ]
  const restore = (r: (typeof rows)[number]) =>
    setDoc(docRef(r.coll, r.id), r.patch, { merge: true }).then(() => message.success(`${r.name} restored`)).catch((e) => message.error((e as Error).message))
  return (
    <Modal title="Deleted items" open={open} onCancel={onClose} footer={null} destroyOnHidden>
      <Table size="small" rowKey="key" pagination={{ pageSize: 8, showSizeChanger: false }} dataSource={rows} locale={{ emptyText: 'Nothing deleted' }}
        columns={[
          { title: 'Type', dataIndex: 'kind', width: 110 },
          { title: 'Name', dataIndex: 'name' },
          { title: '', width: 90, render: (_, r) => <Button variant="text" onClick={() => void restore(r)}>Restore</Button> },
        ]} />
    </Modal>
  )
}
