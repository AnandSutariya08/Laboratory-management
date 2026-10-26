import { Table } from 'antd'
import { orderBy, limit, query } from 'firebase/firestore'
import dayjs from 'dayjs'
import { Card } from '../../design/Card'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { col, docRef } from '../../lib/db'
import { usePaymentConfig } from '../../lib/payments'
import { formatINR } from '../../lib/money'
import PayOnlineButton from './PayOnlineButton'

interface LedgerRow { id: string; type: string; credits: number; balanceAfter: number; amount?: number; paymentId?: string; byName?: string; at?: { toDate?: () => Date } }

// Credit wallet: balance, ledger and purchase of credit packs through the payment gateway. The balance and ledger
// are written by the server only. Mount this where the lab manages credits (Settings); it needs settings.manage.
export default function CreditWallet() {
  const cfg = usePaymentConfig()
  const wallet = useLiveDoc<{ balance: number }>(docRef('aiCredits', 'wallet'), []).data
  const ledger = useLiveQuery<LedgerRow>(query(col('aiCreditLedger'), orderBy('at', 'desc'), limit(50)), []).data
  return (
    <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
      <Card padding={16}>
        <h3 style={{ marginTop: 0 }}>Credit balance: {wallet?.balance ?? 0}</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {(cfg?.packs ?? []).map((p) => (
            <Card key={p.id} padding={12}>
              <b>{p.credits} credits</b>
              <div>{formatINR(p.amount)}</div>
              <PayOnlineButton input={{ purpose: 'credits', packId: p.id }} label="Buy" />
            </Card>
          ))}
          {cfg && !cfg.configured && <span>Online payment is not set up, so credits cannot be bought yet.</span>}
        </div>
      </Card>
      <Card padding={0}>
        <Table<LedgerRow> size="small" rowKey="id" dataSource={ledger} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'No credit movements yet' }}
          columns={[
            { title: 'Date', render: (_, r) => (r.at?.toDate ? dayjs(r.at.toDate()).format('DD MMM YYYY HH:mm') : '') },
            { title: 'Type', dataIndex: 'type' },
            { title: 'Credits', align: 'right', dataIndex: 'credits' },
            { title: 'Balance', align: 'right', dataIndex: 'balanceAfter' },
            { title: 'Paid', align: 'right', render: (_, r) => (r.amount ? formatINR(r.amount) : '') },
            { title: 'Reference', dataIndex: 'paymentId' },
          ]} />
      </Card>
    </div>
  )
}
