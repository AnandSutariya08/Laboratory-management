import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Alert, Button, Input, Tag, Typography } from 'antd'
import { LockOutlined, PrinterOutlined } from '@ant-design/icons'
import { getPublicReport } from '../../lib/messaging'
import { resolveRange, ageInDays } from '../../lib/results'
import { plainNote } from '../../features/smart-report/plain'
import ReportSheet from '../../features/report/ReportSheet'
import { qrDataUrl } from '../../features/report/qr'
import { requestReportOtp } from '../../features/report/api'
import { payloadToModel, type ReportPayload } from '../../features/report/payload'
import type { ReportOpts } from '../../features/report/model'
import type { Parameter, ReportStatus } from '../../types'

interface StatusPayload {
  mode: 'status'
  lab: { name: string; address: string; phone: string; email: string; logoDataUrl: string }
  patientName: string
  billNo: string
  reportStatus: ReportStatus
  tests: { name: string; ready: boolean }[]
  expiresAt: string | null
  factors?: { otp: 'off' | 'optional' | 'required'; pin: boolean; legacy: boolean }
}
type FullPayload = ReportPayload
type Factor = 'otp' | 'pin' | 'other'

const css = `
.pr { min-height:100vh; background:var(--c-surface); padding:16px; box-sizing:border-box; font-family:Inter,Arial,sans-serif; color:var(--c-on-surface); }
.pr .card { max-width:520px; margin:8vh auto 0; background:var(--c-surface-container-high); border-radius:var(--r-card); border-top:5px solid var(--c-accent); box-shadow:0 2px 14px var(--c-primary)22; padding:20px; box-sizing:border-box; text-align:center; }
.pr .tl { text-align:left; margin:12px 0; display:grid; gap:4px; font-size:13px; }
.pr .sheetwrap { overflow-x:auto; }
.pr .smart { max-width:210mm; margin:0 auto 16px; background:#fff; color:#111; border-radius:8px; padding:14px 18px; text-align:left; font-size:13px; }
.pr .smart h3 { margin:0 0 6px; color:#0369A1; }
.pr .smart li { margin-bottom:6px; }
@media print { .pr { background:#fff; padding:0; } .no-print { display:none !important; } .pr .smart { box-shadow:none; } }
`

