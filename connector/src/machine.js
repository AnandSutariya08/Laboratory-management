import net from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { AstmReceiver } from './astm.js'
import { MllpReceiver } from './hl7.js'
import { toMessages } from './formats.js'
import * as log from './log.js'

// One analyser link. Connection types:
//   serial      RS-232 / USB-serial port (COM3 ...); needs the serialport package
//   tcp-server  the connector listens on a port and the analyser connects to it
//   tcp-client  the connector connects to the analyser's IP and port (reconnects on its own)
//   folder      the analyser (or its PC software) saves result files into a folder
// Protocols: astm, hl7. Folder files are detected automatically (ASTM, HL7, CSV or JSON).

export class Machine {
  constructor(cfg, { outbox, dataDir, openSerial }) {
    this.cfg = cfg
    this.id = cfg.id
    this.name = cfg.name
    this.token = cfg.token
    this.outbox = outbox
    this.dataDir = dataDir
    this.openSerial = openSerial
    this.state = { link: 'starting', detail: '', lastDataAt: null, received: 0, lastWarning: '' }
    this.sockets = new Set()
    this.timers = []
    this.stopped = false
  }

  get protocol() {
    return (this.cfg.protocol || 'astm').toLowerCase()
  }

  setLink(link, detail = '') {
    const changed = this.state.link !== link || this.state.detail !== detail
    if (changed) log.info(this.name, `${link}${detail ? `: ${detail}` : ''}`)
    this.state.link = link
    this.state.detail = detail
    if (changed) this.onLinkChange?.()
  }

  warn(msg) {
    this.state.lastWarning = msg
    log.warn(this.name, msg)
  }

  // A complete transmission from the analyser: split per sample and queue.
  handle(text, source = '') {
    this.state.lastDataAt = new Date().toISOString()
    let r
    try {
      r = toMessages(text, this.cfg.fileFormat && source === 'file' ? this.cfg.fileFormat : source === 'file' ? 'auto' : this.protocol)
    } catch (e) {
      this.warn(`Could not read ${source || 'message'}: ${e.message}`)
      return 0
    }
    if (r.queries?.length) this.warn(`The analyser asked for its worklist (${r.queries.length} query record(s)); sending orders to the analyser is not switched on, so run these samples with manual entry of the test list on the analyser`)
    if (!r.messages.length) {
      if (!r.queries?.length) this.warn(`Received data with no results in it (format: ${r.format}); see the raw log`)
      return 0
    }
    for (const m of r.messages) {
      this.outbox.add(this, m.body, { barcode: m.barcode, source })
      this.state.received++
    }
    log.info(this.name, `Received ${r.messages.length} sample(s): ${r.messages.map((m) => m.barcode || '(no barcode)').join(', ')}`)
    this.outbox.flush(new Map([[this.id, this.token]])).catch(() => {})
    return r.messages.length
  }

  receiver(write) {
    const opts = {
      write: (b) => {
        log.raw(this.id, 'OUT', b)
        write(b)
      },
      onMessage: (t) => this.handle(t, this.protocol),
      onWarn: (w) => this.warn(w),
      ignoreChecksum: !!this.cfg.ignoreChecksum,
    }
    return this.protocol === 'hl7' ? new MllpReceiver(opts) : new AstmReceiver(opts)
  }

  feed(rx, chunk) {
    log.raw(this.id, 'IN ', chunk)
    rx.push(chunk)
  }

  async start() {
    const t = (this.cfg.connection || '').toLowerCase()
    if (t === 'serial') return this.startSerial()
    if (t === 'tcp-server') return this.startTcpServer()
    if (t === 'tcp-client') return this.startTcpClient()
    if (t === 'folder') return this.startFolder()
    this.setLink('error', `Unknown connection "${this.cfg.connection}". Use serial, tcp-server, tcp-client or folder`)
  }

  async startSerial() {
    const s = this.cfg.serial || {}
    if (!s.port) return this.setLink('error', 'serial.port is missing (for example COM3)')
    let port
    try {
      port = await this.openSerial({
        path: s.port,
        baudRate: Number(s.baudRate || 9600),
        dataBits: Number(s.dataBits || 8),
        parity: s.parity || 'none',
        stopBits: Number(s.stopBits || 1),
        rtscts: !!s.rtscts,
        xon: !!s.xonxoff,
        xoff: !!s.xonxoff,
      })
    } catch (e) {
      this.setLink('error', `Cannot open ${s.port}: ${e.message}. Retrying in 15 s`)
      if (!this.stopped) this.timers.push(setTimeout(() => this.startSerial(), 15000))
      return
    }
    this.port = port
    const rx = this.receiver((b) => port.write(b))
    port.on('data', (c) => this.feed(rx, c))
    port.on('close', () => {
      if (this.stopped) return
      this.setLink('error', `${s.port} closed (cable unplugged?). Retrying in 15 s`)
      this.timers.push(setTimeout(() => this.startSerial(), 15000))
    })
    port.on('error', (e) => this.warn(`Serial error: ${e.message}`))
    this.setLink('listening', `${s.port} at ${s.baudRate || 9600} baud`)
  }

