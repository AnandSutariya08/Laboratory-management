import { useEffect, useMemo, useState } from 'react'
import { App, Modal, Radio, Select } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, HolderOutlined } from '@ant-design/icons'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { docRef, paths } from '../../lib/db'
import { Button } from '../../design/Button'
import { commitBatch, mergeOp } from './shared'

// ---- Test sequence: report order of departments and of tests inside one ------------
export function SequenceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { tests, departments } = useCatalogueMaps()
  const [mode, setMode] = useState<'departments' | 'tests'>('tests')
  const [dept, setDept] = useState<string | undefined>()
  const [ids, setIds] = useState<string[]>([])
  const [over, setOver] = useState<number | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const source = useMemo(() => {
    if (mode === 'departments') return [...departments].sort((a, b) => a.order - b.order).map((d) => ({ id: d.id, label: d.name }))
    return tests.filter((t) => t.departmentId === dept).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name)).map((t) => ({ id: t.id, label: `${t.name} (${t.code})` }))
  }, [mode, dept, tests, departments])
  useEffect(() => { if (open) setIds(source.map((s) => s.id)) }, [open, source])
  useEffect(() => { if (open && !dept && departments[0]) setDept(departments[0].id) }, [open, dept, departments])

  const label = new Map(source.map((s) => [s.id, s.label]))
  const move = (i: number, j: number) => {
    if (j < 0 || j >= ids.length || i === j) return
    setIds((cur) => { const n = [...cur]; const [x] = n.splice(i, 1); n.splice(j, 0, x); return n })
  }
  const save = async () => {
    setBusy(true)
    try {
      const col = mode === 'departments' ? paths.departments : paths.tests
      await commitBatch(ids.map((id, i) => mergeOp(docRef(col, id), { order: i + 1 })))
      message.success('Sequence saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Test sequence" open={open} onCancel={onClose} onOk={save} okText="Save sequence" confirmLoading={busy} destroyOnHidden>
      <p className="cat-muted">Drag rows, or use the arrow buttons, to set the order used on printed reports.</p>
      <div className="cat-toolbar">
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} optionType="button" options={[{ value: 'tests', label: 'Tests in a department' }, { value: 'departments', label: 'Departments' }]} />
        {mode === 'tests' && <Select aria-label="Department" style={{ width: 200 }} value={dept} onChange={setDept} options={departments.map((d) => ({ value: d.id, label: d.name }))} />}
      </div>
      <ul className="cat-seq" aria-label="Sequence">
        {ids.map((id, i) => (
          <li
            key={id}
            className={`cat-seq__item ${over === i ? 'cat-seq__item--over' : ''}`}
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => { e.preventDefault(); setOver(i) }}
            onDragEnd={() => { setOver(null); setDragFrom(null) }}
            onDrop={() => { if (dragFrom !== null) move(dragFrom, i); setOver(null); setDragFrom(null) }}
          >
            <HolderOutlined aria-hidden="true" />
            <span className="cat-seq__no">{i + 1}</span>
            <span className="cat-seq__name">{label.get(id)}</span>
            <Button variant="text" aria-label={`Move ${label.get(id)} up`} disabled={i === 0} icon={<ArrowUpOutlined />} onClick={() => move(i, i - 1)} />
            <Button variant="text" aria-label={`Move ${label.get(id)} down`} disabled={i === ids.length - 1} icon={<ArrowDownOutlined />} onClick={() => move(i, i + 1)} />
          </li>
        ))}
      </ul>
    </Modal>
  )
}

export { MassPriceModal } from './MassPrice'
