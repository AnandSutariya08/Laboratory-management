import { useCallback, useMemo, useState } from 'react'
import { App, Checkbox, Input, InputNumber, Select } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { b2bPriceListDisabled, strictPartnerPricing } from '../../features/settings/lib'
import { availableInBranch, packageAppliesTo, testsForSpecies } from '../../pages/catalogue/behaviour'
import { activeBranchId } from '../../lib/activeBranch'
import { inactivePackageMembers, lineIsBillingOnly } from '../../pages/catalogue/flags'
import { listPrices, resolvePrice } from '../../features/partners/lib/pricing'
import { catalogueLine, chargeLine } from '../../lib/billing'
import { primaryRateLists, rateListsFor, useMasters, type PartnerContext } from '../../lib/masters'
import { formatINR, toPaise } from '../../lib/money'
import type { OrderItem, Paise } from '../../types'

// Price resolution for the selected partners: first rate list with an entry wins, else MRP.
export function useLinePricer(ctx: PartnerContext) {
  const cat = useCatalogueMaps()
  const masters = useMasters()
  const settings = useLabSettings()
  // Settings > B2B price list disabled: a B2B centre is billed at MRP, its rate lists are not applied.
  const mrpOnly = b2bPriceListDisabled(settings) && !!ctx.b2bCentreId
  const lists = useMemo(
    () => (mrpOnly ? [] : rateListsFor(ctx, masters, settings.registration.autoRateList)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.rateListId, ctx.b2bCentreId, ctx.collectionCentreId, ctx.corporateClientId, ctx.govPanelId, ctx.tpaId, ctx.referrerId, ctx.hospitalId, ctx.secondReferrerId, masters, settings.registration.autoRateList, mrpOnly],
  )
  const basePrice = useCallback(
    (kind: 'test' | 'package', id: string): Paise | null =>
      (kind === 'test' ? cat.testById.get(id)?.price : cat.packageById.get(id)?.price) ?? null,
    [cat.testById, cat.packageById],
  )
  const priceOf = useCallback(
    (kind: 'test' | 'package', id: string): Paise | null => {
      const base = basePrice(kind, id)
      return base === null ? null : resolvePrice(id, base, lists)
    },
    [basePrice, lists],
  )
  // Re-price catalogue lines (skipping charge lines and any line ids in `keep`, e.g. manual overrides).
  const reprice = useCallback(
    (items: OrderItem[], keep: Set<string> = new Set()): OrderItem[] =>
      items.map((i) => {
        if (i.isCharge || keep.has(i.lineId)) return i
        const unit = priceOf(i.kind, i.refId)
        const p = unit === null ? null : unit * (i.qty ?? 1)
        return p === null || p === i.price ? i : { ...i, price: p, listPrice: unit ?? p, discount: 0 }
      }),
    [priceOf],
  )
  const makeLine = useCallback(
    (value: string): OrderItem | null => {
      const [kind, id] = value.split(':')
      if (kind === 'charge') {
        const c = masters.otherCharges.find((x) => x.id === id)
        return c ? chargeLine(c.id, c.name, c.price, c.showOnBill !== false) : null
      }
      if (kind === 'test') {
        const t = cat.testById.get(id)
        return t ? catalogueLine('test', t.id, t.code, t.name, priceOf('test', id) ?? t.price, [t.id], t.tatMinutes, { onlyBilling: t.onlyBilling, departmentId: t.departmentId }) : null
      }
      const p = cat.packageById.get(id)
      return p ? catalogueLine('package', p.id, p.code, p.name, priceOf('package', id) ?? p.price, p.testIds, undefined, { onlyBilling: lineIsBillingOnly({}, p.testIds.map((x) => cat.testById.get(x))) }) : null
    },
    [cat.testById, cat.packageById, masters.otherCharges, priceOf],
  )
  // Lab Settings > strict partner pricing: with an active partner rate list in play, an item that
  // list(s) do not price cannot be billed (instead of silently falling back to MRP).
  // Primary lists (parents aside) that block unlisted items: the per-list policy, or the lab-wide strict switch.
  const primary = useMemo(
    () => (mrpOnly ? [] : primaryRateLists(ctx, masters, settings.registration.autoRateList).filter((l) => l.active !== false)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.rateListId, ctx.b2bCentreId, ctx.collectionCentreId, ctx.corporateClientId, ctx.govPanelId, ctx.tpaId, ctx.referrerId, ctx.hospitalId, ctx.secondReferrerId, masters, settings.registration.autoRateList, mrpOnly],
  )
  const isUnlisted = useCallback(
    (refId: string): boolean => {
      if (!primary.length) return false
      // lab-wide strict switch: blocked when none of the partner lists (through their parents) prices the item
      if (strictPartnerPricing(settings) && !primary.some((l) => l.missingPolicy === 'mrp' || listPrices(l, refId, masters.rateListById))) return true
      // per-list policy 'block'
      return primary.some((l) => l.missingPolicy === 'block' && !listPrices(l, refId, masters.rateListById))
    },
    [settings, primary, masters.rateListById],
  )
  // Items priced from a parent list (not the list picked itself): shown as a fallback flag on the bill line.
  const fallbackOf = useCallback(
    (refId: string): { listName: string; fromParent: boolean; mrp: boolean } | null => {
      const first = primary[0]
      if (!first) return null
      if (typeof first.entries?.[refId] === 'number') return null
      const parent = listPrices(first, refId, masters.rateListById)
      return { listName: first.name, fromParent: parent, mrp: !parent }
    },
    [primary, masters.rateListById],
  )
  const rateListIds = useMemo(() => lists.filter((l): l is NonNullable<typeof l> => !!l).map((l) => l.id), [lists])
  return { priceOf, reprice, makeLine, cat, rateListIds, isUnlisted, fallbackOf }
}

