import { useEffect, useState } from 'react'
import { Alert, App, Button, Checkbox, Drawer, Space, Spin, Table, Typography } from 'antd'
import { getAiDatasetAccess, setAiDatasetAccess, type DatasetAccessInfo } from '../../lib/aiAnalyst'

const { Text } = Typography

const ROLE_LABEL: Record<string, string> = { labAdmin: 'Lab admin', admin: 'Admin', manager: 'Manager' }
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/\s*\[\d+\]\s*$/, '') : 'Something went wrong')

// Which datasets each role may use in the AI analyst. Enforced on the server. Admin roles always keep all.
export default function DataAccessDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const [info, setInfo] = useState<DatasetAccessInfo | null>(null)
  const [access, setAccess] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    getAiDatasetAccess({})
      .then((r) => {
        setInfo(r)
        setAccess(r.access)
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false))
  }, [open])

  const toggle = (role: string, ds: string, on: boolean) =>
    setAccess((a) => ({ ...a, [role]: on ? [...new Set([...(a[role] ?? []), ds])] : (a[role] ?? []).filter((x) => x !== ds) }))

  const save = async () => {
    setSaving(true)
    try {
      await setAiDatasetAccess({ access })
      message.success('Data access saved')
      onClose()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(600px, 100vw)"
      title="Data access"
      extra={
        <Button type="primary" loading={saving} disabled={!info?.canEdit} onClick={save}>
          Save
        </Button>
      }
    >
      <Text type="secondary">Choose which datasets the AI analyst may read for each role. The server enforces this on every question, dashboard and table. Patient data is only ever shown as initials, age and gender.</Text>
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      {loading && <Spin style={{ display: 'block', margin: 40 }} />}
      {info && (
        <Table
          style={{ marginTop: 12 }}
          size="small"
          pagination={false}
          rowKey="value"
          dataSource={info.datasets}
          columns={[
            { title: 'Dataset', dataIndex: 'label' },
            ...info.roles.map((role) => ({
              title: ROLE_LABEL[role] ?? role,
              align: 'center' as const,
              width: 90,
              render: (_: unknown, d: { value: string }) => {
                const fixed = role === 'labAdmin' || role === 'admin'
                return (
                  <Checkbox
                    aria-label={`${ROLE_LABEL[role] ?? role} may use ${d.value}`}
                    checked={fixed || (access[role] ?? []).includes(d.value)}
                    disabled={fixed || !info.canEdit}
                    onChange={(e) => toggle(role, d.value, e.target.checked)}
                  />
                )
              },
            })),
          ]}
        />
      )}
      <Space style={{ marginTop: 12 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Lab admin and admin roles always keep every dataset.</Text>
      </Space>
    </Drawer>
  )
}
