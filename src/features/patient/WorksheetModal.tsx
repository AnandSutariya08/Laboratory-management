import { useMemo, useState } from 'react'
import { worksheetText } from '../settings/lib'
import { App, Modal, Select, Table } from 'antd'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { ageText, GENDER_SHORT } from '../../components/billing/helpers'
import { useMaster } from './lib'
import { esc, labHeader, printHtml } from './print'
import type { PatientOrder } from './types'
import { FieldGrid, FormSection } from '../../design/FormLayout'
import { dialogWidth } from '../../design/dialog'

interface Line {
  key: string
  barcode: string
  billNo: string
  patient: string
  test: string
  sample: string
  params: string[]
}

export default function WorksheetModal({ open, onClose, orders }: { open: boolean; onClose: () => void; orders: PatientOrder[] }) {
  const { message } = App.useApp()
  const settings = useLabSettings()
  const { tests, testById, departments, sampleTypeById } = useCatalogueMaps()
  const b2b = useMaster('b2bCentres')
  const gov = useMaster('govPanels')
  const templates = useMaster('worksheetTemplates') as unknown as { id: string; name: string; blankLines?: number; showRange?: boolean }[]
  const [dept, setDept] = useState<string>()
  const [b2bCentreId, setB2b] = useState<string>()
  const [govId, setGov] = useState<string>()
  const [tplId, setTpl] = useState<string>()
  const tpl = templates.find((t) => t.id === tplId)

  const lines = useMemo<Line[]>(() => {
    const out: Line[] = []
    for (const o of orders) {
      if (b2bCentreId && o.b2bCentreId !== b2bCentreId) continue
      if (govId && o.govPanelId !== govId) continue
      for (const i of o.items) {
        if (i.status === 'refunded') continue
        for (const tid of i.testIds) {
          const t = testById.get(tid)
          if (!t || (dept && t.departmentId !== dept)) continue
          out.push({
            key: `${o.id}-${i.lineId}-${tid}`,
            barcode: o.barcode,
            billNo: o.billNo,
            patient: `${o.patientName} (${ageText(o.ageValue, o.ageUnit)}/${GENDER_SHORT[o.gender]})`,
            test: t.name,
            sample: sampleTypeById.get(t.sampleTypeId)?.name ?? '',
            params: t.parameters.filter((p) => p.structure !== 'group').map((p) => `${p.name}${p.unit ? ` (${p.unit})` : ''}`),
          })
        }
      }
    }
    return out
  }, [orders, dept, b2bCentreId, govId, testById, sampleTypeById])

  const print = () => {
    if (!lines.length) return message.info('Nothing to print for this selection.')
    const ws = worksheetText(settings)
    const deptName = departments.find((d) => d.id === dept)?.name ?? 'All departments'
    const body =
      labHeader(settings, `Worksheet: ${deptName}`) +
      (ws.header ? `<div class="muted" style="white-space:pre-line;margin-bottom:6px">${esc(ws.header)}</div>` : '') +
      `<table><thead><tr><th>Barcode</th><th>Patient</th><th>Test</th><th>Sample</th><th>Result</th></tr></thead><tbody>${lines
        .map((l) => {
          const blanks = (tpl?.blankLines ?? 0) > 0 ? Array.from({ length: tpl!.blankLines! }, () => '<div><span class="blank"></span></div>').join('') : ''
          const res = l.params.length ? l.params.map((p) => `<div>${esc(p)}: <span class="blank"></span></div>`).join('') : '<span class="blank"></span>'
          return `<tr><td class="mono">${esc(l.barcode)}</td><td>${esc(l.patient)}<br><span class="muted">${esc(l.billNo)}</span></td><td>${esc(l.test)}</td><td>${esc(l.sample)}</td><td>${res}${blanks}</td></tr>`
        })
        .join('')}</tbody></table><div class="sig"><div>Technician</div><div>Verified by</div></div>${ws.footer ? `<div class="muted" style="white-space:pre-line;margin-top:12px">${esc(ws.footer)}</div>` : ''}`
    if (!printHtml('Worksheet', body)) message.error('Allow pop-ups to print.')
  }

  const sel = (ph: string, v: string | undefined, set: (x?: string) => void, opts: { id: string; name: string }[]) => (
    <div>
      <label className="pl-field__label" htmlFor={`ws-${ph}`}>{ph}</label>
      <Select id={`ws-${ph}`} allowClear showSearch optionFilterProp="label" placeholder="Any" aria-label={ph} value={v} onChange={set} style={{ width: '100%', marginTop: 4 }} options={opts.map((o) => ({ value: o.id, label: o.name }))} />
    </div>
  )
  void tests
  return (
    <Modal open={open} onCancel={onClose} title="Print worksheet" width={dialogWidth(900)} okText="Print" onOk={print} okButtonProps={{ disabled: !lines.length }} destroyOnHidden>
      <FormSection title="Worksheet options" description="Narrow the lines and pick a print template.">
        <FieldGrid min={200} style={{ rowGap: 'var(--s-3)' }}>
          {sel('Department', dept, setDept, departments)}
          {sel('B2B centre', b2bCentreId, setB2b, b2b)}
          {sel('Government panel', govId, setGov, gov)}
          {sel('Template', tplId, setTpl, templates)}
        </FieldGrid>
      </FormSection>
      <FormSection title="Lines to print" description={`${lines.length} lines from ${orders.length} bills (the selected bills, or all bills in the current list).`}>
      <Table
        size="small"
        rowKey="key"
        dataSource={lines}
        pagination={{ pageSize: 8, showSizeChanger: false }}
        columns={[
          { title: 'Barcode', dataIndex: 'barcode', width: 90 },
          { title: 'Patient', dataIndex: 'patient' },
          { title: 'Test', dataIndex: 'test' },
          { title: 'Sample', dataIndex: 'sample', width: 100 },
          { title: 'Result', render: () => <span className="pl-sub">______</span>, width: 90 },
        ]}
      />
      </FormSection>
    </Modal>
  )
}
