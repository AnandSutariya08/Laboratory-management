import { useEffect, useRef, useState } from 'react'
import { App } from 'antd'
import { BoldOutlined, ItalicOutlined, OrderedListOutlined, UnderlineOutlined, UnorderedListOutlined, UploadOutlined } from '@ant-design/icons'
import { Button } from '../../design/Button'
import { sanitizeRich } from '../../lib/results'
import { compressParamImage, readParamPdf } from './media'

// Small rich-text editor (bold, italic, underline, lists). Stored value is sanitised HTML.
export function RichEditor({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el && el.innerHTML !== sanitizeRich(value)) el.innerHTML = sanitizeRich(value)
  }, [value])
  const cmd = (c: string) => {
    document.execCommand(c)
    ref.current?.focus()
  }
  const commit = () => {
    const html = sanitizeRich(ref.current?.innerHTML ?? '')
    if (html !== value) onChange(html)
  }
  return (
    <div className="re-rich">
      {!disabled && (
        <div className="re-rich__bar" role="toolbar" aria-label={`Format ${label}`}>
          {(
            [
              ['bold', <BoldOutlined />, 'Bold'],
              ['italic', <ItalicOutlined />, 'Italic'],
              ['underline', <UnderlineOutlined />, 'Underline'],
              ['insertUnorderedList', <UnorderedListOutlined />, 'Bulleted list'],
              ['insertOrderedList', <OrderedListOutlined />, 'Numbered list'],
            ] as [string, React.ReactNode, string][]
          ).map(([c, icon, name]) => (
            <Button key={c} variant="text" icon={icon} aria-label={name} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd(c)} />
          ))}
        </div>
      )}
      <div
        ref={ref}
        className="re-rich__body"
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-disabled={disabled}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onBlur={commit}
      />
    </div>
  )
}

// Image or PDF result: picked from disk, shrunk, stored inline as a data URL.
export function FileInput({ kind, label, value, disabled, onChange }: { kind: 'image' | 'pdf'; label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  const pick = async (file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      onChange(kind === 'image' ? await compressParamImage(file) : await readParamPdf(file))
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not attach the file')
    } finally {
      setBusy(false)
      if (ref.current) ref.current.value = ''
    }
  }
  return (
    <span className="re-file">
      {value && kind === 'image' && <img className="re-file__img" src={value} alt={label} />}
      {value && kind === 'pdf' && (
        <a href={value} target="_blank" rel="noreferrer" download={`${label}.pdf`}>
          View PDF
        </a>
      )}
      {!disabled && (
        <>
          <input ref={ref} type="file" hidden accept={kind === 'image' ? 'image/*' : 'application/pdf'} aria-label={`Upload ${label}`} onChange={(e) => pick(e.target.files?.[0])} />
          <Button icon={<UploadOutlined />} disabled={busy} onClick={() => ref.current?.click()}>
            {value ? 'Replace' : kind === 'image' ? 'Add image' : 'Add PDF'}
          </Button>
          {value && <Button variant="text" onClick={() => onChange('')}>Remove</Button>}
        </>
      )}
    </span>
  )
}
