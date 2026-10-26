// Colour roles mirrored from tokens.css (the CSS file is what the DOM uses; this
// is what Ant Design's algorithm-based ThemeConfig needs, because antd derives
// hover/active shades from concrete colours and cannot take var(...) strings).
// Keep the two in sync: DESIGN.md §4.3.
export interface Palette {
  primary: string
  onPrimary: string
  primaryContainer: string
  onPrimaryContainer: string
  surface: string
  surfaceContainerLow: string
  surfaceContainer: string
  surfaceContainerHigh: string
  surfaceContainerHighest: string
  onSurface: string
  onSurfaceVariant: string
  outline: string
  outlineVariant: string
  error: string
  onError: string
  urgent: string
  caution: string
  success: string
  info: string
}

export const light: Palette = {
  primary: '#0369A1',
  onPrimary: '#FFFFFF',
  primaryContainer: '#E0F2FE',
  onPrimaryContainer: '#0C4A6E',
  surface: '#F8FBFE',
  surfaceContainerLow: '#F1F6FB',
  surfaceContainer: '#EBF2F8',
  surfaceContainerHigh: '#FFFFFF',
  surfaceContainerHighest: '#E3EDF6',
  onSurface: '#0F1B26',
  onSurfaceVariant: '#44525F',
  outline: '#74828F',
  outlineVariant: '#D3DEE8',
  error: '#B3261E',
  onError: '#FFFFFF',
  urgent: '#B3261E',
  caution: '#8A5300',
  success: '#1B6E3A',
  info: '#0369A1',
}

export const dark: Palette = {
  primary: '#7DD3FC',
  onPrimary: '#00344F',
  primaryContainer: '#004B70',
  onPrimaryContainer: '#CDEBFF',
  surface: '#0E141A',
  surfaceContainerLow: '#151C23',
  surfaceContainer: '#1A222A',
  surfaceContainerHigh: '#212A33',
  surfaceContainerHighest: '#2B3540',
  onSurface: '#E3EAF1',
  onSurfaceVariant: '#B6C3CF',
  outline: '#8B98A5',
  outlineVariant: '#38444F',
  error: '#F2B8B5',
  onError: '#601410',
  urgent: '#F2B8B5',
  caution: '#FFB95C',
  success: '#7DD99B',
  info: '#7DD3FC',
}

// Increase contrast: 7:1 text, 4.5:1+ borders.
export const lightHC: Palette = {
  ...light,
  primary: '#014A73',
  onPrimaryContainer: '#06314D',
  onSurface: '#000000',
  onSurfaceVariant: '#1F2A33',
  outline: '#3D4A55',
  outlineVariant: '#5C6A76',
  error: '#8C1D18',
  urgent: '#8C1D18',
  caution: '#5E3A00',
  success: '#0F5C2E',
  info: '#014A73',
}

export const darkHC: Palette = {
  ...dark,
  primary: '#A8E0FF',
  onPrimary: '#00263B',
  primaryContainer: '#00547F',
  onPrimaryContainer: '#FFFFFF',
  onSurface: '#FFFFFF',
  onSurfaceVariant: '#DCE5EC',
  outline: '#B6C3CF',
  outlineVariant: '#8B98A5',
  error: '#FFD2CF',
  urgent: '#FFD2CF',
  caution: '#FFD08A',
  success: '#A6EBBE',
  info: '#A8E0FF',
}

// Brand accent: large fills and the ambient wash only, never text on white.
export const BRAND_ACCENT = '#0EA5E9'

export const radii = { panel: 28, card: 24, section: 20, dialog: 32, capsule: 999 }
