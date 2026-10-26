import { useState } from 'react'
import { App, Modal, Select, Table } from 'antd'
import { deleteDoc, updateDoc } from 'firebase/firestore'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { col, docRef, paths } from '../../lib/db'
import { Button } from '../../design/Button'
import type { ParameterExt, TestExt } from './ext'

// Unmapped analyser results (CAT-12): codes the analyser sent that match no test or parameter machine code.
// Mapping a code adds it to the chosen parameter's machine codes (comma separated); the rows for that code are cleared.
interface Row { id: string; machineName?: string; barcode?: string; code: string; value?: string; reason?: string; at?: { toMillis: () => number } }

export function UnmappedInbox({ canEdit }: { canEdit: boolean }) {
  const { message } = App.useApp()
  const rows = useLiveQuery<Row>(col('analyserUnmatched'), []).data.filter((r) => r.code)
  const { tests } = useCatalogueMaps()
  const [mapping, setMapping] = useState<Row | null>(null)
  const [target, setTarget] = useState<string | undefined>()
  const options = (tests as TestExt[]).flatMap((t) =>
    (t.parameters as ParameterExt[]).filter((p) => p.structure !== 'group').map((p) => ({ value: `${t.id}|${p.key}`, label: `${t.name} / ${p.name}` })),
  )
  const apply = async () => {
    if (!mapping || !target) return
    const [tid, key] = target.split('|')
    const t = (tests as TestExt[]).find((x) => x.id === tid)
    if (!t) return
    try {
      await updateDoc(docRef(paths.tests, tid), {
        parameters: (t.parameters as ParameterExt[]).map((p) => (p.key === key ? { ...p, machineCode: [...new Set([...(p.machineCode ?? '').split(',').map((x) => x.trim()).filter(Boolean), mapping.code])].join(',') } : p)),
      })
      await Promise.all(rows.filter((r) => r.code === mapping.code).map((r) => deleteDoc(docRef('analyserUnmatched', r.id))))
      message.success(`Code ${mapping.code} mapped. Send the result again from the analyser to pick it up.`)
      setMapping(null)
      setTarget(undefined)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  if (!rows.length) return null
  return (
    <div className="cat-stack">
      <h3 className="cat-section-title">Unmapped analyser results ({rows.length})</h3>
      <Table<Row> size="small" rowKey="id" dataSource={rows} pagination={{ pageSize: 5, showSizeChanger: false }}
        columns={[
          { title: 'Machine', dataIndex: 'machineName' },
          { title: 'Code', dataIndex: 'code', render: (c: string) => <span className="cat-code">{c}</span> },
          { title: 'Value', dataIndex: 'value' },
          { title: 'Barcode', dataIndex: 'barcode' },
          { title: 'Why', dataIndex: 'reason' },
          {
            title: '', width: 170,
            render: (_, r) => (
              <span className="cat-toolbar" style={{ margin: 0 }}>
                <Button variant="text" disabled={!canEdit} onClick={() => setMapping(r)}>Map code</Button>
                <Button variant="text" disabled={!canEdit} onClick={() => void deleteDoc(docRef('analyserUnmatched', r.id))}>Dismiss</Button>
              </span>
            ),
          },
        ]} />
      <Modal title={`Map analyser code ${mapping?.code ?? ''}`} open={!!mapping} onCancel={() => setMapping(null)} onOk={() => void apply()} okButtonProps={{ disabled: !target }} destroyOnHidden>
        <Select showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="Test / parameter" value={target} onChange={setTarget} options={options} />
      </Modal>
    </div>
  )
}
