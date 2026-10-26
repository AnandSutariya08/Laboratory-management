import { createContext, useContext, useRef, type ReactNode } from 'react'
import { App, Checkbox, Input as AntInput, InputNumber, Select, Switch } from 'antd'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import type { LabSettings } from '../../types'

export interface DraftCtx {
  draft: LabSettings
  // Set a value at a path inside the draft, e.g. set(['reportDetails', 'showQr'], true)
  set: (path: (string | number)[], value: unknown) => void
  canEdit: boolean
}
export const DraftContext = createContext<DraftCtx | null>(null)
// eslint-disable-next-line react-refresh/only-export-components
export const useDraft = () => {
  const c = useContext(DraftContext)
  if (!c) throw new Error('useDraft outside provider')
  return c
}

type Key = keyof LabSettings

// Typed accessors for one group of the settings doc.
// eslint-disable-next-line react-refresh/only-export-components
export function useGroup<K extends Key>(key: K) {
  const { draft, set } = useDraft()
  const value = draft[key]
  const put = <F extends keyof LabSettings[K]>(field: F, v: LabSettings[K][F]) => set([key as string, field as string], v)
  return [value, put] as const
}

export function SectionCard({ title, description, children, extra }: { title: string; description?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <Card as="section" padding="var(--s-5)">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
        <h2 className="st-card-title">{title}</h2>
        {extra}
      </div>
      {description && <p className="st-card-desc">{description}</p>}
      {children}
    </Card>
  )
}

export function SwitchRow({ title, description, checked, onChange }: { title: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="st-row">
      <div className="st-row__text">
        <div className="st-row__title">{title}</div>
        {description && <div className="st-row__desc">{description}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} aria-label={title} />
    </div>
  )
}

export function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`st-field ${wide ? 'st-field--wide' : ''}`}>
      <span className="st-field__label">{label}</span>
      {children}
      {hint && <span className="st-field__hint">{hint}</span>}
    </label>
  )
}

export function CheckGrid({ options, value, onChange }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return <Checkbox.Group options={options} value={value} onChange={(v) => onChange(v as string[])} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--s-2)' }} />
}

const MAX_IMAGE_BYTES = 200 * 1024

export function ImagePicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { message } = App.useApp()
  const input = useRef<HTMLInputElement>(null)
  const pick = (f?: File) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return message.error('Choose an image file')
    if (f.size > MAX_IMAGE_BYTES) return message.error('Image must be 200 KB or smaller')
    const r = new FileReader()
    r.onload = () => onChange(String(r.result))
    r.readAsDataURL(f)
  }
  return (
    <div className="st-actions">
      {value && <img src={value} alt={`${label} preview`} className="st-logo" />}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
      <Button onClick={() => input.current?.click()}>{value ? `Replace ${label}` : `Upload ${label}`}</Button>
      {value && <Button variant="text" onClick={() => onChange('')}>Remove</Button>}
      <span className="st-field__hint">PNG or JPG, up to 200 KB</span>
    </div>
  )
}

// Loosely-typed bound controls for one settings group; keeps section files short.
// Components are created once per group (stable identity, so inputs keep focus).
type Opt = { value: string; label: string }
type Group = Record<string, unknown>
function useG(group: keyof LabSettings) {
  const { draft, set } = useDraft()
  return { g: draft[group] as unknown as Group, put: (f: string, v: unknown) => set([group, f], v) }
}
function make(group: keyof LabSettings) {
  return {
    Txt(p: { f: string; label: string; hint?: string; area?: boolean; wide?: boolean; placeholder?: string; type?: string }) {
      const { g, put } = useG(group)
      return (
        <Field label={p.label} hint={p.hint} wide={p.wide || p.area}>
          {p.area ? (
            <AntInput.TextArea rows={3} value={(g[p.f] as string) ?? ''} placeholder={p.placeholder} onChange={(e) => put(p.f, e.target.value)} />
          ) : (
            <AntInput type={p.type} value={(g[p.f] as string) ?? ''} placeholder={p.placeholder} onChange={(e) => put(p.f, e.target.value)} />
          )}
        </Field>
      )
    },
    Num(p: { f: string; label: string; hint?: string; min?: number; max?: number }) {
      const { g, put } = useG(group)
      return (
        <Field label={p.label} hint={p.hint}>
          <InputNumber style={{ width: '100%' }} min={p.min ?? 0} max={p.max} value={g[p.f] as number} onChange={(v) => put(p.f, v ?? 0)} />
        </Field>
      )
    },
    Sel(p: { f: string; label: string; hint?: string; options: Opt[] }) {
      const { g, put } = useG(group)
      return (
        <Field label={p.label} hint={p.hint}>
          <Select value={g[p.f] as string} options={p.options} onChange={(v) => put(p.f, v)} />
        </Field>
      )
    },
    Sw(p: { f: string; title: string; description?: string }) {
      const { g, put } = useG(group)
      return <SwitchRow title={p.title} description={p.description} checked={!!g[p.f]} onChange={(v) => put(p.f, v)} />
    },
    Checks(p: { f: string; options: Opt[] }) {
      const { g, put } = useG(group)
      return <CheckGrid options={p.options} value={(g[p.f] as string[]) ?? []} onChange={(v) => put(p.f, v)} />
    },
    Img(p: { f: string; label: string }) {
      const { g, put } = useG(group)
      return <ImagePicker label={p.label} value={(g[p.f] as string) ?? ''} onChange={(v) => put(p.f, v)} />
    },
  }
}
const cache = new Map<string, ReturnType<typeof make>>()
export function bind(group: keyof LabSettings) {
  let c = cache.get(group)
  if (!c) cache.set(group, (c = make(group)))
  return c
}
