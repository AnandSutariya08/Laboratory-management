import { useRef, useState } from 'react'
import { App, Modal, Table } from 'antd'
import { addDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { col, docRef, paths } from '../../lib/db'
import { Button } from '../../design/Button'
import type { Parameter } from '../../types'
import { downloadText } from './helpers'
import type { TestExt } from './ext'
import { dialogWidth } from '../../design/dialog'

// Master catalogue sync as import / export (CAT-05). There is no central master service: a "master" is a
// JSON file exported from any lab (this screen's Export) and imported into another. Import shows a field
// diff per test and applies only the ticked changes; prices are NEVER read from or written by the file.
// New tests are added disabled with a zero price, to be priced and enabled by a person.
interface MasterTest {
  code: string
  name: string
  department: string
  sample: string
  gender: string
  tatMinutes: number | null
  urgentTatMinutes: number | null
  interpretation: string
  parameters: Parameter[]
}
interface MasterFile { kind: 'catalogue-master'; version: 1; exportedAt: string; tests: MasterTest[] }
interface Change { key: string; code: string; test: MasterTest; existing?: TestExt; fields: string[] }

const paramSig = (ps: Parameter[]) => JSON.stringify((ps ?? []).map((p) => [p.key, p.name, p.unit, p.low, p.high, p.displayRange, p.dataType]))

export default function MasterSyncModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const maps = useCatalogueMaps()
  const tests = maps.tests as TestExt[]
  const file = useRef<HTMLInputElement>(null)
  const [changes, setChanges] = useState<Change[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const exportMaster = () => {
    const f: MasterFile = {
      kind: 'catalogue-master', version: 1, exportedAt: new Date().toISOString(),
      tests: tests.filter((t) => !t.deleted).map((t) => ({
        code: t.code, name: t.name, department: maps.departmentById.get(t.departmentId)?.name ?? '', sample: maps.sampleTypeById.get(t.sampleTypeId)?.name ?? '',
        gender: t.gender, tatMinutes: t.tatMinutes, urgentTatMinutes: t.urgentTatMinutes, interpretation: t.interpretation ?? '', parameters: t.parameters,
      })),
    }
    downloadText('catalogue-master.json', JSON.stringify(f, null, 1))
  }

  const load = async (fl: File) => {
    try {
      const f = JSON.parse(await fl.text()) as MasterFile
      if (f.kind !== 'catalogue-master' || !Array.isArray(f.tests)) throw new Error('Not a catalogue master file')
      const byCode = new Map(tests.map((t) => [t.code.toUpperCase(), t]))
      const out: Change[] = []
      for (const m of f.tests) {
        const ex = byCode.get(String(m.code).toUpperCase())
        if (!ex) { out.push({ key: m.code, code: m.code, test: m, fields: ['New test'] }); continue }
        const fields: string[] = []
        if (ex.name !== m.name) fields.push('name')
        if ((maps.departmentById.get(ex.departmentId)?.name ?? '') !== m.department) fields.push('department')
        if ((maps.sampleTypeById.get(ex.sampleTypeId)?.name ?? '') !== m.sample) fields.push('sample')
        if (ex.gender !== m.gender) fields.push('gender')
        if ((ex.tatMinutes ?? null) !== (m.tatMinutes ?? null) || (ex.urgentTatMinutes ?? null) !== (m.urgentTatMinutes ?? null)) fields.push('TAT')
        if ((ex.interpretation ?? '') !== (m.interpretation ?? '')) fields.push('interpretation')
        if (paramSig(ex.parameters) !== paramSig(m.parameters)) fields.push('parameters and ranges')
        if (fields.length) out.push({ key: m.code, code: m.code, test: m, existing: ex, fields })
      }
      setChanges(out)
      setPicked(out.map((c) => c.key))
      if (!out.length) message.info('This catalogue already matches the file')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const apply = async () => {
    setBusy(true)
    try {
      const dept = new Map(maps.departments.map((d) => [d.name.toLowerCase(), d.id]))
      const smp = new Map(maps.sampleTypes.map((s) => [s.name.toLowerCase(), s.id]))
      let n = 0
      for (const c of changes.filter((x) => picked.includes(x.key))) {
        const m = c.test
        const common = { name: m.name, gender: m.gender, tatMinutes: m.tatMinutes, urgentTatMinutes: m.urgentTatMinutes, interpretation: m.interpretation, parameters: m.parameters }
        const departmentId = dept.get(m.department.toLowerCase()) ?? c.existing?.departmentId ?? maps.departments[0]?.id ?? ''
        const sampleTypeId = smp.get(m.sample.toLowerCase()) ?? c.existing?.sampleTypeId ?? maps.sampleTypes[0]?.id ?? ''
        if (c.existing) await updateDoc(docRef(paths.tests, c.existing.id), { ...common, departmentId, sampleTypeId }) // price untouched
        else await addDoc(col(paths.tests), { ...common, code: m.code, departmentId, sampleTypeId, price: 0, disabled: true, order: Math.max(0, ...tests.map((t) => t.order ?? 0)) + 1 + n, createdAt: serverTimestamp() })
        n++
      }
      message.success(`Applied ${n} change(s). Prices were not touched.`)
      setChanges([])
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Master catalogue sync" open={open} onCancel={onClose} width={dialogWidth(760)} destroyOnHidden okText={`Apply ${picked.length} change(s)`} onOk={apply} okButtonProps={{ disabled: !picked.length || busy }}>
      <p>Export this lab's tests as a master file, or import a master file from another lab to compare. Only the ticked changes are applied; prices are never changed. New tests arrive disabled with price 0.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button onClick={exportMaster}>Export master file</Button>
        <Button onClick={() => file.current?.click()}>Import master file</Button>
        <input ref={file} type="file" accept="application/json,.json" hidden aria-label="Upload master catalogue file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void load(f) }} />
      </div>
      {changes.length > 0 && (
        <Table<Change> size="small" rowKey="key" pagination={{ pageSize: 8, hideOnSinglePage: true }} dataSource={changes}
          rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as string[]) }}
          columns={[{ title: 'Code', dataIndex: 'code' }, { title: 'Name', render: (_, c) => c.test.name }, { title: 'Differences', render: (_, c) => c.fields.join(', ') }]} />
      )}
    </Modal>
  )
}
