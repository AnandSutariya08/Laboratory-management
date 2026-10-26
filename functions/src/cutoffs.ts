import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { FIRESTORE_DB } from './secrets'

// Automatic "Not received": every hour, a sample line that is still waiting (pending, or in transit from a
// collection centre) longer than accession.notReceivedAfterHours (default 0 = off, as in Flabs) is marked Not received,
// the same state the Not Received tab shows for manual marking. Lines already marked are left alone.
export const notReceivedSweep = onSchedule(
  { schedule: 'every 60 minutes', region: 'asia-south1', timeZone: 'Asia/Kolkata' },
  async () => {
    if (!getApps().length) initializeApp()
    const db = getFirestore(FIRESTORE_DB)
    const labs = await db.collection('labs').get()
    const now = Date.now()
    for (const lab of labs.docs) {
      try {
        const raw = Number((lab.data().accession ?? {}).notReceivedAfterHours)
        const hours = Number.isFinite(raw) && raw >= 0 ? raw : 0
        if (hours === 0) continue
        const cutoff = now - hours * 3_600_000
        // Look back two weeks; older bills are not swept.
        const snap = await db
          .collection(`labs/${lab.id}/orders`)
          .where('createdAt', '>=', Timestamp.fromMillis(now - 14 * 86_400_000))
          .where('createdAt', '<=', Timestamp.fromMillis(cutoff))
          .get()
        for (const d of snap.docs) {
          const o = d.data()
          if (o.deleted) continue
          const base = Math.max(o.createdAt?.toMillis?.() ?? 0, o.collectionDateTime?.toMillis?.() ?? 0)
          if (base > cutoff) continue
          let changed = 0
          const items = ((o.items ?? []) as DocumentData[]).map((i) => {
            const waiting = i.status === 'pending' && !i.notReceived && !i.isCharge && !i.onlyBilling && (i.testIds ?? []).length > 0 && !i.sentToLab
            const stuck = i.status === 'collected' && i.inTransit && (i.collectedAt?.toMillis?.() ?? base) <= cutoff
            if (!waiting && !stuck) return i
            changed++
            return {
              ...i,
              status: 'pending',
              notReceived: true,
              notReceivedAuto: true,
              inTransit: false,
              notReceivedReason: `Not received within ${hours} hours`,
              notReceivedAt: Timestamp.now(),
            }
          })
          if (!changed) continue
          await d.ref.update({ items })
          await db.collection(`labs/${lab.id}/activity`).add({
            type: 'accession.notReceived', category: 'OTHER', text: `${o.billNo ?? ''}: ${changed} sample line(s) marked not received automatically (${hours} h cut-off)`,
            refPath: `orders/${d.id}`, at: Timestamp.now(), by: 'system', byName: 'Auto sweep', branchId: o.branchId ?? 'main',
          })
        }
      } catch (e) {
        console.error('notReceivedSweep failed for lab', lab.id, e)
      }
    }
  },
)
