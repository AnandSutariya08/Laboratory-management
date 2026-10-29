// HL7 v2 over MLLP: <VT> message <FS><CR>. Every message is answered with an HL7 ACK (MSA|AA) so the analyser
// does not resend. split() turns one message into one message per sample (MSH + PID + an OBR and its OBX).

export const VT = 0x0b, FS = 0x1c, CR = 0x0d

const segments = (text) => text.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean)

export function wrap(text) {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(text, 'latin1'), Buffer.from([FS, CR])])
}

// The ACK an analyser expects back, built from its MSH.
export function ack(message, code = 'AA') {
  const msh = segments(message).find((s) => s.startsWith('MSH')) || 'MSH|^~\\&'
  const sep = msh[3] || '|'
  const f = msh.split(sep)
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const control = f[9] || ''
  const version = f[11] || '2.3.1'
  // Swap sending and receiving application / facility.
  return [
    ['MSH', f[1] || '^~\\&', f[4] || '', f[5] || '', f[2] || '', f[3] || '', ts, '', 'ACK', `ACK${ts}`, 'P', version].join(sep),
    ['MSA', code, control].join(sep),
  ].join('\r') + '\r'
}

export class MllpReceiver {
  constructor({ write, onMessage, onWarn = () => {} }) {
    this.write = write
    this.onMessage = onMessage
    this.onWarn = onWarn
    this.buf = Buffer.alloc(0)
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const start = this.buf.indexOf(VT)
      if (start < 0) {
        // Unframed HL7 (some senders skip MLLP): treat a pause-free block that starts with MSH as one message.
        const t = this.buf.toString('latin1')
        if (t.startsWith('MSH') && /\r\r$|\n\n$/.test(t)) {
          this.buf = Buffer.alloc(0)
          this.deliver(t)
        }
        return
      }
      const end = this.buf.indexOf(FS, start)
      if (end < 0) return
      const text = this.buf.subarray(start + 1, end).toString('latin1')
      this.buf = this.buf.subarray(end + (this.buf[end + 1] === CR ? 2 : 1))
      this.deliver(text)
    }
  }

  deliver(text) {
    try {
      this.onMessage(text)
      this.write(wrap(ack(text, 'AA')))
    } catch (e) {
      this.onWarn(`Could not handle a message: ${e.message}`)
      this.write(wrap(ack(text, 'AE')))
    }
  }
}

export function split(text) {
  const segs = segments(text.slice(Math.max(0, text.indexOf('MSH'))))
  const msh = segs.find((s) => s.startsWith('MSH')) || 'MSH|^~\\&'
  const out = []
  let pid = ''
  let cur = null
  for (const s of segs) {
    const t = s.slice(0, 3)
    if (t === 'PID') {
      pid = s
      cur = null
    } else if (t === 'OBR') {
      cur = [msh, ...(pid ? [pid] : []), s]
      out.push(cur)
    } else if ((t === 'OBX' || t === 'NTE' || t === 'SPM') && cur) {
      cur.push(s)
    } else if (t === 'SPM' && !cur) {
      // Some senders put SPM before OBR; keep it with the next sample.
      pid = pid ? `${pid}\r${s}` : s
    }
  }
  const messages = out.filter((m) => m.some((s) => s.startsWith('OBX'))).map((m) => m.join('\r') + '\r')
  // A message without OBR but with OBX results is sent whole.
  if (!messages.length && segs.some((s) => s.startsWith('OBX'))) messages.push(segs.join('\r') + '\r')
  return { messages }
}
