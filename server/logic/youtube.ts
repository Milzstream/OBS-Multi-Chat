/**
 * YouTube live-chat ids, send bodies, official activity/moderation mapping, description tags.
 */

import type { ActivityEvent } from '../activity.js'
import type { YouTubeChatTarget } from '../youtube-chat.js'
import type { ChatBadge, ChatMessage, ChatModeration } from '../types.js'
import { STREAM_TAG_MAX } from '../types.js'
import { normalizeTags, tagsEqual } from './stream-info.js'

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
  if (targets.length) return []
  if (token?.liveChatIds?.length) return [...new Set(token.liveChatIds)]
  if (token?.liveChatId) return [token.liveChatId]
  return []
}

/** Ban targets are live chat ids only. A scraped video id is not a `liveChatId`. */
export function youtubeBanChatIds(sourceId: string | undefined, targets: YouTubeChatTarget[], token?: { liveChatIds?: string[]; liveChatId?: string }) {
  const ids = new Set(resolveYouTubeLiveChatIds(targets, token))
  if (sourceId) {
    const match = targets.find((target) => target.liveChatId === sourceId || target.videoId === sourceId)
    if (match?.liveChatId) ids.add(match.liveChatId)
  }
  return [...ids].filter((id) => !targets.some((target) => target.videoId === id && target.liveChatId !== id))
}

/** A newly scraped video must not inherit the previous broadcast's chat id. */
export function youtubeScrapedTarget(found: { videoId: string; title?: string }, existing?: { liveChatId?: string }) {
  return { videoId: found.videoId, ...(existing?.liveChatId ? { liveChatId: existing.liveChatId } : {}), ...(found.title ? { title: found.title } : {}) }
}

export function youtubeLiveChatListQuery(chatId: string, pageToken?: string, maxResults?: number) {
  const params = new URLSearchParams({ liveChatId: chatId, part: 'snippet,authorDetails' })
  if (pageToken) params.set('pageToken', pageToken)
  if (maxResults) params.set('maxResults', String(maxResults))
  return `/liveChat/messages?${params}`
}

export function youtubeLiveChatCursor(payload: { nextPageToken?: string; pollingIntervalMillis?: number } | null | undefined) {
  const waitMs = Number(payload?.pollingIntervalMillis)
  return {
    pageToken: payload?.nextPageToken || undefined,
    waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 45_000,
  }
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

/**
 * `liveChatMessages.insert` returns a `liveChatMessage` resource whose `id`
 * is what delete needs. A non-JSON or id-less body is not a failed send —
 * the caller already checked HTTP ok. Echo ingest can still supply the id.
 */
export function youtubeInsertedMessageId(text: string) {
  try {
    const parsed = JSON.parse(text) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id ? parsed.id : undefined
  } catch {
    return
  }
}

/** Twitch Helix `reason` max. Kick accepts the same string; a blank reason is omitted rather than defaulted. */

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


export function pruneYouTubeSeenIds(seenIds: Set<string>, messages: ChatMessage[]) {
  const retained = new Set(messages.filter((message) => message.platform === 'YouTube' || message.platforms?.includes('YouTube')).map((message) => message.id))
  for (const id of seenIds) if (!retained.has(id)) seenIds.delete(id)
}

/** Map a Twitch EventSub subscription payload type to an Activity dock event. Unknown types yield nothing. */

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


export function youtubeBanRecord(entries: Iterable<[string, string[]]>) {
  const record: Record<string, string[]> = {}
  for (const [userId, ids] of entries) {
    const key = userId.trim().toLowerCase()
    const clean = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))]
    if (key && clean.length) record[key] = clean
  }
  return record
}

export function loadYoutubeBanIds(raw: unknown) {
  const map = new Map<string, string[]>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map
  for (const [userId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue
    const clean = ids.map((id) => String(id).trim()).filter(Boolean)
    if (userId.trim() && clean.length) map.set(userId.trim().toLowerCase(), clean)
  }
  return map
}


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

