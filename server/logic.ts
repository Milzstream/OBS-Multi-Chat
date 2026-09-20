import crypto from 'node:crypto'
import type { ActivityEvent } from './activity.js'
import type { YouTubeChatTarget } from './youtube-chat.js'
import {
  ACTIVITY_MAX,
  CHAT_MAX,
  CHAT_MAX_HARD,
  CHAT_MAX_MIN,
  KICK_OAUTH_SCOPES,
  TWITCH_OAUTH_SCOPES,
  YOUTUBE_OAUTH_SCOPES,
  type AppSettings,
  type ChatBadge,
  type ChatMessage,
  type ChatModeration,
  type Health,
  type MessagePart,
  type Platform,
  STREAM_TAG_MAX,
  TWITCH_TAG_MAX_LENGTH,
  type StreamDetails,
  type StreamInfoMap,
  type StreamPlatform,
  type YoutubeQuota,
} from './types.js'

/**
 * Pure helper functions for the Relay Chat Dock: parsing official and unofficial
 * platform payloads, moderation mapping, history dedupe and merge, translation
 * config, YouTube quota math, and OAuth URLs. This file owns no network calls,
 * no in-memory state, and no side effects; state and I/O live in server.ts.
 */

export {
  ACTIVITY_MAX,
  CHAT_MAX,
  CHAT_MAX_HARD,
  CHAT_MAX_MIN,
  KICK_OAUTH_SCOPES,
  STREAM_TAG_MAX,
  TWITCH_OAUTH_SCOPES,
  TWITCH_TAG_MAX_LENGTH,
  YOUTUBE_OAUTH_SCOPES,
  YOUTUBE_QUOTA_LIMIT,
} from './types.js'

const NON_ENGLISH = /[\u0400-\u052F\u0600-\u06FF\u0750-\u077F\u1100-\u11FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0590-\u05FF]/

function parseBoundedMax(rawValue: string | undefined, fallback: number) {
  const raw = String(rawValue || '').trim()
  if (!raw) return fallback
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(CHAT_MAX_HARD, Math.max(CHAT_MAX_MIN, n))
}

/** Resolve the `RELAY_CHAT_MAX` chat-history cap from env, clamped to `CHAT_MAX_MIN..CHAT_MAX_HARD`. */
export function parseChatMax(env: Record<string, string | undefined> = process.env) {
  return parseBoundedMax(env.RELAY_CHAT_MAX, CHAT_MAX)
}

/** Resolve the `RELAY_ACTIVITY_MAX` activity-history cap from env, same bounds as chat. */
export function parseActivityMax(env: Record<string, string | undefined> = process.env) {
  return parseBoundedMax(env.RELAY_ACTIVITY_MAX, ACTIVITY_MAX)
}

/**
 * True when `next` is `previous` with one newer row prepended (and maybe the
 * oldest row dropped at the cap). Used so activity SSE can send that one event
 * instead of the whole buffer.
 */
export function activityAppendedEvent<T extends { id: string }>(previous: T[], next: T[]) {
  if (!next.length) return
  const added = next[0]
  if (!added?.id || previous.some((item) => item.id === added.id)) return
  const rest = next.slice(1)
  if (rest.length === previous.length && rest.every((item, i) => item.id === previous[i]?.id)) return added
  if (rest.length === previous.length - 1 && rest.every((item, i) => item.id === previous[i]?.id)) return added
}

/** Build the activity SSE slice: one new event, warnings only, or a full replace. */
export function activitySseFields<T extends { id: string }>(previous: T[], next: T[], warnings: string[]) {
  const appended = activityAppendedEvent(previous, next)
  if (appended) return { activityEvent: appended, activityWarnings: warnings }
  const sameList = previous.length === next.length && previous.every((item, i) => item.id === next[i]?.id)
  if (sameList) return { activityWarnings: warnings }
  return { activity: next, activityWarnings: warnings }
}

export function looksLikePlaceholder(handle: string) {
  return !handle || handle === 'Kick account' || handle.includes(' ')
}

export function summarizeApiError(status: number, text: string) {
  if (/504|Gateway Timeout/i.test(text) || status === 504) return 'Gateway Timeout (Twitch CDN busy)'
  if (/502|Bad Gateway/i.test(text) || status === 502) return 'Bad Gateway'
  if (/503|Service Unavailable/i.test(text) || status === 503) return 'Service Unavailable'
  try {
    const json = JSON.parse(text) as { message?: string; error?: string }
    return json.message || json.error || `HTTP ${status}`
  } catch {
    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return plain.slice(0, 160) || `HTTP ${status}`
  }
}

export function nextPacificMidnight(now = Date.now()) {
  for (let t = now + 60_000; t <= now + 36 * 3600_000; t += 60_000) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)))
    const minute = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', minute: 'numeric' }).format(new Date(t)))
    if (hour === 0 && minute === 0) return t
  }
  return now + 24 * 60 * 60 * 1000
}

export function pacificDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
}

/**
 * Cost in Data API quota units for an endpoint+verb. Reads (`.list`) cost 1;
 * write and delete calls that change chat state cost 50. Anything unknown
 * falls back to 1 so the daily budget is never over-charged.
 */
