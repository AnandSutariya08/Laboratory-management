import { useEffect, useMemo, useState } from 'react'
import { Alert, App, DatePicker, Input, InputNumber, Modal, Select, Switch, Table } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { addDoc, collectionGroup, getDocs, query, serverTimestamp, Timestamp, where } from 'firebase/firestore'
import { can, useAuth } from '../../auth/AuthProvider'
import { useBranch } from '../../branch/BranchProvider'
import { dialogWidth } from '../../design/dialog'
import { db, LAB_ID } from '../../firebase'
import { useLiveQuery } from '../../hooks/useLive'
import { branchStamp } from '../../lib/activeBranch'
import { col } from '../../lib/db'
import { modeLabel, usePaymentModes } from '../../lib/masters'
import { formatINR, toPaise, toRupees } from '../../lib/money'
import { logActivity, shiftOf } from '../../lib/orders'
import type { LedgerEntry, ShiftClose } from '../../types'
import './billing.css'

const SHIFTS = ['Morning', 'Evening', 'Night']

// Day-end shift close. Expected money per payment mode comes from the ledger rows posted in the shift
// (payments and due clearances in, refunds and reversals out). The cashier enters what was counted per mode;
// the difference is recorded with a note. Closes are append-only. Managers can count every cashier's rows,
// everyone else only their own.
export default function ShiftCloseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const { current } = useBranch()
  const branchId = current?.id ?? 'main'
  const modes = usePaymentModes()
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [shift, setShift] = useState(shiftOf())
  const [onlyMine, setOnlyMine] = useState(true)
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [counted, setCounted] = useState<Record<string, number>>({})
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const manager = can(profile, 'billing.reverse') || profile?.role === 'manager' || profile?.role === 'admin' || profile?.role === 'labAdmin'
  const dateKey = date.format('YYYY-MM-DD')

  const closesRaw = useLiveQuery<ShiftClose>(open ? query(col<ShiftClose>('shiftCloses'), where('branchId', '==', branchId), where('date', '==', dateKey)) : null, [open, dateKey]).data
  const closes = useMemo(() => [...closesRaw].sort((a, b) => (b.closedAt?.toMillis?.() ?? 0) - (a.closedAt?.toMillis?.() ?? 0)), [closesRaw])
  const mine = closes.filter((c) => c.shift === shift && c.closedBy === profile?.uid && c.branchId === branchId)
  const alreadyClosed = mine.length > 0

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    getDocs(
      query(
        collectionGroup(db, 'ledger'),
        where('branchId', '==', branchId),
        where('postedAt', '>=', Timestamp.fromDate(date.startOf('day').toDate())),
        where('postedAt', '<=', Timestamp.fromDate(date.endOf('day').toDate())),
      ),
    )
      .then((snap) => {
        if (alive) setEntries(snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as LedgerEntry))
      })
      .catch((e) => {
        if (alive) {
          setEntries([])
          message.error(`Could not load payments: ${(e as Error).message}`)
        }
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dateKey, branchId])

  const scoped = useMemo(
    () =>
      entries.filter((e) => {
        const sh = e.shift ?? shiftOf(e.postedAt?.toDate?.() ?? new Date())
        if (sh !== shift) return false
        if (onlyMine || !manager) return e.postedBy === profile?.uid
        return true
      }),
    [entries, shift, onlyMine, manager, profile?.uid],
  )
  const expected = useMemo(() => {
    const m: Record<string, number> = {}
    for (const e of scoped) m[e.mode] = (m[e.mode] ?? 0) + e.amount
    return m
  }, [scoped])
  const modeKeys = useMemo(() => {
    const set = new Set<string>([...modes.map((x) => x.value), ...Object.keys(expected)])
    set.delete('wallet') // B2B wallet debits are not money at the counter
    return [...set]
  }, [modes, expected])

  // Pre-fill the counted amounts with the expected ones so only the differences are typed.
  useEffect(() => {
    const next: Record<string, number> = {}
    for (const k of modeKeys) next[k] = toRupees(expected[k] ?? 0)
    setCounted(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift, dateKey, onlyMine, entries.length, scoped.length])

  const totalExpected = modeKeys.reduce((n, k) => n + (expected[k] ?? 0), 0)
  const totalCounted = modeKeys.reduce((n, k) => n + toPaise(counted[k] ?? 0), 0)
  const diff = totalCounted - totalExpected

  const close = async () => {
    if (!profile) return
    if (diff !== 0 && !note.trim()) return message.warning('Add a note explaining the difference.')
    setSaving(true)
    try {
      const countedP: Record<string, number> = {}
      const expectedP: Record<string, number> = {}
      for (const k of modeKeys) {
        countedP[k] = toPaise(counted[k] ?? 0)
        expectedP[k] = expected[k] ?? 0
      }
      await addDoc(col('shiftCloses'), {
        ...branchStamp(),
        labId: LAB_ID,
        date: dateKey,
        shift,
        expected: expectedP,
        counted: countedP,
        difference: diff,
        entries: scoped.length,
        onlyMine: onlyMine || !manager,
        closedBy: profile.uid,
        closedByName: profile.name,
        closedAt: serverTimestamp(),
        note: note.trim(),
      })
      void logActivity('shiftClose', `${shift} shift closed for ${dateKey} by ${profile.name}: expected ${formatINR(totalExpected)}, counted ${formatINR(totalCounted)}${diff ? `, difference ${formatINR(diff)}` : ''}`, 'shiftCloses', { category: 'BILLING', actor: profile })
      message.success('Shift closed')
      setNote('')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={dialogWidth(640)}
      title="Close shift (day-end)"
      destroyOnHidden
      okText="Close shift"
      onOk={close}
      okButtonProps={{ loading: saving, disabled: alreadyClosed || loading || scoped.length === 0 }}
    >
      <div className="bill-row">
        <DatePicker aria-label="Shift date" value={date} allowClear={false} onChange={(d) => d && setDate(d)} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
        <Select aria-label="Shift" value={shift} onChange={setShift} style={{ width: 130 }} options={SHIFTS.map((s) => ({ value: s, label: s }))} />
        {manager && (
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Switch size="small" checked={onlyMine} onChange={setOnlyMine} aria-label="Only my collections" />
            <span>Only my collections</span>
          </label>
        )}
      </div>
      {alreadyClosed && <Alert style={{ marginTop: 8 }} type="info" showIcon message={`You already closed the ${shift} shift for ${dateKey}.`} />}
      {!loading && scoped.length === 0 && !alreadyClosed && <Alert style={{ marginTop: 8 }} type="info" showIcon message="No payments were posted in this shift." />}
      <Table
        style={{ marginTop: 8 }}
        size="small"
        rowKey="mode"
        loading={loading}
        pagination={false}
        dataSource={modeKeys.map((mode) => ({ mode }))}
        columns={[
          { title: 'Mode', render: (_, r) => modeLabel(r.mode) },
          { title: 'Expected', align: 'right', render: (_, r) => formatINR(expected[r.mode] ?? 0) },
          {
            title: 'Counted',
            align: 'right',
            render: (_, r) => (
              <InputNumber
                aria-label={`Counted ${modeLabel(r.mode)}`}
                addonBefore="₹"
                min={0}
                precision={2}
                value={counted[r.mode] ?? 0}
                disabled={alreadyClosed}
                onChange={(v) => setCounted({ ...counted, [r.mode]: v ?? 0 })}
                style={{ width: 150 }}
              />
            ),
          },
          { title: 'Difference', align: 'right', render: (_, r) => { const d = toPaise(counted[r.mode] ?? 0) - (expected[r.mode] ?? 0); return <span className={d !== 0 ? 'bill-due' : undefined}>{formatINR(d)}</span> } },
        ]}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}><b>Total</b></Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="right"><b>{formatINR(totalExpected)}</b></Table.Summary.Cell>
            <Table.Summary.Cell index={2} align="right"><b>{formatINR(totalCounted)}</b></Table.Summary.Cell>
            <Table.Summary.Cell index={3} align="right"><b className={diff !== 0 ? 'bill-due' : 'bill-ok'}>{formatINR(diff)}</b></Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
      <Input.TextArea style={{ marginTop: 8 }} rows={2} placeholder={diff !== 0 ? 'Note (required: explain the difference)' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} disabled={alreadyClosed} />
      {closes.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>Closed on {dateKey}</b>
          {closes.map((c) => (
            <div key={c.id} className="bill-muted">
              {c.shift} · {c.closedByName} · counted {formatINR(Object.values(c.counted).reduce((n, v) => n + v, 0))}
              {c.difference !== 0 && <> · difference <span className="bill-due">{formatINR(c.difference)}</span></>}
              {c.note ? ` · ${c.note}` : ''}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
