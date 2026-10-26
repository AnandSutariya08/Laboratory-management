import { Collapse, Drawer, Popconfirm, Table } from 'antd'
import { EyeOutlined, RollbackOutlined } from '@ant-design/icons'
import { orderBy, query } from 'firebase/firestore'
import { versionsCol } from '../../lib/db'
import { useLiveQuery } from '../../hooks/useLive'
import { EmptyState } from '../../design/EmptyState'
import { SkeletonRows } from '../../design/Skeletons'
import { StatusChip } from '../../design/StatusChip'
import { Button } from '../../design/Button'
import type { ResultVersion, Test } from '../../types'
import { fmtDateTime } from './common'

const VARIANT: Record<string, 'info' | 'success' | 'caution' | 'urgent' | 'neutral'> = {
  saved: 'info',
  approved: 'success',
  unapproved: 'caution',
  rerun: 'urgent',
  amended: 'caution',
  hold: 'caution',
  sentBack: 'caution',
  restored: 'info',
}
const LABEL: Record<string, string> = {
  saved: 'Saved',
  approved: 'Test approved',
  unapproved: 'Un-approved',
  rerun: 'Re-run (previous value kept)',
  amended: 'Amended',
  hold: 'On hold',
  sentBack: 'Sent back',
  restored: 'Restored',
}

export type VersionRow = Omit<ResultVersion, 'event'> & { event: string; reason?: string }

export default function VersionsDrawer({
  orderId,
  test,
  onClose,
  onRestore,
}: {
  orderId: string
  test: Test | null
  onClose: () => void
  // When given, each older version shows Restore (loads its values into the editor).
  onRestore?: (v: VersionRow) => void
}) {
  const { data, loading } = useLiveQuery<VersionRow>(
    test ? query(versionsCol(orderId, test.id), orderBy('at', 'desc')) : null,
    [orderId, test?.id],
  )
  const nameOf = (k: string) => test?.parameters.find((p) => p.key === k)?.name ?? k
  return (
    <Drawer open={!!test} onClose={onClose} width={480} title={test ? `Versions: ${test.name}` : 'Versions'} destroyOnHidden>
      {loading ? (
        <SkeletonRows rows={4} columns={2} />
      ) : data.length === 0 ? (
        <EmptyState title="No versions yet" description="Every save, approval, amendment and re-run is recorded here." />
      ) : (
        data.map((v, n) => (
          <div key={v.id} style={{ marginBottom: 'var(--s-4)' }}>
            <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <StatusChip variant={VARIANT[v.event] ?? 'neutral'}>{LABEL[v.event] ?? v.event}</StatusChip>
              {n === 0 && <StatusChip variant="success">Current version</StatusChip>}
              <span>{v.byName}</span>
              <span className="wl-muted">{fmtDateTime(v.at)}</span>
              {onRestore && n > 0 && Object.keys(v.values ?? {}).length > 0 && (
                <Popconfirm title="Restore these values?" description="They are loaded into the editor; save to keep them." okText="Restore" onConfirm={() => onRestore(v)}>
                  <Button icon={<RollbackOutlined />}>Restore</Button>
                </Popconfirm>
              )}
            </div>
            {v.reason && <div className="wl-muted">Reason: {v.reason}</div>}
            <Collapse
              ghost
              size="small"
              items={[
                {
                  key: 'v',
                  label: (
                    <span>
                      <EyeOutlined /> View values
                    </span>
                  ),
                  children: (
                    <Table
                      size="small"
                      pagination={false}
                      rowKey="k"
                      dataSource={Object.entries(v.values ?? {}).map(([k, val]) => ({ k, ...val }))}
                      columns={[
                        { title: 'Parameter', render: (_, r) => nameOf(r.k) },
                        { title: 'Value', render: (_, r) => (/^data:|<[a-z]/i.test(r.value) ? '(attachment / formatted text)' : r.value) },
                        { title: 'Flag', width: 60, render: (_, r) => (r.abnormal === 'high' ? 'H' : r.abnormal === 'low' ? 'L' : r.abnormal === 'abnormal' ? 'Abn' : '') },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </div>
        ))
      )}
    </Drawer>
  )
}