type Tab = 'items' | 'charges'
type Kind = 'all' | 'test' | 'package'

// Search box with a Tests/Packages vs Other Charges toggle and a type filter.
export function ItemPicker({
  ctx,
  onPick,
  allowCharges = true,
  hidePrice = false,
  gender,
  species,
  branchId,
}: {
  ctx: PartnerContext
  onPick: (line: OrderItem) => void
  allowCharges?: boolean
  hidePrice?: boolean // B2B flag "hide B2B rate": option labels show no price
  gender?: string // package gender restriction
  species?: string // veterinary: tests limited to a species
  branchId?: string // defaults to the active branch
}) {
  const branch = branchId ?? activeBranchId()
  const { priceOf, makeLine, cat } = useLinePricer(ctx)
  const { otherCharges } = useMasters()
  const { modal } = App.useApp()
  const [tab, setTab] = useState<Tab>('items')
  const [kind, setKind] = useState<Kind>('all')

  const groups = useMemo(() => {
    const out: { label: string; options: { value: string; label: string; text: string }[] }[] = []
    if (kind !== 'package')
      out.push({
        label: 'Tests',
        options: testsForSpecies(cat.tests, species)
          .filter((t) => !t.disabled && availableInBranch(t, branch))
          .map((t) => ({ value: `test:${t.id}`, label: hidePrice ? `${t.code} · ${t.name}` : `${t.code} · ${t.name} · ${formatINR(priceOf('test', t.id) ?? t.price)}`, text: `${t.code} ${t.name}` })),
      })
    if (kind !== 'test')
      out.push({
        label: 'Packages',
        options: cat.packages
          .filter((p) => !p.disabled && availableInBranch(p as { branchIds?: string[] }, branch) && packageAppliesTo(p as never, gender))
          .map((p) => ({ value: `package:${p.id}`, label: hidePrice ? `${p.code} · ${p.name}` : `${p.code} · ${p.name} · ${formatINR(priceOf('package', p.id) ?? p.price)}`, text: `${p.code} ${p.name}` })),
      })
    return out
  }, [cat.tests, cat.packages, kind, priceOf, hidePrice, species, gender, branch])

  const [cName, setCName] = useState('')
  const [cAmt, setCAmt] = useState<number | null>(null)
  const [cShow, setCShow] = useState(true)
  const addCustom = () => {
    const name = cName.trim()
    if (!name || !cAmt || cAmt <= 0) return
    onPick(chargeLine(`custom-${crypto.randomUUID()}`, name, toPaise(cAmt), cShow))
    setCName('')
    setCAmt(null)
  }

  const chargeOptions = otherCharges.map((c) => ({ value: `charge:${c.id}`, label: `${c.name} · ${formatINR(c.price)}`, text: c.name }))

  return (
    <div className="bill-picker">
      <div className="bill-picker__bar">
        {allowCharges && (
          <Segmented<Tab>
            size="small"
            aria-label="Item source"
            value={tab}
            onChange={setTab}
            options={[{ value: 'items', label: 'Tests / Packages' }, { value: 'charges', label: 'Other charges' }]}
          />
        )}
        {tab === 'items' && (
          <Segmented<Kind>
            size="small"
            aria-label="Type filter"
            value={kind}
            onChange={setKind}
            options={[{ value: 'all', label: 'All' }, { value: 'test', label: 'Tests' }, { value: 'package', label: 'Packages' }]}
          />
        )}
      </div>
      <Select<string | null>
        showSearch
        value={null}
        aria-label="Search items"
        placeholder={tab === 'items' ? 'Search tests or packages by name or code' : 'Pick a charge (home collection, urgent fee...)'}
        style={{ width: '100%' }}
        options={tab === 'items' ? groups : chargeOptions}
        filterOption={(input, opt) => ((opt as { text?: string })?.text ?? '').toLowerCase().includes(input.toLowerCase())}
        onSelect={(v) => {
          const line = v ? makeLine(v) : null
          if (!line) return
          // A package with disabled or deleted member tests: warn, and after confirmation leave those tests out.
          const bad = line.kind === 'package' && !line.isCharge ? inactivePackageMembers(line, cat.testById) : []
          if (!bad.length) return onPick(line)
          const badIds = new Set(bad.map((b) => b.id))
          modal.confirm({
            title: `${line.name} has ${bad.length} inactive test${bad.length > 1 ? 's' : ''}`,
            content: `${bad.map((b) => b.name + (b.missing ? ' (deleted)' : ' (disabled)')).join(', ')} will be left out of this bill. The package price stays the same.`,
            okText: 'Add without them',
            onOk: () => onPick({ ...line, testIds: line.testIds.filter((id) => !badIds.has(id)) }),
          })
        }}
        suffixIcon={<PlusOutlined />}
        notFoundContent={tab === 'charges' ? 'No other charges set up (Settings > Other charges)' : undefined}
      />
      {tab === 'charges' && (
        <div className="bill-row" style={{ marginTop: 6 }}>
          <Input aria-label="New charge name" placeholder="New charge (name)" style={{ width: 220 }} value={cName} onChange={(e) => setCName(e.target.value)} maxLength={80} />
          <InputNumber aria-label="New charge amount" addonBefore="₹" min={0} precision={2} style={{ width: 140 }} value={cAmt} onChange={setCAmt} />
          <Checkbox checked={cShow} onChange={(e) => setCShow(e.target.checked)}>Show on bill</Checkbox>
          <Button icon={<PlusOutlined />} onClick={addCustom}>Add charge</Button>
        </div>
      )}
    </div>
  )
}
