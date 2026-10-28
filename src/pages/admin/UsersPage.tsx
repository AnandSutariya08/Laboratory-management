import { useEffect, useMemo, useState } from 'react'
import { useRef } from 'react'
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Typography } from 'antd'
import { DownloadOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons'
import { getApp, initializeApp, deleteApp } from 'firebase/app'
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, sendPasswordResetEmail, signOut } from 'firebase/auth'
import { onSnapshot, orderBy, query, serverTimestamp } from 'firebase/firestore'
import { useAuth } from '../../auth/AuthProvider'
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_GROUPS,
  PARTNER_COLLECTION,
  PARTNER_ROLES,
  ROLE_LABEL,
  ROLES,
  effectivePermissions,
  isPartnerRole,
} from '../../auth/permissions'
import { LAB_ID } from '../../firebase'
import { useLiveQuery } from '../../hooks/useLive'
import { col, paths } from '../../lib/db'
import { saveUserProfile } from '../../lib/orders'
import type { Branch } from '../../branch/BranchProvider'
import type { Role, RoleDoc, UserProfile } from '../../types'
import { downloadCsv } from '../../components/billing/helpers'
import { fmtDateTime } from '../../components/results/common'
import { Button as DsButton } from '../../design/Button'
import { dialogWidth } from '../../design/dialog'
import { FieldGrid, FormSection, SettingRow } from '../../design/FormLayout'
import { PageHeader } from '../../design/PageHeader'
import { StatusChip } from '../../design/StatusChip'
import { Panel, TileGrid, StatTile, Toolbar } from '../../features/qc/ui'
import { logActivity } from '../../layout/activity'
import { endSession, liveSessions, sessionsCol, type SessionDoc } from '../../features/settings/sessions'
import { auth } from '../../firebase'
import { useViewAs } from '../../features/settings/ViewAs'
import { AccountRequestsPanel } from '../../features/settings/AccountRequests'
import { BrowserApprovals } from '../../features/settings/DeviceCode'
import '../../features/qc/qc.css'
import '../../features/settings/settings.css'

interface UserForm {
  name: string
  username: string
  phone: string
  gender: 'male' | 'female' | 'other' | ''
  sessionTimeoutMin: number
  maxLogins: number
  allowPasswordChange: boolean
  email: string
  password?: string
  role: Role
  partnerId?: string
  active: boolean
  maxDiscountPct: number
  maxDiscountAmountRs?: number // rupees in the form, paise on the profile
  allBranches: boolean
  branchIds: string[]
  defaultBranchId: string
  grants: string[]
  denies: string[]
}

// Creates the login on a throwaway secondary app so the admin stays signed in.
async function createAuthUser(email: string, password: string): Promise<string> {
  const secondary = initializeApp(getApp().options, `secondary-${Date.now()}`)
  try {
    const auth = getAuth(secondary)
    if (import.meta.env.VITE_USE_EMULATORS === 'true') {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    }
    const cred = await createUserWithEmailAndPassword(auth, email, password)
    await signOut(auth)
    return cred.user.uid
  } finally {
    await deleteApp(secondary)
  }
}

const permissionOptions = PERMISSION_GROUPS.map((g) => ({
  label: g.label,
  options: g.permissions.map((p) => ({ value: p.key, label: p.label, title: p.description })),
}))

