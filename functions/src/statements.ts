import { getFirestore, FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { FIRESTORE_DB } from './secrets'

// Mass statements: an async job per request. The web app writes labs/{lab}/statementJobs/{id} with
// status 'queued'; this trigger builds the CSV (one section per party) and stores it in
// statementJobs/{id}/files/csv (Cloud Storage is not used). A failed job is retried by the app setting
// status back to 'queued'.

const REGION = 'asia-south1'
const MAX_CSV = 900_000 // Firestore documents are limited to 1 MiB

type Kind = 'referral' | 'b2b' | 'corporate'
type Type = 'billing' | 'collection' | 'test'

const partyOf = (o: DocumentData, kind: Kind): string => {
  const v = kind === 'referral' ? o.referrerName : kind === 'b2b' ? o.b2bCentreName : o.corporateClientName
  const s = String(v ?? '').trim()
  return kind === 'referral' && s.toLowerCase() === 'self' ? '' : s
}
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
const rs = (paise: number) => (Math.round(Number(paise) || 0) / 100).toFixed(2)
const day = (t: unknown) => {
  const ms = (t as { toMillis?: () => number } | undefined)?.toMillis?.()
  return ms == null ? '' : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(ms))
}

async function build(labId: string, job: DocumentData): Promise<string> {
  const db = getFirestore(FIRESTORE_DB)
  const kind = (job.kind as Kind) ?? 'referral'
  const type = (job.type as Type) ?? 'billing'
  const from = Timestamp.fromMillis(Number(job.from))
  const to = Timestamp.fromMillis(Number(job.to))
  const branchId = typeof job.branchId === 'string' && job.branchId ? job.branchId : ''
  const only = typeof job.party === 'string' ? job.party.trim().toLowerCase() : ''

  const orderRows: { id: string; o: DocumentData }[] = []
  if (type === 'collection') {
    // by payment date: ledger entries posted in the period, then their bills
    let q = db.collectionGroup('ledger').where('postedAt', '>=', from).where('postedAt', '<=', to)
    if (branchId) q = q.where('branchId', '==', branchId)
    const entries = await q.get()
    const byOrder = new Map<string, DocumentData[]>()
    for (const e of entries.docs) {
      if (!e.ref.path.startsWith(`labs/${labId}/`)) continue
      const oid = e.ref.parent.parent?.id
      if (oid) byOrder.set(oid, [...(byOrder.get(oid) ?? []), e.data()])
    }
    const header = ['Party', 'Collection date', 'Bill', 'Patient', 'Entry', 'Mode', 'Amount (Rs)', 'Reference']
    const rows: string[][] = []
    for (const [oid, es] of byOrder) {
      const snap = await db.doc(`labs/${labId}/orders/${oid}`).get()
      const o = snap.data()
      if (!o || o.deleted) continue
      const party = partyOf(o, kind)
      if (!party || (only && party.toLowerCase() !== only)) continue
      for (const e of es) rows.push([party, day(e.postedAt), o.billNo, o.patientName, e.type, e.mode, rs(e.amount), e.reference ?? ''])
    }
    rows.sort((a, b) => a[0].localeCompare(b[0]))
    return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
  }

  let oq = db.collection(`labs/${labId}/orders`).where('deleted', '==', false).where('createdAt', '>=', from).where('createdAt', '<=', to)
  if (branchId) oq = oq.where('branchId', '==', branchId)
  const snap = await oq.get()
  for (const d of snap.docs) orderRows.push({ id: d.id, o: d.data() })

  const rows: string[][] = []
  let header: string[]
  if (type === 'billing') {
    header = ['Party', 'Bill date', 'Bill', 'Patient', 'Tests', 'Referral doctor', 'Gross (Rs)', 'Discount (Rs)', 'Net (Rs)', 'Paid (Rs)', 'Due (Rs)']
    for (const { o } of orderRows) {
      const party = partyOf(o, kind)
      if (!party || (only && party.toLowerCase() !== only)) continue
      const tests = ((o.items ?? []) as DocumentData[]).filter((i) => i.status !== 'refunded').map((i) => i.name).join('; ')
      rows.push([party, day(o.createdAt), o.billNo, o.patientName, tests, o.referrerName ?? '', rs(o.gross), rs(o.discount), rs(o.net), rs(o.paid), rs(o.due)])
    }
  } else {
    header = ['Party', 'Bill date', 'Bill', 'Patient', 'Test / package', 'Amount (Rs)', 'Discount (Rs)', 'Net (Rs)']
    for (const { o } of orderRows) {
      const party = partyOf(o, kind)
      if (!party || (only && party.toLowerCase() !== only)) continue
      for (const i of ((o.items ?? []) as DocumentData[]).filter((x) => x.status !== 'refunded' && !x.isCharge))
        rows.push([party, day(o.createdAt), o.billNo, o.patientName, i.name, rs(i.price), rs(i.discount), rs(i.price - i.discount)])
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
}

export const processStatementJob = onDocumentWritten(
  { document: 'labs/{labId}/statementJobs/{jobId}', database: FIRESTORE_DB, region: REGION, timeoutSeconds: 540, memory: '512MiB' },
  async (event) => {
    const after = event.data?.after
    if (!after?.exists) return
    const job = after.data() as DocumentData
    const before = event.data?.before.data() as DocumentData | undefined
    // run on creation and on retry (status set back to queued)
    if (job.status !== 'queued' || before?.status === 'queued') return
    const { labId, jobId } = event.params
    const ref = after.ref
    const started = Date.now()
    await ref.update({ status: 'processing', startedAt: FieldValue.serverTimestamp(), error: '' })
    try {
      const csv = await build(labId, job)
      if (csv.length > MAX_CSV) throw new Error('The statement is too large for one file. Request a shorter period or a single party.')
      await getFirestore(FIRESTORE_DB).doc(`labs/${labId}/statementJobs/${jobId}/files/csv`).set({ csv, bytes: csv.length })
      await ref.update({ status: 'completed', completedAt: FieldValue.serverTimestamp(), tookMs: Date.now() - started, rows: Math.max(0, csv.split('\n').length - 1) })
    } catch (e) {
      await ref.update({ status: 'failed', completedAt: FieldValue.serverTimestamp(), tookMs: Date.now() - started, error: (e as Error).message.slice(0, 300) })
    }
  },
)