  startTcpServer() {
    const port = Number(this.cfg.tcp?.port)
    if (!port) return this.setLink('error', 'tcp.port is missing')
    const server = net.createServer((sock) => {
      this.sockets.add(sock)
      sock.setKeepAlive(true, 30000)
      this.setLink('connected', `analyser ${sock.remoteAddress} connected to port ${port}`)
      const rx = this.receiver((b) => sock.write(b))
      sock.on('data', (c) => this.feed(rx, c))
      sock.on('error', (e) => this.warn(`Connection error: ${e.message}`))
      sock.on('close', () => {
        this.sockets.delete(sock)
        if (!this.sockets.size && !this.stopped) this.setLink('listening', `waiting for the analyser on port ${port}`)
      })
    })
    server.on('error', (e) => this.setLink('error', `Cannot listen on port ${port}: ${e.message}`))
    server.listen(port, this.cfg.tcp?.bind || '0.0.0.0', () => this.setLink('listening', `waiting for the analyser on port ${port}`))
    this.server = server
  }

  startTcpClient() {
    const host = this.cfg.tcp?.host
    const port = Number(this.cfg.tcp?.port)
    if (!host || !port) return this.setLink('error', 'tcp.host and tcp.port are needed')
    const connect = () => {
      if (this.stopped) return
      const sock = net.connect({ host, port })
      this.sockets.add(sock)
      sock.setKeepAlive(true, 30000)
      const rx = this.receiver((b) => sock.write(b))
      sock.on('connect', () => this.setLink('connected', `connected to ${host}:${port}`))
      sock.on('data', (c) => this.feed(rx, c))
      sock.on('error', (e) => this.setLink('error', `${host}:${port}: ${e.message}. Retrying in 10 s`))
      sock.on('close', () => {
        this.sockets.delete(sock)
        if (!this.stopped) this.timers.push(setTimeout(connect, 10000))
      })
    }
    this.setLink('connecting', `${host}:${port}`)
    connect()
  }

  startFolder() {
    const dir = this.cfg.folder?.path
    if (!dir) return this.setLink('error', 'folder.path is missing')
    const exts = (this.cfg.folder?.extensions || ['.txt', '.astm', '.hl7', '.csv', '.json', '.res', '.dat']).map((e) => e.toLowerCase())
    const done = join(dir, 'sent-to-lab-app')
    const bad = join(dir, 'not-read')
    const sizes = new Map()
    const scan = () => {
      if (this.stopped) return
      try {
        if (!existsSync(dir)) {
          this.setLink('error', `Folder not found: ${dir}`)
          return
        }
        mkdirSync(done, { recursive: true })
        mkdirSync(bad, { recursive: true })
        this.setLink('listening', `watching ${dir}`)
        for (const f of readdirSync(dir)) {
          const full = join(dir, f)
          let st
          try {
            st = statSync(full)
          } catch {
            continue
          }
          if (!st.isFile() || !exts.includes(extname(f).toLowerCase())) continue
          // Only read a file once its size has stopped changing (the analyser may still be writing it).
          if (sizes.get(full) !== st.size) {
            sizes.set(full, st.size)
            continue
          }
          sizes.delete(full)
          const buf = readFileSync(full)
          log.raw(this.id, 'FILE', Buffer.from(`${f}\n`))
          log.raw(this.id, 'IN ', buf)
          const n = this.handle(buf.toString('latin1'), 'file')
          const stampName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${basename(f)}`
          renameSync(full, join(n ? done : bad, stampName))
        }
      } catch (e) {
        this.warn(`Folder scan failed: ${e.message}`)
      }
    }
    scan()
    this.timers.push(setInterval(scan, Number(this.cfg.folder?.scanSeconds || 5) * 1000))
  }

  stop() {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t), clearInterval(t)
    for (const s of this.sockets) s.destroy()
    this.server?.close()
    if (this.port?.isOpen) this.port.close()
  }
}
