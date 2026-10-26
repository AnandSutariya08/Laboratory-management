import { useMemo, useState } from 'react'
import { App, Modal, Radio, Select } from 'antd'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { col, docRef, paths } from '../../lib/db'
import type { Branch } from '../../branch/BranchProvider'
import { commitBatch, mergeOp } from './shared'
import type { PackageExt, TestExt } from './ext'

// Copy tests / packages to branches (CAT-04, PKG-10). The catalogue is one list for the whole lab, so a copy means
// making the item available in the chosen branches: `branchIds` on the test or package. Items with no `branchIds`
// are offered everywhere. "Only these branches" restricts them, "Add branches" widens an existing restriction.
// Billing filters with availableInBranch() (catalogue/behaviour.ts).

export function CopyToBranchesModal({ open, onClose, testIds = [], packageIds = [] }: { open: boolean; onClose: () => void; testIds?: string[]; packageIds?: string[] }) {
  const { message } = App.useApp()
  const maps = useCatalogueMaps()
  const branches = useLiveQuery<Branch>(col('branches'), []).data.filter((b) => b.active !== false)
  const [target, setTarget] = useState<string[]>([])
  const [mode, setMode] = useState<'add' | 'only' | 'all'>('add')
  const [busy, setBusy] = useState(false)
  const tests = useMemo(() => testIds.map((id) => maps.testById.get(id) as TestExt | undefined).filter(Boolean) as TestExt[], [testIds, maps.testById])
  const packs = useMemo(() => packageIds.map((id) => maps.packageById.get(id) as PackageExt | undefined).filter(Boolean) as PackageExt[], [packageIds, maps.packageById])

  const next = (cur: string[] | undefined): string[] | null => {
    if (mode === 'all') return []
    if (mode === 'only') return target
    if (!cur?.length) return null // already everywhere: nothing to add
    return [...new Set([...cur, ...target])]
  }
  const apply = async () => {
    setBusy(true)
    try {
      const ops: Parameters<typeof commitBatch>[0] = []
      for (const t of tests) { const n = next(t.branchIds); if (n) ops.push(mergeOp(docRef(paths.tests, t.id), { branchIds: n })) }
      for (const p of packs) { const n = next((p as { branchIds?: string[] }).branchIds); if (n) ops.push(mergeOp(docRef(paths.packages, p.id), { branchIds: n })) }
      await commitBatch(ops)
      message.success(ops.length ? `Updated ${ops.length} item(s)` : 'Nothing to change: the items are already offered in every branch')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Copy to branches" open={open} onCancel={onClose} onOk={() => void apply()} okText="Apply" confirmLoading={busy}
      okButtonProps={{ disabled: mode !== 'all' && target.length === 0 }} destroyOnHidden>
      <p className="cat-muted">{tests.length} test(s) and {packs.length} package(s). Items that name no branches are offered in every branch.</p>
      <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} style={{ display: 'grid', gap: 6, marginBottom: 12 }}
        options={[
          { value: 'add', label: 'Add these branches to a restricted item' },
          { value: 'only', label: 'Offer only in these branches' },
          { value: 'all', label: 'Offer in every branch (remove the restriction)' },
        ]} />
      {mode !== 'all' && (
        <Select mode="multiple" style={{ width: '100%' }} aria-label="Branches" placeholder="Choose branches" value={target} onChange={setTarget}
          options={branches.map((b) => ({ value: b.id, label: `${b.name} (${b.code})` }))} />
      )}
    </Modal>
  )
}
