/**
 * Shared helpers for the chat and activity docks: avatar/media URL proxying,
 * Kick handle normalization, category preference, feed filtering, combobox
 * highlight math, and the YouTube Studio URL the stream-controls link opens.
 */

export type ChatPlatform = 'Twitch' | 'Kick' | 'YouTube'

/** Rewrite Kick CDN avatar URLs through the local `/api/media` proxy so OBS's sandboxed renderer can load them. */
export function dockAvatarSrc(url?: string) {
  if (!url) return
  try {
    const href = url.startsWith('//') ? `https:${url}` : url
    const host = new URL(href).hostname.toLowerCase()
    if (host === 'files.kick.com' || host.endsWith('.kick.com')) return `/api/media?u=${encodeURIComponent(href)}`
  } catch { return url }
  return url
}

/**
 * Resolve a Kick profile slug: prefer the relay's recorded `slug`, otherwise
 * fall back to the username with `@` stripped and underscores turned into
 * dashes (Kick usernames allow underscores but profile URLs do not).
 */
export function kickProfileSlug(user: string, slug?: string) {
  const fromSlug = String(slug || '').replace(/^@+/, '').trim().toLowerCase()
  if (fromSlug) return fromSlug
  return String(user || '').replace(/^@+/, '').trim().toLowerCase().replace(/_/g, '-')
}

export function preferredCategory(twitch: string, kick: string) {
  const twitchName = twitch.trim()
  const kickName = kick.trim()
  if (!twitchName) return kickName
  if (!kickName) return twitchName
  return twitchName.length >= kickName.length ? twitchName : kickName
}

export function visibleChatMessages<T extends { platform: ChatPlatform; platforms?: ChatPlatform[] }>(messages: T[], filter: 'All' | ChatPlatform) {
  if (filter === 'All') return messages
  return messages.filter((message) => (message.platforms || [message.platform]).includes(filter))
}

/** Send targets default to every connected platform minus any the user has opted out of this session. */
export function selectedSendPlatforms(connected: ChatPlatform[], optOut: Iterable<ChatPlatform> = []) {
  const skip = new Set(optOut)
  return (['Twitch', 'Kick', 'YouTube'] as ChatPlatform[]).filter((platform) => connected.includes(platform) && !skip.has(platform))
}

/** Clamp a combobox highlight. Closed lists never call this; delta is +1 / -1. */
export function nextOptionIndex(current: number, length: number, delta: number) {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, current + delta))
}

export type CategoryHit = { id: string; name: string }
export type MergedCategory = { name: string; twitchId?: string; kickId?: string }

/** Fold Twitch and Kick category hits by case-insensitive name. Shared rows first. */
export function mergeCategoryResults(twitch: CategoryHit[], kick: CategoryHit[]): MergedCategory[] {
  const byName = new Map<string, MergedCategory>()
  const key = (name: string) => name.trim().toLowerCase()
  for (const item of twitch) {
    const id = key(item.name)
    if (!id) continue
    const current = byName.get(id)
    if (current) current.twitchId = item.id
    else byName.set(id, { name: item.name, twitchId: item.id })
  }
  for (const item of kick) {
    const id = key(item.name)
    if (!id) continue
    const current = byName.get(id)
    if (current) {
      current.kickId = item.id
      if (item.name.length > current.name.length) current.name = item.name
    } else byName.set(id, { name: item.name, kickId: item.id })
  }
  return [...byName.values()].sort((left, right) => {
    const leftBoth = Number(Boolean(left.twitchId && left.kickId))
    const rightBoth = Number(Boolean(right.twitchId && right.kickId))
    if (leftBoth !== rightBoth) return rightBoth - leftBoth
    return left.name.localeCompare(right.name)
  })
}

export type TagPlatform = 'Twitch' | 'Kick' | 'YouTube'

/** Twitch: letters/numbers 1–25. Kick: those plus - _. YouTube: any leftover hashtag. No catalog/autocomplete APIs. */
export function tagPlatforms(tag: string): TagPlatform[] {
  const value = tag.trim().replace(/^#+/, '')
  if (!value) return []
  if (/^[A-Za-z0-9]{1,25}$/.test(value)) return ['Twitch', 'Kick', 'YouTube']
  if (/^[A-Za-z0-9_-]{1,40}$/.test(value)) return ['Kick', 'YouTube']
  return ['YouTube']
}

export function sharedStreamTags(...lists: Array<string[] | undefined>) {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const list of lists) {
    for (const tag of list || []) {
      const value = tag.trim().replace(/^#+/, '')
      const key = value.toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      tags.push(value)
      if (tags.length >= 10) return tags
    }
  }
  return tags
}

/** YouTube Studio live page when we have a channel id; otherwise the Studio home. */
export function youtubeStudioUrl(channelId?: string) {
  const id = String(channelId || '').trim()
  if (/^UC[\w-]{20,}$/i.test(id)) return `https://studio.youtube.com/channel/${encodeURIComponent(id)}/livestreaming`
  return 'https://studio.youtube.com'
}
