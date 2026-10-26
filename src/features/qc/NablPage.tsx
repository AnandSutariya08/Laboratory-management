import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Checkbox, DatePicker, Input, Popover, Select, Table } from 'antd'
import { DownloadOutlined, PrinterOutlined, TableOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { getDocs, serverTimestamp, setDoc } from 'firebase/firestore'
import { useBranchScope } from '../../lib/branchScope'
import { downloadCsv, ordersInRange } from '../../components/billing/helpers'
import { fmtDate, fmtDateTime, liveItems, tsToDate } from '../../components/results/common'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { buildTatRows, ms as tsMillis, approvedAtOf, type TatRow } from '../tat/tatRows'
import { useLiveDoc, useLiveQuery } from '../../hooks/useLive'
import { docRef, resultsCol, versionsCol } from '../../lib/db'
import type { Order, OrderItem, ResultVersion, TestResult } from '../../types'
import { retentionMin, useDiscards } from './components/DiscardSection'
import { useEqas } from './components/EqasSection'
import { useIlc } from './components/IlcSection'
import { useCapas, useRuns } from './components/shared'
import { useValidation } from './components/ValidationSection'
import { VALIDATION_LABEL } from './lib/validation'
import { downloadBlob, makeZip } from './lib/zip'
import { ilcParams } from './components/IlcSection'
import { fmt, median, percentile } from './lib/stats'
import { Panel, StatTile, TileGrid } from './ui'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { Button } from '../../design/Button'
import './qc.css'

type Cell = string | number | boolean | null
type LogRow = Record<string, Cell>
interface Log {
  columns: { key: string; title: string }[]
  rows: LogRow[]
  summary: { label: string; value: string | number }[]
  extra?: ReactNode
}

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '-')
const inRange = (d: Date | null, r: [Dayjs, Dayjs]) => !!d && !dayjs(d).isBefore(r[0].startOf('day')) && !dayjs(d).isAfter(r[1].endOf('day'))

