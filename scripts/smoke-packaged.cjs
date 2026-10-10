const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

if (process.platform !== 'win32') {
  console.error('The packaging smoke test runs on Windows.')
  process.exit(1)
}

const root = path.resolve(__dirname, '..')
const sourceDir = path.join(root, 'deploy')
const sourceExe = path.join(sourceDir, 'relay-chat-dock.exe')
if (!fs.existsSync(sourceExe)) {
  console.error('Missing deploy\\relay-chat-dock.exe. Run npm run package:win first.')
  process.exit(1)
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-'))
const children = new Set()
let cleaned = false

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

function releaseDir(dir) {
  const file = path.join(temp, 'release-dir.ps1')
  const escaped = dir.replace(/'/g, "''")
  fs.writeFileSync(file, [
    `$root = '${escaped}'`,
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {',
    '  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\n'))
  spawnSync('powershell.exe', ['-NoProfile', '-File', file], { windowsHide: true, stdio: 'ignore' })
}

async function removeDir(dir) {
  for (let attempt = 0; attempt < 40; attempt++) {
    releaseDir(dir)
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      return
    } catch (error) {
      if (!error || (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'ENOTEMPTY')) throw error
      await sleep(250)
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

async function cleanup() {
  if (cleaned) return
  for (const child of children) killTree(child.pid)
  await removeDir(temp)
  cleaned = true
}

process.on('SIGINT', () => { void cleanup().finally(() => process.exit(1)) })
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(1)) })

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: urlPath, timeout: 2000 }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

async function waitForDock(port) {
  const deadline = Date.now() + 90_000
  let last = 'not started'
  while (Date.now() < deadline) {
    try {
      const hit = await get(port, '/')
      const html = hit.body.toString('utf8')
      if (hit.status === 200 && html.includes('id="root"') && html.includes('Relay Chat Dock')) return html
      last = `status ${hit.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(500)
  }
  throw new Error(`Dock was not reachable on 127.0.0.1:${port} (${last})`)
}

function assetPaths(html) {
  const paths = new Set()
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = match[1]
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) continue
    const pathname = raw.startsWith('/') ? raw : `/${raw.replace(/^\.\//, '')}`
    if (pathname.startsWith('/src/')) continue
    paths.add(pathname.split('?')[0])
  }
  return [...paths]
}

async function assertDock(port, html) {
  const activity = await get(port, '/activity')
  const activityHtml = activity.body.toString('utf8')
  if (activity.status !== 200 || !activityHtml.includes('id="root"')) throw new Error(`/activity did not serve the dock (${activity.status})`)
  const assets = assetPaths(html)
  if (!assets.length) throw new Error('Dock HTML did not reference any local assets')
  for (const asset of assets) {
    const hit = await get(port, asset)
    if (hit.status !== 200 || hit.body.length === 0) throw new Error(`${asset} was not served (${hit.status}, ${hit.body.length} bytes)`)
  }
}

function childNames(pid) {
  const file = path.join(temp, 'children.ps1')
  fs.writeFileSync(file, [
    '$queue = @(' + Number(pid) + ')',
    '$names = @()',
    'while ($queue.Count -gt 0) {',
    '  $id = $queue[0]',
    '  if ($queue.Count -eq 1) { $queue = @() } else { $queue = $queue[1..($queue.Count - 1)] }',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | ForEach-Object {',
    '    $names += $_.Name',
    '    $queue += $_.ProcessId',
    '  }',
    '}',
    '$names -join [Environment]::NewLine',
  ].join('\n'))
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', file], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`Could not list child processes: ${result.stderr || result.stdout}`)
  return result.stdout || ''
}

function smokeEnv(localAppData, port) {
  const env = { ...process.env, LOCALAPPDATA: localAppData, PORT: String(port) }
  env.APPDATA = path.join(localAppData, 'Roaming')
  fs.mkdirSync(env.APPDATA, { recursive: true })
  fs.mkdirSync(localAppData, { recursive: true })
  delete env.BROWSER_PATH
  delete env.RELAY_DATA_DIR
  delete env.RELAY_BIND
  delete env.RELAY_LAN
  delete env.RELAY_API_TOKEN
  delete env.RELAY_WATCH_TOKEN
  delete env.TWITCH_CLIENT_ID
  delete env.TWITCH_CLIENT_SECRET
  delete env.KICK_CLIENT_ID
  delete env.KICK_CLIENT_SECRET
  delete env.YOUTUBE_CLIENT_ID
  delete env.YOUTUBE_CLIENT_SECRET
  return env
}

function copyApp(dest) {
  fs.cpSync(sourceDir, dest, { recursive: true })
  const envFile = path.join(dest, 'production.env')
  if (fs.existsSync(envFile)) fs.rmSync(envFile)
  fs.rmSync(path.join(dest, 'data'), { recursive: true, force: true })
  fs.rmSync(path.join(dest, 'installed.origin'), { force: true })
}

function launch(appDir, env) {
  const logs = []
  const child = spawn(path.join(appDir, 'relay-chat-dock.exe'), [], {
    cwd: appDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const push = (chunk) => {
    logs.push(String(chunk))
    if (logs.join('').length > 16_000) logs.shift()
  }
  child.stdout.on('data', push)
  child.stderr.on('data', push)
  child.once('exit', () => children.delete(child))
  child.logs = () => logs.join('')
  return child
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode != null) return resolve()
    const timer = setTimeout(resolve, 15_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    killTree(child.pid)
  })
}

async function smokePortable() {
  const appDir = path.join(temp, 'portable')
  const local = path.join(temp, 'portable-local')
  copyApp(appDir)
  const port = await freePort()
  const child = launch(appDir, smokeEnv(local, port))
  try {
    const html = await waitForDock(port)
    if (child.exitCode != null) throw new Error(`Portable app exited before the dock was ready (${child.exitCode})`)
    await assertDock(port, html)
    await sleep(1500)
    const names = childNames(child.pid)
    if (/msedge\.exe|chrome\.exe/i.test(names)) throw new Error(`Startup spawned a browser:\n${names}`)
    console.log(`Portable app served the dock on 127.0.0.1:${port} without Edge or Chrome`)
  } catch (error) {
    console.error(child.logs())
    throw error
  } finally {
    await stop(child)
  }
}

async function smokeInstalledUpdate() {
  const appDir = path.join(temp, 'installed')
  const local = path.join(temp, 'installed-local')
  copyApp(appDir)
  fs.writeFileSync(path.join(appDir, 'installed.origin'), 'installer\n')
  const port = await freePort()
  const child = launch(appDir, smokeEnv(local, port))
  try {
    await waitForDock(port)
  } catch (error) {
    console.error(child.logs())
    throw error
  } finally {
    await stop(child)
  }

  const profile = path.join(local, 'Relay Chat Dock')
  const envFile = path.join(profile, 'production.env')
  const dataDir = path.join(profile, 'data')
  if (!fs.existsSync(envFile)) throw new Error(`Installed layout did not create ${envFile}`)
  fs.appendFileSync(envFile, '\nSMOKE_KEEP=kept-across-update\n')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'smoke-keep.json'), '{"ok":true}\n')

  await removeDir(appDir)
  copyApp(appDir)
  fs.writeFileSync(path.join(appDir, 'installed.origin'), 'installer\n')
  const nextPort = await freePort()
  const updated = launch(appDir, smokeEnv(local, nextPort))
  try {
    await waitForDock(nextPort)
    const envText = fs.readFileSync(envFile, 'utf8')
    if (!envText.includes('SMOKE_KEEP=kept-across-update')) throw new Error('production.env did not survive the app-file update')
    if (!fs.existsSync(path.join(dataDir, 'smoke-keep.json'))) throw new Error('LocalAppData data did not survive the app-file update')
    if (fs.existsSync(path.join(appDir, 'data', 'smoke-keep.json'))) throw new Error('Installed data was written beside the exe')
    console.log('Installed layout kept LocalAppData production.env and data across an app-file update')
  } catch (error) {
    console.error(updated.logs())
    throw error
  } finally {
    await stop(updated)
  }
}

smokePortable()
  .then(() => smokeInstalledUpdate())
  .then(() => cleanup())
  .then(() => {
    console.log('Packaging smoke test passed')
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.stack || error.message : error)
    try { await cleanup() } catch (cleanupError) {
      console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError)
    }
    process.exit(1)
  })
