import { useEffect, useState } from 'react'
import { App, InputNumber, Modal, Select, Switch } from 'antd'
import { setDoc } from 'firebase/firestore'
import { labDoc } from '../../lib/db'
import { useLabSettings, useCatalogueMaps } from '../../hooks/useCatalogue'
import { dialogWidth } from '../../design/dialog'
import { FormSection, SettingRow } from '../../design/FormLayout'
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
  return (
    <Modal open={open} title="Auto-verification rules" width={dialogWidth(620)} okText="Save rules" okButtonProps={{ disabled: !canEdit, loading: busy }} onOk={save} onCancel={onClose} destroyOnHidden>
      {!canEdit && <div className="re-notice re-notice--info">Only lab admins can change these rules.</div>}
      <FormSection title="Auto-verification" description="Results fed by an analyser that pass every rule below are approved as Auto verified. Manual entries are never auto-verified.">
        <SettingRow label="Auto-verify analyser results" help="Turn the whole rule set on or off.">
          <Switch checked={cfg.enabled} disabled={!canEdit} onChange={(v) => set({ enabled: v })} aria-label="Auto-verify analyser results" />
        </SettingRow>
        <SettingRow label="Review sample" help="Share of passing results still sent to a person for quality review." htmlFor="av-pct">
          <InputNumber id="av-pct" min={0} max={100} addonAfter="%" disabled={!canEdit} value={cfg.samplingPct} onChange={(v) => set({ samplingPct: v ?? 0 })} aria-label="Review sample percent" />
        </SettingRow>
      </FormSection>
      <FormSection title="Rules that need a person" description="Any of these stops a result from being approved automatically.">
        <SettingRow label="Abnormal results" help="A value outside its reference range is not auto-verified. Critical values never are.">
          <Switch checked={cfg.blockAbnormal} disabled={!canEdit} onChange={(v) => set({ blockAbnormal: v })} aria-label="Abnormal results need a person" />
        </SettingRow>
        <SettingRow label="Delta check" help="A large change from the patient’s previous result (limits and look-back from Report Entry settings).">
          <Switch checked={cfg.useDeltaCheck} disabled={!canEdit} onChange={(v) => set({ useDeltaCheck: v })} aria-label="Delta check" />
        </SettingRow>
        <SettingRow label="Quality control in control" help="A failed latest QC run on the analyser blocks auto-verification.">
          <Switch checked={cfg.requireQcInControl} disabled={!canEdit} onChange={(v) => set({ requireQcInControl: v })} aria-label="QC in control" />
        </SettingRow>
        <SettingRow label="Tests that always need a person" help="These tests are never auto-verified." htmlFor="av-excl" align="start">
          <Select id="av-excl" mode="multiple" allowClear disabled={!canEdit} optionFilterProp="label" value={cfg.excludedTestIds} onChange={(v) => set({ excludedTestIds: v })} options={maps.tests.map((t) => ({ value: t.id, label: t.name }))} placeholder="None" style={{ width: '100%' }} />
        </SettingRow>
      </FormSection>
      <FormSection title="Report">
        <SettingRow label="Signature on auto-verified reports" htmlFor="av-sig">
          <Select id="av-sig" disabled={!canEdit} value={cfg.signatureMode} onChange={(v) => set({ signatureMode: v })} options={[{ value: 'defaultSignatory', label: 'Use the default signatory' }, { value: 'none', label: 'No signature' }]} style={{ minWidth: 220 }} />
        </SettingRow>
      </FormSection>
      <p className="wl-muted">Rules version {settings.autoVerify?.version ?? 0}. Each auto-verified result records the version that approved it.</p>
    </Modal>
  )
}
