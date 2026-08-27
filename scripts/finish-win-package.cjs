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

fs.mkdirSync('deploy', { recursive: true })
copyReplace(built, path.resolve('relay-chat-dock.exe'))
copyReplace(built, path.resolve('deploy', 'relay-chat-dock.exe'))
fs.rmSync(path.resolve('deploy', 'dist'), { recursive: true, force: true })
fs.cpSync('dist', path.resolve('deploy', 'dist'), { recursive: true })
if (fs.existsSync('production.env')) fs.copyFileSync('production.env', path.resolve('deploy', 'production.env'))
else if (!fs.existsSync(path.resolve('deploy', 'production.env')) && fs.existsSync('.env.example')) {
  fs.copyFileSync('.env.example', path.resolve('deploy', 'production.env'))
}
fs.rmSync(built, { force: true })
if (!process.exitCode) console.log('Created deploy\\relay-chat-dock.exe')
