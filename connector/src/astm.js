// ASTM E1381 (low level) receiver and E1394 record splitter.
//
// Low level: the analyser sends ENQ, we answer ACK; then frames <STX>FN text <ETB|ETX> C1 C2 <CR><LF>, each
// answered with ACK (checksum good) or NAK; EOT ends the transmission. Some analysers skip the handshake and
// send bare records ending with an L (terminator) record; those are accepted too.
// Record level: one transmission can carry several patients and samples. split() turns it into one message per
// sample (H + P + O + its R/C records + L) because the lab app matches one barcode per message.

export const ENQ = 0x05, ACK = 0x06, NAK = 0x15, EOT = 0x04, STX = 0x02, ETX = 0x03, ETB = 0x17, CR = 0x0d, LF = 0x0a

export function checksum(bytes) {
  let sum = 0
  for (const b of bytes) sum = (sum + b) & 0xff
  return sum.toString(16).toUpperCase().padStart(2, '0')
}

// Builds a frame (used by tests and the simulator).
export function frame(fn, text, last = true) {
  const body = Buffer.from(`${fn % 8}${text}`, 'latin1')
  const end = Buffer.from([last ? ETX : ETB])
  const cs = checksum(Buffer.concat([body, end]))
  return Buffer.concat([Buffer.from([STX]), body, end, Buffer.from(cs + '\r\n', 'latin1')])
}

// Feed bytes in with push(); write(bytes) sends the handshake replies; onMessage(text) gets each complete
// transmission (records separated by CR).
export class AstmReceiver {
  constructor({ write, onMessage, onWarn = () => {}, ignoreChecksum = false }) {
    this.write = write
    this.onMessage = onMessage
    this.onWarn = onWarn
    this.ignoreChecksum = ignoreChecksum
    this.buf = Buffer.alloc(0)
    this.text = '' // framed text so far in this transmission
    this.bare = '' // unframed records
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      if (!this.buf.length) return
      const b = this.buf[0]
      if (b === ENQ) {
        this.buf = this.buf.subarray(1)
        this.text = ''
        this.write(Buffer.from([ACK]))
        continue
      }
      if (b === EOT) {
        this.buf = this.buf.subarray(1)
        if (this.text) this.emit(this.text)
        this.text = ''
        continue
      }
      if (b === STX) {
        const end = this.buf.indexOf(LF)
        if (end < 0) return // wait for the rest of the frame
        const raw = this.buf.subarray(0, end + 1)
        this.buf = this.buf.subarray(end + 1)
        this.readFrame(raw)
        continue
      }
      if (b === ACK || b === NAK || b === CR || b === LF || b === 0x00) {
        this.buf = this.buf.subarray(1)
        continue
      }
      // Unframed records: take whole lines; a terminator record (L|...) ends the message.
      const nl = this.buf.findIndex((x) => x === CR || x === LF || x === ENQ || x === STX || x === EOT)
      if (nl < 0) return
      const line = this.buf.subarray(0, nl).toString('latin1')
      this.buf = this.buf.subarray(nl)
      this.bare += line + '\r'
      if (/^\d?L\|/.test(line)) {
        this.emit(this.bare)
        this.bare = ''
      }
    }
  }

  readFrame(raw) {
    // raw = STX FN text (ETB|ETX) C1 C2 CR LF
    const endAt = raw.findIndex((x, i) => i > 0 && (x === ETX || x === ETB))
    if (endAt < 0) {
      this.onWarn('Frame without ETX/ETB, rejected')
      this.write(Buffer.from([NAK]))
      return
    }
    const body = raw.subarray(1, endAt + 1) // FN..ETX/ETB inclusive
    const got = raw.subarray(endAt + 1, endAt + 3).toString('latin1').toUpperCase()
    const want = checksum(body)
    if (got !== want && !this.ignoreChecksum) {
      this.onWarn(`Checksum mismatch (got ${got}, expected ${want}), asked the analyser to resend`)
      this.write(Buffer.from([NAK]))
      return
    }
    this.text += raw.subarray(2, endAt).toString('latin1') // drop STX and the frame number
    this.write(Buffer.from([ACK]))
  }

  emit(text) {
    try {
      this.onMessage(text)
    } catch (e) {
      this.onWarn(`Could not handle a message: ${e.message}`)
    }
  }
}

// Records of an ASTM message: one per line, without the leading frame digit some senders keep.
export const records = (text) =>
  text
    .replace(/[\x02\x03\x04\x05\x06\x15\x17]/g, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim().replace(/^\d(?=[A-Z]\|)/, ''))
    .filter(Boolean)

// One message per sample. Query records (the analyser asking for work) are reported, not sent.
export function split(text) {
  const recs = records(text)
  const header = recs.find((r) => r.startsWith('H|')) || 'H|\\^&'
  const out = []
  const queries = []
  let patient = ''
  let cur = null
  for (const r of recs) {
    const type = r[0]
    if (type === 'P') {
      patient = r
      cur = null
    } else if (type === 'O') {
      cur = [header, patient || 'P|1', r]
      out.push(cur)
    } else if ((type === 'R' || type === 'C' || type === 'M') && cur) {
      cur.push(r)
    } else if (type === 'Q') {
      queries.push(r)
    }
  }
  return {
    messages: out.filter((m) => m.some((r) => r.startsWith('R|'))).map((m) => [...m, 'L|1|N'].join('\r') + '\r'),
    queries,
  }
}
