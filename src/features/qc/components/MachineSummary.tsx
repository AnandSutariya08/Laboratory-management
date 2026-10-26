import { useMemo, useState } from 'react'
import { Table } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { downloadCsv } from '../../../components/billing/helpers'
import { Segmented } from '../../../design/Segmented'
import { Button } from '../../../design/Button'
import type { Capa, QcMachine, QcMaterial, QcRun } from '../types'
import type { SlotView } from '../lib/occurrences'
import { runTime } from './shared'
import { Toolbar } from '../ui'

interface Row {
  key: string
  machine: string
  period: string
  lot: string
  scheduled: number
  performed: number
  missed: number
  passRate: string
  failed: number
  openCapas: number
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-')

// Machine-wise QC summary: scheduled / performed / missed / pass rate / open CAPAs per machine.
// "Cumulative" = whole selected period, "Monthly" = one row per month, "By lot" = one row per lot so the
// current lot sits next to the previous one.
export default function MachineSummary({ machines, runs, views, capas, materials }: { machines: QcMachine[]; runs: QcRun[]; views: SlotView[]; capas: Capa[]; materials: QcMaterial[] }) {
  const [mode, setMode] = useState<'cumulative' | 'monthly' | 'lot'>('cumulative')
  const rows = useMemo(() => {
    const out: Row[] = []
    const lotOf = (id: string) => materials.find((m) => m.id === id)
    for (const m of machines) {
      const mr = runs.filter((r) => r.machineId === m.id)
      const mv = views.filter((v) => v.slot.machine.id === m.id)
      const openCapas = (rs: QcRun[]) => capas.filter((c) => c.status !== 'closed' && rs.some((r) => r.id === c.runId)).length
      const make = (key: string, period: string, lot: string, rs: QcRun[], vs: SlotView[]) =>
        out.push({ key, machine: m.name, period, lot, scheduled: vs.length, performed: rs.length, missed: vs.filter((v) => v.status === 'missed').length, passRate: pct(rs.filter((r) => r.status === 'pass').length, rs.length), failed: rs.filter((r) => r.status === 'fail').length, openCapas: openCapas(rs) })
      if (mode === 'cumulative') make(m.id, 'Selected period', 'All lots', mr, mv)
      else if (mode === 'monthly') {
        const months = [...new Set([...mr.map((r) => dayjs(runTime(r)).format('YYYY-MM')), ...mv.map((v) => v.slot.day.slice(0, 7))])].sort().reverse()
        for (const mo of months) make(`${m.id}${mo}`, dayjs(`${mo}-01`).format('MMM YYYY'), 'All lots', mr.filter((r) => dayjs(runTime(r)).format('YYYY-MM') === mo), mv.filter((v) => v.slot.day.startsWith(mo)))
      } else {
        const lots = [...new Set(mr.map((r) => r.materialId))].sort((a, b) => (lotOf(b)?.expiry ?? '').localeCompare(lotOf(a)?.expiry ?? ''))
        lots.forEach((id, i) => {
          const l = lotOf(id)
          const rs = mr.filter((r) => r.materialId === id)
          make(`${m.id}${id}`, i === 0 ? 'Current lot' : i === 1 ? 'Previous lot' : 'Earlier lot', l ? `${l.name} (${l.lotNo})` : rs[0]?.lotNo ?? id, rs, mv.filter((v) => !v.slot.schedule.materialId || v.slot.schedule.materialId === id))
        })
      }
    }
    return out
  }, [machines, runs, views, capas, materials, mode])
  return (
    <>
      <Toolbar>
        <Segmented aria-label="Machine summary view" size="small" value={mode} onChange={setMode} options={[{ value: 'cumulative', label: 'Cumulative' }, { value: 'monthly', label: 'Monthly' }, { value: 'lot', label: 'Compare lots' }]} />
        <span className="qc-toolbar__spacer" />
        <Button icon={<DownloadOutlined />} onClick={() => downloadCsv('qc-machine-summary.csv', [['Machine', 'Period', 'Lot', 'Scheduled', 'Performed', 'Missed', 'Pass rate', 'Failed', 'Open CAPAs'], ...rows.map((r) => [r.machine, r.period, r.lot, r.scheduled, r.performed, r.missed, r.passRate, r.failed, r.openCapas])])}>Export CSV</Button>
      </Toolbar>
      <Table<Row>
        size="small"
        rowKey="key"
        dataSource={rows}
        pagination={{ pageSize: 15, hideOnSinglePage: true }}
        columns={[
          { title: 'Machine', dataIndex: 'machine' },
          { title: 'Period', dataIndex: 'period' },
          { title: 'Lot', dataIndex: 'lot' },
          { title: 'Scheduled', dataIndex: 'scheduled' },
          { title: 'Performed', dataIndex: 'performed' },
          { title: 'Missed', dataIndex: 'missed' },
          { title: 'Pass rate', dataIndex: 'passRate' },
          { title: 'Failed', dataIndex: 'failed' },
          { title: 'Open CAPAs', dataIndex: 'openCapas' },
        ]}
      />
    </>
  )
}
