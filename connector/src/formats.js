import * as astm from './astm.js'
import * as hl7 from './hl7.js'

// Turns one received transmission or file into the messages to send, one per sample.
// Returns [{ body, barcode }] where body is ASTM / HL7 text or a JSON object {barcode, results}.

export function detect(text) {
  const t = text.replace(/^[\s\x00-\x1f]+/, '')
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  if (/(^|[\r\n])MSH\|/.test(text)) return 'hl7'
  if (/(^|[\r\n\x02])\d?H\|/.test(text)) return 'astm'
  if (/[,;\t]/.test(t.split(/\r?\n/)[0] || '')) return 'csv'
  return 'unknown'
}

const astmBarcode = (m) => {
  const o = astm.records(m).find((r) => r.startsWith('O|'))
  const f = o ? o.split('|') : []
  return (f[2] || '').split('^')[0] || (f[3] || '').split('^')[0] || ''
}

const hl7Barcode = (m) => {
  for (const s of m.split('\r')) {
    const f = s.split('|')
    if (f[0] === 'OBR' || f[0] === 'ORC') {
      const b = (f[3] || '').split('^')[0] || (f[2] || '').split('^')[0]
      if (b) return b
    }
    if (f[0] === 'SPM') return (f[2] || '').split('^')[0]
  }
  return ''
}

// CSV with a header row. Recognised columns (any case): barcode / sample / sample id / specimen,
// code / test / test code / parameter, value / result, unit, flag. One row per result; rows are grouped by barcode.
export function parseCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const sep = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0]
  const cells = (l) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
  const head = cells(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''))
  const col = (...names) => head.findIndex((h) => names.includes(h))
  const ib = col('barcode', 'sample', 'sampleid', 'sampleno', 'specimen', 'specimenid', 'sid')
  const ic = col('code', 'test', 'testcode', 'parameter', 'param', 'analyte', 'assay')
  const iv = col('value', 'result', 'resultvalue')
  const iu = col('unit', 'units')
  const iff = col('flag', 'flags', 'abnormal')
  if (ib < 0 || ic < 0 || iv < 0) throw new Error('CSV needs columns for barcode, test code and value')
  const groups = new Map()
  for (const l of lines.slice(1)) {
    const c = cells(l)
    const barcode = c[ib]
    if (!barcode || !c[ic] || c[iv] === undefined || c[iv] === '') continue
    if (!groups.has(barcode)) groups.set(barcode, [])
    groups.get(barcode).push({ code: c[ic], value: c[iv], unit: iu >= 0 ? c[iu] : '', flag: iff >= 0 ? c[iff] : '' })
  }
  return [...groups].map(([barcode, results]) => ({ body: { barcode, results }, barcode }))
}

export function toMessages(text, format = 'auto') {
  const f = format === 'auto' ? detect(text) : format
  if (f === 'astm') {
    const { messages, queries } = astm.split(text)
    return { format: f, queries, messages: messages.map((m) => ({ body: m, barcode: astmBarcode(m) })) }
  }
  if (f === 'hl7') {
    const { messages } = hl7.split(text)
    return { format: f, queries: [], messages: messages.map((m) => ({ body: m, barcode: hl7Barcode(m) })) }
  }
  if (f === 'csv') return { format: f, queries: [], messages: parseCsv(text) }
  if (f === 'json') {
    const v = JSON.parse(text)
    const list = Array.isArray(v) ? v : [v]
    return { format: f, queries: [], messages: list.map((b) => ({ body: b, barcode: String(b.barcode ?? b.sampleId ?? '') })) }
  }
  return { format: f, queries: [], messages: [] }
}
