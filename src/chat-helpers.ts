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

/** YouTube Studio live page when we have a channel id; otherwise the Studio home. */
export function youtubeStudioUrl(channelId?: string) {
  const id = String(channelId || '').trim()
  if (/^UC[\w-]{20,}$/i.test(id)) return `https://studio.youtube.com/channel/${encodeURIComponent(id)}/livestreaming`
  return 'https://studio.youtube.com'
}