export function youtubeQuotaCost(endpoint: string, method = 'GET') {
  const path = endpoint.split('?')[0].replace(/^\//, '')
  const verb = method.toUpperCase()

  // 1. Live Chat Bans
  if (path.startsWith('liveChat/bans')) {
    return verb === 'DELETE' ? 50 : 50 // Both insert and delete cost 50 units
  }

  // 2. Live Chat Messages (Splitting list from insert/delete)
  if (path.startsWith('liveChat/messages')) {
    if (verb === 'POST' || verb === 'DELETE') {
      return 50 // liveChatMessages.insert or .delete
    }
    return 1 // liveChatMessages.list costs exactly 1 unit
  }

  // 3. Other standard list endpoints
  if (path.startsWith('liveBroadcasts')) {
    if (verb === 'PUT' || verb === 'POST') return 50
    return 1
  }
  if (path.startsWith('channels') || path.startsWith('videos')) {
    return 1
  }

  return 1
}

export function youtubeQuotaLabel(endpoint: string, method = 'GET') {
  const path = endpoint.split(/[?#]/)[0].replace(/^\//, '')
  const verb = method.toUpperCase()

  if (path.startsWith('liveChat/bans')) {
    return verb === 'DELETE' ? 'liveChatBans.delete' : 'liveChatBans.insert'
  }
  
  if (path.startsWith('liveChat/messages')) {
    if (verb === 'POST') return 'liveChatMessages.insert'
    if (verb === 'DELETE') return 'liveChatMessages.delete'
    return 'liveChatMessages.list'
  }

  if (path.startsWith('liveBroadcasts')) {
    if (verb === 'PUT') return 'liveBroadcasts.update'
    if (verb === 'POST') return 'liveBroadcasts.insert'
    return 'liveBroadcasts.list'
  }
  if (path.startsWith('channels')) return 'channels.list'
  if (path.startsWith('videos')) return 'videos.list'
  
  return `${path} ${verb}`
}


export function quotaWarnAt(limit: number) {
  return Math.floor(limit * 0.8)
}

export function youtubeQuotaHealthStatus(used: number, limit: number, blocked: boolean): Health | undefined {
  if (blocked || used >= limit) {
    return { status: 'warn', message: `YouTube API quota reached (${Math.min(used, limit).toLocaleString()} / ${limit.toLocaleString()}) — using site chat until midnight Pacific` }
  }
  if (used >= quotaWarnAt(limit)) {
    const percent = Math.min(99, Math.round((used / limit) * 100))
    return { status: 'warn', message: `YouTube API quota ${percent}% used (${used.toLocaleString()} / ${limit.toLocaleString()}) — sending and moderation still use official API` }
  }
}

/** Parse a user-typed quota status line into used/remaining values, or `help` when it doesn't look like one of the accepted shapes. */
export function parseYouTubeQuotaInput(line: string) {
  const pair = line.match(/^(?:used\s+)?(\d+)\s*\/\s*(\d+)\s*$/i)
  if (pair) return { kind: 'used' as const, used: Number(pair[1]), limit: Number(pair[2]) }
  const remaining = line.match(/^(?:remaining|left|rem)\s+(\d+)\s*$/i)
  if (remaining) return { kind: 'remaining' as const, remaining: Number(remaining[1]) }
  const used = line.match(/^(?:used\s+)?(\d+)\s*$/i)
  if (used) return { kind: 'used' as const, used: Number(used[1]) }
  if (/^\d/.test(line) || /quota|remaining|used/i.test(line)) return { kind: 'help' as const }
}

export function headerNumber(headers: Headers, names: string[]) {
  for (const name of names) {
    const raw = headers.get(name)
    if (raw == null || raw === '') continue
    const value = Number(String(raw).split(/[;,\s]/)[0])
    if (Number.isFinite(value)) return value
  }
}

/**
 * Extract quota numbers from response headers. Reads both header families:
 * the per-minute rate limit headers (`ratelimit-*` / `x-ratelimit-*` /
 * `x-rate-limit-*`) and the daily quota-style headers (`x-quota-*`). Each
 * value takes the first non-empty candidate in that traversal order.
 */
export function quotaFromHeaders(headers: Headers): { used?: number; remaining?: number; limit?: number } | undefined {
  const remaining = headerNumber(headers, ['ratelimit-remaining', 'x-ratelimit-remaining', 'x-rate-limit-remaining', 'x-quota-remaining'])
  const limit = headerNumber(headers, ['ratelimit-limit', 'x-ratelimit-limit', 'x-rate-limit-limit', 'x-quota-limit'])
  const used = headerNumber(headers, ['x-quota-used', 'x-ratelimit-used'])
  if (remaining == null && limit == null && used == null) return
  return { remaining, limit, used }
}

/**
 * Tell "is this the daily quota header?" apart from the per-minute rate limit
 * header: the daily budget is ~10,000 units, while per-minute limits are at
 * most a few hundred, so a `limit` of `1000+` means daily. `used` is only
 * trusted when it carries a matching daily `limit` (or no limit at all).
 */
export function isDailyQuotaHeader(parsed: { used?: number; remaining?: number; limit?: number }) {
  return (parsed.limit != null && parsed.limit >= 1000) || (parsed.used != null && parsed.used >= 0 && (parsed.limit == null || parsed.limit >= 1000))
}

/** Pull the machine-readable `reason` out of a Data API error body; falls back to flattened text for non-JSON responses. */
export function youtubeApiErrorReason(text: string) {
  try {
    const payload = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string; message?: string }[] } }
    const entry = payload.error?.errors?.[0]
    const reason = entry?.reason || payload.error?.message || entry?.message
    if (reason) return reason
  } catch { /* not json */ }
  return text.replace(/\s+/g, ' ').slice(0, 120)
}

export function isEndedYouTubeChat(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return /live chat is no longer live|liveChatEnded|liveChatNotFound/i.test(text)
}

export function youtubeTitleIsShorts(title?: string) {
  return /#shortsfeed\b/i.test(title || '')
}

export function youtubeChatLabel(targets: YouTubeChatTarget[], target: YouTubeChatTarget) {
  const multi = targets.length > 1 && targets.some((item) => youtubeTitleIsShorts(item.title))
  if (!multi) return
  return youtubeTitleIsShorts(target.title) ? 'Shorts' : 'Live'
}

export function labelYouTubeTargets(targets: YouTubeChatTarget[]): YouTubeChatTarget[] {
  return targets.map((target) => ({ ...target, label: youtubeChatLabel(targets, target) }))
}

export function resolveYouTubeLiveChatIds(targets: YouTubeChatTarget[], token?: { liveChatIds?: string[]; liveChatId?: string }) {
  const fromTargets = targets.map((target) => target.liveChatId).filter((id): id is string => Boolean(id))
  if (fromTargets.length) return [...new Set(fromTargets)]
  if (token?.liveChatIds?.length) return [...new Set(token.liveChatIds)]
  if (token?.liveChatId) return [token.liveChatId]
  return []
}

export function syncYouTubeTokenChatIds<T extends { liveChatIds?: string[]; liveChatId?: string }>(targets: YouTubeChatTarget[], token: T) {
  const chatIds = [...new Set(targets.map((target) => target.liveChatId).filter((id): id is string => Boolean(id)))]
  token.liveChatIds = chatIds
  token.liveChatId = chatIds[0]
  return token
}

export function youtubeSendGuard(options: { connected: boolean; quotaBlocked: boolean; chatIds: string[] }) {
  if (!options.connected) return { ok: false as const, error: 'Not connected' }
  if (options.quotaBlocked) return { ok: false as const, error: 'YouTube API quota exceeded until midnight Pacific' }
  if (!options.chatIds.length) return { ok: false as const, error: 'YouTube chat is not live' }
  return { ok: true as const }
}

export function youtubeLiveChatMessageBody(liveChatId: string, text: string) {
  return { snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } } }
}

export function youtubeChatKeysFor(sourceId: string | undefined, targets: YouTubeChatTarget[]) {
  if (!sourceId) return []
  const keys = [sourceId]
  for (const target of targets) {
    if (target.liveChatId !== sourceId && target.videoId !== sourceId) continue
    if (target.liveChatId) keys.push(target.liveChatId)
    keys.push(target.videoId)
  }
  return keys
}

export function youtubeSameChatFor(left: string | undefined, right: string | undefined, targets: YouTubeChatTarget[]) {
  if (!left || !right) return true
  if (left === right) return true
  const keys = new Set(youtubeChatKeysFor(left, targets))
  return youtubeChatKeysFor(right, targets).some((key) => keys.has(key))
}

export function youtubeSameAuthor(left: ChatMessage, right: ChatMessage) {
  if (left.userId && right.userId) return left.userId.toLowerCase() === right.userId.toLowerCase()
  return normalizeChatHandle(left.user) === normalizeChatHandle(right.user)
}

export function normalizeChatHandle(name: string) {
  return name.replace(/^@+/, '').trim().toLowerCase()
}

export function isOwnChatMessage(
  message: { user: string; userId?: string },
  ctx: { ownHandles: Set<string>; ownUserIds?: Iterable<string> },
) {
  const handle = normalizeChatHandle(message.user)
  if (ctx.ownHandles.has(handle) || ctx.ownHandles.has(message.user.toLowerCase())) return true
  if (!message.userId || !ctx.ownUserIds) return false
  for (const id of ctx.ownUserIds) if (id.toLowerCase() === message.userId.toLowerCase()) return true
  return false
}

