import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, Button, Checkbox, Input, Typography } from 'antd'
import { getExternalOpinion, submitExternalOpinion } from './api'
import { radHtml } from './richtext'

// Public page for an outside consultant (RAD-17): reads the study text and images, writes an opinion, may co-sign.
type Loaded = Awaited<ReturnType<typeof getExternalOpinion>>
const msg = (e: unknown) => ((e as { message?: string }).message ?? 'Something went wrong.').replace(/\s*\[\d+\]\s*$/, '')

export default function ExternalOpinionPage() {
  const { token = '' } = useParams()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [regNo, setRegNo] = useState('')
  const [opinion, setOpinion] = useState('')
  const [cosign, setCosign] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    document.title = 'Second opinion'
    getExternalOpinion(token).then((d) => { setData(d); setName(d.consultant) }).catch((e) => setError(msg(e)))
  }, [token])

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await submitExternalOpinion({ token, name: name.trim(), regNo: regNo.trim(), opinion: opinion.trim(), cosign })
      setDone(true)
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(false)
    }
  }
  const block = (title: string, html: string) => html.trim() ? <div style={{ marginBottom: 10 }}><b>{title}</b><div dangerouslySetInnerHTML={{ __html: radHtml(html) }} /></div> : null

  return (
    <div style={{ minHeight: '100vh', background: 'var(--c-surface)', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 720, margin: '3vh auto', background: 'var(--c-surface-container-high)', borderRadius: 'var(--r-card)', padding: 20, borderTop: '5px solid var(--c-accent)' }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>{data?.lab.name ?? 'Second opinion'}</Typography.Title>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        {done ? <Alert type="success" showIcon message="Thank you. Your opinion was sent to the lab." /> : data && (
          <>
            <p><b>{data.study.name}</b>{data.study.modality ? ` (${data.study.modality})` : ''}{data.study.bodyPart ? `, ${data.study.bodyPart}` : ''}. Patient {data.patient.initials}, {data.patient.age}, {data.patient.gender}.</p>
            {data.note && <Alert type="info" showIcon message={data.note} style={{ marginBottom: 12 }} />}
            {block('Technique', data.technique)}{block('Findings', data.findings)}{block('Impression', data.impression)}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 16px' }}>
              {data.images.map((im, i) => <figure key={i} style={{ margin: 0 }}><img src={im.dataUrl} alt={im.caption || `Key image ${i + 1}`} style={{ maxHeight: 180 }} /><figcaption style={{ fontSize: 11 }}>{im.caption}</figcaption></figure>)}
            </div>
            <label htmlFor="eo-name">Your name</label>
            <Input id="eo-name" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 8 }} />
            <label htmlFor="eo-reg">Registration number (optional)</label>
            <Input id="eo-reg" value={regNo} onChange={(e) => setRegNo(e.target.value)} style={{ marginBottom: 8 }} />
            <label htmlFor="eo-op">Your opinion</label>
            <Input.TextArea id="eo-op" rows={6} value={opinion} onChange={(e) => setOpinion(e.target.value)} />
            <Checkbox checked={cosign} onChange={(e) => setCosign(e.target.checked)} style={{ margin: '12px 0' }}>I co-sign this report. My name will print with it.</Checkbox>
            <Button type="primary" size="large" block loading={busy} disabled={name.trim().length < 2 || opinion.trim().length < 3} onClick={submit}>Send opinion</Button>
          </>
        )}
      </div>
    </div>
  )
}
