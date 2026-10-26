import { parseCsv } from '../features/partners/lib/csv'

// Spreadsheet helpers without a dependency.
// Write: SpreadsheetML 2003 XML saved as .xls (opens in Excel, LibreOffice and Google Sheets).
// Read: CSV, SpreadsheetML (.xls / .xml) and real .xlsx (a zip of XML read with the browser's
// DecompressionStream), first sheet only.

const xmlEsc = (v: unknown) =>
  String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

export function toSpreadsheetXml(rows: unknown[][], sheetName = 'Sheet1'): string {
  const body = rows
    .map((r) => `<Row>${r.map((v) => (typeof v === 'number' && Number.isFinite(v) ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`)).join('')}</Row>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${xmlEsc(sheetName).slice(0, 31)}"><Table>${body}</Table></Worksheet></Workbook>`
}

export function downloadXls(filename: string, rows: unknown[][], sheetName?: string) {
  const blob = new Blob([toSpreadsheetXml(rows, sheetName)], { type: 'application/vnd.ms-excel' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.xls') ? filename : `${filename}.xls`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---- reading -------------------------------------------------------------------

function parseSpreadsheetXml(text: string): string[][] {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const out: string[][] = []
  for (const row of Array.from(doc.getElementsByTagNameNS('*', 'Row'))) {
    const cells: string[] = []
    for (const cell of Array.from(row.getElementsByTagNameNS('*', 'Cell'))) {
      const idx = cell.getAttribute('ss:Index') ?? cell.getAttributeNS('urn:schemas-microsoft-com:office:spreadsheet', 'Index')
      if (idx) while (cells.length < Number(idx) - 1) cells.push('')
      cells.push(cell.getElementsByTagNameNS('*', 'Data')[0]?.textContent ?? '')
    }
    if (cells.some((c) => c.trim() !== '')) out.push(cells)
  }
  return out
}

interface ZipEntry { name: string; method: number; csize: number; offset: number }

function readZipDirectory(buf: ArrayBuffer): ZipEntry[] {
  const dv = new DataView(buf)
  let eocd = -1
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('This file is not a valid .xlsx workbook.')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  const out: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const offset = dv.getUint32(p + 42, true)
    out.push({ name: dec.decode(new Uint8Array(buf, p + 46, nameLen)), method, csize, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

async function readZipEntry(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf)
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true)
  const data = new Uint8Array(buf, start, e.csize)
  if (e.method === 0) return new TextDecoder().decode(data)
  if (e.method !== 8) throw new Error('Unsupported compression in the .xlsx file.')
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read .xlsx files. Save the sheet as CSV and upload that.')
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

const colIndex = (ref: string) => {
  let n = 0
  for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

async function parseXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const entries = readZipDirectory(buf)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const sheetName = [...byName.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0]
  if (!sheetName) throw new Error('No worksheet found in the .xlsx file.')
  const parser = new DOMParser()
  let shared: string[] = []
  const ss = byName.get('xl/sharedStrings.xml')
  if (ss) {
    const doc = parser.parseFromString(await readZipEntry(buf, ss), 'application/xml')
    shared = Array.from(doc.getElementsByTagNameNS('*', 'si')).map((si) => Array.from(si.getElementsByTagNameNS('*', 't')).map((t) => t.textContent ?? '').join(''))
  }
  const sheet = parser.parseFromString(await readZipEntry(buf, byName.get(sheetName)!), 'application/xml')
  const out: string[][] = []
  for (const row of Array.from(sheet.getElementsByTagNameNS('*', 'row'))) {
    const cells: string[] = []
    for (const c of Array.from(row.getElementsByTagNameNS('*', 'c'))) {
      const ref = c.getAttribute('r')
      if (ref) while (cells.length < colIndex(ref)) cells.push('')
      const t = c.getAttribute('t')
      const v = c.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? ''
      let val = v
      if (t === 's') val = shared[Number(v)] ?? ''
      else if (t === 'inlineStr') val = Array.from(c.getElementsByTagNameNS('*', 't')).map((x) => x.textContent ?? '').join('')
      cells.push(val)
    }
    if (cells.some((x) => x.trim() !== '')) out.push(cells)
  }
  return out
}

// First sheet of a .csv, .xls (SpreadsheetML), .xml or .xlsx file as rows of strings.
export async function readSheetRows(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase()
  const buf = await file.arrayBuffer()
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength))
  const isZip = head[0] === 0x50 && head[1] === 0x4b
  if (isZip || name.endsWith('.xlsx')) return parseXlsx(buf)
  const text = new TextDecoder().decode(buf)
  if (name.endsWith('.xls') || name.endsWith('.xml') || /^\s*<\?xml|^\s*<Workbook/i.test(text)) return parseSpreadsheetXml(text)
  return parseCsv(text)
}

// Header row -> objects keyed by lower-cased trimmed header (same shape as parseCsvObjects).
export function rowsToObjects(rows: string[][]): Record<string, string>[] {
  const [head, ...rest] = rows
  if (!head) return []
  const keys = head.map((h) => String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_'))
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, String(r[i] ?? '').trim()])))
}

// Excel stores dates as day serials; turn one into YYYY-MM-DD (other text passes through).
export function excelDateToIso(v: string): string {
  if (!/^\d{4,6}(\.\d+)?$/.test(v)) return v
  const n = Number(v)
  if (n < 20000 || n > 80000) return v
  const d = new Date(Math.round((n - 25569) * 86400 * 1000))
  return d.toISOString().slice(0, 10)
}
