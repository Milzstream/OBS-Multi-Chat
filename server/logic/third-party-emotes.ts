/**
 * 7TV, BetterTTV, and FrankerFaceZ emote parsing. Pure: the fetching and
 * caching live in `server/third-party-emotes.ts`.
 *
 * These emotes are plain words in chat. The platform never marks them, so a
 * word becomes an emote when it exactly matches a name in the channel's or the
 * global set (case-sensitive, like the browser extensions).
 */

import type { MessagePart } from '../types.js'

/** Emote name to image URL. */
export type EmoteMap = ReadonlyMap<string, string>

function list(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

/** 7TV emote set (`/v3/emote-sets/global`) or user connection (`/v3/users/{twitch|kick}/{id}`). */
export function sevenTvEmotes(json: any): Map<string, string> {
  const emotes = new Map<string, string>()
  for (const emote of list(json?.emotes ?? json?.emote_set?.emotes)) {
    const name = String(emote?.name || '')
    const host = String(emote?.data?.host?.url || '')
    if (!name || !host.startsWith('//cdn.7tv.app/')) continue
    if (!emotes.has(name)) emotes.set(name, `https:${host}/2x.webp`)
  }
  return emotes
}

/** BetterTTV global list (`/3/cached/emotes/global`) or channel (`/3/cached/users/twitch/{id}`). Modifier emotes are skipped. */
export function bttvEmotes(json: any): Map<string, string> {
  const emotes = new Map<string, string>()
  const all = Array.isArray(json) ? json : [...list(json?.channelEmotes), ...list(json?.sharedEmotes)]
  for (const emote of all) {
    const name = String(emote?.code || '')
    const id = String(emote?.id || '')
    if (!name || !/^[a-f0-9]{24}$/i.test(id) || emote?.modifier) continue
    if (!emotes.has(name)) emotes.set(name, `https://cdn.betterttv.net/emote/${id}/2x`)
  }
  return emotes
}

/**
 * FrankerFaceZ global (`/v1/set/global`, only its `default_sets`) or room
 * (`/v1/room/id/{id}`, every set it returns). Modifier emotes are skipped.
 */
export function ffzEmotes(json: any): Map<string, string> {
  const emotes = new Map<string, string>()
  const sets = json?.sets && typeof json.sets === 'object' ? json.sets : {}
  const ids = Array.isArray(json?.default_sets) ? json.default_sets.map(String) : Object.keys(sets)
  for (const id of ids) {
    for (const emote of list(sets[id]?.emoticons)) {
      const name = String(emote?.name || '')
      const url = String(emote?.urls?.['2'] || emote?.urls?.['1'] || '')
      if (!name || emote?.modifier || !url.startsWith('https://cdn.frankerfacez.com/')) continue
      if (!emotes.has(name)) emotes.set(name, url)
    }
  }
  return emotes
}

/** Combine sets in priority order: the first set that has a name wins. */
export function mergeEmoteMaps(...maps: Array<EmoteMap | undefined>): Map<string, string> {
  const merged = new Map<string, string>()
  for (const map of maps) {
    for (const [name, url] of map || []) if (!merged.has(name)) merged.set(name, url)
  }
  return merged
}

/**
 * Turn whole words that match an emote name into emote parts. Platform emote
 * parts are kept as they are. Returns the same array when nothing matched, so
 * an unchanged row keeps its identity.
 */
export function applyThirdPartyEmotes(parts: MessagePart[], emotes: EmoteMap): MessagePart[] {
  if (!emotes.size) return parts
  const next: MessagePart[] = []
  let changed = false
  let text = ''
  const flush = () => {
    if (text) next.push({ type: 'text', text })
    text = ''
  }
  for (const part of parts) {
    if (part.type !== 'text') {
      flush()
      next.push(part)
      continue
    }
    for (const token of part.text.split(/(\s+)/)) {
      const url = token && emotes.get(token)
      if (!url) {
        text += token
        continue
      }
      changed = true
      flush()
      next.push({ type: 'emote', name: token, url })
    }
  }
  flush()
  return changed ? next : parts
}
