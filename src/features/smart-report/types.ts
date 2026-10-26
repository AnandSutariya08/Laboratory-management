export type CoverStyle = 'band' | 'split' | 'frame' | 'minimal' | 'gradient' | 'wave'
export type ThemeKey = 'primary' | 'info' | 'success' | 'caution' | 'urgent' | 'teal' | 'indigo' | 'violet' | 'rose' | 'slate'
export type FontStyle = 'modern' | 'classic' | 'friendly'
export type CardStyle = 'soft' | 'outline' | 'elevated'
export type CoverField = 'name' | 'ageGender' | 'patientId' | 'billNo' | 'referrer' | 'date'

// Stored on the lab document as `smartReport`.
export interface SmartReportSettings {
  logoDataUrl: string
  labName: string
  labAddress: string
  coverStyle: CoverStyle
  themeColour: ThemeKey
  fontStyle: FontStyle
  cardStyle: CardStyle
  coverTitle: string
  coverSubtitle: string
  email: string
  footerText: string // 80 chars
  showHistoryGraph: boolean
  showDoctorNote: boolean
  showAiTag: boolean
  showWellness: boolean // body systems overview
  showHealthScore: boolean
  showAllResults: boolean // full results section after "needs attention"
  showPageHeader: boolean
  disclaimer: string
  coverFields: CoverField[]
  // Smart report options (stored on lab doc `smartReport`; the messaging agent reads smartReportLink).
  smartReportLink: boolean // send/public link offers the smart report variant by default
  includeOriginal: boolean // append the original signed report after the smart pages
  showSummaryCounts: boolean // N parameters / normal / abnormal / critical strip
  showRangeBar: boolean
  letterheadDataUrl: string // cover / page header background (<= 300 KB)
}

export const DEFAULT_SMART: SmartReportSettings = {
  logoDataUrl: '',
  labName: '',
  labAddress: '',
  coverStyle: 'gradient',
  themeColour: 'primary',
  fontStyle: 'modern',
  cardStyle: 'soft',
  coverTitle: 'Your health report',
  coverSubtitle: 'A clear, plain-language guide to your test results',
  email: '',
  footerText: '',
  showHistoryGraph: true,
  showDoctorNote: true,
  showAiTag: true,
  showWellness: true,
  showHealthScore: true,
  showAllResults: true,
  showPageHeader: true,
  disclaimer: 'This summary is written to help you read your results. It is not a diagnosis. Please discuss your results with your doctor.',
  coverFields: ['name', 'ageGender', 'patientId', 'billNo', 'date'],
  smartReportLink: false,
  includeOriginal: false,
  showSummaryCounts: true,
  showRangeBar: true,
  letterheadDataUrl: '',
}

export const COVER_STYLES: { value: CoverStyle; label: string; hint: string }[] = [
  { value: 'gradient', label: 'Gradient', hint: 'Full colour hero with soft shapes' },
  { value: 'wave', label: 'Wave', hint: 'Colour header ending in a wave' },
  { value: 'band', label: 'Banner', hint: 'Colour banner across the top' },
  { value: 'split', label: 'Side panel', hint: 'Colour panel on the left' },
  { value: 'frame', label: 'Framed', hint: 'Centred title inside a border' },
  { value: 'minimal', label: 'Minimal', hint: 'Large type and a thin rule' },
]

export const FONT_STYLES: { value: FontStyle; label: string; hint: string }[] = [
  { value: 'modern', label: 'Modern', hint: 'Clean sans-serif' },
  { value: 'classic', label: 'Classic', hint: 'Serif headings' },
  { value: 'friendly', label: 'Friendly', hint: 'Rounded and warm' },
]

export const CARD_STYLES: { value: CardStyle; label: string; hint: string }[] = [
  { value: 'soft', label: 'Soft', hint: 'Tinted cards' },
  { value: 'outline', label: 'Outline', hint: 'White cards, thin border' },
  { value: 'elevated', label: 'Raised', hint: 'White cards with shadow' },
]

// Print palettes (the report sheet is always light). main = accents and headings, deep = text on
// tints and gradient end, soft = tinted surfaces, tint = page wash.
export interface ThemePalette { label: string; main: string; deep: string; soft: string; tint: string }
export const THEMES: Record<ThemeKey, ThemePalette> = {
  primary: { label: 'Ocean', main: '#0369A1', deep: '#0C4A6E', soft: '#E0F2FE', tint: '#F4FAFE' },
  info: { label: 'Sky', main: '#0284C7', deep: '#075985', soft: '#E0F2FE', tint: '#F5FBFF' },
  teal: { label: 'Teal', main: '#0F766E', deep: '#134E4A', soft: '#CCFBF1', tint: '#F2FBF9' },
  success: { label: 'Emerald', main: '#047857', deep: '#064E3B', soft: '#D1FAE5', tint: '#F3FBF7' },
  indigo: { label: 'Indigo', main: '#4338CA', deep: '#312E81', soft: '#E0E7FF', tint: '#F6F7FF' },
  violet: { label: 'Violet', main: '#7C3AED', deep: '#4C1D95', soft: '#EDE9FE', tint: '#FAF8FF' },
  rose: { label: 'Rose', main: '#BE123C', deep: '#881337', soft: '#FFE4E6', tint: '#FFF7F8' },
  caution: { label: 'Amber', main: '#B45309', deep: '#78350F', soft: '#FEF3C7', tint: '#FFFBF0' },
  urgent: { label: 'Red', main: '#B91C1C', deep: '#7F1D1D', soft: '#FEE2E2', tint: '#FFF7F7' },
  slate: { label: 'Slate', main: '#334155', deep: '#0F172A', soft: '#E2E8F0', tint: '#F8FAFC' },
}
export const THEME_OPTIONS = (Object.keys(THEMES) as ThemeKey[]).map((value) => ({ value, label: THEMES[value].label }))

export const COVER_FIELD_LABEL: Record<CoverField, string> = {
  name: 'Patient name',
  ageGender: 'Age and gender',
  patientId: 'Patient ID',
  billNo: 'Bill number',
  referrer: 'Referred by',
  date: 'Report date',
}

export const themeHex = (k: ThemeKey): string => (THEMES[k] ?? THEMES.primary).main
export const themeOf = (k: ThemeKey): ThemePalette => THEMES[k] ?? THEMES.primary

export function mergeSmart(raw: unknown): SmartReportSettings {
  const o = raw && typeof raw === 'object' ? (raw as Partial<SmartReportSettings>) : {}
  const m = { ...DEFAULT_SMART, ...o, coverFields: Array.isArray(o.coverFields) ? o.coverFields : DEFAULT_SMART.coverFields }
  if (!THEMES[m.themeColour]) m.themeColour = 'primary'
  return m
}
