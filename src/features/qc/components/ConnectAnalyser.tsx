import { useEffect, useMemo, useState } from 'react'
import { App, Input, InputNumber, Modal, Select, Space, Typography } from 'antd'
import { updateDoc, Timestamp } from 'firebase/firestore'
import { docRef } from '../../../lib/db'
import { LAB_ID } from '../../../firebase'
import { Button as DsButton } from '../../../design/Button'
import { StatusChip } from '../../../design/StatusChip'
import { FieldGrid, FormSection } from '../../../design/FormLayout'
import { dialogWidth } from '../../../design/dialog'
import { QC, type QcMachine } from '../types'
import { fmtDateTime } from '../../../components/results/common'
import '../../../components/results/results.css'
import '../qc.css'

const { Text, Paragraph } = Typography

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')

// Where the connector (or an analyser that can post HTTPS itself) sends results.
export const analyserEndpoint = () => {
  const project = import.meta.env.VITE_FIREBASE_PROJECT_ID
  return import.meta.env.VITE_USE_EMULATORS === 'true'
    ? `http://127.0.0.1:5001/${project}/asia-south1/analyserIngest`
    : `https://asia-south1-${project}.cloudfunctions.net/analyserIngest`
}

// The connector program the lab installs on the PC its analysers are cabled to (built from connector/).
export const CONNECTOR_DOWNLOAD = '/downloads/hcl-connector.zip'

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

// Written by the connector's heartbeat (once a minute and whenever its link to the analyser changes).
export interface ConnectorInfo {
  lastSeenAt?: Timestamp | null
  version?: string
  host?: string
  connection?: string
  protocol?: string
  link?: string
  detail?: string
  queue?: number
}

type M = QcMachine & { ingestTokenHash?: string; ingestTokenAt?: Timestamp | null; lastIngestAt?: Timestamp | null; connector?: ConnectorInfo }

const ONLINE_MS = 3 * 60_000

// Live state of a machine's connection, from its token and the connector's last heartbeat.
export function connectorState(m: M, now = Date.now()): { variant: 'success' | 'caution' | 'urgent' | 'neutral'; label: string; detail: string } {
  if (!m.ingestTokenHash) return { variant: 'neutral', label: 'Not connected', detail: 'No token made yet' }
  const c = m.connector
  const seen = c?.lastSeenAt?.toMillis?.() ?? 0
  if (!seen) return { variant: 'caution', label: 'Waiting for connector', detail: 'Token made; the connector has not checked in yet' }
  const ago = fmtDateTime(c!.lastSeenAt!)
  if (now - seen > ONLINE_MS) return { variant: 'urgent', label: 'Connector offline', detail: `Last seen ${ago} on ${c?.host || 'the lab PC'}` }
  if (c?.link === 'starting' || c?.link === 'checking' || c?.link === 'connecting') {
    return { variant: 'caution', label: 'Connector starting', detail: `${c.detail || c.link} (${c.host || 'lab PC'})` }
  }
  if (c?.link === 'connected' || c?.link === 'listening') {
    const q = c.queue ? `, ${c.queue} result(s) waiting to send` : ''
    return { variant: 'success', label: 'Connected', detail: `${c.detail || c.link} (${c.host || 'lab PC'})${q}` }
  }
  return { variant: 'urgent', label: 'Analyser link down', detail: c?.detail || 'The connector is running but cannot reach the analyser' }
}

// Re-renders every 30 s so "offline" shows without new data.
function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function ConnectorStatus({ machine }: { machine: M }) {
  const s = connectorState(machine, useNow())
  return (
    <span title={s.detail}>
      <StatusChip variant={s.variant}>{s.label}</StatusChip>
    </span>
  )
}

type Conn = 'serial' | 'tcp-server' | 'tcp-client' | 'folder'
const CONNECTIONS: { value: Conn; label: string; help: string }[] = [
  { value: 'serial', label: 'Serial cable (RS-232 / USB-serial, COM port)', help: 'Most older and mid-range analysers. Needs the port name (Device Manager > Ports) and the speed set on the analyser.' },
  { value: 'tcp-server', label: 'Network: the analyser connects to this PC', help: 'Set the analyser\u2019s LIS host to this PC\u2019s IP address and the port below.' },
  { value: 'tcp-client', label: 'Network: this PC connects to the analyser', help: 'Use the analyser\u2019s IP address and the LIS port shown in its settings.' },
  { value: 'folder', label: 'Result files saved to a folder', help: 'For analysers or their PC software that export result files (ASTM, HL7 or CSV).' },
]

