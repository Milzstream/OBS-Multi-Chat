import { readJsonFile, writeJsonAtomic } from './persist.js'

/**
 * Activity dock store: in-memory array backed by an atomic JSON file. Feed
 * events from every platform land here so the Activity dock can show follows,
 * subs, gifts, cheers, raids, and donations in one timeline.
 *
 * Reads and writes go through `persist.ts`. This file owns no network calls.
 */

export type ActivityPlatform = 'Twitch' | 'Kick' | 'YouTube' | 'StreamElements'
export type ActivityKind = 'follow' | 'subscription' | 'gift' | 'cheer' | 'raid' | 'donation' | 'membership' | 'superchat' | 'merch'

export type ActivityEvent = {
  id: string
  platform: ActivityPlatform
  kind: ActivityKind
  user: string
  userId?: string
  handle?: string
  amount?: string
  months?: number
  viewers?: number
  message?: string
  time: string
  profileUrl?: string
  source?: ActivityPlatform
}

/** Kick handles in messages are the dash-separated URL slug, not the display username. Normalize to that form. */
export function kickProfileSlug(user: string, slug?: string) {
  const fromSlug = String(slug || '').replace(/^@+/, '').trim().toLowerCase()
  if (fromSlug) return fromSlug
  return String(user || '').replace(/^@+/, '').trim().toLowerCase().replace(/_/g, '-')
}

/** Coerce a feed timestamp into an ISO string. Accepts epoch seconds, epoch ms, bson `$date`, and RFC dates. */
export function parseActivityTime(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 0 && value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    if (Number.isFinite(date.getTime())) return date.toISOString()
  }
  if (value && typeof value === 'object' && '$date' in (value as object)) return parseActivityTime((value as { $date: unknown }).$date)
  const raw = String(value || '').trim()
  if (!raw) return new Date().toISOString()
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    const ms = n > 0 && n < 1e12 ? n * 1000 : n
    const date = new Date(ms)
    if (Number.isFinite(date.getTime())) return date.toISOString()
  }
  const parsed = Date.parse(raw)
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  return new Date().toISOString()
}

/** Build a clickable profile link per platform. Anonymous/test users get none. */
export function profileUrl(platform: ActivityPlatform, user: string, userId?: string, slug?: string) {
  const handle = String(user || '').replace(/^@+/, '').trim().toLowerCase()
  if (!handle || /^anonymous$/i.test(handle) || handle === 'testuser') return
  if (platform === 'Twitch') return `https://www.twitch.tv/${encodeURIComponent(handle)}`
  if (platform === 'Kick') return `https://kick.com/${encodeURIComponent(kickProfileSlug(user, slug))}`
  if (platform === 'YouTube') {
    if (userId && /^UC[\w-]{20,}$/i.test(userId)) return `https://www.youtube.com/channel/${encodeURIComponent(userId)}`
    return `https://www.youtube.com/@${encodeURIComponent(handle)}`
  }
}

function newestFirst(events: ActivityEvent[]) {
  return [...events].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0))
}

const MAX_EVENTS = 300
/** Live events older than this are pruned from the file store so it can't grow without bound. */
export const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function fallbackId(event: Omit<ActivityEvent, 'id'> & { id?: string }) {
  const bucket = Math.floor((Date.parse(event.time) || Date.now()) / 5_000)
  return `${event.platform}:${event.kind}:${(event.user || 'anonymous').toLowerCase()}:${bucket}:${event.amount || event.months || event.viewers || ''}`
}

function isTestEvent(event: ActivityEvent) {
  return event.id.startsWith('test-') || event.user === 'TestUser'
}

function prune(events: ActivityEvent[], maxAgeMs = 0) {
  const cutoff = maxAgeMs ? Date.now() - maxAgeMs : 0
  return events.filter((event) => {
    if (isTestEvent(event)) return false
    const at = Date.parse(event.time)
    if (!Number.isFinite(at)) return false
    if (cutoff && at < cutoff) return false
    return true
  }).slice(0, MAX_EVENTS)
}

/**
 * Full event store: keeps everything in memory for fast reads, persists to a
 * single JSON file via `persist.ts`, and prunes both by age and count.
 * Test events stay in memory only — they never touch the file.
 */
export function createActivityStore(filePath: string) {
  let events: ActivityEvent[] = []
  let maxAgeMs = 0

  function persistable() {
    return prune(events.filter((event) => !isTestEvent(event)), maxAgeMs)
  }

  function save() {
    writeJsonAtomic(filePath, persistable())
  }

  function load() {
    const parsed = readJsonFile<unknown>(filePath, null)
    if (!Array.isArray(parsed)) {
      events = []
      return
    }
    const incoming = parsed as ActivityEvent[]
    events = newestFirst(prune(incoming, maxAgeMs).map((event) => {
      const source = event.source || (event.profileUrl?.includes('youtube.com') ? 'YouTube' : event.profileUrl?.includes('kick.com') ? 'Kick' : event.profileUrl?.includes('twitch.tv') ? 'Twitch' : event.platform)
      return {
        ...event,
        source,
        time: parseActivityTime(event.time),
        profileUrl: event.profileUrl || profileUrl(source, event.user, event.userId, event.handle),
      }
    }))
    save()
  }

  load()

  return {
    setMaxAge(ms: number) {
      maxAgeMs = ms > 0 ? ms : 0
      const tests = events.filter(isTestEvent)
      const real = prune(events, maxAgeMs)
      events = newestFirst([...tests, ...real])
      try { save() } catch { /* ignore */ }
    },
    list: () => {
      const tests = events.filter(isTestEvent)
      const real = prune(events, maxAgeMs)
      if (real.length !== events.length - tests.length) {
        events = newestFirst([...tests, ...real])
        try { save() } catch { /* ignore */ }
      } else {
        events = newestFirst(events)
      }
      return events
    },
    add(incoming: ActivityEvent) {
      const user = String(incoming.user || 'Anonymous').replace(/^@+/, '') || 'Anonymous'
      const source = incoming.source || incoming.platform
      const event: ActivityEvent = {
        ...incoming,
        user,
        source,
        id: incoming.id || fallbackId({ ...incoming, user }),
        time: parseActivityTime(incoming.time),
        profileUrl: incoming.profileUrl || profileUrl(source, incoming.user || user, incoming.userId, incoming.handle),
      }
      if (events.some((item) => item.id === event.id)) return false
      const at = Date.parse(event.time) || Date.now()
      if (events.some((item) => item.platform === event.platform && item.kind === event.kind && item.user.toLowerCase() === event.user.toLowerCase() && Math.abs((Date.parse(item.time) || 0) - at) < 15_000 && (item.amount || '') === (event.amount || ''))) return false
      events = newestFirst([event, ...events]).slice(0, MAX_EVENTS)
      if (!isTestEvent(event)) {
        try { save() } catch (error) { console.error('Activity save:', error instanceof Error ? error.message : error) }
      }
      return true
    },
  }
}
