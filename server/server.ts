import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import WebSocket from 'ws'
import { createServer } from 'node:http'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Token = { accessToken: string; refreshToken?: string; expiresAt?: number; user?: string; userId?: string; channelId?: string; liveChatId?: string }
type Account = { platform: Platform; connected: boolean; live: boolean; viewers: number; handle: string }
type ChatMessage = { id: string; platform: Platform; user: string; text: string; time: string; emotes?: string[] }
type State = { accounts: Account[]; streamInfo: { title: string; category: string }; messages: ChatMessage[] }

const port = Number(process.env.PORT || 4173)
const app = express()
const httpServer = createServer(app)
const clients = new Set<express.Response>()
const dataDir = path.resolve(process.env.RELAY_DATA_DIR || './data')
const tokenFile = path.join(dataDir, 'tokens.json')
const redirectUri = process.env.OAUTH_REDIRECT_URI || `http://localhost:${port}/oauth/callback`
const tokens: Partial<Record<Platform, Token>> = loadTokens()
const oauthStates = new Map<string, { platform: Platform; createdAt: number }>()
const youtubeSeen = new Set<string>()
let twitchSocket: WebSocket | undefined
const state: State = {
  accounts: ['Twitch', 'Kick', 'YouTube'].map((platform) => ({ platform: platform as Platform, connected: Boolean(tokens[platform as Platform]), live: false, viewers: 0, handle: tokens[platform as Platform]?.user || '' })),
  streamInfo: { title: '', category: '' },
  messages: [],
}

app.use(cors())
app.use(express.json())
app.get('/api/state', (_request, response) => response.json(state))
app.get('/events', (request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
  response.write(`data: ${JSON.stringify(state)}\n\n`)
  clients.add(response)
  request.on('close', () => clients.delete(response))
})
app.post('/api/messages', async (request, response) => {
  const { platforms, text } = request.body as { platforms?: Platform[]; text?: string }
  if (!text?.trim() || !platforms?.length) return response.status(400).json({ error: 'platforms and text are required' })
  response.json({ results: await Promise.all(platforms.map((platform) => sendMessage(platform, text.trim()))) })
})
app.post('/api/stream-info', async (request, response) => {
  const { title, category } = request.body as { title?: string; category?: string }
  state.streamInfo = { title: String(title || '').trim(), category: String(category || '').trim() }
  const results = await Promise.all((['Twitch', 'Kick'] as Platform[]).map((platform) => updateStreamInfo(platform, state.streamInfo)))
  broadcast()
  response.json({ streamInfo: state.streamInfo, results })
})
app.post('/api/disconnect/:platform', (request, response) => {
  const platform = request.params.platform as Platform
  delete tokens[platform]
  saveTokens()
  const account = state.accounts.find((item) => item.platform === platform)
  if (account) Object.assign(account, { connected: false, live: false, viewers: 0, handle: '' })
  if (platform === 'Twitch' && twitchSocket) twitchSocket.close()
  broadcast()
  response.json({ ok: true })
})

app.get('/oauth/:platform', (request, response) => {
  const platform = request.params.platform as Platform
  if (!['Twitch', 'Kick', 'YouTube'].includes(platform)) return response.status(404).send('Unknown platform')
  const url = authorizationUrl(platform)
  if (!url) return response.status(500).send(`Missing ${platform} client ID. Configure the backend .env file.`)
  response.redirect(url)
})
app.get('/oauth/callback', async (request, response) => {
  const oauthState = oauthStates.get(String(request.query.state || ''))
  const platform = oauthState?.platform
  const code = String(request.query.code || '')
  if (!code || !platform || Date.now() - oauthState.createdAt > 10 * 60 * 1000) return response.status(400).send('OAuth callback is missing a valid state or code.')
  oauthStates.delete(String(request.query.state))
  try {
    tokens[platform] = await exchangeCode(platform, code)
    saveTokens()
    const account = state.accounts.find((item) => item.platform === platform)
    if (account) Object.assign(account, { connected: true, handle: tokens[platform]?.user || platform })
    if (platform === 'Twitch') connectTwitchChat()
    broadcast()
    response.send('<script>window.close()</script>Connected. You can close this window.')
  } catch (error) {
    console.error(error)
    response.status(502).send('OAuth exchange failed. Check the backend console.')
  }
})

