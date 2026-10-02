/**
 * Shared helpers for the chat and activity docks: avatar/media URL proxying,
 * Kick handle normalization, category preference, feed filtering, combobox
 * highlight math, moderator profile links, and the YouTube Studio URL the
 * stream-controls link opens.
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

/** Keep a one-platform pick. `preferredCategory` would replace it with the other platform's longer name. */
export function unifiedCategoryQuery(current: string, twitch: string, kick: string, typing: boolean) {
  if (typing) return current
  const shown = current.trim()
  const twitchName = twitch.trim()
  const kickName = kick.trim()
  if (shown && (shown === twitchName || shown === kickName)) return shown
  return preferredCategory(twitch, kick)
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

export type TagPlatform = 'Twitch' | 'Kick'

/** Twitch: letters/numbers 1–25. Kick: those plus - _. No catalog/autocomplete APIs. */
/** Destination toggles are authoritative. An empty selection does not fall through to every valid platform. */
export function assignTagPlatforms(tag: string, selected: TagPlatform[]): TagPlatform[] {
  if (!selected.length) return []
  return tagPlatforms(tag).filter((platform) => selected.includes(platform))
}

export function tagPlatforms(tag: string): TagPlatform[] {
  const value = tag.trim().replace(/^#+/, '')
  if (!value) return []
  if (/^[A-Za-z0-9]{1,25}$/.test(value)) return ['Twitch', 'Kick']
  if (/^[A-Za-z0-9_-]{1,40}$/.test(value)) return ['Kick']
  return []
}

export type TagAssignment = { tag: string; platforms: TagPlatform[] }
export type ModerationTarget = { platform: ChatPlatform; messageId?: string; userId?: string; sourceId?: string }

export function moderationTargets(message: { platform: ChatPlatform; id: string; userId?: string; sourceId?: string; copies?: Array<{ platform: ChatPlatform; id: string; userId?: string; sourceId?: string }> }): ModerationTarget[] {
  if (message.copies?.length) return message.copies.map((copy) => ({ platform: copy.platform, messageId: copy.id, userId: copy.userId, sourceId: copy.sourceId }))
  return [{ platform: message.platform, messageId: message.id, userId: message.userId, sourceId: message.sourceId }]
}

export function moderationPlatformLabel(message: { platform: ChatPlatform; copies?: Array<{ platform: ChatPlatform }> }) {
  if (message.copies?.length) return [...new Set(message.copies.map((copy) => copy.platform))].join(', ')
  return message.platform
}

export function tagAssignments(twitch?: string[], kick?: string[]): TagAssignment[] {
  const map = new Map<string, TagAssignment>()
  const add = (list: string[] | undefined, platform: TagPlatform) => {
    for (const raw of list || []) {
      const tag = raw.trim().replace(/^#+/, '')
      if (!tag) continue
      const key = tag.toLowerCase()
      const current = map.get(key)
      if (current) {
        if (!current.platforms.includes(platform)) current.platforms.push(platform)
      } else map.set(key, { tag, platforms: [platform] })
    }
  }
  add(twitch, 'Twitch')
  add(kick, 'Kick')
  return [...map.values()]
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

/** YouTube Studio livestreaming dashboard when we have a channel id. */
export function youtubeStudioUrl(channelId?: string) {
  const id = String(channelId || '').trim()
  if (/^UC[\w-]{20,}$/i.test(id)) return `https://studio.youtube.com/channel/${encodeURIComponent(id)}/livestreaming`
  return 'https://studio.youtube.com/livestreaming'
}

/** Creator live dashboards opened from the chat title. */
export function streamDashboardUrl(platform: ChatPlatform, account: { handle?: string; channelId?: string }) {
  if (platform === 'Twitch') {
    const login = String(account.handle || '').replace(/^@+/, '').trim().toLowerCase()
    if (/^[a-z0-9_]{1,25}$/.test(login) && login !== 'twitch') return `https://dashboard.twitch.tv/u/${encodeURIComponent(login)}/stream-manager`
    return 'https://dashboard.twitch.tv/stream-manager'
  }
  if (platform === 'Kick') return 'https://kick.com/dashboard/stream'
  return youtubeStudioUrl(account.channelId)
}

/** Twitch login, not a display name. Viewer cards and profile URLs both require this shape. */
export function twitchLogin(raw?: string) {
  const handle = String(raw || '').replace(/^@+/, '').trim().toLowerCase()
  if (!/^[a-z0-9_]{1,25}$/.test(handle)) return
  return handle
}

/**
 * Moderator profile link. Twitch viewer cards only load at
 * `/popout/<channel>/viewercard/<login>` — the channel-less `?popout=` route
 * 404s. Without a connected channel login, fall back to the public profile.
 * YouTube's `/community` tab is often disabled, so this opens the channel page.
 * Kick has no viewer-card route. Must stay on the `isSafeExternalUrl` allowlist.
 */
export function chatProfileUrl(message: { platform: string; user: string; userId?: string; handle?: string }, channelLogin?: string) {
  const handle = message.user.replace(/^@+/, '').trim().toLowerCase()
  if (!handle || /^anonymous$/i.test(handle) || handle === 'testuser') return
  if (message.platform === 'Twitch') {
    const login = twitchLogin(message.handle) || twitchLogin(handle)
    if (!login) return
    const channel = twitchLogin(channelLogin)
    if (channel) return `https://www.twitch.tv/popout/${channel}/viewercard/${login}`
    return `https://www.twitch.tv/${login}`
  }
  if (message.platform === 'Kick') return `https://kick.com/${encodeURIComponent(kickProfileSlug(message.user, message.handle))}`
  if (message.platform === 'YouTube') {
    if (message.userId && /^UC[\w-]{20,}$/i.test(message.userId)) return `https://www.youtube.com/channel/${encodeURIComponent(message.userId)}`
    return `https://www.youtube.com/@${encodeURIComponent(handle)}`
  }
}

export function profileLinkTitle(platform: string) {
  if (platform === 'Twitch') return 'Open Twitch viewer card'
  if (platform === 'YouTube') return 'Open YouTube channel'
  if (platform === 'Kick') return 'Open Kick profile'
  return 'Open profile'
}

/** Twitch and Kick accept a ban/timeout reason. YouTube liveChat/bans does not. */
export function moderationAcceptsReason(platform: string) {
  return platform === 'Twitch' || platform === 'Kick'
}

/** Dock status line after a moderation call. Includes the reason only when one was sent. */
export function moderationStatus(action: 'delete' | 'timeout' | 'ban' | 'unban', user: string, reason?: string) {
  if (action === 'delete') return 'Message deleted'
  if (action === 'unban') return `Unbanned ${user}`
  const line = action === 'ban' ? `Banned ${user}` : `Timed out ${user}`
  const cleaned = reason?.trim()
  return cleaned ? `${line}: ${cleaned}` : line
}

export type LiveStreamTip = { title: string; viewers?: number; label?: string }

/** Tile tooltip. YouTube lists every live broadcast; Twitch and Kick show that platform's title. */
export function platformStatTip(input: { platform: string; live: boolean; connected: boolean; viewers: number; title?: string; streams?: LiveStreamTip[]; quota?: { used: number; limit: number }; health?: string }) {
  const lines = [`${input.platform} · ${input.live ? 'live' : input.connected ? 'offline' : 'not connected'}`]
  const streams = (input.streams || []).map((item) => ({ ...item, title: item.title.trim() })).filter((item) => item.title)
  if (streams.length > 1) {
    for (const stream of streams) {
      const name = stream.label ? `${stream.label}: ${stream.title}` : stream.title
      lines.push(stream.viewers != null ? `${name} · ${stream.viewers.toLocaleString()} viewers` : name)
    }
    if (input.connected) lines.push(`${input.viewers.toLocaleString()} combined viewers`)
  } else {
    const title = streams[0]?.title || input.title?.trim()
    if (title) lines.push(title)
    if (input.connected) lines.push(`${input.viewers.toLocaleString()} viewers`)
  }
  if (input.quota) lines.push(`Quota ${input.quota.used.toLocaleString()} / ${input.quota.limit.toLocaleString()}`)
  if (input.health) lines.push(input.health)
  else if (input.live) lines.push('Connected')
  lines.push(input.connected ? `Open ${input.platform} dashboard` : 'Connect in the Relay Chat Dock window')
  return lines.join('\n')
}

export type YoutubePrivacyNotice = { videoId: string; title: string; privacy: 'unlisted' | 'private' }

/** Same sentence the backend logs, so the dock and companion window match the console line. */
export function youtubePrivacyMessage(notice: { title?: string; privacy: string }) {
  const title = String(notice.title || '').trim() || 'stream'
  return `YouTube “${title}” is ${notice.privacy}.`
}

export function postYoutubePrivacy(videoIds: string[], action: 'public' | 'dismiss' = 'public') {
  return fetch('/api/youtube/privacy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoIds, action }),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Could not update YouTube privacy')
    return data
  })
}

/** Ask the local backend to open an allowlisted URL in the system browser. Docks must not navigate themselves. */
export function openDockUrl(url: string) {
  void fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }).catch((error) => console.error('Failed to open link:', error))
}