export default function PublicReportPage() {
  const { token = '' } = useParams()
  const [sp] = useSearchParams()
  const [code, setCode] = useState('')
  const [factor, setFactor] = useState<Factor>('otp')
  const [otpSentTo, setOtpSentTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; fatal: boolean } | null>(null)
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [report, setReport] = useState<FullPayload | null>(null)

  const fail = (e: unknown) => {
    const err = e as { code?: string; message?: string }
    const c = err.code ?? ''
    const fatal = c.endsWith('not-found') || c.endsWith('resource-exhausted') || c.endsWith('failed-precondition')
    const text = (err.message || '').replace(/\s*\[\d+\]\s*$/, '')
    setError({ text: text || 'Something went wrong. Please try again.', fatal })
  }

  // The page opens on a status view; clinical values need a second factor. Arriving from the patient portal
  // (?portal=session) the phone code already proved who the patient is.
  useEffect(() => {
    document.title = 'Lab report'
    let m = document.querySelector('meta[name="robots"]')
    if (!m) {
      m = document.createElement('meta')
      m.setAttribute('name', 'robots')
      document.head.appendChild(m)
    }
    m.setAttribute('content', 'noindex, nofollow')
    const portal = sp.get('portal')
    if (portal) getPublicReport({ token, portal } as never).then((r) => setReport(r as FullPayload)).catch(fail)
    else
      getPublicReport({ token })
        .then((r) => {
          const st = r as StatusPayload
          setStatus(st)
          const f = st.factors
          setFactor(f && f.otp !== 'off' ? 'otp' : f?.pin ? 'pin' : 'other')
        })
        .catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const open = async (extra: Record<string, string>) => {
    setBusy(true)
    setError(null)
    try {
      setReport((await getPublicReport({ token, ...extra } as never)) as FullPayload)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const submit = () => {
    if (!code.trim()) return
    void open(factor === 'otp' ? { otp: code.trim() } : factor === 'pin' ? { pin: code.trim() } : { verify: code.trim() })
  }
  const sendCode = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await requestReportOtp(token)
      setOtpSentTo(r.to)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const model = useMemo(() => (report ? payloadToModel(report, report.settings.reportDetails.showQr === false ? '' : qrDataUrl(`${window.location.origin}/r/${token}`)) : null), [report, token])
  const rd = model?.rd

  const smartOn = sp.get('smart') === '1'
  const attention = useMemo(() => {
    if (!report || !smartOn) return []
    // A saved smart copy (written by the lab) is what the patient sees; without one it is worked out here.
    if (report.smart?.notes?.length) return report.smart.notes
    const age = ageInDays(report.order.ageValue, report.order.ageUnit)
    return report.results.flatMap((r) => {
      const t = report.tests.find((x) => x.id === r.testId)
      if (!t) return []
      return t.parameters
        .filter((p: Parameter) => r.values?.[p.key]?.abnormal || r.values?.[p.key]?.critical)
        .map((p: Parameter) => plainNote(p, r.values[p.key], resolveRange(p, age, String(report.order.gender ?? '')).text))
    })
  }, [report, smartOn])

  if (!report || !model || !rd) {
    const f = status?.factors
    const tabs: { v: Factor; label: string }[] = []
    if (f && f.otp !== 'off') tabs.push({ v: 'otp', label: 'Code on my phone' })
    if (f?.pin) tabs.push({ v: 'pin', label: 'Bill PIN' })
    if (!f || f.legacy) tabs.push({ v: 'other', label: 'Other details' })
    return (
      <div className="pr">
        <style>{css}</style>
        <div className="card">
          <LockOutlined style={{ fontSize: 32, color: 'var(--c-accent)' }} />
          <Typography.Title level={4} style={{ marginTop: 8 }}>{status?.lab.name || 'View your lab report'}</Typography.Title>
          {status && (
            <>
              <Typography.Paragraph>
                Report for <b>{status.patientName}</b> (bill {status.billNo}): <Tag color={status.reportStatus === 'final' ? 'green' : 'blue'}>{status.reportStatus}</Tag>
              </Typography.Paragraph>
              <div className="tl">
                {status.tests.map((t, i) => (
                  <div key={i}>{t.ready ? 'Ready' : 'In progress'}: {t.name}</div>
                ))}
              </div>
            </>
          )}
          {error && <Alert type="error" showIcon message={error.text} style={{ marginBottom: 12, textAlign: 'left' }} />}
          {!error?.fatal && status && (
            <>
              <div role="tablist" aria-label="How to open the report" style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                {tabs.map((t) => (
                  <Button key={t.v} role="tab" aria-selected={factor === t.v} type={factor === t.v ? 'primary' : 'default'} onClick={() => { setFactor(t.v); setCode(''); setError(null) }}>{t.label}</Button>
                ))}
              </div>
              {factor === 'otp' && (
                <>
                  <Typography.Paragraph type="secondary">
                    {otpSentTo ? `We sent a 6-digit code to ${otpSentTo}. Enter it below.` : 'We will send a 6-digit code to the phone number the lab has for you.'}
                  </Typography.Paragraph>
                  <Button block loading={busy && !otpSentTo} onClick={sendCode} style={{ marginBottom: 12 }}>{otpSentTo ? 'Send the code again' : 'Send me a code'}</Button>
                </>
              )}
              {factor === 'pin' && <Typography.Paragraph type="secondary">Enter the PIN printed on your bill.</Typography.Paragraph>}
              {factor === 'other' && <Typography.Paragraph type="secondary">Enter the last 4 digits of your phone number, your patient number or your date of birth (DD/MM/YYYY).</Typography.Paragraph>}
              <Input size="large" value={code} inputMode={factor === 'other' ? 'text' : 'numeric'} onChange={(e) => setCode(e.target.value)} onPressEnter={submit} aria-label={factor === 'otp' ? 'One-time code' : factor === 'pin' ? 'Bill PIN' : 'Verification detail'}
                placeholder={factor === 'otp' ? '6-digit code' : factor === 'pin' ? 'Bill PIN' : 'Last 4 phone digits, patient number or date of birth'} autoComplete="one-time-code" />
              <Button type="primary" size="large" block loading={busy && (factor !== 'otp' || !!otpSentTo)} onClick={submit} style={{ marginTop: 12 }}>View report</Button>
            </>
          )}
        </div>
      </div>
    )
  }

  const opts: ReportOpts = {
    letterhead: sp.get('lh') === '1',
    letterheadId: sp.get('lh') && sp.get('lh') !== '1' ? (sp.get('lh') as string) : undefined,
    header: rd.showHeader,
    footer: rd.showFooter,
    perDept: rd.pageBreakPerDepartment,
    perTest: false,
    compare: false,
    abnSummary: false,
    qr: rd.showQr,
    barcode: rd.showBarcode,
    pageSize: rd.pageSize,
    picked: (sp.get('t') ?? '').split(',').filter(Boolean),
    interpretation: null,
    duplicate: false,
  }

  return (
    <div className="pr">
      <style>{css}</style>
      <div className="no-print" style={{ textAlign: 'right', maxWidth: '210mm', margin: '0 auto 8px' }}>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>Print / Save as PDF</Button>
      </div>
      {smartOn && (
        <div className="smart">
          <h3>Your report in plain words</h3>
          {report.smart?.stale && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="This summary was written before your report was corrected. Please read the full report below and ask the lab if unsure." />}
          {attention.length === 0 ? (
            <p>All your approved results are within the usual ranges.</p>
          ) : (
            <ul>{attention.map((a, i) => <li key={i}><b>{a.label}.</b> {a.text}</li>)}</ul>
          )}
          <small>This summary is general information and does not replace advice from your doctor.</small>
        </div>
      )}
      <div className="sheetwrap">
        <ReportSheet model={model} opts={opts} />
      </div>
      {report.verification?.sha256 && (
        <div className="no-print" style={{ maxWidth: '210mm', margin: '8px auto 0', fontSize: 12, textAlign: 'center' }}>
          <Tag color="green">Verified</Tag>
          Issued by {report.lab.name}. Version {report.verification.revision}, fingerprint <code>{report.verification.sha256.slice(0, 16)}</code>
          {report.verification.at ? `, recorded ${new Date(report.verification.at).toLocaleString()}` : ''}.
        </div>
      )}
    </div>
  )
}