const distPath = path.resolve('./dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('*', (_request, response) => response.sendFile(path.join(distPath, 'index.html')))
}
httpServer.listen(port, () => console.log(`Relay backend listening on http://localhost:${port}`))
for (const platform of ['Twitch', 'YouTube'] as Platform[]) if (tokens[platform]) startAdapter(platform)
setInterval(pollLiveState, 15_000)

function authorizationUrl(platform: Platform) {
  const clientId = process.env[`${platform.toUpperCase()}_CLIENT_ID`]
  if (!clientId) return null
  const stateValue = crypto.randomBytes(24).toString('hex')
  oauthStates.set(stateValue, { platform, createdAt: Date.now() })
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state: stateValue })
  if (platform === 'Twitch') params.set('scope', 'user:read:email chat:read chat:edit channel:manage:broadcast')
  if (platform === 'Kick') params.set('scope', 'user:read channel:read chat:read chat:write')
  if (platform === 'YouTube') { params.set('access_type', 'offline'); params.set('prompt', 'consent'); params.set('scope', 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl') }
  return platform === 'Twitch' ? `https://id.twitch.tv/oauth2/authorize?${params}` : platform === 'Kick' ? `https://id.kick.com/oauth/authorize?${params}` : `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function exchangeCode(platform: Platform, code: string): Promise<Token> {
  const clientId = process.env[`${platform.toUpperCase()}_CLIENT_ID`] || ''
  const clientSecret = process.env[`${platform.toUpperCase()}_CLIENT_SECRET`] || ''
  const endpoint = platform === 'Twitch' ? 'https://id.twitch.tv/oauth2/token' : platform === 'Kick' ? 'https://id.kick.com/oauth/token' : 'https://oauth2.googleapis.com/token'
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri })
  const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!result.ok) throw new Error(`${platform} token exchange: ${result.status} ${await result.text()}`)
  const json = await result.json() as { access_token: string; refresh_token?: string; expires_in?: number }
  const token: Token = { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined }
  if (platform === 'Twitch') {
    const user = await twitchApi('/helix/users', token)
    token.user = user.data?.[0]?.login || 'Twitch'
    token.userId = user.data?.[0]?.id
  } else if (platform === 'YouTube') token.user = 'YouTube account'
  else token.user = 'Kick account'
  return token
}

async function twitchApi(endpoint: string, token: Token, options: RequestInit = {}) {
  const response = await fetch(`https://api.twitch.tv${endpoint}`, { ...options, headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID || '', Authorization: `Bearer ${token.accessToken}`, ...options.headers } })
  if (!response.ok) throw new Error(`Twitch API ${response.status}: ${await response.text()}`)
  return response.json() as Promise<any>
}
async function youtubeApi(endpoint: string, token: Token) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3${endpoint}`, { headers: { Authorization: `Bearer ${token.accessToken}` } })
  if (!response.ok) throw new Error(`YouTube API ${response.status}: ${await response.text()}`)
  return response.json() as Promise<any>
}

function connectTwitchChat() {
  if (!tokens.Twitch?.user || twitchSocket) return
  const token = tokens.Twitch
  twitchSocket = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
  twitchSocket.on('open', () => { twitchSocket?.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n'); twitchSocket?.send(`PASS oauth:${token.accessToken}\r\nNICK ${token.user}\r\nJOIN #${token.user}\r\n`) })
  twitchSocket.on('message', (data) => parseTwitchLines(data.toString()).forEach(addMessage))
  twitchSocket.on('close', () => { twitchSocket = undefined; if (tokens.Twitch) setTimeout(connectTwitchChat, 5_000) })
  twitchSocket.on('error', (error) => console.error('Twitch chat:', error.message))
}
function parseTwitchLines(raw: string): ChatMessage[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    if (line.startsWith('PING')) { twitchSocket?.send('PONG :tmi.twitch.tv\r\n'); return [] }
    const match = line.match(/^@([^ ]+) :([^!]+)!.* PRIVMSG #[^ ]+ :(.*)$/)
    if (!match) return []
    const tags = Object.fromEntries(match[1].split(';').map((item) => item.split('=')))
    return [{ id: crypto.randomUUID(), platform: 'Twitch' as Platform, user: tags['display-name'] || match[2], text: match[3], time: new Date().toISOString(), emotes: tags.emotes ? tags.emotes.split('/').map((item: string) => item.split(':')[0]) : [] }]
  })
}
function addMessage(message: ChatMessage) { state.messages = [...state.messages.slice(-199), message]; broadcast() }
async function pollLiveState() {
  try {
    if (tokens.Twitch) await pollTwitch()
    if (tokens.YouTube) await pollYouTube()
    if (tokens.Kick) await pollKick()
    broadcast()
  } catch (error) { console.error('Live state poll:', error) }
}
async function pollTwitch() {
  const token = tokens.Twitch!
  const streams = await twitchApi(`/helix/streams?user_id=${token.userId}`, token)
  const account = state.accounts.find((item) => item.platform === 'Twitch')!
  const stream = streams.data?.[0]
  Object.assign(account, { live: Boolean(stream), viewers: stream?.viewer_count || 0 })
  if (stream && !twitchSocket) connectTwitchChat()
}
async function pollYouTube() {
  const token = tokens.YouTube!
  const broadcasts = await youtubeApi('/liveBroadcasts?part=snippet,contentDetails,status&mine=true', token)
  const account = state.accounts.find((item) => item.platform === 'YouTube')!
  const broadcastItem = broadcasts.items?.find((item: any) => item.status?.lifeCycleStatus === 'live')
  Object.assign(account, { live: Boolean(broadcastItem), viewers: Number(broadcastItem?.liveStreamingDetails?.concurrentViewers || 0) })
  const chatId = broadcastItem?.snippet?.liveChatId || broadcastItem?.contentDetails?.activeLiveChatId
  if (!chatId) return
  const messages = await youtubeApi(`/liveChat/messages?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails`, token)
  for (const item of messages.items || []) if (!youtubeSeen.has(item.id)) { youtubeSeen.add(item.id); addMessage({ id: item.id, platform: 'YouTube', user: item.authorDetails?.displayName || 'YouTube user', text: item.snippet?.displayMessage || '', time: item.snippet?.publishedAt || new Date().toISOString() }) }
}
async function pollKick() {
  const token = tokens.Kick!
  const base = process.env.KICK_API_BASE
  if (!base) return
  const response = await fetch(`${base}/channels`, { headers: { Authorization: `Bearer ${token.accessToken}` } })
  if (!response.ok) return
  const payload = await response.json() as any
  const channel = payload.data?.[0]
  const account = state.accounts.find((item) => item.platform === 'Kick')!
  Object.assign(account, { live: Boolean(channel?.is_live), viewers: Number(channel?.viewer_count || 0), handle: channel?.slug || account.handle })
}
async function sendMessage(platform: Platform, text: string) {
  if (!tokens[platform]) return { platform, ok: false, error: 'Not connected' }
  if (platform === 'Twitch' && twitchSocket?.readyState === WebSocket.OPEN) { twitchSocket.send(`PRIVMSG #${tokens.Twitch?.user} :${text}\r\n`); return { platform, ok: true } }
  if (platform === 'Kick' && process.env.KICK_API_BASE) return { platform, ok: await kickRequest('/chat', { content: text }) }
  return { platform, ok: false, error: `${platform} chat is not live or its API adapter is unavailable` }
}
async function kickRequest(endpoint: string, body: object) { const response = await fetch(`${process.env.KICK_API_BASE}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.Kick?.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return response.ok }
async function updateStreamInfo(platform: Platform, info: State['streamInfo']) {
  if (!tokens[platform]) return { platform, ok: false, error: 'Not connected' }
  if (platform === 'Twitch') {
    const token = tokens.Twitch!
    const games = await twitchApi(`/helix/games?name=${encodeURIComponent(info.category)}`, token)
    const body = { title: info.title, ...(games.data?.[0]?.id ? { game_id: games.data[0].id } : {}) }
    const response = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${token.userId}`, { method: 'PATCH', headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID || '', Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { platform, ok: response.ok, error: response.ok ? undefined : await response.text() }
  }
  if (platform === 'Kick' && process.env.KICK_API_BASE) return { platform, ok: await kickRequest('/channels', info) }
  return { platform, ok: false, error: 'Configure KICK_API_BASE for the Kick adapter' }
}
function startAdapter(platform: Platform) { if (platform === 'Twitch') connectTwitchChat() }
function broadcast() { const payload = `data: ${JSON.stringify(state)}\n\n`; for (const client of clients) client.write(payload) }
function loadTokens(): Partial<Record<Platform, Token>> { try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')) } catch { return {} } }
function saveTokens() { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 }) }
