import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Unicode text shaping and TrueType subsetting for the PDF writer.
//   - harfbuzzjs (WASM) shapes each run (conjuncts, matras, reordering, mark positioning) to glyph ids.
//   - harfbuzz-subset.wasm cuts every embedded font down to the glyphs a document actually uses (glyph ids are
//     retained, so the shaped ids stay valid and the PDF can use Identity-H with an identity CIDToGIDMap).
// Fonts are Noto Sans (Latin/Greek/Cyrillic) plus Noto Sans Devanagari, Gujarati, Bengali and Tamil (SIL OFL 1.1),
// shipped in functions/fonts. A script's font is read from disk the first time text in that script is drawn.

export type Fam = 'latin' | 'deva' | 'gujr' | 'beng' | 'taml'
const FILES: Record<Fam, string> = { latin: 'NotoSans', deva: 'NotoSansDevanagari', gujr: 'NotoSansGujarati', beng: 'NotoSansBengali', taml: 'NotoSansTamil' }

export interface Glyph { gid: number; adv: number; xo: number; yo: number; cluster: number }
export interface Shaped { glyphs: Glyph[]; width: number; upem: number; cps: number[] }

interface Hb {
  Blob: new (d: Uint8Array) => unknown
  Face: new (b: unknown) => { upem: number; referenceTable(t: string): Uint8Array | undefined }
  Font: new (f: unknown) => { glyphHAdvance(g: number): number; hExtents(): { ascender: number; descender: number; lineGap: number } }
  Buffer: new () => {
    add(cp: number, cluster: number): void
    guessSegmentProperties(): void
    getGlyphInfos(): { codepoint: number; cluster: number }[]
    getGlyphPositions(): { xAdvance: number; xOffset: number; yOffset: number }[]
  }
  shape(font: unknown, buffer: unknown): void
}
interface Loaded {
  key: string
  data: Uint8Array
  face: InstanceType<Hb['Face']>
  font: InstanceType<Hb['Font']>
  upem: number
  ascent: number
  descent: number
  bbox: [number, number, number, number]
  adv: Map<number, number>
}

let hb: Hb | null = null
let initP: Promise<void> | null = null
const loaded = new Map<string, Loaded>()
const shapeCache = new Map<string, Shaped>()
let sub: WebAssembly.Exports | null = null

export function initFonts(): Promise<void> {
  if (!initP) {
    initP = (async () => {
      hb = (await import('harfbuzzjs')) as unknown as Hb
      const wasm = readFileSync(require.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm'))
      const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), {})
      sub = inst.exports
      const init = sub._initialize as (() => void) | undefined
      if (init) init()
    })().catch((e) => {
      initP = null
      throw e
    })
  }
  return initP
}

export function fontDir(): string {
  const p = join(__dirname, '..', 'fonts')
  return existsSync(p) ? p : join(__dirname, 'fonts')
}

export function getFont(fam: Fam, bold: boolean): Loaded {
  if (!hb) throw new Error('fonts not initialised')
  const key = `${fam}${bold ? 'B' : 'R'}`
  let f = loaded.get(key)
  if (f) return f
  const file = join(fontDir(), `${FILES[fam]}-${bold ? 'Bold' : 'Regular'}.ttf`)
  // A script font that is not installed prints as missing-glyph boxes in Noto Sans instead of failing the whole PDF.
  if (fam !== 'latin' && !existsSync(file)) {
    f = getFont('latin', bold)
    loaded.set(key, f)
    return f
  }
  const data = new Uint8Array(readFileSync(file))
  const face = new hb.Face(new hb.Blob(data))
  const font = new hb.Font(face)
  const ext = font.hExtents()
  const head = face.referenceTable('head')
  const s16 = (o: number) => (head ? (head[o] << 8 | head[o + 1]) << 16 >> 16 : 0)
  f = { key, data, face, font, upem: face.upem, ascent: ext.ascender, descent: ext.descender, bbox: [s16(36), s16(38), s16(40), s16(42)], adv: new Map() }
  loaded.set(key, f)
  return f
}

export function advanceOf(f: Loaded, gid: number): number {
  let a = f.adv.get(gid)
  if (a === undefined) {
    a = f.font.glyphHAdvance(gid)
    f.adv.set(gid, a)
  }
  return a
}

// ---- script itemisation

