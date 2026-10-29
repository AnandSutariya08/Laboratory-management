// Local end-to-end run (after e2e-setup.mjs, emulators up). Starts the connector with data-e2e/config.json, plays
// three analysers (ASTM over TCP to the connector, HL7 served for the connector to connect to, a CSV file in a
// folder), drives a fourth over a mock serial port in-process, then checks what reached the database.
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { frame, ENQ, EOT, ACK } from '../src/astm.js'
import { wrap } from '../src/hl7.js'
import { Machine } from '../src/machine.js'
import { Outbox } from '../src/outbox.js'
import * as log from '../src/log.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../data-e2e')
const require = createRequire(resolve(here, '../../package.json'))
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
initializeApp({ projectId: 'demo-health-care-labs' })
const lab = getFirestore('health-care-labs').doc('labs/main')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

// HL7 analyser that the connector connects to.
let hl7Ack = ''
const hl7Server = net.createServer((s) => {
  s.on('data', (d) => (hl7Ack += d.toString('latin1')))
  setTimeout(() => {
    s.write(wrap(['MSH|^~\\&|BS-240|Mindray|LIS|Lab|20261029101500||ORU^R01|MSG77|P|2.3.1', 'PID|1||P2', 'OBR|1|010265|010265', 'OBX|1|NM|GLU^Glucose||132|mg/dL|70-110|H|||F'].join('\r') + '\r'))
  }, 1500)
})
hl7Server.listen(7402, '127.0.0.1')

const conn = spawn(process.execPath, [resolve(here, '../src/index.js'), '--config', join(out, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] })
let connOut = ''
conn.stdout.on('data', (d) => (connOut += d))
conn.stderr.on('data', (d) => (connOut += d))
await sleep(2500)

// 1. ASTM analyser connecting to the connector over TCP, full handshake, two samples, one unknown code.
const astm = ['H|\\^&|||XL-200', 'P|1||P1', 'O|1|010264||^^^GLU\\^^^CHOL|R', 'R|1|^^^GLU|95|mg/dL||N||F', 'R|2|^^^CHOL|210|mg/dL||H||F', 'R|3|^^^XYZ|1.2|U||N||F', 'P|2||P9', 'O|1|999999||^^^GLU|R', 'R|1|^^^GLU|101|mg/dL||N||F', 'L|1|N'].join('\r') + '\r'
const acks = []
await new Promise((done) => {
  const s = net.connect(7401, '127.0.0.1', async () => {
    s.on('data', (d) => acks.push(...d))
    s.write(Buffer.from([ENQ]))
    await sleep(200)
    s.write(frame(1, astm.slice(0, 120), false))
    await sleep(200)
    s.write(frame(2, astm.slice(120), true))
    await sleep(200)
    s.write(Buffer.from([EOT]))
    await sleep(300)
    s.end()
    done()
  })
})
check('ASTM over TCP: analyser got ACK for ENQ and both frames', acks.filter((b) => b === ACK).length === 3, `${acks.length} byte(s) back`)

// 2. Folder: a CSV result file.
mkdirSync(join(out, 'drop'), { recursive: true })
writeFileSync(join(out, 'drop', 'run-0001.csv'), 'Sample ID,Test,Result,Unit\n010264,TG,140,mg/dL\n010264,HDL,48,mg/dL\n')

// 3. Serial: mock port in-process, ASTM frames.
const { MockBinding } = await import('@serialport/binding-mock')
const { SerialPortStream } = await import('@serialport/stream')
MockBinding.createPort('/dev/MOCK1', { echo: false, record: true })
let mockPort
const serialMachine = new Machine(
  { id: 'e2e-serial', name: 'Test serial analyser', token: readFileSync(join(out, 'serial-token.txt'), 'utf8').trim(), connection: 'serial', protocol: 'astm', serial: { port: '/dev/MOCK1', baudRate: 9600 } },
  {
    outbox: new Outbox({ dir: join(out, 'data-serial'), endpoint: JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')).endpoint }),
    dataDir: join(out, 'data-serial'),
    openSerial: (o) => new Promise((ok, fail) => { mockPort = new SerialPortStream({ binding: MockBinding, ...o }); mockPort.on('open', () => ok(mockPort)); mockPort.on('error', fail) }),
  },
)
log.setLogDir(join(out, 'data-serial', 'logs'))
await serialMachine.start()
await sleep(300)
mockPort.port.emitData(Buffer.from([ENQ]))
await sleep(100)
mockPort.port.emitData(frame(1, ['H|\\^&', 'P|1', 'O|1|010265||^^^TG|R', 'R|1|^^^TG|180|mg/dL||H||F', 'L|1|N'].join('\r') + '\r'))
await sleep(100)
mockPort.port.emitData(Buffer.from([EOT]))
await sleep(200)
const serialSent = [...(mockPort.port.recording ?? Buffer.alloc(0))]
check('Serial: analyser got ACK for ENQ and the frame', serialSent.filter((b) => b === ACK).length === 2)

await sleep(9000)

// Checks in the database.
const r1 = (await lab.collection('orders/e2e-order-1/results').doc('fbs').get()).data()
check('ASTM: glucose 95 on bill 010264', r1?.machineValues?.some((v) => v.values?.FBS?.value === '95'), r1?.machineValues?.[0]?.machine)
const lip = (await lab.collection('orders/e2e-order-1/results').doc('lipid').get()).data()
const lv = Object.assign({}, ...(lip?.machineValues ?? []).map((v) => v.values))
check('ASTM + CSV: lipid CHOL 210, TG 140, HDL 48 on bill 010264', lv.CHOL?.value === '210' && lv.TG?.value === '140' && lv.HDL?.value === '48', JSON.stringify(Object.fromEntries(Object.entries(lv).map(([k, v]) => [k, v.value]))))
const r2 = (await lab.collection('orders/e2e-order-2/results').doc('fbs').get()).data()
check('HL7 over TCP: glucose 132 on bill 010265', r2?.machineValues?.some((v) => v.values?.FBS?.value === '132'))
check('HL7: analyser got an ACK', /MSA\|AA\|MSG77/.test(hl7Ack))
const un = (await lab.collection('analyserUnmatched').get()).docs.map((d) => d.data())
check('Unknown code XYZ went to the unmatched list', un.some((u) => u.code === 'XYZ'))
check('Unknown barcode 999999 went to the unmatched list', un.some((u) => u.barcode === '999999'))
const m = (await lab.collection('qcMachines').doc('e2e-xl200').get()).data()
check('Heartbeat: machine shows the connector as seen', !!m?.connector?.lastSeenAt, `${m?.connector?.link} ${m?.connector?.detail}`)
const ser = (await lab.collection('orders/e2e-order-2/results').doc('fbs').get()).data()
check('Serial: TG frame reached the app (TG is not on bill 010265, so it is listed as unmatched)', un.some((u) => u.code === 'TG' && u.barcode === '010265'))
void ser

conn.kill('SIGTERM')
serialMachine.stop()
hl7Server.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log('\nConnector output:\n' + connOut.slice(-3000))
process.exit(failed.length ? 1 : 0)
