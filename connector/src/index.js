#!/usr/bin/env node
import http from 'node:http'
import os from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Machine } from './machine.js'
import { Outbox } from './outbox.js'
import * as log from './log.js'

// Health Care Labs machine connector. Runs on the lab PC that the analysers are cabled to.
//   node src/index.js                 run (reads config.json next to this folder)
//   node src/index.js --check         check config.json and that every token is accepted by the app
//   node src/index.js --list-ports    list the serial (COM) ports on this PC
//   node src/index.js --config <file> use another config file
// The status page is at http://localhost:7300 (only reachable from this PC).

const VERSION = '1.0.0'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function serialOpener() {
  let mod
  try {
    mod = await import('serialport')
  } catch {
    throw new Error('serial support is not installed (run setup.bat again with internet on)')
  }
  return (opts) =>
    new Promise((ok, fail) => {
      const p = new mod.SerialPort({ ...opts, autoOpen: false })
      p.open((e) => (e ? fail(e) : ok(p)))
    })
}

function loadConfig() {
  const file = resolve(arg('--config') || join(root, 'config.json'))
  if (!existsSync(file)) {
    console.error(`No settings file at ${file}. Copy config.example.json to config.json and fill it in (setup.bat does this).`)
    process.exit(1)
  }
  let cfg
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`config.json is not valid JSON: ${e.message}. Check for a missing comma or quote.`)
    process.exit(1)
  }
  const problems = []
  if (!/^https?:\/\//.test(cfg.endpoint || '')) problems.push('"endpoint" must be the address shown in the app (Connect analyser)')
  const machines = (cfg.machines || []).filter((m) => m.enabled !== false)
  if (!machines.length) problems.push('add at least one machine under "machines"')
  for (const [i, m] of machines.entries()) {
    const label = m.name || `machine ${i + 1}`
    const parts = String(m.token || '').split('.')
    if (parts.length !== 3 || !parts[2] || /PASTE/i.test(m.token)) problems.push(`${label}: paste the token made in the app (Connect analyser)`)
    else m.id = parts[1]
    if (!m.name) m.name = label
    if (!['serial', 'tcp-server', 'tcp-client', 'folder'].includes(String(m.connection || '').toLowerCase())) problems.push(`${label}: "connection" must be serial, tcp-server, tcp-client or folder`)
  }
  const ids = machines.map((m) => m.id).filter(Boolean)
  if (new Set(ids).size !== ids.length) problems.push('two machines use the same token; each machine needs its own token')
  if (problems.length) {
    console.error('config.json needs fixing:\n  - ' + problems.join('\n  - '))
    process.exit(1)
  }
  return { ...cfg, machines, file }
}

