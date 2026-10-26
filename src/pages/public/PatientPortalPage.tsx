import { useEffect, useState } from 'react'
import { Alert, Button, Input, Tag, Typography } from 'antd'
import { LockOutlined, FileTextOutlined } from '@ant-design/icons'
import { listPortalReports, requestPortalOtp, verifyPortalOtp, type PortalReport } from '../../features/report/api'

// Patient portal v2 (PB-13): the patient signs in with a code sent to their phone and sees every report
// the lab holds under that number. Opening a report goes through the normal public report page.
const css = `
.pp { min-height:100vh; background:var(--c-surface); padding:16px; box-sizing:border-box; font-family:Inter,Arial,sans-serif; color:var(--c-on-surface); }
.pp .card { max-width:560px; margin:6vh auto 0; background:var(--c-surface-container-high); border-radius:var(--r-card); border-top:5px solid var(--c-accent); padding:20px; box-sizing:border-box; }
.pp .row { display:flex; gap:10px; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--c-outline-variant, #e2e8f0); }
.pp .row:last-child { border-bottom:0; }
`
const SESSION = 'hcl.portal.session'
const msg = (e: unknown) => ((e as { message?: string }).message ?? 'Something went wrong. Please try again.').replace(/\s*\[\d+\]\s*$/, '')

export default function PatientPortalPage() {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [session, setSession] = useState('')
  const [data, setData] = useState<{ lab: { name: string; phone: string }; reports: PortalReport[] } | null>(null)

  const load = async (sess: string) => {
    try {
      setData(await listPortalReports(sess))
      setSession(sess)
    } catch (e) {
      try { sessionStorage.removeItem(SESSION) } catch { /* storage unavailable */ }
      setSession('')
      setError(msg(e))
    }
  }
  useEffect(() => {
    document.title = 'My reports'
    try {
      const s = sessionStorage.getItem(SESSION)
      if (s) void load(s)
    } catch { /* storage unavailable */ }
  }, [])

  const send = async () => {
    setBusy(true)
    setError('')
    try {
      setSentTo((await requestPortalOtp(phone.trim())).to)
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(false)
    }
  }
  const verify = async () => {
    setBusy(true)
    setError('')
    try {
      const s = await verifyPortalOtp(phone.trim(), code.trim())
      try { sessionStorage.setItem(SESSION, s) } catch { /* storage unavailable */ }
      await load(s)
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pp">
      <style>{css}</style>
      <div className="card">
        {!session || !data ? (
          <>
            <div style={{ textAlign: 'center' }}>
              <LockOutlined style={{ fontSize: 32, color: 'var(--c-accent)' }} />
              <Typography.Title level={4} style={{ marginTop: 8 }}>My lab reports</Typography.Title>
              <Typography.Paragraph type="secondary">Enter the mobile number you gave the lab. We will send you a code.</Typography.Paragraph>
            </div>
            {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
            <Input size="large" inputMode="tel" aria-label="Mobile number" placeholder="10-digit mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} onPressEnter={send} />
            <Button block size="large" loading={busy && !sentTo} disabled={phone.replace(/\D/g, '').length < 10} onClick={send} style={{ marginTop: 10 }}>{sentTo ? 'Send the code again' : 'Send code'}</Button>
            {sentTo && (
              <>
                <Typography.Paragraph type="secondary" style={{ marginTop: 14 }}>If this number has reports, a 6-digit code was sent to {sentTo}.</Typography.Paragraph>
                <Input size="large" inputMode="numeric" aria-label="6-digit code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} onPressEnter={verify} autoComplete="one-time-code" />
                <Button type="primary" block size="large" loading={busy} disabled={code.trim().length !== 6} onClick={verify} style={{ marginTop: 10 }}>Show my reports</Button>
              </>
            )}
          </>
        ) : (
          <>
            <Typography.Title level={4} style={{ marginTop: 0 }}>{data.lab.name}</Typography.Title>
            <Typography.Paragraph type="secondary">{data.reports.length} report{data.reports.length === 1 ? '' : 's'} found.{data.lab.phone ? ` For help call ${data.lab.phone}.` : ''}</Typography.Paragraph>
            {data.reports.length === 0 && <Alert type="info" showIcon message="No reports are ready yet." />}
            {data.reports.map((r) => (
              <div className="row" key={r.orderId}>
                <div>
                  <div><b>{r.patientName}</b> <span style={{ opacity: 0.7 }}>bill {r.billNo}</span></div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>{r.date ? new Date(r.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}{r.tests.length ? ` - ${r.tests.join(', ')}` : ''}</div>
                  <Tag color={r.status === 'final' ? 'green' : 'blue'}>{r.status}</Tag>
                </div>
                <Button type="primary" icon={<FileTextOutlined />} href={`/r/${r.token}?portal=${session}`}>Open</Button>
              </div>
            ))}
            <Button type="link" onClick={() => { try { sessionStorage.removeItem(SESSION) } catch { /* storage unavailable */ } setSession(''); setData(null); setCode(''); setSentTo('') }}>Sign out</Button>
          </>
        )}
      </div>
    </div>
  )
}