function indicFam(cp: number): Fam | null {
  if ((cp >= 0x900 && cp <= 0x97f) || (cp >= 0xa8e0 && cp <= 0xa8ff) || (cp >= 0x1cd0 && cp <= 0x1cff)) return 'deva'
  if (cp >= 0x980 && cp <= 0x9ff) return 'beng'
  if (cp >= 0xa80 && cp <= 0xaff) return 'gujr'
  if (cp >= 0xb80 && cp <= 0xbff) return 'taml'
  return null
}
// Characters that belong to whichever Indic run they follow: joiners, the dotted circle and the danda signs.
const sticky = (cp: number) => cp === 0x200c || cp === 0x200d || cp === 0x25cc || cp === 0x964 || cp === 0x965

export function clean(s: string): string {
  let out = ''
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0)!
    if (c < 32 || c === 0xa0 || c === 0x2028 || c === 0x2029) out += ' '
    else out += ch
  }
  return out.normalize('NFC')
}

export function runs(s: string): { fam: Fam; text: string }[] {
  const out: { fam: Fam; text: string }[] = []
  for (const ch of clean(s)) {
    const cp = ch.codePointAt(0)!
    let fam: Fam = indicFam(cp) ?? 'latin'
    const last = out[out.length - 1]
    if (sticky(cp) && last && last.fam !== 'latin') fam = last.fam
    else if (sticky(cp) && !indicFam(cp)) fam = 'latin'
    if (last && last.fam === fam) last.text += ch
    else out.push({ fam, text: ch })
  }
  return out
}

export function shapeRun(fam: Fam, bold: boolean, text: string): Shaped {
  const key = `${fam}${bold ? 'B' : 'R'}${text}`
  const hit = shapeCache.get(key)
  if (hit) return hit
  const f = getFont(fam, bold)
  const buf = new hb!.Buffer()
  const cps = [...text].map((c) => c.codePointAt(0)!)
  cps.forEach((cp, i) => buf.add(cp, i))
  buf.guessSegmentProperties()
  hb!.shape(f.font, buf)
  const infos = buf.getGlyphInfos()
  const pos = buf.getGlyphPositions()
  const glyphs = infos.map((g, i) => ({ gid: g.codepoint, adv: pos[i].xAdvance, xo: pos[i].xOffset, yo: pos[i].yOffset, cluster: g.cluster }))
  const res: Shaped = { glyphs, width: glyphs.reduce((a, g) => a + g.adv, 0), upem: f.upem, cps }
  if (shapeCache.size > 4000) shapeCache.clear()
  shapeCache.set(key, res)
  return res
}

export function measure(s: string, size: number, bold: boolean): number {
  let w = 0
  for (const r of runs(s)) {
    const sh = shapeRun(r.fam, bold, r.text)
    w += (sh.width / sh.upem) * size
  }
  return w
}

// ---- subsetting

export function subsetFont(f: Loaded, gids: number[]): Uint8Array {
  const x = sub as unknown as Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory }
  const mem = () => new Uint8Array(x.memory.buffer)
  const ptr = x.malloc(f.data.length)
  mem().set(f.data, ptr)
  const blob = x.hb_blob_create(ptr, f.data.length, 1, 0, 0)
  const face = x.hb_face_create(blob, 0)
  const input = x.hb_subset_input_create_or_fail()
  const gs = x.hb_subset_input_glyph_set(input)
  for (const g of gids) x.hb_set_add(gs, g)
  // retain glyph ids + keep the .notdef outline; no hinting
  x.hb_subset_input_set_flags(input, 0x1 | 0x2 | 0x40)
  const drop = x.hb_subset_input_set(input, 4)
  for (const t of ['GSUB', 'GPOS', 'GDEF', 'cmap', 'STAT', 'MVAR', 'HVAR', 'gasp', 'kern', 'meta', 'DSIG', 'name']) {
    x.hb_set_add(drop, (t.charCodeAt(0) << 24) | (t.charCodeAt(1) << 16) | (t.charCodeAt(2) << 8) | t.charCodeAt(3))
  }
  const out = x.hb_subset_or_fail(face, input)
  if (!out) throw new Error('font subset failed')
  const ob = x.hb_face_reference_blob(out)
  const len = x.hb_blob_get_length(ob)
  const dp = x.hb_blob_get_data(ob, 0)
  const res = new Uint8Array(len)
  res.set(mem().subarray(dp, dp + len))
  x.hb_blob_destroy(ob)
  x.hb_face_destroy(out)
  x.hb_subset_input_destroy(input)
  x.hb_face_destroy(face)
  x.hb_blob_destroy(blob)
  x.free(ptr)
  return res
}
