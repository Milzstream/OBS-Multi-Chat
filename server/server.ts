import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import WebSocket from 'ws'
import { createServer } from 'node:http'
import { KickChat, type KickActivity } from './kick-chat.js'
import { YouTubeLiveChat, type YouTubeChatMessage, type YouTubeChatTarget } from './youtube-chat.js'
import { spawn } from 'node:child_process'
import { ACTIVITY_MAX_AGE_MS, createActivityStore, type ActivityEvent } from './activity.js'
import { StreamElementsClient, fetchRecentActivities, hydrateStreamElements } from './streamelements.js'
import {
  CHAT_MAX,
  YOUTUBE_QUOTA_LIMIT,
  applyLiveStreamDetails,
  collapseYouTubeDuplicates,
  defaultAppSettings,
  isDailyQuotaHeader,
  isEndedYouTubeChat,
  isStoredChatMessage,
  kickBadges,
  kickStreamDetails,
  looksLikePlaceholder,
  mergeIncomingChat,
  missingStreamElementsMessage,
  needsTranslation,
  nextPacificMidnight,
  normalizeAvatar,
  oauthAuthorizeUrl,
  pacificDate,
  parseAppSettings,
  parseKickParts,
  parseTwitchChatLine,
  parseYouTubeQuotaInput,
  partsFromTwitchFragments,
  quotaFromHeaders,
  quotaWarnAt,
  resolveYouTubeLiveChatIds,
  summarizeApiError,
  syncYouTubeTokenChatIds,
  twitchBadgesFromList,
  twitchEventToActivity,
  youtubeApiErrorReason,
  youtubeBadges,
  youtubeChatLabel,
  youtubeLiveChatMessageBody,
  youtubeOfficialToActivity,
  youtubeQuotaCost,
  youtubeQuotaHealthStatus,
  youtubeQuotaLabel,
  youtubeSendGuard,
} from './logic.js'
import type {
  Account,
  AppSettings,
  ChatMessage,
  Health,
  MessagePart,
  Platform,
  StreamDetails,
  StreamElementsStatus,
  StreamPlatform,
  Token,
  TokenPlatform,
  YoutubeQuota,
  YoutubeQuotaStatus,
} from './types.js'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /Fetch API|fetch/i.test(warning.message)) return
  console.warn(warning.stack || warning.message)
})

const isPackaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)
const runtimeDir = isPackaged ? path.dirname(process.execPath) : process.cwd()
const envPath = process.env.DOTENV_CONFIG_PATH || (fs.existsSync(path.join(runtimeDir, 'production.env')) ? path.join(runtimeDir, 'production.env') : path.join(runtimeDir, '.env'))
dotenv.config({ path: envPath })

type State = { accounts: Account[]; streamInfo: Record<StreamPlatform, StreamDetails>; messages: ChatMessage[]; health: Record<Platform, Health>; activity: ActivityEvent[]; activityWarnings: string[]; streamelements: StreamElementsStatus; activityFallback: boolean; ignoreMissingJwt: boolean; dropOldAlerts: boolean; youtubeQuota: YoutubeQuotaStatus }

const port = Number(process.env.PORT || 4173)
const app = express()
const httpServer = createServer(app)
const clients = new Set<express.Response>()
const dataDir = path.resolve(process.env.RELAY_DATA_DIR || './data')
const tokenFile = path.join(dataDir, 'tokens.json')
const settingsFile = path.join(dataDir, 'settings.json')
const chatFile = path.join(dataDir, 'chat.json')
const settings = loadSettings()
const activityStore = createActivityStore(path.join(dataDir, 'activity.json'))
if (settings.dropOldAlerts) activityStore.setMaxAge(ACTIVITY_MAX_AGE_MS)
const redirectUri = process.env.OAUTH_REDIRECT_URI || `http://localhost:${port}/oauth/callback`
const tokens: Partial<Record<TokenPlatform, Token>> = loadTokens()
const activityWarnings = new Map<string, string>()
const streamElements = new StreamElementsClient()
let twitchEventSubSessionId = ''
const oauthStates = new Map<string, { platform: Platform; createdAt: number; codeVerifier?: string }>()
const youtubeSeen = new Set<string>()
const youtubeChatLabels = new Map<string, string>()
const liveCheckLocks = new Map<Platform, Promise<void>>()
const twitchBadgeUrls = new Map<string, string>()
const twitchAvatars = new Map<string, string>()
const twitchAvatarPending = new Set<string>()
let twitchBadgesLoaded = false
let twitchAvatarTimer: NodeJS.Timeout | undefined
const refreshLocks = new Map<Platform, Promise<Token | undefined>>()
const kickChat = new KickChat()
const youtubeChat = new YouTubeLiveChat()
let youtubeQuotaLimit = YOUTUBE_QUOTA_LIMIT
let youtubeQuotaBlockedUntil = 0
let youtubeQuotaUsed = 0
let youtubeQuotaDay = ''
let youtubeQuotaWarnLogged = false
let youtubeQuotaHeaderLogged = false
let lastYouTubeStatusAt = 0
let lastYouTubeOfficialChatAt = 0
let lastYouTubeViewersAt = 0
let youtubeForceStatus = true
let youtubeTargets: YouTubeChatTarget[] = []
const youtubeHistorySeeded = new Set<string>()
const YOUTUBE_STATUS_SEEK_MS = 3 * 60_000
const YOUTUBE_STATUS_LIVE_MS = 60 * 60_000
const YOUTUBE_VIEWERS_MS = 45_000
const YOUTUBE_OFFICIAL_CHAT_MS = 45_000
const YOUTUBE_HYDRATE_MS = 20_000
let youtubeHydratingUntil = 0

function beginYouTubeHydration() {
  const wasInactive = Date.now() >= youtubeHydratingUntil
  youtubeHydratingUntil = Math.max(youtubeHydratingUntil, Date.now() + YOUTUBE_HYDRATE_MS)
  if (wasInactive) collapseYouTubeHydrationDuplicates()
}

function collapseYouTubeHydrationDuplicates() {
  const result = collapseYouTubeDuplicates(state.messages, youtubeTargets)
  if (!result.changed) return
  for (const id of result.seenIds) youtubeSeen.add(id)
  state.messages = result.messages
  persistChat()
  broadcast()
}
const emptyHealth = (): Health => ({ status: 'ok', message: '' })

function rememberYouTubeFromChat(messages: ChatMessage[]) {
  for (const item of messages) {
    if (item.platform !== 'YouTube') continue
    if (item.id) youtubeSeen.add(item.id)
    if (item.sourceId) youtubeHistorySeeded.add(item.sourceId)
  }
}

function loadChat(): ChatMessage[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(chatFile, 'utf8')) as unknown
    const messages = (Array.isArray(parsed) ? parsed : []).filter(isStoredChatMessage).slice(-CHAT_MAX)
    rememberYouTubeFromChat(messages)
    return messages
  } catch {
    return []
  }
}

const state: State = {
  accounts: (['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => ({ platform, connected: Boolean(tokens[platform]), live: false, viewers: 0, handle: tokens[platform]?.user || '' })),
  streamInfo: {
    Twitch: { ...settings.streamInfo.Twitch },
    Kick: { ...settings.streamInfo.Kick },
  },
  messages: loadChat(),
  health: { Twitch: emptyHealth(), Kick: emptyHealth(), YouTube: emptyHealth() },
  activity: activityStore.list(),
  activityWarnings: [],
  streamelements: { connected: false, handle: '', missing: [] },
  activityFallback: settings.activityFallback,
  ignoreMissingJwt: settings.ignoreMissingJwt,
  dropOldAlerts: settings.dropOldAlerts,
  youtubeQuota: { used: 0, limit: youtubeQuotaLimit },
}

function persistChat() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const stored = state.messages.slice(-CHAT_MAX).map((message) => {
      const rest = { ...message }
      delete rest.ingest
      return rest
    })
    fs.writeFileSync(chatFile, JSON.stringify(stored, null, 2), { mode: 0o600 })
  } catch (error) {
    console.error('Chat save:', error instanceof Error ? error.message : error)
  }
}

let twitchIrc: WebSocket | undefined
let twitchIrcReady = false
let twitchEventSub: WebSocket | undefined
let twitchEventSubGeneration = 0
let twitchEventSubReady = false
let twitchEventSubUnsupported = false
let twitchKeepaliveMs = 10_000
let twitchLastEventSub = 0
const recentOutgoing: { id: string; text: string; platforms: Platform[]; at: number }[] = []

