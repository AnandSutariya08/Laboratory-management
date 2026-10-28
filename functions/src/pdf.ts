import { inflateSync, deflateSync } from 'node:zlib'
import type { DocumentData } from 'firebase-admin/firestore'
import { ageDaysOf, flagOf, rangeFor, richToLines, type ReportPayload } from './snapshot'
import { advanceOf, getFont, initFonts, measure, runs, shapeRun, subsetFont, type Fam, type Glyph } from './pdffonts'

// Minimal PDF 1.4 writer: Unicode text (Latin, Devanagari, Gujarati, Bengali, Tamil) set in embedded, subsetted
// Noto Sans TrueType fonts (CIDFontType2, Identity-H, ToUnicode) after HarfBuzz shaping, plus lines, rectangles,
// JPEG and PNG images and multiple pages. buildReportPdf renders a frozen report payload.

// PDF text string (UTF-16BE hex) for document metadata.
const pdfStr = (s: string) => `<FEFF${Buffer.from(String(s ?? ''), 'utf16le').swap16().toString('hex')}>`

export function textWidth(s: string, size: number, bold = false): number {
  return measure(s, size, bold)
}

export function wrap(text: string, size: number, maxW: number, bold = false): string[] {
  const out: string[] = []
  for (const para of String(text ?? '').split(/\n/)) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = line ? `${line} ${word}` : word
      if (textWidth(cand, size, bold) <= maxW || !line) line = cand
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '')
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
const f2 = (n: number) => (Math.round(n * 100) / 100).toString()

interface Img { obj: number; w: number; h: number }
interface FontUse { name: string; fam: Fam; bold: boolean; used: Map<number, string> }

