import { Collapse, Tag, Typography } from 'antd'
import type { AiChatStep } from '../../types'

const { Text } = Typography

const TOOL_LABEL: Record<string, string> = {
  run_analytics: 'Analytics query',
  list_top_n: 'Ranking',
  compare_periods: 'Period comparison',
  get_bill_stats: 'Bill statistics',
  qc_summary: 'QC summary',
  bookings_summary: 'Bookings summary',
  lookup_tests: 'Catalogue lookup',
  patient_demographics: 'Patient demographics',
  list_patients_masked: 'Masked patient list',
  save_dashboard: 'Saved dashboard',
  update_dashboard: 'Updated dashboard',
}

// "How was this computed": every tool call behind an answer with its query spec and row count.
export default function ComputedPanel({ steps }: { steps: AiChatStep[] }) {
  if (!steps.length) return null
  return (
    <Collapse
      size="small"
      ghost
      style={{ marginTop: 6 }}
      items={[
        {
          key: 'how',
          label: <Text type="secondary" style={{ fontSize: 12 }}>How was this computed? ({steps.length} {steps.length === 1 ? 'step' : 'steps'})</Text>,
          children: (
            <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8 }}>
              {steps.map((s, i) => (
                <li key={i}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <Tag color={s.ok ? 'blue' : 'red'} style={{ margin: 0 }}>{TOOL_LABEL[s.tool] ?? s.tool}</Tag>
                    <Text>{s.summary}</Text>
                    {s.dataset && <Tag style={{ margin: 0 }}>dataset: {s.dataset}</Tag>}
                    {s.rowCount !== undefined && <Text type="secondary" style={{ fontSize: 12 }}>{s.rowCount} {s.rowCount === 1 ? 'row' : 'rows'}</Text>}
                  </div>
                  {s.spec !== undefined && (
                    <pre style={{ margin: '4px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--c-surface-container)', borderRadius: 6, padding: 6 }}>
                      {JSON.stringify(s.spec, null, 1)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          ),
        },
      ]}
    />
  )
}
