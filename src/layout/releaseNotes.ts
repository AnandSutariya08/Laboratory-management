// Release notes shown in the top bar's "What's new" drawer. Newest first.
export interface ReleaseNote {
  version: string
  date: string // YYYY-MM-DD
  title: string
  items: string[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '2026.10.3',
    date: '2026-10-16',
    title: 'Search, support and QC scheduling',
    items: [
      'Global search matches name, phone, patient ID, UHID and bill, with Patient and Bill results.',
      'Scan dialog now shows the bill, tests and statuses with quick links.',
      'Activity notifications, Support Ticket, Install app, Ideas and Feedback.',
      'QC schedules and missed-QC detection, EQAS cycles, per sample type discard setup, AI Tables, bulk user upload.',
    ],
  },
  {
    version: '2026.10.2',
    date: '2026-10-16',
    title: 'A new look: Liquid Glass shell',
    items: [
      'Floating sidebar and top bar with sky-blue glass, keyboard-friendly command search ("Search any feature…").',
      'Scan button for barcode scanners, live alerts bell, Help and What\'s new panels.',
      'Display settings in the user menu: theme, reduce motion, reduce transparency, increase contrast.',
      'Branch switcher in the top bar (shown for users with more than one branch).',
    ],
  },
  {
    version: '2026.10.1',
    date: '2026-10-09',
    title: 'Inventory and Quality Control',
    items: [
      'Inventory: stock, purchase orders, suppliers and stock mapping with FEFO consumption.',
      'Quality Control: Levey-Jennings charts, Westgard rules, EQAS and NABL audit logs.',
    ],
  },
  {
    version: '2026.09.3',
    date: '2026-09-25',
    title: 'Bookings and report sharing',
    items: [
      'Home-collection bookings with phlebotomist assignment and slot scheduling.',
      'Share reports by WhatsApp, SMS or email with expiring links.',
    ],
  },
]
