import { Card } from '../../../design/Card'
import { downloadCsv, ExportButton, rupees, type MasterDoc } from '../shared'
import { BASE_LABEL, PRESETS, buildRows, csvVal, commissionOf, type BaseTab, type Ctx } from './model'
import { resolveCols } from './RowsTable'
import BackgroundExports from './BackgroundExports'
import type { Range } from '../shared'

export default function ExportsTab({ ctx, labs, stamp, range }: { ctx: Ctx; labs: MasterDoc[]; stamp: string; range: Range }) {
  const exportBase = (b: BaseTab) => {
    const cols = resolveCols(PRESETS[b], labs)
    const rows = buildRows(b, ctx, labs)
    downloadCsv(`${b}-wise-${stamp}.csv`, [cols.map((c) => c.title), ...rows.map((r) => cols.map((c) => csvVal(c, c.get(r, ctx))))])
  }
  const exportAllCols = () => {
    const rows = buildRows('billing', ctx, labs)
    const keys = ['billDate', 'billId', 'patientId', 'patientInfo', 'contact', 'tests', 'referral', 'b2b', 'corporate', 'amount', 'discount', 'net', 'paid', 'due', 'refunded', 'cash', 'card', 'upi', 'wallet', 'otherMode', 'transactionId', 'paymentStatus', 'billedBy', 'commission']
    const cols = resolveCols(keys, labs)
    downloadCsv(`full-ledger-${stamp}.csv`, [cols.map((c) => c.title), ...rows.map((r) => cols.map((c) => csvVal(c, c.get(r, ctx))))])
  }
  const commission = () => {
    const m = new Map<string, number>()
    for (const o of ctx.orders) m.set(o.referrerName || 'Self', (m.get(o.referrerName || 'Self') ?? 0) + commissionOf(o, ctx))
    downloadCsv(`commission-${stamp}.csv`, [['Referrer', 'Commission'], ...Array.from(m).map(([k, v]) => [k, rupees(v)])])
  }
  const items: { title: string; desc: string; run: () => void }[] = [
    ...(Object.keys(BASE_LABEL) as BaseTab[]).map((b) => ({ title: BASE_LABEL[b], desc: 'Standard columns for the selected period.', run: () => exportBase(b) })),
    { title: 'Full billing and payment modes', desc: 'Every billing column including payment mode split.', run: exportAllCols },
    { title: 'Referral commission', desc: 'Commission per referrer.', run: commission },
  ]
  return (
    <div className="an-stack">
      <p className="an-note">Quick exports use the bills already loaded for these dates (up to 500 bills). For longer periods use Background exports below.</p>
      <div className="an-grid">
        {items.map((i) => (
          <Card key={i.title}>
            <h2 className="an-card-title">{i.title}</h2>
            <p className="an-note">{i.desc}</p>
            <ExportButton label={`Export ${i.title}`} onClick={i.run} disabled={!ctx.orders.length} />
          </Card>
        ))}
      </div>
      <BackgroundExports range={range} />
    </div>
  )
}
