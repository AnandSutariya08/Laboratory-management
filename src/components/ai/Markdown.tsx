import type { ReactNode } from 'react'

// Tiny markdown renderer: **bold**, `code`, "- " / "* " / "1. " lists, line breaks.
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    out.push(
      t.startsWith('**') ? <strong key={i++}>{t.slice(2, -2)}</strong> : <code key={i++}>{t.slice(1, -1)}</code>,
    )
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const Tag = list.ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag key={blocks.length} style={{ margin: '4px 0', paddingLeft: 22 }}>
        {list.items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </Tag>,
    )
    list = null
  }
  for (const raw of lines) {
    const ul = /^\s*[-*]\s+(.*)$/.exec(raw)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw)
    if (ul || ol) {
      const ordered = !!ol
      if (list && list.ordered !== ordered) flush()
      if (!list) list = { ordered, items: [] }
      list.items.push((ul ?? ol)![1])
      continue
    }
    flush()
    if (raw.trim() === '') blocks.push(<div key={blocks.length} style={{ height: 6 }} />)
    else {
      const h = /^#{1,6}\s+(.*)$/.exec(raw)
      blocks.push(
        <div key={blocks.length} style={h ? { fontWeight: 600 } : undefined}>
          {inline(h ? h[1] : raw)}
        </div>,
      )
    }
  }
  flush()
  return <div style={{ lineHeight: 1.55, wordBreak: 'break-word' }}>{blocks}</div>
}
