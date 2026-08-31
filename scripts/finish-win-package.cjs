const fs = require('fs')
const path = require('path')

function copyReplace(src, dest) {
  try {
    fs.copyFileSync(src, dest)
    return dest
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
    const pending = dest.replace(/\.exe$/i, '.new.exe')
    fs.copyFileSync(src, pending)
    console.error(`Could not replace ${dest} because it is in use. Close relay-chat-dock.exe, then replace it with ${pending}`)
    process.exitCode = 1
    return pending
  }
}

const built = path.resolve('relay-chat-dock.build.exe')
if (!fs.existsSync(built)) {
  console.error('pkg did not create relay-chat-dock.build.exe')
  process.exit(1)
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
  let destText = fs.readFileSync(destPath, 'utf8')
  const dest = envValues(destText)
  const destKeys = new Set(Object.keys(dest))
  const extra = []
  let pending = []
  for (const line of fs.readFileSync(srcPath, 'utf8').split(/\r?\n/)) {
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

fs.mkdirSync('deploy', { recursive: true })
copyReplace(built, path.resolve('relay-chat-dock.exe'))
copyReplace(built, path.resolve('deploy', 'relay-chat-dock.exe'))
fs.rmSync(path.resolve('deploy', 'dist'), { recursive: true, force: true })
fs.cpSync('dist', path.resolve('deploy', 'dist'), { recursive: true })
const deployEnv = path.resolve('deploy', 'production.env')
if (fs.existsSync('production.env')) mergeEnvFile('production.env', deployEnv)
else if (!fs.existsSync(deployEnv) && fs.existsSync('.env.example')) fs.copyFileSync('.env.example', deployEnv)
fs.rmSync(built, { force: true })
if (!process.exitCode) console.log('Created deploy\\relay-chat-dock.exe')
