import { useState } from 'react'
import { App, Input, InputNumber, Modal, Select, Switch, Table } from 'antd'
import { setDoc } from 'firebase/firestore'
import { Button } from '../../design/Button'
import { useLiveQuery } from '../../hooks/useLive'
import { col, docRef, paths } from '../../lib/db'
import type { Collector } from '../../lib/bookings'
import type { UserProfile } from '../../types'
import { dialogWidth } from '../../design/dialog'

// Collector master: zone, pincodes served, working hours and daily capacity per phlebotomist.
// Feeds the collector suggestion on a booking.
export default function CollectorsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const users = useLiveQuery<UserProfile>(col(paths.users), []).data.filter((u) => u.role === 'phlebotomist' && u.active)
  const saved = useLiveQuery<Collector>(col('collectors'), []).data
  const [busy, setBusy] = useState<string | null>(null)
  const get = (u: UserProfile): Collector => saved.find((c) => c.id === u.uid) ?? { id: u.uid, name: u.name, pincodes: [], zone: '', startHour: 7, endHour: 20, capacity: 12, active: true }
  const save = async (c: Collector) => {
    setBusy(c.id)
    try {
      await setDoc(docRef('collectors', c.id), c)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal open={open} onCancel={onClose} footer={<Button onClick={onClose}>Close</Button>} width={dialogWidth(860)} title="Collectors" destroyOnHidden>
      <Table<UserProfile>
        size="small"
        rowKey="uid"
        pagination={false}
        dataSource={users}
        locale={{ emptyText: 'No phlebotomist users yet' }}
        columns={[
          { title: 'Collector', dataIndex: 'name' },
          { title: 'Zone', render: (_, u) => <Input aria-label={`Zone of ${u.name}`} defaultValue={get(u).zone} onBlur={(e) => void save({ ...get(u), zone: e.target.value.trim() })} /> },
          {
            title: 'Pincodes',
            render: (_, u) => (
              <Select mode="tags" aria-label={`Pincodes of ${u.name}`} style={{ minWidth: 180 }} tokenSeparators={[',', ' ']} value={get(u).pincodes} onChange={(v) => void save({ ...get(u), pincodes: v.filter((x: string) => /^\d{6}$/.test(x)) })} />
            ),
          },
          { title: 'From', width: 80, render: (_, u) => <InputNumber aria-label={`Start hour of ${u.name}`} min={0} max={23} value={get(u).startHour} onChange={(v) => void save({ ...get(u), startHour: v ?? 7 })} /> },
          { title: 'To', width: 80, render: (_, u) => <InputNumber aria-label={`End hour of ${u.name}`} min={1} max={24} value={get(u).endHour} onChange={(v) => void save({ ...get(u), endHour: v ?? 20 })} /> },
          { title: 'Per day', width: 90, render: (_, u) => <InputNumber aria-label={`Daily capacity of ${u.name}`} min={0} max={100} value={get(u).capacity} onChange={(v) => void save({ ...get(u), capacity: v ?? 0 })} /> },
          { title: 'Active', width: 80, render: (_, u) => <Switch aria-label={`${u.name} active`} loading={busy === u.uid} checked={get(u).active !== false} onChange={(a) => void save({ ...get(u), active: a })} /> },
        ]}
      />
    </Modal>
  )
}
