import { useState } from 'react'
import { Checkbox, InputNumber, Radio, Select, Switch, Table } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { Button } from '../../../design/Button'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { WESTGARD_RULES, type QcSettings, type WestgardRule } from '../types'
import { paramName, TestParamSelect, type TestParam } from './shared'
import { Panel } from '../ui'
import { FormSection, SettingRow } from '../../../design/FormLayout'

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
        <FormSection title="Multi-point rules" description="Choose what the multi-point rules compare when they look for a pattern.">
          <SettingRow label="Across levels" help="Compare the levels in the same run (2-2s, R-4s, 4-1s, 10x).">
            <Switch aria-label="Across levels" checked={wg.acrossLevels} onChange={(v) => set('westgard', { ...wg, acrossLevels: v })} />
          </SettingRow>
          <SettingRow label="Across runs" help="Compare consecutive runs of the same level.">
            <Switch aria-label="Across runs" checked={wg.acrossRuns} onChange={(v) => set('westgard', { ...wg, acrossRuns: v })} />
          </SettingRow>
        </FormSection>
        <FormSection title="Per-parameter rule override" description="Replaces the lot's rule list for one parameter.">
          <div className="qc-addbar">
            <TestParamSelect tests={maps.tests} value={tp} onChange={setTp} />
            <Button disabled={!ok(tp)} onClick={() => set('paramRules', { ...over, [keyOf(tp)]: over[keyOf(tp)] ?? [...(draft.rules ?? [])] })}>Add override</Button>
          </div>
          <Table
            size="small"
            pagination={false}
            rowKey="k"
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: 'No overrides; each lot uses its own rule list.' }}
            dataSource={Object.entries(over).map(([k, v]) => ({ k, v }))}
            columns={[
              { title: 'Test / parameter', render: (_, r) => nameOf(maps, r.k) },
              { title: 'Rules', render: (_, r) => <Checkbox.Group className="qc-checkgrid" value={r.v} onChange={(v) => set('paramRules', { ...over, [r.k]: v as WestgardRule[] })} options={WESTGARD_RULES.map((x) => ({ value: x, label: x }))} /> },
              { title: '', render: (_, r) => <Button aria-label="Remove override" icon={<DeleteOutlined />} onClick={() => { const n = { ...over }; delete n[r.k]; set('paramRules', n) }} /> },
            ]}
          />
        </FormSection>
      </Panel>
      <Panel title="Allowable error (TEa) and sigma">
        <FormSection title="Allowable error per parameter" description="Sigma = (TEa % - |bias %|) / CV %. Set TEa per parameter, and optionally a different value for one level. The manufacturer-claimed CV is used by precision validation.">
          <div className="qc-addbar">
            <TestParamSelect tests={maps.tests} value={tp2} onChange={setTp2} />
            <Button disabled={!ok(tp2)} onClick={() => set('tea', { ...tea, [keyOf(tp2)]: tea[keyOf(tp2)] ?? 10 })}>Add TEa</Button>
            <Select allowClear placeholder="Level override" style={{ minWidth: 150 }} aria-label="Level override" options={['L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} onChange={(l) => l && ok(tp2) && set('tea', { ...tea, [`${keyOf(tp2)}|${l}`]: tea[keyOf(tp2)] ?? 10 })} />
          </div>
          <Table
            size="small"
            pagination={false}
            rowKey="k"
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: 'No TEa set; sigma is not shown.' }}
            dataSource={metricKeys.map((k) => ({ k }))}
            columns={[
              { title: 'Test / parameter', render: (_, r) => nameOf(maps, r.k) },
              { title: 'TEa', width: 170, render: (_, r) => <InputNumber aria-label={`TEa for ${nameOf(maps, r.k)}`} min={0} style={{ width: 140 }} addonAfter="%" value={tea[r.k] ?? null} onChange={(v) => { const n = { ...tea }; if (v == null) delete n[r.k]; else n[r.k] = v; set('tea', n) }} /> },
              { title: 'Claimed CV', width: 170, render: (_, r) => (r.k.split('|').length > 2 ? '' : <InputNumber aria-label={`Claimed CV for ${nameOf(maps, r.k)}`} min={0} style={{ width: 140 }} addonAfter="%" value={claim[r.k] ?? null} onChange={(v) => { const n = { ...claim }; if (v == null) delete n[r.k]; else n[r.k] = v; set('claimCv', n) }} />) },
              { title: '', width: 56, render: (_, r) => <Button aria-label="Remove TEa" icon={<DeleteOutlined />} onClick={() => { const a = { ...tea }; const b = { ...claim }; delete a[r.k]; delete b[r.k]; set('tea', a); set('claimCv', b) }} /> },
            ]}
          />
        </FormSection>
      </Panel>
      <Panel title="EQAS limits">
        <FormSection title="How a round is judged" description="Pick how an EQAS round is marked acceptable, warning or unacceptable.">
          <SettingRow label="Judge a round by" align="start">
            <Radio.Group value={draft.eqasMode ?? 'sdi'} onChange={(e) => set('eqasMode', e.target.value)} options={[{ value: 'sdi', label: 'SDI (z against the peer mean)' }, { value: 'percent', label: 'Fixed % deviation from the assigned value' }]} />
          </SettingRow>
          {(draft.eqasMode ?? 'sdi') === 'sdi' ? (
            <>
              <SettingRow label="Warning above |SDI|" help="A round above this value is flagged as a warning." htmlFor="eq-warn">
                <InputNumber id="eq-warn" min={0} step={0.5} style={{ width: 180 }} value={draft.eqasSdiWarn ?? 2} onChange={(v) => set('eqasSdiWarn', v ?? 2)} />
              </SettingRow>
              <SettingRow label="Unacceptable above |SDI|" help="A round above this value is marked unacceptable." htmlFor="eq-fail">
                <InputNumber id="eq-fail" min={0} step={0.5} style={{ width: 180 }} value={draft.eqasSdiFail ?? 3} onChange={(v) => set('eqasSdiFail', v ?? 3)} />
              </SettingRow>
            </>
          ) : (
            <SettingRow label="Acceptable up to" help="Warning up to 1.5 times the limit, unacceptable beyond." htmlFor="eq-pct">
              <InputNumber id="eq-pct" min={0} style={{ width: 180 }} addonAfter="%" value={draft.eqasPctLimit ?? 10} onChange={(v) => set('eqasPctLimit', v ?? 10)} />
            </SettingRow>
          )}
        </FormSection>
      </Panel>
    </>
  )
}
