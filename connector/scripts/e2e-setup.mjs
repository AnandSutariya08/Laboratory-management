// Local end-to-end setup (emulators only): four test analysers with tokens, machine codes on tests and two
// bills with barcodes. Writes connector/data-e2e/config.json. Run with the emulators up:
//   node connector/scripts/e2e-setup.mjs
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(resolve(here, '../../package.json'))
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
initializeApp({ projectId: 'demo-health-care-labs' })
const lab = getFirestore('health-care-labs').doc('labs/main')
const out = resolve(here, '../data-e2e')

const machines = [
  { id: 'e2e-xl200', name: 'Test XL-200 (TCP, analyser connects)', connection: 'tcp-server', protocol: 'astm', tcp: { port: 7401 } },
  { id: 'e2e-bs240', name: 'Test BS-240 (TCP, connector connects)', connection: 'tcp-client', protocol: 'hl7', tcp: { host: '127.0.0.1', port: 7402 } },
  { id: 'e2e-folder', name: 'Test folder analyser', connection: 'folder', folder: { path: join(out, 'drop'), scanSeconds: 1 } },
]
const config = { endpoint: 'http://127.0.0.1:5001/demo-health-care-labs/asia-south1/analyserIngest', dataDir: join(out, 'data'), statusPort: 7399, machines: [] }
const tokens = {}
for (const m of [...machines, { id: 'e2e-serial', name: 'Test serial analyser' }]) {
  const token = `main.${m.id}.${randomBytes(24).toString('hex')}`
  tokens[m.id] = token
  await lab.collection('qcMachines').doc(m.id).set({
    id: m.id, name: m.name, branchId: 'main', departmentId: 'biochemistry', active: true, testIds: [],
    ingestTokenHash: createHash('sha256').update(token).digest('hex'), ingestTokenAt: Timestamp.now(),
  })
  if (m.connection) config.machines.push({ name: m.name, token, connection: m.connection, protocol: m.protocol, tcp: m.tcp, folder: m.folder })
}

// Machine codes: FBS glucose as GLU; lipid parameters by their own codes.
const fbs = await lab.collection('tests').doc('fbs').get()
await fbs.ref.update({ parameters: fbs.data().parameters.map((p) => ({ ...p, machineCode: 'GLU' })) })
const lipid = await lab.collection('tests').doc('lipid').get()
await lipid.ref.update({ parameters: lipid.data().parameters.map((p) => ({ ...p, machineCode: p.key })) })

for (const [id, barcode, testIds] of [['e2e-order-1', '010264', ['fbs', 'lipid']], ['e2e-order-2', '010265', ['fbs']]]) {
  await lab.collection('orders').doc(id).set({
    id, barcode, branchId: 'main', deleted: false, patientName: `E2E ${barcode}`, hasMachineValue: false,
    items: [{ id: 'i1', kind: 'test', testIds, status: 'active' }], createdAt: Timestamp.now(),
  })
  for (const t of testIds) await lab.collection(`orders/${id}/results`).doc(t).delete().catch(() => {})
}

mkdirSync(join(out, 'drop'), { recursive: true })
writeFileSync(join(out, 'config.json'), JSON.stringify(config, null, 2))
writeFileSync(join(out, 'serial-token.txt'), tokens['e2e-serial'])
console.log(`Set up ${machines.length + 1} test analysers and 2 bills. Config: ${join(out, 'config.json')}`)
process.exit(0)
