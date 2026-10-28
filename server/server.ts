import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import { ACTIVITY_MAX_AGE_MS, createActivityStore, type ActivityEvent } from './activity.js'
import { resolveEnvFilePath, resolveEnvTemplatePath, STREAMELEMENTS_JWT_KEYS, syncEnvFile, writeTextAtomic } from './env-file.js'

import { createDebouncedSave, readJsonFile, resolveDataDir, writeJsonAtomic } from './persist.js'
import { activityLogLine, createIngestLog, liveCheckLine, moderationLogLine } from './operator-log.js'
import { createOAuthStateStore } from './oauth-state.js'
import { fetchTimed } from './fetch-timed.js'
import { closeListeningServer, corsOriginDelegate, createControlGuard, lanWatchUrl, listenHostFor, listenOn, resolveBindHost, resolveWatchSecret, stickyLanBind, watchLogLine, watchOffLogLine } from './local-api.js'
import { createLogBuffer } from './log-buffer.js'
import { createLogFile, resolveLogFilePath } from './log-file.js'
import { createHostSession, findCompanionExe, nativeWindowPlan, serverShouldOpenWindow, windowsMessageBox } from './console-window.js'
import { StreamElementsClient, fetchRecentActivities, hydrateStreamElements } from './streamelements.js'
import { checkForUpdates, getCurrentVersion, isDesktopPackaged } from './check-update.js'
import { installRelayObsDocks, obsProcessRunning, operatorFilesDir } from './obs-docks.js'
import { registerHttpRoutes } from './http-routes.js'
import { createKickLive } from './kick-live.js'
import { createOAuth } from './oauth.js'
import { createTwitchLive } from './twitch-live.js'
import { createYouTubeLive } from './youtube-live.js'
import {
  YOUTUBE_QUOTA_LIMIT,
  applyChatModeration,
  defaultAppSettings,
  LIVE_STATUS_POLL_MS,
  shouldPollLiveStatus,
  shouldRunYouTubeMaintenance,
  isStoredChatMessage,
  isTokenRefreshHealthMessage,
  normalizeChatHandle,
  kickChannelPatch,
  mergeIncomingChat,
  missingStreamElementsMessage,
  needsTranslation,
  parseAppSettings,
  parseActivityMax,
  parseChatMax,
  activitySseFields,
  parseTranslatedText,
  pruneYouTubeSeenIds,
  resolveTranslateConfig,
  sseChangedKeys,
  sseNamedEvent,
  shouldKeepTokenRefreshBanner,
  shouldWarnKickChatDown,
  translateFailureMessage,
  twitchTagsForApi,
} from './logic.js'
import type {
  Account,
  AlertSettings,
  AppSettings,
  ChatMessage,
  ChatModeration,
  Health,
  MessagePart,
  Platform,
  StreamDetails,
  StreamElementsStatus,
  StreamInfoMap,
  StreamPlatform,
  Token,
  TokenPlatform,
  YoutubePrivacyNotice,
  YoutubeQuotaStatus,
} from './types.js'

/**
 * Relay Chat Dock backend entry point.
 *
 * Owns: the Express + HTTP server, SSE fan-out to the docks, in-memory `state`,
 * persist helpers, translation, StreamElements, and wiring for OAuth plus the
 * Twitch / Kick / YouTube live adapters. HTTP handlers live in http-routes.ts.
 */

const relayLogs = createLogBuffer()
relayLogs.capture()
let flushRelayLog = () => {}

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /Fetch API|fetch/i.test(warning.message)) return
  console.warn(warning.stack || warning.message)
})

const isPackaged = isDesktopPackaged()
const exeDir = process.env.RELAY_APP_ROOT || (isPackaged ? path.dirname(process.execPath) : process.cwd())
const filesDir = operatorFilesDir({ packaged: isPackaged, execPath: process.execPath, cwd: process.cwd() })
let companionChild: ChildProcess | undefined
let companionShutdown = false
const companionHost = createHostSession(() => shutdownCompanion())
function shutdownCompanion(): never {
  if (!companionShutdown) {
    companionShutdown = true
    try { flushChatSave() } catch { /* ignore */ }
    try { ingestLog.flush() } catch { /* ignore */ }
    try { flushRelayLog() } catch { /* ignore */ }
    try { companionChild?.kill() } catch { /* ignore */ }
  }
  process.exit(0)
}
process.on('exit', () => {
  try { flushChatSave() } catch { /* ignore */ }
  try { ingestLog.flush() } catch { /* ignore */ }
  try { flushRelayLog() } catch { /* ignore */ }
  try { companionChild?.kill() } catch { /* ignore */ }
})

function holdConsoleAndExit(code = 1, message?: string): never {
  try { flushRelayLog() } catch { /* ignore */ }
  process.exitCode = code
  const text = message || 'Relay Chat Dock failed to start.'
  if (process.versions.electron) {
    try {
      const { dialog } = createRequire(import.meta.url)('electron')
      dialog.showMessageBoxSync({ type: 'error', title: 'Relay Chat Dock', message: text })
    } catch { /* ignore */ }
  } else if (isPackaged && process.platform === 'win32') windowsMessageBox(text, 'Relay Chat Dock')
  process.exit(code)
}

process.on('uncaughtException', (error) => {
  console.error(error)
  holdConsoleAndExit(1, error instanceof Error ? error.stack || error.message : String(error))
})
// A rejected poll or save must not blank the docks. Startup failures still call holdConsoleAndExit directly.
process.on('unhandledRejection', (error) => {
  console.error(error)
})

try { fs.mkdirSync(filesDir, { recursive: true }) } catch { /* ignore */ }
try { fs.unlinkSync(path.join(filesDir, 'launch.log')) } catch { /* ignore */ }
const relayLogFile = createLogFile({ filePath: resolveLogFilePath(filesDir) })
for (const line of relayLogs.lines()) relayLogFile.writeLine(line)
relayLogs.subscribe((line) => relayLogFile.writeLine(line))
flushRelayLog = () => relayLogFile.flush()
const envPath = resolveEnvFilePath(filesDir)
const envTemplatePath = resolveEnvTemplatePath(exeDir)
let envKeysAdded: string[] = []
try {
  if (fs.existsSync(envPath) || isPackaged) envKeysAdded = syncEnvFile(envPath, envTemplatePath).added
} catch (error) {
  console.error('Could not merge .env.example into the env file:', error instanceof Error ? error.message : error)
}
dotenv.config({ path: envPath })
const chatMax = parseChatMax()
const activityMax = parseActivityMax()

