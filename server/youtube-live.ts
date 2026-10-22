import path from 'node:path'
import { fetchTimed } from './fetch-timed.js'
import {
  YOUTUBE_QUOTA_LIMIT,
  collapseYouTubeDuplicates,
  isDailyQuotaHeader,
  isEndedYouTubeChat,
  loadYoutubeBanIds,
  looksLikePlaceholder,
  nextPacificMidnight,
  nextYoutubePrivacyWatch,
  normalizeAvatar,
  pacificDate,
  parseYouTubeQuotaInput,
  quotaFromHeaders,
  quotaWarnAt,
  resolveYouTubeLiveChatIds,
  restoreYouTubeQuotaBlock,
  shouldRunYouTubeStatusCheck,
  syncYouTubeTokenChatIds,
  youtubeApiErrorReason,
  youtubeBadges,
  youtubeBanChatIds,
  youtubeBanRecord,
  youtubeChatLabel,
  youtubeInsertedMessageId,
  youtubeLiveChatBanSnippet,
  youtubeLiveChatCursor,
  youtubeLiveChatListQuery,
  youtubeLiveChatMessageBody,
  youtubeOfficialModeration,
  youtubeOfficialToActivity,
  youtubePrivacyMessage,
  youtubePrivacyNotices,
  youtubePrivacyRecheckIds,
  youtubePrivacyValue,
  youtubeQuotaCost,
  youtubeQuotaHealthStatus,
  youtubeQuotaLabel,
  youtubeScrapedTarget,
  youtubeSendGuard,
  youtubeStatusIntervalMs,
  type YoutubePrivacyNotice,
  type YoutubePrivacyWatch,
} from './logic.js'
import { readJsonFile, writeJsonAtomic } from './persist.js'
import type { Account, AppSettings, ChatMessage, ChatModeration, Health, Platform, StreamInfoMap, Token, TokenPlatform, YoutubeQuotaStatus } from './types.js'
import { YouTubeLiveChat, youtubeViewersWhileLive, type YouTubeChatMessage, type YouTubeChatTarget, type YouTubeModeration } from './youtube-chat.js'
import type { ActivityEvent } from './activity.js'

export type YoutubeLiveDeps = {
  tokens: Partial<Record<TokenPlatform, Token>>
  state: {
    accounts: Account[]
    messages: ChatMessage[]
    streamInfo: StreamInfoMap
    health: Record<Platform, Health>
    youtubePrivacy: YoutubePrivacyNotice[]
    youtubeQuota: YoutubeQuotaStatus
  }
  settings: AppSettings
  dataDir: string
  ensureToken: (platform: Platform) => Promise<Token | undefined>
  refreshAccessToken: (platform: Platform) => Promise<Token | undefined>
  hydrateYouTubeToken: (token: Token) => Promise<void>
  saveTokens: () => void
  saveSettings: () => void
  restorePlatformConnection: (platform: Platform) => void
  setHealth: (platform: Platform, status: Health['status'], message?: string) => void
  addMessage: (message: ChatMessage, options?: { preload?: boolean; ingest?: 'official' | 'innertube'; source?: string }) => void
  addNativeActivity: (event: ActivityEvent) => void
  applyChatModerationToState: (change: ChatModeration) => boolean
  ownHandles: () => Set<string>
  ownUserIds: () => Set<string>
  scheduleChatSave: () => void
  broadcast: () => void
}

