import { useState } from 'react'
import { Alert, Button, Space, Tag, Typography } from 'antd'
import { BulbOutlined } from '@ant-design/icons'
import { suggestResultFlags, type FlagSuggestion, type SuggestedFlag } from '../../lib/aiFlags'

const { Text } = Typography

const COLOR: Record<SuggestedFlag, string> = { low: 'blue', high: 'orange', critical: 'red', abnormal: 'volcano', normal: 'green', review: 'gold' }

interface Props {
  orderId: string
  // Optional: limit to some tests of the bill.
  testIds?: string[]
  // Optional: called when the user clicks "Use as hint" on a suggestion. Suggestions are advisory;
  // nothing is written to results by this component.
  onApplyHint?: (s: FlagSuggestion) => void
}

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/\s*\[\d+\]\s*$/, '') : 'Could not get suggestions')

// Drop into result entry: asks the AI for advisory flag suggestions on the bill's entered results.
export default function FlagSuggestions({ orderId, testIds, onApplyHint }: Props) {
  const [items, setItems] = useState<FlagSuggestion[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await suggestResultFlags(orderId, testIds))
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <Space wrap>
        <Button icon={<BulbOutlined />} loading={loading} onClick={run}>
          Suggest flags (AI)
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Advisory only. Nothing changes until you decide.
        </Text>
      </Space>
      {error && <Alert style={{ marginTop: 8 }} type="warning" showIcon message={error} />}
      {items && items.length === 0 && <Alert style={{ marginTop: 8 }} type="success" showIcon message="No flags need another look." />}
      {items && items.length > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {items.map((s) => (
            <div
              key={`${s.testId}:${s.parameterKey}`}
              style={{ border: '1px solid var(--c-outline-variant)', borderRadius: 'var(--r-control, 8px)', padding: '6px 10px', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}
            >
              <Text strong>{s.parameter}</Text>
              <Tag color={COLOR[s.suggestedFlag]} style={{ margin: 0 }}>
                {s.suggestedFlag}
              </Tag>
              <Text style={{ flex: 1, minWidth: 160 }}>{s.reason}</Text>
              {onApplyHint && (
                <Button size="small" onClick={() => onApplyHint(s)}>
                  Use as hint
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