app.use(cors())
app.use(express.json())
app.get('/api/state', (_request, response) => {
  state.activity = activityStore.list()
  response.json(state)
})
app.get('/events', (request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
  response.write(`data: ${JSON.stringify(state)}\n\n`)
  clients.add(response)
  request.on('close', () => clients.delete(response))
})
app.post('/api/messages', async (request, response) => {
  const { platforms, text } = request.body as { platforms?: Platform[]; text?: string }
  if (!text?.trim() || !platforms?.length) return response.status(400).json({ error: 'platforms and text are required' })
  const trimmed = text.trim()
  const id = crypto.randomUUID()
  const user = tokens[platforms.find((platform) => tokens[platform]) || platforms[0]]?.user || 'You'
  rememberOutgoing({ id, text: trimmed, platforms, at: Date.now() })
  addMessage({ id, platform: platforms[0], platforms, user, text: trimmed, time: new Date().toISOString() })
  const results = await Promise.all(platforms.map((platform) => sendMessage(platform, trimmed)))
  const sentPlatforms = results.filter((result) => result.ok).map((result) => result.platform)
  const existing = state.messages.find((item) => item.id === id)
    || state.messages.find((item) => item.text === trimmed && ownHandles().has(item.user.toLowerCase()) && Math.abs(Date.parse(item.time) - Date.now()) < 20_000)
  if (existing) {
    if (!sentPlatforms.length) state.messages = state.messages.filter((item) => item.id !== existing.id)
    else {
      existing.platforms = sentPlatforms
      existing.platform = sentPlatforms[0]
    }
    persistChat()
    broadcast()
  }
  response.json({ results })
})
app.post('/api/moderate', async (request, response) => {
  const body = request.body as { action?: string; platform?: Platform; messageId?: string; userId?: string; sourceId?: string; duration?: number }
  if (!body.action || !body.platform) return response.status(400).json({ error: 'action and platform are required' })
  try {
    const result = await moderate(body.platform, { action: body.action, messageId: body.messageId, userId: body.userId, sourceId: body.sourceId, duration: body.duration })
    if (result.ok && body.action === 'delete' && body.messageId) {
      state.messages = state.messages.map((item) => item.id === body.messageId ? { ...item, deleted: true } : item)
      persistChat()
      broadcast()
    }
    response.json(result)
  } catch (error) {
    response.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
app.get('/api/categories/:platform', async (request, response) => {
  const platform = request.params.platform.toLowerCase() === 'twitch' ? 'Twitch' : request.params.platform.toLowerCase() === 'kick' ? 'Kick' : undefined
  const query = String(request.query.query || '').trim()
  if (!platform || !query) return response.json([])
  try { response.json(await searchCategories(platform, query)) } catch (error) { console.error(`${platform} category search:`, error); response.status(502).json({ error: 'Category search failed' }) }
})
app.post('/api/stream-info/:platform', async (request, response) => {
  const platform = request.params.platform.toLowerCase() === 'twitch' ? 'Twitch' : request.params.platform.toLowerCase() === 'kick' ? 'Kick' : undefined
  if (!platform) return response.status(404).json({ error: 'Unknown stream platform' })
  const { title, category, categoryId } = request.body as Partial<StreamDetails>
  const details = { title: String(title || '').trim(), category: String(category || '').trim(), ...(categoryId ? { categoryId: String(categoryId) } : {}) }
  const result = await updateStreamInfo(platform, details)
  if (result.ok) {
    state.streamInfo[platform] = details
    persistStreamInfo()
  }
  broadcast()
  response.json({ streamInfo: state.streamInfo, results: [result] })
})
app.post('/api/stream-info', async (request, response) => {
  const { title, Twitch, Kick } = request.body as { title?: string; Twitch?: StreamDetails; Kick?: StreamDetails }
  const detailsByPlatform = { Twitch: { category: '', ...Twitch, title: String(title || '').trim() }, Kick: { category: '', ...Kick, title: String(title || '').trim() } }
  const results = await Promise.all((['Twitch', 'Kick'] as StreamPlatform[]).map((platform) => updateStreamInfo(platform, detailsByPlatform[platform])))
  let changed = false
  for (const result of results) {
    if (!result.ok) continue
    state.streamInfo[result.platform] = detailsByPlatform[result.platform]
    changed = true
  }
  if (changed) persistStreamInfo()
  broadcast()
  response.json({ streamInfo: state.streamInfo, results })
})
app.post('/api/settings', (request, response) => {
  const body = request.body as { activityFallback?: boolean; ignoreMissingJwt?: boolean; dropOldAlerts?: boolean }
  let changed = false
  if (typeof body.activityFallback === 'boolean' && body.activityFallback !== settings.activityFallback) {
    settings.activityFallback = body.activityFallback
    state.activityFallback = body.activityFallback
    if (body.activityFallback && twitchEventSubSessionId && tokens.Twitch) void subscribeTwitchEvents(twitchEventSubSessionId)
    changed = true
  }
  if (typeof body.ignoreMissingJwt === 'boolean' && body.ignoreMissingJwt !== settings.ignoreMissingJwt) {
    settings.ignoreMissingJwt = body.ignoreMissingJwt
    state.ignoreMissingJwt = body.ignoreMissingJwt
    if (body.ignoreMissingJwt) setActivityWarning('streamelements')
    else {
      const note = missingStreamElementsMessage(state.streamelements.missing)
      if (note) setActivityWarning('streamelements', note)
    }
    changed = true
  }
  if (typeof body.dropOldAlerts === 'boolean' && body.dropOldAlerts !== settings.dropOldAlerts) {
    settings.dropOldAlerts = body.dropOldAlerts
    state.dropOldAlerts = body.dropOldAlerts
    activityStore.setMaxAge(body.dropOldAlerts ? ACTIVITY_MAX_AGE_MS : 0)
    changed = true
  }
  if (changed) {
    saveSettings()
    broadcast()
  }
  response.json({ activityFallback: settings.activityFallback, ignoreMissingJwt: settings.ignoreMissingJwt, dropOldAlerts: settings.dropOldAlerts, streamelements: state.streamelements })
})
app.post('/api/open', (request, response) => {
  const url = String((request.body as { url?: string })?.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return response.status(400).json({ error: 'url must be http or https' })
  try {
    openInDefaultBrowser(url)
    response.json({ ok: true })
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) })
  }
})
app.post('/api/activity/test', (request, response) => {
  const body = request.body as Partial<ActivityEvent>
  const platform = body.platform
  const kind = body.kind
  if (!platform || !kind) return response.status(400).json({ error: 'platform and kind are required' })
  const event: ActivityEvent = {
    id: `test-${crypto.randomUUID()}`,
    platform,
    kind,
    user: String(body.user || 'TestUser'),
    amount: body.amount,
    months: body.months,
    viewers: body.viewers,
    message: body.message || 'Test alert',
    time: new Date().toISOString(),
    source: body.source,
  }
  addActivity(event)
  response.json({ ok: true, event })
})
app.post('/api/disconnect/:platform', (request, response) => {
  const platform = ['Twitch', 'Kick', 'YouTube'].find((item) => item.toLowerCase() === request.params.platform.toLowerCase()) as Platform | undefined
  if (!platform) return response.status(404).json({ error: 'Unknown platform' })
  delete tokens[platform]
  saveTokens()
  const account = state.accounts.find((item) => item.platform === platform)
  if (account) Object.assign(account, { connected: false, live: false, viewers: 0, handle: '' })
  if (platform === 'Twitch') { closeTwitchChat(); setActivityWarning('twitch-scopes') }
  if (platform === 'Kick') void kickChat.stop()
  if (platform === 'YouTube') { setYouTubeTargets([]); void youtubeChat.stop() }
  broadcast()
  response.json({ ok: true })
})
app.post('/api/live-check/:platform', async (request, response) => {
  const platform = ['Twitch', 'Kick', 'YouTube'].find((item) => item.toLowerCase() === request.params.platform.toLowerCase()) as Platform | undefined
  if (!platform) return response.status(404).json({ error: 'Unknown platform' })
  if (!tokens[platform]) return response.status(400).json({ error: `${platform} is not connected` })
  try {
    await checkLiveNow(platform)
    const account = state.accounts.find((item) => item.platform === platform)
    response.json({ ok: true, live: Boolean(account?.live), viewers: account?.viewers || 0 })
  } catch (error) {
    response.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/oauth/callback', async (request, response) => {
  const oauthState = oauthStates.get(String(request.query.state || ''))
  const platform = oauthState?.platform
  const code = String(request.query.code || '')
  if (!code || !platform || Date.now() - oauthState.createdAt > 10 * 60 * 1000) return response.status(400).send('OAuth callback is missing a valid state or code.')
  oauthStates.delete(String(request.query.state))
  try {
    tokens[platform] = await exchangeCode(platform, code, oauthState.codeVerifier)
    saveTokens()
    const account = state.accounts.find((item) => item.platform === platform)
    if (account) Object.assign(account, { connected: true, handle: tokens[platform]?.user || platform })
    startAdapter(platform)
    broadcast()
    response.send('<script>window.close()</script>Connected. You can close this window.')
  } catch (error) {
    console.error(error)
    response.type('text').status(502).send(`OAuth exchange failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})
app.get('/oauth/:platform', (request, response) => {
  const platform = ['Twitch', 'Kick', 'YouTube'].find((item) => item.toLowerCase() === request.params.platform.toLowerCase()) as Platform | undefined
  if (!platform) return response.status(404).send('Unknown platform')
  const url = authorizationUrl(platform)
  if (!url) return response.status(500).send(`Missing ${platform} client ID. Configure the backend .env file.`)
  response.redirect(url)
})

const distPath = path.resolve(isPackaged ? path.join(path.dirname(process.execPath), 'dist') : './dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('*', (_request, response) => response.sendFile(path.join(distPath, 'index.html')))
}
httpServer.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`Relay is already running on port ${port}. Close the existing relay-chat-dock.exe before starting another copy.`)
  else console.error('Relay backend failed to start:', error)
  process.exitCode = 1
})
httpServer.listen(port, '0.0.0.0', () => {
  ensureYouTubeQuotaDay()
  collapseYouTubeHydrationDuplicates()
  const base = `http://127.0.0.1:${port}`
  const missing = streamElementsJwtSlots().filter((slot) => !slot.jwt).map((slot) => slot.platform)
  console.log('')
  console.log('Relay Chat Dock')
  console.log('')
  console.log(`  Chat dock      ${base}`)
  console.log(`  Activity dock  ${base}/activity`)
  console.log('')
  console.log('Add both as OBS custom browser docks (Docks → Custom Browser Docks).')
  console.log('')
  console.log('  YouTube quota  https://console.cloud.google.com/iam-admin/quotas?service=youtube.googleapis.com')
  console.log('  Use YouTube Data API v3 → Queries per day → Current usage (example 35), not the 1,247 quota-count card.')
  if (youtubeQuotaUsed) console.log(`  Estimated today ${youtubeQuotaUsed.toLocaleString()} / ${youtubeQuotaLimit.toLocaleString()} (Pacific)`)
  console.log('  Optional: type 35 or 35/10000 and press Enter anytime. Logging will not wait.')
  console.log('')
  listenForYouTubeQuotaInput()
  if (missing.length && !settings.ignoreMissingJwt) {
    const keys = missing.map((platform) => `STREAMELEMENTS_JWT_${platform.toUpperCase()}`).join(', ')
    console.error(`  StreamElements  missing JWT${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
    console.error(`  Add ${keys} in production.env, then restart this app.`)
    console.error('')
  }
})
for (const platform of ['Twitch', 'Kick', 'YouTube'] as Platform[]) if (tokens[platform]) startAdapter(platform)
void startStreamElements(true)
void pollLiveState()
setInterval(pollLiveState, 15_000)
setInterval(watchTwitchEventSub, 2_000)
setInterval(refreshChatHealth, 5_000)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    persistChat()
    process.exit(0)
  })
}

function authorizationUrl(platform: Platform) {
  const clientId = process.env[`${platform.toUpperCase()}_CLIENT_ID`]
  if (!clientId) return null
  const stateValue = crypto.randomBytes(24).toString('hex')
  const codeVerifier = platform === 'Kick' ? crypto.randomBytes(32).toString('base64url') : undefined
  oauthStates.set(stateValue, { platform, createdAt: Date.now(), codeVerifier })
  const codeChallenge = platform === 'Kick' ? crypto.createHash('sha256').update(codeVerifier!).digest('base64url') : undefined
  return oauthAuthorizeUrl(platform, { clientId, redirectUri, state: stateValue, codeChallenge })
}

async function exchangeCode(platform: Platform, code: string, codeVerifier?: string): Promise<Token> {
  const json = await requestToken(platform, {
    client_id: process.env[`${platform.toUpperCase()}_CLIENT_ID`] || '',
    client_secret: process.env[`${platform.toUpperCase()}_CLIENT_SECRET`] || '',
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    ...(platform === 'Kick' ? { code_verifier: codeVerifier || '' } : {}),
  })
  const token: Token = { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined }
  if (platform === 'Twitch') {
    const user = await twitchApi('/helix/users', token)
    token.user = user.data?.[0]?.login || 'Twitch'
    token.userId = user.data?.[0]?.id
  } else if (platform === 'YouTube') {
    try { await hydrateYouTubeToken(token) } catch { token.user = token.user || 'YouTube' }
  } else await hydrateKickToken(token)
  return token
}

async function hydrateYouTubeToken(token: Token) {
  const channels = await youtubeApi('/channels?part=snippet&mine=true', token)
  const item = channels.items?.[0]
  const channel = item?.snippet
  const handle = String(channel?.customUrl || '').replace(/^@/, '')
  token.channelId = item?.id || token.channelId
  token.user = channel?.title || handle || token.user || 'YouTube'
}

async function hydrateKickToken(token: Token) {
  const [userResponse, channelResponse] = await Promise.all([kickApi('/users', token), kickApi('/channels', token)])
  const userPayload = userResponse.ok ? await userResponse.json() as any : undefined
  const channelPayload = channelResponse.ok ? await channelResponse.json() as any : undefined
  const user = userPayload?.data?.[0]
  const channel = channelPayload?.data?.[0]
  token.user = channel?.slug || user?.name || token.user || 'Kick'
  token.userId = channel?.broadcaster_user_id ? String(channel.broadcaster_user_id) : user?.user_id ? String(user.user_id) : token.userId
}

async function requestToken(platform: Platform, body: Record<string, string>) {
  const endpoint = platform === 'Twitch' ? 'https://id.twitch.tv/oauth2/token' : platform === 'Kick' ? 'https://id.kick.com/oauth/token' : 'https://oauth2.googleapis.com/token'
  const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
  if (!result.ok) throw new Error(`${platform} token request: ${result.status} ${await result.text()}`)
  return result.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>
}

async function ensureToken(platform: Platform): Promise<Token | undefined> {
  const token = tokens[platform]
  if (!token) return
  if (!token.expiresAt || token.expiresAt - 120_000 > Date.now()) return token
  if (!token.refreshToken) return token
  if (!refreshLocks.has(platform)) {
    refreshLocks.set(platform, refreshAccessToken(platform).finally(() => refreshLocks.delete(platform)))
  }
  return refreshLocks.get(platform)
}

async function refreshAccessToken(platform: Platform): Promise<Token | undefined> {
  const token = tokens[platform]
  if (!token?.refreshToken) return token
  try {
    const json = await requestToken(platform, {
      client_id: process.env[`${platform.toUpperCase()}_CLIENT_ID`] || '',
      client_secret: process.env[`${platform.toUpperCase()}_CLIENT_SECRET`] || '',
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
    })
    tokens[platform] = {
      ...token,
      accessToken: json.access_token,
      refreshToken: json.refresh_token || token.refreshToken,
      expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : token.expiresAt,
    }
    saveTokens()
    console.log(`${platform} access token refreshed`)
    return tokens[platform]
  } catch (error) {
    console.error(`${platform} token refresh:`, error instanceof Error ? error.message : error)
    return tokens[platform]
  }
}

async function fetchTimed(url: string, options: RequestInit = {}, ms = 8_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`Request timed out after ${ms}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function twitchApi(endpoint: string, token: Token, options: RequestInit = {}, retried = false): Promise<any> {
  let response: Response
  try {
    response = await fetchTimed(`https://api.twitch.tv${endpoint}`, {
      ...options,
      headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID || '', Authorization: `Bearer ${token.accessToken}`, ...options.headers },
    })
  } catch (error) {
    if (!retried) return twitchApi(endpoint, token, options, true)
    throw error
  }
  if (response.status === 401 && !retried) {
    const refreshed = await refreshAccessToken('Twitch')
    if (refreshed) return twitchApi(endpoint, refreshed, options, true)
  }
  if ((response.status === 502 || response.status === 503 || response.status === 504) && !retried) {
    await new Promise((resolve) => setTimeout(resolve, 800))
    return twitchApi(endpoint, token, options, true)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`Twitch API ${response.status}: ${summarizeApiError(response.status, text)}`)
  return text ? JSON.parse(text) : {}
}

function youtubeQuotaBlocked() {
  return Date.now() < youtubeQuotaBlockedUntil
}

function youtubeQuotaWarnAt() {
  return quotaWarnAt(youtubeQuotaLimit)
}

function youtubeQuotaSnapshot(): YoutubeQuotaStatus {
  return { used: youtubeQuotaUsed, limit: youtubeQuotaLimit }
}

function persistYouTubeQuota() {
  const next = { day: youtubeQuotaDay || pacificDate(), used: youtubeQuotaUsed, limit: youtubeQuotaLimit }
  if (settings.youtubeQuota.day === next.day && settings.youtubeQuota.used === next.used && settings.youtubeQuota.limit === next.limit) return
  settings.youtubeQuota = next
  saveSettings()
}

function ensureYouTubeQuotaDay() {
  const today = pacificDate()
  if (youtubeQuotaDay === today) return
  const saved = settings.youtubeQuota
  const sameDay = saved.day === today
  youtubeQuotaDay = today
  youtubeQuotaUsed = sameDay ? saved.used : 0
  youtubeQuotaLimit = sameDay && saved.limit && saved.limit > 0 ? saved.limit : YOUTUBE_QUOTA_LIMIT
  youtubeQuotaWarnLogged = youtubeQuotaUsed >= youtubeQuotaWarnAt()
  if (!sameDay) youtubeQuotaBlockedUntil = 0
  persistYouTubeQuota()
  state.youtubeQuota = youtubeQuotaSnapshot()
}

function youtubeQuotaHealth(): Health | undefined {
  ensureYouTubeQuotaDay()
  return youtubeQuotaHealthStatus(youtubeQuotaUsed, youtubeQuotaLimit, youtubeQuotaBlocked())
}

function applyYouTubeQuotaHealth() {
  const quota = youtubeQuotaHealth()
  if (quota) setHealth('YouTube', quota.status, quota.message)
  else if (/quota/i.test(state.health.YouTube.message)) setHealth('YouTube', 'ok')
}

function setYouTubeQuotaUsed(used: number, source: string, limit?: number) {
  ensureYouTubeQuotaDay()
  if (limit != null && limit > 0) youtubeQuotaLimit = Math.floor(limit)
  youtubeQuotaUsed = Math.max(0, Math.min(youtubeQuotaLimit, Math.floor(used)))
  youtubeQuotaWarnLogged = youtubeQuotaUsed >= youtubeQuotaWarnAt()
  persistYouTubeQuota()
  state.youtubeQuota = youtubeQuotaSnapshot()
  if (youtubeQuotaUsed < youtubeQuotaLimit) youtubeQuotaBlockedUntil = 0
  console.log(`YouTube quota ${youtubeQuotaUsed.toLocaleString()} / ${youtubeQuotaLimit.toLocaleString()} (${source})`)
  if (youtubeQuotaUsed >= youtubeQuotaLimit) markYouTubeQuotaExceeded()
  else applyYouTubeQuotaHealth()
}

function applyManualYouTubeQuota(line: string) {
  const parsed = parseYouTubeQuotaInput(line)
  if (!parsed) return
  if (parsed.kind === 'help') {
    console.log('YouTube quota: type the Queries per day current usage (e.g. 35), or 35/10000 if your limit is not 10000.')
    return
  }
  if (parsed.kind === 'used') {
    setYouTubeQuotaUsed(parsed.used, 'console', parsed.limit)
    return
  }
  const left = parsed.remaining
  if (left > youtubeQuotaLimit) setYouTubeQuotaUsed(youtubeQuotaUsed, 'console remaining', youtubeQuotaUsed + left)
  else setYouTubeQuotaUsed(youtubeQuotaLimit - left, 'console remaining')
}

function listenForYouTubeQuotaInput() {
  if (!process.stdin || process.stdin.readableEnded || process.stdin.isTTY === false) return
  try { process.stdin.setEncoding('utf8') } catch { return }
  if (typeof process.stdin.resume === 'function') process.stdin.resume()
  let buffer = ''
  process.stdin.on('data', (chunk) => {
    buffer += String(chunk).replace(/\r/g, '')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) applyManualYouTubeQuota(line)
      newline = buffer.indexOf('\n')
    }
  })
  process.stdin.on('error', () => undefined)
}

function applyYouTubeQuotaHeaders(headers: Headers) {
  const parsed = quotaFromHeaders(headers)
  if (!parsed) return false
  const looksDaily = isDailyQuotaHeader(parsed)
  if (!looksDaily) {
    if (!youtubeQuotaHeaderLogged) {
      youtubeQuotaHeaderLogged = true
      console.log('YouTube rate-limit headers are not the daily quota; estimating from this app\'s official calls.')
    }
    return false
  }
  ensureYouTubeQuotaDay()
  if (parsed.limit != null && parsed.limit > 0) youtubeQuotaLimit = parsed.limit
  if (parsed.used != null) youtubeQuotaUsed = parsed.used
  else if (parsed.remaining != null) youtubeQuotaUsed = Math.max(0, youtubeQuotaLimit - parsed.remaining)
  persistYouTubeQuota()
  state.youtubeQuota = youtubeQuotaSnapshot()
  console.log(`YouTube quota ${youtubeQuotaUsed.toLocaleString()} / ${youtubeQuotaLimit.toLocaleString()} (from API headers)`)
  if (youtubeQuotaUsed >= youtubeQuotaWarnAt()) {
    youtubeQuotaWarnLogged = true
    applyYouTubeQuotaHealth()
  } else broadcast()
  return true
}

function noteYouTubeQuotaUse(endpoint: string, method = 'GET') {
  ensureYouTubeQuotaDay()
  const cost = youtubeQuotaCost(endpoint, method)
  const before = youtubeQuotaUsed
  youtubeQuotaUsed += cost
  persistYouTubeQuota()
  state.youtubeQuota = youtubeQuotaSnapshot()
  console.log(`YouTube quota ${youtubeQuotaUsed.toLocaleString()} / ${youtubeQuotaLimit.toLocaleString()} (+${cost} ${youtubeQuotaLabel(endpoint, method)})`)
  if (!youtubeQuotaWarnLogged && youtubeQuotaUsed >= youtubeQuotaWarnAt()) {
    youtubeQuotaWarnLogged = true
    console.warn(`YouTube quota ${youtubeQuotaUsed.toLocaleString()} / ${youtubeQuotaLimit.toLocaleString()} — approaching the daily cap (resets midnight Pacific)`)
  }
  if (before < youtubeQuotaWarnAt() && youtubeQuotaUsed >= youtubeQuotaWarnAt()) applyYouTubeQuotaHealth()
  else broadcast()
}

function markYouTubeQuotaExceeded() {
  ensureYouTubeQuotaDay()
  const until = nextPacificMidnight()
  youtubeQuotaUsed = Math.max(youtubeQuotaUsed, youtubeQuotaLimit)
  persistYouTubeQuota()
  state.youtubeQuota = youtubeQuotaSnapshot()
  if (youtubeQuotaBlockedUntil >= until) {
    applyYouTubeQuotaHealth()
    return
  }
  youtubeQuotaBlockedUntil = until
  console.error(`YouTube Data API quota exceeded (${youtubeQuotaUsed.toLocaleString()} / ${youtubeQuotaLimit.toLocaleString()}). Official YouTube calls paused until midnight Pacific. Chat will use the site reader.`)
  applyYouTubeQuotaHealth()
}

function noteYouTubeQuota(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  if (!/quotaExceeded|quota exceeded/i.test(text)) return false
  markYouTubeQuotaExceeded()
  return true
}

async function youtubeRequest(endpoint: string, token: Token, options: RequestInit = {}, retried = false): Promise<{ ok: boolean; status: number; text: string }> {
  ensureYouTubeQuotaDay()
  if (youtubeQuotaBlocked()) throw new Error('YouTube API quota exceeded')
  const method = String(options.method || 'GET').toUpperCase()
  const localized = /[?&]hl=/.test(endpoint) ? endpoint : `${endpoint}${endpoint.includes('?') ? '&' : '?'}hl=en`
  const headers = { Authorization: `Bearer ${token.accessToken}`, ...(options.headers as Record<string, string> | undefined) }
  const response = await fetchTimed(`https://www.googleapis.com/youtube/v3${localized}`, { ...options, headers }, 12_000)
  const fromHeaders = applyYouTubeQuotaHeaders(response.headers)
  if (response.status === 401 && !retried) {
    if (!fromHeaders) noteYouTubeQuotaUse(endpoint, method)
    const refreshed = await refreshAccessToken('YouTube')
    if (refreshed) return youtubeRequest(endpoint, refreshed, options, true)
  }
  if (!fromHeaders) noteYouTubeQuotaUse(endpoint, method)
  const text = await response.text()
  if (response.status === 403 && /quotaExceeded/i.test(text)) markYouTubeQuotaExceeded()
  return { ok: response.ok, status: response.status, text }
}

function dropEndedYouTubeChat(chatId: string) {
  const token = tokens.YouTube
  if (token) {
    token.liveChatIds = (token.liveChatIds || []).filter((id) => id !== chatId)
    if (token.liveChatId === chatId) token.liveChatId = token.liveChatIds[0]
  }
  const next = youtubeTargets.filter((target) => target.liveChatId !== chatId)
  if (next.length !== youtubeTargets.length) setYouTubeTargets(next)
}

async function youtubeApi(endpoint: string, token: Token): Promise<any> {
  const result = await youtubeRequest(endpoint, token)
  if (result.status === 403 && /quotaExceeded/i.test(result.text)) throw new Error('YouTube API 403 quota exceeded')
  if (!result.ok) throw new Error(`YouTube API ${result.status}: ${youtubeApiErrorReason(result.text)}`)
  return result.text ? JSON.parse(result.text) : {}
}

function startAdapter(platform: Platform) {
  if (platform === 'Twitch') {
    twitchEventSubUnsupported = false
    twitchBadgesLoaded = false
    void ensureTwitchBadges()
    connectTwitchEventSub()
    void pollTwitch().then(() => broadcast()).catch((error) => console.error('Twitch poll:', error instanceof Error ? error.message : error))
  }
  if (platform === 'Kick') void pollKick().then(() => broadcast()).catch((error) => console.error('Kick poll:', error instanceof Error ? error.message : error))
  if (platform === 'YouTube') void pollYouTube().then(() => broadcast()).catch((error) => console.error('YouTube poll:', error instanceof Error ? error.message : error))
}

async function checkLiveNow(platform: Platform) {
  const pending = liveCheckLocks.get(platform)
  if (pending) return pending
  const work = (async () => {
    if (platform === 'Twitch') await pollTwitch()
    else if (platform === 'Kick') await pollKick()
    else {
      youtubeForceStatus = true
      beginYouTubeHydration()
      await pollYouTube()
      const account = state.accounts.find((item) => item.platform === 'YouTube')
      if (!account?.live) {
        const token = await ensureToken('YouTube')
        if (token) {
          await discoverYouTubeLive(token)
          await syncYouTubeChat(token)
          await seedYouTubeHistory(token)
          await refreshYouTubeViewers()
        }
      }
    }
    refreshChatHealth()
    broadcast()
  })().finally(() => {
    if (liveCheckLocks.get(platform) === work) liveCheckLocks.delete(platform)
  })
  liveCheckLocks.set(platform, work)
  return work
}

function startKickChat(slug: string) {
  void kickChat.start(slug, (message) => addMessage({
    id: message.id || crypto.randomUUID(),
    platform: 'Kick',
    user: message.user,
    userId: message.userId,
    color: message.color,
    avatar: normalizeAvatar(message.avatar),
    badges: kickBadges(message.badges),
    text: message.text,
    time: new Date().toISOString(),
    parts: parseKickParts(message.text, message.emotes),
  }), tokens.Kick?.channelId ? Number(tokens.Kick.channelId) : undefined, (event: KickActivity) => addNativeActivity({
    id: event.id || '',
    platform: 'Kick',
    kind: event.kind,
    user: event.user,
    userId: event.userId,
    amount: event.amount,
    months: event.months,
    viewers: event.viewers,
    message: event.message,
    time: new Date().toISOString(),
  })).then(() => {
    if (kickChat.currentChatroomId && tokens.Kick && tokens.Kick.channelId !== String(kickChat.currentChatroomId)) {
      tokens.Kick.channelId = String(kickChat.currentChatroomId)
      saveTokens()
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Kick chat:', message)
    setHealth('Kick', 'down', 'Kick chat failed to connect — messages may be missing')
  })
}

function closeTwitchChat() {
  twitchEventSubGeneration += 1
  twitchEventSubReady = false
  twitchEventSubUnsupported = false
  twitchEventSubSessionId = ''
  twitchIrcReady = false
  twitchEventSub?.close()
  twitchIrc?.close()
  twitchEventSub = undefined
  twitchIrc = undefined
}

function connectTwitchEventSub(url = 'wss://eventsub.wss.twitch.tv/ws') {
  if (!tokens.Twitch?.userId || twitchEventSubUnsupported) return
  const generation = ++twitchEventSubGeneration
  const isResume = url !== 'wss://eventsub.wss.twitch.tv/ws'
  const socket = new WebSocket(url)
  twitchEventSub = socket
  twitchEventSubReady = false
  socket.on('message', (data) => {
    if (generation !== twitchEventSubGeneration) return
    twitchLastEventSub = Date.now()
    let payload: any
    try { payload = JSON.parse(String(data)) } catch { return }
    const type = payload?.metadata?.message_type
    if (type === 'session_welcome') {
      twitchKeepaliveMs = Number(payload.payload?.session?.keepalive_timeout_seconds || 10) * 1000
      if (isResume) { twitchEventSubReady = true; console.log('Twitch EventSub resumed') }
      else {
        twitchEventSubSessionId = String(payload.payload.session.id || '')
        void subscribeTwitchEvents(twitchEventSubSessionId)
      }
    } else if (type === 'notification') {
      handleTwitchEventSub(payload)
    } else if (type === 'session_reconnect' && payload.payload?.session?.reconnect_url) {
      connectTwitchEventSub(payload.payload.session.reconnect_url)
    } else if (type === 'revocation') {
      console.error('Twitch EventSub revoked:', payload.payload?.subscription?.status)
      twitchEventSubReady = false
      connectTwitchIrc()
    }
  })
  socket.on('close', () => {
    if (generation !== twitchEventSubGeneration) return
    twitchEventSub = undefined
    twitchEventSubReady = false
    if (tokens.Twitch && !twitchEventSubUnsupported) setTimeout(() => connectTwitchEventSub(), 3_000)
  })
  socket.on('error', (error) => { console.error('Twitch EventSub:', error.message); socket.close() })
}

const twitchEventSubs: { type: string; version: string; condition: (userId: string) => Record<string, string>; activity?: boolean }[] = [
  { type: 'channel.chat.message', version: '1', condition: (userId) => ({ broadcaster_user_id: userId, user_id: userId }) },
  { type: 'channel.follow', version: '2', condition: (userId) => ({ broadcaster_user_id: userId, moderator_user_id: userId }), activity: true },
  { type: 'channel.subscribe', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true },
  { type: 'channel.subscription.gift', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true },
  { type: 'channel.subscription.message', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true },
  { type: 'channel.cheer', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true },
  { type: 'channel.raid', version: '1', condition: (userId) => ({ to_broadcaster_user_id: userId }), activity: true },
]

async function subscribeTwitchEvents(sessionId: string) {
  const token = await ensureToken('Twitch')
  if (!token?.userId) return
  const transport = { method: 'websocket', session_id: sessionId }
  let chatOk = false
  let activityFailed = false
  for (const spec of twitchEventSubs) {
    if (spec.activity && !settings.activityFallback) continue
    try {
      await twitchApi('/helix/eventsub/subscriptions', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: spec.type, version: spec.version, condition: spec.condition(token.userId), transport }),
      })
      if (spec.type === 'channel.chat.message') chatOk = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/409|already exists|Conflict/i.test(message)) {
        if (spec.type === 'channel.chat.message') chatOk = true
        continue
      }
      if (spec.activity) activityFailed = true
      else {
        console.error(`Twitch EventSub ${spec.type}:`, message)
        if (message.includes('403') || message.includes('401') || message.includes('scope')) {
          twitchEventSubUnsupported = true
          console.log('Twitch chat falling back to IRC. Reconnect Twitch in settings to grant user:read:chat if you want EventSub.')
        }
      }
    }
  }
  if (chatOk) {
    twitchEventSubReady = true
    twitchIrc?.close()
    setHealth('Twitch', 'ok')
    console.log(`Twitch EventSub connected (${token.user})`)
  } else connectTwitchIrc()
  if (activityFailed) {
    console.log('Twitch native alert backup needs a reconnect in settings (follow, sub, bits scopes).')
    setActivityWarning('twitch-scopes', 'Reconnect Twitch to enable native follow/sub/bits backup')
  } else setActivityWarning('twitch-scopes')
}

function handleTwitchEventSub(payload: any) {
  const type = String(payload?.metadata?.subscription_type || '')
  const event = payload?.payload?.event
  if (type === 'channel.chat.message') {
    addMessage({
      id: event?.message_id || crypto.randomUUID(),
      platform: 'Twitch',
      user: event?.chatter_user_name || event?.chatter_user_login || 'Twitch user',
      userId: event?.chatter_user_id ? String(event.chatter_user_id) : undefined,
      color: event?.color || undefined,
      badges: twitchBadgesFromList(event?.badges, twitchBadgeUrls),
      avatar: normalizeAvatar(twitchAvatars.get(String(event?.chatter_user_id || ''))),
      text: event?.message?.text || '',
      time: new Date().toISOString(),
      parts: partsFromTwitchFragments(event?.message?.fragments, event?.message?.text || ''),
      emotes: (event?.message?.fragments || []).filter((item: any) => item.type === 'emote').map((item: any) => item.emote?.id).filter(Boolean),
    })
    setHealth('Twitch', 'ok')
    return
  }
  const activity = twitchEventToActivity(type, event)
  if (activity) addNativeActivity(activity)
}

function watchTwitchEventSub() {
  if (!twitchEventSub || !twitchLastEventSub) return
  if (Date.now() - twitchLastEventSub > twitchKeepaliveMs + 2_000) twitchEventSub.close()
}

function setHealth(platform: Platform, status: Health['status'], message = '') {
  const current = state.health[platform]
  if (current.status === status && current.message === message) return
  state.health[platform] = { status, message }
  broadcast()
}

function ensureTwitchChat() {
  if (!tokens.Twitch) return
  if (twitchEventSubReady) return
  if (twitchIrc && twitchIrc.readyState === WebSocket.OPEN) return
  if (twitchIrc) {
    try { twitchIrc.close() } catch { twitchIrc = undefined; twitchIrcReady = false; connectTwitchIrc(); return }
  }
  connectTwitchIrc()
}

function refreshChatHealth() {
  if (tokens.Twitch) {
    if (twitchEventSubReady || twitchIrcReady) { if (state.health.Twitch.status === 'down') setHealth('Twitch', 'ok') }
    else setHealth('Twitch', 'down', 'Twitch chat disconnected — messages may be missing')
    if (!twitchEventSubReady) ensureTwitchChat()
  }
  if (tokens.Kick) {
    if (kickChat.connected) { if (state.health.Kick.status === 'down') setHealth('Kick', 'ok') }
    else setHealth('Kick', 'down', 'Kick chat disconnected — messages may be missing')
  }
  if (tokens.YouTube) {
    const account = state.accounts.find((item) => item.platform === 'YouTube')
    const quota = youtubeQuotaHealth()
    if (quota && (youtubeQuotaBlocked() || youtubeQuotaUsed >= youtubeQuotaLimit)) setHealth('YouTube', quota.status, quota.message)
    else if (account?.live && youtubeChat.failed) setHealth('YouTube', 'warn', 'YouTube site chat failed — using slow API fallback')
    else if (quota) setHealth('YouTube', quota.status, quota.message)
    else if (youtubeChat.connected) { if (state.health.YouTube.status === 'down' || /quota/i.test(state.health.YouTube.message)) setHealth('YouTube', 'ok') }
    else if (account?.live && !youtubeLiveChatIds().length) setHealth('YouTube', 'down', 'YouTube is live but chat is unavailable')
  }
}

function connectTwitchIrc() {
  if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady) return
  void ensureToken('Twitch').then(() => {
    if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady) return
    openTwitchIrc()
  })
}