export default function UsersPage() {
  const { message } = App.useApp()
  const { profile: me } = useAuth()
  const viewAs = useViewAs()
  const canViewAs = me?.role === 'labAdmin' && !viewAs.viewingAs
  const { data: users, loading } = useLiveQuery<UserProfile>(query(col(paths.users), orderBy('name')), [])
  const { data: branchDocs } = useLiveQuery<Branch>(query(col('branches'), orderBy('name')), [])
  const { data: roleDocs } = useLiveQuery<RoleDoc>(query(col('roles')), [])
  const [editing, setEditing] = useState<UserProfile | 'new' | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<UserForm>()
  // Partner portal users are linked to one partner document (B2B centre, collection centre, corporate client, referrer).
  const partnerRoleW = Form.useWatch('role', form) as Role | undefined
  const partnerList = useLiveQuery<{ id: string; name: string }>(
    partnerRoleW && isPartnerRole(partnerRoleW) ? query(col(PARTNER_COLLECTION[partnerRoleW])) : null,
    [partnerRoleW],
  )

  // A lab with no branch documents runs as the single implicit "main" branch.
  const branches = useMemo<Pick<Branch, 'id' | 'name'>[]>(
    () => (branchDocs.length ? branchDocs : [{ id: 'main', name: 'Main branch' }]),
    [branchDocs],
  )
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? id

  const rolePerms = (role: Role) => roleDocs.find((r) => r.id === role)?.permissions ?? DEFAULT_ROLE_PERMISSIONS[role]

  const open = (u: UserProfile | 'new') => {
    setEditing(u)
    form.resetFields()
    form.setFieldsValue(
      u === 'new'
        ? {
            name: '', username: '', phone: '', gender: '', sessionTimeoutMin: 0, maxLogins: 0, allowPasswordChange: true, email: '', password: '', role: 'reception', active: true, maxDiscountPct: 0, maxDiscountAmountRs: 0,
            // New users start on the main branch (not whichever branch sorts first by name).
            allBranches: false, branchIds: [(branches.find((b) => b.id === 'main') ?? branches[0]).id], defaultBranchId: (branches.find((b) => b.id === 'main') ?? branches[0]).id,
            grants: [], denies: [],
          }
        : {
            partnerId: u.partnerId ?? undefined, name: u.name, username: u.username ?? '', phone: u.phone ?? '', gender: u.gender ?? '', sessionTimeoutMin: u.sessionTimeoutMin ?? 0, maxLogins: u.maxLogins ?? 0, allowPasswordChange: u.allowPasswordChange !== false, email: u.email, role: u.role, active: u.active, maxDiscountPct: u.maxDiscountPct ?? 0, maxDiscountAmountRs: (u.maxDiscountAmount ?? 0) / 100,
            allBranches: u.allBranches ?? false, branchIds: u.branchIds ?? ['main'],
            defaultBranchId: u.defaultBranchId ?? u.branchIds?.[0] ?? 'main',
            grants: u.grants ?? [], denies: u.denies ?? [],
          },
    )
  }

  const save = async () => {
    const v = await form.validateFields()
    const branchIds = v.allBranches ? branches.map((b) => b.id) : v.branchIds ?? []
    const defaultBranchId = branchIds.includes(v.defaultBranchId) ? v.defaultBranchId : (branchIds[0] ?? '')
    // A permission cannot be both granted and denied: deny wins, so drop it from grants.
    const denies = v.denies ?? []
    const grants = (v.grants ?? []).filter((k) => !denies.includes(k))
    const common = {
      name: v.name.trim(),
      username: (v.username ?? '').trim().toLowerCase(),
      phone: (v.phone ?? '').trim(),
      gender: v.gender ?? '',
      sessionTimeoutMin: v.sessionTimeoutMin ?? 0,
      maxLogins: v.maxLogins ?? 0,
      allowPasswordChange: v.allowPasswordChange !== false,
      role: v.role,
      active: v.active,
      maxDiscountPct: v.maxDiscountPct ?? 0,
      maxDiscountAmount: Math.round((v.maxDiscountAmountRs ?? 0) * 100),
      allBranches: !!v.allBranches,
      branchIds,
      defaultBranchId,
      grants,
      denies,
      ...(isPartnerRole(v.role) ? { partnerId: v.partnerId } : {}),
    }
    if (isPartnerRole(v.role) && !v.partnerId) {
      message.error('Pick the organisation this portal login belongs to.')
      return
    }
    if (editing && editing !== 'new' && editing.role === 'labAdmin' && (!v.active || v.role !== 'labAdmin') && isLastAdmin(editing.uid)) {
      message.error('This is the last active Lab admin. Make another user a Lab admin first.')
      return
    }
    if (common.username) {
      const selfUid = editing && editing !== 'new' ? editing.uid : ''
      if (users.some((u) => u.uid !== selfUid && !u.deleted && (u.username ?? '').trim().toLowerCase() === common.username)) {
        message.error(`The username "${common.username}" is already taken.`)
        return
      }
    }
    setSaving(true)
    try {
      if (editing === 'new') {
        const uid = await createAuthUser(v.email.trim(), v.password ?? '')
        await saveUserProfile({ uid, email: v.email.trim(), labId: LAB_ID, ...common })
        void logActivity('user', `User ${common.name} added`)
        message.success('User created')
      } else if (editing) {
        const payload: Omit<UserProfile, 'permissions'> = { ...editing, ...common }
        if (!isPartnerRole(v.role)) delete payload.partnerId
        await saveUserProfile(payload)
        message.success('User updated')
      }
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // The lab must always keep one active, non-deleted Lab admin.
  const isLastAdmin = (uid: string) => !users.some((u) => u.uid !== uid && u.role === 'labAdmin' && u.active && !u.deleted)

  const resetPassword = async (u: UserProfile) => {
    try {
      await sendPasswordResetEmail(auth, u.email)
      void logActivity('user', `Password reset email sent to ${u.name}`)
      message.success(`Password reset email sent to ${u.email}`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const softDelete = async (u: UserProfile) => {
    if (u.uid === me?.uid) return void message.error('You cannot delete your own account.')
    if (u.role === 'labAdmin' && isLastAdmin(u.uid)) return void message.error('This is the last active Lab admin and cannot be deleted.')
    await saveUserProfile({ ...u, active: false, deleted: true, deletedAt: serverTimestamp() as unknown as UserProfile['deletedAt'] })
    void logActivity('user', `User ${u.name} deleted`)
    message.success('User deleted (kept for history)')
  }
  const restore = async (u: UserProfile) => {
    await saveUserProfile({ ...u, deleted: false, deletedAt: null })
    void logActivity('user', `User ${u.name} restored (inactive)`)
    message.success('User restored as inactive')
  }
  const toggleActive = async (u: UserProfile, on: boolean) => {
    if (!on && u.role === 'labAdmin' && isLastAdmin(u.uid)) return void message.error('This is the last active Lab admin and cannot be deactivated.')
    if (!on && u.uid === me?.uid) return void message.error('You cannot deactivate your own account.')
    await saveUserProfile({ ...u, active: on })
    void logActivity('user', `User ${u.name} ${on ? 'activated' : 'deactivated'}`)
  }
  const [sessionsOf, setSessionsOf] = useState<UserProfile | null>(null)
  const [sessionDocs, setSessionDocs] = useState<SessionDoc[]>([])
  useEffect(() => {
    if (!sessionsOf) return
    return onSnapshot(sessionsCol(sessionsOf.uid), (snap) => setSessionDocs(snap.docs.map((d) => ({ ...(d.data() as Omit<SessionDoc, 'id'>), id: d.id }))))
  }, [sessionsOf])
  const [showDeleted, setShowDeleted] = useState(false)

  const isNew = editing === 'new'
  const role = Form.useWatch('role', form) as Role | undefined
  const allBranches = Form.useWatch('allBranches', form) as boolean | undefined
  const branchIds = (Form.useWatch('branchIds', form) as string[] | undefined) ?? []
  const grants = (Form.useWatch('grants', form) as string[] | undefined) ?? []
  const denies = (Form.useWatch('denies', form) as string[] | undefined) ?? []
  const effective = role ? effectivePermissions(role, rolePerms(role), grants, denies) : []
  const editingSelf = editing && editing !== 'new' && editing.uid === me?.uid

  const [q, setQ] = useState('')
  const shown = users.filter((u) => (showDeleted ? !!u.deleted : !u.deleted) && `${u.name} ${u.email} ${u.username ?? ''} ${u.phone ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
  const fileRef = useRef<HTMLInputElement>(null)
  const [bulk, setBulk] = useState<{ rows: string[][]; log: string[]; busy: boolean } | null>(null)
  const branchCount = (id: string) => users.filter((u) => u.active && (u.allBranches || (u.branchIds ?? ['main']).includes(id))).length

  const exportUsers = () =>
    downloadCsv('users.csv', [
      ['Name', 'Username', 'Email', 'Phone', 'Gender', 'Role', 'Branches', 'Status', 'Last login'],
      ...users.filter((u) => !u.deleted).map((u) => [u.name, u.username ?? '', u.email, u.phone ?? '', u.gender ?? '', ROLE_LABEL[u.role] ?? u.role, u.allBranches ? 'All branches' : (u.branchIds ?? []).map(branchName).join('; '), u.active ? 'Active' : 'Inactive', u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '']),
    ])
  const template = () =>
    downloadCsv('users-template.csv', [
      ['name', 'email', 'password', 'role', 'phone', 'username', 'gender', 'branch ids (semicolon separated)'],
      ['Asha Rao', 'asha@example.com', 'ChangeMe123', 'reception', '9876543210', 'asha', 'female', branches[0]?.id ?? 'main'],
    ])
  const readCsv = async (f: File) => {
    const rows = (await f.text()).split(/\r?\n/).filter((l) => l.trim()).slice(1).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()))
    setBulk({ rows, log: [], busy: false })
  }
  const runBulk = async () => {
    if (!bulk) return
    setBulk({ ...bulk, busy: true, log: [] })
    const log: string[] = []
    for (const [name, email, password, role, phone, username, gender, br] of bulk.rows) {
      try {
        if (!name || !email || (password ?? '').length < 6) throw new Error('name, email and a 6+ character password are required')
        if (!(ROLES as readonly string[]).includes(role)) throw new Error(`unknown role "${role}"`)
        const ids = (br ? br.split(';') : [branches[0]?.id ?? 'main']).map((x) => x.trim()).filter((x) => branches.some((b) => b.id === x))
        const uid = await createAuthUser(email, password)
        await saveUserProfile({
          uid, email, labId: LAB_ID, name, role: role as Role, active: true, maxDiscountPct: 0, allBranches: false,
          branchIds: ids, defaultBranchId: ids[0] ?? '', grants: [], denies: [],
          phone: phone ?? '', username: (username ?? '').toLowerCase(), gender: (['male', 'female', 'other'].includes(gender) ? gender : '') as UserProfile['gender'],
        })
        log.push(`Added ${name}`)
      } catch (e) {
        log.push(`Skipped ${name || email || 'row'}: ${(e as Error).message}`)
      }
      setBulk((b) => (b ? { ...b, log: [...log] } : b))
    }
    setBulk((b) => (b ? { ...b, busy: false, log } : b))
    void logActivity('user', `${log.filter((l) => l.startsWith('Added')).length} users added in bulk`)
  }

  return (
    <div>
      <PageHeader
        title="Manage Users"
        subtitle="Staff accounts, roles, branch access and session rules."
        actions={
          <>
            <DsButton onClick={() => fileRef.current?.click()} icon={<UploadOutlined />}>Bulk add users</DsButton>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden aria-label="Upload users CSV" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readCsv(f) }} />
            <DsButton variant="primary" icon={<PlusOutlined />} onClick={() => open('new')}>Add user</DsButton>
          </>
        }
      />
      <Panel title="Branch access summary" style={{ marginBottom: 'var(--s-4)' }}>
        <TileGrid>
          <StatTile label="Active users" value={users.filter((u) => u.active).length} />
          {branches.map((b) => (
            <StatTile key={b.id} label={b.name} value={branchCount(b.id)} hint="users with access" />
          ))}
          <StatTile label="No branch" value={users.filter((u) => u.active && !u.allBranches && !(u.branchIds ?? ['main']).length).length} tone="caution" />
        </TileGrid>
      </Panel>
      <Toolbar>
        <Input.Search allowClear placeholder="Search name, username, email, phone" style={{ maxWidth: 340 }} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
        <span className="qc-toolbar__spacer" />
        <Space size={4}><Switch size="small" checked={showDeleted} onChange={setShowDeleted} aria-label="Show deleted users" /> <span>Deleted users</span></Space>
        <DsButton icon={<DownloadOutlined />} onClick={exportUsers}>Export CSV</DsButton>
      </Toolbar>
      <Panel>
        <Table<UserProfile>
          rowKey="uid"
          loading={loading}
          dataSource={shown}
          pagination={{ pageSize: 25, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: 'Name', render: (_, u) => <span>{u.name}{u.username && <small className="qc-muted"> @{u.username}</small>}</span> },
            { title: 'Email', dataIndex: 'email' },
            { title: 'Contact', dataIndex: 'phone' },
            { title: 'Role', dataIndex: 'role', render: (r: Role) => <StatusChip variant="info">{ROLE_LABEL[r] ?? r}</StatusChip> },
            {
              title: 'Branches',
              render: (_, u) =>
                u.allBranches ? (
                  <StatusChip variant="neutral">All branches</StatusChip>
                ) : (u.branchIds ?? ['main']).length ? (
                  (u.branchIds ?? ['main']).map((b) => (
                    <StatusChip key={b} variant="neutral">{branchName(b)}{b === u.defaultBranchId ? ' (default)' : ''}</StatusChip>
                  ))
                ) : (
                  <StatusChip variant="urgent">No branch</StatusChip>
                ),
            },
            {
              title: 'Overrides',
              render: (_, u) => ((u.grants?.length ?? 0) + (u.denies?.length ?? 0) ? `+${u.grants?.length ?? 0} / -${u.denies?.length ?? 0}` : '-'),
            },
            { title: 'Max discount', dataIndex: 'maxDiscountPct', render: (n: number) => `${n ?? 0}%` },
            { title: 'Session', render: (_, u) => (u.sessionTimeoutMin ? `${u.sessionTimeoutMin >= 60 ? `${u.sessionTimeoutMin / 60} h` : `${u.sessionTimeoutMin} min`} idle` : 'No timeout') },
            { title: 'Last login', render: (_, u) => (u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : <span className="qc-muted">never</span>) },
            { title: 'Login limit', render: (_, u) => (u.maxLogins ? u.maxLogins : 'No limit') },
            { title: 'Status', render: (_, u) => (u.deleted ? <StatusChip variant="urgent">Deleted</StatusChip> : <Switch size="small" checked={u.active} onChange={(on) => void toggleActive(u, on)} aria-label={`Active ${u.name}`} />) },
            {
              title: '',
              render: (_, u) =>
                u.deleted ? (
                  <Button type="link" onClick={() => void restore(u)}>Restore</Button>
                ) : (
                  <Space size={0} wrap>
                    <Button type="link" onClick={() => open(u)}>Edit</Button>
                    <Button type="link" onClick={() => setSessionsOf(u)}>Sessions</Button>
                    {canViewAs && u.uid !== me?.uid && u.active && <Popconfirm title={`View the app as ${u.name}? Read-only, and recorded in the audit log.`} onConfirm={() => void viewAs.begin(u)}><Button type="link">View as</Button></Popconfirm>}
                    <Popconfirm title={`Send a password reset email to ${u.email}?`} onConfirm={() => void resetPassword(u)}><Button type="link">Reset password</Button></Popconfirm>
                    <Popconfirm title={`Delete ${u.name}? They can no longer sign in; history is kept.`} onConfirm={() => void softDelete(u)}><Button type="link" danger>Delete</Button></Popconfirm>
                  </Space>
                ),
            },
          ]}
        />
      </Panel>
      <Panel title="Account deletion requests" style={{ marginTop: 'var(--s-4)' }}><AccountRequestsPanel users={users} /></Panel>
      <Panel title="Browser approvals" style={{ marginTop: 'var(--s-4)' }}><BrowserApprovals /></Panel>
      <Drawer
        title={isNew ? 'Add user' : 'Edit user'}
        open={!!editing}
        size={680}
        onClose={() => setEditing(null)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <DsButton variant="primary" disabled={saving} onClick={save}>Save</DsButton>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <FormSection title="Account" description="Who this person is and how they sign in.">
            <FieldGrid min={240}>
              <Form.Item name="name" label="Name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="gender" label="Gender">
                <Select allowClear options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} />
              </Form.Item>
              <Form.Item name="email" label="Email (login)" rules={[{ required: true, type: 'email' }]}>
                <Input disabled={!isNew} />
              </Form.Item>
              <Form.Item name="phone" label="Contact number">
                <Input inputMode="tel" />
              </Form.Item>
              <Form.Item name="username" label="Username" extra="Lowercase, must be unique. Can be used instead of the email to sign in.">
                <Input autoComplete="off" />
              </Form.Item>
              {isNew && (
                <Form.Item name="password" label="Initial password" rules={[{ required: true, min: 6, message: 'At least 6 characters' }]}>
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              )}
            </FieldGrid>
          </FormSection>

          <FormSection title="Role and discount limits" description="What this person can do. The role's permissions are edited under Roles & permissions.">
            <FieldGrid min={240}>
              <Form.Item name="role" label="Role">
                <Select options={[
                  { label: 'Staff', options: ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] })) },
                  { label: 'Partner portal (sees only their own organisation)', options: PARTNER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] })) },
                ]} />
              </Form.Item>
              {role && isPartnerRole(role) && (
                <Form.Item name="partnerId" label="Organisation" rules={[{ required: true, message: 'Required' }]} extra="The login can only open bills, reports, statements and wallet of this organisation.">
                  <Select showSearch optionFilterProp="label" loading={partnerList.loading} options={partnerList.data.map((x) => ({ value: x.id, label: x.name }))} placeholder="Select organisation" />
                </Form.Item>
              )}
              <Form.Item name="maxDiscountPct" label="Max discount" tooltip="Highest bill discount this user may give (needs the Give discounts permission)">
                <InputNumber min={0} max={100} addonAfter="%" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="maxDiscountAmountRs" label="Max discount per bill" tooltip="Highest rupee discount on one bill. 0 uses the lab-wide cap from Front desk settings (or no cap if none is set).">
                <InputNumber min={0} precision={2} addonBefore="Rs" style={{ width: '100%' }} />
              </Form.Item>
            </FieldGrid>
          </FormSection>

          <FormSection title="Sign-in and session" description="How long a session lasts and whether this person can manage their own password.">
            <FieldGrid min={240}>
              <Form.Item name="sessionTimeoutMin" label="Sign out after inactivity" extra="Enforced in the browser.">
                <Select options={[{ value: 0, label: 'Never' }, { value: 60, label: '1 hour' }, { value: 480, label: '8 hours' }, { value: 720, label: '12 hours' }, { value: 15, label: '15 minutes' }, { value: 30, label: '30 minutes' }]} />
              </Form.Item>
              <Form.Item name="maxLogins" label="Login limit" extra="Signing in beyond the limit signs out the oldest session.">
                <Select options={[{ value: 0, label: 'No limit' }, ...[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))]} />
              </Form.Item>
            </FieldGrid>
            <SettingRow label="Allow user to change own password" help="When off, only an admin can reset this person's password." htmlFor="uf-allowPasswordChange">
              <Form.Item name="allowPasswordChange" valuePropName="checked" noStyle><Switch id="uf-allowPasswordChange" /></Form.Item>
            </SettingRow>
            {editing && editing !== 'new' && (
              <SettingRow label="Password reset" help="Emails a reset link to this user.">
                <Button onClick={() => void resetPassword(editing)}>Send password reset email</Button>
              </SettingRow>
            )}
          </FormSection>

          <FormSection title="Branch access" description="Which branches this person can work in.">
            <SettingRow label="All branches" help="Access to every branch, including ones added later." htmlFor="uf-allBranches">
              <Form.Item name="allBranches" valuePropName="checked" noStyle><Switch id="uf-allBranches" /></Form.Item>
            </SettingRow>
            <FieldGrid min={240}>
              {!allBranches && (
                <Form.Item name="branchIds" label="Branches" extra="No branch selected means the user cannot work anywhere.">
                  <Select mode="multiple" options={branches.map((b) => ({ value: b.id, label: b.name }))} placeholder="Select branches" />
                </Form.Item>
              )}
              <Form.Item name="defaultBranchId" label="Default branch">
                <Select options={(allBranches ? branches : branches.filter((b) => branchIds.includes(b.id))).map((b) => ({ value: b.id, label: b.name }))} />
              </Form.Item>
            </FieldGrid>
          </FormSection>

          <FormSection
            title="Permission overrides"
            description="Fine-tune this person's access on top of their role."
            className={role && isPartnerRole(role) ? 'st-hide' : ''}
          >
            <Form.Item name="grants" hidden={!!(role && isPartnerRole(role))} label="Extra permissions (grant)" tooltip="Added on top of the role">
              <Select mode="multiple" allowClear options={permissionOptions} optionFilterProp="label" placeholder="Grant extra permissions" />
            </Form.Item>
            <Form.Item name="denies" hidden={!!(role && isPartnerRole(role))} label="Removed permissions (deny)" tooltip="Taken away even if the role has them">
              <Select mode="multiple" allowClear options={permissionOptions} optionFilterProp="label" placeholder="Deny permissions" />
            </Form.Item>
            <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
              Effective: {role === 'labAdmin' ? 'everything (Lab admin)' : `${effective.length} permissions`}
            </Typography.Paragraph>
          </FormSection>

          <FormSection title="Status">
            <SettingRow label="Active" help="Inactive users cannot sign in." htmlFor="uf-active">
              <Form.Item name="active" valuePropName="checked" noStyle><Switch id="uf-active" /></Form.Item>
            </SettingRow>
            {editingSelf && <Alert type="warning" showIcon message="You are editing your own account." style={{ marginTop: 'var(--s-3)' }} />}
          </FormSection>
        </Form>
      </Drawer>
      <Modal title={`Active sessions: ${sessionsOf?.name ?? ''}`} open={!!sessionsOf} onCancel={() => setSessionsOf(null)} footer={null} destroyOnHidden width={dialogWidth(720)}>
        <Table<SessionDoc>
          rowKey="id"
          size="small"
          scroll={{ x: 'max-content' }}
          pagination={false}
          dataSource={liveSessions(sessionDocs)}
          locale={{ emptyText: 'No active sessions' }}
          columns={[
            { title: 'Device', dataIndex: 'device' },
            { title: 'Signed in', render: (_, x) => new Date(x.startedAt).toLocaleString() },
            { title: 'Last seen', render: (_, x) => new Date(x.seenAt).toLocaleTimeString() },
            { title: '', render: (_, x) => <Popconfirm title="Sign this session out?" onConfirm={() => sessionsOf && void endSession(sessionsOf.uid, x.id)}><Button type="link" danger>Log out</Button></Popconfirm> },
          ]}
        />
        {sessionsOf && <Button style={{ marginTop: 12 }} danger onClick={() => Promise.all(liveSessions(sessionDocs).map((x) => endSession(sessionsOf.uid, x.id)))}>Log out everywhere</Button>}
      </Modal>
      <Modal
        title="Bulk add users"
        open={!!bulk}
        onCancel={() => !bulk?.busy && setBulk(null)}
        onOk={runBulk}
        okText={`Create ${bulk?.rows.length ?? 0} user(s)`}
        okButtonProps={{ disabled: !bulk?.rows.length || bulk.busy || bulk.log.length > 0 }}
        confirmLoading={bulk?.busy}
        destroyOnHidden
      >
        <p>Upload a CSV with the columns name, email, password, role, phone, username, gender and branch ids. <Button type="link" onClick={template} style={{ padding: 0 }}>Download a template</Button></p>
        <p>{bulk?.rows.length ?? 0} row(s) read.</p>
        {bulk && bulk.log.length > 0 && (
          <ul className="howto" aria-live="polite">{bulk.log.map((l, i) => <li key={i}>{l}</li>)}</ul>
        )}
      </Modal>
    </div>
  )
}
