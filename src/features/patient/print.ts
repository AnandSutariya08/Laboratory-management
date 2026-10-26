// Small helpers for printable sheets (worksheet, TRF, tables). They open a plain
// white document in a new window so the print layout never depends on the app theme.

import { labContactLine } from '../settings/lib'

export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export const PRINT_CSS = `
body{font-family:Inter,Arial,sans-serif;font-size:12px;color:#111;margin:12mm}
h1{font-size:18px;margin:0}h2{font-size:14px;margin:14px 0 4px}
.hdr{border-bottom:2px solid #333;padding-bottom:6px;margin-bottom:10px}
.muted{color:#555}
table{border-collapse:collapse;width:100%;margin:6px 0}
th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#eee}
.blank{display:inline-block;min-width:90px;border-bottom:1px solid #333;height:14px}
.sig{display:flex;gap:40px;margin-top:40px}.sig div{flex:1;border-top:1px solid #333;padding-top:4px}
.mono{font-family:ui-monospace,Menlo,monospace;letter-spacing:2px}
.brk{page-break-after:always}
@page{size:A4;margin:10mm}
`

export function printHtml(title: string, body: string, extraCss = ''): boolean {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}${extraCss}</style></head><body>${body}</body></html>`,
  )
  w.document.close()
  w.focus()
  setTimeout(() => w.print(), 250)
  return true
}

export function labHeader(s: { name: string; address: string; phone: string; email: string; profile?: { website?: string } }, title: string) {
  return `<div class="hdr"><h1>${esc(s.name)}</h1><div class="muted">${esc(s.address)} ${esc(labContactLine(s))}</div><h2 style="margin-top:8px">${esc(title)}</h2></div>`
}

export function tableHtml(head: string[], rows: (string | number)[][]) {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`
}
