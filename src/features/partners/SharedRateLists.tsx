import { useMemo, useState } from 'react'
import { Drawer, Input, Modal, Popconfirm, Select, message } from 'antd'
import { DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons'
import { writeBatch } from 'firebase/firestore'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { db } from '../../firebase'
import { docRef } from '../../lib/db'
import { removeMaster, saveMaster, useMaster, useRateLists } from './lib/master'
import RateListEditor from './RateListEditor'
import type { B2BCentre, CollectionCentre, CorporateClient, GovPanel, Referrer, Tpa } from './types'
import { DataTable, Spacer, Toolbar } from './ui'

type Kind = 'doctor' | 'hospital' | 'second' | 'tpa' | 'govPanel' | 'b2b' | 'collectionCentre' | 'corporate'
const KINDS: { value: Kind; label: string; collection: string }[] = [
  { value: 'doctor', label: 'Doctors', collection: 'referrers' },
  { value: 'hospital', label: 'Hospitals', collection: 'referrers' },
  { value: 'second', label: 'Second referrals', collection: 'referrers' },
  { value: 'tpa', label: 'TPAs', collection: 'tpas' },
  { value: 'govPanel', label: 'Government panels', collection: 'govPanels' },
  { value: 'b2b', label: 'B2B centres', collection: 'b2bCentres' },
  { value: 'collectionCentre', label: 'Collection centres', collection: 'collectionCentres' },
  { value: 'corporate', label: 'Corporate clients', collection: 'corporateClients' },
]

// All price lists in one place. A "shared" list is built once and applied to many partners in one go
// (bulk apply); each partner simply points at it with rateListId, so editing it re-prices all of them.
export default function SharedRateLists() {
  const lists = useRateLists()
  const referrers = useMaster<Referrer>('referrers')
  const tpas = useMaster<Tpa>('tpas')
  const gov = useMaster<GovPanel>('govPanels')
  const b2b = useMaster<B2BCentre>('b2bCentres')
  const cc = useMaster<CollectionCentre>('collectionCentres')
  const corp = useMaster<CorporateClient>('corporateClients')
  const [editId, setEditId] = useState<string | null>(null)
  const [applyId, setApplyId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [kind, setKind] = useState<Kind>('doctor')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const owners = useMemo(
    () => ({
      doctor: referrers.data.filter((r) => r.type === 'doctor' && !r.mergedInto),
      hospital: referrers.data.filter((r) => r.type === 'hospital' && !r.mergedInto),
      second: referrers.data.filter((r) => r.type === 'second' && !r.mergedInto),
      tpa: tpas.data,
      govPanel: gov.data,
      b2b: b2b.data,
      collectionCentre: cc.data,
      corporate: corp.data,
    }),
    [referrers.data, tpas.data, gov.data, b2b.data, cc.data, corp.data],
  ) as Record<Kind, { id: string; name: string; rateListId?: string }[]>

  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const k of Object.keys(owners) as Kind[]) for (const o of owners[k]) if (o.rateListId) m.set(o.rateListId, (m.get(o.rateListId) ?? 0) + 1)
    for (const l of lists.data) if (l.parentId) m.set(l.parentId, (m.get(l.parentId) ?? 0) + 1)
    return m
  }, [owners, lists.data])

  const create = async () => {
    if (!newName.trim()) return
    setBusy(true)
    try {
      const id = await saveMaster('rateLists', null, { name: newName.trim(), kind: 'shared', shared: true, entries: {}, active: true, missingPolicy: 'mrp' })
      setCreating(false)
      setNewName('')
      setEditId(id)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    const list = lists.data.find((l) => l.id === applyId)
    const collection = KINDS.find((k) => k.value === kind)!.collection
    if (!list || !picked.length) return
    setBusy(true)
    try {
      for (let i = 0; i < picked.length; i += 400) {
        const b = writeBatch(db)
        for (const id of picked.slice(i, i + 400)) b.update(docRef(collection, id), { rateListId: list.id })
        await b.commit()
      }
      message.success(`${list.name} applied to ${picked.length} ${KINDS.find((k) => k.value === kind)!.label.toLowerCase()}`)
      setPicked([])
      setApplyId(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if ((usage.get(id) ?? 0) > 0) return void message.warning('This list is still used by partners or as a parent list. Move them to another list first.')
    try {
      await removeMaster('rateLists', id)
      message.success('Deleted')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const nameOf = (id?: string) => lists.data.find((l) => l.id === id)?.name ?? ''

  return (
    <>
      <DataTable
        loading={lists.loading}
        dataSource={lists.data}
        emptyTitle="No price lists yet"
        emptyHint="Create a shared list, then apply it to many partners at once."
        toolbar={
          <Toolbar>
            <span className="pt-muted">Lists built for one partner appear here too. Shared lists can be applied to many partners.</span>
            <Spacer />
            <Button variant="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>New shared list</Button>
          </Toolbar>
        }
        columns={[
          { title: 'Name', render: (_, l) => <span>{l.name} {l.shared && <StatusChip variant="info">Shared</StatusChip>}</span> },
          { title: 'Items priced', align: 'right', render: (_, l) => Object.keys(l.entries ?? {}).length },
          { title: 'Parent list', render: (_, l) => nameOf(l.parentId) || <span className="pt-muted">None</span> },
          { title: 'Missing item', render: (_, l) => (l.missingPolicy === 'block' ? 'Cannot be billed' : 'Bill at MRP') },
          { title: 'Used by', align: 'right', render: (_, l) => usage.get(l.id) ?? 0 },
          {
            title: 'Actions',
            render: (_, l) => (
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <Button variant="text" icon={<EditOutlined />} aria-label={`Edit ${l.name}`} onClick={() => setEditId(l.id)} />
                <Button variant="text" icon={<LinkOutlined />} aria-label={`Apply ${l.name} to partners`} onClick={() => { setApplyId(l.id); setPicked([]) }} />
                <Popconfirm title={`Delete ${l.name}?`} okText="Delete" onConfirm={() => remove(l.id)}>
                  <Button variant="text" icon={<DeleteOutlined />} aria-label={`Delete ${l.name}`} />
                </Popconfirm>
              </span>
            ),
          },
        ]}
      />
      <Modal open={creating} title="New shared price list" onCancel={() => setCreating(false)} onOk={create} okText="Create" okButtonProps={{ disabled: !newName.trim(), loading: busy }} destroyOnHidden>
        <Input aria-label="List name" placeholder="List name" value={newName} onChange={(e) => setNewName(e.target.value)} onPressEnter={create} autoFocus />
      </Modal>
      <Modal
        open={!!applyId}
        title={`Apply ${nameOf(applyId ?? undefined)} to partners`}
        onCancel={() => setApplyId(null)}
        onOk={apply}
        okText={`Apply to ${picked.length}`}
        okButtonProps={{ disabled: !picked.length, loading: busy }}
        destroyOnHidden
      >
        <p className="pt-muted">Each partner you pick will use this list from the next bill. Their old list link is replaced.</p>
        <Select aria-label="Partner type" style={{ width: '100%', marginBottom: 8 }} value={kind} onChange={(v) => { setKind(v); setPicked([]) }} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        <Select
          mode="multiple"
          aria-label="Partners"
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
          placeholder="Pick partners"
          value={picked}
          onChange={setPicked}
          maxTagCount="responsive"
          options={owners[kind].map((o) => ({ value: o.id, label: `${o.name}${o.rateListId && o.rateListId !== applyId ? ` (now: ${nameOf(o.rateListId) || 'other list'})` : ''}` }))}
          dropdownRender={(menu) => (
            <>
              <div style={{ padding: 6 }}><Button variant="text" onClick={() => setPicked(owners[kind].map((o) => o.id))}>Select all {owners[kind].length}</Button></div>
              {menu}
            </>
          )}
        />
      </Modal>
      <Drawer open={!!editId} onClose={() => setEditId(null)} size="large" title="Price list" destroyOnHidden>
        {editId && <RateListEditor rateListId={editId} />}
      </Drawer>
    </>
  )
}
