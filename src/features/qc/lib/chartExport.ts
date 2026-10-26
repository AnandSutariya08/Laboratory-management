// Export a Recharts chart (the <svg> inside `host`) as PNG, or open a print view (save as PDF).
function inlined(svg: SVGSVGElement): { node: SVGSVGElement; w: number; h: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const a = [svg, ...Array.from(svg.querySelectorAll('*'))]
  const b = [clone, ...Array.from(clone.querySelectorAll('*'))]
  a.forEach((el, i) => {
    const cs = getComputedStyle(el)
    const t = b[i] as SVGElement
    for (const p of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'font-size', 'font-family', 'opacity']) t.style.setProperty(p, cs.getPropertyValue(p))
  })
  const r = svg.getBoundingClientRect()
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(r.width))
  clone.setAttribute('height', String(r.height))
  return { node: clone, w: r.width, h: r.height }
}

export function exportChart(host: HTMLElement | null, title: string, kind: 'png' | 'pdf') {
  const svg = host?.querySelector('svg.recharts-surface') as SVGSVGElement | null
  if (!svg) return false
  const { node, w, h } = inlined(svg)
  const xml = new XMLSerializer().serializeToString(node)
  if (kind === 'pdf') {
    const win = window.open('', '_blank')
    if (!win) return false
    const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    win.document.write(`<html><head><title>${esc}</title><style>body{font:13px sans-serif;margin:24px}</style></head><body><h3>${esc}</h3>${xml}</body></html>`)
    win.document.close()
    win.print()
    return true
  }
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas')
    c.width = w * 2
    c.height = h * 2
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.scale(2, 2)
    ctx.drawImage(img, 0, 0, w, h)
    c.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title.replace(/[^\w-]+/g, '-')}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
  return true
}