if (process.argv.includes('--add-obs-docks')) {
  const portArg = process.argv.indexOf('--port')
  const configArg = process.argv.indexOf('--obs-config')
  const dockPort = Number((portArg >= 0 && process.argv[portArg + 1]) || process.env.PORT || 4173)
  const configDir = configArg >= 0 ? process.argv[configArg + 1] : undefined
  if (obsProcessRunning()) {
    console.error('OBS is running. Close OBS Studio, then add docks from the installer or Custom Browser Docks.')
    process.exit(2)
  }
  const result = installRelayObsDocks({ configDir, port: dockPort })
  if (result.status === 'added') console.log(`Added OBS docks in ${result.file}`)
  else if (result.status === 'exists') console.log(`OBS docks already present in ${result.file}`)
  else if (result.status === 'not-found') {
    console.error('OBS settings folder not found. Add docks by hand:')
    console.error(`  Chat      http://127.0.0.1:${dockPort}/`)
    console.error(`  Activity  http://127.0.0.1:${dockPort}/activity`)
    process.exitCode = 3
  } else {
    console.error(`Could not write OBS docks (${result.status}). Add them by hand from Custom Browser Docks.`)
    process.exitCode = 4
  }
  process.exit()
}

type State = { bootId: string; accounts: Account[]; streamInfo: StreamInfoMap; messages: ChatMessage[]; health: Record<Platform, Health>; activity: ActivityEvent[]; activityWarnings: string[]; chatWarnings: string[]; youtubePrivacy: YoutubePrivacyNotice[]; streamelements: StreamElementsStatus; activityFallback: boolean; ignoreMissingJwt: boolean; dropOldAlerts: boolean; translateChat: boolean; translateError: string; alerts: AlertSettings; activityMax: number; autoLiveCheck: AppSettings['autoLiveCheck']; youtubeQuota: YoutubeQuotaStatus }

const port = Number(process.env.PORT || 4173)
const { lanEnabled: envLanEnabled } = resolveBindHost()
/** Honored as-is when it is 0.0.0.0 or a LAN IP. Default loopback only expands to the LAN while Watch is on. */
const envBindHost = String(process.env.RELAY_BIND || '').trim()
const apiToken = String(process.env.RELAY_API_TOKEN || '').trim() || undefined
const localApi = { port, bindHost: '127.0.0.1', lanEnabled: envLanEnabled, apiToken, watchToken: undefined as string | undefined }
const app = express()
const httpServer = createServer(app)
httpServer.requestTimeout = 0
httpServer.headersTimeout = 0
httpServer.timeout = 0
const clients = new Set<express.Response>()
const dataDir = resolveDataDir({ packaged: isPackaged, execPath: process.execPath, cwd: process.cwd(), env: process.env })
const tokenFile = path.join(dataDir, 'tokens.json')
const settingsFile = path.join(dataDir, 'settings.json')
const chatFile = path.join(dataDir, 'chat.json')
const settings = loadSettings()
if (typeof settings.lanWatch === 'boolean') localApi.lanEnabled = settings.lanWatch
localApi.bindHost = listenHostFor(localApi.lanEnabled, envBindHost)
// View secret for the shared watch URL. Kept distinct from RELAY_API_TOKEN so that link cannot write.
const watchTokenFile = path.join(dataDir, 'watch-token')
let storedWatchToken = ''
try { storedWatchToken = fs.readFileSync(watchTokenFile, 'utf8') } catch { /* created the first time Watch is turned on */ }
function ensureWatchToken() {
  if (localApi.watchToken) return localApi.watchToken
  const secret = resolveWatchSecret({
    lanEnabled: true,
    envToken: process.env.RELAY_WATCH_TOKEN,
    apiToken,
    stored: storedWatchToken,
    create: () => crypto.randomBytes(24).toString('base64url'),
  })
  if (secret.persist) {
    storedWatchToken = secret.persist
    try { writeTextAtomic(watchTokenFile, `${secret.persist}\n`) }
    catch (error) { console.error(`Could not save the watch token: ${error instanceof Error ? error.message : error}`) }
  }
  localApi.watchToken = secret.token
  if (secret.warning) console.warn(secret.warning)
  return secret.token
}
if (localApi.lanEnabled) ensureWatchToken()
const activityStore = createActivityStore(path.join(dataDir, 'activity.json'), activityMax)
if (settings.dropOldAlerts) activityStore.setMaxAge(ACTIVITY_MAX_AGE_MS)
const redirectUri = process.env.OAUTH_REDIRECT_URI || `http://localhost:${port}/oauth/callback`
const tokens: Partial<Record<TokenPlatform, Token>> = loadTokens()
const activityWarnings = new Map<string, string>()
const chatWarnings = new Map<string, string>()
const streamElements = new StreamElementsClient()
const oauthStates = createOAuthStateStore()
const liveCheckLocks = new Map<Platform, Promise<void>>()
let twitchLivePollInFlight = false
let youtubeLivePollInFlight = false
let kickLivePollInFlight = false
const emptyHealth = (): Health => ({ status: 'ok', message: '' })

function loadChat(): ChatMessage[] {
  const parsed = readJsonFile<unknown>(chatFile, [])
  const messages = (Array.isArray(parsed) ? parsed : []).filter(isStoredChatMessage).slice(-chatMax)
  return messages
}

