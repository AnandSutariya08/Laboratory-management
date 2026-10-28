import { useMemo, useRef, useState } from 'react'
import { FormSection, SettingRow } from '../../design/FormLayout'
import { App, Checkbox, Progress, Select, Table } from 'antd'
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import { getDoc, limit, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { ref as storageRef, uploadBytes } from 'firebase/storage'
import { functions, LAB_ID, storage } from '../../firebase'
import { useLiveDoc } from '../../hooks/useLive'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { EmptyState } from '../../design/EmptyState'
import { PageHeader } from '../../design/PageHeader'
import { StatusChip } from '../../design/StatusChip'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { useLiveQuery } from '../../hooks/useLive'
import { col, paths } from '../../lib/db'
import { useMasters, usePaymentModes } from '../../lib/masters'
import { downloadCsv } from '../partners/lib/csv'
import { downloadXls, excelDateToIso, readSheetRows, rowsToObjects } from '../../lib/sheet'
import { branchStamp } from '../../lib/activeBranch'
import { docRef } from '../../lib/db'
import type { AgeUnit, Gender, Patient } from '../../types'
import '../../components/billing/billing.css'

const HEADERS = ['first_name', 'last_name', 'gender', 'age', 'age_unit', 'dob', 'country_code', 'phone', 'email', 'address', 'city', 'pincode', 'uhid', 'referring_doctor', 'b2b_centre_code', 'corporate_client', 'rate_list', 'tests', 'discount', 'payment_mode', 'paid_amount', 'collected_at', 'corporate_user']
const MAX_ROWS = 2000

interface Row {
  n: number
  raw: Record<string, string>
  errors: string[]
  warnings: string[]
  corporateUser?: string
  patient?: { firstName: string; lastName: string; gender: Gender; ageValue: number; ageUnit: AgeUnit; dob?: string; phone: string; email: string; address: string; city: string; pincode: string; uhid: string; referrerId?: string; referrerName: string }
  codes: string[]
  dupOf?: Patient // existing patient this row matches (same phone and name)
  extra: { countryCode: string; b2bCentreId?: string; corporateId?: string; rateListId?: string; discount: number; payMode: string; paid: number | null; billDate?: Date }
}

const parseGender = (s: string): Gender | null => {
  const g = s.trim().toLowerCase()
  return g === 'm' || g === 'male' ? 'male' : g === 'f' || g === 'female' ? 'female' : g === 'o' || g === 'other' ? 'other' : null
}
const parseUnit = (s: string): AgeUnit | null => {
  const u = s.trim().toLowerCase()
  if (!u) return 'year'
  return /^y/.test(u) ? 'year' : /^m/.test(u) ? 'month' : /^d/.test(u) ? 'day' : null
}

export default function BulkRegistrationPage() {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const cat = useCatalogueMaps()
  const masters = useMasters()
  const payModes = usePaymentModes()
  const fileRef = useRef<HTMLInputElement>(null)
  const { data: patients } = useLiveQuery<Patient>(query(col(paths.patients), orderBy('createdAt', 'desc'), limit(1000)), [])
  const [rows, setRows] = useState<Row[]>([])
  const [fileName, setFileName] = useState('')
  const [makeBills, setMakeBills] = useState(true)
  const [payMode, setPayMode] = useState<string>('due')
  const [policy, setPolicy] = useState<'skip' | 'attach' | 'create'>(settings.registration.bulkDuplicatePolicy ?? 'skip')
  const [importId, setImportId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const job = useLiveDoc<{ status: string; processed?: number; total?: number; created?: number; skipped?: number; failed?: number; error?: string }>(importId ? docRef('bulkImports', importId) : null, [importId]).data
  const chunks = useLiveQuery<{ rows: { n: number; ok: boolean; text: string }[] }>(importId ? query(col(`bulkImports/${importId}/results`)) : null, [importId]).data
  const resultByRow = useMemo(() => new Map(chunks.flatMap((c) => c.rows ?? []).map((r) => [r.n, r])), [chunks])
  const running = starting || job?.status === 'running' || job?.status === 'queued'
  const finished = job?.status === 'done'
  const done = job?.processed ?? 0
  const [fileHash, setFileHash] = useState('')
  const [rosterClient, setRosterClient] = useState<string | undefined>()

  const testByCode = useMemo(() => {
    const m = new Map<string, { kind: 'test' | 'package'; id: string }>()
    for (const t of cat.tests) m.set(t.code.toLowerCase(), { kind: 'test', id: t.id })
    for (const p of cat.packages) m.set(p.code.toLowerCase(), { kind: 'package', id: p.id })
    return m
  }, [cat.tests, cat.packages])

  const templateRows = [
    HEADERS,
    ['Asha', 'Verma', 'female', '34', 'year', '', '+91', '9876543210', 'asha@example.com', '12 Park Road', 'Pune', '411001', '', '', '', '', '', 'CBC;LFT', '50', 'upi', '500', '2026-10-15', ''],
    ['Rohan', 'Mehta', 'male', '', '', '1990-04-12', '+91', '9123456780', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'EMP-102'],
  ]
  const template = () => downloadCsv('bulk-registration-template', templateRows)
  const templateXls = () => downloadXls('bulk-registration-template', templateRows, 'Registrations')

  const onFile = async (file: File) => {
    let objs: Record<string, string>[]
    try {
      objs = rowsToObjects(await readSheetRows(file))
    } catch (e) {
      return message.error((e as Error).message)
    }
    // Hash of the file content: re-uploading the same file is flagged before anything is written.
    let hash = ''
    try {
      const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      hash = Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch { /* hashing is best effort */ }
    setFileHash(hash)
    processObjs(objs, file.name)
  }

  // Corporate roster: the client's employees become registration rows (checked like any upload).
  const loadRoster = (clientId: string) => {
    const client = masters.corporateClients.find((c) => c.id === clientId)
    if (!client) return
    const emps = client.employees ?? []
    if (emps.length === 0) return message.info('This corporate client has no employees uploaded.')
    const objs = emps.map((e) => {
      const parts = (e.name ?? '').trim().split(/\s+/)
      return {
        first_name: parts[0] ?? '', last_name: parts.slice(1).join(' '), gender: e.gender ?? '', age: e.age ?? '', age_unit: 'year',
        phone: (e.phone ?? '').replace(/\D/g, '').slice(-10), email: e.email ?? '', corporate_client: client.name, corporate_user: e.empId ?? '',
      } as Record<string, string>
    })
    setFileHash('')
    processObjs(objs, `${client.name} roster`)
  }

  const processObjs = (objsAll: Record<string, string>[], name: string) => {
    for (const o of objsAll) {
      if (o.dob) o.dob = excelDateToIso(o.dob)
      if (o.collected_at) o.collected_at = excelDateToIso(o.collected_at)
    }
    const objs = objsAll
    if (objs.length === 0) return message.error('The file has no data rows.')
    if (objs.length > MAX_ROWS) message.warning(`Only the first ${MAX_ROWS} rows are read. Split the file to import more.`)
    const seenPhones = new Set<string>()
    const seenEmp = new Set<string>()
    const out: Row[] = objs.slice(0, MAX_ROWS).map((raw, i) => {
      const errors: string[] = []
      const warnings: string[] = []
      const first = raw.first_name?.trim()
      if (!first) errors.push('First name is required')
      const gender = parseGender(raw.gender ?? '')
      if (!gender) errors.push('Gender must be male, female or other')
      let ageValue = Number(raw.age)
      let ageUnit = parseUnit(raw.age_unit ?? '')
      let dob: string | undefined
      if (raw.dob) {
        const d = dayjs(raw.dob)
        if (!d.isValid() || d.isAfter(dayjs())) errors.push('Date of birth is invalid')
        else {
          dob = d.format('YYYY-MM-DD')
          const y = dayjs().diff(d, 'year')
          const m = dayjs().diff(d, 'month')
          ;[ageValue, ageUnit] = y > 0 ? [y, 'year'] : m > 0 ? [m, 'month'] : [dayjs().diff(d, 'day'), 'day']
        }
      } else if (!raw.age || !Number.isFinite(ageValue) || ageValue < 0 || ageValue > 150) errors.push('Age (or date of birth) is required')
      if (!ageUnit) errors.push('Age unit must be year, month or day')
      const phone = (raw.phone ?? '').replace(/\D/g, '')
      if (settings.registration.requiredFields.includes('phone') && !phone) errors.push('Phone is required')
      else if (phone && !/^\d{10}$/.test(phone)) errors.push('Phone must be 10 digits')
      if (raw.email && !/^\S+@\S+\.\S+$/.test(raw.email)) errors.push('Email is invalid')
      if (raw.pincode && !/^\d{6}$/.test(raw.pincode)) errors.push('Pincode must be 6 digits')
      const nm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
      const empId = (raw.corporate_user ?? '').trim()
      const dupOf = phone ? patients.find((p) => p.phone === phone && nm(`${p.firstName}${p.lastName}`) === nm(`${first ?? ''}${raw.last_name ?? ''}`)) : empId ? patients.find((p) => p.corporateUser === empId && nm(`${p.firstName}${p.lastName}`) === nm(`${first ?? ''}${raw.last_name ?? ''}`)) : undefined
      if (empId && !dupOf && patients.some((p) => p.corporateUser === empId)) warnings.push('Employee ID already registered under another name')
      if (empId && seenEmp.has(empId)) warnings.push('Employee ID repeated in this file')
      if (empId) seenEmp.add(empId)
      if (phone) {
        const dup = seenPhones.has(phone) || patients.some((p) => p.phone === phone)
        seenPhones.add(phone)
        if (dup) warnings.push(dupOf ? 'Already registered (same phone and name)' : 'Phone is already registered')
      }
      const cc = (raw.country_code ?? '').trim()
      const countryCode = cc ? (cc.startsWith('+') ? cc : `+${cc}`) : '+91'
      if (!/^\+\d{1,4}$/.test(countryCode)) errors.push('Country code is invalid')
      const b2bCode = raw.b2b_centre_code?.trim().toLowerCase()
      const b2b = b2bCode ? masters.b2bCentres.find((c) => c.code.toLowerCase() === b2bCode) : undefined
      if (b2bCode && !b2b) errors.push(`Unknown B2B centre code ${raw.b2b_centre_code}`)
      const corpName = raw.corporate_client?.trim().toLowerCase()
      const corp = corpName ? masters.corporateClients.find((c) => c.name.toLowerCase() === corpName) : undefined
      if (corpName && !corp) errors.push(`Unknown corporate client ${raw.corporate_client}`)
      const rlName = raw.rate_list?.trim().toLowerCase()
      const rl = rlName ? [...masters.rateListById.values()].find((r) => r.name.toLowerCase() === rlName) : undefined
      if (rlName && !rl) errors.push(`Unknown rate list ${raw.rate_list}`)
      const discount = raw.discount ? Number(raw.discount) : 0
      if (!Number.isFinite(discount) || discount < 0) errors.push('Discount must be a number (rupees)')
      const pm = (raw.payment_mode ?? '').trim().toLowerCase()
      const mode = pm ? payModes.find((m) => m.value.toLowerCase() === pm || m.label.toLowerCase() === pm)?.value : undefined
      if (pm && !mode) errors.push(`Unknown payment mode ${raw.payment_mode}`)
      const paid = raw.paid_amount ? Number(raw.paid_amount) : null
      if (paid !== null && (!Number.isFinite(paid) || paid < 0)) errors.push('Paid amount must be a number (rupees)')
      let billDate: Date | undefined
      if (raw.collected_at) {
        const d = dayjs(raw.collected_at)
        if (!d.isValid() || d.isAfter(dayjs())) errors.push('Collected-at date is invalid')
        else billDate = d.toDate()
      }
      const docName = raw.referring_doctor?.trim().toLowerCase()
      const doctor = docName ? masters.doctors.find((d) => d.name.toLowerCase() === docName) : undefined
      if (docName && !doctor) warnings.push('Referring doctor not found: saved as plain text')
      const codes = (raw.tests ?? '').split(/[;|]/).map((c) => c.trim()).filter(Boolean)
      for (const c of codes) if (!testByCode.has(c.toLowerCase())) errors.push(`Unknown test code ${c}`)
      return {
        n: i + 2,
        corporateUser: (raw.corporate_user ?? '').trim() || undefined,
        raw,
        errors,
        warnings,
        codes,
        dupOf,
        extra: { countryCode, b2bCentreId: b2b?.id, corporateId: corp?.id, rateListId: rl?.id, discount, payMode: mode ?? '', paid, billDate },
        patient: errors.length || !gender || !ageUnit
          ? undefined
          : {
              firstName: first, lastName: (raw.last_name ?? '').trim(), gender, ageValue, ageUnit, dob, phone,
              email: (raw.email ?? '').trim(), address: raw.address ?? '', city: raw.city ?? '', pincode: raw.pincode ?? '',
              uhid: raw.uhid ?? '', referrerId: doctor?.id, referrerName: doctor?.name ?? raw.referring_doctor ?? '',
            },
      }
    })
    setRows(out)
    setFileName(name)
    setImportId(null)
  }

  const valid = rows.filter((r) => r.patient)
  const invalid = rows.length - valid.length
  const dupRows = valid.filter((r) => r.dupOf).length

  const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  // Normalised CSV of the rows that passed the checks: the server job reads this file, not the screen.
  const buildCsv = () => {
    const head = ['n', 'first_name', 'last_name', 'gender', 'age_value', 'age_unit', 'dob', 'country_code', 'phone', 'email', 'address', 'city', 'pincode', 'uhid', 'referrer_id', 'referrer_name', 'b2b_id', 'b2b_name', 'corporate_id', 'corporate_name', 'corporate_user', 'rate_list_id', 'codes', 'discount', 'pay_mode', 'paid_amount', 'bill_date', 'dup_of', 'dup_no']
    const lines = valid.map((r) => {
      const p = r.patient!
      const b2b = masters.b2bCentres.find((c) => c.id === r.extra.b2bCentreId)
      const corp = masters.corporateClients.find((c) => c.id === r.extra.corporateId)
      return [r.n, p.firstName, p.lastName, p.gender, p.ageValue, p.ageUnit, p.dob ?? '', r.extra.countryCode, p.phone, p.email, p.address, p.city, p.pincode, p.uhid, p.referrerId ?? '', p.referrerName, b2b?.id ?? '', b2b?.name ?? '', corp?.id ?? '', corp?.name ?? '', r.corporateUser ?? '', r.extra.rateListId ?? '', r.codes.join(';'), r.extra.discount, r.extra.payMode, r.extra.paid ?? '', r.extra.billDate ? r.extra.billDate.toISOString() : '', r.dupOf?.id ?? '', r.dupOf?.patientNo ?? ''].map(csvCell).join(',')
    })
    return [head.map(csvCell).join(','), ...lines].join('\n')
  }

  const callJob = (id: string) =>
    httpsCallable(functions, 'runBulkRegistration', { timeout: 3_600_000 })({ labId: LAB_ID, importId: id }).catch((e: Error) => {
      message.error(`The import stopped: ${e.message}. Use Resume to continue.`)
    })

  const run = async () => {
    if (!profile) return
    let id = fileHash || `manual-${Date.now().toString(36)}`
    // Idempotency: the same file content is not imported twice unless the user confirms.
    if (fileHash) {
      try {
        const prev = await getDoc(docRef<{ at?: { toDate?: () => Date }; finishedAt?: { toDate?: () => Date }; fileName?: string; created?: number; status?: string }>('bulkImports', fileHash))
        if (prev.exists() && prev.data().status && prev.data().status !== 'done') {
          // an earlier run of this same file did not finish: continue it
          setImportId(fileHash)
          setStarting(true)
          void callJob(fileHash).finally(() => setStarting(false))
          return
        }
        if (prev.exists()) {
          const when = (prev.data().finishedAt ?? prev.data().at)?.toDate?.()
          const go = await new Promise<boolean>((resolve) =>
            modal.confirm({
              title: 'This file was imported before',
              content: `${prev.data().fileName ?? 'A file'} with identical content was imported${when ? ` on ${dayjs(when).format('DD MMM YYYY HH:mm')}` : ''} (${prev.data().created ?? 0} patients). Importing again may create duplicates.`,
              okText: 'Import again', cancelText: 'Cancel',
              onOk: () => resolve(true), onCancel: () => resolve(false),
            }),
          )
          if (!go) return
          id = `${fileHash.slice(0, 48)}-${Date.now().toString(36)}`
        }
      } catch { /* the check is best effort */ }
    }
    setStarting(true)
    try {
      const path = `labs/${LAB_ID}/bulk/${id}.csv`
      await uploadBytes(storageRef(storage, path), new Blob([buildCsv()], { type: 'text/csv' }), { contentType: 'text/csv' })
      await setDoc(docRef('bulkImports', id), {
        ...branchStamp(), fileName, rows: valid.length, by: profile.uid, status: 'queued', csvPath: path, processed: 0, created: 0, skipped: 0, failed: 0, createdAt: serverTimestamp(),
        options: {
          makeBills, payMode, policy,
          uniqueContact: !!settings.registration.uniqueContact, autoUhid: settings.registration.uhidMode === 'auto',
          dispatchModes: settings.dispatchDefaults, dispatchModesB2b: settings.registration.dispatchDefaultsB2b ?? [],
          autoRateList: settings.registration.autoRateList, branchId: branchStamp().branchId,
        },
      })
      setImportId(id)
      void callJob(id).finally(() => setStarting(false))
    } catch (e) {
      setStarting(false)
      message.error(`Could not start the import: ${(e as Error).message}`)
    }
  }

  const created = job?.created ?? 0
  const failed = job?.failed ?? 0

  const downloadErrors = () =>
    downloadCsv('bulk-registration-errors', [
      ['row', ...HEADERS, 'error'],
      ...rows.filter((r) => r.errors.length || (resultByRow.get(r.n) && !resultByRow.get(r.n)!.ok)).map((r) => [r.n, ...HEADERS.map((h) => r.raw[h] ?? ''), [...r.errors, resultByRow.get(r.n) && !resultByRow.get(r.n)!.ok ? resultByRow.get(r.n)!.text : ''].filter(Boolean).join('; ')]),
    ])

  return (
    <div>
      <PageHeader
        title="Bulk Registration"
        subtitle="Register many patients at once from an Excel or CSV file, or a corporate roster, optionally with bills."
        actions={
          <>
            <Button icon={<DownloadOutlined />} onClick={template}>Template (CSV)</Button>
            <Button icon={<DownloadOutlined />} onClick={templateXls}>Template (Excel)</Button>
            <Button variant="primary" icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>Upload file</Button>
          </>
        }
      />
      <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx,.xml,text/csv" hidden aria-label="Upload spreadsheet file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }} />

      {rows.length === 0 ? (
        <Card padding={0}>
          <EmptyState
            icon={<UploadOutlined />}
            title="Upload a file to begin"
            description="Download the template, fill one patient per row (tests as codes separated by semicolons), then upload it as .xlsx, .xls or .csv. Rows are checked before anything is saved. Up to 2000 rows per file."
            action={
              <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
                <Button onClick={template}>Download template</Button>
                <Select aria-label="Load a corporate roster" allowClear showSearch optionFilterProp="label" placeholder="Or load a corporate roster" style={{ width: 'min(100%, 280px)' }} value={rosterClient}
                  options={masters.corporateClients.filter((c) => (c.employees?.length ?? 0) > 0).map((c) => ({ value: c.id, label: `${c.name} (${c.employees.length})` }))}
                  onChange={(v) => { setRosterClient(v); if (v) loadRoster(v) }} />
              </div>
            }
          />
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Card padding={16}>
            <div className="bill-row" style={{ marginTop: 0 }}>
              <b>{fileName}</b>
              <StatusChip variant="success">{valid.length} ready</StatusChip>
              {invalid > 0 && <StatusChip variant="urgent">{invalid} with errors</StatusChip>}
              <span style={{ flex: 1 }} />
              <Button disabled={running} onClick={() => { setRows([]); setFileName('') }}>Clear</Button>
              <Button variant="primary" disabled={running || finished || job?.status === 'failed' || valid.length === 0} onClick={run}>
                Register {valid.length} patient{valid.length === 1 ? '' : 's'}
              </Button>
            </div>
            <FormSection title="Import options" description="Choose how duplicates and bills are handled before registering.">
              {dupRows > 0 && (
                <SettingRow label="Duplicate patients" help={`${dupRows} row${dupRows === 1 ? '' : 's'} match an existing patient.`}>
                  <Select aria-label="Duplicate patients" style={{ width: 'min(100%, 320px)' }} value={policy} onChange={setPolicy}
                    options={[{ value: 'skip', label: `Duplicates (${dupRows}): skip` }, { value: 'attach', label: `Duplicates (${dupRows}): add bill to existing` }, { value: 'create', label: `Duplicates (${dupRows}): create new patient` }]} />
                </SettingRow>
              )}
              <SettingRow label="Create bills" help="Bill rows that have test codes.">
                <Checkbox checked={makeBills} onChange={(e) => setMakeBills(e.target.checked)}>Create bills for rows with test codes</Checkbox>
              </SettingRow>
              {makeBills && (
                <SettingRow label="Payment for created bills" help="Leave the bills due, or mark them paid in full.">
                  <Select aria-label="Payment for created bills" style={{ width: 'min(100%, 320px)' }} value={payMode} onChange={setPayMode}
                    options={[{ value: 'due', label: 'Leave bills due' }, ...payModes.map((m) => ({ value: m.value, label: `Paid in full: ${m.label}` }))]} />
                </SettingRow>
              )}
            </FormSection>
            {(running || finished || job?.status === 'failed') && (
              <div style={{ marginTop: 'var(--s-3)' }}>
                <Progress percent={Math.round((done / Math.max(1, job?.total ?? valid.length)) * 100)} status={job?.status === 'failed' ? 'exception' : running ? 'active' : 'success'} />
                {job?.status === 'failed' && importId && (
                  <div className="bill-row"><span role="alert">{job.error ?? 'The import stopped.'}</span><Button onClick={() => { setStarting(true); void callJob(importId).finally(() => setStarting(false)) }}>Resume</Button></div>
                )}
                {finished && (
                  <div className="bill-row">
                    <span role="status">Done: {created} registered, {job?.skipped ?? 0} skipped, {failed} failed, {invalid} not sent (errors in the file). It runs on the server, so you can leave this page.</span>
                    {(failed > 0 || invalid > 0) && <Button onClick={downloadErrors}>Download error report</Button>}
                    <Button onClick={() => navigate('/patients')}>Open patient list</Button>
                  </div>
                )}
              </div>
            )}
          </Card>
          <Card padding={0}>
            <Table<Row>
              size="small"
              rowKey="n"
              dataSource={rows}
              pagination={{ pageSize: 25, hideOnSinglePage: true }}
              columns={[
                { title: 'Row', dataIndex: 'n', width: 56 },
                { title: 'Name', render: (_, r) => `${r.raw.first_name ?? ''} ${r.raw.last_name ?? ''}`.trim() },
                { title: 'Gender / age', render: (_, r) => `${r.raw.gender ?? ''} ${r.raw.dob || `${r.raw.age ?? ''} ${r.raw.age_unit ?? ''}`}` },
                { title: 'Phone', render: (_, r) => r.raw.phone },
                { title: 'Tests', render: (_, r) => r.codes.join(', ') || '-' },
                {
                  title: 'Status',
                  render: (_, r) =>
                    resultByRow.get(r.n) ? (
                      <StatusChip variant={resultByRow.get(r.n)!.ok ? 'success' : 'urgent'}>{resultByRow.get(r.n)!.text}</StatusChip>
                    ) : r.errors.length ? (
                      <StatusChip variant="urgent">{r.errors.join('; ')}</StatusChip>
                    ) : r.warnings.length ? (
                      <StatusChip variant="caution">Ready · {r.warnings.join('; ')}</StatusChip>
                    ) : (
                      <StatusChip variant="success">Ready</StatusChip>
                    ),
                },
              ]}
            />
          </Card>
        </div>
      )}
    </div>
  )
}