const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase()
const utf16hex = (t: string) => Buffer.from(t, 'utf16le').swap16().toString('hex').toUpperCase()
function stream(dict: string, body: Buffer): Buffer {
  const z = deflateSync(body)
  return Buffer.concat([Buffer.from(`<< ${dict} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')])
}

export class PdfDoc {
  readonly pw: number
  readonly ph: number
  pages: string[] = []
  private cur = ''
  private objs: (Buffer | null)[] = []
  private imgs: Map<string, Img> = new Map()
  private pageImgs: Set<string>[] = []
  private curImgs = new Set<string>()
  // Fonts in use, keyed by family+weight. A footer scratch document shares its parent's registry.
  readonly fonts: Map<string, FontUse>
  constructor(pw = 595.28, ph = 841.89, fonts?: Map<string, FontUse>) {
    this.pw = pw
    this.ph = ph
    this.fonts = fonts ?? new Map()
    this.newPage()
  }
  private fontUse(fam: Fam, bold: boolean): FontUse {
    const key = `${fam}${bold ? 'B' : 'R'}`
    let u = this.fonts.get(key)
    if (!u) {
      u = { name: `F${this.fonts.size + 1}`, fam, bold, used: new Map() }
      this.fonts.set(key, u)
    }
    return u
  }
  newPage() {
    if (this.pages.length || this.cur) this.flush()
    this.cur = ''
    this.curImgs = new Set()
  }
  private flush() {
    this.pages.push(this.cur)
    this.pageImgs.push(this.curImgs)
  }
  get pageNo() {
    return this.pages.length + 1
  }
  // y is measured from the TOP of the page.
  text(x: number, y: number, s: string, size = 10, o: { bold?: boolean; color?: string } = {}) {
    const [r, g, b] = hex(o.color ?? '#111111')
    const base = this.ph - y - size * 0.8
    let pen = x
    let out = `${f2(r)} ${f2(g)} ${f2(b)} rg\n`
    for (const run of runs(s)) {
      const sh = shapeRun(run.fam, !!o.bold, run.text)
      const fu = this.fontUse(run.fam, !!o.bold)
      const font = getFont(run.fam, !!o.bold)
      const k = size / sh.upem
      let tj = ''
      let start = pen
      const flush = () => {
        if (tj) out += `BT /${fu.name} ${f2(size)} Tf ${f2(start)} ${f2(base)} Td [${tj}] TJ ET\n`
        tj = ''
      }
      const clusters = [...new Set(sh.glyphs.map((g) => g.cluster))].sort((m, n) => m - n)
      const groups: Glyph[][] = []
      for (const gl of sh.glyphs) {
        const last = groups[groups.length - 1]
        if (last && last[0].cluster === gl.cluster) last.push(gl)
        else groups.push([gl])
      }
      for (const grp of groups) {
        const c0 = grp[0].cluster
        const nx = clusters.find((c) => c > c0)
        const txt = String.fromCodePoint(...sh.cps.slice(c0, nx ?? sh.cps.length))
        // A reordered or split cluster (matra before its consonant, two-part vowel signs) cannot be mapped glyph by glyph:
        // its text is attached with ActualText so copy and search return the original characters.
        const multi = grp.length > 1
        if (multi) {
          flush()
          out += `/Span << /ActualText <FEFF${utf16hex(txt)}> >> BDC\n`
        }
        // ToUnicode: the first glyph of a cluster carries its text (viewers that honour ActualText use that instead).
        if (!fu.used.has(grp[0].gid) || (multi && fu.used.get(grp[0].gid) === '\u200b')) fu.used.set(grp[0].gid, txt)
        for (const gl of grp.slice(1)) if (!fu.used.has(gl.gid)) fu.used.set(gl.gid, '\u200b')
        for (const gl of grp) {
          const hx = gl.gid.toString(16).padStart(4, '0')
          if (gl.xo || gl.yo) {
            flush()
            out += `BT /${fu.name} ${f2(size)} Tf ${f2(pen + gl.xo * k)} ${f2(base + gl.yo * k)} Td [<${hx}>] TJ ET\n`
            pen += gl.adv * k
            start = pen
            continue
          }
          if (!tj) start = pen
          tj += `<${hx}>`
          const diff = gl.adv - advanceOf(font, gl.gid)
          if (diff) tj += ` ${f2((-diff * 1000) / sh.upem)} `
          pen += gl.adv * k
        }
        if (multi) {
          flush()
          out += 'EMC\n'
        }
      }
      flush()
    }
    this.cur += out
  }
  line(x1: number, y1: number, x2: number, y2: number, o: { color?: string; width?: number } = {}) {
    const [r, g, b] = hex(o.color ?? '#999999')
    this.cur += `${f2(r)} ${f2(g)} ${f2(b)} RG ${f2(o.width ?? 0.5)} w ${f2(x1)} ${f2(this.ph - y1)} m ${f2(x2)} ${f2(this.ph - y2)} l S\n`
  }
  rect(x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; width?: number } = {}) {
    let op = ''
    if (o.fill) {
      const [r, g, b] = hex(o.fill)
      op += `${f2(r)} ${f2(g)} ${f2(b)} rg `
    }
    if (o.stroke) {
      const [r, g, b] = hex(o.stroke)
      op += `${f2(r)} ${f2(g)} ${f2(b)} RG ${f2(o.width ?? 0.5)} w `
    }
    this.cur += `${op}${f2(x)} ${f2(this.ph - y - h)} ${f2(w)} ${f2(h)} re ${o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S'}\n`
  }
  // Embeds a JPEG or PNG data URL; returns its pixel size, or null when it cannot be read.
  addImage(dataUrl: string): { key: string; w: number; h: number } | null {
    const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl || '')
    if (!m) return null
    const key = `${m[1].toLowerCase().startsWith('p') ? 'p' : 'j'}${dataUrl.length}${dataUrl.slice(-24)}`
    const got = this.imgs.get(key)
    if (got) return { key, w: got.w, h: got.h }
    try {
      const buf = Buffer.from(m[2], 'base64')
      const img = m[1].toLowerCase().startsWith('p') ? this.png(buf) : this.jpeg(buf)
      if (!img) return null
      this.imgs.set(key, img)
      return { key, w: img.w, h: img.h }
    } catch {
      return null
    }
  }
  drawImage(key: string, x: number, y: number, w: number, h: number) {
    if (!this.imgs.has(key)) return
    this.curImgs.add(key)
    this.cur += `q ${f2(w)} 0 0 ${f2(h)} ${f2(x)} ${f2(this.ph - y - h)} cm /Im${[...this.imgs.keys()].indexOf(key)} Do Q\n`
  }
  private add(b: Buffer): number {
    this.objs.push(b)
    return this.objs.length // object numbers are 1-based; the catalogue objects are reserved at the start of finish()
  }
  private jpeg(buf: Buffer): Img | null {
    let i = 2
    let w = 0
    let h = 0
    let comps = 3
    while (i < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        h = buf.readUInt16BE(i + 5)
        w = buf.readUInt16BE(i + 7)
        comps = buf[i + 9]
        break
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
    if (!w || !h) return null
    const cs = comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK' : '/DeviceRGB'
    const head = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${buf.length} >>\nstream\n`, 'latin1')
    const obj = this.add(Buffer.concat([head, buf, Buffer.from('\nendstream', 'latin1')]))
    return { obj, w, h }
  }
  private png(buf: Buffer): Img | null {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null
    let pos = 8
    let w = 0
    let h = 0
    let depth = 8
    let ctype = 2
    let interlace = 0
    let plte: Buffer | null = null
    const idat: Buffer[] = []
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos)
      const type = buf.toString('latin1', pos + 4, pos + 8)
      const data = buf.subarray(pos + 8, pos + 8 + len)
      if (type === 'IHDR') {
        w = data.readUInt32BE(0)
        h = data.readUInt32BE(4)
        depth = data[8]
        ctype = data[9]
        interlace = data[12]
      } else if (type === 'PLTE') plte = Buffer.from(data)
      else if (type === 'IDAT') idat.push(Buffer.from(data))
      else if (type === 'IEND') break
      pos += 12 + len
    }
    if (!w || !h || depth !== 8 || interlace !== 0 || ![0, 2, 3, 6].includes(ctype)) return null
    const ch = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : 4
    const raw = inflateSync(Buffer.concat(idat))
    const stride = w * ch
    const px = Buffer.alloc(stride * h)
    let prev = Buffer.alloc(stride)
    for (let y = 0; y < h; y++) {
      const ft = raw[y * (stride + 1)]
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
      const out = px.subarray(y * stride, (y + 1) * stride)
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? out[x - ch] : 0
        const b = prev[x]
        const c = x >= ch ? prev[x - ch] : 0
        let v = line[x]
        if (ft === 1) v += a
        else if (ft === 2) v += b
        else if (ft === 3) v += (a + b) >> 1
        else if (ft === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        out[x] = v & 255
      }
      prev = Buffer.from(out)
    }
    let rgb: Buffer
    let alpha: Buffer | null = null
    if (ctype === 2) rgb = px
    else if (ctype === 0) {
      rgb = Buffer.alloc(w * h * 3)
      for (let i = 0; i < w * h; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = px[i]
    } else if (ctype === 3) {
      if (!plte) return null
      rgb = Buffer.alloc(w * h * 3)
      for (let i = 0; i < w * h; i++) {
        const k = px[i] * 3
        rgb[i * 3] = plte[k]
        rgb[i * 3 + 1] = plte[k + 1]
        rgb[i * 3 + 2] = plte[k + 2]
      }
    } else {
      rgb = Buffer.alloc(w * h * 3)
      alpha = Buffer.alloc(w * h)
      for (let i = 0; i < w * h; i++) {
        rgb[i * 3] = px[i * 4]
        rgb[i * 3 + 1] = px[i * 4 + 1]
        rgb[i * 3 + 2] = px[i * 4 + 2]
        alpha[i] = px[i * 4 + 3]
      }
    }
    let smask = 0
    if (alpha) {
      const z = deflateSync(alpha)
      smask = this.add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')]))
    }
    const z = deflateSync(rgb)
    const obj = this.add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${smask ? `/SMask ${smask} 0 R ` : ''}/Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')]))
    return { obj, w, h }
  }

  finish(title: string): Buffer {
    this.flush()
    this.cur = ''
    const imgKeys = [...this.imgs.keys()]
    // Object layout: image objects were added first (1..n). Then fonts, content streams, pages, pages-root, catalogue, info.
    const fontRefs: string[] = []
    let tagN = 0
    for (const fu of this.fonts.values()) {
      const f = getFont(fu.fam, fu.bold)
      const gids = [0, ...fu.used.keys()].sort((a, b) => a - b)
      const ttf = Buffer.from(subsetFont(f, gids))
      const tag = String.fromCharCode(65 + (tagN % 26), 65 + ((tagN / 26) | 0) % 26, 70, 72, 76, 66) // ABFHLB-style prefix, unique per font in the file
      tagN++
      const psName = `${tag}+NotoSans${{ latin: '', deva: 'Devanagari', gujr: 'Gujarati', beng: 'Bengali', taml: 'Tamil' }[fu.fam]}-${fu.bold ? 'Bold' : 'Regular'}`
      const file = this.add(stream(`/Length1 ${ttf.length}`, ttf))
      const sc = 1000 / f.upem
      const desc = this.add(Buffer.from(`<< /Type /FontDescriptor /FontName /${psName} /Flags 4 /FontBBox [${f.bbox.map((v) => Math.round(v * sc)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.ascent * sc)} /Descent ${Math.round(f.descent * sc)} /CapHeight ${Math.round(f.ascent * sc * 0.7)} /StemV ${fu.bold ? 140 : 80} /FontFile2 ${file} 0 R >>`, 'latin1'))
      const widths = gids.map((g) => `${g} [${Math.round(advanceOf(f, g) * sc)}]`).join(' ')
      const cid = this.add(Buffer.from(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${psName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`, 'latin1'))
      const entries = [...fu.used.entries()].map(([g, t]) => `<${hex4(g)}> <${utf16hex(t)}>`)
      let bf = ''
      for (let i = 0; i < entries.length; i += 100) bf += `${Math.min(100, entries.length - i)} beginbfchar\n${entries.slice(i, i + 100).join('\n')}\nendbfchar\n`
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`
      const tu = this.add(stream('', Buffer.from(cmap, 'latin1')))
      const t0 = this.add(Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /${psName} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`, 'latin1'))
      fontRefs.push(`/${fu.name} ${t0} 0 R`)
    }
    const contentIds: number[] = []
    for (const c of this.pages) contentIds.push(this.add(stream('', Buffer.from(c, 'latin1'))))
    const pagesRoot = this.objs.length + this.pages.length + 1
    const pageIds: number[] = []
    this.pages.forEach((_, i) => {
      const xo = [...this.pageImgs[i]].map((k) => `/Im${imgKeys.indexOf(k)} ${this.imgs.get(k)!.obj} 0 R`).join(' ')
      pageIds.push(this.add(Buffer.from(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${f2(this.pw)} ${f2(this.ph)}] /Resources << /Font << ${fontRefs.join(' ')} >> /XObject << ${xo} >> >> /Contents ${contentIds[i]} 0 R >>`, 'latin1')))
    })
    this.add(Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1'))
    const cat = this.add(Buffer.from(`<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`, 'latin1'))
    const info = this.add(Buffer.from(`<< /Title ${pdfStr(title)} /Producer (Health Care Labs) >>`, 'latin1'))
    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
    const offsets: number[] = []
    let len = parts[0].length
    this.objs.forEach((o, i) => {
      offsets.push(len)
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o!, Buffer.from('\nendobj\n', 'latin1')])
      parts.push(b)
      len += b.length
    })
    const xref = [`xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('')
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${this.objs.length + 1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'))
    return Buffer.concat(parts)
  }
}

// ---- Report renderer -----------------------------------------------------------------------------------------

const AGE_SHORT: Record<string, string> = { year: 'Y', month: 'M', day: 'D' }
const FIELD_LABEL: Record<string, string> = {
  name: 'Name', ageGender: 'Age / Gender', age: 'Age', gender: 'Gender', patientId: 'Patient ID', uhid: 'UHID', billNo: 'Bill No', reportNo: 'Report No',
  phone: 'Phone', email: 'Email', address: 'Address', dob: 'Date of birth', altPhone: 'Alternate phone', referrer: 'Referred by', secondReferrer: 'Second referrer',
  hospital: 'Hospital', b2bCentre: 'B2B centre', b2bCode: 'B2B code', collectionCentre: 'Collection centre', corporate: 'Corporate', corporateUser: 'Employee',
  corporatePlan: 'Plan', govPanel: 'Government panel', tpa: 'TPA', registeredAt: 'Registered', billDate: 'Bill date', collectedAt: 'Collected', receivedAt: 'Received',
  reportedAt: 'Reported', sampleType: 'Sample type', barcode: 'Barcode', status: 'Report status', priority: 'Priority', clinicalHistory: 'Clinical history',
  weight: 'Weight', height: 'Height', category: 'Category', source: 'Source', collectionPlace: 'Collection', phlebotomist: 'Collected by', species: 'Species',
  breed: 'Breed', owner: 'Owner', branch: 'Branch', bookingId: 'Booking ID', abhaNo: 'ABHA no', idNumber: 'ID number', insuranceNo: 'Insurance no',
}
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', partial: 'Partial', provisional: 'Provisional', final: 'Final' }
const DEFAULT_FIELDS = ['name', 'ageGender', 'patientId', 'billNo', 'referrer', 'collectedAt', 'reportedAt']
const DEFAULT_W: Record<string, number> = { test: 32, result: 16, flag: 8, reference: 22, unit: 12, method: 14 }
const COL_LABEL: Record<string, string> = { test: 'Test', result: 'Result', flag: 'Flag', reference: 'Reference', unit: 'Unit', method: 'Method' }

const pad2 = (n: number) => String(n).padStart(2, '0')
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDate(isoStr: unknown, dateOnly: boolean): string {
  const t = typeof isoStr === 'string' && isoStr ? Date.parse(isoStr) : NaN
  if (Number.isNaN(t)) return '-'
  const d = new Date(t + 5.5 * 3_600_000) // IST
  const day = `${pad2(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`
  return dateOnly ? day : `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}
export function ageText(v: number, unit: string, format: string): string {
  if (format === 'short') return `${v}${AGE_SHORT[unit] ?? ''}`
  if (format === 'ymd' && unit === 'year') return `${Math.floor(v)}Y ${Math.round((v % 1) * 12)}M`
  return `${v} ${unit}${v === 1 ? '' : 's'}`
}

export async function buildReportPdf(pl: ReportPayload, opts: { revision: number; sha256: string; generatedAt: number }): Promise<Buffer> {
  await initFonts()
  const rd = pl.settings.reportDetails as Record<string, unknown>
  const L = pl.settings.layout
  const o = pl.order as Record<string, any>
  const fields = (o.fields ?? {}) as Record<string, string>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const mm = (v: unknown) => num(v, 10) * 2.8346
  const size: Record<string, [number, number]> = { A4: [595.28, 841.89], A5: [419.53, 595.28], Letter: [612, 792] }
  const [pw, ph] = size[String(rd.pageSize)] ?? size.A4
  const doc = new PdfDoc(pw, ph)
  const mL = mm(rd.marginLeft)
  const mR = mm(rd.marginRight)
  const mT = mm(rd.marginTop)
  const mB = Math.max(mm(rd.marginBottom), 40)
  const cw = pw - mL - mR
  const fs = Math.max(7, Math.min(16, L.fontSize || 12)) * 0.82 // CSS px to pt
  const hs = Math.max(fs, (L.headingSize || 14) * 0.82)
  const lh = fs * 1.35
  const lowC = String(rd.lowColour || '#1D4ED8')
  const highC = String(rd.highColour || '#B91C1C')
  // Pre-printed stationery, or a corporate client whose reports go out without a letterhead: no header or footer is drawn.
  const letterhead = !!rd.useLetterhead || (pl.order as DocumentData).disableLetterhead === true
  let y = mT

  const need = (h: number) => {
    if (y + h > ph - mB) {
      doc.newPage()
      y = mT
      return true
    }
    return false
  }
  const para = (s: string, x: number, w: number, size = fs, o2: { bold?: boolean; color?: string } = {}) => {
    for (const ln of wrap(s, size, w, o2.bold)) {
      need(size * 1.3)
      doc.text(x, y, ln, size, o2)
      y += size * 1.3
    }
  }
  const image = (dataUrl: string, x: number, maxW: number, maxH: number) => {
    const im = doc.addImage(dataUrl)
    if (!im) return 0
    const k = Math.min(maxW / im.w, maxH / im.h)
    const w = im.w * k
    const h = im.h * k
    need(h)
    doc.drawImage(im.key, x, y, w, h)
    return h
  }

  // ---- header
  const lhId = L.defaultLetterheadId
  const lhead = (L.letterheads as DocumentData[]).find((x) => x.id === lhId && x.active !== false)
  if (!letterhead) {
    if (lhead?.headerDataUrl) y += image(lhead.headerDataUrl, mL, cw, 90) + 4
    else if (rd.headerImage) y += image(String(rd.headerImage), mL, cw, 90) + 4
    else {
      const logoH = Math.max(20, Math.min(120, L.logoHeight || 56)) * 0.82
      let textX = mL
      if (pl.lab.logoDataUrl) {
        const im = doc.addImage(pl.lab.logoDataUrl)
        if (im) {
          const w = (im.w * logoH) / im.h
          const x = L.logoAlign === 'right' ? pw - mR - w : L.logoAlign === 'center' ? mL + (cw - w) / 2 : mL
          doc.drawImage(im.key, x, y, w, logoH)
          if (L.logoAlign === 'left') textX = mL + w + 10
          else y += logoH + 4
        }
      }
      doc.text(textX, y, pl.lab.name, 16, { bold: true, color: '#0369A1' })
      doc.text(textX, y + 20, [pl.lab.address, pl.lab.city].filter(Boolean).join(', '), fs)
      doc.text(textX, y + 20 + lh, [L.showLabPhone && pl.lab.phone ? `Phone: ${pl.lab.phone}` : '', pl.lab.email, pl.lab.website].filter(Boolean).join('  |  '), fs)
      y += Math.max(20 + lh * 2, pl.lab.logoDataUrl && L.logoAlign === 'left' ? logoH : 0) + 4
    }
    doc.line(mL, y, pw - mR, y, { color: '#333333', width: 1 })
    y += 8
  } else y += 70 // pre-printed stationery: leave the header area blank

  // ---- banners
  const banner = (s: string, c: string) => {
    need(26)
    doc.rect(mL, y, cw, 22, { stroke: c, width: 1.2 })
    doc.text(mL + (cw - textWidth(s, 10, true)) / 2, y + 6, s, 10, { bold: true, color: c })
    y += 28
  }
  if (o.reportStatus === 'provisional') banner('PROVISIONAL REPORT', '#B45309')
  else if (o.reportStatus === 'partial') banner('INTERIM REPORT: some results are awaited', '#B45309')
  if (opts.revision > 0) banner(`AMENDED REPORT: revision ${opts.revision}`, '#B91C1C')

  // ---- patient block
  const idValue = pl.settings.idDisplay === 'uhid' && o.uhid ? o.uhid : o.patientNo
  const dateOnly = !!L.reportDateOnly
  const reportDate = o.reportDateOverride || o.reportedAt
  const sampleTypes = [...new Set((pl.tests as DocumentData[]).map((t) => t.sampleTypeName).filter(Boolean))].join(', ')
  const gender = o.gender ? String(o.gender).charAt(0).toUpperCase() + String(o.gender).slice(1) : ''
  const val = (k: string): string => {
    switch (k) {
      case 'name': return o.patientName
      case 'ageGender': return `${ageText(o.ageValue, o.ageUnit, L.ageFormat)} / ${gender}`
      case 'age': return ageText(o.ageValue, o.ageUnit, L.ageFormat)
      case 'gender': return gender
      case 'patientId': return String(idValue ?? '')
      case 'billNo': return o.billNo
      case 'referrer': return o.referrerName || 'Self'
      case 'registeredAt': return fmtDate(o.createdAt, dateOnly)
      case 'billDate': return fmtDate(o.billDate || o.createdAt, dateOnly)
      case 'collectedAt': return fmtDate(o.collectedAt, dateOnly)
      case 'receivedAt': return fmtDate(o.receivedAt, dateOnly)
      case 'reportedAt': return fmtDate(reportDate, dateOnly)
      case 'sampleType': return sampleTypes || '-'
      case 'barcode': return o.barcode
      case 'status': return STATUS_LABEL[o.reportStatus] ?? o.reportStatus
      case 'dob': return fields.dob ? fmtDate(`${fields.dob}T00:00:00+05:30`, true) : '-'
      default: return fields[k] || '-'
    }
  }
  const keys = ((L.headerFields?.length ? L.headerFields : (rd.patientFields as string[])?.length ? (rd.patientFields as string[]) : DEFAULT_FIELDS) as string[]).filter((k) => FIELD_LABEL[k])
  const cols = Math.max(2, Math.min(4, L.headerColumns || 2))
  const colW = cw / cols
  for (let i = 0; i < keys.length; i += cols) {
    need(lh)
    keys.slice(i, i + cols).forEach((k, j) => {
      const x = mL + j * colW
      const lab = `${FIELD_LABEL[k]}: `
      doc.text(x, y, lab, fs, { color: '#555555' })
      const v = wrap(val(k), fs, colW - textWidth(lab, fs) - 6, true)[0] ?? ''
      doc.text(x + textWidth(lab, fs), y, v, fs, { bold: true })
    })
    y += lh
  }
  y += 2
  doc.line(mL, y, pw - mR, y, { color: '#999999' })
  y += 8
  if (o.reportNote) para(`Note: ${o.reportNote}`, mL, cw, fs)

  // ---- results
  const testById = new Map((pl.tests as DocumentData[]).map((t) => [String(t.id), t]))
  const deptById = new Map(pl.departments.map((d) => [d.id, d]))
  const ageDays = Number(o.ageDays ?? ageDaysOf(Number(o.ageValue), String(o.ageUnit)))
  const colOrder = (L.columnOrder as string[]).filter((c) => (c !== 'reference' || rd.showReferenceRanges !== false) && (c !== 'method' || L.showTestMethod))
  const widths = colOrder.map((c) => L.columnWidths?.[c] ?? DEFAULT_W[c] ?? 10)
  const tot = widths.reduce((a, b) => a + b, 0) || 1
  const px = widths.map((w) => (w / tot) * cw)
  const xs = px.map((_, i) => mL + px.slice(0, i).reduce((a, b) => a + b, 0))
  const heading = (c: string) => L.columnLabels?.[c] || COL_LABEL[c]

  const results = [...pl.results].sort((a, b) => {
    const ta = testById.get(a.testId)
    const tb = testById.get(b.testId)
    return (deptById.get(ta?.departmentId)?.order ?? 0) - (deptById.get(tb?.departmentId)?.order ?? 0) || (ta?.order ?? 0) - (tb?.order ?? 0)
  })
  let lastDept = ''
  let first = true
  for (const r of results) {
    const t = (testById.get(r.testId) ?? {}) as DocumentData
    const dept = deptById.get(t.departmentId)?.name ?? ''
    if (!first && (t.startOnNewPage || t.startNextPage || (rd.pageBreakPerDepartment && t.departmentId !== lastDept))) {
      doc.newPage()
      y = mT
    }
    first = false
    if (t.departmentId !== lastDept && L.showDeptName) {
      need(hs + 14)
      doc.text(mL, y, dept.toUpperCase(), fs + 1, { bold: true, color: '#0369A1' })
      y += fs + 8
    }
    lastDept = t.departmentId
    need(hs + 30)
    doc.text(mL, y, String(r.testName || t.name || ''), hs, { bold: true })
    y += hs + 4
    if (rd.showSampleTypePerTest !== false && t.sampleTypeName) {
      doc.text(mL, y, `Sample: ${t.sampleTypeName}${o.barcode ? ` (${o.barcode})` : ''}`, fs - 1, { color: '#555555' })
      y += lh - 1
    }
    if (L.showMachineName && r.machineName) {
      doc.text(mL, y, `Machine: ${r.machineName}`, fs - 1, { color: '#555555' })
      y += lh - 1
    }
    if (r.radiology) {
      const rad = r.radiology as DocumentData
      for (const [h, body] of [['Technique', rad.technique], ['Findings', rad.findings], ['Impression', rad.impression]] as [string, string][]) {
        const lines = richToLines(body)
        if (!lines.length) continue
        need(lh * 2)
        doc.text(mL, y, h, fs, { bold: true })
        y += lh
        for (const ln of lines) para(ln, mL, cw)
        y += 3
      }
      if (rad.secondOpinion) para(`Second opinion (${rad.secondOpinion.doctorName}${rad.secondOpinion.cosignedBy ? `, co-signed by ${rad.secondOpinion.cosignedBy}` : ''}): ${rad.secondOpinion.opinion}`, mL, cw)
      const imgs = (rad.images ?? []) as DocumentData[]
      for (let i = 0; i < imgs.length; i += 2) {
        let rowH = 0
        for (let j = 0; j < 2 && imgs[i + j]; j++) {
          const im = doc.addImage(imgs[i + j].dataUrl)
          if (!im) continue
          const k = Math.min((cw / 2 - 8) / im.w, 200 / im.h)
          const h = im.h * k
          rowH = Math.max(rowH, h + 12)
        }
        if (!rowH) continue
        need(rowH)
        for (let j = 0; j < 2 && imgs[i + j]; j++) {
          const im = doc.addImage(imgs[i + j].dataUrl)
          if (!im) continue
          const k = Math.min((cw / 2 - 8) / im.w, 200 / im.h)
          doc.drawImage(im.key, mL + j * (cw / 2), y, im.w * k, im.h * k)
          if (imgs[i + j].caption) doc.text(mL + j * (cw / 2), y + im.h * k + 1, String(imgs[i + j].caption), fs - 2)
        }
        y += rowH
      }
    } else {
      need(lh + 4)
      doc.rect(mL, y - 1, cw, lh + 1, { fill: '#F3F4F6' })
      colOrder.forEach((c, i) => doc.text(xs[i] + 3, y + 1, heading(c), fs - 1, { bold: true }))
      y += lh + 2
      const params = ((t.parameters ?? []) as DocumentData[]).filter((p) => !p.hideOnReport)
      const keysSet = new Set(((t.parameters ?? []) as DocumentData[]).map((p) => p.key))
      const rejected = new Set((r.rejectedParams ?? []) as string[])
      const has = (p: DocumentData) => String((r.values ?? {})[p.key]?.value ?? '').trim() !== '' || rejected.has(p.key)
      const rows: { p?: DocumentData; header?: string; indent?: boolean }[] = []
      for (const p of params.filter((x) => !x.parentKey || !keysSet.has(x.parentKey))) {
        if (p.structure === 'group') {
          const members = params.filter((m) => m.parentKey === p.key && has(m))
          if (members.length) {
            rows.push({ header: p.name })
            members.forEach((m) => rows.push({ p: m, indent: true }))
          }
        } else if (has(p)) rows.push({ p })
      }
      for (const row of rows) {
        if (row.header) {
          need(lh + 2)
          doc.text(mL + 3, y, row.header, fs, { bold: true })
          y += lh
          continue
        }
        const p = row.p!
        const v = (r.values ?? {})[p.key] as DocumentData | undefined
        const flag = flagOf(v)
        const rg = rangeFor(p, ageDays, String(o.gender ?? ''), String(o.condition ?? ''), v?.rangeOverride, v)
        const isBig = p.dataType === 'richText' || p.dataType === 'image' || p.dataType === 'pdf'
        if (isBig) {
          need(lh * 2)
          doc.text(mL + 3 + (row.indent ? 12 : 0), y, p.name, fs, { bold: true })
          y += lh
          if (p.dataType === 'richText') for (const ln of richToLines(v?.value)) para(ln, mL + 6, cw - 6)
          else if (p.dataType === 'image') {
            const h = image(String(v?.value ?? ''), mL + 6, cw - 12, Math.max(40, (L.imageHeight || 220) * 0.82))
            y += h + 4
          } else para('(PDF attachment, see the online report)', mL + 6, cw - 6)
          continue
        }
        const cells: Record<string, string> = {
          test: p.name, result: rejected.has(p.key) ? 'Rejected' : String(v?.value ?? ''), flag: rd.showFlagArrows ? (flag.startsWith('L') && flag !== 'Critical' ? `v ${flag}` : flag.startsWith('H') ? `^ ${flag}` : flag) : flag,
          reference: rg.text, unit: p.unit ?? '', method: p.method ?? '',
        }
        const col = L.boldOnly ? undefined : flag === 'L' || flag === 'LL' ? lowC : flag ? highC : undefined
        const bold = !!flag && rd.abnormalStyle !== 'colour' && rd.abnormalStyle !== 'none'
        const cellLines = colOrder.map((c, i) => wrap(c === 'test' && row.indent ? `  ${cells.test}` : cells[c], fs, px[i] - 6, (c === 'result' || c === 'flag') && bold))
        const rows2 = Math.max(...cellLines.map((l) => l.length), 1)
        const hgt = rows2 * lh
        need(hgt + 2)
        colOrder.forEach((c, i) => {
          const colored = col && (c === 'result' || c === 'flag') && rd.abnormalStyle !== 'bold' && rd.abnormalStyle !== 'none'
          cellLines[i].forEach((ln, k) => doc.text(xs[i] + 3, y + k * lh, ln, fs, { bold: (c === 'result' || c === 'flag') && bold, color: colored ? col : undefined }))
        })
        y += hgt
        if (r.paramComments?.[p.key] && !r.paramCommentHidden?.[p.key]) para(String(r.paramComments[p.key]), mL + 8, cw - 8, fs - 1, { color: '#555555' })
        if (L.showMic && v?.mic) para(`MIC: ${v.mic}`, mL + 8, cw - 8, fs - 1, { color: '#555555' })
        doc.line(mL, y + 1, pw - mR, y + 1, { color: '#E5E7EB', width: 0.4 })
        y += 3
      }
      if (t.interpretation && r.showInterpretation !== false && t.interpretationEnabled !== false) {
        y += 3
        para('Interpretation', mL, cw, fs, { bold: true })
        for (const ln of richToLines(t.interpretation)) para(ln, mL, cw)
      }
      if (t.comments && r.commentOnReport !== false) para(String(t.comments), mL, cw, fs - 1, { color: '#444444' })
      if (r.comment && r.commentOnReport !== false) para(`Comment: ${r.comment}`, mL, cw)
    }
    // signatures: the ones frozen at approval (up to the lab limit), else the single snapshot
    const sigs = ((r.signatureSnapshots as DocumentData[] | undefined)?.length ? (r.signatureSnapshots as DocumentData[]) : r.signatorySnapshot ? [r.signatorySnapshot as DocumentData] : []).slice(0, Math.max(1, L.maxSignatures || 3))
    if (sigs.length && rd.signaturePlacement !== 'everyPage') {
      y += 6
      need(80)
      const top = y
      let maxH = 0
      sigs.forEach((sig, i) => {
        const x = mL + i * Math.min(190, cw / sigs.length)
        let yy = top
        if (sig.signatureDataUrl) {
          const im = doc.addImage(sig.signatureDataUrl)
          if (im) {
            const k = Math.min(110 / im.w, Math.max(24, (sig.signatureHeight || 40) * 0.82) / im.h)
            doc.drawImage(im.key, x, yy, im.w * k, im.h * k)
            if (L.showStamp && sig.stampDataUrl) {
              const st = doc.addImage(sig.stampDataUrl)
              if (st) doc.drawImage(st.key, x + im.w * k + 6, yy, (st.w * 40) / st.h, 40)
            }
            yy += im.h * k + 2
          }
        }
        for (const [txt, bold] of [[sig.hideNameInReport ? '' : sig.name, true], [sig.designation, false], [sig.qualification, false], [sig.registrationNo ? `Reg. no. ${sig.registrationNo}` : '', false]] as [string, boolean][]) {
          if (!txt) continue
          doc.text(x, yy, String(txt), bold ? fs : fs - 1, { bold })
          yy += lh - 1
        }
        maxH = Math.max(maxH, yy - top)
      })
      y += maxH
    }
    y += 8
  }
  if (!results.length) para('No approved results.', mL, cw)
  if (L.listPendingTests && (o.pending as string[])?.length) {
    y += 4
    para(`Results awaited: ${(o.pending as string[]).join(', ')}`, mL, cw, fs, { bold: true, color: '#B45309' })
  }
  if (L.showPackageName && (o.packages as string[])?.length) para(`Package: ${(o.packages as string[]).join(', ')}`, mL, cw, fs - 1, { color: '#555555' })
  need(20)
  y += 6
  const end = String(rd.endOfReportText || '*** End of report ***')
  doc.text(mL + (cw - textWidth(end, fs)) / 2, y, end, fs, { color: '#555555' })

  // ---- footers on every page (added after the last page is closed)
  const totalPages = doc.pages.length + 1
  const foot = (n: number) => {
    const ft = !letterhead && rd.showFooter !== false ? String(lhead?.footerText || rd.footerText || `${pl.lab.name}${pl.lab.address ? ` - ${pl.lab.address}` : ''}`) : ''
    return { ft, n }
  }
  // Draw footer on the open page, then on earlier pages by rewriting their content streams.
  const footerOps = (n: number) => {
    const tmp = new PdfDoc(pw, ph, doc.fonts)
    const { ft } = foot(n)
    if (!letterhead) tmp.line(mL, ph - mB + 14, pw - mR, ph - mB + 14, { color: '#999999' })
    if (ft) tmp.text(mL, ph - mB + 18, wrap(ft, 8, cw - 90)[0] ?? '', 8, { color: '#555555' })
    tmp.text(pw - mR - 60, ph - mB + 18, `Page ${n} of ${totalPages}`, 8, { color: '#555555' })
    const extra = [`Report rev ${opts.revision}`, opts.sha256 ? `ID ${opts.sha256.slice(0, 12)}` : '', L.showMadeWith ? 'Made with Health Care Labs' : ''].filter(Boolean).join('  |  ')
    tmp.text(mL, ph - mB + 28, extra, 7, { color: '#888888' })
    return tmp.pages.length ? tmp.pages[0] : (tmp as unknown as { cur: string }).cur
  }
  const open = doc as unknown as { cur: string }
  open.cur += footerOps(totalPages)
  doc.pages = doc.pages.map((c, i) => c + footerOps(i + 1))
  return doc.finish(`Report ${o.billNo}`)
}
