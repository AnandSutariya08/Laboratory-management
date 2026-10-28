import { useMemo, useState } from 'react'
import { App, DatePicker, Form, Modal, Select, Table } from 'antd'
import { PrinterOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { addDoc, orderBy, query, serverTimestamp, limit } from 'firebase/firestore'
import { col } from '../../../lib/db'
import { useLiveQuery } from '../../../hooks/useLive'
import { useAuth } from '../../../auth/AuthProvider'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { useBranchScope } from '../../../lib/branchScope'
import { branchStamp } from '../../../lib/activeBranch'
import { fmtDateTime } from '../../../components/results/common'
import { Button } from '../../../design/Button'
import { biasPct, cv, fmt, mean, sd } from '../lib/stats'
import { QC, type QcLevel, type QcRun } from '../types'
import { paramName, runTime, useMachines, useMaterials } from './shared'
import { Chip } from '../ui'
import { FieldGrid } from '../../../design/FormLayout'
import { dialogWidth } from '../../../design/dialog'

interface Download {
  id: string
  at: unknown
  byName: string
  machineName: string
  materialName: string
  parameter: string
  month: string
}

export const useIqcDownloads = () => {
  const scope = useBranchScope()
  return useLiveQuery<Download>(query(col(QC.iqcDownloads), ...scope.constraints, orderBy('at', 'desc'), limit(50)), [scope.key])
}

// Monthly IQC data sheet for one machine, lot and parameter: a day grid per level, monthly statistics,
// rejections, remarks, and sign-off lines. Printing is recorded in the download history.
export default function IqcSheet({ open, onClose, runs }: { open: boolean; onClose: () => void; runs: QcRun[] }) {
  const { message } = App.useApp()
  const { user, profile } = useAuth()
  const maps = useCatalogueMaps()
  const { data: machines } = useMachines()
  const { data: materials } = useMaterials()
  const { data: history } = useIqcDownloads()
  const [machineId, setMachineId] = useState<string>()
  const [materialId, setMaterialId] = useState<string>()
  const [param, setParam] = useState<string>()
  const [month, setMonth] = useState<Dayjs>(dayjs())

  const material = materials.find((m) => m.id === materialId)
  const machine = machines.find((m) => m.id === machineId)
  const params = useMemo(() => [...new Set((material?.targets ?? []).map((t) => `${t.testId}|${t.paramKey}`))], [material])
  const levels: QcLevel[] = material?.levels ?? []
  const days = month.daysInMonth()

  const sheet = useMemo(() => {
    if (!material || !machine || !param) return null
    const [testId, paramKey] = param.split('|')
    const mruns = runs.filter((r) => !r.deleted && r.machineId === machine.id && r.materialId === material.id && dayjs(runTime(r)).isSame(month, 'month'))
    const grid: Record<QcLevel, (string | number)[][]> = { L1: [], L2: [], L3: [] }
    const stats = levels.map((lv) => {
      const vals: number[] = []
      for (let d = 1; d <= days; d++) {
        const cell = mruns
          .filter((r) => dayjs(runTime(r)).date() === d)
          .flatMap((r) => r.results.filter((x) => x.testId === testId && x.paramKey === paramKey && x.level === lv))
          .map((x) => x.value)
        grid[lv].push(cell)
        vals.push(...cell)
      }
      const t = material.targets.find((x) => x.testId === testId && x.paramKey === paramKey && x.level === lv && (!x.machineId || x.machineId === machine.id))
      return { lv, n: vals.length, mean: mean(vals), sd: sd(vals), cv: cv(vals), bias: t ? biasPct(mean(vals), t.mean) : NaN, target: t ? `${t.mean} ± ${t.sd}` : '-' }
    })
    const rejections = mruns.filter((r) => r.status === 'fail').length
    const remarks = mruns.filter((r) => r.note).map((r) => `${dayjs(runTime(r)).format('DD')}: ${r.note}`)
    return { stats, grid, rejections, remarks, n: mruns.length }
  }, [material, machine, param, runs, month, levels, days])

  const print = async () => {
    if (!sheet || !machine || !material || !param) return
    const [testId, paramKey] = param.split('|')
    const test = maps.testById.get(testId)
    const pname = `${test?.name ?? ''} / ${paramName(test, paramKey)}`
    const w = window.open('', '_blank')
    if (!w) return message.warning('Allow pop-ups to print the sheet')
    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const dayHead = Array.from({ length: days }, (_, i) => `<th>${i + 1}</th>`).join('')
    const body = levels
      .map((lv) => `<tr><th>${lv}</th>${sheet.grid[lv].map((c) => `<td>${esc(c.join(', '))}</td>`).join('')}</tr>`)
      .join('')
    w.document.write(`<html><head><title>IQC sheet</title><style>body{font:11px sans-serif}table{border-collapse:collapse}td,th{border:1px solid #888;padding:2px 4px;text-align:center;min-width:22px}.s td,.s th{min-width:60px}</style></head><body>
      <h3>${esc(profile?.name ? '' : '')}IQC data sheet</h3>
      <p><b>Machine:</b> ${esc(machine.name)} &nbsp; <b>Lot:</b> ${esc(material.name)} (${esc(material.lotNo)}) &nbsp; <b>Parameter:</b> ${esc(pname)} &nbsp; <b>Month:</b> ${month.format('MMMM YYYY')}</p>
      <table><tr><th>Level</th>${dayHead}</tr>${body}</table>
      <h4>Monthly statistics</h4>
      <table class="s"><tr><th>Level</th><th>Target</th><th>n</th><th>Mean</th><th>SD</th><th>CV %</th><th>Bias %</th></tr>${sheet.stats.map((s) => `<tr><td>${s.lv}</td><td>${esc(s.target)}</td><td>${s.n}</td><td>${fmt(s.mean)}</td><td>${fmt(s.sd)}</td><td>${fmt(s.cv)}</td><td>${fmt(s.bias)}</td></tr>`).join('')}</table>
      <p><b>Rejected runs:</b> ${sheet.rejections}</p>
      <p><b>Remarks:</b> ${esc(sheet.remarks.join(' | ') || '-')}</p>
      <p style="margin-top:30px">Performed by (initials): ________ &nbsp;&nbsp; Reviewed by (signature): ________________ &nbsp;&nbsp; Date: ________</p>
      </body></html>`)
    w.document.close()
    w.print()
    try {
      await addDoc(col(QC.iqcDownloads), {
        ...branchStamp(),
        at: serverTimestamp(),
        by: user?.uid ?? '',
        byName: profile?.name ?? '',
        machineName: machine.name,
        materialName: `${material.name} (${material.lotNo})`,
        parameter: pname,
        month: month.format('YYYY-MM'),
      })
    } catch {
      /* the history is best-effort */
    }
  }

  return (
    <Modal title="IQC data sheet" open={open} onCancel={onClose} footer={null} width={dialogWidth(900)} destroyOnHidden>
      <Form layout="vertical" component="div">
        <FieldGrid min={200}>
          <Form.Item label="Machine"><Select placeholder="Machine" style={{ width: '100%' }} value={machineId} onChange={setMachineId} options={machines.map((m) => ({ value: m.id, label: m.name }))} aria-label="Machine" /></Form.Item>
          <Form.Item label="Sample kit / lot"><Select placeholder="Sample kit / lot" style={{ width: '100%' }} value={materialId} onChange={(v) => { setMaterialId(v); setParam(undefined) }} options={materials.map((m) => ({ value: m.id, label: `${m.name} (${m.lotNo})` }))} aria-label="Sample kit" /></Form.Item>
          <Form.Item label="Parameter"><Select placeholder="Parameter" style={{ width: '100%' }} value={param} onChange={setParam} options={params.map((k) => { const [t, p] = k.split('|'); return { value: k, label: `${maps.testById.get(t)?.name ?? t} / ${paramName(maps.testById.get(t), p)}` } })} aria-label="Parameter" /></Form.Item>
          <Form.Item label="Month"><DatePicker style={{ width: '100%' }} picker="month" allowClear={false} value={month} onChange={(v) => v && setMonth(v)} aria-label="Month" /></Form.Item>
        </FieldGrid>
      </Form>
      <div className="qc-actionbar" style={{ marginBottom: 12 }}>
        <Button variant="primary" icon={<PrinterOutlined />} disabled={!sheet} onClick={print}>Print / save as PDF</Button>
      </div>
      {sheet && (
        <Table
          size="small"
          pagination={false}
          rowKey="lv"
          dataSource={sheet.stats}
          columns={[
            { title: 'Level', dataIndex: 'lv' },
            { title: 'Target', dataIndex: 'target' },
            { title: 'n', dataIndex: 'n' },
            { title: 'Mean', render: (_, s) => fmt(s.mean) },
            { title: 'SD', render: (_, s) => fmt(s.sd) },
            { title: 'CV %', render: (_, s) => fmt(s.cv) },
            { title: 'Bias %', render: (_, s) => fmt(s.bias) },
          ]}
        />
      )}
      {sheet && <p className="qc-muted">{sheet.n} run(s) in the month, {sheet.rejections} rejected.</p>}
      <h4>Download history</h4>
      <Table
        size="small"
        rowKey="id"
        dataSource={history}
        pagination={{ pageSize: 5, hideOnSinglePage: true }}
        locale={{ emptyText: 'No sheets printed yet' }}
        columns={[
          { title: 'When', render: (_, d) => fmtDateTime(d.at as never) },
          { title: 'By', dataIndex: 'byName' },
          { title: 'Machine', dataIndex: 'machineName' },
          { title: 'Lot', dataIndex: 'materialName' },
          { title: 'Parameter', dataIndex: 'parameter' },
          { title: 'Month', render: (_, d) => <Chip status="neutral">{d.month}</Chip> },
        ]}
      />
    </Modal>
  )
}