function openTwitchIrc() {
  if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady) return
  const nick = tokens.Twitch.user.toLowerCase()
  twitchIrcReady = false
  twitchIrc = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
  twitchIrc.on('open', () => {
    const token = tokens.Twitch
    if (!token || !twitchIrc) return
    twitchIrc.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n')
    twitchIrc.send(`PASS oauth:${token.accessToken}\r\n`)
    twitchIrc.send(`NICK ${nick}\r\n`)
  })
  twitchIrc.on('message', (data) => {
    const raw = String(data)
    if (raw.includes('NOTICE * :Login authentication failed') || raw.includes('NOTICE * :Improperly formatted auth')) {
      console.error('Twitch IRC authentication failed; reconnect Twitch to refresh its token and chat scopes.')
      setHealth('Twitch', 'down', 'Twitch chat login failed — reconnect Twitch in settings')
      void refreshAccessToken('Twitch').then(() => twitchIrc?.close())
      return
    }
    if (raw.includes(' 001 ')) {
      twitchIrc?.send(`JOIN #${nick}\r\n`)
      console.log(`Twitch IRC connected as ${nick}`)
    }
    if (raw.includes(' 366 ')) {
      twitchIrcReady = true
      setHealth('Twitch', 'ok')
      console.log(`Twitch IRC joined #${nick}`)
    }
    parseTwitchLines(raw).forEach((message) => addMessage(message))
  })
  twitchIrc.on('close', () => {
    twitchIrc = undefined
    twitchIrcReady = false
    if (tokens.Twitch && !twitchEventSubReady) setTimeout(connectTwitchIrc, 5_000)
  })
  twitchIrc.on('error', (error) => {
    if (!/closed before the connection was established/i.test(error.message)) console.error('Twitch IRC:', error.message)
    twitchIrc?.close()
  })
}

