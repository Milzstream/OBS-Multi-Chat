const fs = require('fs')
const path = require('path')

const version = (process.env.RELEASE_VERSION || require('../package.json').version).replace(/^v/i, '')
const stage = path.resolve('release-staging')
const zipName = `obs-multi-chat-v${version}-windows-x64.zip`

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage)

const exe = ['relay-chat-dock.exe', path.join('deploy', 'relay-chat-dock.exe')].find((candidate) => fs.existsSync(candidate))
if (!exe) {
  console.error('Missing relay-chat-dock.exe. Run npm run package:win first.')
  process.exit(1)
}

fs.copyFileSync(exe, path.join(stage, 'relay-chat-dock.exe'))
fs.copyFileSync('.env.example', path.join(stage, 'production.env'))

const stagedEnv = fs.readFileSync(path.join(stage, 'production.env'), 'utf8')
if (/CLIENT_SECRET=\S+/.test(stagedEnv) || /CLIENT_ID=\S+/.test(stagedEnv)) {
  console.error('Refusing to ship a production.env that contains filled credentials.')
  process.exit(1)
}

fs.writeFileSync(
  path.join(stage, 'README.txt'),
  `Relay Chat Dock v${version}

1. Edit production.env and add your Twitch, Kick, and YouTube API credentials.
2. Run relay-chat-dock.exe.
3. In OBS, add a Browser Source (or dock) pointed at http://localhost:4173.

OAuth tokens are stored in a local data/tokens.json file beside the executable.
Never share production.env or the data folder.
`,
)

console.log(`Staged ${stage}`)
console.log(`zip_name=${zipName}`)
