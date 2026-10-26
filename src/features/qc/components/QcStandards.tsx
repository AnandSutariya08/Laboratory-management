import { useState } from 'react'
import { Checkbox, InputNumber, Radio, Select, Space, Switch, Table } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { Button } from '../../../design/Button'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { WESTGARD_RULES, type QcSettings, type WestgardRule } from '../types'
import { paramName, TestParamSelect, type TestParam } from './shared'
import { Panel } from '../ui'

type SetFn = <K extends keyof QcSettings>(k: K, v: QcSettings[K]) => void
const nameOf = (maps: ReturnType<typeof useCatalogueMaps>, k: string) => {
  const [t, p, l] = k.split('|')
  return `${maps.testById.get(t)?.name ?? t} / ${paramName(maps.testById.get(t), p)}${l ? ` (${l})` : ''}`
}

// Westgard profile (across levels / runs), per-parameter rule override, TEa and claimed CV per parameter,
// and EQAS limits. Rendered inside QC setting; saved with the rest of the QC settings.
export default function QcStandards({ draft, set }: { draft: QcSettings; set: SetFn }) {
  const maps = useCatalogueMaps()
  const [tp, setTp] = useState<TestParam>({})
  const [tp2, setTp2] = useState<TestParam>({})
  const wg = draft.westgard ?? { acrossLevels: true, acrossRuns: true }
  const over = draft.paramRules ?? {}
  const tea = draft.tea ?? {}
  const claim = draft.claimCv ?? {}
  const keyOf = (p: TestParam) => `${p.testId}|${p.paramKey}`
  const ok = (p: TestParam) => !!p.testId && !!p.paramKey
  const metricKeys = [...new Set([...Object.keys(tea), ...Object.keys(claim)])]
  return (
    <>
      <Panel title="Westgard profile">
        <div className="field-row">
          <label>Multi-point rules look across</label>
          <Space>
            <Switch aria-label="Across levels" checked={wg.acrossLevels} onChange={(v) => set('westgard', { ...wg, acrossLevels: v })} /> <span>levels in the same run (2-2s, R-4s, 4-1s, 10x)</span>
          </Space>
          <Space>
            <Switch aria-label="Across runs" checked={wg.acrossRuns} onChange={(v) => set('westgard', { ...wg, acrossRuns: v })} /> <span>consecutive runs of the same level</span>
          </Space>
        </div>
        <div className="field-row">
          <label>Per-parameter rule override (replaces the lot's rule list for that parameter)</label>
          <Space wrap style={{ marginBottom: 8 }}>
            <TestParamSelect tests={maps.tests} value={tp} onChange={setTp} />
            <Button disabled={!ok(tp)} onClick={() => set('paramRules', { ...over, [keyOf(tp)]: over[keyOf(tp)] ?? [...(draft.rules ?? [])] })}>Add override</Button>
          </Space>
          <Table
            size="small"
            pagination={false}
            rowKey="k"
            locale={{ emptyText: 'No overrides; each lot uses its own rule list.' }}
            dataSource={Object.entries(over).map(([k, v]) => ({ k, v }))}
            columns={[
              { title: 'Test / parameter', render: (_, r) => nameOf(maps, r.k) },
              { title: 'Rules', render: (_, r) => <Checkbox.Group value={r.v} onChange={(v) => set('paramRules', { ...over, [r.k]: v as WestgardRule[] })} options={WESTGARD_RULES.map((x) => ({ value: x, label: x }))} /> },
              { title: '', render: (_, r) => <Button aria-label="Remove override" icon={<DeleteOutlined />} onClick={() => { const n = { ...over }; delete n[r.k]; set('paramRules', n) }} /> },
            ]}
          />
        </div>
      </Panel>
      <Panel title="Allowable error (TEa) and sigma">
        <p className="qc-muted">Sigma = (TEa % - |bias %|) / CV %. Set TEa per parameter (and optionally a different value for one level, e.g. key it as L2 below). The manufacturer-claimed CV is used by precision validation.</p>
        <Space wrap style={{ marginBottom: 8 }}>
          <TestParamSelect tests={maps.tests} value={tp2} onChange={setTp2} />
          <Button disabled={!ok(tp2)} onClick={() => set('tea', { ...tea, [keyOf(tp2)]: tea[keyOf(tp2)] ?? 10 })}>Add TEa</Button>
          <Select allowClear placeholder="Level override" style={{ width: 140 }} aria-label="Level override" options={['L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} onChange={(l) => l && ok(tp2) && set('tea', { ...tea, [`${keyOf(tp2)}|${l}`]: tea[keyOf(tp2)] ?? 10 })} />
        </Space>
        <Table
          size="small"
          pagination={false}
          rowKey="k"
          locale={{ emptyText: 'No TEa set; sigma is not shown.' }}
          dataSource={metricKeys.map((k) => ({ k }))}
          columns={[
            { title: 'Test / parameter', render: (_, r) => nameOf(maps, r.k) },
            { title: 'TEa %', render: (_, r) => <InputNumber min={0} value={tea[r.k] ?? null} onChange={(v) => { const n = { ...tea }; if (v == null) delete n[r.k]; else n[r.k] = v; set('tea', n) }} /> },
            { title: 'Claimed CV %', render: (_, r) => (r.k.split('|').length > 2 ? '' : <InputNumber min={0} value={claim[r.k] ?? null} onChange={(v) => { const n = { ...claim }; if (v == null) delete n[r.k]; else n[r.k] = v; set('claimCv', n) }} />) },
            { title: '', render: (_, r) => <Button aria-label="Remove TEa" icon={<DeleteOutlined />} onClick={() => { const a = { ...tea }; const b = { ...claim }; delete a[r.k]; delete b[r.k]; set('tea', a); set('claimCv', b) }} /> },
          ]}
        />
      </Panel>
      <Panel title="EQAS limits">
        <div className="field-row">
          <label>Judge a round by</label>
          <Radio.Group value={draft.eqasMode ?? 'sdi'} onChange={(e) => set('eqasMode', e.target.value)} options={[{ value: 'sdi', label: 'SDI (z against the peer mean)' }, { value: 'percent', label: 'Fixed % deviation from the assigned value' }]} />
        </div>
        {(draft.eqasMode ?? 'sdi') === 'sdi' ? (
          <Space wrap>
            <label htmlFor="eq-warn">Warning above |SDI|</label>
            <InputNumber id="eq-warn" min={0} step={0.5} value={draft.eqasSdiWarn ?? 2} onChange={(v) => set('eqasSdiWarn', v ?? 2)} />
            <label htmlFor="eq-fail">Unacceptable above |SDI|</label>
            <InputNumber id="eq-fail" min={0} step={0.5} value={draft.eqasSdiFail ?? 3} onChange={(v) => set('eqasSdiFail', v ?? 3)} />
          </Space>
        ) : (
          <Space wrap>
            <label htmlFor="eq-pct">Acceptable up to (%)</label>
            <InputNumber id="eq-pct" min={0} value={draft.eqasPctLimit ?? 10} onChange={(v) => set('eqasPctLimit', v ?? 10)} />
            <span className="qc-muted">Warning up to 1.5 times the limit, unacceptable beyond.</span>
          </Space>
        )}
      </Panel>
    </>
  )
}