/** Official Data API, quota bookkeeping, and InnerTube ingest glue. */
export function createYouTubeLive(d: YoutubeLiveDeps) {
  const {
    tokens,
    state,
    settings,
    dataDir,
    ensureToken,
    refreshAccessToken,
    hydrateYouTubeToken,
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
  } = d

  const youtubeChat = new YouTubeLiveChat()
  const youtubeSeen = new Set<string>()
  const youtubeChatLabels = new Map<string, string>()
  let youtubeQuotaLimit = YOUTUBE_QUOTA_LIMIT
  let youtubeQuotaBlockedUntil = 0
  let youtubeQuotaUsed = 0
  let youtubeQuotaDay = ''
  let youtubeQuotaWarnLogged = false
  let youtubeQuotaHeaderLogged = false
  let lastYouTubeStatusAt = 0
  let lastYouTubeOfficialChatAt = 0
  const youtubeOfficialCursors = new Map<string, { pageToken?: string; waitMs: number }>()
  let youtubePollTail: Promise<void> = Promise.resolve()
  let lastYouTubeViewersAt = 0
  let youtubeForceStatus = true
  let youtubeTargets: YouTubeChatTarget[] = []
  const youtubeStreamViewers = new Map<string, number>()
  let youtubePrivacyWatch: Array<YoutubePrivacyWatch & { status?: Record<string, unknown> }> = []
  const youtubePrivacyDismissed = new Set<string>()
  const announcedYoutubePrivacy = new Set<string>()
  let lastYoutubePrivacyRecheck = 0
  const youtubeHistorySeeded = new Set<string>()
  const YOUTUBE_VIEWERS_MS = 45_000
  const YOUTUBE_OFFICIAL_CHAT_MS = 45_000
  const YOUTUBE_HYDRATE_MS = 20_000
  let youtubeHydratingUntil = 0
  const youtubeBanFile = path.join(dataDir, 'youtube-bans.json')
  const youtubeBanIds = loadYoutubeBanIds(readJsonFile(youtubeBanFile, {}))

  function beginYouTubeHydration() {
    // InnerTube and the official history seed deliver the same messages; re-run duplicate collapse while we are ingesting
    const wasInactive = Date.now() >= youtubeHydratingUntil
    youtubeHydratingUntil = Math.max(youtubeHydratingUntil, Date.now() + YOUTUBE_HYDRATE_MS)
    if (wasInactive) collapseYouTubeHydrationDuplicates()
  }

  function collapseYouTubeHydrationDuplicates() {
    const result = collapseYouTubeDuplicates(state.messages, youtubeTargets, { ownHandles: ownHandles(), ownUserIds: ownUserIds() })
    if (!result.changed) return
    for (const id of result.seenIds) youtubeSeen.add(id)
    state.messages = result.messages
    scheduleChatSave()
    broadcast()
  }

  /** Remember which YouTube messages we have seen so a restart re-seeds the history buffer without re-sending the same messages to the docks. */
  function rememberYouTubeFromChat(messages: ChatMessage[]) {
    for (const item of messages) {
      if (item.platform !== 'YouTube') continue
      if (item.id) youtubeSeen.add(item.id)
      if (item.sourceId) youtubeHistorySeeded.add(item.sourceId)
    }
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
    const next = {
      day: youtubeQuotaDay || pacificDate(),
      used: youtubeQuotaUsed,
      limit: youtubeQuotaLimit,
      ...(youtubeQuotaBlockedUntil > Date.now() ? { blockedUntil: youtubeQuotaBlockedUntil } : {}),
    }
    const saved = settings.youtubeQuota
    if (saved.day === next.day && saved.used === next.used && saved.limit === next.limit && (saved.blockedUntil || 0) === (next.blockedUntil || 0)) return
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
    youtubeQuotaBlockedUntil = sameDay ? restoreYouTubeQuotaBlock({ day: today, used: youtubeQuotaUsed, limit: youtubeQuotaLimit, blockedUntil: saved.blockedUntil }) : 0
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
    // The console number is the day's usage from the official quotas page (see below)
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

  /** Read the daily quota straight from Google's response headers when they carry it; returns false if the headers are only per-minute rate limits. */
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

  /** Add a call's known quota cost so the dock can warn before Google actually rejects us. */
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
    if (youtubeQuotaUsed >= youtubeQuotaLimit) markYouTubeQuotaExceeded()
    else if (before < youtubeQuotaWarnAt() && youtubeQuotaUsed >= youtubeQuotaWarnAt()) applyYouTubeQuotaHealth()
    else broadcast()
  }

  /** Pause all official YouTube API calls until the next Pacific midnight; site chat (InnerTube) keeps running. */
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
    persistYouTubeQuota()
    console.error(`YouTube Data API quota exceeded (${youtubeQuotaUsed.toLocaleString()} / ${youtubeQuotaLimit.toLocaleString()}). Official YouTube calls paused until midnight Pacific. Chat will use the site reader.`)
    applyYouTubeQuotaHealth()
  }

  function noteYouTubeQuota(error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    if (!/quotaExceeded|quota exceeded/i.test(text)) return false
    markYouTubeQuotaExceeded()
    return true
  }

  /** One official YouTube Data API call, gated on the daily quota, with token refresh and quota bookkeeping. */
  async function youtubeRequest(endpoint: string, token: Token, options: RequestInit = {}, retried = false): Promise<{ ok: boolean; status: number; text: string }> {
    ensureYouTubeQuotaDay()
    if (youtubeQuotaBlocked() || youtubeQuotaUsed >= youtubeQuotaLimit) {
      markYouTubeQuotaExceeded()
      throw new Error('YouTube API quota exceeded')
    }
    const method = String(options.method || 'GET').toUpperCase()
    const localized = /[?&]hl=/.test(endpoint) ? endpoint : `${endpoint}${endpoint.includes('?') ? '&' : '?'}hl=en`
    const headers = { Authorization: `Bearer ${token.accessToken}`, ...(options.headers as Record<string, string> | undefined) }
    const response = await fetchTimed(`https://www.googleapis.com/youtube/v3${localized}`, { ...options, headers }, 12_000)
    const fromHeaders = applyYouTubeQuotaHeaders(response.headers)
    if (response.status === 401 && !retried) {
      if (!fromHeaders) noteYouTubeQuotaUse(endpoint, method)
      const refreshed = await refreshAccessToken('YouTube')
      if (refreshed) return youtubeRequest(endpoint, refreshed, options, true)
      const text = await response.text()
      return { ok: false, status: response.status, text }
    }
    if (!fromHeaders) noteYouTubeQuotaUse(endpoint, method)
    const text = await response.text()
    if (response.status === 403 && /quotaExceeded/i.test(text)) markYouTubeQuotaExceeded()
    return { ok: response.ok, status: response.status, text }
  }

  /** Forget an ended YouTube live chat id so we stop polling a dead room. */
  function runYouTubePoll<T>(work: () => Promise<T>): Promise<T> {
    const run = youtubePollTail.then(work, work)
    youtubePollTail = run.then(() => undefined, () => undefined)
    return run
  }

  function dropEndedYouTubeChat(chatId: string) {
    youtubeOfficialCursors.delete(chatId)
    const token = tokens.YouTube
    if (token) {
      token.liveChatIds = (token.liveChatIds || []).filter((id) => id !== chatId)
      if (token.liveChatId === chatId) token.liveChatId = token.liveChatIds[0]
    }
    const next = youtubeTargets.filter((target) => target.liveChatId !== chatId)
    if (next.length !== youtubeTargets.length) setYouTubeTargets(next)
  }

  async function youtubeApi(endpoint: string, token: Token, options: RequestInit = {}): Promise<any> {
    const result = await youtubeRequest(endpoint, token, options)
    if (result.status === 403 && /quotaExceeded/i.test(result.text)) throw new Error('YouTube API 403 quota exceeded')
    if (!result.ok) throw new Error(`YouTube API ${result.status}: ${youtubeApiErrorReason(result.text)}`)
    return result.text ? JSON.parse(result.text) : {}
  }

  function ingestYouTubeOfficialItem(item: any, chatId: string, chatIds: string[], preload = false) {
    const moderation = youtubeOfficialModeration(item)
    if (moderation) {
      applyChatModerationToState(moderation)
      return
    }
    const user = String(item.authorDetails?.displayName || 'YouTube user').replace(/^@+/, '')
    const time = item.snippet?.publishedAt || new Date().toISOString()
    const activity = youtubeOfficialToActivity(item)
    if (activity) addNativeActivity(activity)
    const type = String(item.snippet?.type || 'textMessageEvent')
    if (type !== 'textMessageEvent' && !activity) return
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

  function ingestYouTubeInnerModeration(event: YouTubeModeration) {
    applyChatModerationToState({ action: event.action, platform: 'YouTube', messageId: event.messageId, userId: event.userId })
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

  async function pollYouTube(options?: { manual?: boolean }) {
    return runYouTubePoll(() => pollYouTubeNow(options))
  }

  async function pollYouTubeNow(options?: { manual?: boolean }) {
    const token = await ensureToken('YouTube')
    if (!token) return false
    const account = state.accounts.find((item) => item.platform === 'YouTube')
    const live = Boolean(account?.live || youtubeChat.connected || youtubeTargets.length)
    const auto = settings.autoLiveCheck.YouTube
    const manual = Boolean(options?.manual)
    // A failed site chat may force one official status look, but only while Auto is on.
    if (!manual && auto && live && youtubeChat.failed) youtubeForceStatus = true
    const interval = youtubeStatusIntervalMs(live)
    const statusDue = youtubeForceStatus || !lastYouTubeStatusAt || Date.now() - lastYouTubeStatusAt >= interval
    const checked = shouldRunYouTubeStatusCheck({ autoEnabled: auto, manual, due: statusDue })
    if (checked) {
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
    // Auto off must not spend a history-seed unit on a chat id saved from the last stream.
    if (!manual && !auto && !youtubeChat.connected && !youtubeTargets.length) return checked
    await recheckEndedYoutubePrivacy(token)
    await syncYouTubeChat(token)
    await seedYouTubeHistory(token)
    await refreshYouTubeViewers()
    return checked
  }

  /** Copy each live YouTube title onto the account so the tile tooltip can list them. Cleared when YouTube is offline. */
  function publishYouTubeStreams() {
    const account = state.accounts.find((item) => item.platform === 'YouTube')
    if (!account) return
    const streams = account.live ? youtubeTargets.map((target) => {
      const title = String(target.title || '').trim()
      if (!title) return
      const viewers = youtubeStreamViewers.get(target.videoId)
      return { title, ...(target.label ? { label: target.label } : {}), ...(viewers != null ? { viewers } : {}) }
    }).filter((item): item is { title: string; label?: string; viewers?: number } => Boolean(item)) : []
    if (JSON.stringify(account.streams || []) === JSON.stringify(streams)) return
    account.streams = streams
    for (const id of [...youtubeStreamViewers.keys()]) {
      if (!youtubeTargets.some((target) => target.videoId === id)) youtubeStreamViewers.delete(id)
    }
  }

  function setYoutubePrivacy(notices: YoutubePrivacyNotice[]) {
    const visible = notices.filter((item) => !youtubePrivacyDismissed.has(item.videoId))
    const previous = state.youtubePrivacy
    const same = previous.length === visible.length && previous.every((item, index) => item.videoId === visible[index]?.videoId && item.privacy === visible[index]?.privacy && item.title === visible[index]?.title)
    for (const item of visible) {
      if (announcedYoutubePrivacy.has(item.videoId)) continue
      announcedYoutubePrivacy.add(item.videoId)
      console.warn(youtubePrivacyMessage(item))
    }
    for (const id of [...announcedYoutubePrivacy]) {
      if (!visible.some((item) => item.videoId === id)) announcedYoutubePrivacy.delete(id)
    }
    if (same) return
    state.youtubePrivacy = visible
    broadcast()
  }

  /** Remember live privacy from the broadcast list we already fetched, and keep those ids for a post-stream recheck. */
  function noteYouTubeLivePrivacy(liveItems: any[]) {
    const now = Date.now()
    const live = liveItems.map((item) => ({
      videoId: String(item.id || ''),
      title: String(item.snippet?.title || ''),
      privacyStatus: item.status?.privacyStatus,
    }))
    youtubePrivacyWatch = nextYoutubePrivacyWatch(now, youtubePrivacyWatch, live).map((item) => {
      const source = liveItems.find((entry) => String(entry.id || '') === item.videoId)
      const previous = youtubePrivacyWatch.find((entry) => entry.videoId === item.videoId)
      const status = source?.status && typeof source.status === 'object' ? source.status as Record<string, unknown> : previous?.status
      return { ...item, status }
    })
    for (const item of live) {
      if (youtubePrivacyValue(item.privacyStatus) === 'public') youtubePrivacyDismissed.delete(item.videoId)
    }
    const liveIds = new Set(live.map((item) => item.videoId))
    const ended = state.youtubePrivacy.filter((item) => !liveIds.has(item.videoId))
    setYoutubePrivacy([...youtubePrivacyNotices(live), ...ended])
  }

  /**
   * Recheck broadcasts that left the live list. videos.list is 1 unit and only
   * runs for those ids, so a still-unlisted stream keeps its warning.
   */
  async function recheckEndedYoutubePrivacy(token: Token) {
    const ids = youtubePrivacyRecheckIds(Date.now(), lastYoutubePrivacyRecheck, youtubePrivacyWatch, youtubeTargets.map((item) => item.videoId), state.youtubePrivacy)
    if (!ids.length || youtubeQuotaBlocked()) return
    lastYoutubePrivacyRecheck = Date.now()
    let listed: any
    try {
      listed = await youtubeApi(`/videos?part=status,snippet&id=${ids.map((id) => encodeURIComponent(id)).join(',')}`, token)
    } catch (error) {
      if (!noteYouTubeQuota(error)) console.error('YouTube privacy check:', error instanceof Error ? error.message : error)
      return
    }
    const found = new Set<string>()
    const endedNotices = youtubePrivacyNotices((listed.items || []).map((item: any) => {
      const videoId = String(item.id || '')
      found.add(videoId)
      const watched = youtubePrivacyWatch.find((entry) => entry.videoId === videoId)
      if (watched && item.status && typeof item.status === 'object') watched.status = item.status
      if (watched && item.snippet?.title) watched.title = String(item.snippet.title)
      if (youtubePrivacyValue(item.status?.privacyStatus) === 'public') youtubePrivacyDismissed.delete(videoId)
      return { videoId, title: String(item.snippet?.title || watched?.title || ''), privacyStatus: item.status?.privacyStatus }
    }))
    const liveIds = new Set(youtubeTargets.map((item) => item.videoId))
    const liveNotices = state.youtubePrivacy.filter((item) => liveIds.has(item.videoId))
    const missing = ids.filter((id) => !found.has(id))
    if (missing.length) youtubePrivacyWatch = youtubePrivacyWatch.filter((item) => !missing.includes(item.videoId))
    setYoutubePrivacy([...liveNotices, ...endedNotices.filter((item) => !liveIds.has(item.videoId))])
  }

  /** Poll the official liveBroadcasts API for our live chats, and fall back to the site reader when quota blocks the official status check. */
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
        description: item.snippet?.description != null ? String(item.snippet.description) : existing?.description,
        scheduledStartTime: item.snippet?.scheduledStartTime ? String(item.snippet.scheduledStartTime) : existing?.scheduledStartTime,
      }
    }).filter((item: YouTubeChatTarget) => item.videoId)
    setYouTubeTargets(next)
    noteYouTubeLivePrivacy(liveItems)
    restorePlatformConnection('YouTube')
    Object.assign(account, { live: liveItems.length > 0, handle: token.user && !looksLikePlaceholder(token.user) ? token.user : account.handle, channelId: token.channelId, ...(liveItems.length ? {} : { viewers: 0 }) })
    publishYouTubeStreams()
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
        Object.assign(account, { live: false, viewers: 0, streams: [], handle: token.user && !looksLikePlaceholder(token.user) ? token.user : account.handle })
      }
      return
    }
    const existing = youtubeTargets.find((item) => item.videoId === found.videoId)
    if (!existing) setYouTubeTargets([youtubeScrapedTarget(found)])
    Object.assign(account, { live: true, handle: token.user && !looksLikePlaceholder(token.user) ? token.user : account.handle, ...(Number.isFinite(found.viewers) ? { viewers: found.viewers } : {}) })
    publishYouTubeStreams()
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
      if (Number.isFinite(info?.viewers)) youtubeStreamViewers.set(target.videoId, info!.viewers as number)
    }
    publishYouTubeStreams()
    relabelYouTubeTargets()
    const labelsChanged = youtubeTargets.map((target) => `${target.videoId}:${target.label || ''}`).join(',') !== previousLabels
    if (labelsChanged) {
      const labels = youtubeTargets.map((target) => target.label).filter(Boolean)
      if (labels.length) console.log(`YouTube chats: ${labels.join(', ')}`)
      retagYouTubeMessages()
      await youtubeChat.start(youtubeTargets, ingestYouTubeInnerMessage, ingestYouTubeInnerModeration)
    }
    const counts = pages.map((item) => item.info?.viewers).filter((count): count is number => Number.isFinite(count))
    if (!counts.length) return
    const viewers = counts.reduce((total, count) => total + count, 0)
    const account = state.accounts.find((item) => item.platform === 'YouTube')
    if (!account) return
    const next = youtubeViewersWhileLive(account.live, account.viewers, viewers)
    if (!next && !labelsChanged) return
    if (next) Object.assign(account, next)
  }

  async function seedYouTubeHistory(token: Token) {
    if (youtubeQuotaBlocked()) return
    if (!youtubeTargets.length && !youtubeChat.connected) return
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
        const messages = await youtubeApi(youtubeLiveChatListQuery(chatId, undefined, 200), token)
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
    await youtubeChat.start(youtubeTargets, ingestYouTubeInnerMessage, ingestYouTubeInnerModeration)
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
    let waitMs = YOUTUBE_OFFICIAL_CHAT_MS
    for (const chatId of chatIds) {
      try {
        const cursor = youtubeOfficialCursors.get(chatId)
        const messages = await youtubeApi(youtubeLiveChatListQuery(chatId, cursor?.pageToken), token)
        const next = youtubeLiveChatCursor(messages)
        if (next.pageToken) youtubeOfficialCursors.set(chatId, next)
        else youtubeOfficialCursors.delete(chatId)
        waitMs = Math.max(waitMs, next.waitMs)
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
    lastYouTubeOfficialChatAt = Date.now() - YOUTUBE_OFFICIAL_CHAT_MS + waitMs
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
    scheduleChatSave()
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
    const results = await Promise.all(chatIds.map(async (liveChatId) => ({ liveChatId, result: await youtubeRequest('/liveChat/messages?part=snippet', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(youtubeLiveChatMessageBody(liveChatId, text)),
    }) })))
    const failed = results.filter((item) => !item.result.ok)
    const sent = results.flatMap((item) => {
      if (!item.result.ok) return []
      const id = youtubeInsertedMessageId(item.result.text)
      return id ? [{ id, sourceId: item.liveChatId }] : []
    })
    return { ok: results.some((item) => item.result.ok), error: failed.length ? failed.map((item) => youtubeApiErrorReason(item.result.text)).join(' | ') : undefined, ...(sent.length ? { sent } : {}) }
  }

  function saveYoutubeBans() {
    writeJsonAtomic(youtubeBanFile, youtubeBanRecord(youtubeBanIds))
  }

  /** Sending via the official YouTube Data API: delete a message, unban by the ban id we stored, or ban/timeout across every live chat we have. */
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
    if (body.action === 'unban') {
      if (!body.userId) return { ok: false, error: 'User id is required' }
      const ids = youtubeBanIds.get(body.userId.toLowerCase()) || []
      if (!ids.length) return { ok: false, error: 'Unban this chatter on YouTube. Relay only has a ban id after banning from this dock.' }
      const results = await Promise.all(ids.map((id) => youtubeRequest(`/liveChat/bans?id=${encodeURIComponent(id)}`, token, { method: 'DELETE' })))
      const failed = results.filter((result) => !result.ok)
      if (!failed.length) {
        youtubeBanIds.delete(body.userId.toLowerCase())
        saveYoutubeBans()
      }
      return { ok: results.some((result) => result.ok), error: failed.length ? failed.map((result) => youtubeApiErrorReason(result.text)).join(' | ') : undefined }
    }
    const chatIds = youtubeBanChatIds(body.sourceId, youtubeTargets, token)
    const userId = body.userId
    if (!userId || !chatIds.length) return { ok: false, error: 'YouTube user or live chat is missing' }
    const results = await Promise.all(chatIds.map((liveChatId) => youtubeRequest('/liveChat/bans?part=snippet', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: youtubeLiveChatBanSnippet(liveChatId, userId, body.action, body.duration) }),
    })))
    const failed = results.filter((result) => !result.ok)
    const remembered: string[] = []
    for (const result of results) {
      if (!result.ok || !result.text) continue
      try {
        const id = JSON.parse(result.text)?.id
        if (id) remembered.push(String(id))
      } catch { /* ignore */ }
    }
    if (remembered.length) {
      youtubeBanIds.set(userId.toLowerCase(), remembered)
      saveYoutubeBans()
    }
    return { ok: results.some((result) => result.ok), error: failed.length ? failed.map((result) => result.text).join(' | ') : undefined }
  }

  return {
    youtubeQuotaBlocked,
    youtubeQuotaSnapshot,
    persistYouTubeQuota,
    ensureYouTubeQuotaDay,
    youtubeQuotaHealth,
    applyYouTubeQuotaHealth,
    setYouTubeQuotaUsed,
    applyManualYouTubeQuota,
    listenForYouTubeQuotaInput,
    applyYouTubeQuotaHeaders,
    noteYouTubeQuotaUse,
    markYouTubeQuotaExceeded,
    noteYouTubeQuota,
    youtubeRequest,
    runYouTubePoll,
    dropEndedYouTubeChat,
    youtubeApi,
    beginYouTubeHydration,
    collapseYouTubeHydrationDuplicates,
    rememberYouTubeFromChat,
    ingestYouTubeOfficialItem,
    ingestYouTubeInnerModeration,
    ingestYouTubeInnerMessage,
    pollYouTube,
    pollYouTubeNow,
    publishYouTubeStreams,
    setYoutubePrivacy,
    noteYouTubeLivePrivacy,
    recheckEndedYoutubePrivacy,
    pollYouTubeStatus,
    discoverYouTubeLive,
    refreshYouTubeViewers,
    seedYouTubeHistory,
    syncYouTubeChat,
    pollYouTubeOfficialChat,
    relabelYouTubeTargets,
    youtubeSourceLabel,
    retagYouTubeMessages,
    youtubeLiveChatIds,
    setYouTubeTargets,
    sendYouTubeMessage,
    moderateYouTube,
    saveYoutubeBans,
    youtubeChat,
    youtubeSeen,
    youtubeStreamViewers,
    youtubePrivacyDismissed,
    announcedYoutubePrivacy,
    get youtubeTargets() { return youtubeTargets },
    get youtubeQuotaUsed() { return youtubeQuotaUsed },
    get youtubeQuotaLimit() { return youtubeQuotaLimit },
    get youtubeForceStatus() { return youtubeForceStatus },
    set youtubeForceStatus(value: boolean) { youtubeForceStatus = value },
    get youtubePrivacyWatch() { return youtubePrivacyWatch },
    set youtubePrivacyWatch(value: Array<YoutubePrivacyWatch & { status?: Record<string, unknown> }>) { youtubePrivacyWatch = value },
  }
}

export type YoutubeLive = ReturnType<typeof createYouTubeLive>
