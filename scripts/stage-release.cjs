const fs = require('fs')
const path = require('path')

const version = (process.env.RELEASE_VERSION || require('../package.json').version).replace(/^v/i, '')
const stage = path.resolve('release-staging')
const zipName = `obs-multi-chat-v${version}-windows-x64.zip`

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage)

const deploy = path.resolve('deploy')
const exe = path.join(deploy, 'relay-chat-dock.exe')
if (!fs.existsSync(exe)) {
  console.error('Missing deploy\\relay-chat-dock.exe. Run npm run package:win or easy.bat first.')
  process.exit(1)
}

if (fs.existsSync(path.join(deploy, 'resources'))) {
  fs.cpSync(deploy, stage, {
    recursive: true,
    filter: (src) => path.basename(src) !== 'production.env',
  })
} else {
  fs.copyFileSync(exe, path.join(stage, 'relay-chat-dock.exe'))
  const dist = path.join(deploy, 'dist')
  if (fs.existsSync(dist)) fs.cpSync(dist, path.join(stage, 'dist'), { recursive: true })
}
fs.copyFileSync('.env.example', path.join(stage, 'production.env'))
fs.copyFileSync('.env.example', path.join(stage, '.env.example'))
const versionManifest = path.join(stage, 'package.json')
fs.writeFileSync(versionManifest, `${JSON.stringify({ name: 'obs-multi-chat', version }, null, 2)}\n`)
if (!JSON.parse(fs.readFileSync(versionManifest, 'utf8')).version) {
  console.error('Release package.json must include version so the exe can check GitHub for updates.')
  process.exit(1)
}

const stagedEnv = fs.readFileSync(path.join(stage, 'production.env'), 'utf8')
if (/CLIENT_SECRET=\S+/.test(stagedEnv) || /CLIENT_ID=\S+/.test(stagedEnv)) {
  console.error('Refusing to ship a production.env that contains filled credentials.')
  process.exit(1)
}

fs.writeFileSync(
  path.join(stage, 'README.txt'),
  `Relay Chat Dock v${version}

1. Edit production.env and add your Twitch, Kick, and YouTube API credentials plus StreamElements JWTs (one per linked platform).
2. Run relay-chat-dock.exe. The window is the app. Closing it stops the docks.
3. In OBS, add custom browser docks:
   Chat      http://localhost:4173
   Activity  http://localhost:4173/activity

Keep package.json and .env.example beside the exe. The app reads its version from package.json to check GitHub for updates. On launch it appends any new keys from .env.example onto production.env without changing your existing values.
OAuth tokens are stored in a local data/tokens.json file beside the executable.
Never share production.env or the data folder.
`,
)

console.log(`Staged ${stage}`)
console.log(`zip_name=${zipName}`)
