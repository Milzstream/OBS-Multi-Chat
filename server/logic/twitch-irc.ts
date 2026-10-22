/**
 * Twitch IRC parse, badges, emotes, EventSub reconnect plans, EventSub-to-activity mapping.
 */

import crypto from 'node:crypto'
import type { ActivityEvent } from '../activity.js'
import type { ChatBadge, ChatMessage, ChatModeration, MessagePart } from '../types.js'

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

/**
 * IRCv3 tag escapes: `\s` space, `\:` semicolon, `\\` backslash, `\r` CR, `\n` LF.
 * Unknown sequences are left intact so a display name is not eaten.
 */
export function unescapeIrcTag(value: string) {
  return value.replace(/\\(.)/g, (match, ch: string) => {
    if (ch === 's') return ' '
    if (ch === ':') return ';'
    if (ch === '\\') return '\\'
    if (ch === 'r') return '\r'
    if (ch === 'n') return '\n'
    return match
  })
}

export function parseIrcTags(raw: string) {
  return Object.fromEntries((raw || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=')
    return index === -1 ? [item, ''] : [item.slice(0, index), unescapeIrcTag(item.slice(index + 1))]
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


export function twitchEmoteUrl(id: string) {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`
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
    handle: match[2],
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


export function sanitizeIrcMessage(text: string) {
  return text.replace(/[\r\n\0]/g, ' ')
}


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

export function twitchEventSubRetryDelay(attempt: number) {
  return Math.min(30_000, 3_000 * 2 ** Math.max(0, attempt))
}

/** A socket that has not welcomed yet must not be closed for the previous session's keepalive. */
export function twitchEventSubWatchdogShouldClose(ready: boolean, lastMessageAt: number, now: number, keepaliveMs: number) {
  if (!ready || !lastMessageAt) return false
  return now - lastMessageAt > keepaliveMs + 2_000
}

/**
 * Subscribe completion must not mark a socket ready after a newer session won.
 * A stale completion used to set ready and close IRC for a session that was already gone.
 */
export function twitchEventSubSubscribeStillCurrent(startedGeneration: number, startedSessionId: string, generation: number, sessionId: string) {
  return startedGeneration === generation && startedSessionId !== '' && startedSessionId === sessionId
}

export function twitchEventSubCloseAction(socketIsCurrent: boolean, generation: number, currentGeneration: number, resumeInFlight = false, isResumeSocket = false) {
  if (generation !== currentGeneration) return 'ignore' as const
  if (resumeInFlight && isResumeSocket && !socketIsCurrent) return 'resume-failed' as const
  if (resumeInFlight && socketIsCurrent) return 'ignore' as const
  if (!socketIsCurrent) return 'ignore' as const
  return 'reconnect' as const
}

