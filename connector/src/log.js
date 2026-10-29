import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Daily log files under data/logs: connector-YYYY-MM-DD.log for events, raw-<machine>-YYYY-MM-DD.log for the
// exact bytes each analyser sent (control characters shown as <STX>, <ETX> ...), which is what you need when
// setting up a new analyser model.

let dir = 'data/logs'
const recent = [] // last lines, shown on the status page

export function setLogDir(d) {
  dir = d
  mkdirSync(dir, { recursive: true })
}

const day = () => new Date().toISOString().slice(0, 10)
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

function write(file, line) {
  try {
    appendFileSync(join(dir, file), line + '\n')
  } catch {
    // A full or read-only disk must not stop results flowing.
  }
}

export function log(level, machine, msg) {
  const line = `${stamp()} ${level.padEnd(5)} ${machine ? `[${machine}] ` : ''}${msg}`
  recent.push(line)
  if (recent.length > 300) recent.shift()
  ;(level === 'ERROR' ? console.error : console.log)(line)
  write(`connector-${day()}.log`, line)
}

export const info = (m, s) => log('INFO', m, s)
export const warn = (m, s) => log('WARN', m, s)
export const error = (m, s) => log('ERROR', m, s)
export const recentLines = () => recent.slice()

const NAMES = { 0: 'NUL', 2: 'STX', 3: 'ETX', 4: 'EOT', 5: 'ENQ', 6: 'ACK', 10: 'LF', 11: 'VT', 13: 'CR', 21: 'NAK', 23: 'ETB', 28: 'FS' }
export function printable(buf) {
  let s = ''
  for (const b of buf) {
    if (b >= 32 && b < 127) s += String.fromCharCode(b)
    else s += `<${NAMES[b] ?? b.toString(16).padStart(2, '0')}>` + (b === 10 ? '\n' : '')
  }
  return s
}

export function raw(machineId, direction, buf) {
  write(`raw-${machineId}-${day()}.log`, `${stamp()} ${direction} ${printable(buf)}`)
}
