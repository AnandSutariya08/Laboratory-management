import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, Button, Checkbox, Input, Typography } from 'antd'
import { getFormFSign, submitFormFSign } from '../report/api'
import SignaturePad from './SignaturePad'

// Public page the patient opens from the Form F link or QR code (no login). The token is checked on the server.
type Loaded = Awaited<ReturnType<typeof getFormFSign>>
const FIELD: [string, string][] = [
  ['patientName', 'Name'], ['age', 'Age'], ['guardianName', 'Husband or father'], ['address', 'Address'], ['lmp', 'Last menstrual period'],
  ['childrenSons', 'Living sons'], ['childrenDaughters', 'Living daughters'], ['indication', 'Indication'], ['procedure', 'Procedure'], ['referrerName', 'Referring doctor'], ['performedBy', 'Doctor performing the scan'],
]

export default function FormFSignPage() {
  const { token = '' } = useParams()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [sig, setSig] = useState('')
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    document.title = 'Sign Form F'
    getFormFSign(token).then((d) => { setData(d); setName(d.patientName) }).catch((e: { message?: string }) => setError((e.message ?? 'This link is not valid.').replace(/\s*\[\d+\]\s*$/, '')))
  }, [token])

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await submitFormFSign({ token, signatureDataUrl: sig, signerName: name.trim(), agree })
      setDone(true)
    } catch (e) {
      setError(((e as { message?: string }).message ?? 'Could not submit').replace(/\s*\[\d+\]\s*$/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--c-surface)', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 560, margin: '4vh auto', background: 'var(--c-surface-container-high)', borderRadius: 'var(--r-card)', padding: 20, borderTop: '5px solid var(--c-accent)' }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>{data?.lab.name ?? 'Form F'}</Typography.Title>
        {done ? (
          <Alert type="success" showIcon message="Thank you. Your signature has been recorded and the form is complete." />
        ) : (
          <>
            {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
            {data && (
              <>
                <Typography.Paragraph type="secondary">Please check the details below. They were filled in at the clinic. Then sign to confirm.</Typography.Paragraph>
                <div style={{ display: 'grid', gap: 4, fontSize: 14, marginBottom: 16 }}>
                  {FIELD.map(([k, label]) => (data.fields[k] ? <div key={k}><span style={{ opacity: 0.7 }}>{label}: </span><b>{data.fields[k]}</b></div> : null))}
                </div>
                <label htmlFor="ffs-name">Your full name</label>
                <Input id="ffs-name" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 12 }} />
                <SignaturePad onChange={setSig} />
                <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ margin: '12px 0' }}>
                  The details are correct. I understand that the sex of the foetus will not be disclosed.
                </Checkbox>
                <Button type="primary" size="large" block loading={busy} disabled={!sig || !agree || name.trim().length < 2} onClick={submit}>Sign and submit</Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
