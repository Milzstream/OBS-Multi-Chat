import { fetchTimed, type FetchLike } from './fetch-timed.js'
import { bttvEmotes, ffzEmotes, mergeEmoteMaps, sevenTvEmotes, type EmoteMap } from './logic.js'
import type { Platform } from './types.js'

/**
 * Loads and caches 7TV, BetterTTV, and FrankerFaceZ emote sets. Twitch gets all
 * three. Kick gets 7TV channel + global. YouTube gets 7TV global only: 7TV's
 * `/v3/users/{platform}/{id}` no longer accepts `youtube` (HTTP 400
 * "invalid platform").
 *
 * `emotesFor` never waits: it returns whatever is cached and starts a load or a
 * refresh in the background, so chat is never held up by a slow emote API.
 */

export const EMOTE_REFRESH_MS = 30 * 60_000
export const EMOTE_RETRY_MS = 5 * 60_000
const EMOTE_TIMEOUT_MS = 10_000

type Source = { key: string; label: string; url: string; parse: (json: any) => Map<string, string> }
type Entry = { emotes: Map<string, string>; loadedAt: number; loading?: Promise<void> }

/** 7TV user-connection platforms that still exist. YouTube was dropped. */
const SEVEN_TV_CHANNEL_PLATFORM: Partial<Record<Platform, string>> = { Twitch: 'twitch', Kick: 'kick' }

function sourcesFor(platform: Platform, id: string): Source[] {
  const channel = encodeURIComponent(id)
  const sources: Source[] = []
  const seventvPlatform = SEVEN_TV_CHANNEL_PLATFORM[platform]
  if (seventvPlatform) {
    sources.push({ key: `7tv:${platform}:${id}`, label: '7TV', url: `https://7tv.io/v3/users/${seventvPlatform}/${channel}`, parse: sevenTvEmotes })
  }
  if (platform === 'Twitch') {
    sources.push(
      { key: `bttv:Twitch:${id}`, label: 'BTTV', url: `https://api.betterttv.net/3/cached/users/twitch/${channel}`, parse: bttvEmotes },
      { key: `ffz:Twitch:${id}`, label: 'FFZ', url: `https://api.frankerfacez.com/v1/room/id/${channel}`, parse: ffzEmotes },
    )
  }
  sources.push({ key: '7tv:global', label: '7TV', url: 'https://7tv.io/v3/emote-sets/global', parse: sevenTvEmotes })
  if (platform === 'Twitch') {
    sources.push(
      { key: 'bttv:global', label: 'BTTV', url: 'https://api.betterttv.net/3/cached/emotes/global', parse: bttvEmotes },
      { key: 'ffz:global', label: 'FFZ', url: 'https://api.frankerfacez.com/v1/set/global', parse: ffzEmotes },
    )
  }
  return sources
}

export function createThirdPartyEmotes(options: { fetchImpl?: FetchLike; now?: () => number; log?: (line: string) => void } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.log(line))
  const entries = new Map<string, Entry>()
  const merged = new Map<string, { version: number; emotes: Map<string, string> }>()
  let version = 0

  async function load(source: Source, entry: Entry) {
    try {
      const response = await fetchTimed(source.url, { headers: { Accept: 'application/json' } }, EMOTE_TIMEOUT_MS, fetchImpl)
      // No account on that service is 404. 7TV also 400s "invalid platform" for
      // dropped user-connection platforms (YouTube) instead of 404.
      const missing = response.status === 404
        || (response.status === 400 && source.label === '7TV' && !source.key.endsWith(':global'))
      if (missing) {
        await response.body?.cancel().catch(() => {})
        entry.emotes = new Map()
      } else if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${response.status}`)
      } else {
        entry.emotes = source.parse(await response.json())
        if (!source.key.endsWith(':global')) log(`${source.label} emotes: ${entry.emotes.size} for ${source.key.split(':')[1]}`)
      }
      entry.loadedAt = now()
    } catch (error) {
      // Keep the last good set and try again sooner than a normal refresh.
      entry.loadedAt = now() - EMOTE_REFRESH_MS + EMOTE_RETRY_MS
      log(`${source.label} emotes could not load: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      entry.loading = undefined
      version += 1
    }
  }

  function entryFor(source: Source) {
    let entry = entries.get(source.key)
    if (!entry) {
      entry = { emotes: new Map(), loadedAt: Number.NEGATIVE_INFINITY }
      entries.set(source.key, entry)
    }
    if (!entry.loading && now() - entry.loadedAt >= EMOTE_REFRESH_MS) entry.loading = load(source, entry)
    return entry
  }

  /** Cached emotes for this channel, channel sets ahead of global ones. Starts any load that is due. */
  function emotesFor(platform: Platform, id: string | undefined): EmoteMap {
    if (!id) return new Map()
    const sources = sourcesFor(platform, id)
    const sets = sources.map((source) => entryFor(source).emotes)
    const key = `${platform}:${id}`
    const cached = merged.get(key)
    if (cached && cached.version === version) return cached.emotes
    const emotes = mergeEmoteMaps(...sets)
    merged.set(key, { version, emotes })
    return emotes
  }

  /** Resolves once every load this channel has started is done. For tests and the startup prefetch. */
  async function ready(platform: Platform, id: string | undefined) {
    if (!id) return
    emotesFor(platform, id)
    await Promise.all(sourcesFor(platform, id).map((source) => entries.get(source.key)?.loading))
  }

  return { emotesFor, ready }
}
