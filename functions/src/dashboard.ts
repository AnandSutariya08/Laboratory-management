import { getFirestore, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { REGION, FIRESTORE_DB } from './secrets'
import { bucketOfMode, dateBound, dayKey, live, ms, n, scanOrders, str, testCount, type Order } from './exports'

// Admin dashboard: one call returns everything the Dashboard page shows for a period and a set of branches.
//   money and volume for the period and the period before it (same length), per branch and per day
//   payments by the day they were taken (ledger), by mode
//   outstanding due (all time)
//   live work pipeline (open bills of the last 90 days), late / nearly late tests
//   alerts: unacknowledged critical results, rejected samples, failed report sends, QC failures, offline
//           analysers, unmatched machine results, low or expiring stock, voided bills, refunds
//   home collections in the period
// Only the lab admin and admin roles may call it.

const db = () => getFirestore(FIRESTORE_DB)
const DAY = 86_400_000
const ADMIN_ROLES = ['labAdmin', 'admin']
const OPEN_WINDOW = 90 * DAY
const MACHINE_ONLINE_MS = 3 * 60_000

interface Money { billed: number; gross: number; discount: number; bills: number; patients: Set<string>; tests: number; dueOnBills: number; final: number; delivered: number; rejected: number; collected: number; refunds: number }
const money = (): Money => ({ billed: 0, gross: 0, discount: 0, bills: 0, patients: new Set(), tests: 0, dueOnBills: 0, final: 0, delivered: 0, rejected: 0, collected: 0, refunds: 0 })
const out = (m: Money) => ({
  billed: m.billed, gross: m.gross, discount: m.discount, bills: m.bills, patients: m.patients.size, tests: m.tests, dueOnBills: m.dueOnBills,
  final: m.final, delivered: m.delivered, rejected: m.rejected, collected: m.collected, refunds: m.refunds,
  avgBill: m.bills ? Math.round(m.billed / m.bills) : 0,
})
type Alert = { key: string; level: 'urgent' | 'caution' | 'info'; title: string; count: number; detail: string; link: string; items?: { label: string; link: string }[] }

const branchOf = (o: DocumentData) => str(o.branchId) || 'main'

export const dashboardSummary = onCall({ region: REGION, timeoutSeconds: 300, memory: '1GiB' }, async (request) => {
  const d = (request.data ?? {}) as { labId?: unknown; from?: unknown; to?: unknown; branchIds?: unknown }
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
  const labId = str(d.labId)
  if (!labId || labId.includes('/')) throw new HttpsError('invalid-argument', 'labId is required.')
  const u = (await db().doc(`labs/${labId}/users/${request.auth.uid}`).get()).data()
  if (!u || u.active !== true || !ADMIN_ROLES.includes(str(u.role))) throw new HttpsError('permission-denied', 'The dashboard is for the lab admin.')

  // Branches the caller may see, narrowed to the ones asked for (none asked = all of them).
  const branchSnap = await db().collection(`labs/${labId}/branches`).get()
  const allBranches = branchSnap.docs.map((b) => ({ id: b.id, name: str(b.data().name) || b.id, active: b.data().active !== false }))
  if (!allBranches.some((b) => b.id === 'main')) allBranches.unshift({ id: 'main', name: 'Main branch', active: true })
  const mine = u.allBranches === true || u.role === 'labAdmin' ? allBranches : allBranches.filter((b) => (Array.isArray(u.branchIds) ? u.branchIds.map(String) : ['main']).includes(b.id))
  const asked = Array.isArray(d.branchIds) ? d.branchIds.map(String).filter(Boolean) : []
  const scope = asked.length ? mine.filter((b) => asked.includes(b.id)) : mine
  if (!scope.length) throw new HttpsError('permission-denied', 'You do not have access to those branches.')
  const inScope = new Set(scope.map((b) => b.id))
  const ok = (branch: string) => inScope.has(branch)

  const fromMs = dateBound(d.from, false)
  const toMs = dateBound(d.to, true)
  if (toMs <= fromMs) throw new HttpsError('invalid-argument', 'The end date must be on or after the start date.')
  if ((toMs - fromMs) / DAY > 400) throw new HttpsError('invalid-argument', 'The longest period is about a year.')
  const len = toMs - fromMs
  const prevFrom = fromMs - len
  const now = Date.now()
  const days = Math.round(len / DAY)

  const [labSnap, testSnap] = await Promise.all([db().doc(`labs/${labId}`).get(), db().collection(`labs/${labId}/tests`).get()])
  const settings = labSnap.data() ?? {}
  const tests = new Map(testSnap.docs.map((t) => [t.id, t.data()]))

  // ---- bills of the period and the period before ------------------------------------------------------------
  const cur = money()
  const prev = money()
  const perBranch = new Map<string, Money>(scope.map((b) => [b.id, money()]))
  const dayBilled = new Map<string, number>() // current period, by day
  const dayBilledPrev = new Map<string, number>() // previous period, keyed by the matching current day
  const branchDay = new Map<string, Map<string, number>>()
  const orderBranch = new Map<string, string>()
  const ingest = (o: Order, m: Money, perB: Money | undefined) => {
    for (const x of perB ? [m, perB] : [m]) {
      x.billed += n(o.net)
      x.gross += n(o.gross)
      x.discount += n(o.discount)
      x.bills++
      x.patients.add(str(o.patientId))
      x.tests += testCount(o)
      x.dueOnBills += n(o.due)
      if (o.reportStatus === 'final') x.final++
      if (o.dispatched === true) x.delivered++
      for (const i of live(o)) if (i.status === 'rejected') x.rejected += i.testIds?.length ?? 0
    }
  }
  await scanOrders(labId, fromMs, toMs, null, (o) => {
    const b = branchOf(o)
    orderBranch.set(o.id, b)
    if (!ok(b)) return
    ingest(o, cur, perBranch.get(b))
    const k = dayKey(ms(o.createdAt) ?? fromMs)
    dayBilled.set(k, (dayBilled.get(k) ?? 0) + n(o.net))
    const bd = branchDay.get(b) ?? new Map<string, number>()
    bd.set(k, (bd.get(k) ?? 0) + n(o.net))
    branchDay.set(b, bd)
  })
  await scanOrders(labId, prevFrom, fromMs, null, (o) => {
    const b = branchOf(o)
    orderBranch.set(o.id, b)
    if (!ok(b)) return
    ingest(o, prev, undefined)
    const k = dayKey((ms(o.createdAt) ?? prevFrom) + len)
    dayBilledPrev.set(k, (dayBilledPrev.get(k) ?? 0) + n(o.net))
  })

  // ---- money taken, by the day it was posted (any bill, old or new) ----------------------------------------
  const modes: Record<string, number> = {}
  const dayCollected = new Map<string, number>()
  const dayCollectedPrev = new Map<string, number>()
  let refundCount = 0
  const ledgerSnap = await db().collectionGroup('ledger').where('postedAt', '>=', Timestamp.fromMillis(prevFrom)).where('postedAt', '<', Timestamp.fromMillis(toMs)).get()
  const entries = ledgerSnap.docs
    .map((e) => ({ path: e.ref.path.split('/'), x: e.data() }))
    .filter((e) => e.path[0] === 'labs' && e.path[1] === labId && e.path[2] === 'orders')
  const missing = [...new Set(entries.map((e) => e.path[3]).filter((id) => !orderBranch.has(id)))]
  for (let i = 0; i < missing.length; i += 300) {
    const refs = missing.slice(i, i + 300).map((id) => db().doc(`labs/${labId}/orders/${id}`))
    const docs = await db().getAll(...refs, { fieldMask: ['branchId'] })
    docs.forEach((s) => orderBranch.set(s.id, branchOf(s.data() ?? {})))
  }
  for (const e of entries) {
    const b = orderBranch.get(e.path[3]) ?? 'main'
    if (!ok(b)) continue
    const amount = n(e.x.amount)
    const at = ms(e.x.postedAt) ?? 0
    const isCur = at >= fromMs
    const m = isCur ? cur : prev
    m.collected += amount
    if (str(e.x.type) === 'refund') {
      m.refunds += -amount
      if (isCur) refundCount++
    }
    if (isCur) {
      const pb = perBranch.get(b)
      if (pb) pb.collected += amount
      if (amount > 0 || str(e.x.type) === 'reversal') modes[bucketOfMode(str(e.x.mode))] = (modes[bucketOfMode(str(e.x.mode))] ?? 0) + amount
      const k = dayKey(at)
      dayCollected.set(k, (dayCollected.get(k) ?? 0) + amount)
    } else {
      const k = dayKey(at + len)
      dayCollectedPrev.set(k, (dayCollectedPrev.get(k) ?? 0) + amount)
    }
  }

  // ---- outstanding due, all time ---------------------------------------------------------------------------
  const dueByBranch = new Map<string, { amount: number; bills: number }>()
  const dueSnap = await db().collection(`labs/${labId}/orders`).where('due', '>', 0).select('due', 'branchId', 'deleted').get()
  for (const s of dueSnap.docs) {
    const o = s.data()
    if (o.deleted === true || !ok(branchOf(o))) continue
    const r = dueByBranch.get(branchOf(o)) ?? { amount: 0, bills: 0 }
    r.amount += n(o.due)
    r.bills++
    dueByBranch.set(branchOf(o), r)
  }
  const outstanding = [...dueByBranch.values()].reduce((a, r) => ({ amount: a.amount + r.amount, bills: a.bills + r.bills }), { amount: 0, bills: 0 })

  // ---- live pipeline: open work of the last 90 days --------------------------------------------------------
  const cutoff = Timestamp.fromMillis(now - OPEN_WINDOW)
  const PIPE_FIELDS = ['billNo', 'patientName', 'items', 'reportStatus', 'dispatched', 'deleted', 'branchId', 'createdAt', 'collectedAt', 'receivedAt']
  const [openSnap, readySnap] = await Promise.all([
    db().collection(`labs/${labId}/orders`).where('reportStatus', 'in', ['pending', 'partial', 'provisional']).where('createdAt', '>=', cutoff).select(...PIPE_FIELDS).get(),
    db().collection(`labs/${labId}/orders`).where('reportStatus', '==', 'final').where('dispatched', '==', false).where('createdAt', '>=', cutoff).select(...PIPE_FIELDS).get(),
  ])
  const accessionOn = (settings.accession as DocumentData | undefined)?.enabled !== false
  const pipe = { toCollect: 0, collected: 0, inLab: 0, waitingApproval: 0, hold: 0, readyToSend: 0 }
  const pipeByBranch = new Map<string, number>()
  const tat = settings.tat as DocumentData | undefined
  const clock = tat?.clockStart === 'collection' ? 'collection' : tat?.clockStart === 'receipt' ? 'receipt' : accessionOn ? 'receipt' : 'registration'
  const nearbyPct = n(tat?.nearbyThresholdPercent) || 80
  const urgentPct = n(tat?.urgentTatPercent) || 50
  const late: { label: string; link: string; over: number }[] = []
  let nearly = 0
  let lateCount = 0
  const lateByBranch = new Map<string, number>()
  for (const s of openSnap.docs) {
    const o = s.data()
    const b = branchOf(o)
    if (o.deleted === true || !ok(b)) continue
    let open = 0
    for (const i of (o.items ?? []) as DocumentData[]) {
      if (i.status === 'refunded' || i.isCharge || !Array.isArray(i.testIds) || !i.testIds.length) continue
      const c = i.testIds.length
      if (i.status === 'pending') accessionOn ? (pipe.toCollect += c) : (pipe.inLab += c)
      else if (i.status === 'collected') pipe.collected += c
      else if (i.status === 'received') pipe.inLab += c
      else if (i.status === 'entered') pipe.waitingApproval += c
      else if (i.status === 'hold') pipe.hold += c
      if (['pending', 'collected', 'received', 'entered'].includes(i.status)) open += c
      // Turnaround: tests not approved yet, against the test's TAT (the TAT page's rule; hold time not taken off).
      if (!['pending', 'collected', 'received', 'entered'].includes(i.status)) continue
      const created = ms(o.createdAt)
      const start = clock === 'registration' ? created : clock === 'collection' ? (ms(o.collectedAt) ?? created) : ms(o.receivedAt)
      if (start == null) continue
      for (const tid of i.testIds as string[]) {
        const t = tests.get(tid)
        const base = typeof t?.tatMinutes === 'number' ? t.tatMinutes : null
        const total = i.urgent ? (typeof t?.urgentTatMinutes === 'number' ? t.urgentTatMinutes : base != null ? Math.round((base * urgentPct) / 100) : null) : base
        if (total == null || total <= 0) continue
        const pre = clock === 'receipt' ? Math.min(Math.max(0, n(t?.preAnalyticalTatMinutes)), total - 1) : 0
        const expected = total - pre
        const actual = Math.round((now - start) / 60_000)
        if (actual > expected) {
          lateCount++
          lateByBranch.set(b, (lateByBranch.get(b) ?? 0) + 1)
          late.push({ label: `${str(o.billNo)} ${str(o.patientName)}: ${str(t?.name) || str(i.name)}`, link: `/results/${s.id}`, over: actual - expected })
        } else if (actual >= (expected * nearbyPct) / 100) nearly++
      }
    }
    if (open) pipeByBranch.set(b, (pipeByBranch.get(b) ?? 0) + 1)
  }
  for (const s of readySnap.docs) {
    const o = s.data()
    if (o.deleted === true || !ok(branchOf(o))) continue
    pipe.readyToSend++
  }

  // ---- alerts ----------------------------------------------------------------------------------------------
  const alerts: Alert[] = []
  const since = Timestamp.fromMillis(fromMs)
  const until = Timestamp.fromMillis(toMs)

  // Critical results not acknowledged (raised in the last 7 days or in the period).
  const critSince = Timestamp.fromMillis(Math.min(fromMs, now - 7 * DAY))
  const critSnap = await db().collection(`labs/${labId}/activity`).where('at', '>=', critSince).get()
  const critOrders = [...new Set(critSnap.docs.filter((a) => a.data().type === 'critical' && ok(str(a.data().branchId) || 'main')).map((a) => str(a.data().refPath).split('/')[3]).filter(Boolean))].slice(0, 100)
  const unacked: { label: string; link: string }[] = []
  for (const oid of critOrders) {
    const rs = await db().collection(`labs/${labId}/orders/${oid}/results`).get()
    for (const r of rs.docs) {
      const x = r.data()
      const crit = Object.values((x.values ?? {}) as Record<string, DocumentData>).some((v) => v?.critical === true)
      if (crit && !x.criticalAck) unacked.push({ label: `${str(x.testName) || r.id}`, link: `/results/${oid}` })
    }
  }
  if (unacked.length) alerts.push({ key: 'critical', level: 'urgent', title: 'Critical results not acknowledged', count: unacked.length, detail: 'A doctor or technician must confirm the critical value was communicated.', link: '/worklist', items: unacked.slice(0, 5) })

  if (lateCount) alerts.push({ key: 'late', level: 'urgent', title: 'Reports past their promised time', count: lateCount, detail: `${lateCount} test(s) are late${nearly ? `, and ${nearly} more will be late soon` : ''}.`, link: '/tat', items: late.sort((a, b) => b.over - a.over).slice(0, 5).map(({ label, link, over }) => ({ label: `${label} (${over >= 60 ? `${Math.round(over / 60)} h` : `${over} min`} late)`, link })) })
  else if (nearly) alerts.push({ key: 'nearly', level: 'caution', title: 'Reports close to their promised time', count: nearly, detail: 'These tests are not late yet but will be soon.', link: '/tat' })

  if (cur.rejected) alerts.push({ key: 'rejected', level: 'caution', title: 'Samples rejected', count: cur.rejected, detail: 'Tests rejected in this period. The patient may need a new sample.', link: '/accession' })

  const delSnap = await db().collectionGroup('deliveries').where('at', '>=', since).where('at', '<', until).get()
  const failed = delSnap.docs.filter((x) => {
    const p = x.ref.path.split('/')
    return p[1] === labId && x.data().status === 'failed' && ok(orderBranch.get(p[3]) ?? 'main')
  })
  if (failed.length) alerts.push({ key: 'sendFailed', level: 'caution', title: 'Reports that failed to send', count: failed.length, detail: 'WhatsApp, SMS or email sends that did not go through. Retry from Pending Dispatch.', link: '/dispatch' })

  const qcSnap = await db().collection(`labs/${labId}/qcRuns`).where('runAt', '>=', since).where('runAt', '<', until).get()
  const qcFails = qcSnap.docs.filter((x) => x.data().deleted !== true && x.data().status === 'fail' && ok(str(x.data().branchId) || 'main'))
  if (qcFails.length) alerts.push({ key: 'qc', level: 'urgent', title: 'QC runs failed', count: qcFails.length, detail: 'Results from these machines should not be released until QC passes.', link: '/qc', items: qcFails.slice(0, 5).map((x) => ({ label: `${str(x.data().machineName)}: ${str(x.data().materialName)}`, link: '/qc' })) })

  const machines = (await db().collection(`labs/${labId}/qcMachines`).get()).docs.map((x) => ({ id: x.id, ...x.data() }) as DocumentData)
  const offline = machines.filter((m) => m.active !== false && m.ingestTokenHash && ok(str(m.branchId) || 'main') && now - (ms(m.connector?.lastSeenAt) ?? 0) > MACHINE_ONLINE_MS)
  const linkDown = machines.filter((m) => m.active !== false && m.ingestTokenHash && ok(str(m.branchId) || 'main') && now - (ms(m.connector?.lastSeenAt) ?? 0) <= MACHINE_ONLINE_MS && !['connected', 'listening'].includes(str(m.connector?.link)))
  if (offline.length || linkDown.length) alerts.push({ key: 'machines', level: 'urgent', title: 'Analysers not connected', count: offline.length + linkDown.length, detail: 'Results from these analysers are not reaching the app.', link: '/qc/setup', items: [...offline.map((m) => ({ label: `${str(m.name)}: connector offline`, link: '/qc/setup' })), ...linkDown.map((m) => ({ label: `${str(m.name)}: ${str(m.connector?.detail) || 'link to analyser down'}`, link: '/qc/setup' }))].slice(0, 5) })

  const unmSnap = await db().collection(`labs/${labId}/analyserUnmatched`).where('at', '>=', since).where('at', '<', until).get()
  const unmatched = unmSnap.docs.filter((x) => ok(str(x.data().branchId) || 'main'))
  if (unmatched.length) alerts.push({ key: 'unmatched', level: 'caution', title: 'Machine results not matched', count: unmatched.length, detail: 'Values from analysers with an unknown barcode or test code. Check the machine codes on your tests.', link: '/qc/setup' })

  // Stock: below reorder level, and lots expiring within 30 days.
  const [itemSnap, batchSnap] = await Promise.all([db().collection(`labs/${labId}/invItems`).get(), db().collection(`labs/${labId}/invBatches`).get()])
  const itemsById = new Map(itemSnap.docs.filter((x) => x.data().active !== false).map((x) => [x.id, x.data()]))
  const onHand = new Map<string, number>()
  const stocked = new Set<string>() // branch|item pairs the branch has ever kept: only those can be "low"
  const soon = dayKey(now + 30 * DAY)
  const today = dayKey(now)
  let expiring = 0
  for (const bt of batchSnap.docs) {
    const x = bt.data()
    const b = str(x.branchId) || 'main'
    if (x.deleted === true || !ok(b) || !itemsById.has(str(x.itemId))) continue
    const k = `${b}|${str(x.itemId)}`
    stocked.add(k)
    if (n(x.qtyRemaining) <= 0) continue
    if (str(x.expiry) >= today) onHand.set(k, (onHand.get(k) ?? 0) + n(x.qtyRemaining))
    if (str(x.expiry) && str(x.expiry) <= soon) expiring++
  }
  const low: string[] = []
  for (const b of scope) for (const [id, it] of itemsById) if (n(it.reorderLevel) > 0 && stocked.has(`${b.id}|${id}`) && (onHand.get(`${b.id}|${id}`) ?? 0) < n(it.reorderLevel)) low.push(`${str(it.name)}${scope.length > 1 ? ` (${b.name})` : ''}`)
  if (low.length) alerts.push({ key: 'lowStock', level: 'caution', title: 'Stock below reorder level', count: low.length, detail: 'Order these before they run out.', link: '/inventory', items: low.slice(0, 5).map((label) => ({ label, link: '/inventory' })) })
  if (expiring) alerts.push({ key: 'expiring', level: 'caution', title: 'Stock lots expiring within 30 days', count: expiring, detail: 'Use these first, or plan to replace them.', link: '/inventory' })

  const voidSnap = await db().collection(`labs/${labId}/orders`).where('voidedAt', '>=', since).where('voidedAt', '<', until).select('branchId', 'net', 'voidedBranchId').get()
  const voided = voidSnap.docs.filter((x) => ok(str(x.data().voidedBranchId) || branchOf(x.data())))
  if (voided.length) alerts.push({ key: 'voided', level: 'info', title: 'Bills cancelled', count: voided.length, detail: `Worth ₹${Math.round(voided.reduce((a, x) => a + n(x.data().net), 0) / 100).toLocaleString('en-IN')} in total. See the audit log for who and why.`, link: '/analysis' })
  if (refundCount) alerts.push({ key: 'refunds', level: 'info', title: 'Refunds given', count: refundCount, detail: `₹${Math.round(cur.refunds / 100).toLocaleString('en-IN')} paid back in this period.`, link: '/finance' })

  // ---- home collections in the period ----------------------------------------------------------------------
  const bookSnap = await db().collection(`labs/${labId}/bookings`).where('scheduledAt', '>=', since).where('scheduledAt', '<', until).get()
  const home = { total: 0, done: 0, pending: 0, missed: 0, cancelled: 0 }
  for (const bk of bookSnap.docs) {
    const x = bk.data()
    if (x.deleted === true || !ok(str(x.branchId) || 'main')) continue
    home.total++
    if (x.status === 'completed') home.done++
    else if (x.status === 'cancelled') home.cancelled++
    else if ((ms(x.scheduledAt) ?? now) < now - 60 * 60_000) home.missed++
    else home.pending++
  }
  if (home.missed) alerts.push({ key: 'homeMissed', level: 'caution', title: 'Home collections overdue', count: home.missed, detail: 'Booked slots that have passed without a collection.', link: '/bookings' })

  // ---- trend and branch rows ---------------------------------------------------------------------------------
  const dayList: string[] = []
  for (let t = fromMs; t < toMs; t += DAY) dayList.push(dayKey(t))
  const trend = dayList.map((k) => ({ date: k, billed: dayBilled.get(k) ?? 0, collected: dayCollected.get(k) ?? 0, prevBilled: dayBilledPrev.get(k) ?? 0, prevCollected: dayCollectedPrev.get(k) ?? 0 }))
  const branches = scope.map((b) => {
    const m = perBranch.get(b.id) ?? money()
    return {
      id: b.id, name: b.name, ...out(m),
      outstanding: dueByBranch.get(b.id)?.amount ?? 0,
      openBills: pipeByBranch.get(b.id) ?? 0,
      lateTests: lateByBranch.get(b.id) ?? 0,
      trend: dayList.map((k) => branchDay.get(b.id)?.get(k) ?? 0),
    }
  })
  const level = { urgent: 0, caution: 1, info: 2 }
  return {
    range: { from: dayKey(fromMs), to: dayKey(toMs - 1), prevFrom: dayKey(prevFrom), prevTo: dayKey(fromMs - 1), days },
    asOf: now,
    scope: scope.map((b) => b.id),
    branchesAvailable: mine.map((b) => ({ id: b.id, name: b.name, active: b.active })),
    kpi: { cur: out(cur), prev: out(prev), outstanding },
    modes,
    trend,
    branches,
    pipeline: { ...pipe, accessionOn, lateTests: lateCount, nearlyLate: nearly },
    home,
    alerts: alerts.sort((a, b) => level[a.level] - level[b.level]),
  }
})
