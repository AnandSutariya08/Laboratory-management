// Builds the download the app links to: ../public/downloads/hcl-connector.zip (served by the web app).
// Contains the program, the Windows scripts, the guide and the serial-port library with its prebuilt Windows
// binaries, so the lab PC needs only Node.js. Never contains config.json, data or test files.
//   cd connector && npm run pack
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, '../public/downloads/hcl-connector.zip')
const stage = join(tmpdir(), `hcl-connector-${Date.now()}`)
const dest = join(stage, 'HCL-Connector')
mkdirSync(dest, { recursive: true })

const keep = ['src', 'README.md', 'config.example.json', 'package.json', 'setup.bat', 'install-startup.bat', 'start.bat', 'restart.bat', 'stop.bat', 'uninstall.bat', 'status.bat', 'list-ports.bat']
for (const f of keep) cpSync(join(root, f), join(dest, f), { recursive: true })

// Runtime modules only (serialport and its dependencies), Windows binaries only.
if (!existsSync(join(root, 'node_modules/serialport'))) throw new Error('Run npm install in connector/ first')
cpSync(join(root, 'node_modules'), join(dest, 'node_modules'), {
  recursive: true,
  filter: (src) => !/[\\/]node_modules[\\/](@serialport[\\/]binding-mock|\.package-lock\.json)/.test(src) && !/[\\/]prebuilds[\\/](?!win32-)[^\\/]+/.test(src),
})

mkdirSync(dirname(out), { recursive: true })
rmSync(out, { force: true })
execFileSync('zip', ['-qr', '-X', out, 'HCL-Connector'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })
console.log(`Packed ${out}`)
