import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Checkbox, Input, Modal, Select } from 'antd'
import { CheckCircleOutlined, LinkOutlined, QrcodeOutlined } from '@ant-design/icons'
import { can, useAuth } from '../../auth/AuthProvider'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { useLiveDoc } from '../../hooks/useLive'
import { dialogWidth } from '../../design/dialog'
import { createFormFLink } from '../report/api'
import { qrDataUrl } from '../report/qr'
import type { Order } from '../../types'
import SignaturePad from './SignaturePad'
import { completeFormFInPerson, formFDoc, INDICATIONS, markFormFFilled, missingFormF, saveFormF, type FormFDoc, type FormFFields } from './lib'

const LABEL: Record<keyof FormFFields, string> = {
  patientName: 'Name of the pregnant woman', age: 'Age (years)', guardianName: 'Husband or father name', address: 'Address', lmp: 'Last menstrual period',
  childrenSons: 'Living sons', childrenDaughters: 'Living daughters', lastChildAge: 'Age of the last child', previousProcedures: 'Earlier ultrasound or invasive procedures',
  geneticHistory: 'Family history of genetic disease or mental disability', indication: 'Indication for the ultrasound', procedure: 'Procedure to be carried out',
  referrerName: 'Referring doctor', referrerAddress: 'Referring doctor address', performedBy: 'Doctor performing the scan', declaration: 'Declaration',
}

