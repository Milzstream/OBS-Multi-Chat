const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const version = require('../package.json').version
const root = path.resolve(__dirname, '..')
const exe = path.join(root, 'deploy', 'relay-chat-dock.exe')
if (!fs.existsSync(exe)) {
  console.error('Missing deploy\\relay-chat-dock.exe. Run npm run package:win first.')
  process.exit(1)
}

const candidates = [
  process.env.ISCC,
  path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
].filter(Boolean)

const iscc = candidates.find((file) => file && fs.existsSync(file))
if (!iscc) {
  console.error('Inno Setup 6 is not installed (ISCC.exe). Install it or skip the setup exe.')
  process.exit(1)
}

const iss = path.join(root, 'installer', 'relay-chat-dock.iss')
const result = spawnSync(iscc, [`/DMyAppVersion=${version}`, iss], { cwd: root, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status || 1)

const setup = path.join(root, `obs-multi-chat-v${version}-windows-x64-setup.exe`)
if (!fs.existsSync(setup)) {
  console.error(`Expected ${setup}`)
  process.exit(1)
}
console.log(`Created ${setup}`)
