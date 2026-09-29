const fs = require('fs')
const path = require('path')

const version = require('../package.json').version
const unpacked = path.resolve('deploy-electron', 'win-unpacked')
const exe = path.join(unpacked, 'relay-chat-dock.exe')
if (!fs.existsSync(exe)) {
  console.error('electron-builder did not create deploy-electron\\win-unpacked\\relay-chat-dock.exe')
  process.exit(1)
}

const deploy = path.resolve('deploy')
const savedEnv = path.join(deploy, 'production.env')
const keptEnv = fs.existsSync(savedEnv) ? fs.readFileSync(savedEnv) : null
const dataDir = path.join(deploy, 'data')
const keptData = path.join(require('os').tmpdir(), `relay-deploy-data-${process.pid}`)
if (fs.existsSync(dataDir)) fs.cpSync(dataDir, keptData, { recursive: true })
fs.rmSync(deploy, { recursive: true, force: true })
fs.cpSync(unpacked, deploy, { recursive: true })
if (keptEnv) fs.writeFileSync(savedEnv, keptEnv)
if (fs.existsSync(keptData)) {
  fs.cpSync(keptData, dataDir, { recursive: true })
  fs.rmSync(keptData, { recursive: true, force: true })
}

function envValues(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function mergeEnvFile(srcPath, destPath) {
  if (!fs.existsSync(destPath)) {
    if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, destPath)
    return
  }
  if (!fs.existsSync(srcPath)) return
  const src = fs.readFileSync(srcPath, 'utf8')
  let destText = fs.readFileSync(destPath, 'utf8')
  const dest = envValues(destText)
  const destKeys = new Set(Object.keys(dest))
  const extra = []
  let pending = []
  for (const line of src.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) {
      pending.push(line)
      continue
    }
    const key = match[1]
    const value = match[2]
    if (!destKeys.has(key)) {
      extra.push(...pending, line)
      destKeys.add(key)
    } else if (!String(dest[key] || '').trim() && String(value || '').trim()) {
      destText = destText.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
      dest[key] = value
    }
    pending = []
  }
  if (extra.length) destText = destText.replace(/\s*$/, '') + '\n' + extra.join('\n') + '\n'
  fs.writeFileSync(destPath, destText)
}

const deployEnv = path.join(deploy, 'production.env')
if (fs.existsSync('.env.example')) fs.copyFileSync('.env.example', path.join(deploy, '.env.example'))
if (fs.existsSync('production.env')) mergeEnvFile('production.env', deployEnv)
else if (!fs.existsSync(deployEnv) && fs.existsSync('.env.example')) fs.copyFileSync('.env.example', deployEnv)
else if (fs.existsSync('.env.example')) mergeEnvFile('.env.example', deployEnv)
fs.writeFileSync(path.join(deploy, 'package.json'), `${JSON.stringify({ name: 'obs-multi-chat', version }, null, 2)}\n`)
console.log('Created deploy\\relay-chat-dock.exe')