// PCPNDT Form F for one bill: capture, sign in person or by a link / QR the patient opens on their phone,
// or mark a paper form as filled. The ultrasound report stays blocked until it is complete.
export default function FormFModal({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const canEdit = can(profile, 'billing.edit') || can(profile, 'results.enter')
  const { data: saved } = useLiveDoc<FormFDoc>(open ? formFDoc(order.id) : null, [open, order.id])
  const [f, setF] = useState<Partial<FormFFields>>({})
  const [sig, setSig] = useState('')
  const [signer, setSigner] = useState('')
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [paperNote, setPaperNote] = useState('')

  useEffect(() => {
    if (!open) return
    setF({ patientName: order.patientName, age: order.ageUnit === 'year' ? String(order.ageValue) : '', referrerName: order.referrerName && order.referrerName !== 'Self' ? order.referrerName : '', declaration: false, ...(saved?.fields ?? {}) })
    setSigner(saved?.signerName ?? order.patientName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, saved?.fields, order.id])

  const status = order.formFStatus === 'complete' ? 'complete' : saved?.status ?? 'draft'
  const done = status === 'complete'
  const missing = useMemo(() => missingFormF(f), [f])
  const set = (k: keyof FormFFields, v: string | boolean) => setF((cur) => ({ ...cur, [k]: v }))
  const field = (k: keyof FormFFields, extra?: { area?: boolean; type?: string }) => (
    <div className="st-field" style={{ display: 'grid', gap: 2 }}>
      <label htmlFor={`ff-${k}`}>{LABEL[k]}</label>
      {extra?.area ? (
        <Input.TextArea id={`ff-${k}`} rows={2} disabled={done || !canEdit} value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value)} />
      ) : (
        <Input id={`ff-${k}`} type={extra?.type} disabled={done || !canEdit} value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value)} />
      )}
    </div>
  )

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      message.success(ok)
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }
  const by = profile?.uid ?? ''

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={dialogWidth(760)} destroyOnHidden title={`PCPNDT Form F - ${order.patientName} (${order.billNo})`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <StatusChip variant={done ? 'success' : status === 'awaitingSignature' ? 'info' : 'caution'}>{done ? 'Complete' : status === 'awaitingSignature' ? 'Waiting for the patient to sign' : 'Not complete'}</StatusChip>
        {saved?.manual && <StatusChip variant="neutral">Paper form on file</StatusChip>}
        {saved?.signedVia && <span style={{ opacity: 0.7, fontSize: 12 }}>Signed {saved.signedVia === 'link' ? 'on the patient phone' : 'at the desk'} by {saved.signerName}</span>}
      </div>
      {!done && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="The ultrasound report cannot be printed, sent or approved until Form F is complete." />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {field('patientName')}{field('age')}{field('guardianName')}{field('lmp', { type: 'date' })}
        {field('childrenSons')}{field('childrenDaughters')}{field('lastChildAge')}
      </div>
      <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        {field('address', { area: true })}
        {field('previousProcedures', { area: true })}
        {field('geneticHistory', { area: true })}
        <div style={{ display: 'grid', gap: 2 }}>
          <label htmlFor="ff-indication">{LABEL.indication}</label>
          <Select id="ff-indication" disabled={done || !canEdit} value={f.indication || undefined} onChange={(v) => set('indication', v)} options={INDICATIONS.map((v) => ({ value: v, label: v }))} />
        </div>
        {field('procedure')}{field('referrerName')}{field('referrerAddress')}{field('performedBy')}
        <Checkbox disabled={done || !canEdit} checked={!!f.declaration} onChange={(e) => set('declaration', e.target.checked)}>
          The patient has been told that the lab does not and will not disclose the sex of the foetus.
        </Checkbox>
      </div>

      {!done && canEdit && (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <Button disabled={busy} onClick={() => run(() => saveFormF(order, f, by), 'Form F saved')}>Save draft</Button>
          </div>
          <h3 style={{ marginTop: 20 }}>Signature</h3>
          {missing.length > 0 && <div style={{ opacity: 0.7, fontSize: 12 }}>Still to fill: {missing.map((k) => LABEL[k as keyof FormFFields]).join(', ')}.</div>}
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <label htmlFor="ff-signer">Name of the signer</label>
            <Input id="ff-signer" value={signer} onChange={(e) => setSigner(e.target.value)} />
            <SignaturePad onChange={setSig} />
            <Button
              variant="primary"
              icon={<CheckCircleOutlined />}
              disabled={busy || missing.length > 0 || !f.declaration || !sig || signer.trim().length < 2}
              onClick={() => run(async () => { await completeFormFInPerson(order, f, sig, signer.trim(), by); onClose() }, 'Form F signed and complete')}
            >
              Sign and complete
            </Button>
          </div>
          <h3 style={{ marginTop: 20 }}>Or let the patient sign on their phone</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              icon={<LinkOutlined />}
              disabled={busy || missing.length > 0 || !f.declaration}
              onClick={() => run(async () => { await saveFormF(order, f, by); setLink(await createFormFLink(order.id)) }, 'Signing link created')}
            >
              Create link and QR
            </Button>
            {link && (
              <>
                <Input readOnly style={{ flex: 1, minWidth: 240 }} value={link.url} aria-label="Signing link" onFocus={(e) => e.target.select()} />
                <Button onClick={() => void navigator.clipboard?.writeText(link.url).then(() => message.success('Link copied'))}>Copy</Button>
              </>
            )}
          </div>
          {link && (
            <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
              <img src={qrDataUrl(link.url)} alt="QR code of the signing link" width={140} height={140} />
              <div style={{ opacity: 0.7, fontSize: 12 }}><QrcodeOutlined /> Valid until {new Date(link.expiresAt).toLocaleString()}. The status here updates when the patient signs.</div>
            </div>
          )}
          <h3 style={{ marginTop: 20 }}>Paper form already filled</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input placeholder="Where the paper form is kept (register no., file)" value={paperNote} onChange={(e) => setPaperNote(e.target.value)} />
            <Button disabled={busy || paperNote.trim().length < 3} onClick={() => run(async () => { await markFormFFilled(order, true, paperNote.trim(), by); onClose() }, 'Marked as Form F filled')}>Mark Form F filled</Button>
          </div>
        </>
      )}
      {done && canEdit && saved?.manual && (
        <div style={{ marginTop: 16 }}>
          <Button onClick={() => run(() => markFormFFilled(order, false, '', by), 'Mark removed')}>Remove the filled mark</Button>
        </div>
      )}
      {done && saved?.signatureDataUrl && <img src={saved.signatureDataUrl} alt="Patient signature" style={{ maxHeight: 90, marginTop: 12, border: '1px solid #e5e7eb', background: '#fff' }} />}
    </Modal>
  )
}
