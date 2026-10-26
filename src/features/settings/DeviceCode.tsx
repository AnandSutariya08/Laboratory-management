import { useEffect, useState } from 'react'
import { App, Input, Modal, Table } from 'antd'
import { serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { col, docRef } from '../../lib/db'
import { logActivity } from '../../layout/activity'

// Browser Code (device approval code). Every browser gets a stable code, shown on the profile. The user asks for the
// browser to be approved; a lab admin approves or revokes it (Users page > Browser approvals). The code is also what
// support asks for to identify a device. Wire: <BrowserCodeModal open onClose /> from the user menu "Browser Code" item.
// Doc: browserCodes/{uid}_{code}.

const KEY = 'hcl.browserCode'
export function getBrowserCode(): string {
  try {
    let c = localStorage.getItem(KEY)
    if (!c) {
      const r = crypto.getRandomValues(new Uint8Array(5))
      c = [...r].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('') + Date.now().toString(36).slice(-3).toUpperCase()
      localStorage.setItem(KEY, c)
    }
    return c
  } catch {
    return 'NO-STORAGE'
  }
}

interface CodeDoc { id: string; uid: string; userName: string; code: string; label: string; status: 'pending' | 'approved' | 'revoked'; userAgent?: string; requestedAt?: { toMillis: () => number }; approvedByName?: string }

export function useBrowserApproval() {
  const { profile } = useAuth()
  const code = getBrowserCode()
  const doc = useLiveDoc<CodeDoc>(profile ? docRef('browserCodes', `${profile.uid}_${code}`) : null, [profile?.uid, code])
  return { code, status: doc.data?.status ?? 'none', doc: doc.data }
}

export function BrowserCodeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const { code, status, doc } = useBrowserApproval()
  const [label, setLabel] = useState('')
  useEffect(() => { if (doc?.label) setLabel(doc.label) }, [doc?.label])
  const request = async () => {
    if (!profile) return
    try {
      await setDoc(docRef('browserCodes', `${profile.uid}_${code}`), {
        uid: profile.uid, userName: profile.name, code, label: label.trim() || navigator.platform, status: 'pending',
        userAgent: navigator.userAgent.slice(0, 200), requestedAt: serverTimestamp(),
      })
      message.success('Approval requested. A lab admin will review it.')
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Modal title="Browser code" open={open} onCancel={onClose} footer={null} destroyOnHidden>
      <p>This code identifies this browser. Share it with your lab admin to get the browser approved.</p>
      <p style={{ fontSize: 28, letterSpacing: 4, fontWeight: 600, margin: '8px 0' }} aria-label="Browser code">{code}</p>
      <p>Status: <StatusChip variant={status === 'approved' ? 'success' : status === 'pending' ? 'caution' : status === 'revoked' ? 'urgent' : 'neutral'}>{status === 'none' ? 'Not requested' : status === 'pending' ? 'Waiting for approval' : status === 'approved' ? 'Approved' : 'Revoked'}</StatusChip></p>
      {status !== 'approved' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <Input aria-label="Device name" placeholder="Device name (e.g. Reception PC)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button variant="primary" onClick={() => void request()} disabled={status === 'pending'}>{status === 'pending' ? 'Request sent' : 'Request approval'}</Button>
        </div>
      )}
    </Modal>
  )
}

// Admin: approve / revoke browsers. Wire: rendered on the Users page.
export function BrowserApprovals() {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const rows = useLiveQuery<CodeDoc>(col('browserCodes'), []).data
  const set = async (r: CodeDoc, status: 'approved' | 'revoked') => {
    try {
      await updateDoc(docRef('browserCodes', r.id), { status, approvedBy: profile?.uid ?? '', approvedByName: profile?.name ?? '', decidedAt: serverTimestamp() })
      void logActivity('admin', `Browser ${status}: ${r.userName} (${r.code})`, `browserCodes/${r.id}`, { category: 'ADMIN_ACCESS' })
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <Table<CodeDoc> size="small" rowKey="id" dataSource={rows} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: 'No browsers registered yet' }}
      columns={[
        { title: 'User', dataIndex: 'userName' },
        { title: 'Code', dataIndex: 'code', render: (c: string) => <b>{c}</b> },
        { title: 'Device', dataIndex: 'label' },
        { title: 'Status', dataIndex: 'status', render: (s: CodeDoc['status']) => <StatusChip variant={s === 'approved' ? 'success' : s === 'pending' ? 'caution' : 'urgent'}>{s}</StatusChip> },
        { title: '', render: (_, r) => (<span>{r.status !== 'approved' && <Button variant="text" onClick={() => void set(r, 'approved')}>Approve</Button>}{r.status !== 'revoked' && <Button variant="text" onClick={() => void set(r, 'revoked')}>Revoke</Button>}</span>) },
      ]} />
  )
}
