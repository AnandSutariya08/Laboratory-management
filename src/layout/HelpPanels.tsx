import { Link } from 'react-router-dom'
import { Drawer, Modal } from 'antd'
import { MailOutlined, PhoneOutlined } from '@ant-design/icons'
import { useLabSettings } from '../hooks/useCatalogue'
import { Button } from '../design/Button'
import { dialogWidth } from '../design/dialog'

export const SHORTCUTS: [string, string][] = [
  ['/', 'Focus the search box'],
  ['Ctrl K  or  ⌘ K', 'Search any feature in the sidebar'],
  ['Alt S', 'Open the barcode scan dialog'],
  ['?', 'Open the help centre'],
  ['Enter', 'Run a search or jump to the highlighted result'],
  ['↑ ↓', 'Move through search results'],
  ['← → Home End', 'Move between tabs and segmented filters'],
  ['Esc', 'Close dialogs, drawers and menus'],
]

const HOWTOS: [string, string][] = [
  ['Register a patient and create a bill', '/registration'],
  ['Receive and accession samples', '/accession'],
  ['Enter and verify results', '/worklist'],
  ['Find a patient, reprint or share a report', '/patients'],
  ['Schedule a home collection', '/bookings'],
  ['Check quality control', '/qc'],
]

// Short page-specific guidance, matched by path prefix.
const PAGE_HELP: [string, string, string[]][] = [
  ['/registration', 'New Registration', ['Pick or create the patient, add tests or packages, then bill.', 'Use Due to bill now and collect later.']],
  ['/accession', 'Accession', ['Scan the barcode to receive a sample; reject with a reason if it is unfit.']],
  ['/worklist', 'Enter & Verify', ['Enter values per test, send for verification, then approve.', 'Critical values are flagged in red.']],
  ['/results', 'Enter results', ['Use Tab to move between parameters. A second user approves unless self-verification is allowed.']],
  ['/patients', 'Patient List', ['Filter by status and date; open a bill to reprint, share or edit.']],
  ['/qc', 'Quality Control', ['Run QC each day for every machine; failures raise CAPA actions.', 'Set schedules in QC Setup so missed QC shows on the dashboard.']],
  ['/nabl', 'NABL Audit', ['Registers are computed from bills, results and QC for the chosen period; export any of them as CSV.']],
  ['/inventory', 'Inventory', ['Receive purchase orders to add lots; results consume stock through Stock Mapping.']],
  ['/ai', 'Labby AI', ['Ask in plain words. Tables from your chats are kept under AI Tables.']],
  ['/users', 'Manage Users', ['Add staff one by one or in bulk from CSV. Set an idle timeout per user.']],
]

export function useSupport() {
  const s = useLabSettings()
  const links = ((s as unknown as { helpLinks?: { title: string; url: string }[] }).helpLinks ?? []).filter((l) => l?.url)
  return { s, links }
}

export function HelpDrawer({ open, onClose, pathname }: { open: boolean; onClose: () => void; pathname: string }) {
  const page = PAGE_HELP.find(([p]) => pathname === p || pathname.startsWith(p + '/'))
  return (
    <Drawer title="Help centre" open={open} onClose={onClose} size={400} placement="right">
      {page && (
        <>
          <h3 className="panel-title">On this page: {page[1]}</h3>
          <ul className="howto">{page[2].map((t) => <li key={t}>{t}</li>)}</ul>
        </>
      )}
      <h3 className="panel-title">Keyboard shortcuts</h3>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, d]) => (
          <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>
        ))}
      </dl>
      <h3 className="panel-title">How do I…</h3>
      <ul className="howto">
        {HOWTOS.map(([label, to]) => <li key={to}><Link to={to} onClick={onClose}>{label}</Link></li>)}
      </ul>
    </Drawer>
  )
}

export function SupportCenter({ open, onClose, onTicket }: { open: boolean; onClose: () => void; onTicket: () => void }) {
  const { s } = useSupport()
  return (
    <Modal title="Support Center" open={open} onCancel={onClose} footer={null} destroyOnHidden width={dialogWidth(420)}>
      <p style={{ margin: '0 0 var(--s-2)' }}>{s.name}</p>
      <ul className="howto">
        {s.phone && <li><PhoneOutlined /> <a href={`tel:${s.phone}`}>{s.phone}</a></li>}
        {s.email && <li><MailOutlined /> <a href={`mailto:${s.email}`}>{s.email}</a></li>}
        {!s.phone && !s.email && <li>Add a phone number or email in Lab Profile to show support contacts here.</li>}
      </ul>
      <div style={{ marginTop: 'var(--s-4)' }}>
        <Button variant="primary" onClick={() => { onClose(); onTicket() }}>Create a support ticket</Button>
      </div>
    </Modal>
  )
}

export function DemoVideos({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { links } = useSupport()
  return (
    <Modal title="Demo videos" open={open} onCancel={onClose} footer={null} destroyOnHidden width={dialogWidth(420)}>
      {links.length ? (
        <ul className="howto">{links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.title || l.url}</a></li>)}</ul>
      ) : (
        <p>No demo videos are linked yet. A lab admin can add a list of links under the helpLinks setting.</p>
      )}
    </Modal>
  )
}
