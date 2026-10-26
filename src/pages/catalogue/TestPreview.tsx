import { useMemo } from 'react'
import { useLabSettings, useDepartments } from '../../hooks/useCatalogue'
import { mergeLayout } from '../../features/report/layout'
import ReportSheet from '../../features/report/ReportSheet'
import type { ReportModel, ReportOpts, RResult, RTest } from '../../features/report/model'
import { ageInDays, flagValue, resolveRange } from '../../lib/results'
import type { Parameter, ParamValue } from '../../types'

// Preview of one test exactly as it prints (CAT-38): the real ReportSheet renderer, the lab's report settings and
// layout, a sample patient and sample values taken from the middle of each numeric range.

const SAMPLE_AGE = 30
const sampleValue = (p: Parameter, age: number): string => {
  if (p.structure === 'group' || p.formula) return ''
  if (p.dataType === 'options') return p.options?.[0] ?? ''
  if (p.dataType === 'text') return p.defaultText || 'Sample text'
  if (p.dataType !== 'numeric' && p.dataType !== 'numericUnbound') return ''
  const { low, high } = resolveRange(p, age, 'male')
  if (low !== null && high !== null) return String(Math.round(((low + high) / 2) * 100) / 100)
  if (low !== null) return String(low + 1)
  if (high !== null) return String(Math.max(0, high - 1))
  return '10'
}

export function TestPreview({ test }: { test: Omit<RTest, 'id' | 'order'> & { id?: string; order?: number } }) {
  const s = useLabSettings()
  const depts = useDepartments().data
  const age = ageInDays(SAMPLE_AGE, 'year')

  const { model, opts } = useMemo(() => {
    const id = test.id ?? 'preview'
    const values: Record<string, ParamValue> = {}
    for (const p of test.parameters) {
      const value = sampleValue(p, age)
      values[p.key] = { value, overridden: false, ...(value ? flagValue(p, value, age, 'male') : { abnormal: null, critical: false }) } as ParamValue
    }
    const result: RResult = { testId: id, status: 'approved', values, approvedByName: 'Preview' }
    const now = new Date()
    const m: ReportModel = {
      lab: {
        name: s.name, address: s.address, phone: s.phone, email: s.email, website: s.profile?.website ?? '', city: s.profile?.city ?? '',
        logoDataUrl: s.profile?.logoDataUrl ?? '', dateFormat: s.profile?.dateFormat ?? 'DD/MM/YYYY',
      },
      rd: s.reportDetails,
      layout: mergeLayout(s.reportLayout),
      idDisplay: s.registration?.idDisplay ?? 'patientId',
      order: {
        billNo: `${s.billPrefix}0000`, patientName: 'Sample Patient', patientNo: '000000000', uhid: '', phone: '9000000000', address: '', gender: 'male',
        ageValue: SAMPLE_AGE, ageUnit: 'year', referrerName: 'Dr. Sample', barcode: '000000', createdAt: now, collectedAt: now, receivedAt: now, reportedAt: now,
        reportStatus: 'final', reportSignatoryId: '', reportNote: '', reportRevision: 0, amendSummary: '',
      },
      signatories: s.signatories.filter((x) => x.active).map((x) => ({ ...x })),
      defaultSignatoryId: s.reportEntry?.defaultSignatoryId ?? '',
      depts: depts.map((d) => ({ id: d.id, name: d.name, order: d.order })),
      tests: [{ ...test, id, order: test.order ?? 0 }],
      results: [result],
      qrUrl: '',
    }
    const rd = s.reportDetails
    const o: ReportOpts = {
      letterhead: rd.useLetterhead, header: rd.showHeader, footer: rd.showFooter, perDept: false, perTest: false, compare: false, abnSummary: false,
      qr: false, barcode: false, pageSize: rd.pageSize, picked: [id], interpretation: null, duplicate: false,
    }
    return { model: m, opts: o }
  }, [test, s, depts, age])

  return <div style={{ overflow: 'auto', maxHeight: '70vh' }}><ReportSheet model={model} opts={opts} prevs={{}} /></div>
}
