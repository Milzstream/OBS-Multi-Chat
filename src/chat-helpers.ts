export type ChatPlatform = 'Twitch' | 'Kick' | 'YouTube'

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

export function selectedSendPlatforms(connected: ChatPlatform[], optOut: Iterable<ChatPlatform> = []) {
  const skip = new Set(optOut)
  return (['Twitch', 'Kick', 'YouTube'] as ChatPlatform[]).filter((platform) => connected.includes(platform) && !skip.has(platform))
}