function parseTwitchLines(raw: string): ChatMessage[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    const parsed = parseTwitchChatLine(line, { urls: twitchBadgeUrls })
    if (parsed === 'ping') { twitchIrc?.send('PONG :tmi.twitch.tv\r\n'); return [] }
    if (!parsed) return []
    return [{ ...parsed, avatar: parsed.userId ? twitchAvatars.get(parsed.userId) : undefined }]
  })
}

async function ensureTwitchBadges() {
  const token = await ensureToken('Twitch')
  if (!token?.userId || twitchBadgesLoaded) return
  try {
    const [globalBadges, channelBadges] = await Promise.all([
      twitchApi('/helix/chat/badges/global', token),
      twitchApi(`/helix/chat/badges?broadcaster_id=${token.userId}`, token),
    ])
    twitchBadgeUrls.clear()
    for (const set of [...(globalBadges.data || []), ...(channelBadges.data || [])]) {
      for (const version of set.versions || []) {
        twitchBadgeUrls.set(`${set.set_id}/${version.id}`, version.image_url_2x || version.image_url_1x)
      }
    }
    twitchBadgesLoaded = true
  } catch (error) {
    console.error('Twitch badges:', error instanceof Error ? error.message : error)
  }
}

function queueTwitchAvatar(userId?: string) {
  if (!userId || twitchAvatars.has(userId) || twitchAvatarPending.has(userId)) return
  twitchAvatarPending.add(userId)
  if (twitchAvatarTimer) clearTimeout(twitchAvatarTimer)
  twitchAvatarTimer = setTimeout(() => { void flushTwitchAvatars() }, 400)
}

