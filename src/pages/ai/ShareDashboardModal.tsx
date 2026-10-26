import { useEffect, useState } from 'react'
import { App, Button, Checkbox, Modal, Space, Typography } from 'antd'
import { shareAiDashboard } from '../../lib/aiAnalyst'

const { Text } = Typography
const ROLES = [
  { value: 'manager', label: 'Managers' },
  { value: 'admin', label: 'Admins (always can open)' },
  { value: 'labAdmin', label: 'Lab admins (always can open)' },
]

// Share a dashboard with roles. The owner and lab admins can always open it.
export default function ShareDashboardModal({
  open,
  dashboardId,
  title,
  roles,
  onClose,
  onSaved,
}: {
  open: boolean
  dashboardId: string
  title: string
  roles: string[] | null | undefined
  onClose: () => void
  onSaved: () => void
}) {
  const { message } = App.useApp()
  const [value, setValue] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setValue(roles ?? ['manager']) // legacy dashboards (no list) were open to every AI user
  }, [open, roles])

  const save = async () => {
    setSaving(true)
    try {
      await shareAiDashboard({ dashboardId, roles: value })
      message.success('Sharing updated')
      onSaved()
      onClose()
    } catch (e) {
      message.error(e instanceof Error ? e.message.replace(/\s*\[\d+\]\s*$/, '') : 'Could not update sharing')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title={`Share "${title}"`} footer={null} destroyOnClose>
      <Text type="secondary">Pick the roles that may open this dashboard. Only the owner and lab admins can change sharing.</Text>
      <Checkbox.Group
        style={{ display: 'grid', gap: 8, margin: '12px 0' }}
        options={ROLES.map((r) => ({ ...r, disabled: r.value !== 'manager' }))}
        value={[...new Set([...value, 'admin', 'labAdmin'])]}
        onChange={(v) => setValue((v as string[]).filter((x) => x === 'manager'))}
      />
      <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
        <Button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/ai?tab=dashboards&d=${dashboardId}`).then(() => message.success('Link copied'))}>Copy link</Button>
        <Button type="primary" loading={saving} onClick={save}>
          Save
        </Button>
      </Space>
    </Modal>
  )
}
