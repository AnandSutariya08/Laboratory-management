import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Checkbox, Popconfirm, Space, Table, Tooltip, Typography } from 'antd'
import { Panel } from '../../features/qc/ui'
import { PageHeader } from '../../design/PageHeader'
import { Button as DsButton } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { setDoc } from 'firebase/firestore'
import { query } from 'firebase/firestore'
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS_V2, ROLE_LABEL, ROLES, withImplied } from '../../auth/permissions'
import { useLiveQuery } from '../../hooks/useLive'
import { col, docRef } from '../../lib/db'
import type { Role, RoleDoc } from '../../types'

type Draft = Record<Role, string[]>

interface Row {
  key: string
  kind: 'group' | 'perm'
  label: string
  description?: string
  perms: string[] // for a group: all its keys; for a perm: [key]
}

const rows: Row[] = PERMISSION_GROUPS.flatMap((g) => [
  { key: `g-${g.module}`, kind: 'group' as const, label: g.label, perms: g.permissions.map((p) => p.key as string) },
  ...g.permissions.map((p) => ({ key: p.key as string, kind: 'perm' as const, label: p.label, description: p.description, perms: [p.key as string] })),
])

export default function RolesPage() {
  const { message } = App.useApp()
  const { data: docs, loading } = useLiveQuery<RoleDoc>(query(col('roles')), [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  // Stored matrix (or built-in defaults for roles that have no document yet).
  const stored = useMemo<Draft>(() => {
    const out = {} as Draft
    for (const r of ROLES) out[r] = withImplied(docs.find((d) => d.id === r)?.permissions ?? [...DEFAULT_ROLE_PERMISSIONS[r]])
    out.labAdmin = [...ALL_PERMISSIONS]
    return out
  }, [docs])

  useEffect(() => {
    if (!loading) setDraft(null)
  }, [stored, loading])
  const matrix = draft ?? stored
  const dirtyRoles = ROLES.filter((r) => r !== 'labAdmin' && draft && [...draft[r]].sort().join() !== [...stored[r]].sort().join())

  const toggle = (role: Role, perms: string[], on: boolean) => {
    const base = { ...matrix }
    const set = new Set(base[role])
    perms.forEach((p) => (on ? set.add(p) : set.delete(p)))
    base[role] = [...set]
    setDraft(base)
  }

  const saveRole = async (role: Role, permissions: string[]) => {
    await setDoc(docRef('roles', role), { name: ROLE_LABEL[role], permissions: [...new Set([...permissions, PERMISSIONS_V2])], builtIn: true })
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      for (const r of dirtyRoles) await saveRole(r, draft[r])
      message.success('Permissions saved')
      setDraft(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const reset = async (role: Role) => {
    try {
      await saveRole(role, [...DEFAULT_ROLE_PERMISSIONS[role]])
      setDraft((d) => (d ? { ...d, [role]: [...DEFAULT_ROLE_PERMISSIONS[role]] } : d))
      message.success(`${ROLE_LABEL[role]} reset to defaults`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div>
      <PageHeader
        title="Roles & Permissions"
        subtitle="Change what each role can do. Applies to everyone with that role immediately."
        actions={
          <>
            {dirtyRoles.length > 0 && <StatusChip variant="caution">{dirtyRoles.length} role(s) changed</StatusChip>}
            <DsButton disabled={!draft} onClick={() => setDraft(null)}>Discard</DsButton>
            <DsButton variant="primary" disabled={!dirtyRoles.length || saving} onClick={save}>Save changes</DsButton>
          </>
        }
      />
      <Panel>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Changes apply to everyone with that role immediately. Individual users can have extra grants or denies under Staff. The Lab admin role always has every permission."
      />
      <Table<Row>
        rowKey="key"
        size="small"
        loading={loading}
        pagination={false}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: 'Permission',
            fixed: 'left',
            width: 280,
            render: (_, r) =>
              r.kind === 'group' ? (
                <Typography.Text strong>{r.label}</Typography.Text>
              ) : (
                <Tooltip title={r.description}>
                  <span style={{ paddingLeft: 16 }}>{r.label}</span>
                </Tooltip>
              ),
          },
          ...ROLES.map((role) => ({
            title: (
              <Space direction="vertical" size={0} style={{ textAlign: 'center' }}>
                <span>{ROLE_LABEL[role]}</span>
                {role !== 'labAdmin' && (
                  <Popconfirm title={`Reset ${ROLE_LABEL[role]} to defaults?`} onConfirm={() => reset(role)}>
                    <Button type="link" size="small">
                      Reset
                    </Button>
                  </Popconfirm>
                )}
                {role === 'labAdmin' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>locked</Typography.Text>}
              </Space>
            ),
            key: role,
            align: 'center' as const,
            width: 120,
            render: (_: unknown, r: Row) => {
              const have = r.perms.filter((p) => matrix[role].includes(p)).length
              const checked = have === r.perms.length
              return (
                <Checkbox
                  disabled={role === 'labAdmin'}
                  checked={checked}
                  indeterminate={have > 0 && !checked}
                  onChange={(e) => toggle(role, r.perms, e.target.checked)}
                />
              )
            },
          })),
        ]}
        onRow={(r) => ({ style: r.kind === 'group' ? { background: 'var(--c-surface-container-low)' } : undefined })}
      />
      </Panel>
    </div>
  )
}