/**
 * Fold a raw chat line into a stable key for dedupe/merge: drop zero-width and
 * joiner characters, strip emojis and variation selectors, collapse and
 * trim whitespace, lowercase. Two wordings that differ only in emoji or caps
 * then compare equal.
 */
export function foldRawText(text: string) {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function foldChatText(message: ChatMessage) {
  const raw = message.parts?.length
    ? message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
    : message.text
  return foldRawText(raw)
}

export function isTruncatedText(text: string) {
  return /(?:\.{2,}|…)\s*$/.test(text.trim())
}

/**
 * When one side was cut off mid-message ("..." or unicode ellipsis), treat it
 * as a match if the other side starts with that truncated prefix. Guards on a
 * 12-char prefix so short messages that merely end with a period never collide.
 */
export function truncatedFoldMatches(left: string, right: string) {
  if (!left || !right) return false
  if (left === right) return true
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  if (!isTruncatedText(short)) return false
  const prefix = short.replace(/(?:\.{2,}|…)\s*$/g, '').trim()
  return prefix.length >= 12 && long.startsWith(prefix)
}

/**
 * Compare two messages (or raw strings) for dedupe: exact text first, then
 * folded text, then truncated-prefix matching. Folds parts-based messages from
 * their text parts and plain strings as-is.
 */
export function chatTextMatches(left: ChatMessage | string, right: ChatMessage | string) {
  const leftText = typeof left === 'string' ? left : left.text
  const rightText = typeof right === 'string' ? right : right.text
  if (leftText === rightText) return true
  const leftFold = typeof left === 'string' ? foldRawText(left) : foldChatText(left)
  const rightFold = typeof right === 'string' ? foldRawText(right) : foldChatText(right)
  if (leftFold === rightFold) return true
  if (truncatedFoldMatches(leftFold, rightFold)) return true
  return truncatedFoldMatches(foldRawText(leftText), foldRawText(rightText))
}

export function preferChatText(current: string, incoming: string) {
  if (!incoming) return current
  if (!current) return incoming
  if (!chatTextMatches(current, incoming)) return current
  if (isTruncatedText(current) && !isTruncatedText(incoming)) return incoming
  if (isTruncatedText(incoming) && !isTruncatedText(current)) return current
  return incoming.length > current.length ? incoming : current
}

export function mergedSourceLabel(current: ChatMessage, incoming: ChatMessage, targets: YouTubeChatTarget[] = []) {
  const currentPlatforms = current.platforms || [current.platform]
  const incomingPlatforms = incoming.platforms || [incoming.platform]
  if (!current.sourceId && currentPlatforms.length > 1) return current.sourceLabel
  if (!incoming.sourceId && incomingPlatforms.length > 1) return incoming.sourceLabel
  if (current.sourceId && incoming.sourceId && !youtubeSameChatFor(current.sourceId, incoming.sourceId, targets)) return undefined
  if (current.sourceLabel && incoming.sourceLabel && current.sourceLabel !== incoming.sourceLabel) return undefined
  return current.sourceLabel || incoming.sourceLabel
}

function isHostOrOwn(message: ChatMessage, ctx?: { ownHandles?: Set<string>; ownUserIds?: Iterable<string> }) {
  if (message.badges?.some((badge) => badge.label === 'HOST')) return true
  if (!ctx?.ownHandles) return false
  return isOwnChatMessage(message, { ownHandles: ctx.ownHandles, ownUserIds: ctx.ownUserIds })
}

export function sortedYouTubeBadges(badges?: ChatBadge[]) {
  if (!badges?.length) return badges
  const rank = (label?: string) => label === 'HOST' ? 0 : label === 'MOD' ? 1 : label === '✓' ? 2 : label === 'MEM' ? 3 : 4
  return [...badges].sort((left, right) => rank(left.label) - rank(right.label) || left.title.localeCompare(right.title))
}

export function youtubeBadges(author?: { isChatOwner?: boolean; isChatModerator?: boolean; isChatSponsor?: boolean; isVerified?: boolean }): ChatBadge[] {
  const badges: ChatBadge[] = []
  if (author?.isChatOwner) badges.push({ title: 'Owner', label: 'HOST' })
  if (author?.isChatModerator) badges.push({ title: 'Moderator', label: 'MOD' })
  if (author?.isChatSponsor) badges.push({ title: 'Member', label: 'MEM' })
  if (author?.isVerified) badges.push({ title: 'Verified', label: '✓' })
  return badges
}

export function isStoredChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false
  const item = value as ChatMessage
  return Boolean(item.id) && (item.platform === 'Twitch' || item.platform === 'Kick' || item.platform === 'YouTube') && typeof item.user === 'string' && typeof item.text === 'string' && typeof item.time === 'string'
}

export function chatUserMatches(message: ChatMessage, target: { userId?: string; user?: string }) {
  if (target.userId && message.userId) return message.userId.toLowerCase() === target.userId.toLowerCase()
  if (target.user) return normalizeChatHandle(message.user) === normalizeChatHandle(target.user)
  return false
}

export function messageOnPlatform(message: ChatMessage, platform: Platform) {
  return (message.platforms || [message.platform]).includes(platform)
}

/**
 * Apply one moderation change to the stored history: `delete` flags a single
 * message id; `ban`, `timeout`, and `unban` flag every stored message from
 * that user so the whole thread disappears (or reappears on unban).
 */
export function applyChatModeration(messages: ChatMessage[], change: ChatModeration): { messages: ChatMessage[]; changed: boolean } {
  if (change.action === 'delete') {
    if (!change.messageId) return { messages, changed: false }
    let changed = false
    const next = messages.map((item) => {
      if (item.id !== change.messageId || item.deleted) return item
      changed = true
      return { ...item, deleted: true }
    })
    return { messages: changed ? next : messages, changed }
  }
  if (!change.userId && !change.user) return { messages, changed: false }
  const hide = change.action === 'ban' || change.action === 'timeout'
  if (!hide && change.action !== 'unban') return { messages, changed: false }
  let changed = false
  const next = messages.map((item) => {
    if (!messageOnPlatform(item, change.platform) || !chatUserMatches(item, change)) return item
    if (hide ? item.deleted : !item.deleted) return item
    changed = true
    return { ...item, deleted: hide }
  })
  return { messages: changed ? next : messages, changed }
}

/**
 * Collapse duplicate YouTube messages that come from both data sources: the
 * official Data API and the unofficial site poll both deliver the same chat,
 * and this folds pick-ups into their originals. Distant duplicates 20s apart
 * are only merged when they are the streamer's own posts.
 */