const state: State = {
  // Changes on every launch so an open alert page can tell the server restarted
  bootId: crypto.randomUUID(),
  // Everything the docks render; each broadcast re-serializes a slice of it
  accounts: (['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => ({ platform, connected: Boolean(tokens[platform]), live: false, viewers: 0, handle: tokens[platform]?.user || '' })),
  streamInfo: {
    Twitch: { ...settings.streamInfo.Twitch },
    Kick: { ...settings.streamInfo.Kick },
    YouTube: { ...settings.streamInfo.YouTube },
  },
  messages: loadChat(),
  health: { Twitch: emptyHealth(), Kick: emptyHealth(), YouTube: emptyHealth() },
  activity: activityStore.list(),
  activityWarnings: [],
  chatWarnings: [],
  youtubePrivacy: [],
  // The JWTs hydrate right after the server boots, so start out connecting:
  // the docks should not read this as "StreamElements is not configured".
  streamelements: { connected: false, handle: '', missing: [], connecting: true },
  activityFallback: settings.activityFallback,
  ignoreMissingJwt: settings.ignoreMissingJwt,
  dropOldAlerts: settings.dropOldAlerts,
  translateChat: settings.translateChat,
  translateError: '',
  alerts: { ...settings.alerts, disabled: [...settings.alerts.disabled] },
  activityMax,
  autoLiveCheck: { ...settings.autoLiveCheck },
  youtubeQuota: { used: 0, limit: YOUTUBE_QUOTA_LIMIT },
}

function persistChatNow() {
  try {
    pruneYouTubeSeenIds(youtube.youtubeSeen, state.messages)
    const stored = state.messages.slice(-chatMax).map((message) => {
      const rest = { ...message }
      delete rest.ingest
      return rest
    })
    writeJsonAtomic(chatFile, stored)
  } catch (error) {
    console.error('Chat save:', error instanceof Error ? error.message : error)
  }
}

const chatSave = createDebouncedSave(persistChatNow)
function scheduleChatSave() { chatSave.schedule() }
function flushChatSave() { chatSave.flush() }

const ingestLog = createIngestLog((line) => console.log(line))
const liveStatusSeen = new Map<Platform, { key: string; at: number }>()

function logPolledLive(platform: Platform, manual = false) {
  const account = state.accounts.find((item) => item.platform === platform)
  if (!account?.connected) return
  noteLiveStatus(platform, Boolean(account.live), account.viewers || 0, manual)
}

function noteLiveStatus(platform: Platform, live: boolean, viewers: number, manual = false) {
  const previous = liveStatusSeen.get(platform)
  const next = liveCheckLine(previous, { platform, live, viewers }, manual)
  liveStatusSeen.set(platform, { key: next.key, at: next.at })
  if (next.line) console.log(next.line)
}

function applyChatModerationToState(change: ChatModeration) {
  const result = applyChatModeration(state.messages, change)
  if (!result.changed) return false
  state.messages = result.messages
  scheduleChatSave()
  broadcast()
  console.log(moderationLogLine(change.action, change.platform, change.user))
  return true
}

const recentOutgoing: { id: string; text: string; platforms: Platform[]; at: number }[] = []
let sseSeq = 0
let lastSseSlices = { chat: '', activity: '', presence: '', settings: '' }
let lastActivityEvents: ActivityEvent[] = []

function currentWatchUrl() {
  if (!localApi.lanEnabled) return
  ensureWatchToken()
  return lanWatchUrl({ bindHost: localApi.bindHost, port, token: localApi.watchToken, interfaces: os.networkInterfaces() })
}

function restorePlatformConnection(platform: Platform) {
  const token = tokens[platform]
  const account = state.accounts.find((item) => item.platform === platform)
  if (account && token) Object.assign(account, { connected: true, handle: token.user || account.handle || platform })
  if (isTokenRefreshHealthMessage(state.health[platform].message)) setHealth(platform, 'ok')
}

function setHealth(platform: Platform, status: Health['status'], message = '') {
  const current = state.health[platform]
  if (current.status === status && current.message === message) return
  state.health[platform] = { status, message }
  broadcast()
}

function rememberOutgoing(entry: { id: string; text: string; platforms: Platform[]; at: number }) {
  const cutoff = Date.now() - 20_000
  for (let index = recentOutgoing.length - 1; index >= 0; index--) if (recentOutgoing[index].at < cutoff) recentOutgoing.splice(index, 1)
  recentOutgoing.push(entry)
}

function ownHandles() {
  const names = new Set<string>(['you'])
  const add = (value?: string) => {
    if (!value) return
    names.add(value.toLowerCase())
    names.add(normalizeChatHandle(value))
  }
  for (const platform of ['Twitch', 'Kick', 'YouTube'] as Platform[]) add(tokens[platform]?.user)
  for (const account of state.accounts) add(account.handle)
  return names
}

function ownUserIds() {
  const ids = new Set<string>()
  for (const platform of ['Twitch', 'Kick', 'YouTube'] as Platform[]) {
    const token = tokens[platform]
    if (token?.userId) ids.add(token.userId.toLowerCase())
    if (token?.channelId) ids.add(token.channelId.toLowerCase())
  }
  return ids
}

const translationCache = new Map<string, string>()
const translateQueue: ChatMessage[] = []
let translating = false
let translateFailures = 0
function noteTranslateFailure() {
  translateFailures += 1
  if (translateFailures < 2) return
  const message = translateFailureMessage(resolveTranslateConfig().provider)
  if (state.translateError === message) return
  state.translateError = message
  broadcast()
}
function clearTranslateFailure() {
  translateFailures = 0
  if (!state.translateError) return
  state.translateError = ''
  broadcast()
}
/** Translate a chat snippet to English using the configured provider, with a per-session cache. Falls back silently to the original text on any failure. */
async function translateToEnglish(text: string) {
  const key = text.trim()
  if (!key || !needsTranslation(key)) return
  const cached = translationCache.get(key)
  if (cached) return cached
  const config = resolveTranslateConfig()
  const snippet = key.slice(0, 500)
  try {
    let response: Response
    if (config.provider === 'google-v2') {
      response = await fetchTimed(`${config.url}?key=${encodeURIComponent(config.key || '')}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: snippet, target: 'en', format: 'text' }),
      }, 6_000)
    } else if (config.provider === 'libre') {
      response = await fetchTimed(config.url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: snippet, source: 'auto', target: 'en', format: 'text', ...(config.key ? { api_key: config.key } : {}) }),
      }, 6_000)
    } else {
      // Free unofficial Google endpoint, no key required; can be rate-limited or blocked by Google
      response = await fetchTimed(`${config.url}?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(snippet)}`, { headers: { Accept: 'application/json' } }, 6_000)
    }
    if (!response.ok) { noteTranslateFailure(); return }
    const translated = parseTranslatedText(config.provider, await response.json(), key)
    if (!translated) return
    clearTranslateFailure()
    translationCache.set(key, translated)
    if (translationCache.size > 2_000) {
      const oldest = translationCache.keys().next().value
      if (oldest) translationCache.delete(oldest)
    }
    return translated
  } catch {
    noteTranslateFailure()
  }
}

async function applyTranslation(message: ChatMessage) {
  if (!settings.translateChat) return
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
  scheduleChatSave()
  broadcast()
}

function queueTranslation(message: ChatMessage) {
  if (!settings.translateChat) return
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

function addActivity(event: ActivityEvent) {
  if (!activityStore.add(event)) return
  state.activity = activityStore.list()
  console.log(activityLogLine(event))
  broadcast()
}

function addNativeActivity(event: ActivityEvent, options: { always?: boolean } = {}) {
  if (!settings.activityFallback && !options.always) return
  addActivity({ ...event, feed: event.feed || 'native' })
}

function addStreamElementsActivity(event: ActivityEvent) {
  addActivity({ ...event, feed: event.feed || 'streamelements' })
}

async function streamElementsChannelFor(provider: string, anyChannel = false) {
  const wanted = provider.toLowerCase()
  const loaded = streamElements.loadedChannels.find((channel) => (channel.provider || '').toLowerCase() === wanted)
  if (loaded) return loaded
  if (anyChannel && streamElements.loadedChannels[0]) return streamElements.loadedChannels[0]
  const jwtPlatform = wanted === 'kick' ? 'Kick' : wanted === 'youtube' ? 'YouTube' : 'Twitch'
  const jwt = String(process.env[STREAMELEMENTS_JWT_KEYS[jwtPlatform]] || '').trim()
  if (!jwt && anyChannel) {
    for (const platform of ['Twitch', 'Kick', 'YouTube'] as const) {
      const fallback = String(process.env[STREAMELEMENTS_JWT_KEYS[platform]] || '').trim()
      if (!fallback) continue
      return hydrateStreamElements(fallback)
    }
  }
  if (!jwt) return
  return hydrateStreamElements(jwt)
}

function streamElementsJwtSlots() {
  return [
    { platform: 'Twitch' as const, jwt: String(process.env.STREAMELEMENTS_JWT_TWITCH || '').trim() },
    { platform: 'Kick' as const, jwt: String(process.env.STREAMELEMENTS_JWT_KICK || '').trim() },
    { platform: 'YouTube' as const, jwt: String(process.env.STREAMELEMENTS_JWT_YOUTUBE || '').trim() },
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

function setChatWarning(key: string, message?: string) {
  if (message) chatWarnings.set(key, message)
  else chatWarnings.delete(key)
  const next = [...chatWarnings.values()]
  if (next.length === state.chatWarnings.length && next.every((item, index) => item === state.chatWarnings[index])) return
  state.chatWarnings = next
  broadcast()
}

/** Publish a StreamElements status slice to the docks, skipping the broadcast when nothing changed. */
function updateStreamElementsStatus(patch: Partial<StreamElementsStatus>) {
  const next = { ...state.streamelements, ...patch }
  if (JSON.stringify(next) === JSON.stringify(state.streamelements)) return
  state.streamelements = next
  broadcast()
}

async function startStreamElements(backfill = false) {
  await streamElements.stop()
  const slots = streamElementsJwtSlots()
  const missing = slots.filter((slot) => !slot.jwt).map((slot) => slot.platform)
  const missingNote = missingStreamElementsMessage(missing)
  const failed: Array<{ platform: 'Twitch' | 'Kick' | 'YouTube'; message: string }> = []
  if (!slots.some((slot) => slot.jwt)) {
    updateStreamElementsStatus({ connected: false, handle: '', missing, connecting: false })
    setActivityWarning('streamelements', settings.ignoreMissingJwt ? undefined : missingNote)
    return failed
  }
  // Hydrating a JWT hits the StreamElements API and can take a moment after a
  // restart or a saved JWT. Keep the last known status and mark the window as
  // connecting so the docks stay quiet instead of flashing a warning.
  updateStreamElementsStatus({ missing, connecting: true })
  const channels = []
  const seen = new Map<string, Awaited<ReturnType<typeof hydrateStreamElements>>>()
  for (const slot of slots) {
    if (!slot.jwt) continue
    const cached = seen.get(slot.jwt)
    if (cached) {
      channels.push(cached)
      continue
    }
    try {
      const channel = await hydrateStreamElements(slot.jwt)
      seen.set(slot.jwt, channel)
      channels.push(channel)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`StreamElements ${slot.platform} JWT failed:`, message)
      failed.push({ platform: slot.platform, message })
    }
  }
  if (!channels.length) {
    updateStreamElementsStatus({ connected: false, handle: '', missing: missing.length ? missing : ['Twitch', 'Kick', 'YouTube'], connecting: false })
    setActivityWarning('streamelements', 'StreamElements JWTs failed to load. Check the Relay Chat Dock window or production.env.')
    console.error('StreamElements JWTs failed to load. Check the Relay Chat Dock window or production.env.')
    return failed
  }
  const handle = channels.map((channel) => channel.provider ? `${channel.handle} (${channel.provider})` : channel.handle).join(', ')
  updateStreamElementsStatus({ connected: true, handle, connecting: false })
  setActivityWarning('streamelements', settings.ignoreMissingJwt ? undefined : missingNote)
  // The socket callback is also how the dock learns the connection really is
  // live: a drop only reaches it once the client has waited out its grace
  // period, so a short reconnect never shows up as an alert.
  await streamElements.start(channels, (event) => addStreamElementsActivity(event), (message) => {
    setActivityWarning('streamelements-live', message)
    updateStreamElementsStatus({ connected: streamElements.connected })
  })
  console.log(`StreamElements connected (${handle})`)
  if (backfill) {
    for (const channel of channels) {
      const events = await fetchRecentActivities(channel)
      for (const event of events) addStreamElementsActivity(event)
    }
  }
  return failed
}

function addMessage(message: ChatMessage, options?: { preload?: boolean; ingest?: 'official' | 'innertube'; source?: string }) {
  const result = mergeIncomingChat(state.messages, message, options, {
    ownHandles: ownHandles(),
    ownUserIds: ownUserIds(),
    recentOutgoing,
    targets: youtube.youtubeTargets,
    max: chatMax,
  })
  for (const id of result.seenIds) youtube.youtubeSeen.add(id)
  if (!result.changed) return
  state.messages = result.messages
  scheduleChatSave()
  broadcast()
  if (result.added) {
    const source = options?.preload ? 'history' : options?.source || (options?.ingest === 'official' ? 'official list' : options?.ingest === 'innertube' ? 'InnerTube' : 'chat')
    ingestLog.note(message.platform, source)
    queueTranslation(result.added)
    if (result.added.platform === 'Twitch') twitch.queueTwitchAvatar(result.added.userId)
  }
}

function writeSse(client: express.Response, chunk: string) {
  if (client.writableEnded || client.destroyed) {
    clients.delete(client)
    return
  }
  try {
    client.write(chunk)
  } catch {
    clients.delete(client)
  }
}

function ssePresence() {
  return {
    accounts: state.accounts,
    streamInfo: state.streamInfo,
    health: state.health,
    chatWarnings: state.chatWarnings,
    youtubePrivacy: state.youtubePrivacy,
    youtubeQuota: state.youtubeQuota,
    streamelements: state.streamelements,
  }
}

function sseSettings() {
  return {
    activityFallback: state.activityFallback,
    ignoreMissingJwt: state.ignoreMissingJwt,
    dropOldAlerts: state.dropOldAlerts,
    translateChat: state.translateChat,
    translateError: state.translateError,
    alerts: state.alerts,
    activityMax: state.activityMax,
    autoLiveCheck: state.autoLiveCheck,
  }
}

function pushSse(chunk: string) {
  for (const client of [...clients]) writeSse(client, chunk)
}

// Slice the sub-slices so each dock only receives and re-broadcasts what it renders
function broadcast() {
  state.activity = activityStore.list()
  const activityFields = activitySseFields(lastActivityEvents, state.activity, state.activityWarnings)
  lastActivityEvents = state.activity
  const next = {
    chat: JSON.stringify(state.messages),
    activity: JSON.stringify({ activity: state.activity, activityWarnings: state.activityWarnings }),
    presence: JSON.stringify(ssePresence()),
    settings: JSON.stringify(sseSettings()),
  }
  const changed = sseChangedKeys(lastSseSlices, next)
  if (!changed.length) return
  lastSseSlices = next
  if (changed.length >= 4) {
    sseSeq += 1
    pushSse(sseNamedEvent('snapshot', { seq: sseSeq, ...state }))
    return
  }
  for (const key of changed) {
    sseSeq += 1
    if (key === 'chat') pushSse(sseNamedEvent('chat', { seq: sseSeq, messages: state.messages }))
    else if (key === 'activity') pushSse(sseNamedEvent('activity', { seq: sseSeq, ...activityFields }))
    else if (key === 'presence') pushSse(sseNamedEvent('presence', { seq: sseSeq, ...ssePresence() }))
    else pushSse(sseNamedEvent('settings', { seq: sseSeq, ...sseSettings() }))
  }
}

let twitch!: ReturnType<typeof createTwitchLive>
let youtube!: ReturnType<typeof createYouTubeLive>
let kick!: ReturnType<typeof createKickLive>

const oauth = createOAuth({
  tokens,
  state,
  oauthStates,
  redirectUri,
  twitchApi: (endpoint, token, options) => twitch.twitchApi(endpoint, token, options),
  youtubeApi: (endpoint, token, options) => youtube.youtubeApi(endpoint, token, options),
  kickApi: (endpoint, token, options, retried) => kick.kickApi(endpoint, token, options, retried),
  saveTokens,
  restorePlatformConnection,
  setHealth,
})

twitch = createTwitchLive({
  tokens,
  state,
  settings,
  ensureToken: oauth.ensureToken,
  refreshAccessToken: oauth.refreshAccessToken,
  setHealth,
  setActivityWarning,
  setChatWarning,
  addMessage,
  addNativeActivity,
  applyChatModerationToState,
  restorePlatformConnection,
  scheduleChatSave,
  broadcast,
})

youtube = createYouTubeLive({
  tokens,
  state,
  settings,
  dataDir,
  ensureToken: oauth.ensureToken,
  refreshAccessToken: oauth.refreshAccessToken,
  hydrateYouTubeToken: oauth.hydrateYouTubeToken,
  saveTokens,
  saveSettings,
  restorePlatformConnection,
  setHealth,
  addMessage,
  addNativeActivity,
  applyChatModerationToState,
  ownHandles,
  ownUserIds,
  scheduleChatSave,
  broadcast,
})
youtube.rememberYouTubeFromChat(state.messages)

kick = createKickLive({
  tokens,
  state,
  ensureToken: oauth.ensureToken,
  refreshAccessToken: oauth.refreshAccessToken,
  saveTokens,
  restorePlatformConnection,
  setHealth,
  addMessage,
  addNativeActivity,
  applyChatModerationToState,
  scheduleChatSave,
  broadcast,
})

function startAdapter(platform: Platform) {
  if (platform === 'Twitch') {
    twitch.twitchEventSubUnsupported = false
    twitch.twitchBadgesLoaded = false
    void twitch.ensureTwitchBadges()
    twitch.connectTwitchEventSub()
    // Auto off: keep EventSub/IRC up, but do not ask Helix whether the channel is live.
    if (shouldPollLiveStatus(settings.autoLiveCheck.Twitch, 'auto')) void twitch.pollTwitch().then(() => broadcast()).catch((error) => console.error('Twitch poll:', error instanceof Error ? error.message : error))
    else twitch.ensureTwitchChat()
  }
  if (platform === 'Kick') {
    if (shouldPollLiveStatus(settings.autoLiveCheck.Kick, 'auto')) void kick.pollKick().then(() => broadcast()).catch((error) => console.error('Kick poll:', error instanceof Error ? error.message : error))
    else kick.maintainKickChat()
  }
  if (platform === 'YouTube' && shouldRunYouTubeMaintenance({ autoEnabled: settings.autoLiveCheck.YouTube, manual: false, chatConnected: youtube.youtubeChat.connected })) {
    void youtube.pollYouTube().then((checked) => { if (checked) logPolledLive('YouTube'); broadcast() }).catch((error) => console.error('YouTube poll:', error instanceof Error ? error.message : error))
  }
}

async function checkLiveNow(platform: Platform) {
  const pending = liveCheckLocks.get(platform)
  if (pending) return pending
  const work = (async () => {
    if (platform === 'Twitch') { await twitch.pollTwitch(); logPolledLive('Twitch', true) }
    else if (platform === 'Kick') { await kick.pollKick(); logPolledLive('Kick', true) }
    else await youtube.runYouTubePoll(async () => {
      youtube.youtubeForceStatus = true
      youtube.beginYouTubeHydration()
      await youtube.pollYouTubeNow({ manual: true })
      const account = state.accounts.find((item) => item.platform === 'YouTube')
      if (!account?.live) {
        const token = await oauth.ensureToken('YouTube')
        if (token) {
          await youtube.discoverYouTubeLive(token)
          await youtube.syncYouTubeChat(token)
          await youtube.seedYouTubeHistory(token)
          await youtube.refreshYouTubeViewers()
        }
      }
      logPolledLive('YouTube', true)
    })
    refreshChatHealth()
    broadcast()
  })().finally(() => {
    if (liveCheckLocks.get(platform) === work) liveCheckLocks.delete(platform)
  })
  liveCheckLocks.set(platform, work)
  return work
}

function refreshChatHealth() {
  if (tokens.Twitch) {
    const twitchAccount = state.accounts.find((item) => item.platform === 'Twitch')
    if (!shouldKeepTokenRefreshBanner(state.health.Twitch, Boolean(twitchAccount?.connected))) {
      if (twitch.twitchEventSubReady || twitch.twitchIrcReady) { if (state.health.Twitch.status === 'down') setHealth('Twitch', 'ok') }
      else setHealth('Twitch', 'down', 'Twitch chat disconnected — messages may be missing')
    }
    if (!twitch.twitchEventSubReady) twitch.ensureTwitchChat()
  } else if (isTokenRefreshHealthMessage(state.health.Twitch.message)) {
    setHealth('Twitch', 'ok')
  }
  if (tokens.Kick) {
    const kickAccount = state.accounts.find((item) => item.platform === 'Kick')
    if (!shouldKeepTokenRefreshBanner(state.health.Kick, Boolean(kickAccount?.connected))) {
      if (kick.kickChat.connected) { if (state.health.Kick.status === 'down') setHealth('Kick', 'ok') }
      else if (shouldWarnKickChatDown(kick.kickChat.connected, kick.kickChat.failed)) setHealth('Kick', 'down', 'Kick chat disconnected — messages may be missing')
    }
  } else if (isTokenRefreshHealthMessage(state.health.Kick.message)) {
    setHealth('Kick', 'ok')
  }
  if (tokens.YouTube) {
    const account = state.accounts.find((item) => item.platform === 'YouTube')
    if (!shouldKeepTokenRefreshBanner(state.health.YouTube, Boolean(account?.connected))) {
      const quota = youtube.youtubeQuotaHealth()
      if (quota && (youtube.youtubeQuotaBlocked() || youtube.youtubeQuotaUsed >= youtube.youtubeQuotaLimit)) setHealth('YouTube', quota.status, quota.message)
      else if (account?.live && youtube.youtubeChat.failed) setHealth('YouTube', 'warn', 'YouTube site chat failed — using slow API fallback')
      else if (quota) setHealth('YouTube', quota.status, quota.message)
      else if (youtube.youtubeChat.connected) { if (state.health.YouTube.status === 'down' || /quota/i.test(state.health.YouTube.message)) setHealth('YouTube', 'ok') }
      else if (account?.live && !youtube.youtubeLiveChatIds().length) setHealth('YouTube', 'down', 'YouTube is live but chat is unavailable')
    }
  } else if (isTokenRefreshHealthMessage(state.health.YouTube.message)) {
    setHealth('YouTube', 'ok')
  }
}

async function pollLiveState() {
  const twitchAccount = state.accounts.find((item) => item.platform === 'Twitch')
  const kickAccount = state.accounts.find((item) => item.platform === 'Kick')
  const twitchWasLive = Boolean(twitchAccount?.live)
  const kickWasLive = Boolean(kickAccount?.live)
  // Poll each platform independently so a slow YouTube or Twitch poll cannot
  // delay Kick's live/offline update. Per-platform guards prevent overlapping
  // polls for the same platform.
  const tasks: Promise<void>[] = []
  if (tokens.Twitch) {
    tasks.push((async () => {
      if (twitchLivePollInFlight) return
      twitchLivePollInFlight = true
      try {
        // Auto off skips the live-status API only. Chat sockets stay up, and live/offline is not updated until Check live.
        if (shouldPollLiveStatus(settings.autoLiveCheck.Twitch, 'auto')) {
          try { await twitch.pollTwitch(); logPolledLive('Twitch'); if (twitchWasLive && !twitchAccount?.live && settings.autoLiveCheck.YouTube) youtube.youtubeForceStatus = true; if (state.health.Twitch.status === 'warn') setHealth('Twitch', twitch.twitchEventSubReady || twitch.twitchIrcReady ? 'ok' : 'down', twitch.twitchEventSubReady || twitch.twitchIrcReady ? '' : 'Twitch chat disconnected — messages may be missing') } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('Twitch poll:', message)
            if (state.health.Twitch.status !== 'down') setHealth('Twitch', twitch.twitchEventSubReady || twitch.twitchIrcReady ? 'warn' : 'down', twitch.twitchEventSubReady || twitch.twitchIrcReady ? 'Twitch status poll failed' : `Twitch poll failed — messages may be missing`)
            twitch.ensureTwitchChat()
          }
        } else twitch.ensureTwitchChat()
      } finally {
        twitchLivePollInFlight = false
      }
    })())
  }
  if (tokens.YouTube && shouldRunYouTubeMaintenance({ autoEnabled: settings.autoLiveCheck.YouTube, manual: false, chatConnected: youtube.youtubeChat.connected })) {
    tasks.push((async () => {
      if (youtubeLivePollInFlight) return
      youtubeLivePollInFlight = true
      try {
        try {
          const checked = await youtube.pollYouTube()
          if (checked) logPolledLive('YouTube')
          if (!youtube.youtubeQuotaBlocked() && (youtube.youtubeChat.connected || /poll failed/i.test(state.health.YouTube.message)) && state.health.YouTube.status === 'warn') setHealth('YouTube', 'ok')
        } catch (error) {
          if (youtube.noteYouTubeQuota(error)) { /* site chat continues */ }
          else {
            const message = error instanceof Error ? error.message : String(error)
            console.error('YouTube poll:', message)
            if (!youtube.youtubeChat.connected && !isTokenRefreshHealthMessage(state.health.YouTube.message)) setHealth('YouTube', 'warn', 'YouTube poll failed — chat or counts may be stale')
          }
        }
      } finally {
        youtubeLivePollInFlight = false
      }
    })())
  }
  if (tokens.Kick) {
    tasks.push((async () => {
      if (kickLivePollInFlight) return
      kickLivePollInFlight = true
      try {
        if (shouldPollLiveStatus(settings.autoLiveCheck.Kick, 'auto')) {
          try { await kick.pollKick(); logPolledLive('Kick'); if (kickWasLive && !kickAccount?.live && settings.autoLiveCheck.YouTube) youtube.youtubeForceStatus = true; if (kick.kickChat.connected) setHealth('Kick', 'ok'); else if (shouldWarnKickChatDown(kick.kickChat.connected, kick.kickChat.failed)) setHealth('Kick', 'down', 'Kick chat disconnected — messages may be missing') } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('Kick poll:', message)
            if (kick.kickChat.connected) setHealth('Kick', 'warn', 'Kick status poll failed')
            else setHealth('Kick', 'down', 'Kick poll failed — messages may be missing')
          }
          broadcast()
        } else kick.maintainKickChat()
      } finally {
        kickLivePollInFlight = false
      }
    })())
  }
  try {
    await Promise.allSettled(tasks)
    if (twitchWasLive && !twitchAccount?.live && settings.autoLiveCheck.YouTube) youtube.youtubeForceStatus = true
    if (kickWasLive && !kickAccount?.live && settings.autoLiveCheck.YouTube) youtube.youtubeForceStatus = true
    persistStreamInfo()
    refreshChatHealth()
    broadcast()
  } catch (error) {
    // A locked settings file or a thrown status poll must not reject void pollLiveState() and exit.
    console.error('Live status poll:', error instanceof Error ? error.message : error)
  }
}

async function sendMessage(platform: Platform, text: string) {
  if (!tokens[platform]) return { platform, ok: false, error: 'Not connected' }
  try {
    if (platform === 'Twitch') return { platform, ...(await twitch.sendTwitchMessage(text)) }
    if (platform === 'Kick') return { platform, ...(await kick.sendKickMessage(text)) }
    if (platform === 'YouTube') return { platform, ...(await youtube.sendYouTubeMessage(text)) }
  } catch (error) {
    return { platform, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { platform, ok: false, error: `${platform} chat is not live or its API adapter is unavailable` }
}

async function moderate(platform: Platform, body: { action: string; messageId?: string; userId?: string; sourceId?: string; duration?: number; reason?: string }) {
  if (!tokens[platform]) return { ok: false, error: 'Not connected' }
  if (platform === 'Twitch') return twitch.moderateTwitch(body)
  if (platform === 'Kick') return kick.moderateKick(body)
  // YouTube liveChat/bans has no reason field, so moderateYouTube ignores body.reason.
  if (platform === 'YouTube') return youtube.moderateYouTube(body)
  return { ok: false, error: `${platform} moderation is not available` }
}

async function searchCategories(platform: StreamPlatform, query: string) {
  if (platform === 'Twitch') {
    const token = await oauth.ensureToken('Twitch')
    const result = await twitch.twitchApi(`/helix/search/categories?query=${encodeURIComponent(query)}`, token!)
    return (result.data || []).map((item: any) => ({ id: String(item.id), name: item.name }))
  }
  const response = await kick.kickApi(`/categories?q=${encodeURIComponent(query)}&page=1`)
  if (!response.ok) throw new Error(`Kick categories ${response.status}: ${await response.text()}`)
  const result = await response.json() as any
  return (result.data || []).map((item: any) => ({ id: String(item.id), name: item.name }))
}

async function updateStreamInfo(platform: StreamPlatform, info: StreamDetails) {
  if (!tokens[platform]) return { platform, ok: false, error: 'Not connected' }
  if (platform === 'Twitch') {
    const token = await oauth.ensureToken('Twitch')
    if (!token) return { platform, ok: false, error: 'Not connected' }
    const games = info.categoryId ? { data: [{ id: info.categoryId }] } : await twitch.twitchApi(`/helix/games?name=${encodeURIComponent(info.category)}`, token)
    const tags = twitchTagsForApi(info.tags)
    const body = { title: info.title, ...(games.data?.[0]?.id ? { game_id: games.data[0].id } : {}), ...(tags ? { tags } : {}) }
    try {
      await twitch.twitchApi(`/helix/channels?broadcaster_id=${token.userId}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { platform, ok: true }
    } catch (error) {
      return { platform, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (platform === 'Kick') {
    const patch = kickChannelPatch({ title: info.title, category: info.category, categoryId: info.categoryId, tags: info.tags })
    try {
      const response = await kick.kickApi('/channels', undefined, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch.body) })
      if (!response.ok) return { platform, ok: false, error: await response.text() }
      return { platform, ok: true, ...(patch.warning ? { warning: patch.warning } : {}) }
    } catch (error) {
      return { platform, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { platform, ok: false, error: 'Unsupported stream platform' }
}

app.use(cors({ origin: corsOriginDelegate(localApi) }))
app.use(express.json())
app.use(createControlGuard(localApi))
registerHttpRoutes(app, {
  state,
  tokens,
  settings,
  activityStore,
  port,
  envPath,
  dataDir,
  envTemplatePath,
  envBindHost,
  localApi,
  currentWatchUrl,
  relayLogs,
  companionHost,
  shutdownCompanion,
  applyManualYouTubeQuota: (line) => youtube.applyManualYouTubeQuota(line),
  writeSse,
  clients,
  sendMessage,
  rememberOutgoing,
  addMessage,
  scheduleChatSave,
  broadcast,
  moderate,
  applyChatModerationToState,
  youtubePrivacyDismissed: youtube.youtubePrivacyDismissed,
  setYoutubePrivacy: (notices) => youtube.setYoutubePrivacy(notices),
  youtubeQuotaBlocked: () => youtube.youtubeQuotaBlocked(),
  ensureToken: oauth.ensureToken,
  youtubeApi: (endpoint, token, options) => youtube.youtubeApi(endpoint, token, options),
  searchCategories,
  updateStreamInfo,
  persistStreamInfo,
  subscribeTwitchEvents: (sessionId, generation) => twitch.subscribeTwitchEvents(sessionId, generation),
  setActivityWarning,
  setChatWarning,
  setHealth,
  saveSettings,
  saveTokens,
  checkLiveNow,
  rebindForWatch,
  streamElementsJwtSlots,
  startStreamElements,
  streamElementsChannelFor,
  closeTwitchChat: () => twitch.closeTwitchChat(),
  kickChat: kick.kickChat,
  setYouTubeTargets: (targets) => youtube.setYouTubeTargets(targets),
  youtubeStreamViewers: youtube.youtubeStreamViewers,
  publishYouTubeStreams: () => youtube.publishYouTubeStreams(),
  youtubeChat: youtube.youtubeChat,
  announcedYoutubePrivacy: youtube.announcedYoutubePrivacy,
  startAdapter,
  authorizationUrl: (platform) => oauth.authorizationUrl(platform),
  exchangeCode: (platform, code, codeVerifier) => oauth.exchangeCode(platform, code, codeVerifier),
  oauthStates,
  get sseSeq() { return sseSeq },
  get twitchEventSubSessionId() { return twitch.twitchEventSubSessionId },
  get youtubeForceStatus() { return youtube.youtubeForceStatus },
  set youtubeForceStatus(value) { youtube.youtubeForceStatus = value },
  get youtubePrivacyWatch() { return youtube.youtubePrivacyWatch },
  set youtubePrivacyWatch(value) { youtube.youtubePrivacyWatch = value },
})

const distPath = path.resolve(process.env.RELAY_APP_ROOT ? path.join(process.env.RELAY_APP_ROOT, 'dist') : isPackaged ? path.join(path.dirname(process.execPath), 'dist') : './dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('*', (_request, response) => response.sendFile(path.join(distPath, 'index.html')))
}
function dropSseClients() {
  for (const response of [...clients]) {
    try { response.end() } catch { /* ignore */ }
  }
  clients.clear()
}

/**
 * Watch hosts or unhosts `/watch`. The socket only moves when bind is the
 * default loopback: Watch on → 0.0.0.0, Watch off → 127.0.0.1. A sticky
 * RELAY_BIND (0.0.0.0 or a LAN IP) stays put.
 */
async function rebindForWatch(enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const nextHost = listenHostFor(enabled, envBindHost)
  if (enabled === localApi.lanEnabled && nextHost === localApi.bindHost && httpServer.listening) return { ok: true }
  if (nextHost === localApi.bindHost && httpServer.listening) {
    localApi.lanEnabled = enabled
    if (enabled) ensureWatchToken()
    return { ok: true }
  }
  const previousHost = localApi.bindHost
  const previousEnabled = localApi.lanEnabled
  try {
    await closeListeningServer(httpServer, dropSseClients)
    await listenOn(httpServer, port, nextHost)
    localApi.bindHost = nextHost
    localApi.lanEnabled = enabled
    if (enabled) ensureWatchToken()
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      if (!httpServer.listening) await listenOn(httpServer, port, previousHost)
      localApi.bindHost = previousHost
      localApi.lanEnabled = previousEnabled
    } catch {
      try {
        await listenOn(httpServer, port, previousHost || '127.0.0.1')
        localApi.bindHost = previousHost || '127.0.0.1'
        localApi.lanEnabled = previousEnabled
      } catch { /* last-resort bind failed; the next request will error */ }
    }
    return { ok: false, error: `Could not ${enabled ? 'listen on the LAN' : 'return to this computer only'}: ${message}` }
  }
}

function listenFailureMessage(error: NodeJS.ErrnoException) {
  return error.code === 'EADDRINUSE'
    ? `Relay Chat Dock is already running on port ${port}. Use the window that is already open.`
    : `Relay backend failed to start: ${error.message}`
}

function printListenBanner() {
  youtube.ensureYouTubeQuotaDay()
  youtube.collapseYouTubeHydrationDuplicates()
  const base = `http://127.0.0.1:${port}`
  const missing = streamElementsJwtSlots().filter((slot) => !slot.jwt).map((slot) => slot.platform)
  console.log(`Relay Chat Dock v${getCurrentVersion()}`)
  console.log(`Data  ${dataDir}`)
  console.log(`Log   ${resolveLogFilePath(filesDir)}`)
  if (process.env.RELAY_ELECTRON !== '1') {
    console.log(`Chat dock      ${base}`)
    console.log(`Activity dock  ${base}/activity`)
  }
  if (localApi.lanEnabled) {
    console.log(watchLogLine(currentWatchUrl()))
    console.log(apiToken
      ? 'LAN browsers can only open the watch link. Tools must send RELAY_API_TOKEN to write.'
      : 'LAN browsers can only open the watch link. Set RELAY_API_TOKEN before a tool on another device can write.')
  } else {
    console.log(stickyLanBind(envBindHost)
      ? watchOffLogLine(envBindHost)
      : 'Watch is off. Turn it on from the Relay Chat Dock window to share a readonly link.')
  }
  if (envKeysAdded.length) console.log(`Env file added ${envKeysAdded.join(', ')} (existing values kept).`)
  if (youtube.youtubeQuotaUsed) console.log(`YouTube quota ${youtube.youtubeQuotaUsed.toLocaleString()} / ${youtube.youtubeQuotaLimit.toLocaleString()}`)
  youtube.listenForYouTubeQuotaInput()
  void checkForUpdates()
  if (missing.length && !settings.ignoreMissingJwt) {
    const keys = missing.map((platform) => `STREAMELEMENTS_JWT_${platform.toUpperCase()}`).join(', ')
    console.error(`  StreamElements  missing JWT${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
    console.error(`  Add ${keys} in the Relay Chat Dock window or production.env.`)
    console.error('')
  }
  openCompanionWindow()
}

export const relayReady = new Promise<number>((resolve, reject) => {
  void listenOn(httpServer, port, localApi.bindHost).then(() => {
    printListenBanner()
    resolve(port)
  }, (error: NodeJS.ErrnoException) => {
    const message = listenFailureMessage(error)
    console.error(message)
    reject(error)
    holdConsoleAndExit(1, message)
  })
})
function openCompanionWindow() {
  if (!serverShouldOpenWindow({ packaged: isPackaged, platform: process.platform, argv: process.argv, env: process.env })) return
  const native = findCompanionExe([exeDir, path.join(exeDir, 'deploy')], fs.existsSync)
  if (native) {
    const plan = nativeWindowPlan(native, `http://127.0.0.1:${port}/console`)
    const child = spawn(plan.command, plan.args, plan.options)
    companionChild = child
    child.on('exit', (code) => {
      companionChild = undefined
      if (code === 2 || companionShutdown) return
      shutdownCompanion()
    })
    child.on('error', (error) => {
      console.error('Companion window:', error.message)
      windowsMessageBox('Relay Chat Dock is running, but the companion window failed to open. OBS docks can still use the usual URLs.', 'Relay Chat Dock')
    })
    console.log('  Companion window  opening')
    return
  }
  windowsMessageBox(`Relay Chat Dock is running, but relay-chat-dock-window.exe was not found beside the app.\n\nOBS docks still use http://127.0.0.1:${port}`, 'Relay Chat Dock')
}

for (const platform of ['Twitch', 'Kick', 'YouTube'] as Platform[]) if (tokens[platform]) startAdapter(platform)
void startStreamElements(true)
void pollLiveState()
setInterval(() => { void pollLiveState() }, LIVE_STATUS_POLL_MS)
setInterval(() => twitch.watchTwitchEventSub(), 2_000)
setInterval(refreshChatHealth, 5_000)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    flushChatSave()
    ingestLog.flush()
    flushRelayLog()
    process.exit(0)
  })
}

setInterval(() => {
  pushSse(sseNamedEvent('ping', { seq: sseSeq }))
}, 15_000).unref()
setInterval(() => {
  if (!clients.size) return
  state.activity = activityStore.list()
  pushSse(sseNamedEvent('snapshot', { seq: sseSeq, ...state }))
}, 60_000).unref()
function loadTokens(): Partial<Record<TokenPlatform, Token>> {
  const parsed = readJsonFile<unknown>(tokenFile, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Partial<Record<TokenPlatform, Token>>
}

function persistStreamInfo() {
  const next = { Twitch: { ...state.streamInfo.Twitch }, Kick: { ...state.streamInfo.Kick }, YouTube: { ...state.streamInfo.YouTube } }
  if (JSON.stringify(settings.streamInfo) === JSON.stringify(next)) return
  settings.streamInfo = next
  saveSettings()
}

function loadSettings(): AppSettings {
  return readJsonFile(settingsFile, defaultAppSettings(), parseAppSettings)
}

function saveSettings() {
  writeJsonAtomic(settingsFile, settings)
}
function saveTokens() { writeJsonAtomic(tokenFile, tokens) }