async function flushTwitchAvatars() {
  const token = await ensureToken('Twitch')
  if (!token) return
  const ids = [...twitchAvatarPending].slice(0, 80)
  ids.forEach((id) => twitchAvatarPending.delete(id))
  if (!ids.length) return
  try {
    const result = await twitchApi(`/helix/users?${ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`, token)
    for (const user of result.data || []) {
      const avatar = normalizeAvatar(user.profile_image_url)
      if (user.id && avatar) twitchAvatars.set(String(user.id), avatar)
    }
    let changed = false
    state.messages = state.messages.map((item) => {
      if (item.platform !== 'Twitch' || !item.userId) return item
      const avatar = twitchAvatars.get(item.userId)
      if (!avatar || item.avatar === avatar) return item
      changed = true
      return { ...item, avatar }
    })
    if (changed) {
      persistChat()
      broadcast()
    }
  } catch (error) {
    console.error('Twitch avatars:', error instanceof Error ? error.message : error)
  }
  if (twitchAvatarPending.size) queueTwitchAvatar([...twitchAvatarPending][0])
}

function rememberOutgoing(entry: { id: string; text: string; platforms: Platform[]; at: number }) {
  const cutoff = Date.now() - 20_000
  for (let index = recentOutgoing.length - 1; index >= 0; index--) if (recentOutgoing[index].at < cutoff) recentOutgoing.splice(index, 1)
  recentOutgoing.push(entry)
}

function ownHandles() {
  const names = new Set<string>(['you'])
  for (const platform of ['Twitch', 'Kick', 'YouTube'] as Platform[]) {
    const user = tokens[platform]?.user
    if (user) names.add(user.toLowerCase())
  }
  for (const account of state.accounts) if (account.handle) names.add(account.handle.toLowerCase())
  return names
}

