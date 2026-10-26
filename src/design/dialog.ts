import type { ModalProps } from 'antd'

// Responsive dialog width (DESIGN.md layout). `base` is the width the dialog was designed at for a
// 13-14" laptop. Form and table dialogs grow on wider screens so they use the room a desktop gives;
// small confirm-style dialogs (< 560) stay compact. Antd breakpoints: xl >= 1200, xxl >= 1600.
// The viewport cap (never wider than the window less 48px) lives in glass.css.
export function dialogWidth(base: number): NonNullable<ModalProps['width']> {
  if (base < 560) return base
  return {
    xs: '100%',
    sm: '100%',
    md: base,
    lg: base,
    xl: Math.round(base * 1.15),
    xxl: Math.round(base * 1.4),
  }
}
