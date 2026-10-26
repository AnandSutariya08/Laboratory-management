import { useState } from 'react'
import { App, Input, Modal, Space, Typography } from 'antd'
import { updateDoc, Timestamp } from 'firebase/firestore'
import { docRef } from '../../../lib/db'
import { LAB_ID } from '../../../firebase'
import { Button as DsButton } from '../../../design/Button'
import { QC, type QcMachine } from '../types'
import { fmtDateTime } from '../../../components/results/common'

const { Text, Paragraph } = Typography

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')

// Where the analyser (or its interface agent) posts results.
export const analyserEndpoint = () => {
  const project = import.meta.env.VITE_FIREBASE_PROJECT_ID
  return import.meta.env.VITE_USE_EMULATORS === 'true'
    ? `http://127.0.0.1:5001/${project}/asia-south1/analyserIngest`
    : `https://asia-south1-${project}.cloudfunctions.net/analyserIngest`
}

// Issues a new ingest token for a machine. Only its hash is stored on the machine record; the token itself is
// returned once and never shown again. Issuing a new one switches the old one off.
export async function issueMachineToken(machineId: string, who: string): Promise<string> {
  const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const token = `${LAB_ID}.${machineId}.${secret}`
  await updateDoc(docRef(QC.machines, machineId), { ingestTokenHash: await sha256(token), ingestTokenAt: Timestamp.now(), ingestTokenBy: who })
  return token
}

export async function revokeMachineToken(machineId: string) {
  await updateDoc(docRef(QC.machines, machineId), { ingestTokenHash: '', ingestTokenAt: null })
}

type M = QcMachine & { ingestTokenHash?: string; ingestTokenAt?: Timestamp | null; lastIngestAt?: Timestamp | null }

// "Connect analyser" panel for one machine: issue or revoke its token and show how to post results.
// Call site: render <ConnectAnalyserButton machine={m} who={profile.name} /> in a machine row or the machine form
// (QC Setup, or Lab settings > Machines).
export function ConnectAnalyserButton({ machine, who, disabled }: { machine: M; who: string; disabled?: boolean }) {
  const { message, modal } = App.useApp()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const issue = async () => {
    setBusy(true)
    try {
      setToken(await issueMachineToken(machine.id, who))
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not create a token')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DsButton disabled={disabled} onClick={() => { setToken(''); setOpen(true) }}>Connect analyser</DsButton>
      <Modal open={open} title={`Connect analyser: ${machine.name}`} footer={null} onCancel={() => setOpen(false)} destroyOnHidden>
        <Paragraph type="secondary">
          The analyser or its interface agent posts results over HTTPS with a token made here. Results are matched by the sample barcode and the
          machine codes set on tests and parameters. A QC lot barcode (QC:&lt;lot&gt;:L1) is saved as a QC run.
        </Paragraph>
        <div className="re-field">
          <label>Endpoint</label>
          <Input readOnly aria-label="Endpoint" value={analyserEndpoint()} onFocus={(e) => e.target.select()} />
        </div>
        <Text type="secondary">
          {machine.ingestTokenHash ? `A token is active (made ${machine.ingestTokenAt ? fmtDateTime(machine.ingestTokenAt) : 'earlier'}).` : 'No token yet.'}
          {machine.lastIngestAt ? ` Last data received ${fmtDateTime(machine.lastIngestAt)}.` : ''}
        </Text>
        {token && (
          <div className="re-notice re-notice--warn" style={{ marginTop: 'var(--s-3)' }} role="status">
            Copy this token now. It is shown only once.
            <Input readOnly aria-label="Analyser token" value={token} onFocus={(e) => e.target.select()} />
            <pre style={{ whiteSpace: 'pre-wrap', margin: 'var(--s-2) 0 0' }}>{`curl -X POST '${analyserEndpoint()}' -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' -d '{"barcode":"000123","results":[{"code":"GLU","value":"95","unit":"mg/dL"}]}'`}</pre>
          </div>
        )}
        <Space style={{ marginTop: 'var(--s-4)' }}>
          <DsButton variant="primary" disabled={busy} onClick={() => (machine.ingestTokenHash ? modal.confirm({ title: 'Replace the token?', content: 'The current token stops working at once.', okText: 'Replace', onOk: issue }) : issue())}>
            {machine.ingestTokenHash ? 'Make a new token' : 'Make a token'}
          </DsButton>
          {machine.ingestTokenHash && <DsButton disabled={busy} onClick={() => modal.confirm({ title: 'Switch off this analyser?', okText: 'Switch off', okButtonProps: { danger: true }, onOk: async () => { await revokeMachineToken(machine.id); message.success('Token revoked') } })}>Revoke</DsButton>}
        </Space>
      </Modal>
    </>
  )
}
