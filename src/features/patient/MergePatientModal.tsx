import { useState } from 'react'
import { Alert, App, Button as AButton, Input, List, Modal } from 'antd'
import { arrayRemove, arrayUnion, deleteField, doc, endAt, getDocs, limit, orderBy, query, serverTimestamp, startAt, updateDoc, where, writeBatch } from 'firebase/firestore'
import { db, LAB_ID } from '../../firebase'
import { can, useAuth } from '../../auth/AuthProvider'
import { col, docRef, paths } from '../../lib/db'
import { fetchPatientOrders, logActivity } from './lib'
import type { PatientDoc } from './types'

// Manager or admin (patients.merge): moves this (source) patient's bills to the chosen target and marks the source merged.
export default function MergePatientModal({ source, open, onClose }: { source: PatientDoc; open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<PatientDoc[]>([])
  const [target, setTarget] = useState<PatientDoc | null>(null)
  const [busy, setBusy] = useState(false)
  const isAdmin = can(profile, 'patients.merge')

  const search = async () => {
    const t = q.trim()
    if (!t) return
    const cap = t.charAt(0).toUpperCase() + t.slice(1)
    const snaps = await Promise.all([
      getDocs(query(col(paths.patients), where('patientNo', '==', t), limit(10))),
      getDocs(query(col(paths.patients), where('phone', '==', t), limit(10))),
      getDocs(query(col(paths.patients), orderBy('firstName'), startAt(cap), endAt(cap + ''), limit(15))),
    ])
    const m = new Map<string, PatientDoc>()
    snaps.forEach((s) => s.docs.forEach((d) => m.set(d.id, { ...(d.data() as object), id: d.id } as PatientDoc)))
    m.delete(source.id)
    setFound([...m.values()].filter((p) => !p.merged))
  }

  const merge = async () => {
    if (!profile || !target) return
    setBusy(true)
    try {
      const orders = await fetchPatientOrders(source.id, profile)
      const name = `${target.salutation} ${target.firstName} ${target.lastName}`.replace(/\s+/g, ' ').trim()
      for (let i = 0; i < orders.length; i += 400) {
        const b = writeBatch(db)
        for (const o of orders.slice(i, i + 400))
          b.update(doc(db, 'labs', LAB_ID, 'orders', o.id), {
            patientId: target.id,
            patientNo: target.patientNo,
            patientName: name,
            mergedFromPatientId: source.id,
          })
        await b.commit()
      }
      // Quotations and bookings follow the patient too.
      const [qs, bs] = await Promise.all([
        getDocs(query(col('quotations'), where('patientId', '==', source.id))).catch(() => null),
        getDocs(query(col(paths.bookings), where('patientId', '==', source.id))).catch(() => null),
      ])
      const qDocs = qs?.docs ?? []
      const bDocs = bs?.docs ?? []
      for (let i = 0; i < qDocs.length; i += 400) {
        const b = writeBatch(db)
        qDocs.slice(i, i + 400).forEach((d) => b.update(d.ref, { patientId: target.id, patientNo: target.patientNo }))
        await b.commit()
      }
      for (let i = 0; i < bDocs.length; i += 400) {
        const b = writeBatch(db)
        bDocs.slice(i, i + 400).forEach((d) => b.update(d.ref, { patientId: target.id }))
        await b.commit()
      }
      await updateDoc(docRef(paths.patients, target.id), { mergedFrom: arrayUnion(source.id) })
      await updateDoc(docRef(paths.patients, source.id), {
        merged: true,
        mergedInto: target.id,
        mergedAt: serverTimestamp(),
        mergedBy: profile.uid,
        mergeMoved: { orders: orders.map((o) => o.id), quotations: qDocs.map((d) => d.id), bookings: bDocs.map((d) => d.id) },
      })
      await logActivity('patient.merge', `Merged patient ${source.patientNo} into ${target.patientNo} (${orders.length} bills, ${qDocs.length} quotations, ${bDocs.length} bookings moved)`, `patients/${target.id}`, { category: 'OTHER', actor: profile })
      message.success(`Merged. ${orders.length} bills, ${qDocs.length} quotations and ${bDocs.length} bookings moved.`)
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title="Merge duplicate patient" okText="Merge" onOk={merge} confirmLoading={busy} okButtonProps={{ disabled: !target || !isAdmin, danger: true }} destroyOnHidden>
      {!isAdmin && <Alert type="warning" showIcon message="Only a manager or admin can merge patients." style={{ marginBottom: 12 }} />}
      <p>
        Bills, quotations and bookings of <b>{source.firstName} {source.lastName}</b> ({source.patientNo}) move to the patient you pick. This patient is then marked merged. Bills in branches you cannot access stay unchanged.
      </p>
      <Input.Search placeholder="Target: patient no, phone or first name" value={q} onChange={(e) => setQ(e.target.value)} onSearch={search} enterButton="Search" />
      <List
        size="small"
        style={{ marginTop: 12 }}
        dataSource={found}
        locale={{ emptyText: 'No matches' }}
        renderItem={(p) => (
          <List.Item actions={[<AButton key="p" size="small" type={target?.id === p.id ? 'primary' : 'default'} onClick={() => setTarget(p)}>{target?.id === p.id ? 'Selected' : 'Pick'}</AButton>]}>
            {p.firstName} {p.lastName} · {p.patientNo} · {p.phone}
          </List.Item>
        )}
      />
    </Modal>
  )
}

// Admin: undo a merge within 30 days. Everything the merge re-pointed goes back to the source patient.
export const RESTORE_WINDOW_DAYS = 30
export async function restoreMerge(source: PatientDoc, profile: import('../../types').UserProfile) {
  if (profile.role !== 'labAdmin' && profile.role !== 'admin') throw new Error('Only an admin can restore a merged patient.')
  if (!source.merged || !source.mergedInto) throw new Error('This patient is not merged.')
  const at = source.mergedAt?.toDate?.()
  if (at && Date.now() - at.getTime() > RESTORE_WINDOW_DAYS * 86400000) throw new Error(`A merge can be restored only within ${RESTORE_WINDOW_DAYS} days.`)
  const moved = source.mergeMoved ?? { orders: [], quotations: [], bookings: [] }
  const name = `${source.salutation} ${source.firstName} ${source.lastName}`.replace(/\s+/g, ' ').trim()
  const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / 400) }, (_, i) => xs.slice(i * 400, i * 400 + 400))
  for (const part of chunks(moved.orders)) {
    const b = writeBatch(db)
    part.forEach((id) => b.update(doc(db, 'labs', LAB_ID, 'orders', id), { patientId: source.id, patientNo: source.patientNo, patientName: name, mergedFromPatientId: deleteField() }))
    await b.commit()
  }
  for (const part of chunks(moved.quotations)) {
    const b = writeBatch(db)
    part.forEach((id) => b.update(doc(db, 'labs', LAB_ID, 'quotations', id), { patientId: source.id, patientNo: source.patientNo }))
    await b.commit()
  }
  for (const part of chunks(moved.bookings)) {
    const b = writeBatch(db)
    part.forEach((id) => b.update(doc(db, 'labs', LAB_ID, 'bookings', id), { patientId: source.id }))
    await b.commit()
  }
  await updateDoc(docRef(paths.patients, source.mergedInto), { mergedFrom: arrayRemove(source.id) })
  await updateDoc(docRef(paths.patients, source.id), { merged: deleteField(), mergedInto: deleteField(), mergedAt: deleteField(), mergedBy: deleteField(), mergeMoved: deleteField() })
  await logActivity('patient.merge', `Restored patient ${source.patientNo} (merge undone)`, `patients/${source.id}`, { category: 'OTHER', actor: profile })
}
