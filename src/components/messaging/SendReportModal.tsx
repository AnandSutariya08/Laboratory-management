import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Checkbox, Divider, Input, Modal, Radio, Select, Space, Table, Tag, Typography } from 'antd'
import { MailOutlined, MessageOutlined, SendOutlined, WhatsAppOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { addDoc, getDoc, orderBy, query, serverTimestamp } from 'firebase/firestore'
import { can, useAuth } from '../../auth/AuthProvider'
import { useCatalogueMaps, useLabSettings } from '../../hooks/useCatalogue'
import { isRestrictedTest } from '../../pages/catalogue/flags'
import { useLiveQuery } from '../../hooks/useLive'
import { deliveriesCol, docRef, labDoc, paths } from '../../lib/db'
import { useLiveDoc } from '../../hooks/useLive'
import { createReportShare, fillTemplate, retryReportDelivery, revokeReportShare, sendBill, sendReport, whatsappLink, type ReportRecipient, type SendResult } from '../../lib/messaging'
import { markDispatched } from '../../lib/orders'
import { allowDispatchedDueAccess } from '../../features/settings/lib'
import { useReportLayout } from '../../features/report/layout'
import type { Channel, Delivery, Order, Patient } from '../../types'
import type { Referrer } from '../../features/partners/types'
import { fmtDateTime } from '../results/common'
import { dialogWidth } from '../../design/dialog'

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  manualWhatsapp: 'WhatsApp (manual)',
  hardcopy: 'Hard copy',
}
const STATUS_COLOR: Record<string, string> = { sent: 'green', delivered: 'green', read: 'green', logged: 'gold', failed: 'red', queued: 'blue', sending: 'blue', cancelled: 'default' }
const STATUS_TEXT: Record<string, string> = { sent: 'Sent', delivered: 'Delivered', read: 'Read', sending: 'Sending', cancelled: 'Cancelled', logged: 'Not delivered (dev log)', failed: 'Failed', queued: 'Queued' }
const RECIPIENT_LABEL: Record<string, string> = { doctor: 'doctor', b2b: 'B2B centre', centre: 'collection centre', corporate: 'corporate' }
// Contact lives on the partner master; the bill stores only its id.
const PARTNER: Partial<Record<ReportRecipient, { col: string; id: (o: Order) => string | undefined; name: (o: Order) => string | undefined; label: string }>> = {
  b2b: { col: 'b2bCentres', id: (o) => o.b2bCentreId, name: (o) => o.b2bCentreName, label: 'B2B centre' },
  centre: { col: 'collectionCentres', id: (o) => o.collectionCentreId, name: (o) => o.collectionCentreName, label: 'Collection centre' },
  corporate: { col: 'corporateClients', id: (o) => o.corporateClientId, name: (o) => o.corporateClientName, label: 'Corporate' },
}

interface Props {
  order: Order
  open: boolean
  onClose: () => void
  tests?: { id: string; name: string }[]
  defaultTestIds?: string[]
  letterheadDefault?: boolean
}

