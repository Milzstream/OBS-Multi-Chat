import crypto from 'node:crypto'
import fs from 'node:fs'
import type { Express, Response } from 'express'
import { ACTIVITY_MAX_AGE_MS, type ActivityEvent } from './activity.js'
import { getCurrentVersion } from './check-update.js'
import { looksLikeJwt, setEnvKey, STREAMELEMENTS_JWT_KEYS, syncEnvFile, writeTextAtomic } from './env-file.js'
import {
  applyOutgoingSendResult,
  clampAlertSeconds,
  mergeAutoLiveCheck,
  missingStreamElementsMessage,
  normalizeTags,
  parseAlertDisabled,
  parseAlertLooks,
  parseMentionKeywords,
  parseYouTubeQuotaInput,
  sseNamedEvent,
  youtubePublicVideoBody,
  youtubeVideoId,
  type YoutubePrivacyNotice,
  type YoutubePrivacyWatch,
} from './logic.js'
import { createOpenHandler, isTrustedOrigin, openInDefaultBrowser, watchLogLine, watchOffLogLine } from './local-api.js'
import { registerAlertAssetRoutes } from './alert-assets.js'
import { fetchMedia } from './media-proxy.js'
import { OAUTH_STATE_TTL_MS, type createOAuthStateStore } from './oauth-state.js'
import { moderationLogLine } from './operator-log.js'
import { postStreamElementsMock, streamElementsEmulateName, streamElementsEmulatePlan, streamElementsMockActivity, type StreamElementsChannel } from './streamelements.js'
import type {
  AlertSettings,
  AppSettings,
  ChatMessage,
  ChatModeration,
  Health,
  Platform,
  StreamDetails,
  StreamPlatform,
  Token,
  TokenPlatform,
} from './types.js'
import type { YouTubeChatTarget } from './youtube-chat.js'

const YOUTUBE_QUOTA_PAGE = 'https://console.cloud.google.com/iam-admin/quotas?service=youtube.googleapis.com'

