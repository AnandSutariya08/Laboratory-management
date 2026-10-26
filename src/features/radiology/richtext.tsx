import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import { fillTokens } from './lib'

const ALLOWED = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'UL', 'OL', 'LI', 'P', 'BR', 'DIV', 'SPAN'])
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE'])
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const HAS_TAGS = /<\/?(b|i|u|strong|em|ul|ol|li|p|br|div|span)\b[^>]*>/i

function clean(node: Node, out: string[]) {
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) out.push(esc(n.textContent ?? ''))
    else if (n.nodeType === 1) {
      const el = n as Element
      const tag = el.tagName
      if (DROP.has(tag)) return
      if (ALLOWED.has(tag)) {
        const t = tag.toLowerCase()
        if (t === 'br') out.push('<br>')
        else {
          out.push(`<${t}>`)
          clean(el, out)
          out.push(`</${t}>`)
        }
      } else clean(el, out)
    }
  })
}

// Allow-list sanitiser. Plain text (no known tags) is escaped and newlines become <br>.
export function sanitizeRadHtml(input: string | undefined | null): string {
  const text = input ?? ''
  if (!text) return ''
  if (!HAS_TAGS.test(text)) return esc(text).replace(/\r?\n/g, '<br>')
  const doc = new DOMParser().parseFromString(`<body>${text}</body>`, 'text/html')
  const out: string[] = []
  clean(doc.body, out)
  return out.join('')
}
// Shared helper: render stored radiology text (plain or HTML) as safe HTML.
export const radHtml = sanitizeRadHtml
export const radHtmlProps = (text: string | undefined | null) => ({ dangerouslySetInnerHTML: { __html: sanitizeRadHtml(text) } })
export const radHasText = (text: string | undefined | null) => {
  const h = sanitizeRadHtml(text)
  return /<li>/.test(h) || h.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0
}

export interface RichHandle {
  insertText: (text: string) => void
  focus: () => void
}

const CMDS: { cmd: string; label: string; title: string; style?: React.CSSProperties }[] = [
  { cmd: 'bold', label: 'B', title: 'Bold', style: { fontWeight: 700 } },
  { cmd: 'italic', label: 'I', title: 'Italic', style: { fontStyle: 'italic' } },
  { cmd: 'underline', label: 'U', title: 'Underline', style: { textDecoration: 'underline' } },
  { cmd: 'insertUnorderedList', label: '• List', title: 'Bullet list' },
  { cmd: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
  { cmd: 'undo', label: 'Undo', title: 'Undo' },
  { cmd: 'redo', label: 'Redo', title: 'Redo' },
  { cmd: 'removeFormat', label: 'Clear', title: 'Clear formatting' },
]

interface Props {
  id: string
  label: string
  value: string
  onChange: (html: string) => void
  disabled?: boolean
  minHeight?: number
  onActive?: (h: RichHandle) => void
}

const RichText = forwardRef<RichHandle, Props>(function RichText({ id, label, value, onChange, disabled, minHeight = 80, onActive }, ref) {
  const el = useRef<HTMLDivElement>(null)
  const saved = useRef<Range | null>(null)

  useEffect(() => {
    const e = el.current
    if (!e) return
    const html = sanitizeRadHtml(value)
    if (e.innerHTML !== html) e.innerHTML = html
  }, [value])

  const emit = () => {
    const e = el.current
    if (!e) return
    const h = sanitizeRadHtml(e.innerHTML)
    onChange(radHasText(h) ? h : '')
  }
  const remember = () => {
    const s = window.getSelection()
    if (s && s.rangeCount && el.current?.contains(s.anchorNode)) saved.current = s.getRangeAt(0).cloneRange()
  }
  const restore = () => {
    el.current?.focus()
    const s = window.getSelection()
    if (s && saved.current) {
      s.removeAllRanges()
      s.addRange(saved.current)
    }
  }
  const handle: RichHandle = {
    focus: () => el.current?.focus(),
    insertText: (text) => {
      if (disabled) return
      restore()
      document.execCommand('insertText', false, text)
      emit()
    },
  }
  useImperativeHandle(ref, () => handle)

  const run = (cmd: string) => {
    restore()
    document.execCommand(cmd, false)
    emit()
  }

  return (
    <div className="rd-field">
      <label id={`${id}-l`}>{label}</label>
      {!disabled && (
        <div className="rt-bar" role="toolbar" aria-label={`${label} formatting`}>
          {CMDS.map((c) => (
            <button key={c.cmd} type="button" className="rt-btn" title={c.title} aria-label={c.title} style={c.style} onMouseDown={(ev) => ev.preventDefault()} onClick={() => run(c.cmd)}>{c.label}</button>
          ))}
        </div>
      )}
      <div
        id={id}
        ref={el}
        className={`rt-edit${disabled ? ' rt-edit--off' : ''}`}
        role="textbox"
        aria-multiline="true"
        aria-labelledby={`${id}-l`}
        contentEditable={!disabled}
        suppressContentEditableWarning
        style={{ minHeight }}
        onInput={emit}
        onBlur={() => { remember(); emit() }}
        onKeyUp={remember}
        onMouseUp={remember}
        onFocus={() => onActive?.(handle)}
        onPaste={(ev) => {
          ev.preventDefault()
          document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'))
        }}
      />
    </div>
  )
})
export default RichText

export { fillTokens }
