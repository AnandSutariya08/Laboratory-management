import { useMemo, useState } from 'react'
import { Alert, App, Space, Table, Typography, Upload } from 'antd'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import { StatusChip } from '../../design/StatusChip'
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import { doc, writeBatch } from 'firebase/firestore'
import { db } from '../../firebase'
import { useCatalogueMaps } from '../../hooks/useCatalogue'
import { col, docRef, paths } from '../../lib/db'
import { toPaise } from '../../lib/money'
import { evaluateFormula } from '../../lib/results'
import type { Parameter, ParamDataType, Test, TestGender } from '../../types'
import { downloadText, parseCsv, slug } from './helpers'
import './catalogue.css'

const TEST_HEADERS = [
  'test_code', 'test_name', 'department', 'sample_type', 'price', 'gender', 'tat_minutes',
  'param_key', 'param_name', 'unit', 'low', 'high', 'display_range', 'formula', 'data_type',
  'options', 'parent_key',
]
const PACKAGE_HEADERS = ['package_code', 'package_name', 'price', 'test_codes']

const TEST_TEMPLATE = [
  TEST_HEADERS.join(','),
  'CBC,Complete Blood Count,Haematology,EDTA Whole Blood,350,both,240,HB,Haemoglobin,g/dL,12,17,,,numeric,,',
  'CBC,,,,,,,RBC,RBC Count,million/cumm,4.5,5.9,,,numeric,,',
  'CBC,,,,,,,DLC,Differential Count,,,,,,group,,',
  'CBC,,,,,,,NEUT,Neutrophils,%,40,75,,,numeric,,DLC',
  'CBC,,,,,,,MCV,MCV,fL,,,80 - 100,HB / RBC * 10,numeric,,',
  'URINE,Urine Routine,Clinical Pathology,Urine,120,both,120,COLOUR,Colour,,,,,,options,Pale Yellow|Yellow|Amber,',
].join('\n')
const PACKAGE_TEMPLATE = [PACKAGE_HEADERS.join(','), 'BASIC,Basic Health Package,450,CBC|URINE'].join('\n')

interface ParsedTest {
  code: string
  name: string
  department: string
  sampleType: string
  price: number // rupees
  gender: TestGender
  tat: number | null
  params: Parameter[]
  errors: string[]
  rows: number[]
}

interface ParsedPackage {
  code: string
  name: string
  price: number
  testCodes: string[]
  errors: string[]
  row: number
}

const DATA_TYPES: Record<string, ParamDataType | 'group'> = {
  numeric: 'numeric',
  text: 'text',
  numericunbound: 'numericUnbound',
  options: 'options',
  group: 'group',
}

function numOrNull(raw: string, label: string, errors: string[], row: number): number | null {
  if (raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    errors.push(`Row ${row}: ${label} "${raw}" is not a number`)
    return null
  }
  return n
}

function indexer(headerRow: string[], expected: string[]) {
  const h = headerRow.map((x) => x.trim().toLowerCase())
  const missing = expected.filter((e) => !h.includes(e))
  return { idx: (name: string) => h.indexOf(name), missing }
}