export type HttpRouteDeps = {
  state: {
    accounts: { platform: Platform; connected: boolean; live: boolean; viewers: number; handle: string }[]
    streamInfo: AppSettings['streamInfo']
    messages: ChatMessage[]
    health: Record<Platform, Health>
    activity: ActivityEvent[]
    activityWarnings: string[]
    chatWarnings: string[]
    youtubePrivacy: YoutubePrivacyNotice[]
    streamelements: { connected: boolean; handle: string; missing: string[]; connecting: boolean }
    activityFallback: boolean
    ignoreMissingJwt: boolean
    dropOldAlerts: boolean
    translateChat: boolean
    translateError: string
    mentionKeywords: string[]
    alerts: AlertSettings
    activityMax: number
    autoLiveCheck: AppSettings['autoLiveCheck']
    youtubeQuota: { used: number; limit: number }
  }
  tokens: Partial<Record<TokenPlatform, Token>>
  settings: AppSettings
  activityStore: { list: () => ActivityEvent[]; remove: (id: string) => boolean; setMaxAge: (ms: number) => void }
  port: number
  envPath: string
  dataDir: string
  envTemplatePath: string
  envBindHost: string
  localApi: { port: number; bindHost: string; lanEnabled: boolean; apiToken?: string; watchToken?: string }
  currentWatchUrl: () => string | undefined
  relayLogs: { lines: () => { id: number }[]; since: (after: number) => { id: number }[]; subscribe: (write: (line: { id: number }) => void) => () => void }
  companionHost: { hello: () => void; bye: () => boolean }
  shutdownCompanion: () => void
  applyManualYouTubeQuota: (line: string) => void
  writeSse: (client: Response, chunk: string) => void
  clients: Set<Response>
  sendMessage: (platform: Platform, text: string) => Promise<any>
  rememberOutgoing: (entry: { id: string; text: string; platforms: Platform[]; at: number }) => void
  addMessage: (message: ChatMessage, options?: { preload?: boolean; ingest?: 'official' | 'innertube'; source?: string }) => void
  scheduleChatSave: () => void
  broadcast: () => void
  moderate: (platform: Platform, body: { action: string; messageId?: string; userId?: string; sourceId?: string; duration?: number; reason?: string }) => Promise<{ ok: boolean; error?: string; reason?: string }>
  applyChatModerationToState: (change: ChatModeration) => boolean
  youtubePrivacyDismissed: Set<string>
  setYoutubePrivacy: (notices: YoutubePrivacyNotice[]) => void
  youtubeQuotaBlocked: () => boolean
  ensureToken: (platform: Platform) => Promise<Token | undefined>
  youtubeApi: (endpoint: string, token: Token, options?: RequestInit) => Promise<any>
  searchCategories: (platform: StreamPlatform, query: string) => Promise<{ id: string; name: string }[]>
  updateStreamInfo: (platform: StreamPlatform, info: StreamDetails) => Promise<{ platform: StreamPlatform; ok: boolean; error?: string; skipped?: boolean; warning?: string }>
  persistStreamInfo: () => void
  subscribeTwitchEvents: (sessionId: string, generation?: number) => Promise<void>
  setActivityWarning: (key: string, message?: string) => void
  setChatWarning: (key: string, message?: string) => void
  setHealth: (platform: Platform, status: Health['status'], message?: string) => void
  saveSettings: () => void
  saveTokens: () => void
  checkLiveNow: (platform: Platform) => Promise<void>
  rebindForWatch: (enabled: boolean) => Promise<{ ok: true } | { ok: false; error: string }>
  streamElementsJwtSlots: () => Array<{ platform: 'Twitch' | 'Kick' | 'YouTube'; jwt: string }>
  startStreamElements: (backfill?: boolean) => Promise<Array<{ platform: 'Twitch' | 'Kick' | 'YouTube'; message: string }>>
  streamElementsChannelFor: (provider: string, anyChannel?: boolean) => Promise<StreamElementsChannel | undefined>
  closeTwitchChat: () => void
  kickChat: { stop: () => Promise<void> }
  setYouTubeTargets: (targets: YouTubeChatTarget[]) => void
  youtubeStreamViewers: Map<string, number>
  publishYouTubeStreams: () => void
  youtubeChat: { stop: () => Promise<void> }
  announcedYoutubePrivacy: Set<string>
  startAdapter: (platform: Platform) => void
  authorizationUrl: (platform: Platform) => string | null
  exchangeCode: (platform: Platform, code: string, codeVerifier?: string) => Promise<Token>
  oauthStates: ReturnType<typeof createOAuthStateStore>
  get sseSeq(): number
  get twitchEventSubSessionId(): string
  get youtubeForceStatus(): boolean
  set youtubeForceStatus(value: boolean)
  get youtubePrivacyWatch(): Array<YoutubePrivacyWatch & { status?: Record<string, unknown> }>
  set youtubePrivacyWatch(value: Array<YoutubePrivacyWatch & { status?: Record<string, unknown> }>)
}

