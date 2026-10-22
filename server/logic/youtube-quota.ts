/**
 * YouTube Data API quota math, Pacific-day rollover, and live-status poll cadence.
 */

import { type Health, type YoutubeQuota } from '../types.js'

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
  if (path.startsWith('videos')) {
    // videos.list is 1. videos.update and videos.delete are 50. insert is unused.
    if (verb === 'PUT' || verb === 'DELETE') return 50
    return 1
  }
  if (path.startsWith('channels')) return 1

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
  if (path.startsWith('videos')) {
    if (verb === 'PUT') return 'videos.update'
    if (verb === 'DELETE') return 'videos.delete'
    return 'videos.list'
  }
  
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


export function loadYouTubeQuota(value: unknown): YoutubeQuota {
  if (!value || typeof value !== 'object') return { day: '', used: 0 }
  const item = value as Partial<YoutubeQuota>
  const limit = item.limit != null ? Math.floor(Number(item.limit) || 0) : 0
  const blockedUntil = Number(item.blockedUntil)
  return {
    day: String(item.day || ''),
    used: Math.max(0, Math.floor(Number(item.used) || 0)),
    ...(limit > 0 ? { limit } : {}),
    ...(Number.isFinite(blockedUntil) && blockedUntil > 0 ? { blockedUntil } : {}),
  }
}

/** Same Pacific day at or over the cap stays paused, including after a restart that lost the in-memory timestamp. */
export function restoreYouTubeQuotaBlock(saved: Pick<YoutubeQuota, 'day' | 'used' | 'limit' | 'blockedUntil'>, now = Date.now(), limitDefault = 10_000) {
  if (!saved.day || saved.day !== pacificDate(now)) return 0
  if (saved.blockedUntil && saved.blockedUntil > now) return saved.blockedUntil
  const limit = saved.limit && saved.limit > 0 ? saved.limit : limitDefault
  if (saved.used >= limit) return nextPacificMidnight(now)
  return 0
}


export function shouldPollLiveStatus(autoEnabled: boolean, reason: 'auto' | 'manual') {
  return reason === 'manual' || autoEnabled
}

/** Twitch, Kick, and the shared poll loop. YouTube uses this only until it is live. */
export const LIVE_STATUS_POLL_MS = 15_000

/**
 * While live, `liveBroadcasts.list` does not need the 15s loop. Five minutes
 * still notices the broadcast ending, and an 8-hour stream is about 96 units
 * instead of ~1,900. The list call itself is 1 unit.
 */
export const YOUTUBE_STATUS_LIVE_MS = 5 * 60_000

/** Offline matches Twitch/Kick. Live stays slower so ending the stream is not a 15s quota poll. */
export function youtubeStatusIntervalMs(live: boolean) {
  return live ? YOUTUBE_STATUS_LIVE_MS : LIVE_STATUS_POLL_MS
}

/**
 * YouTube's official liveBroadcasts call spends quota. Skip it on the automatic
 * interval when Auto is off. A manual Check live still runs it. `due` is
 * `youtubeStatusIntervalMs`, or a forced follow-up such as a failed site chat
 * while Auto is still on.
 */
export function shouldRunYouTubeStatusCheck(options: { autoEnabled: boolean; manual: boolean; due: boolean }) {
  if (options.manual) return true
  return options.autoEnabled && options.due
}

/**
 * Auto off skips the launch poll, including token refresh and the history seed
 * against a saved chat id. An InnerTube session that is already up keeps running.
 */
export function shouldRunYouTubeMaintenance(options: { autoEnabled: boolean; manual: boolean; chatConnected: boolean }) {
  if (options.manual || options.autoEnabled) return true
  return options.chatConnected
}

