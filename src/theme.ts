import { theme as antdTheme, type ThemeConfig } from 'antd'
import { BRAND_ACCENT, dark, darkHC, light, lightHC, radii, type Palette } from './design/palette'

// Ant Design theme derived from the same colour roles as src/design/tokens.css
// (palette.ts mirrors them; antd needs concrete colours to derive hover/active
// shades). Layer map (DESIGN.md §3): tables, inputs, cards are content;
// Modal / Drawer / Dropdown / Popover are large glass; Message / Notification
// are small glass. The glass paint itself is applied by src/design/glass.css, so
// the overlay components here are given transparent backgrounds.

export const BRAND = {
  name: 'Health Care Labs',
  primary: BRAND_ACCENT, // large fills and ambient wash only
  primaryDark: light.primary, // text-safe sky blue (AA on white)
  primarySoft: light.primaryContainer,
  surface: light.surfaceContainerHigh,
  page: light.surface,
}

const FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

export interface ThemeOptions {
  dark?: boolean
  highContrast?: boolean
}

export function paletteFor({ dark: isDark, highContrast }: ThemeOptions = {}): Palette {
  return isDark ? (highContrast ? darkHC : dark) : highContrast ? lightHC : light
}

export function buildTheme(opts: ThemeOptions = {}): ThemeConfig {
  const p = paletteFor(opts)
  const hc = !!opts.highContrast
  return {
    algorithm: opts.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: p.primary,
      colorInfo: p.info,
      colorSuccess: p.success,
      colorWarning: p.caution,
      colorError: p.error,
      colorLink: p.primary,
      colorText: p.onSurface,
      colorTextSecondary: p.onSurfaceVariant,
      colorTextTertiary: p.onSurfaceVariant,
      colorTextDescription: p.onSurfaceVariant,
      colorTextPlaceholder: p.onSurfaceVariant,
      colorBgLayout: p.surface,
      colorBgContainer: p.surfaceContainerHigh,
      colorBgElevated: p.surfaceContainerHigh,
      colorBgSpotlight: p.surfaceContainerHighest,
      colorFillAlter: p.surfaceContainerLow,
      colorBorder: p.outline, // 3:1 for input boundaries
      colorBorderSecondary: p.outlineVariant,
      colorSplit: p.outlineVariant,
      lineWidth: hc ? 1.5 : 1,
      borderRadius: 10,
      borderRadiusLG: radii.card,
      borderRadiusSM: 8,
      fontFamily: FONT,
      fontSize: 14,
      controlHeight: 36,
      motionDurationFast: '0.1s',
      motionDurationMid: '0.16s',
      motionDurationSlow: '0.24s',
      motionEaseOut: 'cubic-bezier(0, 0, 0, 1)',
      motionEaseInOut: 'cubic-bezier(0.2, 0, 0, 1)',
      boxShadow: 'none',
      boxShadowSecondary: 'none',
    },
    components: {
      Layout: { siderBg: 'transparent', headerBg: 'transparent', bodyBg: 'transparent' },
      Menu: {
        itemSelectedBg: p.primaryContainer,
        itemSelectedColor: p.onPrimaryContainer,
        itemBorderRadius: 999,
        itemBg: 'transparent',
        popupBg: 'transparent',
      },
      Button: {
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        primaryColor: p.onPrimary,
        borderRadius: 999,
        controlHeight: 36,
      },
      Card: { borderRadiusLG: radii.card, colorBorderSecondary: p.outlineVariant, headerBg: 'transparent' },
      Table: {
        headerBg: p.surfaceContainer,
        headerColor: p.onSurface,
        rowHoverBg: p.surfaceContainerLow,
        borderColor: p.outlineVariant,
        cellFontSize: 13,
        cellPaddingBlock: 10,
        borderRadiusLG: radii.card,
      },
      Input: { activeShadow: 'none', hoverBorderColor: p.primary, activeBorderColor: p.primary },
      InputNumber: { activeShadow: 'none' },
      Select: {
        optionSelectedBg: p.primaryContainer,
        optionSelectedColor: p.onPrimaryContainer,
        selectorBg: p.surfaceContainerHigh,
        activeOutlineColor: 'transparent',
      },
      DatePicker: { activeShadow: 'none' },
      Tabs: { itemSelectedColor: p.primary, inkBarColor: p.primary },
      Modal: {
        contentBg: 'transparent',
        headerBg: 'transparent',
        footerBg: 'transparent',
        titleFontSize: 18,
        borderRadiusLG: radii.dialog,
      },
      Drawer: { colorBgElevated: 'transparent', borderRadiusLG: radii.panel },
      Dropdown: { colorBgElevated: 'transparent', borderRadiusLG: radii.panel, paddingBlock: 6 },
      Popover: { colorBgElevated: 'transparent', borderRadiusLG: radii.panel },
      Tooltip: { colorBgSpotlight: p.surfaceContainerHighest, colorTextLightSolid: p.onSurface, borderRadius: 12 },
      Message: { contentBg: 'transparent', borderRadiusLG: radii.panel },
      Notification: { colorBgElevated: 'transparent', borderRadiusLG: radii.panel },
      Segmented: { trackBg: p.surfaceContainer, itemSelectedBg: p.primaryContainer, itemSelectedColor: p.onPrimaryContainer },
      Tag: { defaultBg: p.surfaceContainer, defaultColor: p.onSurface },
    },
  }
}

// Default (light) theme, kept for code that imports `theme`.
export const theme: ThemeConfig = buildTheme()
