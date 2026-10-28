import { useState } from 'react'
import { FieldGrid } from '../../design/FormLayout'
import '../billing/billing.css'
import { App, DatePicker, Dropdown, Input, Modal, Select } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { query, Timestamp } from 'firebase/firestore'
import { useBranchScope } from '../../lib/branchScope'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { useLiveQuery } from '../../hooks/useLive'
import { col, paths } from '../../lib/db'
import { bulkAssignSuggested, type Collector, bulkUpdateBookings, SLOTS, STATUS_LABEL, type BookingX } from '../../lib/bookings'
import type { BookingStatus, UserProfile } from '../../types'

type Mode = 'cancelled' | 'owner' | 'reschedule' | null

// Bulk actions on the selected bookings: change status, assign owner, reschedule.
// Each booking is checked against the state machine; the ones that cannot move are reported.
export default function BulkActions({ rows, onDone }: { rows: BookingX[]; onDone: () => void }) {
  const { message, modal } = App.useApp()
  const { profile } = useAuth()
  const { data: users } = useLiveQuery<UserProfile>(col(paths.users), [])
  const scope = useBranchScope()
  const { data: collectors } = useLiveQuery<Collector>(col('collectors'), [])
  const { data: all } = useLiveQuery<BookingX>(query(col<BookingX>(paths.bookings), ...scope.constraints), [scope.key])
  const [mode, setMode] = useState<Mode>(null)
  const [reason, setReason] = useState('')
  const [owner, setOwner] = useState<string | undefined>()
  const [date, setDate] = useState<Dayjs | null>(null)
  const [slot, setSlot] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const report = (res: { done: number; skipped: { booking: BookingX; why: string }[] }) => {
    if (res.skipped.length === 0) message.success(`${res.done} booking(s) updated`)
    else
      modal.warning({
        title: `${res.done} updated, ${res.skipped.length} skipped`,
        content: (
          <div>
            {res.skipped.slice(0, 8).map((s) => (
              <div key={s.booking.id}>{s.booking.bookingNo}: {s.why}</div>
            ))}
          </div>
        ),
      })
    onDone()
  }

  const run = async (action: Parameters<typeof bulkUpdateBookings>[1]) => {
    if (!profile) return
    setBusy(true)
    try {
      report(await bulkUpdateBookings(rows, action, profile))
      setMode(null)
      setReason('')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const statusItems = (['scheduled', 'confirmed', 'assigned', 'inProgress', 'cancelled'] as BookingStatus[]).map((s) => ({ key: s, label: STATUS_LABEL[s] }))

  return (
    <>
      <Dropdown
        trigger={['click']}
        disabled={rows.length === 0}
        menu={{
          items: [
            { key: 'status', label: 'Change status', children: statusItems },
            { key: 'owner', label: 'Assign owner' },
            { key: 'reschedule', label: 'Reschedule' },
            { key: 'suggest', label: 'Assign suggested collectors' },
          ],
          onClick: ({ key, keyPath }) => {
            if (key === 'owner') setMode('owner')
            else if (key === 'reschedule') setMode('reschedule')
            else if (key === 'suggest') {
              const phlebos = users.filter((u) => u.role === 'phlebotomist' && u.active).map((u) => ({ uid: u.uid, name: u.name }))
              modal.confirm({
                title: `Assign the best-fit collector to ${rows.length} booking(s)?`,
                content: 'Ranked by pincode served, shift hours and the lightest load that day. Bookings that cannot be assigned are reported.',
                okText: 'Assign',
                onOk: async () => { if (profile) report(await bulkAssignSuggested(rows, phlebos, collectors, all, profile)) },
              })
            }
            else if (keyPath.includes('status')) {
              if (key === 'cancelled') setMode('cancelled')
              else void run({ kind: 'status', to: key as BookingStatus })
            }
          },
        }}
      >
        <Button disabled={rows.length === 0}>Bulk actions{rows.length ? ` (${rows.length})` : ''}</Button>
      </Dropdown>
      <Modal
        open={mode !== null}
        onCancel={() => setMode(null)}
        destroyOnHidden
        title={mode === 'owner' ? 'Assign owner' : mode === 'reschedule' ? 'Reschedule selected' : 'Cancel selected'}
        okText="Apply"
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            (mode === 'owner' && !owner) ||
            (mode === 'reschedule' && (!date || !slot || !reason.trim())) ||
            (mode === 'cancelled' && !reason.trim()),
        }}
        onOk={() => {
          if (mode === 'owner' && owner) void run({ kind: 'owner', ownerName: owner })
          else if (mode === 'reschedule' && date && slot) void run({ kind: 'reschedule', scheduledAt: Timestamp.fromDate(date.startOf('day').toDate()), slot, reason })
          else if (mode === 'cancelled') void run({ kind: 'status', to: 'cancelled', reason })
        }}
      >
        <p>{rows.length} booking(s) selected.</p>
        {mode === 'owner' && (
          <Select
            showSearch
            style={{ width: '100%' }}
            placeholder="Owner (staff member)"
            value={owner}
            onChange={setOwner}
            options={users.filter((u) => u.active).map((u) => ({ value: u.name, label: u.name }))}
          />
        )}
        {mode === 'reschedule' && (
          <FieldGrid min={200}>
            <div>
              <label className="bill-field-label" htmlFor="bulk-date">Date</label>
              <DatePicker id="bulk-date" value={date} onChange={setDate} disabledDate={(d) => d.isBefore(dayjs(), 'day')} style={{ width: '100%' }} />
            </div>
            <div>
              <label className="bill-field-label" htmlFor="bulk-slot">Slot</label>
              <Select id="bulk-slot" style={{ width: '100%' }} placeholder="Slot" value={slot} onChange={setSlot} options={SLOTS.map((s) => ({ value: s, label: s }))} />
            </div>
          </FieldGrid>
        )}
        {(mode === 'reschedule' || mode === 'cancelled') && (
          <Input.TextArea aria-label="Reason" style={{ marginTop: 12 }} rows={2} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </Modal>
    </>
  )
}
