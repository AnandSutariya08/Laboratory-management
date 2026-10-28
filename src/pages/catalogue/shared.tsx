import { useState } from 'react'
import { InputNumber, Input, Upload } from 'antd'
import { writeBatch, type DocumentReference } from 'firebase/firestore'
import { db } from '../../firebase'
import { Button } from '../../design/Button'
import { UploadOutlined } from '@ant-design/icons'
import { csvCell, parseCsv } from './helpers'
import { joinTat, splitTat } from './ext'

import './catalogue.css'

export const csvLine = (cells: (string | number | boolean | null | undefined)[]) =>
  cells.map((c) => csvCell(String(c ?? ''))).join(',')

// Commits on blur / Enter only when the value changed.
export function EditableText({
  value,
  onCommit,
  label,
  disabled,
  placeholder,
}: {
  value: string
  onCommit: (v: string) => void
  label: string
  disabled?: boolean
  placeholder?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = draft.trim()
    setDraft(null)
    if (v !== value) onCommit(v)
  }
  return (
    <Input
      size="small"
      aria-label={label}
      disabled={disabled}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onPressEnter={commit}
    />
  )
}

// Days / hours / minutes editor bound to a total in minutes.
export function TatInput({
  value,
  onChange,
  label,
  disabled,
}: {
  value?: number | null
  onChange?: (v: number | null) => void
  label: string
  disabled?: boolean
}) {
  const { d, h, m } = splitTat(value)
  const set = (nd: number | null, nh: number | null, nm: number | null) => onChange?.(joinTat(nd, nh, nm))
  return (
    <span className="cat-tat">
      <InputNumber size="small" min={0} aria-label={`${label} days`} disabled={disabled} value={d} suffix="d" style={{ width: 84 }} onChange={(v) => set(v, h, m)} />
      <InputNumber size="small" min={0} max={23} aria-label={`${label} hours`} disabled={disabled} value={h} suffix="h" style={{ width: 84 }} onChange={(v) => set(d, v, m)} />
      <InputNumber size="small" min={0} max={59} aria-label={`${label} minutes`} disabled={disabled} value={m} suffix="m" style={{ width: 84 }} onChange={(v) => set(d, h, v)} />
    </span>
  )
}

// CSV file picker; hands the parsed rows (including header) to the callback.
export function CsvUpload({ onRows, children, disabled }: { onRows: (rows: string[][], fileName: string) => void; children: string; disabled?: boolean }) {
  return (
    <Upload
      accept=".csv,text/csv"
      showUploadList={false}
      disabled={disabled}
      beforeUpload={async (f) => {
        onRows(parseCsv(await f.text()), f.name)
        return false
      }}
    >
      <Button icon={<UploadOutlined />} disabled={disabled}>
        {children}
      </Button>
    </Upload>
  )
}

// Column lookup for a parsed CSV header row.
export function headerIndex(row: string[]) {
  const h = row.map((x) => x.trim().toLowerCase())
  return (name: string) => h.indexOf(name)
}

// Firestore batches hold at most 500 writes.
export async function commitBatch(ops: Array<(b: ReturnType<typeof writeBatch>) => void>) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db)
    ops.slice(i, i + 400).forEach((op) => op(batch))
    await batch.commit()
  }
}

export const mergeOp =
  (ref: DocumentReference, data: Record<string, unknown>) => (b: ReturnType<typeof writeBatch>) =>
    b.set(ref, data, { merge: true })
