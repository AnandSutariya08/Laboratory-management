import { useEffect, useState } from 'react'
import { App, InputNumber, Modal, Select, Switch } from 'antd'
import { setDoc } from 'firebase/firestore'
import { labDoc } from '../../lib/db'
import { useLabSettings, useCatalogueMaps } from '../../hooks/useCatalogue'
import { dialogWidth } from '../../design/dialog'
import type { AutoVerifyConfig } from '../../types'

export const DEFAULT_AUTO_VERIFY: AutoVerifyConfig = {
  enabled: false,
  samplingPct: 5,
  blockAbnormal: true,
  useDeltaCheck: true,
  requireQcInControl: true,
  excludedTestIds: [],
  signatureMode: 'defaultSignatory',
  version: 0,
}

// Lab-level auto-verification rule set. A result that comes straight from an analyser is approved without a person
// only when every rule passes; otherwise it waits for verification as usual. Saved on the lab document (admins only).
export default function AutoVerifyRulesModal({ open, canEdit, who, onClose }: { open: boolean; canEdit: boolean; who: string; onClose: () => void }) {
  const { message } = App.useApp()
  const settings = useLabSettings()
  const maps = useCatalogueMaps()
  const [cfg, setCfg] = useState<AutoVerifyConfig>(DEFAULT_AUTO_VERIFY)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setCfg({ ...DEFAULT_AUTO_VERIFY, ...(settings.autoVerify ?? {}) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const set = (p: Partial<AutoVerifyConfig>) => setCfg((c) => ({ ...c, ...p }))
  const save = async () => {
    setBusy(true)
    try {
      await setDoc(labDoc(), { autoVerify: { ...cfg, samplingPct: Math.max(0, Math.min(100, cfg.samplingPct)), version: (settings.autoVerify?.version ?? 0) + 1, updatedByName: who } }, { merge: true })
      message.success('Auto-verification rules saved')
      onClose()
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save the rules')
    } finally {
      setBusy(false)
    }
  }
  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="re-field" style={{ gridTemplateColumns: '1fr auto', alignItems: 'center', columnGap: 'var(--s-4)' }}>
      <div>
        <label>{label}</label>
        <div className="wl-muted">{hint}</div>
      </div>
      {control}
    </div>
  )
  return (
    <Modal open={open} title="Auto-verification rules" width={dialogWidth(620)} okText="Save rules" okButtonProps={{ disabled: !canEdit, loading: busy }} onOk={save} onCancel={onClose} destroyOnHidden>
      {!canEdit && <div className="re-notice re-notice--info">Only lab admins can change these rules.</div>}
      {row('Auto-verify analyser results', 'Results fed by an analyser that pass every rule below are approved as "Auto verified". Manual entries are never auto-verified.', <Switch checked={cfg.enabled} disabled={!canEdit} onChange={(v) => set({ enabled: v })} aria-label="Auto-verify analyser results" />)}
      {row('Review sample', 'Share of passing results still sent to a person for quality review.', <InputNumber min={0} max={100} addonAfter="%" disabled={!canEdit} value={cfg.samplingPct} onChange={(v) => set({ samplingPct: v ?? 0 })} aria-label="Review sample percent" />)}
      {row('Abnormal results need a person', 'A value outside its reference range is not auto-verified. Critical values never are.', <Switch checked={cfg.blockAbnormal} disabled={!canEdit} onChange={(v) => set({ blockAbnormal: v })} aria-label="Abnormal results need a person" />)}
      {row('Delta check', 'A large change from the patient’s previous result (limits and look-back window from Report Entry settings) needs a person.', <Switch checked={cfg.useDeltaCheck} disabled={!canEdit} onChange={(v) => set({ useDeltaCheck: v })} aria-label="Delta check" />)}
      {row('Quality control in control', 'A failed latest QC run on the analyser blocks auto-verification.', <Switch checked={cfg.requireQcInControl} disabled={!canEdit} onChange={(v) => set({ requireQcInControl: v })} aria-label="QC in control" />)}
      <div className="re-field">
        <label htmlFor="av-excl">Tests that always need a person</label>
        <Select id="av-excl" mode="multiple" allowClear disabled={!canEdit} optionFilterProp="label" value={cfg.excludedTestIds} onChange={(v) => set({ excludedTestIds: v })} options={maps.tests.map((t) => ({ value: t.id, label: t.name }))} placeholder="None" />
      </div>
      <div className="re-field">
        <label htmlFor="av-sig">Signature on auto-verified reports</label>
        <Select id="av-sig" disabled={!canEdit} value={cfg.signatureMode} onChange={(v) => set({ signatureMode: v })} options={[{ value: 'defaultSignatory', label: 'Use the default signatory' }, { value: 'none', label: 'No signature' }]} />
      </div>
      <p className="wl-muted">Rules version {settings.autoVerify?.version ?? 0}. Each auto-verified result records the version that approved it.</p>
    </Modal>
  )
}