export default function SendReportModal({ order, open, onClose, tests = [], defaultTestIds = [], letterheadDefault = false }: Props) {
  const { message, modal } = App.useApp()
  const { profile } = useAuth()
  const settings = useLabSettings()
  const [patient, setPatient] = useState<Patient | null>(null)
  const [referrer, setReferrer] = useState<Referrer | null>(null)
  const [recipient, setRecipient] = useState<ReportRecipient>('patient')
  const [partners, setPartners] = useState<Partial<Record<ReportRecipient, { phone: string; email: string }>>>({})
  const { data: labData } = useLiveDoc<{ smartReport?: { smartReportLink?: boolean } }>(open ? labDoc() : null, [open])
  const [channels, setChannels] = useState<Channel[]>([])
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [withLetterhead, setWithLetterhead] = useState(false)
  const [letterheadId, setLetterheadId] = useState('')
  const layout = useReportLayout()
  const [testIds, setTestIds] = useState<string[]>([])
  const [smartLink, setSmartLink] = useState(false)
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<SendResult[]>([])
  const [waPrompt, setWaPrompt] = useState<{ to: string; link: string } | null>(null)

  const { data: deliveries } = useLiveQuery<Delivery>(
    open ? query(deliveriesCol(order.id), orderBy('at', 'desc')) : null,
    [open, order.id],
  )

  useEffect(() => {
    if (!open) return
    setResults([])
    setChannels([])
    setRecipient('patient')
    setWithLetterhead(letterheadDefault)
    setLetterheadId('')
    setTestIds(defaultTestIds)
    setSmartLink(!!labData?.smartReport?.smartReportLink)
    let cancelled = false
    getDoc(docRef<Patient>(paths.patients, order.patientId))
      .then((s) => {
        if (cancelled) return
        const p = s.exists() ? ({ ...s.data(), id: s.id } as Patient) : null
        setPatient(p)
        setPhone(p?.phone ?? '')
        setEmail(p?.email ?? '')
        setChannels((p?.dispatchModes ?? []).filter((m): m is Channel => m === 'whatsapp' || m === 'sms' || m === 'email'))
      })
      .catch(() => undefined)
    if (order.referrerId)
      getDoc(docRef<Referrer>('referrers', order.referrerId))
        .then((s) => !cancelled && setReferrer(s.exists() ? ({ ...s.data(), id: s.id } as Referrer) : null))
        .catch(() => undefined)
    else setReferrer(null)
    setPartners({})
    for (const [r, pc] of Object.entries(PARTNER)) {
      const id = pc?.id(order)
      if (pc && id)
        getDoc(docRef<{ phone?: string; email?: string }>(pc.col, id))
          .then((x) => !cancelled && x.exists() && setPartners((p) => ({ ...p, [r]: { phone: x.data().phone ?? '', email: x.data().email ?? '' } })))
          .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.patientId, order.referrerId])

  const switchRecipient = (r: ReportRecipient) => {
    setRecipient(r)
    const pc = partners[r]
    if (pc) {
      setPhone(pc.phone)
      setEmail(pc.email)
      setChannels([pc.phone ? 'whatsapp' : 'email'])
    } else if (r === 'doctor') {
      setPhone(referrer?.phone ?? '')
      setEmail(referrer?.email ?? '')
      setChannels([referrer?.phone ? 'whatsapp' : 'email'])
    } else {
      setPhone(patient?.phone ?? '')
      setEmail(patient?.email ?? '')
      setChannels((patient?.dispatchModes ?? []).filter((m): m is Channel => m === 'whatsapp' || m === 'sms' || m === 'email'))
    }
  }

  const rd = settings.reportDetails
  // A restricted (sensitive) test on the bill: never sent over WhatsApp or SMS (the server enforces it too).
  const cat = useCatalogueMaps()
  const restricted = useMemo(() => order.items.some((i) => i.testIds.some((t) => isRestrictedTest(cat.testById.get(t)))), [order.items, cat.testById])
  useEffect(() => {
    if (restricted) setChannels((c) => c.filter((x) => x === 'email'))
  }, [restricted])
  const blockers = useMemo(() => {
    const b: string[] = []
    const govOk = !!order.govPanelId && settings.referrals.govPanelSendDueReport
    if (recipient === 'patient' && settings.blockSendWhileDue && order.due > 0 && !can(profile, 'reports.sendDue') && !govOk && !(order.dispatched && allowDispatchedDueAccess(settings)))
      b.push('The bill has an outstanding balance. Clear the due before sending.')
    if (order.reportStatus === 'provisional' && rd.allowProvisionalSend === false) b.push('Provisional reports cannot be sent. Wait until the report is final.')
    else if (order.reportStatus === 'partial' && rd.reportBlockPartial !== false) b.push('Some results are still pending; the report is not ready to send.')
    else if (order.reportStatus === 'pending') b.push('The report is pending; it must be provisional or final.')
    return b
  }, [settings, order.due, order.reportStatus, order.govPanelId, recipient, rd, profile])

  const needsPhone = channels.includes('whatsapp') || channels.includes('sms')
  const needsEmail = channels.includes('email')
  const missing = (needsPhone && !phone.trim()) || (needsEmail && !email.trim())
  const provisional = order.reportStatus === 'provisional'

  const doSend = async (allowDuplicate: boolean) => {
    setSending(true)
    try {
      const res = await sendReport({
        orderId: order.id, channels, phone: phone.trim(), email: email.trim(), recipient,
        withLetterhead, letterheadId: letterheadId || undefined, testIds: testIds.length ? testIds : undefined, smart: smartLink, allowDuplicate,
      })
      if (res.duplicates?.length) {
        modal.confirm({
          title: 'Already sent recently',
          content: `This report was sent by ${res.duplicates.map((c) => CHANNEL_LABEL[c]).join(', ')} within the last hour. Send it again?`,
          okText: 'Send again',
          onOk: () => doSend(true),
        })
        return
      }
      setResults(res.results)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  // Same template choice as the server: partner-specific WhatsApp templates first, then the standard one.
  const manualVars = (link: string) => ({
    patientName: recipient === 'doctor' ? referrer?.name ?? 'Doctor' : recipient !== 'patient' ? PARTNER[recipient]?.name(order) ?? 'Partner' : order.patientName,
    labName: settings.name, billNo: order.billNo, link, reportLink: link, smartReportLink: link,
    ageGender: `${order.ageValue} ${order.ageUnit} / ${order.gender}`, labContact: [settings.phone, settings.email].filter(Boolean).join(' | '), dueAmount: `Rs ${(order.due / 100).toLocaleString('en-IN')}`,
  })
  const waTemplate = () => {
    const ex = settings.extraTemplates
    if (recipient !== 'patient' && ex.waReportToB2b) return ex.waReportToB2b
    if (order.b2bCentreId && ex.waReportFromB2b) return ex.waReportFromB2b
    if (order.collectionCentreId && ex.waReportFromCentre) return ex.waReportFromCentre
    return settings.templates.reportReady
  }
  const reportLinkNow = async () => {
    if (knownLink) return knownLink
    try {
      return `${(settings.publicAppUrl || window.location.origin).replace(/\/+$/, '')}/r/${await createReportShare(order.id)}`
    } catch {
      return ''
    }
  }
  // Manual email from the staff member's own mail program, with the email subject and body templates.
  const openMail = async () => {
    const to = email.trim()
    if (!to) return message.warning('Enter an email address')
    const vars = manualVars(await reportLinkNow())
    const ex = settings.extraTemplates
    const subject = fillTemplate(ex.emailSubject || 'Your report from {labName} ({billNo})', vars)
    const body = fillTemplate(ex.emailBody || settings.templates.reportReady, vars)
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }
  const knownLink = results.find((r) => r.link)?.link ?? deliveries.find((d) => d.link)?.link ?? ''

  const openManual = async () => {
    const to = phone.trim()
    if (!to) return message.warning('Enter a phone number')
    let link = knownLink
    if (!link) {
      try {
        const t = await createReportShare(order.id)
        link = `${(settings.publicAppUrl || window.location.origin).replace(/\/+$/, '')}/r/${t}`
      } catch {
        link = ''
      }
    }
    const text = fillTemplate(waTemplate(), manualVars(link)).trim()
    window.open(whatsappLink(to, text), '_blank', 'noopener')
    setWaPrompt({ to, link })
  }

  // Dispatch is recorded only after the staff member confirms they pressed send in WhatsApp.
  const confirmManual = async () => {
    if (!profile || !waPrompt) return
    try {
      await addDoc(deliveriesCol(order.id), {
        channel: 'manualWhatsapp', to: waPrompt.to, kind: 'report', recipient, status: 'sent', providerId: '', error: '',
        link: waPrompt.link, sentBy: profile.uid, sentByName: profile.name, at: serverTimestamp(),
      })
      if (recipient === 'patient') await markDispatched(order, 'manualWhatsapp')
      setWaPrompt(null)
      message.success('Recorded as sent')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // DP-21: the bill summary goes out on its own, logged as kind "bill"; the report is not involved.
  const sendBillNow = async () => {
    setSending(true)
    try {
      setResults(await sendBill({ orderId: order.id, channels, phone: phone.trim(), email: email.trim() }))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const retry = async (d: Delivery) => {
    try {
      const r = await retryReportDelivery(order.id, d.id)
      message[r.status === 'sent' ? 'success' : 'warning'](r.status === 'sent' ? 'Sent' : r.error || 'Still failing')
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  const revoke = () =>
    modal.confirm({
      title: 'Revoke report links?',
      content: 'Every link already sent for this bill stops working. The next send creates a new link.',
      okText: 'Revoke',
      okButtonProps: { danger: true },
      onOk: async () => {
        const r = await revokeReportShare(order.id)
        message.success(`${r.revoked} link${r.revoked === 1 ? '' : 's'} revoked`)
      },
    })

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`Send report - ${order.patientName} (${order.billNo})`}
      width={dialogWidth(680)}
      footer={
        <Space>
          <Button onClick={onClose}>Close</Button>
          <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={blockers.length > 0 || channels.length === 0 || missing} onClick={() => doSend(false)}>
            Send
          </Button>
        </Space>
      }
    >
      {blockers.map((b) => <Alert key={b} type="warning" showIcon message={b} style={{ marginBottom: 8 }} />)}
      {provisional && !blockers.length && <Alert type="info" showIcon message="This is a provisional report; it is sent with a PROVISIONAL banner." style={{ marginBottom: 8 }} />}

      <Radio.Group value={recipient} onChange={(e) => switchRecipient(e.target.value)} style={{ marginBottom: 12 }}>
        <Radio.Button value="patient">Patient</Radio.Button>
        <Radio.Button value="doctor" disabled={!order.referrerId}>Referring doctor{referrer ? ` (${referrer.name})` : ''}</Radio.Button>
        {(Object.keys(PARTNER) as ReportRecipient[]).map((r) => {
          const pc = PARTNER[r]!
          return pc.id(order) ? <Radio.Button key={r} value={r}>{pc.label}{pc.name(order) ? ` (${pc.name(order)})` : ''}</Radio.Button> : null
        })}
      </Radio.Group>

      {restricted && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="This bill has a restricted test: it can only be sent by email." />}
      <Checkbox.Group
        value={channels}
        onChange={(v) => setChannels(v as Channel[])}
        options={[
          { value: 'whatsapp', disabled: restricted, label: <span><WhatsAppOutlined /> WhatsApp</span> },
          { value: 'sms', disabled: restricted, label: <span><MessageOutlined /> SMS</span> },
          { value: 'email', label: <span><MailOutlined /> Email</span> },
        ]}
      />
      <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
        <Input addonBefore="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile" />
        <Input addonBefore="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        {recipient === 'patient' && patient && !patient.phone && !patient.email && (
          <Typography.Text type="secondary">No contact details saved for this patient; type them above.</Typography.Text>
        )}
      </Space>

      {channels.includes('email') && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
          {settings.emailSender?.status === 'verified'
            ? <>Email goes out as <b>{settings.emailSender.fromName || settings.name}</b>, replies to {settings.emailSender.fromEmail} <Tag color="green">Verified sender</Tag></>
            : <>Email goes out from the lab's shared address. <Tag color={settings.emailSender?.status === 'pending' ? 'gold' : 'default'}>{settings.emailSender?.status === 'pending' ? 'Sender verification pending' : 'Sender not verified'}</Tag> Verify your own sender in Lab profile, Report layout.</>}
          {' '}The report PDF is attached.
        </Typography.Text>
      )}
      <Divider titlePlacement="start">Options</Divider>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Checkbox checked={withLetterhead} onChange={(e) => setWithLetterhead(e.target.checked)}>Send with letterhead (hide the lab header and footer, for pre-printed stationery)</Checkbox>
        {layout.letterheads.some((l) => l.active !== false) && (
          <Select allowClear style={{ width: '100%' }} placeholder="Letterhead from the library (optional)" value={letterheadId || undefined} onChange={(v) => setLetterheadId(v ?? '')}
            options={layout.letterheads.filter((l) => l.active !== false).map((l) => ({ value: l.id, label: l.name }))} aria-label="Letterhead" />
        )}
        <Checkbox checked={smartLink} onChange={(e) => setSmartLink(e.target.checked)}>Send the smart report link instead of the standard report</Checkbox>
        {tests.length > 1 && (
          <Select mode="multiple" allowClear style={{ width: '100%' }} placeholder="All tests" value={testIds} onChange={setTestIds} maxTagCount="responsive"
            options={tests.map((t) => ({ value: t.id, label: t.name }))} aria-label="Tests to include" />
        )}
      </Space>

      {results.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {results.map((r) => (
            <Alert
              key={r.channel}
              style={{ marginBottom: 6 }}
              type={r.status === 'sent' ? 'success' : r.status === 'logged' ? 'info' : 'error'}
              showIcon
              message={`${CHANNEL_LABEL[r.channel]} to ${r.to || '-'}: ${
                r.status === 'sent' ? 'sent' : r.status === 'logged' ? 'logged in dev outbox only (provider not configured); not marked delivered' : 'failed; it will be retried automatically'
              }`}
              description={r.error}
            />
          ))}
        </div>
      )}

      <Divider />
      <Space wrap>
        <Button icon={<WhatsAppOutlined />} onClick={openManual} disabled={!phone.trim() || blockers.length > 0 || restricted}>Send from my WhatsApp</Button>
        <Button icon={<MailOutlined />} onClick={() => void openMail()} disabled={!email.trim() || blockers.length > 0}>Send from my email</Button>
        <Button icon={<SendOutlined />} disabled={channels.length === 0 || missing || recipient !== 'patient'} onClick={sendBillNow}>Send bill instead</Button>
        <Button icon={<StopOutlined />} danger onClick={revoke}>Revoke links</Button>
      </Space>

      <Divider titlePlacement="start">Delivery history</Divider>
      <Table<Delivery>
        size="small"
        rowKey="id"
        dataSource={deliveries}
        pagination={false}
        locale={{ emptyText: 'Nothing sent yet' }}
        scroll={{ y: 200 }}
        columns={[
          { title: 'When', width: 150, render: (_, d) => fmtDateTime(d.at) },
          { title: 'Channel', render: (_, d) => `${CHANNEL_LABEL[d.channel] ?? d.channel}${d.recipient && d.recipient !== 'patient' ? ` (${RECIPIENT_LABEL[d.recipient] ?? d.recipient})` : ''}${d.kind === 'bill' ? ' - bill' : d.kind === 'alert' ? ' - alert' : ''}` },
          { title: 'To', dataIndex: 'to' },
          {
            title: 'Status',
            render: (_, d) => (
              <Space size={4}>
                <Tag color={STATUS_COLOR[d.status]} title={d.error || undefined}>{STATUS_TEXT[d.status] ?? d.status}</Tag>
                {d.status === 'failed' && d.retryAt !== undefined && d.channel !== 'manualWhatsapp' && (
                  <Button size="small" icon={<ReloadOutlined />} aria-label="Retry" onClick={() => retry(d)} />
                )}
              </Space>
            ),
          },
          { title: 'File', width: 70, render: (_, d) => (d.attachment ? <Tag color="blue">PDF</Tag> : '') },
          { title: 'By', dataIndex: 'sentByName' },
        ]}
      />

      <Modal open={!!waPrompt} title="Did you send the WhatsApp message?" okText="Yes, mark as sent" cancelText="Not yet" onOk={confirmManual} onCancel={() => setWaPrompt(null)}>
        WhatsApp opened with the message ready. Press send there, then confirm here so the report is recorded as delivered.
      </Modal>
    </Modal>
  )
}