// The machine entry for the connector's config.json.
function configFor(name: string, token: string, s: { connection: Conn; protocol: string; port: string; baud: number; tcpPort: number; host: string; folder: string }) {
  const m: Record<string, unknown> = { name, token, connection: s.connection }
  if (s.connection !== 'folder') m.protocol = s.protocol
  if (s.connection === 'serial') m.serial = { port: s.port || 'COM3', baudRate: s.baud || 9600, dataBits: 8, parity: 'none', stopBits: 1 }
  if (s.connection === 'tcp-server') m.tcp = { port: s.tcpPort || 5100 }
  if (s.connection === 'tcp-client') m.tcp = { host: s.host || '192.168.1.50', port: s.tcpPort || 5100 }
  if (s.connection === 'folder') m.folder = { path: s.folder || 'C:\\AnalyserResults' }
  return JSON.stringify({ endpoint: analyserEndpoint(), machines: [m] }, null, 2)
}

// "Connect analyser" for one machine: guided setup of the connector, token, and live connection status.
// Call site: render <ConnectAnalyserButton machine={m} who={profile.name} /> in a machine row (QC Setup, or
// Lab settings > Machines).
export function ConnectAnalyserButton({ machine, who, disabled }: { machine: M; who: string; disabled?: boolean }) {
  const { message, modal } = App.useApp()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [s, setS] = useState({ connection: 'serial' as Conn, protocol: 'astm', port: 'COM3', baud: 9600, tcpPort: 5100, host: '', folder: '' })
  const set = (p: Partial<typeof s>) => setS((v) => ({ ...v, ...p }))
  const now = useNow()
  const state = connectorState(machine, now)
  const config = useMemo(() => configFor(machine.name, token || 'PASTE-THE-TOKEN-HERE', s), [machine.name, token, s])

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
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => message.success(`${what} copied`),
      () => message.error('Could not copy; select the text and copy it'),
    )
  const conn = CONNECTIONS.find((c) => c.value === s.connection)!

  return (
    <>
      <DsButton disabled={disabled} onClick={() => { setToken(''); setOpen(true) }}>Connect analyser</DsButton>
      <Modal open={open} title={`Connect analyser: ${machine.name}`} footer={null} onCancel={() => setOpen(false)} destroyOnHidden width={dialogWidth(760)}>
        <div className={`re-notice re-notice--${state.variant === 'success' ? 'ok' : state.variant === 'urgent' ? 'crit' : state.variant === 'caution' ? 'warn' : 'info'}`} role="status">
          <b>{state.label}.</b> {state.detail}
          {machine.lastIngestAt ? ` Last results received ${fmtDateTime(machine.lastIngestAt)}.` : ''}
        </div>

        <FormSection title="1. Install the connector on the lab PC" description="One small program runs on the Windows PC the analysers are cabled to. It reads each analyser and sends results here, and keeps them safe if the internet drops. One connector handles every analyser on that PC.">
          <ol className="ca-steps">
            <li>Install <b>Node.js LTS</b> on that PC from nodejs.org (one time).</li>
            <li>
              <a href={CONNECTOR_DOWNLOAD} download>Download the connector</a>, unzip it to <code>C:\HCL-Connector</code>, and double-click <code>setup.bat</code>.
            </li>
            <li>setup.bat opens <code>config.json</code>. Paste the settings from step 3, save, and close it. The connector then starts, and starts again by itself when the PC restarts.</li>
          </ol>
        </FormSection>

        <FormSection
          title="2. Make this analyser's token"
          description="The token lets the connector send results for this analyser only. It is shown once. Making a new one switches the old one off."
          extra={machine.ingestTokenHash && (
            <DsButton variant="text" disabled={busy} onClick={() => modal.confirm({ title: 'Switch off this analyser?', content: 'The connector stops being able to send results for it.', okText: 'Switch off', okButtonProps: { danger: true }, onOk: async () => { await revokeMachineToken(machine.id); setToken(''); message.success('Token switched off') } })}>
              Switch off
            </DsButton>
          )}
        >
          <Space wrap>
            <DsButton variant="primary" disabled={busy} onClick={() => (machine.ingestTokenHash ? modal.confirm({ title: 'Make a new token?', content: 'The current token stops working at once, so update config.json on the lab PC.', okText: 'Make new token', onOk: issue }) : issue())}>
              {machine.ingestTokenHash ? 'Make a new token' : 'Make a token'}
            </DsButton>
            <Text type="secondary">
              {machine.ingestTokenHash ? `A token is active (made ${machine.ingestTokenAt ? fmtDateTime(machine.ingestTokenAt) : 'earlier'}).` : 'No token yet.'}
            </Text>
          </Space>
          {token && <div className="re-notice re-notice--warn" style={{ marginTop: 'var(--s-3)', marginBottom: 0 }}>Token made. It is already filled in below; copy the settings now, because the token is not shown again.</div>}
        </FormSection>

        <FormSection title="3. How is the analyser linked?" description="Pick the link and fill in what the analyser's LIS / host settings show. The settings below update as you go.">
          <div className="re-field">
            <label htmlFor="ca-conn">Link</label>
            <Select id="ca-conn" value={s.connection} onChange={(v) => set({ connection: v })} options={CONNECTIONS.map(({ value, label }) => ({ value, label }))} />
            <Text type="secondary">{conn.help}</Text>
          </div>
          <FieldGrid min={180}>
            {s.connection !== 'folder' && (
              <div className="re-field">
                <label htmlFor="ca-proto">Protocol</label>
                <Select id="ca-proto" value={s.protocol} onChange={(v) => set({ protocol: v })} options={[{ value: 'astm', label: 'ASTM (most analysers)' }, { value: 'hl7', label: 'HL7' }]} />
              </div>
            )}
            {s.connection === 'serial' && (
              <>
                <div className="re-field">
                  <label htmlFor="ca-port">COM port</label>
                  <Input id="ca-port" value={s.port} onChange={(e) => set({ port: e.target.value.trim() })} placeholder="COM3" />
                </div>
                <div className="re-field">
                  <label htmlFor="ca-baud">Speed (baud)</label>
                  <Select id="ca-baud" value={s.baud} onChange={(v) => set({ baud: v })} options={[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((v) => ({ value: v, label: String(v) }))} />
                </div>
              </>
            )}
            {s.connection === 'tcp-client' && (
              <div className="re-field">
                <label htmlFor="ca-host">Analyser IP address</label>
                <Input id="ca-host" value={s.host} onChange={(e) => set({ host: e.target.value.trim() })} placeholder="192.168.1.50" />
              </div>
            )}
            {(s.connection === 'tcp-server' || s.connection === 'tcp-client') && (
              <div className="re-field">
                <label htmlFor="ca-tcp">Port</label>
                <InputNumber id="ca-tcp" min={1} max={65535} value={s.tcpPort} onChange={(v) => set({ tcpPort: Number(v) || 0 })} />
              </div>
            )}
            {s.connection === 'folder' && (
              <div className="re-field">
                <label htmlFor="ca-folder">Folder on the lab PC</label>
                <Input id="ca-folder" value={s.folder} onChange={(e) => set({ folder: e.target.value })} placeholder="C:\AnalyserResults" />
              </div>
            )}
          </FieldGrid>
          <div className="ca-config">
            <div className="ca-config__bar">
              <b>Settings for config.json</b>
              <DsButton variant="text" onClick={() => copy(config, 'Settings')}>Copy</DsButton>
            </div>
            <pre aria-label="Connector settings">{config}</pre>
            <Text type="secondary">Several analysers on the same PC: add each one's block to the "machines" list, each with its own token.</Text>
          </div>
        </FormSection>

        <FormSection title="4. Check it" description="The status at the top turns to Connected within a minute of the connector starting. Then run one sample with a barcode from a bill: its values appear in result entry under Machine value.">
          <Paragraph type="secondary" style={{ margin: 0 }}>
            On the lab PC, the connector&apos;s own status page is at <code>http://localhost:7300</code>. It shows each analyser, what was received and any problem. Test codes from the
            analyser must match the machine codes set on the tests (Tests &gt; edit test); anything that does not match is listed for checking instead of being lost.
          </Paragraph>
        </FormSection>

        <details className="ca-advanced">
          <summary>Advanced: analyser or middleware that can send HTTPS itself</summary>
          <div className="re-field" style={{ marginTop: 'var(--s-3)' }}>
            <label htmlFor="ca-endpoint">Endpoint</label>
            <Input id="ca-endpoint" readOnly value={analyserEndpoint()} onFocus={(e) => e.target.select()} />
          </div>
          <pre>{`POST with header  Authorization: Bearer <token>
Body: ASTM or HL7 text, or JSON {"barcode":"000123","results":[{"code":"GLU","value":"95","unit":"mg/dL"}]}`}</pre>
        </details>
      </Modal>
    </>
  )
}
