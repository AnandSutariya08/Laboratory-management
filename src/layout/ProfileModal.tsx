import { useEffect, useState } from 'react'
import { App, Modal } from 'antd'
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth'
import { updateDoc } from 'firebase/firestore'
import { useAuth } from '../auth/AuthProvider'
import { auth } from '../firebase'
import { docRef, paths } from '../lib/db'
import { Segmented } from '../design/Segmented'
import { canChangeOwnPassword } from '../features/settings/lib'
import { setActivityActor } from './activity'
import { dialogWidth } from '../design/dialog'
import { FieldGrid, FormSection } from '../design/FormLayout'

// "My profile": edit name, phone and (doctors) signature; change password with re-authentication.
// Editing your own profile needs the users rule that lets a user update name, phone, signature.
export default function ProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const [tab, setTab] = useState<'profile' | 'password'>('profile')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [signature, setSignature] = useState('')
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const mayChangePassword = canChangeOwnPassword(profile) // user setting: allowPasswordChange

  useEffect(() => {
    if (open) {
      setTab('profile')
      setName(profile?.name ?? '')
      setPhone(profile?.phone ?? '')
      setSignature(profile?.signature ?? '')
      setCur('')
      setNext('')
      setAgain('')
    }
  }, [open, profile])

  const saveProfile = async () => {
    if (!user || !name.trim()) return
    setBusy(true)
    try {
      const data: Record<string, string> = { name: name.trim(), phone: phone.trim() }
      if (profile?.role === 'doctor') data.signature = signature.trim()
      await updateDoc(docRef(paths.users, user.uid), data)
      setActivityActor(name.trim())
      message.success('Profile updated')
      onClose()
    } catch {
      message.error('Could not save. Ask a lab admin to update your profile.')
    } finally {
      setBusy(false)
    }
  }
  const changePassword = async () => {
    const u = auth.currentUser
    if (!u?.email || !mayChangePassword) return
    if (next.length < 6) return void message.warning('Use at least 6 characters')
    if (next !== again) return void message.warning('The new passwords do not match')
    setBusy(true)
    try {
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, cur))
      await updatePassword(u, next)
      message.success('Password changed')
      onClose()
    } catch {
      message.error('Current password is incorrect, or sign in again and retry.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="My profile"
      open={open}
      onCancel={onClose}
      destroyOnHidden
      width={dialogWidth(560)}
      okText={tab === 'profile' || !mayChangePassword ? 'Save profile' : 'Change password'}
      onOk={tab === 'profile' || !mayChangePassword ? saveProfile : changePassword}
      confirmLoading={busy}
    >
      {mayChangePassword && (
        <Segmented aria-label="Profile section" value={tab} onChange={setTab} options={[{ value: 'profile', label: 'Edit profile' }, { value: 'password', label: 'Change password' }]} />
      )}
      <div style={{ marginTop: 'var(--s-4)' }}>
        {tab === 'profile' || !mayChangePassword ? (
          <>
            <FormSection title="Your details" description="Shown to colleagues and on the activity log.">
              <FieldGrid min={200}>
                <div className="field-row">
                  <label htmlFor="pf-name">Name</label>
                  <input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="field-row">
                  <label htmlFor="pf-phone">Phone</label>
                  <input id="pf-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
                </div>
              </FieldGrid>
            </FormSection>
            <FormSection title="Sign-in" description="Set by your lab admin. Ask them if either needs to change.">
              <FieldGrid min={200}>
                <div className="field-row">
                  <label htmlFor="pf-email">Email (login)</label>
                  <input id="pf-email" value={profile?.email ?? ''} disabled />
                </div>
                {profile?.username && (
                  <div className="field-row">
                    <label htmlFor="pf-user">Username</label>
                    <input id="pf-user" value={profile.username} disabled />
                  </div>
                )}
              </FieldGrid>
            </FormSection>
            {profile?.role === 'doctor' && (
              <FormSection title="Report signature" description="Printed under reports you sign.">
                <div className="field-row">
                  <label htmlFor="pf-sig">Signature line (name, qualification, registration no.)</label>
                  <textarea id="pf-sig" rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} />
                </div>
              </FormSection>
            )}
          </>
        ) : (
          <FormSection title="Change password" description="Enter your current password, then choose a new one of at least 6 characters.">
            <div className="field-row">
              <label htmlFor="pw-cur">Current password</label>
              <input id="pw-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
            </div>
            <FieldGrid min={200}>
              <div className="field-row">
                <label htmlFor="pw-new">New password</label>
                <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
              </div>
              <div className="field-row">
                <label htmlFor="pw-again">Repeat new password</label>
                <input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
              </div>
            </FieldGrid>
          </FormSection>
        )}
      </div>
    </Modal>
  )
}
