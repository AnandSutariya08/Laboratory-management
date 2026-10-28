import { Select } from 'antd'
import { FEATURE_LABELS, featureEnabled } from '../lib'
import { bind, Field, SectionCard, SwitchRow, useDraft } from '../ui'

const IV = bind('inventory')

// Lab Settings > Lab features: per-lab module switches (hide menus and block routes).
export function LabFeatures() {
  const { draft, set } = useDraft()
  return (
    <SectionCard title="Lab features" description="Switch modules off to hide them from the menu and block their pages for everyone in this lab.">
      {FEATURE_LABELS.map((f) => (
        <SwitchRow
          key={f.key}
          title={f.label}
          description={f.description}
          checked={featureEnabled(draft, f.key)}
          onChange={(v) => set(['features', f.key], v)}
        />
      ))}
    </SectionCard>
  )
}

export function InventorySettings() {
  const { draft, set } = useDraft()
  return (
    <>
      <SectionCard title="Inventory">
        <div className="st-grid">
          <IV.Sel
            f="consumeOn"
            label="Deduct mapped consumables when"
            hint="Outsourced and billing-only tests never consume stock. Refunds and voids restore it."
            options={[{ value: 'receipt', label: 'Sample is received' }, { value: 'billing', label: 'Bill is created' }]}
          />
        </div>
      </SectionCard>
      <SectionCard title="Partner pricing">
        <SwitchRow
          title="Strict partner pricing"
          description="When a partner rate list has no price for a test, block the line instead of falling back to the MRP."
          checked={draft.strictPartnerPricing === true}
          onChange={(v) => set(['strictPartnerPricing'], v)}
        />
        <div className="st-grid">
          <Field label="Commission basis is set under Referrals"><Select disabled value={draft.referrals.commissionBasis} options={[{ value: draft.referrals.commissionBasis, label: draft.referrals.commissionBasis }]} /></Field>
        </div>
      </SectionCard>
    </>
  )
}