const translationCache = new Map<string, string>()
const translateQueue: ChatMessage[] = []
let translating = false
async function translateToEnglish(text: string) {
  const key = text.trim()
  if (!key || !needsTranslation(key)) return
  const cached = translationCache.get(key)
  if (cached) return cached
  const response = await fetchTimed(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(key.slice(0, 500))}`, { headers: { Accept: 'application/json' } }, 6_000)
  if (!response.ok) return
  const data = await response.json() as any
  const translated = Array.isArray(data?.[0]) ? data[0].map((row: any) => String(row?.[0] || '')).join('').trim() : ''
  if (!translated || translated === key) return
  translationCache.set(key, translated)
  if (translationCache.size > 2_000) {
    const oldest = translationCache.keys().next().value
    if (oldest) translationCache.delete(oldest)
  }
  return translated
}

async function applyTranslation(message: ChatMessage) {
  const parts = message.parts?.length ? message.parts : (message.text ? [{ type: 'text' as const, text: message.text }] : [])
  let changed = false
  const next: MessagePart[] = []
  for (const part of parts) {
    if (part.type !== 'text' || !needsTranslation(part.text)) { next.push(part); continue }
    try {
      const translated = await translateToEnglish(part.text)
      if (translated) { next.push({ type: 'text', text: translated }); changed = true }
      else next.push(part)
    } catch { next.push(part) }
  }
  if (!changed) return
  const index = state.messages.findIndex((item) => item.id === message.id)
  if (index < 0) return
  const current = state.messages[index]
  const text = next.filter((part) => part.type === 'text').map((part) => part.text).join('') || current.text
  state.messages = state.messages.map((item, itemIndex) => itemIndex === index ? { ...item, text, parts: next, originalText: current.originalText || current.text } : item)
  persistChat()
  broadcast()
}

function queueTranslation(message: ChatMessage) {
  const source = message.parts?.some((part) => part.type === 'text' && needsTranslation(part.text)) || needsTranslation(message.text)
  if (!source) return
  translateQueue.push(message)
  void drainTranslations()
}

async function drainTranslations() {
  if (translating) return
  translating = true
  while (translateQueue.length) {
    const batch = translateQueue.splice(0, 3)
    await Promise.all(batch.map((item) => applyTranslation(item)))
  }
  translating = false
}

function ingestYouTubeOfficialItem(item: any, chatId: string, chatIds: string[], preload = false) {
  const user = String(item.authorDetails?.displayName || 'YouTube user').replace(/^@+/, '')
  const time = item.snippet?.publishedAt || new Date().toISOString()
  const activity = youtubeOfficialToActivity(item)
  if (activity) addNativeActivity(activity)
  if (preload) beginYouTubeHydration()
  addMessage({
    id: item.id,
    platform: 'YouTube',
    user,
    userId: item.authorDetails?.channelId,
    avatar: normalizeAvatar(item.authorDetails?.profileImageUrl),
    badges: youtubeBadges(item.authorDetails),
    sourceId: chatId,
    sourceLabel: chatIds.length > 1 ? youtubeChatLabels.get(chatId) : undefined,
    text: item.snippet?.textMessageDetails?.messageText || item.snippet?.displayMessage || '',
    time,
  }, { preload, ingest: 'official' })
}

function addActivity(event: ActivityEvent) {
  if (!activityStore.add(event)) return
  state.activity = activityStore.list()
  broadcast()
}

function addNativeActivity(event: ActivityEvent) {
  if (!settings.activityFallback) return
  addActivity(event)
}

function streamElementsJwtSlots() {
  return [
    { platform: 'Twitch', jwt: String(process.env.STREAMELEMENTS_JWT_TWITCH || '').trim() },
    { platform: 'Kick', jwt: String(process.env.STREAMELEMENTS_JWT_KICK || '').trim() },
    { platform: 'YouTube', jwt: String(process.env.STREAMELEMENTS_JWT_YOUTUBE || '').trim() },
  ]
}

function setActivityWarning(key: string, message?: string) {
  if (message) activityWarnings.set(key, message)
  else activityWarnings.delete(key)
  const next = [...activityWarnings.values()]
  if (next.length === state.activityWarnings.length && next.every((item, index) => item === state.activityWarnings[index])) return
  state.activityWarnings = next
  broadcast()
}

async function startStreamElements(backfill = false) {
  const slots = streamElementsJwtSlots()
  const missing = slots.filter((slot) => !slot.jwt).map((slot) => slot.platform)
  const jwts = [...new Set(slots.map((slot) => slot.jwt).filter(Boolean))]
  const missingNote = missingStreamElementsMessage(missing)
  if (!jwts.length) {
    state.streamelements = { connected: false, handle: '', missing }
    setActivityWarning('streamelements', settings.ignoreMissingJwt ? undefined : missingNote)
    return
  }
  const channels = []
  for (const jwt of jwts) {
    try {
      channels.push(await hydrateStreamElements(jwt))
    } catch (error) {
      console.error('StreamElements JWT failed:', error instanceof Error ? error.message : error)
    }
  }
  if (!channels.length) {
    state.streamelements = { connected: false, handle: '', missing: missing.length ? missing : ['Twitch', 'Kick', 'YouTube'] }
    setActivityWarning('streamelements', 'StreamElements JWTs failed to load. Check production.env, then restart.')
    console.error('StreamElements JWTs failed to load. Check production.env, then restart.')
    return
  }
  const handle = channels.map((channel) => channel.provider ? `${channel.handle} (${channel.provider})` : channel.handle).join(', ')
  state.streamelements = { connected: true, handle, missing }
  setActivityWarning('streamelements', settings.ignoreMissingJwt ? undefined : missingNote)
  await streamElements.start(channels, (event) => addActivity(event), (message) => setActivityWarning('streamelements-live', message))
  console.log(`StreamElements connected (${handle})`)
  if (backfill) {
    for (const channel of channels) {
      const events = await fetchRecentActivities(channel)
      for (const event of events) addActivity(event)
    }
  }
}

function addMessage(message: ChatMessage, options?: { preload?: boolean; ingest?: 'official' | 'innertube' }) {
  const result = mergeIncomingChat(state.messages, message, options, {
    ownHandles: ownHandles(),
    recentOutgoing,
    targets: youtubeTargets,
  })
  for (const id of result.seenIds) youtubeSeen.add(id)
  if (!result.changed) return
  state.messages = result.messages
  persistChat()
  broadcast()
  if (result.added) {
    queueTranslation(result.added)
    if (result.added.platform === 'Twitch') queueTwitchAvatar(result.added.userId)
  }
}

async function pollLiveState() {
  const twitchAccount = state.accounts.find((item) => item.platform === 'Twitch')
  const kickAccount = state.accounts.find((item) => item.platform === 'Kick')
  const twitchWasLive = Boolean(twitchAccount?.live)
  const kickWasLive = Boolean(kickAccount?.live)
  if (tokens.Twitch) try { await pollTwitch(); if (state.health.Twitch.status === 'warn') setHealth('Twitch', twitchEventSubReady || twitchIrcReady ? 'ok' : 'down', twitchEventSubReady || twitchIrcReady ? '' : 'Twitch chat disconnected — messages may be missing') } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Twitch poll:', message)
    if (state.health.Twitch.status !== 'down') setHealth('Twitch', twitchEventSubReady || twitchIrcReady ? 'warn' : 'down', twitchEventSubReady || twitchIrcReady ? 'Twitch status poll failed' : `Twitch poll failed — messages may be missing`)
    ensureTwitchChat()
  }
  if (twitchWasLive && !twitchAccount?.live) youtubeForceStatus = true
  if (tokens.YouTube) try { await pollYouTube(); if (youtubeChat.connected && state.health.YouTube.status === 'warn' && !youtubeQuotaBlocked()) setHealth('YouTube', 'ok') } catch (error) {
    if (noteYouTubeQuota(error)) { /* site chat continues */ }
    else {
      const message = error instanceof Error ? error.message : String(error)
      console.error('YouTube poll:', message)
      if (!youtubeChat.connected) setHealth('YouTube', 'warn', 'YouTube poll failed — chat or counts may be stale')
    }
  }
  if (tokens.Kick) try { await pollKick(); if (kickChat.connected) setHealth('Kick', 'ok'); else if (tokens.Kick) setHealth('Kick', 'down', 'Kick chat disconnected — messages may be missing') } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Kick poll:', message)
    if (!kickChat.connected) setHealth('Kick', 'down', 'Kick poll failed — messages may be missing')
    else setHealth('Kick', 'warn', 'Kick status poll failed')
  }
  if (kickWasLive && !kickAccount?.live) youtubeForceStatus = true
  persistStreamInfo()
  refreshChatHealth()
  broadcast()
}

async function pollTwitch() {
  const token = await ensureToken('Twitch')
  if (!token) return
  const streams = await twitchApi(`/helix/streams?user_id=${token.userId}`, token)
  const account = state.accounts.find((item) => item.platform === 'Twitch')!
  const stream = streams.data?.[0]
  Object.assign(account, { live: Boolean(stream), viewers: stream?.viewer_count || 0, handle: token.user || account.handle })
  if (stream) {
    state.streamInfo.Twitch = applyLiveStreamDetails(state.streamInfo.Twitch, { title: stream.title || '', category: stream.game_name || '', categoryId: stream.game_id || undefined })
  } else {
    const channel = await twitchApi(`/helix/channels?broadcaster_id=${token.userId}`, token)
    const info = channel.data?.[0]
    if (info) state.streamInfo.Twitch = applyLiveStreamDetails(state.streamInfo.Twitch, { title: info.title || '', category: info.game_name || '', categoryId: info.game_id || undefined })
  }
  void ensureTwitchBadges()
  ensureTwitchChat()
}

function ingestYouTubeInnerMessage(message: YouTubeChatMessage, target: YouTubeChatTarget) {
  if (youtubeSeen.has(message.id)) return
  youtubeSeen.add(message.id)
  const multi = youtubeTargets.length > 1
  if (message.activityKind) {
    addNativeActivity({
      id: message.id,
      platform: 'YouTube',
      kind: message.activityKind,
      user: message.user,
      userId: message.userId,
      amount: message.amount,
      message: message.activityKind === 'superchat' ? message.text.replace(/^\[.*?\]\s*/, '') : message.text,
      time: message.time,
    })
  }
  if (message.preload) beginYouTubeHydration()
  addMessage({
    id: message.id,
    platform: 'YouTube',
    user: message.user,
    userId: message.userId,
    avatar: normalizeAvatar(message.avatar),
    badges: message.badges,
    sourceId: target.liveChatId || message.videoId,
    sourceLabel: multi ? target.label : undefined,
    text: message.text,
    time: message.time,
    parts: message.parts,
  }, { preload: Boolean(message.preload), ingest: 'innertube' })
}

async function pollYouTube() {
  const token = await ensureToken('YouTube')
  if (!token) return
  const account = state.accounts.find((item) => item.platform === 'YouTube')
  const live = Boolean(account?.live || youtubeChat.connected || youtubeTargets.length)
  if (live && youtubeChat.failed) youtubeForceStatus = true
  const interval = live ? YOUTUBE_STATUS_LIVE_MS : YOUTUBE_STATUS_SEEK_MS
  const statusDue = youtubeForceStatus || !lastYouTubeStatusAt || Date.now() - lastYouTubeStatusAt >= interval
  if (statusDue) {
    youtubeForceStatus = false
    lastYouTubeStatusAt = Date.now()
    if (youtubeQuotaBlocked()) await discoverYouTubeLive(token)
    else {
      try { await pollYouTubeStatus(token) }
      catch (error) {
        if (noteYouTubeQuota(error)) await discoverYouTubeLive(token)
        else throw error
      }
    }
  }
  await syncYouTubeChat(token)
  await seedYouTubeHistory(token)
  await refreshYouTubeViewers()
}

async function pollYouTubeStatus(token: Token) {
  const account = state.accounts.find((item) => item.platform === 'YouTube')!
  let broadcasts: any
  try {
    broadcasts = await youtubeApi('/liveBroadcasts?part=snippet,contentDetails,status&broadcastStatus=active&broadcastType=all&maxResults=10', token)
  } catch (error) {
    if (noteYouTubeQuota(error)) throw error
    broadcasts = await youtubeApi('/liveBroadcasts?part=snippet,contentDetails,status&mine=true&maxResults=10', token)
  }
  const liveItems = (broadcasts.items || []).filter((item: any) => item.status?.lifeCycleStatus === 'live')
  if (!youtubeQuotaBlocked() && (looksLikePlaceholder(token.user || '') || token.user === 'YouTube' || !token.channelId)) {
    try { await hydrateYouTubeToken(token); saveTokens() } catch (error) { if (!noteYouTubeQuota(error)) console.error('YouTube profile:', error instanceof Error ? error.message : error) }
  }
  const previous = youtubeTargets
  const next = liveItems.map((item: any) => {
    const chatId = item.snippet?.liveChatId || item.contentDetails?.activeLiveChatId
    const videoId = String(item.id)
    const existing = previous.find((target) => target.videoId === videoId)
    return {
      videoId,
      liveChatId: chatId ? String(chatId) : undefined,
      title: String(item.snippet?.title || existing?.title || ''),
    }
  }).filter((item: YouTubeChatTarget) => item.videoId)
  setYouTubeTargets(next)
  Object.assign(account, { live: liveItems.length > 0, handle: token.user && !looksLikePlaceholder(token.user) ? token.user : account.handle, ...(liveItems.length ? {} : { viewers: 0 }) })
  if (liveItems.length) {
    const labels = youtubeTargets.map((target) => target.label).filter(Boolean)
    console.log(`YouTube lives: ${liveItems.length} chat(s)${labels.length ? ` (${labels.join(', ')})` : ''}`)
  }
  if (!youtubeTargets.length) {
    youtubeHistorySeeded.clear()
    await youtubeChat.stop()
  }
  lastYouTubeViewersAt = 0
}

async function discoverYouTubeLive(token: Token) {
  const account = state.accounts.find((item) => item.platform === 'YouTube')!
  const found = await youtubeChat.discoverLive({ channelId: token.channelId, handle: token.user })
  if (!found) {
    if (!youtubeChat.connected) {
      setYouTubeTargets([])
      youtubeHistorySeeded.clear()
      await youtubeChat.stop()
      Object.assign(account, { live: false, viewers: 0, handle: token.user && !looksLikePlaceholder(token.user) ? token.user : account.handle })
    }
    return
  }
  const existing = youtubeTargets.find((item) => item.videoId === found.videoId)
  if (!existing) setYouTubeTargets([{ videoId: found.videoId, liveChatId: token.liveChatId, title: found.title }])
  Object.assign(account, { live: true, handle: token.user && !looksLikePlaceholder(token.user) ? token.user : account.handle, ...(Number.isFinite(found.viewers) ? { viewers: found.viewers } : {}) })
  lastYouTubeViewersAt = 0
}

async function refreshYouTubeViewers() {
  if (!youtubeTargets.length) return
  if (lastYouTubeViewersAt && Date.now() - lastYouTubeViewersAt < YOUTUBE_VIEWERS_MS) return
  lastYouTubeViewersAt = Date.now()
  const pages = await Promise.all(youtubeTargets.map(async (target) => ({ target, info: await youtubeChat.pageInfo(target.videoId) })))
  const previousLabels = youtubeTargets.map((target) => `${target.videoId}:${target.label || ''}`).join(',')
  for (const { target, info } of pages) {
    if (info?.title) target.title = info.title
  }
  relabelYouTubeTargets()
  const labelsChanged = youtubeTargets.map((target) => `${target.videoId}:${target.label || ''}`).join(',') !== previousLabels
  if (labelsChanged) {
    const labels = youtubeTargets.map((target) => target.label).filter(Boolean)
    if (labels.length) console.log(`YouTube chats: ${labels.join(', ')}`)
    retagYouTubeMessages()
    await youtubeChat.start(youtubeTargets, ingestYouTubeInnerMessage)
  }
  const counts = pages.map((item) => item.info?.viewers).filter((count): count is number => Number.isFinite(count))
  if (!counts.length) return
  const viewers = counts.reduce((total, count) => total + count, 0)
  const account = state.accounts.find((item) => item.platform === 'YouTube')
  if (!account) return
  if (account.viewers === viewers && account.live && !labelsChanged) return
  Object.assign(account, { live: true, viewers })
}

async function seedYouTubeHistory(token: Token) {
  if (youtubeQuotaBlocked()) return
  const chatIds = youtubeLiveChatIds()
  if (youtubeChat.connected) {
    for (const chatId of chatIds) youtubeHistorySeeded.add(chatId)
    collapseYouTubeHydrationDuplicates()
    return
  }
  const pending = chatIds.filter((chatId) => !youtubeHistorySeeded.has(chatId))
  if (!pending.length) return
  for (const chatId of pending) {
    youtubeHistorySeeded.add(chatId)
    beginYouTubeHydration()
    try {
      const messages = await youtubeApi(`/liveChat/messages?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails&maxResults=200`, token)
      for (const item of messages.items || []) if (!youtubeSeen.has(item.id)) {
        youtubeSeen.add(item.id)
        ingestYouTubeOfficialItem(item, chatId, chatIds, true)
      }
    } catch (error) {
      if (noteYouTubeQuota(error)) return
      if (isEndedYouTubeChat(error)) {
        console.log('YouTube history seed skipped: live chat ended')
        dropEndedYouTubeChat(chatId)
        continue
      }
      youtubeHistorySeeded.delete(chatId)
      console.error('YouTube history seed:', error instanceof Error ? error.message : error)
    }
  }
  collapseYouTubeHydrationDuplicates()
}

async function syncYouTubeChat(token: Token) {
  if (!youtubeTargets.length) {
    await youtubeChat.stop()
    return
  }
  beginYouTubeHydration()
  await youtubeChat.start(youtubeTargets, ingestYouTubeInnerMessage)
  if (youtubeChat.connected || !youtubeChat.failed) return
  if (youtubeQuotaBlocked()) {
    setHealth('YouTube', 'warn', 'YouTube site chat failed and API quota is exhausted')
    return
  }
  if (Date.now() - lastYouTubeOfficialChatAt < YOUTUBE_OFFICIAL_CHAT_MS) return
  lastYouTubeOfficialChatAt = Date.now()
  await pollYouTubeOfficialChat(token)
}

async function pollYouTubeOfficialChat(token: Token) {
  const chatIds = youtubeLiveChatIds()
  if (!chatIds.length) return
  setHealth('YouTube', 'warn', 'YouTube site chat failed — using slow API fallback')
  for (const chatId of chatIds) {
    try {
      const messages = await youtubeApi(`/liveChat/messages?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails`, token)
      for (const item of messages.items || []) if (!youtubeSeen.has(item.id)) {
        youtubeSeen.add(item.id)
        ingestYouTubeOfficialItem(item, chatId, chatIds)
      }
    } catch (error) {
      if (noteYouTubeQuota(error)) return
      if (isEndedYouTubeChat(error)) {
        dropEndedYouTubeChat(chatId)
        continue
      }
      console.error('YouTube chat poll:', error instanceof Error ? error.message : error)
    }
  }
}

function relabelYouTubeTargets() {
  youtubeChatLabels.clear()
  for (const target of youtubeTargets) {
    target.label = youtubeChatLabel(youtubeTargets, target)
    if (target.liveChatId && target.label) youtubeChatLabels.set(target.liveChatId, target.label)
  }
}

function youtubeSourceLabel(sourceId?: string) {
  if (!sourceId || youtubeTargets.length <= 1) return
  const target = youtubeTargets.find((item) => item.liveChatId === sourceId || item.videoId === sourceId)
  return target?.label || youtubeChatLabels.get(sourceId)
}

function retagYouTubeMessages() {
  let changed = false
  const next = state.messages.map((message) => {
    const youtube = message.platform === 'YouTube' || (message.platforms || []).includes('YouTube')
    if (!youtube) return message
    const label = youtubeSourceLabel(message.sourceId)
    if (!label || message.sourceLabel === label) return message
    changed = true
    return { ...message, sourceLabel: label }
  })
  if (!changed) return false
  state.messages = next
  persistChat()
  return true
}

function youtubeLiveChatIds() {
  return resolveYouTubeLiveChatIds(youtubeTargets, tokens.YouTube)
}

function setYouTubeTargets(targets: YouTubeChatTarget[]) {
  youtubeTargets = targets
  relabelYouTubeTargets()
  retagYouTubeMessages()
  collapseYouTubeHydrationDuplicates()
  if (tokens.YouTube) syncYouTubeTokenChatIds(targets, tokens.YouTube)
}

async function pollKick() {
  const token = await ensureToken('Kick')
  if (!token) return
  const response = await kickApi('/channels', token)
  if (!response.ok) {
    if (response.status === 401) await refreshAccessToken('Kick')
    return
  }
  const payload = await response.json() as any
  const channel = payload.data?.[0]
  const account = state.accounts.find((item) => item.platform === 'Kick')!
  const slug = channel?.slug || (!looksLikePlaceholder(token.user || '') ? token.user : '')
  if (slug && token.user !== slug) {
    token.user = slug
    saveTokens()
  }
  if (channel?.broadcaster_user_id && token.userId !== String(channel.broadcaster_user_id)) {
    token.userId = String(channel.broadcaster_user_id)
    saveTokens()
  }
  Object.assign(account, { live: Boolean(channel?.stream?.is_live), viewers: Number(channel?.stream?.viewer_count || 0), handle: slug || account.handle })
  if (channel) state.streamInfo.Kick = applyLiveStreamDetails(state.streamInfo.Kick, kickStreamDetails(channel))
  if (slug) startKickChat(slug)
  else await kickChat.stop()
}

async function sendMessage(platform: Platform, text: string) {
  if (!tokens[platform]) return { platform, ok: false, error: 'Not connected' }
  try {
    if (platform === 'Twitch') return { platform, ...(await sendTwitchMessage(text)) }
    if (platform === 'Kick') return { platform, ...(await sendKickMessage(text)) }
    if (platform === 'YouTube') return { platform, ...(await sendYouTubeMessage(text)) }
  } catch (error) {
    return { platform, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { platform, ok: false, error: `${platform} chat is not live or its API adapter is unavailable` }
}

async function sendTwitchMessage(text: string) {
  const nick = tokens.Twitch?.user?.toLowerCase()
  if (twitchIrc?.readyState === WebSocket.OPEN && twitchIrcReady && nick) {
    twitchIrc.send(`PRIVMSG #${nick} :${text}\r\n`)
    return { ok: true }
  }
  const helix = await sendTwitchHelix(text)
  if (helix.ok) return helix
  await waitForTwitchIrc()
  if (twitchIrc?.readyState === WebSocket.OPEN && twitchIrcReady && nick) {
    twitchIrc.send(`PRIVMSG #${nick} :${text}\r\n`)
    return { ok: true }
  }
  return { ok: false, error: helix.error || 'Twitch chat is not ready; reconnect Twitch and try again' }
}

