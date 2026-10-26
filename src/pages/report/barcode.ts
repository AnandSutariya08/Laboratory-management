// Minimal Code 128 (subset B) encoder returning an SVG string. Plain text input only.
const PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(' ')

export function code128Svg(text: string, height = 36, bar = 1.4): string {
  const chars = [...text].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)
  if (!chars.length || PATTERNS.length !== 107) return ''
  const codes = [104, ...chars.map((c) => c.charCodeAt(0) - 32)]
  const sum = codes.reduce((s, c, i) => s + c * (i === 0 ? 1 : i), 0)
  codes.push(sum % 103, 106)
  let x = 10 * bar
  let rects = ''
  for (const c of codes) {
    const widths = PATTERNS[c].split('').map(Number)
    widths.forEach((w, i) => {
      if (i % 2 === 0) rects += `<rect x="${x.toFixed(2)}" y="0" width="${(w * bar).toFixed(2)}" height="${height}"/>`
      x += w * bar
    })
  }
  const width = x + 10 * bar
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height}" width="${width.toFixed(0)}" height="${height}" role="img" aria-label="Barcode ${text}" fill="#000">${rects}</svg>`
}