export function collapseYouTubeDuplicates(
  messages: ChatMessage[],
  targets: YouTubeChatTarget[] = [],
  ctx?: { ownHandles?: Set<string>; ownUserIds?: Iterable<string> },
) {
  const kept: ChatMessage[] = []
  const seenIds: string[] = []
  let changed = false
  for (const message of messages) {
    const at = Date.parse(message.time) || 0
    const youtube = message.platform === 'YouTube' || (message.platforms || []).includes('YouTube')
    const match = youtube ? kept.findIndex((item) => {
      if (!chatTextMatches(item, message)) return false
      if (!(item.platform === 'YouTube' || (item.platforms || []).includes('YouTube'))) return false
      if (!youtubeSameAuthor(item, message)) return false
      const sameChat = youtubeSameChatFor(item.sourceId, message.sourceId, targets)
      const ownPair = isHostOrOwn(item, ctx) && isHostOrOwn(message, ctx)
      if (!sameChat && !ownPair) return false
      const delta = Math.abs((Date.parse(item.time) || 0) - at)
      return delta <= (sameChat ? 2_000 : 20_000)
    }) : -1
    if (match < 0) {
      kept.push(message)
      continue
    }
    changed = true
    const current = kept[match]
    const platforms = [...new Set([...(current.platforms || [current.platform]), ...(message.platforms || [message.platform])])]
    const text = preferChatText(current.text, message.text)
    const takeIncomingParts = text === message.text && !isTruncatedText(message.text)
    const parts = current.parts?.some((part) => part.type === 'emote')
      ? current.parts
      : takeIncomingParts && message.parts?.length ? message.parts : current.parts
    kept[match] = {
      ...current,
      text,
      platforms,
      platform: platforms[0],
      sourceId: current.sourceId || message.sourceId,
      userId: current.userId || message.userId,
      ingest: message.ingest || current.ingest,
      parts,
      avatar: current.avatar || message.avatar,
      badges: sortedYouTubeBadges(current.badges?.length ? current.badges : message.badges),
      color: current.color || message.color,
      sourceLabel: mergedSourceLabel(current, message, targets),
    }
    if (current.id) seenIds.push(current.id)
    if (message.id) seenIds.push(message.id)
  }
  return { messages: changed ? kept : messages, changed, seenIds }
}

/**
 * Merge one incoming message into the chat history: either appends it, or
 * folds it into an existing entry when it looks like the same message observed
 * on another platform or ingest source. Returns `seenIds` for the YouTube
 * dedupe map, plus `added` when a brand-new message was appended.
 */
export function mergeIncomingChat(
  messages: ChatMessage[],
  message: ChatMessage,
  options: { ingest?: 'official' | 'innertube' } | undefined,
  ctx: {
    ownHandles: Set<string>
    recentOutgoing: { id: string; text: string; platforms: Platform[]; at: number }[]
    targets?: YouTubeChatTarget[]
    ownUserIds?: Iterable<string>
    max?: number
  },
) {
  const seenIds: string[] = []
  if (!message.text && !message.parts?.length) return { messages, changed: false, seenIds }
  if (messages.some((item) => item.id === message.id)) {
    if (message.id) seenIds.push(message.id)
    return { messages, changed: false, seenIds }
  }
  const incomingTime = Date.parse(message.time) || Date.now()
  const incomingPlatforms = message.platforms?.length ? message.platforms : [message.platform]
  const incomingIsOwn = isOwnChatMessage(message, ctx)
  const tracked = ctx.recentOutgoing.find((item) => chatTextMatches(item.text, message) && Math.abs(incomingTime - item.at) < 20_000)
  const incomingIngest = options?.ingest
  const targets = ctx.targets || []

  let mergeAt = -1
  let mergeDelta = Infinity
  for (let index = 0; index < messages.length; index++) {
    const item = messages[index]
    if (!chatTextMatches(item, message)) continue
    const delta = Math.abs((Date.parse(item.time) || 0) - incomingTime)
    const itemIsOwn = isOwnChatMessage(item, ctx)
    const itemPlatforms = item.platforms || [item.platform]
    const sameYouTubeChat = youtubeSameChatFor(item.sourceId, message.sourceId, targets)
    const youtubePair = message.platform === 'YouTube'
      && (item.platform === 'YouTube' || itemPlatforms.includes('YouTube'))
      && youtubeSameAuthor(item, message)
    const ownYouTube = youtubePair && (incomingIsOwn || itemIsOwn)
    let match = youtubePair && sameYouTubeChat && delta <= 2_000
    if (!match && ownYouTube && !sameYouTubeChat && delta <= 20_000) match = true
    if (!match && tracked && delta <= 20_000 && (item.id === tracked.id || (incomingIsOwn && itemIsOwn))) match = true
    else if (!match && incomingIsOwn && itemIsOwn && delta <= 90_000) {
      const samePlatforms = incomingPlatforms.every((platform) => itemPlatforms.includes(platform)) && itemPlatforms.every((platform) => incomingPlatforms.includes(platform))
      match = !samePlatforms || Boolean(youtubePair && !sameYouTubeChat)
    }
    if (!match || delta >= mergeDelta) continue
    mergeAt = index
    mergeDelta = delta
  }

  if (mergeAt >= 0) {
    const current = messages[mergeAt]
    const preferred = tracked?.platforms || []
    const platforms = [...new Set([...preferred, ...(current.platforms || [current.platform]), ...incomingPlatforms])]
    const already = current.platforms || [current.platform]
    const text = preferChatText(current.text, message.text)
    const takeIncomingParts = text === message.text && !isTruncatedText(message.text)
    const parts = current.parts?.some((part) => part.type === 'emote')
      ? current.parts
      : takeIncomingParts && message.parts?.length ? message.parts : current.parts
    const takeIncomingId = Boolean(message.sourceId && !current.sourceId)
    const sourceLabel = mergedSourceLabel(current, message, targets)
    const platformsUnchanged = platforms.length === already.length && platforms.every((platform) => already.includes(platform))
    if (current.id) seenIds.push(current.id)
    if (message.id) seenIds.push(message.id)
    const ingestChanged = Boolean(incomingIngest && current.ingest !== incomingIngest)
    const textChanged = text !== current.text
    const labelChanged = sourceLabel !== current.sourceLabel
    const metaChanged = Boolean((message.userId && !current.userId) || (message.handle && !current.handle) || (message.avatar && !current.avatar) || (!current.badges?.length && message.badges?.length))
    if (platformsUnchanged && parts === current.parts && !takeIncomingId && !ingestChanged && !textChanged && !labelChanged && !metaChanged) {
      return { messages, changed: false, seenIds }
    }
    return {
      messages: messages.map((item, index) => index === mergeAt ? {
        ...item,
        ...(takeIncomingId ? { id: message.id } : {}),
        text,
        platform: platforms[0],
        platforms,
        sourceId: item.sourceId || message.sourceId,
        userId: item.userId || message.userId,
        handle: item.handle || message.handle,
        ingest: incomingIngest || item.ingest,
        ...(parts ? { parts } : {}),
        avatar: item.avatar || message.avatar,
        badges: sortedYouTubeBadges(item.badges?.length ? item.badges : message.badges),
        color: item.color || message.color,
        sourceLabel,
      } : item),
      changed: true,
      seenIds,
    }
  }

  const stored = { ...message, platforms: incomingPlatforms, ...(incomingIngest ? { ingest: incomingIngest } : {}) }
  if (stored.id && stored.platform === 'YouTube') seenIds.push(stored.id)
  return { messages: [...messages, stored].slice(-(ctx.max ?? CHAT_MAX)), changed: true, added: stored, seenIds }
}

/** Map a Twitch badge set name to a short dock label (`broadcaster`→`HOST`, `moderator`→`MOD`, etc.). */
export function twitchBadgeLabel(set: string) {
  const name = set.toLowerCase()
  if (name === 'broadcaster') return 'HOST'
  if (name === 'moderator') return 'MOD'
  if (name === 'subscriber' || name === 'founder') return 'SUB'
  if (name === 'vip') return 'VIP'
  if (name === 'premium' || name === 'turbo') return 'PRIME'
  if (name === 'staff' || name === 'admin') return 'STAFF'
  if (name === 'partner' || name === 'verified') return '✓'
  if (name.includes('bit')) return 'BITS'
  if (name.includes('gift')) return 'GIFT'
  return ''
}