async function heartbeat(endpoint, m, outbox) {
  const body = {
    heartbeat: true,
    agent: 'hcl-connector',
    version: VERSION,
    host: os.hostname(),
    connection: m.cfg.connection,
    protocol: m.protocol,
    link: m.state.link,
    detail: m.state.detail,
    queue: outbox.pending(m.id),
    lastDataAt: m.state.lastDataAt,
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function statusPage(machines, outbox, cfg) {
  const rows = machines
    .map((m) => {
      const s = outbox.stat(m.id)
      const color = m.state.link === 'connected' || m.state.link === 'listening' ? '#15803d' : m.state.link === 'error' ? '#b91c1c' : '#a16207'
      return `<tr><td><b>${esc(m.name)}</b><div class="sub">${esc(m.cfg.connection)} · ${esc(m.protocol.toUpperCase())}</div></td>
<td><span class="dot" style="background:${color}"></span>${esc(m.state.link)}<div class="sub">${esc(m.state.detail)}</div></td>
<td>${m.cloud?.ok ? '<span class="ok">Accepted</span>' : `<span class="bad">${esc(m.cloud?.error || 'Not checked yet')}</span>`}<div class="sub">${m.cloud?.at ? `checked ${esc(m.cloud.at.slice(11, 19))}` : ''}</div></td>
<td>${m.state.received}<div class="sub">${m.state.lastDataAt ? `last ${esc(m.state.lastDataAt.replace('T', ' ').slice(0, 19))}` : 'nothing yet'}</div></td>
<td>${s.sent}<div class="sub">${esc(s.lastResult)}</div></td>
<td>${outbox.pending(m.id)}</td>
<td class="sub">${esc(s.lastError || m.state.lastWarning)}</td></tr>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Lab machine connector</title><style>
body{font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;margin:24px;color:#10202e;background:#f5f8fb}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#4a5d6c}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dbe5ed;border-radius:10px;overflow:hidden}
th{background:#062b45;color:#fff;text-align:left;padding:8px 10px;font-size:12px}td{padding:8px 10px;border-top:1px solid #e5edf3;vertical-align:top}
.sub{color:#4a5d6c;font-size:12px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.ok{color:#15803d;font-weight:600}.bad{color:#b91c1c;font-weight:600}
pre{background:#0b1720;color:#d6e2ea;padding:12px;border-radius:10px;max-height:360px;overflow:auto;font-size:12px}
</style></head><body><h1>Lab machine connector ${VERSION}</h1>
<p>${esc(os.hostname())} · sending to ${esc(cfg.endpoint)} · settings: ${esc(cfg.file)} · this page refreshes every 5 seconds</p>
<table><thead><tr><th>Machine</th><th>Link to analyser</th><th>Lab app</th><th>Samples received</th><th>Sent to app</th><th>Waiting</th><th>Last problem</th></tr></thead><tbody>${rows}</tbody></table>
<h2 style="font-size:15px;margin:20px 0 6px">Recent activity</h2><pre>${esc(log.recentLines().slice(-80).reverse().join('\n'))}</pre></body></html>`
}

async function main() {
  if (args.includes('--list-ports')) {
    try {
      const { SerialPort } = await import('serialport')
      const ports = await SerialPort.list()
      if (!ports.length) console.log('No serial ports found. Check the cable and the USB-serial driver.')
      for (const p of ports) console.log(`${p.path}\t${p.manufacturer || ''} ${p.friendlyName || ''}`.trim())
    } catch {
      console.log('Serial support is not installed. Run setup.bat with internet on.')
    }
    return
  }

  const cfg = loadConfig()
  const dataDir = resolve(cfg.dataDir || join(root, 'data'))
  log.setLogDir(join(dataDir, 'logs'))
  const outbox = new Outbox({ dir: dataDir, endpoint: cfg.endpoint })
  const needsSerial = cfg.machines.some((m) => String(m.connection).toLowerCase() === 'serial')
  const openSerial = needsSerial ? await serialOpener().catch((e) => async () => { throw e }) : null
  const machines = cfg.machines.map((m) => new Machine(m, { outbox, dataDir, openSerial }))
  const tokens = new Map(machines.map((m) => [m.id, m.token]))

  const beat = async (m) => {
    try {
      const { status, data } = await heartbeat(cfg.endpoint, m, outbox)
      const ok = status === 200 && data.ok
      const error = ok ? '' : status === 401 ? 'Token refused: make a new one in the app' : `App answered ${status || 'nothing'}${data.error ? `: ${data.error}` : ''}`
      if (!m.cloud || m.cloud.ok !== ok) (ok ? log.info : log.warn)(m.name, ok ? `Lab app accepted the token (machine "${data.machine || m.name}")` : error)
      m.cloud = { ok, error, at: new Date().toISOString() }
    } catch (e) {
      if (m.cloud?.ok !== false) log.warn(m.name, `Cannot reach the lab app: ${e.message}`)
      m.cloud = { ok: false, error: `Cannot reach the lab app (${e.message})`, at: new Date().toISOString() }
    }
  }

  if (args.includes('--check')) {
    console.log(`Settings OK: ${machines.length} machine(s). Checking each token with the lab app...`)
    let bad = 0
    for (const m of machines) {
      m.state.link = 'checking'
      m.state.detail = 'setup is checking the token'
      await beat(m)
      console.log(`  ${m.cloud.ok ? 'OK ' : 'BAD'} ${m.name}${m.cloud.ok ? '' : `: ${m.cloud.error}`}`)
      if (!m.cloud.ok) bad++
    }
    process.exit(bad ? 1 : 0)
  }

  log.info('', `Connector ${VERSION} starting on ${os.hostname()} with ${machines.length} machine(s)`)
  // Tell the app as soon as a link changes (a cable unplugged shows within seconds, not at the next minute).
  for (const m of machines) {
    let t
    m.onLinkChange = () => {
      clearTimeout(t)
      t = setTimeout(() => beat(m), 2000)
    }
  }
  for (const m of machines) await m.start()
  for (const m of machines) beat(m)
  setInterval(() => machines.forEach(beat), 60_000)
  setInterval(() => outbox.flush(tokens).catch((e) => log.error('', `Send loop: ${e.message}`)), 3_000)
  outbox.flush(tokens).catch(() => {})

  const port = Number(cfg.statusPort || 7300)
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(statusPage(machines, outbox, cfg))
    })
    .on('error', (e) => log.warn('', `Status page not available on port ${port}: ${e.message}`))
    .listen(port, '127.0.0.1', () => log.info('', `Status page: http://localhost:${port}`))

  const stop = () => {
    log.info('', 'Stopping')
    machines.forEach((m) => m.stop())
    setTimeout(() => process.exit(0), 300)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('uncaughtException', (e) => log.error('', `Unexpected error: ${e.stack || e.message}`))
}

main()