async function sendTwitchHelix(text: string) {
  const token = await ensureToken('Twitch')
  if (!token?.userId) return { ok: false, error: 'Twitch user id missing' }
  try {
    const result = await twitchApi('/helix/chat/messages', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcaster_id: token.userId, sender_id: token.userId, message: text }),
    })
    if (result.data?.[0]?.is_sent === false) return { ok: false, error: result.data[0].drop_reason?.message || 'Twitch dropped the message' }
    return { ok: true, id: result.data?.[0]?.message_id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function sendKickMessage(text: string) {
  const token = await ensureToken('Kick')
  if (!token) return { ok: false, error: 'Not connected' }
  const response = await kickApi('/chat', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, type: 'user', ...(token.userId ? { broadcaster_user_id: Number(token.userId) } : {}) }),
  })
  if (response.ok) return { ok: true }
  return { ok: false, error: await response.text() }
}

async function sendYouTubeMessage(text: string) {
  if (youtubeQuotaBlocked()) return { ok: false, error: 'YouTube API quota exceeded until midnight Pacific' }
  const token = await ensureToken('YouTube')
  if (!token) return { ok: false, error: 'Not connected' }
  let chatIds = youtubeLiveChatIds()
  if (!chatIds.length) {
    try {
      youtubeForceStatus = true
      await pollYouTubeStatus(token)
    } catch (error) {
      if (noteYouTubeQuota(error)) return { ok: false, error: 'YouTube API quota exceeded until midnight Pacific' }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    chatIds = youtubeLiveChatIds()
  }
  const guard = youtubeSendGuard({ connected: true, quotaBlocked: false, chatIds })
  if (guard.ok === false) return guard
  const results = await Promise.all(chatIds.map((liveChatId) => youtubeRequest('/liveChat/messages?part=snippet', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(youtubeLiveChatMessageBody(liveChatId, text)),
  })))
  const failed = results.filter((result) => !result.ok)
  return { ok: results.some((result) => result.ok), error: failed.length ? failed.map((result) => youtubeApiErrorReason(result.text)).join(' | ') : undefined }
}

