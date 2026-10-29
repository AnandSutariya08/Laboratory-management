import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as log from './log.js'

// Durable queue: every message is written to data/outbox before it is sent, so results survive an internet
// outage, a crash or a restart. Sent messages are recorded in data/sent-YYYY-MM-DD.jsonl; messages the app
// refuses for good (unknown format) go to data/failed with the reason.
//
// Outcomes from the app:
//   200       stored (patient or QC)               -> done
//   404       no bill with this barcode            -> done (the app keeps it in its "unmatched" list)
//   400       not a result message                 -> failed (kept for checking)
//   401/403   token wrong or switched off          -> kept, retried every 5 minutes
//   5xx/net   app or internet down                 -> kept, retried with backoff (10 s up to 5 min)

export class Outbox {
  constructor({ dir, endpoint, timeoutMs = 30000 }) {
    this.dir = dir
    this.endpoint = endpoint
    this.timeoutMs = timeoutMs
    this.q = join(dir, 'outbox')
    this.failed = join(dir, 'failed')
    for (const d of [this.q, this.failed]) mkdirSync(d, { recursive: true })
    this.stats = new Map() // machineId -> { sent, unmatched, lastSentAt, lastError, authError }
    this.busy = false
  }

  stat(id) {
    if (!this.stats.has(id)) this.stats.set(id, { sent: 0, unmatched: 0, lastSentAt: null, lastResult: '', lastError: '', authError: false })
    return this.stats.get(id)
  }

  // body: string (ASTM / HL7 text) or object (JSON)
  add(machine, body, meta = {}) {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const item = { id, machineId: machine.id, machineName: machine.name, token: machine.token, body, meta, attempts: 0, nextAt: 0, createdAt: new Date().toISOString() }
    writeFileSync(join(this.q, `${id}.json`), JSON.stringify(item))
    return id
  }

  pending(machineId) {
    return this.items().filter((i) => !machineId || i.machineId === machineId).length
  }

  items() {
    return readdirSync(this.q)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.q, f), 'utf8'))
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }

  // Tokens can change in config.json; queued items always use the current token of their machine.
  async flush(tokens) {
    if (this.busy) return
    this.busy = true
    try {
      const now = Date.now()
      for (const item of this.items()) {
        if (item.nextAt > now) continue
        const token = tokens.get(item.machineId) ?? item.token
        if (!token) continue
        await this.send(item, token)
      }
    } finally {
      this.busy = false
    }
  }

  async send(item, token) {
    const s = this.stat(item.machineId)
    const isJson = typeof item.body === 'object'
    let status = 0
    let reply = ''
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8' },
        body: isJson ? JSON.stringify(item.body) : item.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      status = res.status
      reply = await res.text()
    } catch (e) {
      reply = e.name === 'TimeoutError' ? 'timed out' : e.message
    }
    let data = {}
    try {
      data = JSON.parse(reply)
    } catch {
      // not JSON
    }
    const file = join(this.q, `${item.id}.json`)
    if (status === 200 || status === 404) {
      s.authError = false
      s.sent++
      s.lastSentAt = new Date().toISOString()
      const um = data.unmatched?.length ?? (status === 404 ? 'all' : 0)
      if (status === 404 || (Array.isArray(data.unmatched) && data.unmatched.length)) s.unmatched++
      s.lastResult =
        status === 404
          ? `Sample ${item.meta.barcode || ''} has no bill in the app; saved in the app's unmatched list`
          : data.kind === 'qc'
            ? `QC lot ${data.lot} ${data.level}: ${data.matched} value(s) saved`
            : `Sample ${item.meta.barcode || ''}: ${data.matched?.length ?? 0} value(s) saved${um ? `, ${Array.isArray(data.unmatched) ? data.unmatched.join(', ') : um} not mapped` : ''}`
      log.info(item.machineName, s.lastResult)
      appendFileSync(join(this.dir, `sent-${s.lastSentAt.slice(0, 10)}.jsonl`), JSON.stringify({ at: s.lastSentAt, machine: item.machineName, status, barcode: item.meta.barcode, reply: data }) + '\n')
      rmSync(file, { force: true })
      return
    }
    if (status === 400) {
      s.lastError = `The app did not accept a message: ${data.error || reply}`
      log.error(item.machineName, `${s.lastError}. Kept in data/failed/${item.id}.json`)
      writeFileSync(join(this.failed, `${item.id}.json`), JSON.stringify({ ...item, token: undefined, status, reply }))
      rmSync(file, { force: true })
      return
    }
    item.attempts++
    if (status === 401 || status === 403) {
      s.authError = true
      s.lastError = 'The app refused the token. Make a new token in the app (Connect analyser) and paste it in config.json'
      item.nextAt = Date.now() + 5 * 60_000
    } else {
      s.lastError = status ? `The app answered ${status}: ${data.error || reply.slice(0, 200)}` : `Could not reach the app (${reply}); will retry`
      item.nextAt = Date.now() + Math.min(300_000, 10_000 * 2 ** Math.min(item.attempts - 1, 5))
    }
    if (item.attempts === 1 || item.attempts % 10 === 0) log.warn(item.machineName, s.lastError)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(item))
    renameSync(tmp, file)
  }
}