/** `/api/*`, `/events`, and `/oauth/*` HTTP handlers. */
export function registerHttpRoutes(app: Express, d: HttpRouteDeps): void {
  const {
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
    applyManualYouTubeQuota,
    writeSse,
    clients,
    sendMessage,
    rememberOutgoing,
    addMessage,
    scheduleChatSave,
    broadcast,
    moderate,
    applyChatModerationToState,
    youtubePrivacyDismissed,
    setYoutubePrivacy,
    youtubeQuotaBlocked,
    ensureToken,
    youtubeApi,
    searchCategories,
    updateStreamInfo,
    persistStreamInfo,
    subscribeTwitchEvents,
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
    closeTwitchChat,
    kickChat,
    setYouTubeTargets,
    youtubeStreamViewers,
    publishYouTubeStreams,
    youtubeChat,
    announcedYoutubePrivacy,
    startAdapter,
    authorizationUrl,
    exchangeCode,
    oauthStates,
  } = d

  registerAlertAssetRoutes(app, dataDir)

  app.get('/api/state', (_request, response) => {
    state.activity = activityStore.list()
    response.json({ seq: d.sseSeq, ...state })
  })
  app.get('/api/console', (_request, response) => {
    const base = `http://127.0.0.1:${port}`
    response.json({ version: getCurrentVersion(), envPath, dataDir, chatUrl: base, activityUrl: `${base}/activity`, alertsUrl: `${base}/alerts`, lanEnabled: localApi.lanEnabled, watchUrl: currentWatchUrl() || null })
  })
  app.get('/api/logs', (request, response) => {
    const after = Number(request.query.after || 0)
    response.json({ lines: Number.isFinite(after) && after > 0 ? relayLogs.since(after) : relayLogs.lines() })
  })
  app.get('/events/logs', (request, response) => {
    const headers: Record<string, string> = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
    response.writeHead(200, headers)
    const write = (line: { id: number }) => {
      if (!response.writableEnded) response.write(`data: ${JSON.stringify(line)}\n\n`)
    }
    const unsubscribe = relayLogs.subscribe(write)
    for (const line of relayLogs.lines()) write(line)
    request.on('close', () => unsubscribe())
  })
  app.post('/api/console/host', (_request, response) => {
    companionHost.hello()
    response.json({ ok: true })
  })
  app.post('/api/console/bye', (_request, response) => {
    response.json({ ok: true, scheduled: companionHost.bye() })
  })
  app.post('/api/shutdown', (_request, response) => {
    response.json({ ok: true })
    response.on('finish', () => shutdownCompanion())
  })
  app.post('/api/youtube-quota', (request, response) => {
    const input = String((request.body as { input?: string } | undefined)?.input || '').trim()
    const parsed = parseYouTubeQuotaInput(input)
    if (!parsed || parsed.kind === 'help') return response.status(400).json({ error: 'Type usage like 35 or 35/10000' })
    applyManualYouTubeQuota(input)
    response.json({ ok: true, youtubeQuota: state.youtubeQuota })
  })
  app.post('/api/console/quota-page', (_request, response) => {
    openInDefaultBrowser(YOUTUBE_QUOTA_PAGE)
    response.json({ ok: true })
  })
  app.get('/api/media', async (request, response) => {
    try {
      const result = await fetchMedia(String(request.query.u || ''))
      if (!result.ok) return response.status(result.status).end()
      response.setHeader('Content-Type', result.contentType)
      response.setHeader('Cache-Control', 'public, max-age=86400')
      response.end(result.body)
    } catch {
      if (!response.headersSent) response.status(502).end()
    }
  })
  app.get('/events', (request, response) => {
    const headers: Record<string, string> = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
    const origin = request.get('origin')
    if (origin && isTrustedOrigin(origin, localApi, request.get('host'))) headers['Access-Control-Allow-Origin'] = origin
    response.writeHead(200, headers)
    state.activity = activityStore.list()
    writeSse(response, sseNamedEvent('snapshot', { seq: d.sseSeq, ...state }))
    clients.add(response)
    request.on('close', () => {
      clients.delete(response)
      console.log(`SSE client dropped (${clients.size} left)`)
    })
  })
  app.post('/api/messages', async (request, response) => {
    const { platforms, text } = request.body as { platforms?: Platform[]; text?: string }
    if (!text?.trim() || !platforms?.length) return response.status(400).json({ error: 'platforms and text are required' })
    const trimmed = text.trim()
    const id = crypto.randomUUID()
    const user = tokens[platforms.find((platform) => tokens[platform]) || platforms[0]]?.user || 'You'
    rememberOutgoing({ id, text: trimmed, platforms, at: Date.now() })
    addMessage({ id, platform: platforms[0], platforms, user, text: trimmed, time: new Date().toISOString() }, { source: 'send' })
    const results = await Promise.all(platforms.map((platform) => sendMessage(platform, trimmed)))
    const applied = applyOutgoingSendResult(state.messages, id, results)
    if (applied.changed) {
      state.messages = applied.messages
      scheduleChatSave()
      broadcast()
    }
    response.json({ results })
  })
  app.post('/api/moderate', async (request, response) => {
      const body = request.body as { action?: string; platform?: Platform; messageId?: string; userId?: string; sourceId?: string; duration?: number; reason?: string }
      if (!body.action || !body.platform) return response.status(400).json({ error: 'action and platform are required' })
      try {
        const result = await moderate(body.platform, { action: body.action, messageId: body.messageId, userId: body.userId, sourceId: body.sourceId, duration: body.duration, reason: body.reason })
      if (result.ok && (body.action === 'delete' || body.action === 'timeout' || body.action === 'ban' || body.action === 'unban')) {
        const target = state.messages.find((item) => item.id === body.messageId)
        const applied = applyChatModerationToState({
          action: body.action,
          platform: body.platform,
          messageId: body.messageId,
          userId: body.userId,
          user: target?.user,
        })
        if (!applied) console.log(moderationLogLine(body.action, body.platform, target?.user))
      }
      response.json(result)
    } catch (error) {
      response.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/youtube/privacy', async (request, response) => {
    const body = request.body as { videoIds?: unknown; action?: string }
    const action = body.action === 'dismiss' ? 'dismiss' : 'public'
    const requested = Array.isArray(body.videoIds) ? body.videoIds.map(youtubeVideoId).filter((id): id is string => Boolean(id)) : []
    const allowed = new Set([...state.youtubePrivacy.map((item) => item.videoId), ...d.youtubePrivacyWatch.map((item) => item.videoId)])
    const videoIds = [...new Set(requested.filter((id) => allowed.has(id)))].slice(0, 10)
    if (!videoIds.length) return response.status(400).json({ ok: false, error: 'No YouTube broadcast to update' })
    if (action === 'dismiss') {
      for (const id of videoIds) youtubePrivacyDismissed.add(id)
      setYoutubePrivacy(state.youtubePrivacy.filter((item) => !youtubePrivacyDismissed.has(item.videoId)))
      return response.json({ ok: true, dismissed: videoIds })
    }
    if (youtubeQuotaBlocked()) return response.status(429).json({ ok: false, error: 'YouTube API quota exceeded until midnight Pacific' })
    const token = await ensureToken('YouTube')
    if (!token) return response.status(400).json({ ok: false, error: 'YouTube is not connected' })
    const updated: string[] = []
    const errors: string[] = []
    for (const videoId of videoIds) {
      const watched = d.youtubePrivacyWatch.find((item) => item.videoId === videoId)
      try {
        await youtubeApi('/videos?part=status', token, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(youtubePublicVideoBody(videoId, watched?.status)),
        })
        updated.push(videoId)
        youtubePrivacyDismissed.delete(videoId)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (updated.length) {
      setYoutubePrivacy(state.youtubePrivacy.filter((item) => !updated.includes(item.videoId)))
      console.log(`YouTube privacy set to public: ${updated.join(', ')}`)
    }
    if (!updated.length) return response.status(502).json({ ok: false, error: errors[0] || 'Could not make the video public' })
    response.json({ ok: true, updated, error: errors.length ? errors.join(' | ') : undefined })
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
    const { title, category, categoryId, tags } = request.body as Partial<StreamDetails>
    const normalizedTags = normalizeTags(tags)
    const details = { title: String(title || '').trim(), category: String(category || '').trim(), ...(categoryId ? { categoryId: String(categoryId) } : {}), ...(normalizedTags ? { tags: normalizedTags } : {}) }
    try {
      const result = await updateStreamInfo(platform, details)
      if (result.ok) {
        state.streamInfo[platform] = details
        persistStreamInfo()
      }
      broadcast()
      response.json({ streamInfo: state.streamInfo, results: [result] })
    } catch (error) {
      console.error('Stream info:', error instanceof Error ? error.message : error)
      if (!response.headersSent) response.status(502).json({ error: error instanceof Error ? error.message : 'Could not update stream info' })
    }
  })
  app.post('/api/stream-info', async (request, response) => {
    const { title, Twitch, Kick } = request.body as { title?: string; Twitch?: StreamDetails; Kick?: StreamDetails }
    const sharedTitle = String(title || '').trim()
    const detailsByPlatform = {
      Twitch: { category: '', ...Twitch, title: sharedTitle, tags: normalizeTags(Twitch?.tags) || [] },
      Kick: { category: '', ...Kick, title: sharedTitle, tags: normalizeTags(Kick?.tags) || [] },
    }
    try {
      const results = await Promise.all((['Twitch', 'Kick'] as StreamPlatform[]).map((platform) => updateStreamInfo(platform, detailsByPlatform[platform])))
      let changed = false
      for (const result of results) {
        if (!result.ok || ('skipped' in result && result.skipped)) continue
        state.streamInfo[result.platform] = detailsByPlatform[result.platform]
        changed = true
      }
      if (changed) persistStreamInfo()
      broadcast()
      response.json({ streamInfo: state.streamInfo, results })
    } catch (error) {
      console.error('Stream info:', error instanceof Error ? error.message : error)
      if (!response.headersSent) response.status(502).json({ error: error instanceof Error ? error.message : 'Could not update stream info' })
    }
  })
  app.post('/api/settings', async (request, response) => {
    const body = request.body as { activityFallback?: boolean; ignoreMissingJwt?: boolean; dropOldAlerts?: boolean; translateChat?: boolean; mentionKeywords?: unknown; autoLiveCheck?: Partial<Record<Platform, boolean>>; lanWatch?: boolean; alerts?: Partial<AlertSettings> }
    let changed = false
    let watchError = ''
    const turnedOn: Platform[] = []
    if (typeof body.activityFallback === 'boolean' && body.activityFallback !== settings.activityFallback) {
      settings.activityFallback = body.activityFallback
      state.activityFallback = body.activityFallback
      if (body.activityFallback && d.twitchEventSubSessionId && tokens.Twitch) void subscribeTwitchEvents(d.twitchEventSubSessionId)
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
    if (typeof body.translateChat === 'boolean' && body.translateChat !== settings.translateChat) {
      settings.translateChat = body.translateChat
      state.translateChat = body.translateChat
      changed = true
    }
    if (Array.isArray(body.mentionKeywords)) {
      const words = parseMentionKeywords(body.mentionKeywords)
      if (JSON.stringify(words) !== JSON.stringify(settings.mentionKeywords)) {
        settings.mentionKeywords = words
        state.mentionKeywords = [...words]
        changed = true
      }
    }
    let watchChanged = false
    if (typeof body.lanWatch === 'boolean' && body.lanWatch !== localApi.lanEnabled) {
      const rebound = await rebindForWatch(body.lanWatch)
      if (rebound.ok) {
        settings.lanWatch = body.lanWatch
        watchChanged = true
        console.log(body.lanWatch ? watchLogLine(currentWatchUrl()) : watchOffLogLine(envBindHost))
      } else {
        watchError = rebound.error
        console.error(watchError)
      }
    }
    if (body.autoLiveCheck && typeof body.autoLiveCheck === 'object') {
      const next = mergeAutoLiveCheck(settings.autoLiveCheck, body.autoLiveCheck)
      for (const platform of ['Twitch', 'Kick', 'YouTube'] as const) {
        if (next[platform] && !settings.autoLiveCheck[platform]) turnedOn.push(platform)
      }
      if (next.Twitch !== settings.autoLiveCheck.Twitch || next.Kick !== settings.autoLiveCheck.Kick || next.YouTube !== settings.autoLiveCheck.YouTube) {
        const youtubeTurnedOn = next.YouTube && !settings.autoLiveCheck.YouTube
        settings.autoLiveCheck = next
        state.autoLiveCheck = { ...next }
        if (youtubeTurnedOn) d.youtubeForceStatus = true
        changed = true
      }
    }
    if (body.alerts && typeof body.alerts === 'object' && !Array.isArray(body.alerts)) {
      const patch = body.alerts
      const next = { ...settings.alerts, disabled: [...settings.alerts.disabled] }
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      if (typeof patch.sound === 'boolean') next.sound = patch.sound
      if (typeof patch.showPlatform === 'boolean') next.showPlatform = patch.showPlatform
      if (patch.displaySec !== undefined) next.displaySec = clampAlertSeconds(patch.displaySec, next.displaySec)
      if (Array.isArray(patch.disabled)) next.disabled = parseAlertDisabled(patch.disabled)
      if (patch.looks !== undefined) {
        const looks = parseAlertLooks(patch.looks)
        if (looks) next.looks = looks
        else delete next.looks
      }
      if (JSON.stringify(next) !== JSON.stringify(settings.alerts)) {
        settings.alerts = next
        state.alerts = { ...next, disabled: [...next.disabled] }
        changed = true
      }
    }
    if (changed || watchChanged) saveSettings()
    if (changed) broadcast()
    const payload = {
      activityFallback: settings.activityFallback,
      ignoreMissingJwt: settings.ignoreMissingJwt,
      dropOldAlerts: settings.dropOldAlerts,
      translateChat: settings.translateChat,
      mentionKeywords: settings.mentionKeywords,
      autoLiveCheck: settings.autoLiveCheck,
      alerts: settings.alerts,
      streamelements: state.streamelements,
      lanEnabled: localApi.lanEnabled,
      watchUrl: currentWatchUrl() || null,
    }
    // Turning Auto back on should notice a live change without waiting out YouTube's slow interval.
    for (const platform of turnedOn) {
      if (!tokens[platform]) continue
      void checkLiveNow(platform).catch((error) => console.error(`${platform} live check:`, error instanceof Error ? error.message : error))
    }
    if (watchError) return response.status(503).json({ error: watchError, ...payload })
    response.json(payload)
  })
  app.get('/api/jwts', (_request, response) => {
    const slots = streamElementsJwtSlots()
    response.json(Object.fromEntries(slots.map((slot) => [slot.platform, slot.jwt])))
  })
  app.post('/api/jwts', async (request, response) => {
    const body = request.body as Partial<Record<'Twitch' | 'Kick' | 'YouTube', string>>
    const platforms = ['Twitch', 'Kick', 'YouTube'] as const
    let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    if (!text) {
      try { syncEnvFile(envPath, envTemplatePath) } catch { /* ignore */ }
      text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    }
    const saved: Array<'Twitch' | 'Kick' | 'YouTube'> = []
    for (const platform of platforms) {
      if (!Object.prototype.hasOwnProperty.call(body, platform)) continue
      const value = String(body[platform] ?? '').trim()
      if (value && !looksLikeJwt(value)) return response.status(400).json({ error: `${platform} JWT is not valid` })
      const key = STREAMELEMENTS_JWT_KEYS[platform]
      text = setEnvKey(text, key, value, true)
      process.env[key] = value
      saved.push(platform)
    }
    let failed: Array<{ platform: 'Twitch' | 'Kick' | 'YouTube'; message: string }> = []
    if (saved.length) {
      try {
        writeTextAtomic(envPath, text)
      } catch (error) {
        console.error('StreamElements JWT save:', error instanceof Error ? error.message : error)
        return response.status(500).json({ error: 'Could not save StreamElements JWTs' })
      }
      failed = await startStreamElements(false)
    }
    const slots = streamElementsJwtSlots()
    const error = failed.filter((item) => saved.includes(item.platform)).map((item) => item.message).join(' ')
    response.json({
      tokens: Object.fromEntries(slots.map((slot) => [slot.platform, slot.jwt])),
      error: error || undefined,
    })
  })
  app.post('/api/open', createOpenHandler(openInDefaultBrowser))
  app.post('/api/activity/delete', (request, response) => {
    const id = String((request.body as { id?: string } | undefined)?.id || '').trim()
    if (!id) return response.status(400).json({ error: 'id is required' })
    if (!activityStore.remove(id)) return response.status(404).json({ error: 'Activity not found' })
    state.activity = activityStore.list()
    broadcast()
    response.json({ ok: true })
  })
  app.post('/api/activity/test', async (request, response) => {
    const body = request.body as Partial<ActivityEvent>
    const platform = body.platform
    const kind = body.kind
    if (!platform || !kind) return response.status(400).json({ error: 'platform and kind are required' })
    const plan = streamElementsEmulatePlan(platform, kind)
    if (!plan) return response.status(400).json({ error: 'That test is not a StreamElements emulate option' })
    try {
      const channel = await streamElementsChannelFor(plan.provider, platform === 'StreamElements')
      if (!channel) return response.status(400).json({ error: `Connect StreamElements for ${plan.provider} first` })
      const provider = (channel.provider || plan.provider).toLowerCase()
      const name = streamElementsEmulateName()
      const activity = streamElementsMockActivity({ ...plan, provider, name })
      await postStreamElementsMock(channel, activity)
      console.log(`StreamElements emulate: ${provider} ${plan.type} (${name})`)
      response.json({ ok: true, name, type: plan.type })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'StreamElements emulate failed'
      console.error(message)
      response.status(502).json({ error: message })
    }
  })
  app.post('/api/disconnect/:platform', (request, response) => {
    const platform = ['Twitch', 'Kick', 'YouTube'].find((item) => item.toLowerCase() === request.params.platform.toLowerCase()) as Platform | undefined
    if (!platform) return response.status(404).json({ error: 'Unknown platform' })
    delete tokens[platform]
    saveTokens()
    const account = state.accounts.find((item) => item.platform === platform)
    if (account) Object.assign(account, { connected: false, live: false, viewers: 0, handle: '' })
    if (platform === 'Twitch') { closeTwitchChat(); setActivityWarning('twitch-scopes'); setChatWarning('twitch-moderate') }
    if (platform === 'Kick') void kickChat.stop()
    if (platform === 'YouTube') { setYouTubeTargets([]); youtubeStreamViewers.clear(); publishYouTubeStreams(); d.youtubePrivacyWatch = []; youtubePrivacyDismissed.clear(); announcedYoutubePrivacy.clear(); setYoutubePrivacy([]); void youtubeChat.stop() }
    setHealth(platform, 'ok')
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
    if (!code || !platform || Date.now() - oauthState.createdAt > OAUTH_STATE_TTL_MS) return response.status(400).send('OAuth callback is missing a valid state or code.')
    oauthStates.delete(String(request.query.state))
    try {
      tokens[platform] = await exchangeCode(platform, code, oauthState.codeVerifier)
      saveTokens()
      const account = state.accounts.find((item) => item.platform === platform)
      if (account) Object.assign(account, { connected: true, handle: tokens[platform]?.user || platform })
      setHealth(platform, 'ok')
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
}