export function parseIrcTags(raw: string) {
  return Object.fromEntries((raw || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=')
    return index === -1 ? [item, ''] : [item.slice(0, index), item.slice(index + 1)]
  }))
}

export function twitchBadgesFromTag(tag?: string, urls?: Map<string, string>): ChatBadge[] {
  return (tag || '').split(',').filter(Boolean).map((item) => {
    const [set, version] = item.split('/')
    return { title: set, url: urls?.get(`${set}/${version || '1'}`), label: twitchBadgeLabel(set) }
  }).filter((badge) => badge.url || badge.label).slice(0, 5)
}

export function twitchBadgesFromList(badges?: { set_id?: string; id?: string }[], urls?: Map<string, string>): ChatBadge[] {
  return (badges || []).map((badge) => {
    const set = String(badge.set_id || '')
    const version = String(badge.id || '1')
    return { title: set, url: urls?.get(`${set}/${version}`), label: twitchBadgeLabel(set) }
  }).filter((badge) => badge.url || badge.label).slice(0, 5)
}

export function kickBadges(badges?: { type?: string; text?: string }[]): ChatBadge[] {
  return (badges || []).map((badge) => {
    const type = String(badge.type || '').toLowerCase()
    let label = ''
    if (type.includes('broadcaster') || type === 'og') label = 'HOST'
    else if (type.includes('mod')) label = 'MOD'
    else if (type.includes('sub')) label = 'SUB'
    else if (type.includes('vip')) label = 'VIP'
    else if (type.includes('verified')) label = '✓'
    else if (type.includes('staff')) label = 'STAFF'
    else if (type.includes('founder')) label = 'OG'
    return { title: badge.text || badge.type || label, label }
  }).filter((badge) => badge.label).slice(0, 4)
}

/**
 * Normalize an avatar URL for the dock: force HTTPS (Kick avatars arrive
 * URL-escaped and protocol-relative), reject placeholder avatars, and cap the
 * size query param so hotlinked images stay small.
 */
export function normalizeAvatar(url?: string) {
  if (!url) return
  let next = String(url).trim()
  if (!next) return
  if (next.startsWith('//')) next = `https:${next}`
  else if (next.startsWith('http://')) next = `https://${next.slice(7)}`
  if (/default-user|\/photo\.jpg(\?|$)/i.test(next)) return
  return next.replace(/=s\d+/i, '=s88')
}

export function twitchEmoteUrl(id: string) {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`
}

export function kickEmoteUrl(id: string) {
  return `https://files.kick.com/emotes/${encodeURIComponent(id)}/fullsize`
}

/** Convert a Twitch IRC `emotes` tag (id:start-end,start-end/...) into emote/text parts with CDN URLs. */
export function parseTwitchEmoteParts(text: string, emotesTag?: string): MessagePart[] {
  if (!emotesTag) return [{ type: 'text', text }]
  const ranges: { start: number; end: number; id: string }[] = []
  for (const emote of emotesTag.split('/').filter(Boolean)) {
    const [id, positions] = [emote.slice(0, emote.indexOf(':')), emote.slice(emote.indexOf(':') + 1)]
    if (!id || !positions) continue
    for (const position of positions.split(',').filter(Boolean)) {
      const [start, end] = position.split('-').map(Number)
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) ranges.push({ start, end, id })
    }
  }
  if (!ranges.length) return [{ type: 'text', text }]
  ranges.sort((left, right) => left.start - right.start)
  const parts: MessagePart[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    if (range.start > cursor) parts.push({ type: 'text', text: text.slice(cursor, range.start) })
    parts.push({ type: 'emote', name: text.slice(range.start, range.end + 1), url: twitchEmoteUrl(range.id) })
    cursor = range.end + 1
  }
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) })
  return parts.length ? parts : [{ type: 'text', text }]
}

export function partsFromTwitchFragments(fragments: any[] | undefined, fallback: string): MessagePart[] {
  if (!fragments?.length) return fallback ? [{ type: 'text', text: fallback }] : []
  const parts: MessagePart[] = []
  for (const fragment of fragments) {
    if (fragment?.type === 'emote' && fragment.emote?.id) parts.push({ type: 'emote', name: String(fragment.text || ''), url: twitchEmoteUrl(String(fragment.emote.id)) })
    else if (fragment?.text) parts.push({ type: 'text', text: String(fragment.text) })
  }
  return parts.length ? parts : [{ type: 'text', text: fallback }]
}

/**
 * Parse Kick's unofficial emote format. The text carries inline
 * `[emote:ID:name]` tokens — this extracts them and builds `MessagePart[]`.
 * Falls back to the `emotes` positional array when no inline tokens exist.
 */
export function parseKickParts(text: string, emotes?: any[]): MessagePart[] {
  const token = /\[emote:(\d+):([^\]]+)\]/g
  const parts: MessagePart[] = []
  let cursor = 0
  let matched = false
  for (const match of text.matchAll(token)) {
    matched = true
    const index = match.index || 0
    if (index > cursor) parts.push({ type: 'text', text: text.slice(cursor, index) })
    parts.push({ type: 'emote', name: match[2], url: kickEmoteUrl(match[1]) })
    cursor = index + match[0].length
  }
  if (matched) {
    if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) })
    return parts.length ? parts : [{ type: 'text', text }]
  }
  if (emotes?.length) {
    const ranges = emotes.flatMap((emote) => {
      const id = String(emote.emote_id || emote.id || '')
      const name = String(emote.name || '')
      return (emote.positions || []).map((position: any) => ({ start: Number(position.s ?? position.start), end: Number(position.e ?? position.end), id, name }))
    }).filter((range) => range.id && Number.isFinite(range.start) && Number.isFinite(range.end)).sort((left, right) => left.start - right.start)
    if (ranges.length) {
      let offset = 0
      for (const range of ranges) {
        if (range.start < offset) continue
        if (range.start > offset) parts.push({ type: 'text', text: text.slice(offset, range.start) })
        parts.push({ type: 'emote', name: range.name || text.slice(range.start, range.end + 1), url: kickEmoteUrl(range.id) })
        offset = range.end + 1
      }
      if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) })
      return parts.length ? parts : [{ type: 'text', text }]
    }
  }
  return [{ type: 'text', text }]
}

/**
 * Parse one line of Twitch IRC chat. Returns `'ping'` for keepalives, a
 * `ChatMessage` for `PRIVMSG`, otherwise `undefined`. The `urls` map resolves
 * badge set/version keys like `subscriber/1` to their image URLs.
 */
