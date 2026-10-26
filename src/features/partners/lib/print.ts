// Open a plain white printable document in a new window (print styles only, no glass).
export function printHtml(title: string, bodyHtml: string) {
  const w = window.open('', '_blank', 'width=900,height=1000')
  if (!w) return false
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font:13px/1.5 system-ui,sans-serif;color:#111;margin:32px}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:16px 0 6px}
 table{border-collapse:collapse;width:100%;margin-top:12px}
 th,td{border:1px solid #bbb;padding:6px 8px;text-align:left} th{background:#f1f1f1}
 td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
 .meta{display:flex;justify-content:space-between;gap:24px}
 .muted{color:#555}
</style></head><body>${bodyHtml}</body></html>`)
  w.document.close()
  w.focus()
  setTimeout(() => w.print(), 250)
  return true
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
