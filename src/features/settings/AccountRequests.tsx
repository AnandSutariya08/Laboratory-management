import { useState } from 'react'
import { App, Input, Modal, Table } from 'antd'
import { addDoc, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { useLiveQuery } from '../../hooks/useLive'
import { col, docRef, paths } from '../../lib/db'
import { logActivity } from '../../layout/activity'
import type { UserProfile } from '../../types'

// Delete Account: an admin-approved request flow. The user files a request (no immediate deletion); a lab admin approves
// it in Users > Account deletion requests, which soft-deletes the user (history kept, sign-in blocked). The last active
// lab admin can never be removed this way. Wire: <DeleteAccountModal open onClose /> from the user menu "Delete Account".

interface Req { id: string; uid: string; name: string; email: string; reason: string; status: 'pending' | 'approved' | 'rejected'; requestedAt?: { toMillis: () => number }; decidedByName?: string }

export function DeleteAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const mine = useLiveQuery<Req>(profile ? query(col('accountRequests'), where('uid', '==', profile.uid)) : null, [profile?.uid]).data.filter((r) => r.status === 'pending')
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (!profile) return
    setBusy(true)
    try {
      await addDoc(col('accountRequests'), { uid: profile.uid, name: profile.name, email: profile.email, role: profile.role, reason: reason.trim(), status: 'pending', requestedAt: serverTimestamp() })
      void logActivity('user', `Account deletion requested by ${profile.name}`, `users/${profile.uid}`, { category: 'ADMIN_ACCESS', reason: reason.trim() })
      message.success('Request sent to your lab admin')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Delete account" open={open} onCancel={onClose} okText="Send request" okButtonProps={{ danger: true, disabled: confirm !== 'DELETE' || mine.length > 0, loading: busy }} onOk={() => void send()} destroyOnHidden>
      {mine.length > 0 ? (
        <p>You already have a deletion request waiting for approval.</p>
      ) : (
        <>
          <p>Your lab admin must approve this. Once approved you can no longer sign in. Bills and reports you handled are kept.</p>
          <Input.TextArea aria-label="Reason" rows={3} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ marginBottom: 8 }} />
          <Input aria-label="Type DELETE to confirm" placeholder="Type DELETE to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </>
      )}
    </Modal>
  )
}

export function AccountRequestsPanel({ users }: { users: UserProfile[] }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const rows = useLiveQuery<Req>(col('accountRequests'), []).data.sort((a, b) => (b.requestedAt?.toMillis() ?? 0) - (a.requestedAt?.toMillis() ?? 0))
  const decide = async (r: Req, approve: boolean) => {
    try {
      if (approve) {
        const u = users.find((x) => x.uid === r.uid)
        const lastAdmin = u?.role === 'labAdmin' && !users.some((x) => x.uid !== r.uid && x.role === 'labAdmin' && x.active && !x.deleted)
        if (lastAdmin) return void message.error('This is the last active Lab admin and cannot be deleted.')
        await setDoc(docRef(paths.users, r.uid), { active: false, deleted: true, deletedAt: serverTimestamp() }, { merge: true })
      }
      await updateDoc(docRef('accountRequests', r.id), { status: approve ? 'approved' : 'rejected', decidedBy: profile?.uid ?? '', decidedByName: profile?.name ?? '', decidedAt: serverTimestamp() })
      void logActivity('user', `Account deletion ${approve ? 'approved' : 'rejected'}: ${r.name}`, `users/${r.uid}`, { category: 'DELETE' })
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Table<Req> size="small" rowKey="id" dataSource={rows} pagination={{ pageSize: 6, hideOnSinglePage: true }} locale={{ emptyText: 'No deletion requests' }}
      columns={[
        { title: 'User', render: (_, r) => `${r.name} (${r.email})` },
        { title: 'Reason', dataIndex: 'reason' },
        { title: 'Status', dataIndex: 'status', render: (s: Req['status']) => <StatusChip variant={s === 'pending' ? 'caution' : s === 'approved' ? 'urgent' : 'neutral'}>{s}</StatusChip> },
        { title: '', render: (_, r) => r.status === 'pending' && (<span><Button variant="text" onClick={() => void decide(r, true)}>Approve</Button><Button variant="text" onClick={() => void decide(r, false)}>Reject</Button></span>) },
      ]} />
  )
}
