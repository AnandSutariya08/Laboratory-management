// WCAG 2.2 contrast helpers (DESIGN.md §8). Used to verify palette pairs and to
// pick a readable foreground over an arbitrary background.

type RGB = [number, number, number]

export function parseColor(input: string): RGB | null {
  const s = input.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = [...h].map((c) => c + c).join('')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

export function relativeLuminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(fg: string, bg: string): number {
  const a = parseColor(fg)
  const b = parseColor(bg)
  if (!a || !b) return 1
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export type ContrastKind = 'text' | 'large' | 'ui'

// AA: 4.5 body text, 3 large text (>= 18px or 14px bold) and non-text UI parts.
// AAA (increase contrast): 7 / 4.5 / 4.5.
export function meetsContrast(fg: string, bg: string, kind: ContrastKind = 'text', level: 'AA' | 'AAA' = 'AA') {
  const need = level === 'AA' ? (kind === 'text' ? 4.5 : 3) : kind === 'text' ? 7 : 4.5
  return contrastRatio(fg, bg) >= need
}

// First candidate that reads on bg, else whichever has the best ratio.
export function readableOn(bg: string, candidates: string[], kind: ContrastKind = 'text'): string {
  const ok = candidates.find((c) => meetsContrast(c, bg, kind))
  if (ok) return ok
  return [...candidates].sort((x, y) => contrastRatio(y, bg) - contrastRatio(x, bg))[0]
}
