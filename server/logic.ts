import crypto from 'node:crypto'
import type { ActivityEvent } from './activity.js'
import type { YouTubeChatTarget } from './youtube-chat.js'
import {
  CHAT_MAX,
  KICK_OAUTH_SCOPES,
  TWITCH_OAUTH_SCOPES,
  YOUTUBE_OAUTH_SCOPES,
  type AppSettings,
  type ChatBadge,
  type ChatMessage,
  type Health,
  type MessagePart,
  type Platform,
  type StreamDetails,
  type StreamPlatform,
  type YoutubeQuota,
} from './types.js'

export {
  CHAT_MAX,
  KICK_OAUTH_SCOPES,
  TWITCH_OAUTH_SCOPES,
  YOUTUBE_OAUTH_SCOPES,
  YOUTUBE_QUOTA_LIMIT,
} from './types.js'

const NON_ENGLISH = /[\u0400-\u052F\u0600-\u06FF\u0750-\u077F\u1100-\u11FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0590-\u05FF]/

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

export function youtubeQuotaCost(endpoint: string, method = 'GET') {
  const path = endpoint.split('?')[0].replace(/^\//, '')
  if (path.startsWith('liveChat/bans')) return 50
  if (path.startsWith('liveChat/messages')) return 5
  return 1
}

export function youtubeQuotaLabel(endpoint: string, method = 'GET') {
  const path = endpoint.split('?')[0].replace(/^\//, '')
  const verb = method.toUpperCase()
  if (path.startsWith('liveChat/bans')) return verb === 'DELETE' ? 'liveChatBans.delete' : 'liveChatBans.insert'
  if (path.startsWith('liveChat/messages')) return verb === 'POST' ? 'liveChatMessages.insert' : verb === 'DELETE' ? 'liveChatMessages.delete' : 'liveChatMessages.list'
  if (path.startsWith('liveBroadcasts')) return 'liveBroadcasts.list'
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

export function quotaFromHeaders(headers: Headers): { used?: number; remaining?: number; limit?: number } | undefined {
  const remaining = headerNumber(headers, ['ratelimit-remaining', 'x-ratelimit-remaining', 'x-rate-limit-remaining', 'x-quota-remaining'])
  const limit = headerNumber(headers, ['ratelimit-limit', 'x-ratelimit-limit', 'x-rate-limit-limit', 'x-quota-limit'])
  const used = headerNumber(headers, ['x-quota-used', 'x-ratelimit-used'])
  if (remaining == null && limit == null && used == null) return
  return { remaining, limit, used }
}

export function isDailyQuotaHeader(parsed: { used?: number; remaining?: number; limit?: number }) {
  return (parsed.limit != null && parsed.limit >= 1000) || (parsed.used != null && parsed.used >= 0 && (parsed.limit == null || parsed.limit >= 1000))
}

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

export function truncatedFoldMatches(left: string, right: string) {
  if (!left || !right) return false
  if (left === right) return true
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  if (!isTruncatedText(short)) return false
  const prefix = short.replace(/(?:\.{2,}|…)\s*$/g, '').trim()
  return prefix.length >= 12 && long.startsWith(prefix)
}

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
    const metaChanged = Boolean((message.userId && !current.userId) || (message.avatar && !current.avatar) || (!current.badges?.length && message.badges?.length))
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

export function needsTranslation(text: string) {
  return NON_ENGLISH.test(text)
}

export function twitchEventToActivity(type: string, event: any, now = new Date().toISOString()): ActivityEvent | undefined {
  const time = now
  if (type === 'channel.follow') {
    return { id: `twitch-follow-${event?.user_id}-${event?.followed_at || time}`, platform: 'Twitch', kind: 'follow', user: event?.user_login || event?.user_name || 'Twitch user', userId: event?.user_id ? String(event.user_id) : undefined, time: event?.followed_at || time }
  }
  if (type === 'channel.subscribe') {
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

export function missingStreamElementsMessage(missing: string[]) {
  if (!missing.length) return
  const keys = missing.map((platform) => `STREAMELEMENTS_JWT_${platform.toUpperCase()}`).join(', ')
  if (missing.length === 3) return `Add STREAMELEMENTS_JWT_TWITCH, STREAMELEMENTS_JWT_KICK, and STREAMELEMENTS_JWT_YOUTUBE in production.env, then restart.`
  return `Missing StreamElements JWT${missing.length === 1 ? '' : 's'} for ${missing.join(', ')}. Add ${keys} in production.env, then restart.`
}

export function emptyStreamDetails(): StreamDetails {
  return { title: '', category: '' }
}

export function emptyStreamInfo(): Record<StreamPlatform, StreamDetails> {
  return { Twitch: emptyStreamDetails(), Kick: emptyStreamDetails() }
}

export function normalizeStreamDetails(value: unknown): StreamDetails {
  if (!value || typeof value !== 'object') return emptyStreamDetails()
  const item = value as Partial<StreamDetails>
  const title = String(item.title || '').trim()
  const category = String(item.category || '').trim()
  const categoryId = item.categoryId != null && String(item.categoryId).trim() ? String(item.categoryId).trim() : undefined
  return { title, category, ...(categoryId ? { categoryId } : {}) }
}

export function loadStreamInfo(value: unknown): Record<StreamPlatform, StreamDetails> {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { Twitch: normalizeStreamDetails(raw.Twitch), Kick: normalizeStreamDetails(raw.Kick) }
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
  if (!liveCategory) return { title, category: currentCategory, ...(current.categoryId ? { categoryId: current.categoryId } : {}) }
  if (isMoreSpecificCategory(currentCategory, liveCategory)) {
    return { title, category: currentCategory, ...(current.categoryId ? { categoryId: current.categoryId } : {}) }
  }
  return { title, category: liveCategory, ...(live.categoryId ? { categoryId: live.categoryId } : current.categoryId ? { categoryId: current.categoryId } : {}) }
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
  return { title: String(channel?.stream_title || '').trim(), category: best?.name || '', ...(best?.id ? { categoryId: best.id } : {}) }
}

export function loadYouTubeQuota(value: unknown): YoutubeQuota {
  if (!value || typeof value !== 'object') return { day: '', used: 0 }
  const item = value as Partial<YoutubeQuota>
  const limit = item.limit != null ? Math.floor(Number(item.limit) || 0) : 0
  return { day: String(item.day || ''), used: Math.max(0, Math.floor(Number(item.used) || 0)), ...(limit > 0 ? { limit } : {}) }
}

export function defaultAppSettings(): AppSettings {
  return { activityFallback: true, ignoreMissingJwt: false, dropOldAlerts: false, streamInfo: emptyStreamInfo(), youtubeQuota: { day: '', used: 0 } }
}

export function parseAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return defaultAppSettings()
  const parsed = value as Partial<AppSettings>
  return {
    activityFallback: parsed.activityFallback !== false,
    ignoreMissingJwt: parsed.ignoreMissingJwt === true,
    dropOldAlerts: parsed.dropOldAlerts === true,
    streamInfo: loadStreamInfo(parsed.streamInfo),
    youtubeQuota: loadYouTubeQuota(parsed.youtubeQuota),
  }
}

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
