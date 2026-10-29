import test from 'node:test'
import assert from 'node:assert/strict'
import { AstmReceiver, frame, checksum, split as astmSplit, ENQ, EOT, ACK, NAK } from '../src/astm.js'
import { MllpReceiver, wrap, ack } from '../src/hl7.js'
import { toMessages, detect } from '../src/formats.js'

const ASTM = [
  'H|\\^&|||XL-200^1.0|||||||P|1',
  'P|1||PID001||Shah^Ravi',
  'O|1|010264||^^^GLU\\^^^CHOL|R',
  'R|1|^^^GLU|95|mg/dL||N||F',
  'R|2|^^^CHOL|210|mg/dL||H||F',
  'P|2||PID002||Patel^Asha',
  'O|1|010265||^^^GLU|R',
  'R|1|^^^GLU|132|mg/dL||H||F',
  'L|1|N',
].join('\r') + '\r'

function run(chunks, opts = {}) {
  const out = []
  const msgs = []
  const warns = []
  const rx = new AstmReceiver({ write: (b) => out.push(...b), onMessage: (t) => msgs.push(t), onWarn: (w) => warns.push(w), ...opts })
  for (const c of chunks) rx.push(c)
  return { out, msgs, warns }
}

test('checksum matches the ASTM example', () => {
  // "1H|\^&" + CR + ETX: known to give a two-digit hex sum
  assert.match(checksum(Buffer.from('1H|\\^&\r\x03', 'latin1')), /^[0-9A-F]{2}$/)
})

test('ASTM handshake, frames split across chunks and ETB continuation', () => {
  const half = ASTM.length / 2
  const f1 = frame(1, ASTM.slice(0, half), false)
  const f2 = frame(2, ASTM.slice(half), true)
  const all = Buffer.concat([Buffer.from([ENQ]), f1, f2, Buffer.from([EOT])])
  // feed byte by byte to prove reassembly
  const { out, msgs, warns } = run([...all].map((b) => Buffer.from([b])))
  assert.deepEqual(out, [ACK, ACK, ACK])
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0], ASTM)
  assert.equal(warns.length, 0)
})

test('bad checksum is refused with NAK and accepted when ignored', () => {
  const f = frame(1, ASTM)
  f[f.length - 4] = 0x30 // corrupt checksum digit
  f[f.length - 3] = 0x30
  assert.deepEqual(run([Buffer.from([ENQ]), f, Buffer.from([EOT])]).out, [ACK, NAK])
  assert.equal(run([Buffer.from([ENQ]), f, Buffer.from([EOT])], { ignoreChecksum: true }).msgs.length, 1)
})

test('unframed ASTM records end at the L record', () => {
  const { msgs } = run([Buffer.from(ASTM.replace(/\r/g, '\r\n'), 'latin1')])
  assert.equal(msgs.length, 1)
})

test('one ASTM transmission with two samples becomes two messages', () => {
  const { messages, queries } = astmSplit(ASTM)
  assert.equal(messages.length, 2)
  assert.equal(queries.length, 0)
  assert.match(messages[0], /^H\|.*\rP\|1\|\|PID001.*\rO\|1\|010264.*\rR\|1.*\rR\|2.*\rL\|1\|N\r$/s)
  assert.doesNotMatch(messages[0], /010265/)
  const r = toMessages(ASTM, 'astm')
  assert.deepEqual(r.messages.map((m) => m.barcode), ['010264', '010265'])
})

test('ASTM worklist queries are reported, not sent', () => {
  const q = 'H|\\^&\rQ|1|^010264||ALL\rL|1|N\r'
  const r = toMessages(q, 'astm')
  assert.equal(r.messages.length, 0)
  assert.equal(r.queries.length, 1)
})

const HL7 = [
  'MSH|^~\\&|BS-240|Mindray|LIS|Lab|20261029101500||ORU^R01|MSG0001|P|2.3.1',
  'PID|1||PID001||Shah^Ravi',
  'OBR|1|010264|010264|^Biochem',
  'OBX|1|NM|GLU^Glucose||95|mg/dL|70-110|N|||F',
  'OBX|2|NM|CHOL^Cholesterol||210|mg/dL|0-200|H|||F',
  'OBR|2|010265|010265|^Biochem',
  'OBX|1|NM|GLU^Glucose||132|mg/dL|70-110|H|||F',
].join('\r') + '\r'

test('MLLP message gets an HL7 ACK with the control id', () => {
  const out = []
  const msgs = []
  const rx = new MllpReceiver({ write: (b) => out.push(b), onMessage: (t) => msgs.push(t) })
  const w = wrap(HL7)
  rx.push(w.subarray(0, 10))
  rx.push(w.subarray(10))
  assert.equal(msgs.length, 1)
  const reply = Buffer.concat(out).toString('latin1')
  assert.match(reply, /^\x0bMSH\|\^~\\&\|LIS\|Lab\|BS-240\|Mindray\|/)
  assert.match(reply, /MSA\|AA\|MSG0001\r\x1c\r$/)
  assert.match(ack(HL7, 'AE'), /MSA\|AE\|MSG0001/)
})

test('HL7 with two OBR becomes two messages', () => {
  const r = toMessages(HL7, 'hl7')
  assert.deepEqual(r.messages.map((m) => m.barcode), ['010264', '010265'])
  assert.match(r.messages[0].body, /^MSH.*\rPID.*\rOBR\|1.*\rOBX\|1.*\rOBX\|2.*\r$/s)
})

test('CSV rows are grouped per barcode', () => {
  const csv = 'Sample ID,Test,Result,Unit,Flag\n010264,GLU,95,mg/dL,\n010264,CHOL,210,mg/dL,H\n010265,GLU,132,mg/dL,H\n'
  assert.equal(detect(csv), 'csv')
  const r = toMessages(csv)
  assert.equal(r.messages.length, 2)
  assert.deepEqual(r.messages[0].body, { barcode: '010264', results: [{ code: 'GLU', value: '95', unit: 'mg/dL', flag: '' }, { code: 'CHOL', value: '210', unit: 'mg/dL', flag: 'H' }] })
})

test('format detection', () => {
  assert.equal(detect(ASTM), 'astm')
  assert.equal(detect(HL7), 'hl7')
  assert.equal(detect('{"barcode":"1","results":[]}'), 'json')
})