const colKey = (name: string) => `hcl.nabl.columns.${name}`
const loadCols = (name: string): string[] | null => {
  try {
    const v = JSON.parse(localStorage.getItem(colKey(name)) ?? 'null')
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

// One register: department filter, free-text search, column show/hide (remembered per log),
// CSV / Excel / PDF (print) export with a lab header, and pagination.
function LogTab({ name, log, loading, depts, labName }: { name: string; log: Log; loading?: boolean; depts: string[]; labName: string }) {
  const [q, setQ] = useState('')
  const [dept, setDept] = useState<string>()
  // Column choice is shared lab-wide (labs/{lab}/nablColumns/{log}); the browser copy is only a fallback.
  const shared = useLiveDoc<{ hidden?: string[] }>(docRef('nablColumns', name), [name])
  const [local, setLocal] = useState<string[]>(() => loadCols(name) ?? [])
  useEffect(() => setLocal(loadCols(name) ?? []), [name])
  const hidden = shared.data?.hidden ?? local
  const setVisible = (keys: string[]) => {
    const h = log.columns.map((c) => c.key).filter((k) => !keys.includes(k))
    setLocal(h)
    try {
      localStorage.setItem(colKey(name), JSON.stringify(h))
    } catch {
      /* ignore */
    }
    void setDoc(docRef('nablColumns', name), { hidden: h, updatedAt: serverTimestamp() }).catch(() => undefined)
  }
  const shownCols = log.columns.filter((c) => !hidden.includes(c.key))
  const rows = useMemo(
    () =>
      log.rows.filter(
        (r) =>
          (!dept || !('department' in r) || r.department === dept) &&
          (!q || Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q.toLowerCase()))),
      ),
    [log.rows, q, dept],
  )
  const table = () => [shownCols.map((c) => c.title), ...rows.map((r) => shownCols.map((c) => String(r[c.key] ?? '')))]
  const stamp = `${dayjs().format('YYYYMMDD')}`
  const exportExcel = () => {
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const html = `<html><head><meta charset="utf-8"></head><body><h3>${esc(labName)}: ${esc(name)}</h3><table border="1">${table().map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></body></html>`
    const url = URL.createObjectURL(new Blob([html], { type: 'application/vnd.ms-excel' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `nabl-${name}-${stamp}.xls`
    a.click()
    URL.revokeObjectURL(url)
  }
  const exportPdf = () => {
    const w = window.open('', '_blank')
    if (!w) return
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    w.document.write(`<html><head><title>${esc(name)}</title><style>body{font:12px sans-serif}table{border-collapse:collapse;width:100%}td,th{border:1px solid #888;padding:3px 5px;text-align:left}</style></head><body><h3>${esc(labName)}</h3><p>${esc(name)} register, printed ${dayjs().format('DD MMM YYYY HH:mm')}</p><table>${table().map((r, i) => `<tr>${r.map((c) => (i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`)).join('')}</tr>`).join('')}</table></body></html>`)
    w.document.close()
    w.print()
  }
  return (
    <>
      <div className="qc-toolbar">
        <Input allowClear placeholder="Search this register" aria-label="Search" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
        {log.columns.some((c) => c.key === 'department') && (
          <Select allowClear placeholder="All departments" aria-label="Department" style={{ width: 190 }} value={dept} onChange={setDept} options={depts.map((d) => ({ value: d, label: d }))} />
        )}
        <Popover
          trigger="click"
          title="Columns"
          content={<Checkbox.Group style={{ display: 'grid', gap: 4 }} value={shownCols.map((c) => c.key)} onChange={(v) => setVisible(v as string[])} options={log.columns.map((c) => ({ value: c.key, label: c.title }))} />}
        >
          <Button icon={<TableOutlined />}>Columns</Button>
        </Popover>
        <span className="qc-toolbar__spacer" />
        <Button icon={<DownloadOutlined />} onClick={() => downloadCsv(`nabl-${name}-${stamp}.csv`, [[labName], ...table()])}>CSV</Button>
        <Button icon={<DownloadOutlined />} onClick={exportExcel}>Excel</Button>
        <Button icon={<PrinterOutlined />} onClick={exportPdf}>PDF</Button>
      </div>
      <TileGrid>
        {log.summary.map((s) => (
          <StatTile key={s.label} label={s.label} value={s.value} />
        ))}
      </TileGrid>
      <Table<LogRow>
        size="small"
        loading={loading}
        rowKey={(_, i) => String(i)}
        dataSource={rows}
        pagination={{ pageSize: 15 }}
        scroll={{ x: true }}
        columns={shownCols.map((c) => ({ title: c.title, dataIndex: c.key }))}
      />
      {log.extra}
    </>
  )
}

const cols = (...pairs: [string, string][]) => pairs.map(([key, title]) => ({ key, title }))

export default function NablPage() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(30, 'day'), dayjs()])
  const [tab, setTab] = useState('tat')
  const [tatSub, setTatSub] = useState<'all' | 'within' | 'out'>('all')
  const maps = useCatalogueMaps()
  const scope = useBranchScope()
  const { data: orders, loading } = useLiveQuery<Order>(ordersInRange(range[0], range[1], scope.constraints), [range[0].valueOf(), range[1].valueOf(), scope.key])
  const { data: runsAll } = useRuns(range[0], range[1])
  const runs = useMemo(() => runsAll.filter((r) => !r.deleted), [runsAll])
  const { data: capas } = useCapas()
  const { data: eqasAll } = useEqas()
  const eqas = useMemo(() => eqasAll.filter((r) => r.status !== 'deleted'), [eqasAll])
  const eqasNotPerformed = eqas.filter((r) => r.status === 'notPerformed').length
  const { data: ilcAll } = useIlc()
  const ilc = useMemo(() => ilcAll.filter((r) => !r.deleted), [ilcAll])
  const { data: validationAll } = useValidation()
  const validation = useMemo(() => validationAll.filter((r) => !r.deleted), [validationAll])
  const { data: discards } = useDiscards()

  // Results per order, refetched when the orders (or their report state) change.
  const [results, setResults] = useState<Record<string, TestResult[]>>({})
  const sig = orders.map((o) => `${o.id}:${o.reportStatus}:${o.reportedAt?.toMillis?.() ?? 0}:${o.items.map((i) => i.status).join('')}`).join('|')
  useEffect(() => {
    let live = true
    Promise.all(orders.map((o) => getDocs(resultsCol(o.id)).then((s) => [o.id, s.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as TestResult)] as const))).then((pairs) => {
      if (live) setResults(Object.fromEntries(pairs))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  // Version history is only loaded for the repeat log.
  const [versions, setVersions] = useState<Record<string, ResultVersion[]>>({})
  useEffect(() => {
    if (tab !== 'repeat') return
    let live = true
    const targets = orders.flatMap((o) => (results[o.id] ?? []).map((r) => [o.id, r.testId] as const))
    Promise.all(targets.map(([oid, tid]) => getDocs(versionsCol(oid, tid)).then((s) => [`${oid}|${tid}`, s.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as ResultVersion)] as const))).then((pairs) => {
      if (live) setVersions(Object.fromEntries(pairs))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sig, results])

  // ---- TAT (and urgent) rows: same builder as the TAT Analysis page (clock start from settings,
  // stop at approval, tests with no TAT and rejected / not-received samples left out).
  const settings = useLabSettings()
  const tatRows = useMemo(() => {
    const base = buildTatRows(orders, results, { settings, testById: maps.testById, departmentById: maps.departmentById, now: Date.now() })
    return base.map((r: TatRow) => ({
      _urgent: r.urgent,
      _within: r.done ? r.status !== 'out' : null,
      _min: r.done ? r.actual : null,
      _test: r.test,
      date: fmtDate(new Date(r.start)),
      bill: r.billNo,
      patient: r.patient,
      test: r.test,
      department: r.dept,
      urgent: r.urgent ? 'Yes' : 'No',
      received: fmtDateTime(new Date(r.start)),
      reported: r.end ? fmtDateTime(new Date(r.end)) : 'Pending',
      expected: r.expected,
      actual: r.done ? r.actual : '',
      status: !r.done ? 'Pending' : r.status === 'out' ? 'Out of TAT' : 'Within TAT',
      reason: r.reason,
      urgentRemark: r.urgentRemark,
      markedBy: r.urgentBy,
    }))
  }, [orders, results, maps.testById, maps.departmentById, settings])

  const tatSummary = (rows: typeof tatRows, label: string) => {
    const done = rows.filter((r) => r._within != null)
    const within = done.filter((r) => r._within).length
    const m = rows.map((r) => r._min).filter((x): x is number => x != null)
    return [
      { label: 'Tests', value: rows.length },
      { label, value: pct(within, done.length) },
      { label: 'Out of TAT', value: done.length - within },
      { label: 'Median TAT (min)', value: fmt(median(m), 0) },
      { label: '90th percentile (min)', value: fmt(percentile(m, 90), 0) },
    ]
  }
  const tatCols = cols(['date', 'Received date'], ['bill', 'Bill'], ['patient', 'Patient'], ['test', 'Test'], ['department', 'Department'], ['urgent', 'Urgent'], ['received', 'Received'], ['reported', 'Reported'], ['expected', 'Expected TAT (min)'], ['actual', 'Actual TAT (min)'], ['status', 'Status'], ['reason', 'Out of TAT reason'])
  const urgentCols = [...tatCols, { key: 'markedBy', title: 'Urgent marked by' }, { key: 'urgentRemark', title: 'Urgent remark' }]

  const tatLog: Log = useMemo(() => {
    const byTest = new Map<string, { n: number; within: number; done: number }>()
    for (const r of tatRows) {
      const g = byTest.get(r._test) ?? { n: 0, within: 0, done: 0 }
      g.n++
      if (r._within != null) {
        g.done++
        if (r._within) g.within++
      }
      byTest.set(r._test, g)
    }
    return {
      columns: tatCols,
      rows: tatRows,
      summary: tatSummary(tatRows, '% within TAT'),
      extra: (
        <Panel size="small" title="By test" style={{ marginTop: 16 }}>
          <Table
            size="small"
            pagination={{ pageSize: 10 }}
            rowKey="test"
            dataSource={[...byTest.entries()].map(([test, g]) => ({ test, tests: g.n, evaluated: g.done, within: pct(g.within, g.done) }))}
            columns={[{ title: 'Test', dataIndex: 'test' }, { title: 'Tests', dataIndex: 'tests' }, { title: 'Evaluated', dataIndex: 'evaluated' }, { title: '% within TAT', dataIndex: 'within' }]}
          />
        </Panel>
      ),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tatRows])

  const urgentLog: Log = useMemo(() => {
    const u = tatRows.filter((r) => r._urgent)
    return { columns: urgentCols, rows: u, summary: tatSummary(u, '% within urgent TAT').slice(0, 3) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tatRows])

  // ---- Rejections: items marked rejected with a reason
  const rejectionLog: Log = useMemo(() => {
    const rows: LogRow[] = []
    let handled = 0
    for (const o of orders)
      for (const it of liveItems(o) as (OrderItem & { rejectReason?: string; rejectedByName?: string; rejectStage?: string; recollection?: string })[]) {
        if (['received', 'entered', 'approved', 'hold', 'rejected'].includes(it.status)) handled++
        const isRej = (it.status as string) === 'rejected'
        // Earlier sample rejections stay in the register after the sample is re-collected.
        const hist = (it as { rejectHistory?: { reason?: string; by?: string; at?: { toDate?: () => Date } | number }[] }).rejectHistory ?? []
        hist.slice(0, isRej ? -1 : undefined).forEach((h) => {
          const at = typeof h.at === 'number' ? new Date(h.at) : h.at?.toDate?.()
          rows.push({
            date: fmtDateTime(at ?? o.receivedAt ?? o.createdAt),
            bill: o.billNo,
            barcode: o.barcode,
            patient: o.patientName,
            department: maps.departmentById.get(maps.testById.get(it.testIds[0])?.departmentId ?? '')?.name ?? '',
            item: it.name,
            reason: h.reason || 'No reason recorded',
            by: h.by ?? '',
            stage: 'Accession',
            recollection: 'Re-collected',
          })
        })
        // A single test rejected at result entry while the rest of its line carries on.
        if (!isRej)
          for (const x of (results[o.id] ?? []) as (TestResult & { rejected?: { reason?: string; byName?: string; at?: number } })[])
            if ((x.status as string) === 'rejected' && it.testIds.includes(x.testId)) {
              rows.push({
                date: fmtDateTime(x.rejected?.at ? new Date(x.rejected.at) : o.receivedAt ?? o.createdAt),
                bill: o.billNo,
                barcode: o.barcode,
                patient: o.patientName,
                department: maps.departmentById.get(maps.testById.get(x.testId)?.departmentId ?? '')?.name ?? '',
                item: maps.testById.get(x.testId)?.name ?? it.name,
                reason: x.rejected?.reason || 'No reason recorded',
                by: x.rejected?.byName ?? '',
                stage: 'Result entry',
                recollection: '',
              })
            }
        if (isRej) {
          const rej = (results[o.id] ?? []).find((x) => it.testIds.includes(x.testId)) as (TestResult & { rejected?: { reason?: string; byName?: string; at?: number } }) | undefined
          rows.push({
            date: fmtDateTime(o.receivedAt ?? o.createdAt),
            bill: o.billNo,
            barcode: o.barcode,
            patient: o.patientName,
            department: maps.departmentById.get(maps.testById.get(it.testIds[0])?.departmentId ?? '')?.name ?? '',
            item: it.name,
            reason: it.rejectReason ?? rej?.rejected?.reason ?? 'No reason recorded',
            by: it.rejectedByName ?? rej?.rejected?.byName ?? '',
            stage: it.rejectStage ?? (rej ? 'Result entry' : 'Accession'),
            recollection: it.recollection ?? '',
          })
        }
      }
    const reasons = new Map<string, number>()
    rows.forEach((r) => reasons.set(String(r.reason), (reasons.get(String(r.reason)) ?? 0) + 1))
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]
    return {
      columns: cols(['date', 'Date'], ['bill', 'Bill'], ['barcode', 'Barcode'], ['patient', 'Patient'], ['department', 'Department'], ['item', 'Test / package'], ['reason', 'Rejection reason'], ['by', 'Rejected by'], ['stage', 'Stage'], ['recollection', 'Recollection']),
      rows,
      summary: [{ label: 'Rejected', value: rows.length }, { label: 'Rejection rate', value: pct(rows.length, handled) }, { label: 'Top reason', value: top ? `${top[0]} (${top[1]})` : '-' }],
    }
  }, [orders, results, maps.testById, maps.departmentById])

  // ---- Critical values: from the captured acknowledgement (who was told, by whom, when, how)
  type CritAck = { by?: string; byName?: string; at?: number; note?: string; notifiedTo?: string; mode?: string; readBack?: boolean }
  const criticalLog: Log = useMemo(() => {
    const rows: LogRow[] = []
    let total = 0
    let within30 = 0
    let acked = 0
    for (const o of orders)
      for (const r of results[o.id] ?? []) {
        total++
        const t = maps.testById.get(r.testId)
        const ack = (r as TestResult & { criticalAck?: CritAck }).criticalAck
        const resulted = approvedAtOf(r) ?? tsMillis(r.updatedAt)
        for (const [key, v] of Object.entries(r.values ?? {})) {
          if (!v.critical) continue
          const p = t?.parameters.find((x) => x.key === key)
          const gap = ack?.at && resulted ? Math.max(0, Math.round((ack.at - resulted) / 60000)) : null
          if (ack) {
            acked++
            if (gap != null && gap <= 30) within30++
          }
          rows.push({
            date: fmtDateTime(r.updatedAt),
            bill: o.billNo,
            patient: o.patientName,
            department: maps.departmentById.get(t?.departmentId ?? '')?.name ?? '',
            test: r.testName,
            parameter: p?.name ?? key,
            value: `${v.value} ${p?.unit ?? ''}`.trim(),
            notifiedTo: ack?.notifiedTo ?? '',
            notifiedBy: ack?.byName ?? '',
            notifiedAt: ack?.at ? fmtDateTime(new Date(ack.at)) : 'Not recorded',
            mode: ack?.mode ?? '',
            readBack: ack ? (ack.readBack ? 'Yes' : ack.readBack === false ? 'No' : '') : '',
            timeToNotify: gap ?? '',
            remark: ack?.note ?? '',
            approvedBy: r.approvedByName || 'Not approved',
          })
        }
      }
    return {
      columns: cols(['date', 'Resulted'], ['bill', 'Bill'], ['patient', 'Patient'], ['department', 'Department'], ['test', 'Test'], ['parameter', 'Parameter'], ['value', 'Value'], ['notifiedTo', 'Notified to'], ['notifiedBy', 'Notified by'], ['notifiedAt', 'Notified at'], ['mode', 'Mode'], ['readBack', 'Read back'], ['timeToNotify', 'Time to notify (min)'], ['remark', 'Remark'], ['approvedBy', 'Approved by']),
      rows,
      summary: [{ label: 'Critical values', value: rows.length }, { label: 'Notified', value: pct(acked, rows.length) }, { label: 'Notified within 30 min', value: pct(within30, rows.length) }, { label: 'Results checked', value: total }],
    }
  }, [orders, results, maps.testById, maps.departmentById])

  // ---- Repeats: each re-run, with the reason captured at re-run time, the original value
  // (the version saved at the re-run) and the value now on the result. Older un-approvals show too.
  const repeatLog: Log = useMemo(() => {
    const rows: LogRow[] = []
    let total = 0
    const valText = (vals: Record<string, { value: string }> | undefined) =>
      Object.entries(vals ?? {}).filter(([, x]) => x?.value).map(([k, x]) => `${k}: ${x.value}`).join('; ')
    for (const o of orders)
      for (const r of results[o.id] ?? []) {
        total++
        const t = maps.testById.get(r.testId)
        const vs = [...(versions[`${o.id}|${r.testId}`] ?? [])].sort((a, b) => (a.at?.toMillis?.() ?? 0) - (b.at?.toMillis?.() ?? 0)) as (ResultVersion & { reason?: string })[]
        const events = vs.filter((v) => (v.event as string) === 'rerun' || v.event === 'unapproved')
        events.forEach((ev, idx) => {
          const next = vs.filter((v) => v.event === 'approved' && (v.at?.toMillis?.() ?? 0) > (ev.at?.toMillis?.() ?? 0))[0]
          rows.push({
            date: fmtDateTime(ev.at),
            bill: o.billNo,
            patient: o.patientName,
            department: maps.departmentById.get(t?.departmentId ?? '')?.name ?? '',
            test: r.testName,
            reason: ev.reason ?? (r as TestResult & { rerunReason?: string }).rerunReason ?? (ev.event === 'unapproved' ? 'Un-approved' : 'No reason recorded'),
            original: valText(ev.values),
            repeat: next ? valText(next.values) : r.status === 'approved' ? valText(r.values) : 'Awaiting repeat',
            requestedBy: ev.byName,
            performedBy: next?.byName ?? '',
            outcome: next ? 'Re-approved' : 'Pending',
            attempt: idx + 1,
          })
        })
      }
    const distinct = new Set(rows.map((r) => `${r.bill}|${r.test}`)).size
    return {
      columns: cols(['date', 'Date'], ['bill', 'Bill'], ['patient', 'Patient'], ['department', 'Department'], ['test', 'Test'], ['reason', 'Reason'], ['original', 'Original value'], ['repeat', 'Repeat value'], ['requestedBy', 'Requested by'], ['performedBy', 'Approved by'], ['outcome', 'Outcome'], ['attempt', 'Attempt']),
      rows,
      summary: [{ label: 'Repeat events', value: rows.length }, { label: 'Repeat rate', value: pct(distinct, total) }, { label: 'Results checked', value: total }],
    }
  }, [orders, results, versions, maps.testById, maps.departmentById])

  // ---- Sample discarding
  const discardLog: Log = useMemo(() => {
    const inR = discards.filter((d) => inRange(tsToDate(d.discardedAt), range))
    const rows: LogRow[] = inR.flatMap((d) =>
      (d.items ?? []).map((i) => ({ date: fmtDate(d.discardedAt), bill: i.billNo, barcode: i.barcode, received: fmtDateTime(i.receivedAt), method: d.method, discardedBy: d.discardedByName, verifiedBy: d.verifiedByName })),
    )
    const gone = new Set(discards.flatMap((d) => d.orderIds ?? []))
    const typeMin = new Map(maps.sampleTypes.map((t) => [t.id, retentionMin(t)]))
    const retentionOf = (o: Order) => {
      const m = o.items.flatMap((i) => i.testIds).map((id) => typeMin.get(maps.testById.get(id)?.sampleTypeId ?? '') ?? 0).filter((x) => x > 0)
      return m.length ? Math.max(...m) : (settings.nabl?.retentionDays ?? 7) * 1440
    }
    const overdue = orders.filter((o) => o.receivedAt && dayjs().diff(tsToDate(o.receivedAt), 'minute') >= retentionOf(o) && !gone.has(o.id)).length
    return {
      columns: cols(['date', 'Discard date'], ['bill', 'Bill'], ['barcode', 'Barcode'], ['received', 'Received'], ['method', 'Method'], ['discardedBy', 'Discarded by'], ['verifiedBy', 'Verified by']),
      rows,
      summary: [{ label: 'Samples discarded', value: rows.length }, { label: 'Batches', value: inR.length }, { label: 'Overdue (past retention)', value: overdue }],
    }
  }, [discards, orders, range, maps.sampleTypes, maps.testById, settings.nabl?.retentionDays])

  // ---- QC records
  const iqcLog: Log = useMemo(() => {
    const rows: LogRow[] = runs.map((r) => ({
      date: fmtDateTime(r.runAt),
      machine: r.machineName,
      material: `${r.materialName} (${r.lotNo})`,
      parameters: new Set(r.results.map((x) => `${x.testName}/${x.paramName}`)).size,
      status: r.status,
      violations: [...new Set(r.violations.map((v) => v.rule))].join(' '),
      source: r.source === 'analyser' ? 'Machine-fed' : 'Manual',
      by: r.runByName,
      capa: capas.find((c) => c.runId === r.id)?.status ?? '',
    }))
    const fail = runs.filter((r) => r.status === 'fail')
    const ids = new Set(runs.map((r) => r.id))
    const rc = capas.filter((c) => ids.has(c.runId))
    return {
      columns: cols(['date', 'Date'], ['machine', 'Machine'], ['material', 'Material / lot'], ['parameters', 'Parameters'], ['status', 'Status'], ['violations', 'Rules'], ['source', 'Source'], ['by', 'Run by'], ['capa', 'CAPA']),
      rows,
      summary: [{ label: 'QC runs', value: runs.length }, { label: 'Pass rate', value: pct(runs.filter((r) => r.status === 'pass').length, runs.length) }, { label: 'Rejected runs', value: fail.length }, { label: 'CAPAs (open / total)', value: `${rc.filter((c) => c.status === 'open').length} / ${rc.length}` }],
    }
  }, [runs, capas])

  const eqasLog: Log = useMemo(() => {
    const e = eqas.filter((r) => r.status !== 'notPerformed' && inRange(tsToDate(r.date), range))
    return {
      columns: cols(['date', 'Date'], ['provider', 'Provider'], ['round', 'Round'], ['sample', 'Sample'], ['param', 'Test / parameter'], ['ours', 'Our result'], ['peer', 'Peer mean ± SD'], ['sdi', 'SDI'], ['dev', 'Deviation %'], ['outcome', 'Outcome']),
      rows: e.map((r) => ({ date: fmtDate(r.date), provider: r.provider, round: r.round, sample: r.sampleId, param: `${r.testName} / ${r.paramName}`, ours: r.ourResult, peer: `${r.peerMean} ± ${r.peerSd}`, sdi: fmt(r.sdi), dev: fmt(r.devPct), outcome: r.outcome })),
      summary: [{ label: 'EQAS results', value: e.length }, { label: 'Acceptable', value: pct(e.filter((r) => r.outcome === 'acceptable').length, e.length) }, { label: 'Unacceptable', value: e.filter((r) => r.outcome === 'unacceptable').length }, { label: 'Not performed', value: eqasNotPerformed }],
    }
  }, [eqas, range, eqasNotPerformed])

  const ilcLog: Log = useMemo(() => {
    const e = ilc.filter((r) => inRange(tsToDate(r.date), range))
    return {
      columns: cols(['date', 'Date'], ['partner', 'Partner lab'], ['sample', 'Sample'], ['param', 'Test / parameter'], ['ours', 'Our result'], ['theirs', 'Partner result'], ['diff', '% difference'], ['sdi', 'SDI'], ['limit', 'Limit %'], ['outcome', 'Outcome']),
      rows: e.flatMap((r) => ilcParams(r).map((p) => ({ date: fmtDate(r.date), partner: r.partnerLab, sample: r.sampleId, param: `${p.testName} / ${p.paramName}`, ours: p.ourResult, theirs: p.theirResult, diff: fmt(p.diffPct), sdi: fmt(p.sdi), limit: p.limitPct, outcome: p.outcome }))),
      summary: [{ label: 'ILC studies', value: e.length }, { label: 'Acceptable', value: pct(e.filter((r) => r.outcome === 'acceptable').length, e.length) }],
    }
  }, [ilc, range])

  const validationLog: Log = useMemo(() => {
    const e = validation.filter((r) => inRange(tsToDate(r.date), range))
    return {
      columns: cols(['date', 'Date'], ['type', 'Study'], ['machine', 'Machine'], ['param', 'Parameter'], ['by', 'Performed by'], ['outcome', 'Outcome']),
      rows: e.map((r) => ({ date: fmtDate(r.date), type: VALIDATION_LABEL[r.type], machine: r.machineBName ? `${r.machineName} vs ${r.machineBName}` : r.machineName, param: r.testName ? `${r.testName} / ${r.paramName}` : '', by: r.performedByName, outcome: r.outcome })),
      summary: [{ label: 'Studies', value: e.length }, { label: 'Passed', value: pct(e.filter((r) => r.outcome === 'pass').length, e.length) }],
    }
  }, [validation, range])

  const tatShown: Log = useMemo(() => {
    if (tatSub === 'all') return tatLog
    const want = tatSub === 'within' ? 'Within TAT' : 'Out of TAT'
    const rows = tatRows.filter((r) => r.status === want)
    return { ...tatLog, rows, summary: tatLog.summary.slice(0, 1).map((x) => ({ ...x, value: rows.length })) }
  }, [tatLog, tatRows, tatSub])

  const GROUPS: { key: 'log' | 'qc'; label: string; tabs: [string, string, Log][] }[] = [
    {
      key: 'log',
      label: 'Log records',
      tabs: [
        ...(settings.tat?.enabled === false ? [] : [['tat', 'TAT reports', tatShown] as [string, string, Log]]),
        ['rejection', 'Rejection log', rejectionLog],
        ['critical', 'Critical alert log', criticalLog],
        ['repeat', 'Repeat tests record', repeatLog],
        ['discard', 'Sample discarding', discardLog],
        ['urgent', 'Urgent sample', urgentLog],
      ],
    },
    {
      key: 'qc',
      label: 'QC records',
      tabs: [
        ['iqc', 'IQC', iqcLog],
        ['eqas', 'EQAS', eqasLog],
        ['ilc', 'ILC', ilcLog],
        ['validation', 'Equipment validation', validationLog],
      ],
    },
  ]
  // Evidence pack: one CSV per register plus a printable HTML with every register, zipped client side.
  const evidencePack = () => {
    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const csv = (rows: unknown[][]) => rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const files: { name: string; data: string }[] = []
    const sections: string[] = []
    const period = `${range[0].format('YYYY-MM-DD')} to ${range[1].format('YYYY-MM-DD')}`
    for (const g of GROUPS)
      for (const [key, label, log] of g.tabs) {
        const table = [log.columns.map((c) => c.title), ...log.rows.map((r) => log.columns.map((c) => r[c.key] ?? ''))]
        files.push({ name: `${g.key}-${key}.csv`, data: '\ufeff' + csv([[settings.name], [label, period], ...table]) })
        sections.push(`<section><h2>${esc(label)}</h2><p>${log.summary.map((x) => `${esc(x.label)}: <b>${esc(x.value)}</b>`).join(' &nbsp; ')}</p><table><tr>${table[0].map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${table.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></section>`)
      }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>NABL evidence pack</title><style>body{font:12px sans-serif;margin:24px}table{border-collapse:collapse;width:100%;margin-bottom:8px}td,th{border:1px solid #888;padding:3px 5px;text-align:left}section{page-break-after:always}</style></head><body><h1>${esc(settings.name)}: NABL evidence pack</h1><p>Period ${period}. Generated ${dayjs().format('DD MMM YYYY HH:mm')}.</p>${sections.join('')}</body></html>`
    const readme = `${settings.name}\nNABL evidence pack\nPeriod: ${period}\nGenerated: ${dayjs().format('YYYY-MM-DD HH:mm')}\n\nFiles\n${files.map((f) => `- ${f.name}`).join('\n')}\n- evidence-pack.html (all registers, open and print)\n`
    downloadBlob(`nabl-evidence-pack-${dayjs().format('YYYYMMDD')}.zip`, makeZip([...files, { name: 'evidence-pack.html', data: html }, { name: 'README.txt', data: readme }]))
  }
  const group = GROUPS.find((g) => g.tabs.some(([k]) => k === tab)) ?? GROUPS[0]
  const current = group.tabs.find(([k]) => k === tab) ?? group.tabs[0]

  return (
    <div>
      <PageHeader
        title="NABL Audit"
        subtitle="Registers are computed live from bills, results and QC records for the selected period."
        actions={<><DatePicker.RangePicker allowClear={false} value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} aria-label="Audit period" /><Button icon={<DownloadOutlined />} onClick={evidencePack}>Evidence pack (zip)</Button></>}
      />
      <div className="qc-subnav">
        <Segmented aria-label="NABL record groups" value={group.key} onChange={(k) => setTab(GROUPS.find((g) => g.key === k)!.tabs[0][0])} options={GROUPS.map((g) => ({ value: g.key, label: g.label }))} />
        <div>
          <Segmented aria-label={`${group.label} registers`} size="small" value={current[0]} onChange={setTab} options={group.tabs.map(([k, l]) => ({ value: k, label: l }))} />
        </div>
        {current[0] === 'tat' && (
          <div>
            <Segmented aria-label="TAT report filter" size="small" value={tatSub} onChange={setTatSub} options={[{ value: 'all', label: 'All' }, { value: 'within', label: 'Within TAT' }, { value: 'out', label: 'Out of TAT' }]} />
          </div>
        )}
      </div>
      <LogTab name={current[0] + (current[0] === 'tat' ? `-${tatSub}` : '')} log={current[2]} loading={loading} depts={maps.departments.map((d) => d.name)} labName={settings.name} />
    </div>
  )
}