async function moderate(platform: Platform, body: { action: string; messageId?: string; userId?: string; sourceId?: string; duration?: number }) {
  if (!tokens[platform]) return { ok: false, error: 'Not connected' }
  if (platform === 'Twitch') return moderateTwitch(body)
  if (platform === 'Kick') return moderateKick(body)
  if (platform === 'YouTube') return moderateYouTube(body)
  return { ok: false, error: `${platform} moderation is not available` }
}

async function moderateTwitch(body: { action: string; messageId?: string; userId?: string; duration?: number }) {
  const token = await ensureToken('Twitch')
  if (!token?.userId) return { ok: false, error: 'Twitch is not connected' }
  const id = token.userId
  if (body.action === 'delete') {
    if (!body.messageId) return { ok: false, error: 'Message id is required' }
    await twitchApi(`/helix/moderation/chat?broadcaster_id=${id}&moderator_id=${id}&message_id=${encodeURIComponent(body.messageId)}`, token, { method: 'DELETE' })
    return { ok: true }
  }
  if (!body.userId) return { ok: false, error: 'User id is required' }
  const data: { user_id: string; duration?: number; reason: string } = { user_id: body.userId, reason: 'Relayed from OBS dock' }
  if (body.action === 'timeout') data.duration = Math.max(1, Number(body.duration || 60))
  await twitchApi(`/helix/moderation/bans?broadcaster_id=${id}&moderator_id=${id}`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  return { ok: true }
}

async function moderateKick(body: { action: string; messageId?: string; userId?: string; duration?: number }) {
  const token = await ensureToken('Kick')
  if (!token?.userId) return { ok: false, error: 'Kick is not connected' }
  if (body.action === 'delete') {
    if (!body.messageId) return { ok: false, error: 'Message id is required' }
    const response = await kickApi(`/chat/${encodeURIComponent(body.messageId)}`, token, { method: 'DELETE' })
    if (!response.ok) return { ok: false, error: await response.text() }
    return { ok: true }
  }
  if (!body.userId) return { ok: false, error: 'User id is required' }
  const payload: { broadcaster_user_id: number; user_id: number; duration?: number; reason: string } = {
    broadcaster_user_id: Number(token.userId),
    user_id: Number(body.userId),
    reason: 'Relayed from OBS dock',
  }
  if (body.action === 'timeout') payload.duration = Math.max(1, Math.round(Number(body.duration || 60) / 60) || 1)
  const response = await kickApi('/moderation/bans', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (!response.ok) return { ok: false, error: await response.text() }
  return { ok: true }
}

async function moderateYouTube(body: { action: string; messageId?: string; userId?: string; sourceId?: string; duration?: number }) {
  if (youtubeQuotaBlocked()) return { ok: false, error: 'YouTube API quota exceeded until midnight Pacific' }
  const token = await ensureToken('YouTube')
  if (!token) return { ok: false, error: 'YouTube is not connected' }
  if (body.action === 'delete') {
    if (!body.messageId) return { ok: false, error: 'Message id is required' }
    const result = await youtubeRequest(`/liveChat/messages?id=${encodeURIComponent(body.messageId)}`, token, { method: 'DELETE' })
    if (!result.ok) return { ok: false, error: youtubeApiErrorReason(result.text) }
    return { ok: true }
  }
  const chatIds = [...new Set([body.sourceId, ...youtubeLiveChatIds()].filter(Boolean))] as string[]
  if (!body.userId || !chatIds.length) return { ok: false, error: 'YouTube user or live chat is missing' }
  const results = await Promise.all(chatIds.map((liveChatId) => youtubeRequest('/liveChat/bans?part=snippet', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snippet: {
        liveChatId,
        type: body.action === 'timeout' ? 'temporary' : 'permanent',
        ...(body.action === 'timeout' ? { banDurationSeconds: Math.max(1, Number(body.duration || 60)) } : {}),
        bannedUserDetails: { channelId: body.userId },
      },
    }),
  })))
  const failed = results.filter((result) => !result.ok)
  return { ok: results.some((result) => result.ok), error: failed.length ? failed.map((result) => result.text).join(' | ') : undefined }
}

async function waitForTwitchIrc() {
  if (!twitchIrc && !twitchEventSubReady) connectTwitchIrc()
  for (let attempt = 0; attempt < 40 && (!twitchIrc || twitchIrc.readyState !== WebSocket.OPEN || !twitchIrcReady); attempt++) {
    if (twitchEventSubReady) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function kickApi(endpoint: string, token = tokens.Kick!, options: RequestInit = {}, retried = false) {
  const current = token || await ensureToken('Kick')
  if (!current) throw new Error('Kick is not connected')
  const base = process.env.KICK_API_BASE || 'https://api.kick.com/public/v1'
  const response = await fetchTimed(`${base}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${current.accessToken}`, Accept: 'application/json', ...options.headers },
  })
  if (response.status === 401 && !retried) {
    const refreshed = await refreshAccessToken('Kick')
    if (refreshed) return kickApi(endpoint, refreshed, options, true)
  }
  return response
}

async function searchCategories(platform: StreamPlatform, query: string) {
  if (platform === 'Twitch') {
    const token = await ensureToken('Twitch')
    const result = await twitchApi(`/helix/search/categories?query=${encodeURIComponent(query)}`, token!)
    return (result.data || []).map((item: any) => ({ id: String(item.id), name: item.name }))
  }
  const response = await kickApi(`/categories?q=${encodeURIComponent(query)}&page=1`)
  if (!response.ok) throw new Error(`Kick categories ${response.status}: ${await response.text()}`)
  const result = await response.json() as any
  return (result.data || []).map((item: any) => ({ id: String(item.id), name: item.name }))
}

async function updateStreamInfo(platform: StreamPlatform, info: StreamDetails) {
  if (!tokens[platform]) return { platform, ok: false, error: 'Not connected' }
  if (platform === 'Twitch') {
    const token = await ensureToken('Twitch')
    if (!token) return { platform, ok: false, error: 'Not connected' }
    const games = info.categoryId ? { data: [{ id: info.categoryId }] } : await twitchApi(`/helix/games?name=${encodeURIComponent(info.category)}`, token)
    const body = { title: info.title, ...(games.data?.[0]?.id ? { game_id: games.data[0].id } : {}) }
    try {
      await twitchApi(`/helix/channels?broadcaster_id=${token.userId}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { platform, ok: true }
    } catch (error) {
      return { platform, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (platform === 'Kick') {
    const response = await kickApi('/channels', undefined, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream_title: info.title, ...(info.categoryId ? { category_id: Number(info.categoryId) } : {}) }) })
    return { platform, ok: response.ok, error: response.ok ? undefined : await response.text() }
  }
  return { platform, ok: false, error: 'Unsupported stream platform' }
}

function broadcast() {
  state.activity = activityStore.list()
  const payload = `data: ${JSON.stringify(state)}\n\n`
  for (const client of clients) client.write(payload)
}
function loadTokens(): Partial<Record<TokenPlatform, Token>> { try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')) } catch { return {} } }

function persistStreamInfo() {
  const next = { Twitch: { ...state.streamInfo.Twitch }, Kick: { ...state.streamInfo.Kick } }
  if (JSON.stringify(settings.streamInfo) === JSON.stringify(next)) return
  settings.streamInfo = next
  saveSettings()
}

function loadSettings(): AppSettings {
  try {
    return parseAppSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8')))
  } catch {
    return defaultAppSettings()
  }
}

function openInDefaultBrowser(url: string) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}
function saveSettings() {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 })
}
function saveTokens() { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 }) }