export function parseTwitchChatLine(line: string, options: { now?: Date; urls?: Map<string, string> } = {}): ChatMessage | 'ping' | undefined {
  if (line.startsWith('PING')) return 'ping'
  const match = line.match(/^(?:@([^ ]+) )?:([^!]+)!.* PRIVMSG #[^ ]+ :(.*)$/)
  if (!match) return
  const tags = parseIrcTags(match[1] || '')
  const userId = tags['user-id'] || undefined
  return {
    id: tags.id || crypto.randomUUID(),
    platform: 'Twitch',
    user: tags['display-name'] || match[2],
    userId,
    color: tags.color || undefined,
    badges: twitchBadgesFromTag(tags.badges, options.urls),
    text: match[3],
    time: (options.now || new Date()).toISOString(),
    parts: parseTwitchEmoteParts(match[3], tags.emotes),
    emotes: tags.emotes ? tags.emotes.split('/').map((item: string) => item.split(':')[0]) : [],
  }
}

/**
 * Parse Twitch IRC moderation lines: `CLEARMSG` deletes one message;
 * `CLEARCHAT` clears a whole user and becomes a `timeout` when the
 * `ban-duration` tag is present (seconds) or a `ban` otherwise.
 */
export function parseTwitchModerationLine(line: string): ChatModeration | undefined {
  const clearmsg = line.match(/^(?:@([^ ]+) )?:tmi\.twitch\.tv CLEARMSG #/)
  if (clearmsg) {
    const tags = parseIrcTags(clearmsg[1] || '')
    const messageId = tags['target-msg-id']
    if (!messageId) return
    return { action: 'delete', platform: 'Twitch', messageId, user: tags.login || undefined }
  }
  const clearchat = line.match(/^(?:@([^ ]+) )?:tmi\.twitch\.tv CLEARCHAT #[^ ]*(?: :(.+))?$/)
  if (!clearchat) return
  const tags = parseIrcTags(clearchat[1] || '')
  const user = String(clearchat[2] || '').trim() || undefined
  const userId = tags['target-user-id'] || undefined
  if (!user && !userId) return
  return { action: tags['ban-duration'] ? 'timeout' : 'ban', platform: 'Twitch', userId, user }
}

export function needsTranslation(text: string) {
  return NON_ENGLISH.test(text)
}

export function sanitizeIrcMessage(text: string) {
  return text.replace(/[\r\n\0]/g, ' ')
}

export function pruneYouTubeSeenIds(seenIds: Set<string>, messages: ChatMessage[]) {
  const retained = new Set(messages.filter((message) => message.platform === 'YouTube' || message.platforms?.includes('YouTube')).map((message) => message.id))
  for (const id of seenIds) if (!retained.has(id)) seenIds.delete(id)
}

/** Map a Twitch EventSub subscription payload type to an Activity dock event. Unknown types yield nothing. */
export function twitchEventToActivity(type: string, event: any, now = new Date().toISOString()): ActivityEvent | undefined {
  const time = now
  if (type === 'channel.follow') {
    return { id: `twitch-follow-${event?.user_id}-${event?.followed_at || time}`, platform: 'Twitch', kind: 'follow', user: event?.user_login || event?.user_name || 'Twitch user', userId: event?.user_id ? String(event.user_id) : undefined, time: event?.followed_at || time }
  }
  if (type === 'channel.subscribe') {
    // Gifted subs arrive via `channel.subscription.gift` instead; skip so they aren't double-counted.
    if (event?.is_gift) return
    return { id: `twitch-sub-${event?.user_id}-${time}`, platform: 'Twitch', kind: 'subscription', user: event?.user_login || event?.user_name || 'Twitch user', userId: event?.user_id ? String(event.user_id) : undefined, time }
  }
  if (type === 'channel.subscription.message') {
    const months = Number(event?.cumulative_months || event?.duration_months)
    return {
      id: event?.message?.id || `twitch-resub-${event?.user_id}-${time}`,
      platform: 'Twitch',
      kind: 'subscription',
      user: event?.user_login || event?.user_name || 'Twitch user',
      userId: event?.user_id ? String(event.user_id) : undefined,
      months: Number.isFinite(months) && months > 0 ? months : undefined,
      message: String(event?.message?.text || '').trim() || undefined,
      time,
    }
  }
  if (type === 'channel.subscription.gift') {
    const total = Number(event?.total)
    const user = event?.is_anonymous ? 'Anonymous' : event?.user_name || event?.user_login || 'Twitch user'
    return { id: `twitch-gift-${event?.user_id || 'anon'}-${time}`, platform: 'Twitch', kind: 'gift', user, userId: event?.user_id ? String(event.user_id) : undefined, amount: Number.isFinite(total) && total > 0 ? `${total} gift${total === 1 ? '' : 's'}` : undefined, time }
  }
  if (type === 'channel.cheer') {
    const bits = Number(event?.bits)
    const user = event?.is_anonymous ? 'Anonymous' : event?.user_name || event?.user_login || 'Twitch user'
    return { id: `twitch-cheer-${event?.user_id || 'anon'}-${time}`, platform: 'Twitch', kind: 'cheer', user, userId: event?.user_id ? String(event.user_id) : undefined, amount: Number.isFinite(bits) ? `${bits} Bits` : undefined, message: String(event?.message || '').trim() || undefined, time }
  }
  if (type === 'channel.raid') {
    const viewers = Number(event?.viewers)
    return { id: `twitch-raid-${event?.from_broadcaster_user_id}-${time}`, platform: 'Twitch', kind: 'raid', user: event?.from_broadcaster_user_login || event?.from_broadcaster_user_name || 'Twitch user', userId: event?.from_broadcaster_user_id ? String(event.from_broadcaster_user_id) : undefined, viewers: Number.isFinite(viewers) ? viewers : undefined, time }
  }
}

/** Map one official Data API `liveChatMessages.list` item (superchat/membership/gift) to an Activity dock event. */
export function youtubeOfficialToActivity(item: any): ActivityEvent | undefined {
  const type = String(item.snippet?.type || '')
  const user = String(item.authorDetails?.displayName || 'YouTube user').replace(/^@+/, '')
  const userId = item.authorDetails?.channelId ? String(item.authorDetails.channelId) : undefined
  const time = item.snippet?.publishedAt || new Date().toISOString()
  if (type === 'superChatEvent' || type === 'superStickerEvent') {
    const details = item.snippet?.superChatDetails || item.snippet?.superStickerDetails
    return { id: item.id, platform: 'YouTube', kind: 'superchat', user, userId, amount: details?.amountDisplayString, message: String(details?.userComment || '').trim() || undefined, time }
  }
  if (type === 'newSponsorEvent') {
    return { id: item.id, platform: 'YouTube', kind: 'membership', user, userId, message: item.snippet?.newSponsorDetails?.memberLevelName, time }
  }
  if (type === 'memberMilestoneChatEvent') {
    const months = Number(item.snippet?.memberMilestoneChatDetails?.memberMonth)
    return { id: item.id, platform: 'YouTube', kind: 'membership', user, userId, months: Number.isFinite(months) && months > 0 ? months : undefined, message: item.snippet?.memberMilestoneChatDetails?.memberLevelName, time }
  }
  if (type === 'membershipGiftingEvent') {
    const count = Number(item.snippet?.membershipGiftingDetails?.giftMembershipsCount)
    return { id: item.id, platform: 'YouTube', kind: 'gift', user, userId, amount: Number.isFinite(count) && count > 0 ? `${count} gift${count === 1 ? '' : 's'}` : undefined, time }
  }
}

/** Map an official Data API moderation event item (`messageDeletedEvent`/`userBannedEvent`) to a moderation change. */
export function youtubeOfficialModeration(item: any): ChatModeration | undefined {
  const type = String(item?.snippet?.type || '')
  if (type === 'messageDeletedEvent') {
    const messageId = item?.snippet?.messageDeletedDetails?.deletedMessageId
    if (!messageId) return
    return { action: 'delete', platform: 'YouTube', messageId: String(messageId) }
  }
  if (type === 'userBannedEvent') {
    const details = item?.snippet?.userBannedDetails?.bannedUserDetails
    const userId = details?.channelId ? String(details.channelId) : undefined
    const user = details?.displayName ? String(details.displayName).replace(/^@+/, '') : undefined
    if (!userId && !user) return
    return { action: 'ban', platform: 'YouTube', userId, user }
  }
}

export function missingStreamElementsMessage(missing: string[]) {
  if (!missing.length) return
  const keys = missing.map((platform) => `STREAMELEMENTS_JWT_${platform.toUpperCase()}`).join(', ')
  if (missing.length === 3) return `Add STREAMELEMENTS_JWT_TWITCH, STREAMELEMENTS_JWT_KICK, and STREAMELEMENTS_JWT_YOUTUBE in production.env, then restart.`
  return `Missing StreamElements JWT${missing.length === 1 ? '' : 's'} for ${missing.join(', ')}. Add ${keys} in production.env, then restart.`
}

export function emptyStreamDetails(): StreamDetails {
  return { title: '', category: '' }
}

export function emptyStreamInfo(): StreamInfoMap {
  return { Twitch: emptyStreamDetails(), Kick: emptyStreamDetails(), YouTube: emptyStreamDetails() }
}

/** Dedupe, trim, cap at 10. `undefined` means the payload omitted tags. */
export function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of value) {
    const tag = String(item || '').trim().replace(/^#+/, '')
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= STREAM_TAG_MAX) break
  }
  return tags
}

export function isTwitchTag(value: string) {
  return new RegExp(`^[A-Za-z0-9]{1,${TWITCH_TAG_MAX_LENGTH}}$`).test(value)
}

/** Twitch rejects spaces and specials; empty array clears channel tags. */
export function twitchTagsForApi(tags?: string[]) {
  if (!tags) return
  return tags.map((tag) => tag.trim().replace(/^#+/, '')).filter(isTwitchTag).slice(0, STREAM_TAG_MAX)
}

export function isKickTag(value: string) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(value)
}

/** Kick is freeform strings with no catalog; keep chips Kick can actually store. */
export function kickTagsForApi(tags?: string[]) {
  if (!tags) return
  return (normalizeTags(tags) || []).filter(isKickTag)
}

export function tagsEqual(left?: string[], right?: string[]) {
  const a = normalizeTags(left) || []
  const b = normalizeTags(right) || []
  if (a.length !== b.length) return false
  return a.every((tag, index) => tag.toLowerCase() === b[index].toLowerCase())
}

export function streamDetailsUnchanged(current: StreamDetails, next: StreamDetails) {
  return current.title === next.title
    && current.category === next.category
    && (current.categoryId || '') === (next.categoryId || '')
    && tagsEqual(current.tags, next.tags)
}

/**
 * Whether a YouTube description PUT would change anything. Uses the snippet we
 * already cached from liveBroadcasts.list — never an extra read (list is 1 unit,
 * update is 50).
 */
export function youtubeTagWriteNeeded(targets: { description?: string }[], persistedTags: string[] | undefined, nextTags: string[]) {
  if (targets.length) {
    return targets.some((target) => descriptionWithTagLine(target.description || '', nextTags) !== (target.description || ''))
  }
  return !tagsEqual(persistedTags, nextTags)
}

export function looksLikeTagLine(line: string) {
  const text = line.trim()
  if (!text || /[.!?]/.test(text)) return false
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  if (!tokens.length || tokens.length > STREAM_TAG_MAX) return false
  if (!tokens.every((token) => /^#?[A-Za-z0-9_]{1,40}$/.test(token))) return false
  // Lowercase words like "chat" / "tonight" are prose, not a tag line.
  if (tokens.some((token) => !token.startsWith('#') && token === token.toLowerCase() && token.length > 3)) return false
  return true
}

/** YouTube discovery wants a hash on the description line; chips and Twitch/Kick stay bare. */
export function youtubeTagLine(tags: string[]) {
  return (normalizeTags(tags) || []).map((tag) => `#${tag}`).join(' ')
}

export function parseTagsFromDescription(description: string) {
  const lines = String(description || '').replace(/\r\n/g, '\n').split('\n')
  const last = lines.at(-1) || ''
  if (!looksLikeTagLine(last)) return []
  return normalizeTags(last.split(/[\s,]+/)) || []
}

/** Replace or append the last description line; never rewrite the blurb above it. */
export function descriptionWithTagLine(description: string, tags: string[]) {
  const body = String(description || '').replace(/\r\n/g, '\n')
  const tagLine = youtubeTagLine(tags)
  const lines = body.split('\n')
  const lastIsTags = looksLikeTagLine(lines.at(-1) || '')
  if (lastIsTags) {
    if (!tagLine) {
      lines.pop()
      while (lines.length && lines.at(-1) === '') lines.pop()
      return lines.join('\n')
    }
    lines[lines.length - 1] = tagLine
    return lines.join('\n')
  }
  if (!tagLine) return body
  if (!body.trim()) return tagLine
  return `${body.replace(/\n+$/, '')}\n${tagLine}`
}

export function normalizeStreamDetails(value: unknown): StreamDetails {
  if (!value || typeof value !== 'object') return emptyStreamDetails()
  const item = value as Partial<StreamDetails>
  const title = String(item.title || '').trim()
  const category = String(item.category || '').trim()
  const categoryId = item.categoryId != null && String(item.categoryId).trim() ? String(item.categoryId).trim() : undefined
  const tags = normalizeTags(item.tags)
  return { title, category, ...(categoryId ? { categoryId } : {}), ...(tags ? { tags } : {}) }
}

export function loadStreamInfo(value: unknown): StreamInfoMap {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { Twitch: normalizeStreamDetails(raw.Twitch), Kick: normalizeStreamDetails(raw.Kick), YouTube: normalizeStreamDetails(raw.YouTube) }
}

export function isMoreSpecificCategory(specific: string, general: string) {
  const a = specific.trim().toLowerCase()
  const b = general.trim().toLowerCase()
  if (!a || !b || a === b || !a.startsWith(b)) return false
  const next = a[b.length]
  return next === ' ' || next === ':' || next === '-' || next === '('
}

export function applyLiveStreamDetails(current: StreamDetails, live: StreamDetails): StreamDetails {
  const title = (live.title || current.title || '').trim()
  const liveCategory = (live.category || '').trim()
  const currentCategory = (current.category || '').trim()
  const tags = live.tags !== undefined ? live.tags : current.tags
  const withTags = (details: StreamDetails): StreamDetails => tags !== undefined ? { ...details, tags } : details
  if (!liveCategory) return withTags({ title, category: currentCategory, ...(current.categoryId ? { categoryId: current.categoryId } : {}) })
  if (isMoreSpecificCategory(currentCategory, liveCategory)) {
    return withTags({ title, category: currentCategory, ...(current.categoryId ? { categoryId: current.categoryId } : {}) })
  }
  return withTags({ title, category: liveCategory, ...(live.categoryId ? { categoryId: live.categoryId } : current.categoryId ? { categoryId: current.categoryId } : {}) })
}

export function kickStreamDetails(channel: any): StreamDetails {
  const candidates = [
    channel?.category,
    channel?.subcategory,
    channel?.livestream?.category,
    ...(Array.isArray(channel?.livestream?.categories) ? channel.livestream.categories : []),
  ]
  let best: { name: string; id?: string } | undefined
  for (const item of candidates) {
    const name = String(item?.name || '').trim()
    const id = item?.id != null && String(item.id).trim() ? String(item.id) : undefined
    if (!name) continue
    if (!best || isMoreSpecificCategory(name, best.name) || (id && !best.id && name.toLowerCase() === best.name.toLowerCase())) best = { name, id }
  }
  const tags = normalizeTags(channel?.stream?.custom_tags)
  return { title: String(channel?.stream_title || '').trim(), category: best?.name || '', ...(best?.id ? { categoryId: best.id } : {}), ...(tags ? { tags } : {}) }
}

export function loadYouTubeQuota(value: unknown): YoutubeQuota {
  if (!value || typeof value !== 'object') return { day: '', used: 0 }
  const item = value as Partial<YoutubeQuota>
  const limit = item.limit != null ? Math.floor(Number(item.limit) || 0) : 0
  return { day: String(item.day || ''), used: Math.max(0, Math.floor(Number(item.used) || 0)), ...(limit > 0 ? { limit } : {}) }
}

export function defaultAppSettings(): AppSettings {
  return { activityFallback: true, ignoreMissingJwt: false, dropOldAlerts: false, translateChat: true, streamInfo: emptyStreamInfo(), youtubeQuota: { day: '', used: 0 } }
}

/** Coerce the persisted settings JSON into a known-good shape, filling missing keys with app defaults. */
export function parseAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return defaultAppSettings()
  const parsed = value as Partial<AppSettings>
  return {
    activityFallback: parsed.activityFallback !== false,
    ignoreMissingJwt: parsed.ignoreMissingJwt === true,
    dropOldAlerts: parsed.dropOldAlerts === true,
    translateChat: parsed.translateChat !== false,
    streamInfo: loadStreamInfo(parsed.streamInfo),
    youtubeQuota: loadYouTubeQuota(parsed.youtubeQuota),
  }
}

/** Build the provider's OAuth authorize URL. Kick needs PKCE, YouTube needs offline access, Twitch forces re-consent. */
export function oauthAuthorizeUrl(platform: Platform, options: { clientId: string; redirectUri: string; state: string; codeChallenge?: string }) {
  const params = new URLSearchParams({ client_id: options.clientId, redirect_uri: options.redirectUri, response_type: 'code', state: options.state })
  if (platform === 'Twitch') {
    params.set('scope', TWITCH_OAUTH_SCOPES)
    params.set('force_verify', 'true')
  }
  if (platform === 'Kick') {
    params.set('scope', KICK_OAUTH_SCOPES)
    if (options.codeChallenge) {
      params.set('code_challenge', options.codeChallenge)
      params.set('code_challenge_method', 'S256')
    }
  }
  if (platform === 'YouTube') {
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
    params.set('scope', YOUTUBE_OAUTH_SCOPES)
  }
  return platform === 'Twitch' ? `https://id.twitch.tv/oauth2/authorize?${params}` : platform === 'Kick' ? `https://id.kick.com/oauth/authorize?${params}` : `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export function tokenRefreshFailureMessage(platform: Platform) {
  return `${platform} token refresh failed - reconnect in settings`
}

export function tokenRefreshRetryMessage(platform: Platform) {
  return `${platform} token refresh failed — retrying`
}

export function isTokenRefreshHealthMessage(message: string) {
  return /token refresh failed/i.test(message)
}

export function shouldKeepTokenRefreshBanner(health: Health, connected: boolean) {
  return isTokenRefreshHealthMessage(health.message) && !connected
}

export function isPermanentTokenRefreshError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout|AbortError|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network|socket|429|502|503|504/i.test(text)) return false
  return /invalid_grant|invalid_token|unauthorized_client|invalid_client|invalid_request|\b400\b|\b401\b/i.test(text)
}

export type TranslateProvider = 'gtx' | 'google-v2' | 'libre'

/**
 * Choose the translation backend from env: `TRANSLATE_URL` → LibreTranslate,
 * a Google API key → official `google-v2`, and the default is the unofficial
 * `gtx` Google endpoint which needs no key at all.
 */
export function resolveTranslateConfig(env: Record<string, string | undefined> = process.env): { provider: TranslateProvider; url: string; key?: string } {
  const key = String(env.TRANSLATE_API_KEY || env.GOOGLE_TRANSLATE_API_KEY || '').trim() || undefined
  const url = String(env.TRANSLATE_URL || '').trim()
  if (url) return { provider: 'libre', url, key }
  if (key) return { provider: 'google-v2', url: 'https://translation.googleapis.com/language/translate/v2', key }
  return { provider: 'gtx', url: 'https://translate.googleapis.com/translate_a/single' }
}

/**
 * Pull the translated text from each provider's response shape: `gtx` returns
 * sentence rows, `google-v2` nests under `data.translations`, LibreTranslate
 * uses a flat `translatedText`. Returns `undefined` when translation didn't
 * change the text.
 */
export function parseTranslatedText(provider: TranslateProvider, data: any, original: string) {
  let translated = ''
  if (provider === 'gtx') translated = Array.isArray(data?.[0]) ? data[0].map((row: any) => String(row?.[0] || '')).join('').trim() : ''
  else if (provider === 'google-v2') translated = String(data?.data?.translations?.[0]?.translatedText || '').trim()
  else translated = String(data?.translatedText || data?.translation || '').trim()
  if (!translated || translated === original) return
  return translated
}

export function translateFailureMessage(provider: TranslateProvider) {
  if (provider === 'google-v2') return 'Chat translation failed (Google Translate API). Check TRANSLATE_API_KEY.'
  if (provider === 'libre') return 'Chat translation failed (TRANSLATE_URL). Messages stay untranslated.'
  return 'Chat translation failed (unofficial Google endpoint). Set TRANSLATE_API_KEY or TRANSLATE_URL, or turn translation off.'
}

export function sseBroadcastEvent(data: unknown, previous?: string) {
  const json = JSON.stringify(data)
  if (json === previous) return { json, payload: undefined, unchanged: true as const }
  return { json, payload: `data: ${json}\n\n`, unchanged: false as const }
}

export function sseNamedEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function sseChangedKeys(previous: Record<string, string>, next: Record<string, string>) {
  return Object.keys(next).filter((key) => previous[key] !== next[key])
}

export const TWITCH_EVENTSUB_DEFAULT_URL = 'wss://eventsub.wss.twitch.tv/ws'

/**
 * Decide how to (re)connect the EventSub websocket. A session URL other than
 * the default welcome endpoint means we can `resume` the same session and keep
 * generation/state as-is; a fresh connect bumps the generation so stale socket
 * events from the old session can be ignored.
 */
export function twitchEventSubConnectPlan(url: string, currentGeneration: number) {
  const resume = url !== TWITCH_EVENTSUB_DEFAULT_URL
  return { resume, generation: resume ? currentGeneration : currentGeneration + 1, keepPreviousUntilWelcome: resume }
}

export function twitchEventSubCloseAction(socketIsCurrent: boolean, generation: number, currentGeneration: number) {
  if (generation !== currentGeneration || !socketIsCurrent) return 'ignore' as const
  return 'reconnect' as const
}