function parseTests(text: string): { tests: ParsedTest[]; fatal: string | null } {
  const rows = parseCsv(text)
  if (rows.length === 0) return { tests: [], fatal: 'The file is empty' }
  const { idx, missing } = indexer(rows[0], ['test_code', 'test_name'])
  if (missing.length) return { tests: [], fatal: `Missing column(s): ${missing.join(', ')}` }
  const get = (r: string[], name: string) => (idx(name) >= 0 ? (r[idx(name)] ?? '').trim() : '')

  const byCode = new Map<string, ParsedTest>()
  rows.slice(1).forEach((r, i) => {
    const row = i + 2
    const code = get(r, 'test_code').toUpperCase()
    if (!code) return
    let t = byCode.get(code)
    if (!t) {
      t = { code, name: '', department: '', sampleType: '', price: 0, gender: 'both', tat: null, params: [], errors: [], rows: [] }
      byCode.set(code, t)
    }
    t.rows.push(row)
    const errs = t.errors
    if (!t.name) t.name = get(r, 'test_name')
    if (!t.department) t.department = get(r, 'department')
    if (!t.sampleType) t.sampleType = get(r, 'sample_type')
    const price = get(r, 'price')
    if (price && t.price === 0) t.price = numOrNull(price, 'price', errs, row) ?? 0
    const gender = get(r, 'gender').toLowerCase()
    if (gender) {
      if (gender === 'both' || gender === 'male' || gender === 'female') t.gender = gender
      else errs.push(`Row ${row}: gender "${gender}" must be both, male or female`)
    }
    const tat = get(r, 'tat_minutes')
    if (tat && t.tat === null) t.tat = numOrNull(tat, 'tat_minutes', errs, row)

    const key = get(r, 'param_key').toUpperCase()
    if (!key) return
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) errs.push(`Row ${row}: param_key "${key}" must be UPPERCASE letters/digits/_`)
    if (t.params.some((p) => p.key === key)) errs.push(`Row ${row}: duplicate param_key ${key}`)
    const rawType = get(r, 'data_type').toLowerCase()
    const options = get(r, 'options').split('|').map((x) => x.trim()).filter(Boolean)
    let type = rawType ? DATA_TYPES[rawType] : options.length ? 'options' : 'numeric'
    if (!type) {
      errs.push(`Row ${row}: data_type "${rawType}" must be numeric, text, numericUnbound, options or group`)
      type = 'numeric'
    }
    if (type === 'options' && options.length === 0) errs.push(`Row ${row}: data_type options needs an options list`)
    const isGroup = type === 'group'
    t.params.push({
      key,
      name: get(r, 'param_name') || key,
      structure: isGroup ? 'group' : 'single',
      parentKey: get(r, 'parent_key').toUpperCase() || null,
      dataType: type === 'group' ? 'text' : type,
      unit: get(r, 'unit'),
      options: type === 'options' ? options : [],
      low: numOrNull(get(r, 'low'), 'low', errs, row),
      high: numOrNull(get(r, 'high'), 'high', errs, row),
      ranges: [],
      criticalLow: null,
      criticalHigh: null,
      displayRange: get(r, 'display_range'),
      formula: get(r, 'formula'),
      required: false,
      hideOnReport: false,
      method: '',
    })
  })

  for (const t of byCode.values()) {
    if (!t.name) t.errors.push('Missing test_name')
    const keys = new Set(t.params.map((p) => p.key))
    for (const p of t.params) {
      if (p.parentKey) {
        const parent = t.params.find((x) => x.key === p.parentKey)
        if (!parent) t.errors.push(`${p.key}: parent_key ${p.parentKey} not found`)
        else if (parent.structure !== 'group') t.errors.push(`${p.key}: parent ${p.parentKey} must have data_type group`)
      }
      if (p.formula) {
        const ids = p.formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
        const bad = ids.find((i) => !keys.has(i) || i === p.key)
        if (bad) t.errors.push(`${p.key}: formula refers to unknown key ${bad}`)
        else {
          try {
            const vars: Record<string, number | null> = {}
            keys.forEach((k) => (vars[k] = 1))
            if (evaluateFormula(p.formula, vars) === null) t.errors.push(`${p.key}: formula cannot be evaluated`)
          } catch (e) {
            t.errors.push(`${p.key}: ${(e as Error).message}`)
          }
        }
      }
    }
  }
  return { tests: [...byCode.values()], fatal: null }
}

function parsePackages(text: string): { pkgs: ParsedPackage[]; fatal: string | null } {
  const rows = parseCsv(text)
  if (rows.length === 0) return { pkgs: [], fatal: 'The file is empty' }
  const { idx, missing } = indexer(rows[0], PACKAGE_HEADERS)
  if (missing.length) return { pkgs: [], fatal: `Missing column(s): ${missing.join(', ')}` }
  const get = (r: string[], name: string) => (r[idx(name)] ?? '').trim()
  const pkgs = rows.slice(1).map((r, i): ParsedPackage => {
    const errors: string[] = []
    const row = i + 2
    const code = get(r, 'package_code').toUpperCase()
    if (!code) errors.push('Missing package_code')
    if (!get(r, 'package_name')) errors.push('Missing package_name')
    return {
      code,
      name: get(r, 'package_name'),
      price: numOrNull(get(r, 'price'), 'price', errors, row) ?? 0,
      testCodes: get(r, 'test_codes').split('|').map((x) => x.trim().toUpperCase()).filter(Boolean),
      errors,
      row,
    }
  })
  return { pkgs, fatal: null }
}

