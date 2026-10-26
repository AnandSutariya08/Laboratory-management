// Minimal store-only (no compression) zip writer. No dependency.
const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry { name: string; data: string | Uint8Array }

export function makeZip(entries: ZipEntry[], when = new Date()): Blob {
  const enc = new TextEncoder()
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const u16 = (v: DataView, o: number, x: number) => v.setUint16(o, x, true)
  const u32 = (v: DataView, o: number, x: number) => v.setUint32(o, x >>> 0, true)
  for (const e of entries) {
    const name = enc.encode(e.name)
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data
    const crc = crc32(data)
    const lh = new Uint8Array(30 + name.length)
    const lv = new DataView(lh.buffer)
    u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0x0800); u16(lv, 8, 0); u16(lv, 10, dosTime); u16(lv, 12, dosDate)
    u32(lv, 14, crc); u32(lv, 18, data.length); u32(lv, 22, data.length); u16(lv, 26, name.length); u16(lv, 28, 0)
    lh.set(name, 30)
    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    u32(cv, 0, 0x02014b50); u16(cv, 4, 20); u16(cv, 6, 20); u16(cv, 8, 0x0800); u16(cv, 10, 0); u16(cv, 12, dosTime); u16(cv, 14, dosDate)
    u32(cv, 16, crc); u32(cv, 20, data.length); u32(cv, 24, data.length); u16(cv, 28, name.length)
    u32(cv, 42, offset)
    ch.set(name, 46)
    parts.push(lh, data)
    central.push(ch)
    offset += lh.length + data.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  u32(ev, 0, 0x06054b50); u16(ev, 8, entries.length); u16(ev, 10, entries.length); u32(ev, 12, cdSize); u32(ev, 16, offset)
  return new Blob([...parts, ...central, end] as BlobPart[], { type: 'application/zip' })
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