export default function CatalogueImportPage() {
  const { message } = App.useApp()
  const { tests: existingTests, departments, sampleTypes, packages } = useCatalogueMaps()
  const [kind, setKind] = useState<'tests' | 'packages'>('tests')
  const [parsedTests, setParsedTests] = useState<ParsedTest[]>([])
  const [parsedPkgs, setParsedPkgs] = useState<ParsedPackage[]>([])
  const [fatal, setFatal] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setParsedTests([])
    setParsedPkgs([])
    setFatal(null)
    setFileName('')
  }

  const onFile = async (file: File) => {
    reset()
    const text = await file.text()
    setFileName(file.name)
    if (kind === 'tests') {
      const r = parseTests(text)
      setParsedTests(r.tests)
      setFatal(r.fatal)
    } else {
      const r = parsePackages(text)
      setParsedPkgs(r.pkgs)
      setFatal(r.fatal)
    }
    return false
  }

  const existingByCode = useMemo(() => new Map(existingTests.map((t) => [t.code.toUpperCase(), t])), [existingTests])
  const validTests = parsedTests.filter((t) => t.errors.length === 0)

  const testCodeKnown = (code: string) =>
    existingByCode.has(code) || parsedTests.some((t) => t.code === code && t.errors.length === 0)
  const pkgErrors = (p: ParsedPackage) => [
    ...p.errors,
    ...p.testCodes.filter((c) => !testCodeKnown(c)).map((c) => `Unknown test code ${c}`),
  ]
  const validPkgs = parsedPkgs.filter((p) => pkgErrors(p).length === 0)

  const importTests = async () => {
    setBusy(true)
    try {
      // Resolve (and create) departments and sample types by name.
      const deptByName = new Map(departments.map((d) => [d.name.toLowerCase(), d.id]))
      const sampleByName = new Map(sampleTypes.map((s) => [s.name.toLowerCase(), s.id]))
      const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = []
      let nextDeptOrder = Math.max(0, ...departments.map((d) => d.order)) + 1
      const ensureDept = (name: string): string => {
        const n = name || 'General'
        const found = deptByName.get(n.toLowerCase())
        if (found) return found
        const id = slug(n)
        deptByName.set(n.toLowerCase(), id)
        const order = nextDeptOrder++
        ops.push((b) => b.set(docRef(paths.departments, id), { name: n, order }, { merge: true }))
        return id
      }
      const ensureSample = (name: string): string => {
        const n = name || 'Other'
        const found = sampleByName.get(n.toLowerCase())
        if (found) return found
        const id = slug(n)
        sampleByName.set(n.toLowerCase(), id)
        ops.push((b) => b.set(docRef(paths.sampleTypes, id), { name: n, tubeColor: '#9CA3AF' }, { merge: true }))
        return id
      }
      let nextOrder = Math.max(0, ...existingTests.map((t) => t.order ?? 0)) + 1
      for (const t of validTests) {
        const prev = existingByCode.get(t.code)
        const data: Omit<Test, 'id'> = {
          code: t.code,
          name: t.name,
          departmentId: t.department ? ensureDept(t.department) : prev?.departmentId ?? ensureDept(''),
          sampleTypeId: t.sampleType ? ensureSample(t.sampleType) : prev?.sampleTypeId ?? ensureSample(''),
          price: t.price > 0 || !prev ? toPaise(t.price) : prev.price,
          gender: t.gender,
          tatMinutes: t.tat ?? prev?.tatMinutes ?? null,
          urgentTatMinutes: prev?.urgentTatMinutes ?? null,
          // rows without parameters leave existing parameters untouched
          parameters: t.params.length ? t.params : prev?.parameters ?? [],
          interpretation: prev?.interpretation ?? '',
          disabled: prev?.disabled ?? false,
          order: prev?.order ?? nextOrder++,
        }
        const ref = prev ? docRef(paths.tests, prev.id) : doc(col(paths.tests))
        ops.push((b) => b.set(ref, data, { merge: true }))
      }
      await commit(ops)
      message.success(`Imported ${validTests.length} test(s)`)
      reset()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const importPackages = async () => {
    setBusy(true)
    try {
      const idByCode = new Map(existingTests.map((t) => [t.code.toUpperCase(), t.id]))
      const pkgByCode = new Map(packages.map((p) => [p.code.toUpperCase(), p]))
      const ops: Array<(b: ReturnType<typeof writeBatch>) => void> = []
      // Tests imported earlier in this session are already in the live catalogue.
      for (const p of validPkgs) {
        const testIds = p.testCodes.map((c) => idByCode.get(c)).filter((x): x is string => !!x)
        const prev = pkgByCode.get(p.code)
        const ref = prev ? docRef(paths.packages, prev.id) : doc(col(paths.packages))
        ops.push((b) =>
          b.set(ref, { code: p.code, name: p.name, price: toPaise(p.price), testIds, disabled: prev?.disabled ?? false }, { merge: true }),
        )
      }
      await commit(ops)
      message.success(`Imported ${validPkgs.length} package(s)`)
      reset()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unresolvedPkgTests = kind === 'packages' && validPkgs.some((p) => p.testCodes.some((c) => !existingByCode.has(c)))

  return (
    <div className="cat-stack">
      <PageHeader title="Import catalogue" subtitle="Create or update tests and packages from a CSV master." />
      <Card>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Segmented<'tests' | 'packages'>
            aria-label="Import type"
            value={kind}
            onChange={(v) => {
              setKind(v)
              reset()
            }}
            options={[
              { value: 'tests', label: 'Tests' },
              { value: 'packages', label: 'Packages' },
            ]}
          />
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {kind === 'tests'
              ? 'One row per parameter. Repeat test_code on every row of a test; test-level columns are read from its first filled row. Existing tests with the same code are updated (their parameters are replaced when the file has param rows). Missing departments and sample types are created. Options are pipe-separated; use data_type "group" for headings and parent_key to nest.'
              : 'One row per package; test_codes is pipe-separated. Import tests first. Existing packages with the same code are updated.'}
          </Typography.Paragraph>
          <Space wrap>
            <Button
              icon={<DownloadOutlined />}
              onClick={() =>
                kind === 'tests'
                  ? downloadText('tests-template.csv', TEST_TEMPLATE)
                  : downloadText('packages-template.csv', PACKAGE_TEMPLATE)
              }
            >
              Download template
            </Button>
            <Upload accept=".csv,text/csv" showUploadList={false} beforeUpload={onFile}>
              <Button variant="primary" icon={<UploadOutlined />}>
                Choose CSV file
              </Button>
            </Upload>
            {fileName && <StatusChip>{fileName}</StatusChip>}
          </Space>
          {fatal && <Alert type="error" showIcon title={fatal} />}
        </Space>
      </Card>

      {kind === 'tests' && parsedTests.length > 0 && (
        <Card>
          <div className="cat-toolbar">
            <h2 className="cat-section-title" style={{ margin: 0 }}>{`Preview - ${parsedTests.length} test(s), ${validTests.length} valid`}</h2>
            <span className="cat-toolbar__grow" />
            <Button variant="primary" disabled={validTests.length === 0 || busy} onClick={importTests}>
              {`Import ${validTests.length} valid test(s)`}
            </Button>
          </div>
          <Table<ParsedTest>
            rowKey="code"
            size="small"
            dataSource={parsedTests}
            pagination={{ pageSize: 15, showSizeChanger: false }}
            columns={[
              { title: 'Code', dataIndex: 'code', width: 110 },
              { title: 'Name', dataIndex: 'name' },
              { title: 'Department', dataIndex: 'department' },
              { title: 'Sample', dataIndex: 'sampleType' },
              { title: 'Price', dataIndex: 'price', width: 80 },
              { title: 'Params', width: 80, render: (_, t) => t.params.length },
              {
                title: 'Action',
                width: 100,
                render: (_, t) =>
                  t.errors.length ? <StatusChip variant="urgent">Error</StatusChip> : existingByCode.has(t.code) ? <StatusChip variant="caution">Update</StatusChip> : <StatusChip variant="success">New</StatusChip>,
              },
              {
                title: 'Problems',
                render: (_, t) => (
                  <Space direction="vertical" size={0}>
                    {t.errors.map((e, i) => (
                      <Typography.Text key={i} type="danger">
                        {e}
                      </Typography.Text>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}

      {kind === 'packages' && parsedPkgs.length > 0 && (
        <Card>
          <div className="cat-toolbar">
            <h2 className="cat-section-title" style={{ margin: 0 }}>{`Preview - ${parsedPkgs.length} package(s), ${validPkgs.length} valid`}</h2>
            <span className="cat-toolbar__grow" />
            <Button variant="primary" disabled={validPkgs.length === 0 || unresolvedPkgTests || busy} onClick={importPackages}>
              {`Import ${validPkgs.length} valid package(s)`}
            </Button>
          </div>
          {unresolvedPkgTests && (
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              title="Some packages refer to tests from an unsaved test import. Import the tests first, then the packages."
            />
          )}
          <Table<ParsedPackage>
            rowKey="row"
            size="small"
            dataSource={parsedPkgs}
            pagination={{ pageSize: 15, showSizeChanger: false }}
            columns={[
              { title: 'Row', dataIndex: 'row', width: 60 },
              { title: 'Code', dataIndex: 'code', width: 110 },
              { title: 'Name', dataIndex: 'name' },
              { title: 'Price', dataIndex: 'price', width: 80 },
              { title: 'Tests', render: (_, p) => p.testCodes.join(', ') },
              {
                title: 'Action',
                width: 100,
                render: (_, p) =>
                  pkgErrors(p).length ? <StatusChip variant="urgent">Error</StatusChip> : packages.some((x) => x.code.toUpperCase() === p.code) ? <StatusChip variant="caution">Update</StatusChip> : <StatusChip variant="success">New</StatusChip>,
              },
              {
                title: 'Problems',
                render: (_, p) => (
                  <Space direction="vertical" size={0}>
                    {pkgErrors(p).map((e, i) => (
                      <Typography.Text key={i} type="danger">
                        {e}
                      </Typography.Text>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  )
}

// Firestore batches hold at most 500 writes.
async function commit(ops: Array<(b: ReturnType<typeof writeBatch>) => void>) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db)
    ops.slice(i, i + 400).forEach((op) => op(batch))
    await batch.commit()
  }
}
