/**
 * Unified chat merge: own-message matching, copies, optimistic send rows, YouTube duplicate collapse.
 */

import type { YouTubeChatTarget } from '../youtube-chat.js'
import { CHAT_MAX, type ChatBadge, type ChatMessage, type ChatMessageCopy, type Platform } from '../types.js'
import { sortedYouTubeBadges, youtubeSameChatFor } from './youtube.js'

export function normalizeChatHandle(name: string) {
  return name.replace(/^@+/, '').trim().toLowerCase()
}

export function youtubeSameAuthor(left: ChatMessage, right: ChatMessage) {
  if (left.userId && right.userId) return left.userId.toLowerCase() === right.userId.toLowerCase()
  return normalizeChatHandle(left.user) === normalizeChatHandle(right.user)
}

export function isOwnChatMessage(
  message: { user: string; userId?: string },
  ctx: { ownHandles: Set<string>; ownUserIds?: Iterable<string> },
) {
  const handle = normalizeChatHandle(message.user)
  if (ctx.ownHandles.has(handle) || ctx.ownHandles.has(message.user.toLowerCase())) return true
  if (!message.userId || !ctx.ownUserIds) return false
  for (const id of ctx.ownUserIds) if (id.toLowerCase() === message.userId.toLowerCase()) return true
  return false
}

/**
 * Fold a raw chat line into a stable key for dedupe/merge: drop zero-width and
 * joiner characters, strip emojis and variation selectors, collapse and
 * trim whitespace, lowercase. Two wordings that differ only in emoji or caps
 * then compare equal.
 */
export function foldRawText(text: string) {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function foldChatText(message: ChatMessage) {
  const raw = message.parts?.length
    ? message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
    : message.text
  return foldRawText(raw)
}

export function isTruncatedText(text: string) {
  return /(?:\.{2,}|…)\s*$/.test(text.trim())
}

/**
 * When one side was cut off mid-message ("..." or unicode ellipsis), treat it
 * as a match if the other side starts with that truncated prefix. Guards on a
 * 12-char prefix so short messages that merely end with a period never collide.
 */
export function truncatedFoldMatches(left: string, right: string) {
  if (!left || !right) return false
  if (left === right) return true
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  if (!isTruncatedText(short)) return false
  const prefix = short.replace(/(?:\.{2,}|…)\s*$/g, '').trim()
  return prefix.length >= 12 && long.startsWith(prefix)
}

/**
 * Compare two messages (or raw strings) for dedupe: exact text first, then
 * folded text, then truncated-prefix matching. Folds parts-based messages from
 * their text parts and plain strings as-is.
 */
export function chatTextMatches(left: ChatMessage | string, right: ChatMessage | string) {
  const leftText = typeof left === 'string' ? left : left.text
  const rightText = typeof right === 'string' ? right : right.text
  if (leftText === rightText) return true
  const leftFold = typeof left === 'string' ? foldRawText(left) : foldChatText(left)
  const rightFold = typeof right === 'string' ? foldRawText(right) : foldChatText(right)
  if (leftFold === rightFold) return true
  if (truncatedFoldMatches(leftFold, rightFold)) return true
  return truncatedFoldMatches(foldRawText(leftText), foldRawText(rightText))
}

export function preferChatText(current: string, incoming: string) {
  if (!incoming) return current
  if (!current) return incoming
  if (!chatTextMatches(current, incoming)) return current
  if (isTruncatedText(current) && !isTruncatedText(incoming)) return incoming
  if (isTruncatedText(incoming) && !isTruncatedText(current)) return current
  return incoming.length > current.length ? incoming : current
}

export function mergedSourceLabel(current: ChatMessage, incoming: ChatMessage, targets: YouTubeChatTarget[] = []) {
  const currentPlatforms = current.platforms || [current.platform]
  const incomingPlatforms = incoming.platforms || [incoming.platform]
  if (!current.sourceId && currentPlatforms.length > 1) return current.sourceLabel
  if (!incoming.sourceId && incomingPlatforms.length > 1) return incoming.sourceLabel
  if (current.sourceId && incoming.sourceId && !youtubeSameChatFor(current.sourceId, incoming.sourceId, targets)) return undefined
  if (current.sourceLabel && incoming.sourceLabel && current.sourceLabel !== incoming.sourceLabel) return undefined
  return current.sourceLabel || incoming.sourceLabel
}

function isHostOrOwn(message: ChatMessage, ctx?: { ownHandles?: Set<string>; ownUserIds?: Iterable<string> }) {
  if (message.badges?.some((badge) => badge.label === 'HOST')) return true
  if (!ctx?.ownHandles) return false
  return isOwnChatMessage(message, { ownHandles: ctx.ownHandles, ownUserIds: ctx.ownUserIds })
}


export function isStoredChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false
  const item = value as ChatMessage
  return Boolean(item.id) && (item.platform === 'Twitch' || item.platform === 'Kick' || item.platform === 'YouTube') && typeof item.user === 'string' && typeof item.text === 'string' && typeof item.time === 'string'
}


export function collapseYouTubeDuplicates(
  messages: ChatMessage[],
  targets: YouTubeChatTarget[] = [],
  ctx?: { ownHandles?: Set<string>; ownUserIds?: Iterable<string> },
) {
  const kept: ChatMessage[] = []
  const seenIds: string[] = []
  let changed = false
  for (const message of messages) {
    const at = Date.parse(message.time) || 0
    const youtube = message.platform === 'YouTube' || (message.platforms || []).includes('YouTube')
    const match = youtube ? kept.findIndex((item) => {
      if (!chatTextMatches(item, message)) return false
      if (!(item.platform === 'YouTube' || (item.platforms || []).includes('YouTube'))) return false
      if (!youtubeSameAuthor(item, message)) return false
      const sameChat = youtubeSameChatFor(item.sourceId, message.sourceId, targets)
      const ownPair = isHostOrOwn(item, ctx) && isHostOrOwn(message, ctx)
      if (!sameChat && !ownPair) return false
      const delta = Math.abs((Date.parse(item.time) || 0) - at)
      return delta <= (sameChat ? 2_000 : 20_000)
    }) : -1
    if (match < 0) {
      kept.push(message)
      continue
    }
    changed = true
    const current = kept[match]
    const platforms = [...new Set([...(current.platforms || [current.platform]), ...(message.platforms || [message.platform])])]
    const text = preferChatText(current.text, message.text)
    const takeIncomingParts = text === message.text && !isTruncatedText(message.text)
    const parts = current.parts?.some((part) => part.type === 'emote')
      ? current.parts
      : takeIncomingParts && message.parts?.length ? message.parts : current.parts
    const copies = mergeChatCopies(current, message)
    kept[match] = {
      ...current,
      text,
      platforms,
      platform: platforms[0],
      ...(copies ? { copies } : {}),
      sourceId: current.sourceId || message.sourceId,
      userId: current.userId || message.userId,
      ingest: message.ingest || current.ingest,
      parts,
      avatar: current.avatar || message.avatar,
      badges: sortedYouTubeBadges(current.badges?.length ? current.badges : message.badges),
      color: current.color || message.color,
      sourceLabel: mergedSourceLabel(current, message, targets),
    }
    if (current.id) seenIds.push(current.id)
    if (message.id) seenIds.push(message.id)
  }
  return { messages: changed ? kept : messages, changed, seenIds }
}

/**
 * Merge one incoming message into the chat history: either appends it, or
 * folds it into an existing entry when it looks like the same message observed
 * on another platform or ingest source. Returns `seenIds` for the YouTube
 * dedupe map, plus `added` when a brand-new message was appended.
 */
export function chatMessageCopies(message: Pick<ChatMessage, 'platform' | 'id' | 'userId' | 'sourceId' | 'copies'>): ChatMessageCopy[] {
  if (message.copies?.length) return message.copies
  if (!message.id) return []
  return [{ platform: message.platform, id: message.id, userId: message.userId, sourceId: message.sourceId }]
}

/**
 * One moderation target per platform, except YouTube: Live and Shorts are the
 * same platform but different chats, and delete needs both message ids.
 * An optimistic dock id loses to the platform id once the echo arrives.
 */
export function chatCopyKey(copy: Pick<ChatMessageCopy, 'platform' | 'sourceId'>) {
  return copy.platform === 'YouTube' && copy.sourceId ? `YouTube:${copy.sourceId}` : copy.platform
}

export function mergeChatCopies(current: ChatMessage, incoming: ChatMessage, optimisticIds?: ReadonlySet<string>): ChatMessageCopy[] | undefined {
  const merged = new Map<string, ChatMessageCopy>()
  for (const copy of [...chatMessageCopies(current), ...chatMessageCopies(incoming)]) {
    const key = chatCopyKey(copy)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...copy })
      continue
    }
    const incomingIdWins = Boolean(copy.id && optimisticIds?.has(existing.id) && !optimisticIds.has(copy.id))
    merged.set(key, {
      platform: copy.platform,
      id: incomingIdWins ? copy.id : (existing.id || copy.id),
      userId: existing.userId || copy.userId,
      sourceId: existing.sourceId || copy.sourceId,
    })
  }
  const copies = [...merged.values()]
  return copies.length > 1 ? copies : undefined
}

/** Closest optimistic send in the window. The first "lol" is not this echo if a newer send is closer. */
export function closestRecentOutgoing<T extends { text: string; at: number }>(
  recent: T[],
  message: ChatMessage | string,
  incomingTime: number,
  windowMs = 20_000,
) {
  let best: T | undefined
  let bestDelta = windowMs
  for (const item of recent) {
    if (!chatTextMatches(item.text, message)) continue
    const delta = Math.abs(incomingTime - item.at)
    if (delta >= bestDelta) continue
    best = item
    bestDelta = delta
  }
  return best
}

/**
 * True when `item` is the dock send `tracked` refers to. Twitch or YouTube may
 * already have replaced the optimistic UUID, so Kick still has to find that row.
 */
export function rowMatchesOutgoing(
  item: ChatMessage,
  tracked: { id: string; platforms: Platform[]; at: number },
  optimisticIds: ReadonlySet<string>,
) {
  if (item.id === tracked.id) return true
  if (item.copies?.some((copy) => copy.id === tracked.id)) return true
  if (optimisticIds.has(item.id)) return false
  const itemPlatforms = item.platforms || [item.platform]
  // The dock send stores every target platform on insert. A received Kick line is Kick-only.
  if (!tracked.platforms.every((platform) => itemPlatforms.includes(platform))) return false
  const itemTime = Date.parse(item.time) || 0
  return Math.abs(itemTime - tracked.at) <= 20_000
}

function copiesUnchanged(current?: ChatMessageCopy[], next?: ChatMessageCopy[]) {
  if (!current?.length && !next?.length) return true
  if (!current || !next || current.length !== next.length) return false
  return current.every((copy, index) => {
    const other = next[index]
    return copy.platform === other.platform && copy.id === other.id && copy.userId === other.userId && copy.sourceId === other.sourceId
  })
}

export function mergeIncomingChat(
  messages: ChatMessage[],
  message: ChatMessage,
  options: { ingest?: 'official' | 'innertube' } | undefined,
  ctx: {
    ownHandles: Set<string>
    recentOutgoing: { id: string; text: string; platforms: Platform[]; at: number }[]
    targets?: YouTubeChatTarget[]
    ownUserIds?: Iterable<string>
    max?: number
  },
) {
  const seenIds: string[] = []
  if (!message.text && !message.parts?.length) return { messages, changed: false, seenIds }
  if (messages.some((item) => item.id === message.id)) {
    if (message.id) seenIds.push(message.id)
    return { messages, changed: false, seenIds }
  }
  const incomingTime = Date.parse(message.time) || Date.now()
  const incomingPlatforms = message.platforms?.length ? message.platforms : [message.platform]
  const incomingIsOwn = isOwnChatMessage(message, ctx)
  // This id was just remembered by the dock send. It is a new line, not the echo of an older one.
  const incomingIsThisSend = ctx.recentOutgoing.some((item) => item.id === message.id)
  const tracked = closestRecentOutgoing(ctx.recentOutgoing, message, incomingTime)
  const optimisticIds = new Set(ctx.recentOutgoing.map((item) => item.id))
  const incomingIngest = options?.ingest
  const targets = ctx.targets || []

  let mergeAt = -1
  let mergeDelta = Infinity
  // A dock insert uses the id we just remembered. Folding it into an older own row is what swallowed the second "lol".
  if (!incomingIsThisSend) for (let index = 0; index < messages.length; index++) {
    const item = messages[index]
    if (!chatTextMatches(item, message)) continue
    const delta = Math.abs((Date.parse(item.time) || 0) - incomingTime)
    const itemIsOwn = isOwnChatMessage(item, ctx)
    const itemPlatforms = item.platforms || [item.platform]
    const sameYouTubeChat = youtubeSameChatFor(item.sourceId, message.sourceId, targets)
    const youtubePair = message.platform === 'YouTube'
      && (item.platform === 'YouTube' || itemPlatforms.includes('YouTube'))
      && youtubeSameAuthor(item, message)
    const ownYouTube = youtubePair && (incomingIsOwn || itemIsOwn)
    let match = youtubePair && sameYouTubeChat && delta <= 2_000
    if (!match && ownYouTube && !sameYouTubeChat && delta <= 20_000) match = true
    // Echoes merge only into the optimistic row for that send. Any other own row with the same text is a separate line.
    // After Twitch/YouTube replace the dock UUID, Kick still has to fold into that same unified row.
    if (!match && tracked && delta <= 20_000 && incomingPlatforms.some((platform) => tracked.platforms.includes(platform)) && rowMatchesOutgoing(item, tracked, optimisticIds)) match = true
    else if (!match && incomingIsOwn && itemIsOwn && delta <= 90_000 && youtubePair && !sameYouTubeChat) {
      match = true
    }
    if (!match || delta >= mergeDelta) continue
    mergeAt = index
    mergeDelta = delta
  }

  if (mergeAt >= 0) {
    const current = messages[mergeAt]
    const preferred = tracked?.platforms || []
    const platforms = [...new Set([...preferred, ...(current.platforms || [current.platform]), ...incomingPlatforms])]
    const already = current.platforms || [current.platform]
    const text = preferChatText(current.text, message.text)
    const takeIncomingParts = text === message.text && !isTruncatedText(message.text)
    const parts = current.parts?.some((part) => part.type === 'emote')
      ? current.parts
      : takeIncomingParts && message.parts?.length ? message.parts : current.parts
    // YouTube's first sighting fills sourceId. Twitch and Kick echoes have no sourceId, so the optimistic UUID has to yield to the platform id or Delete calls the API with a UUID.
    const echoReplacesOptimisticId = Boolean(tracked && rowMatchesOutgoing(current, tracked, optimisticIds) && message.id && optimisticIds.has(current.id) && !optimisticIds.has(message.id))
    const takeIncomingId = Boolean((message.sourceId && !current.sourceId) || echoReplacesOptimisticId)
    const sourceLabel = mergedSourceLabel(current, message, targets)
    const platformsUnchanged = platforms.length === already.length && platforms.every((platform) => already.includes(platform))
    if (current.id) seenIds.push(current.id)
    if (message.id) seenIds.push(message.id)
    const ingestChanged = Boolean(incomingIngest && current.ingest !== incomingIngest)
    const textChanged = text !== current.text
    const labelChanged = sourceLabel !== current.sourceLabel
    const metaChanged = Boolean((message.userId && !current.userId) || (message.handle && !current.handle) || (message.avatar && !current.avatar) || (!current.badges?.length && message.badges?.length))
    const copies = mergeChatCopies(current, message, optimisticIds)
    if (platformsUnchanged && parts === current.parts && !takeIncomingId && !ingestChanged && !textChanged && !labelChanged && !metaChanged && copiesUnchanged(current.copies, copies)) {
      return { messages, changed: false, seenIds }
    }
    return {
      messages: messages.map((item, index) => index === mergeAt ? {
        ...item,
        ...(takeIncomingId ? { id: message.id } : {}),
        text,
        platform: platforms[0],
        platforms,
        ...(copies ? { copies } : { copies: undefined }),
        sourceId: item.sourceId || message.sourceId,
        userId: item.userId || message.userId,
        handle: item.handle || message.handle,
        ingest: incomingIngest || item.ingest,
        ...(parts ? { parts } : {}),
        avatar: item.avatar || message.avatar,
        badges: sortedYouTubeBadges(item.badges?.length ? item.badges : message.badges),
        color: item.color || message.color,
        sourceLabel,
      } : item),
      changed: true,
      seenIds,
    }
  }

  const stored = { ...message, platforms: incomingPlatforms, ...(incomingIngest ? { ingest: incomingIngest } : {}) }
  if (stored.id && stored.platform === 'YouTube') seenIds.push(stored.id)
  return { messages: [...messages, stored].slice(-(ctx.max ?? CHAT_MAX)), changed: true, added: stored, seenIds }
}

export type OutgoingSendResult = {
  platform: Platform
  ok: boolean
  id?: string
  sourceId?: string
  /** YouTube can acknowledge more than one live chat for a single platform send. */
  sent?: { id?: string; sourceId?: string }[]
}

function sendResultCopies(row: ChatMessage, sent: OutgoingSendResult[]): ChatMessageCopy[] {
  const copies: ChatMessageCopy[] = []
  for (const result of sent) {
    const extras = (result.sent || []).filter((item) => item.id)
    if (extras.length) {
      for (const extra of extras) {
        if (!extra.id) continue
        copies.push({ platform: result.platform, id: extra.id, sourceId: extra.sourceId, userId: row.userId })
      }
      continue
    }
    if (result.id) copies.push({ platform: result.platform, id: result.id, sourceId: result.sourceId, userId: row.userId })
  }
  return copies
}

/**
 * Apply a dock send after the platform calls return.
 * Failure deletes only `localId` — never an older own row that happens to have the same text.
 * Success writes the platform message ids so Delete does not call Helix/Kick/YouTube with the local UUID.
 * If the echo already replaced `localId`, this is a no-op; that merge stored the platform id.
 */
export function applyOutgoingSendResult(messages: ChatMessage[], localId: string, results: OutgoingSendResult[]) {
  const index = messages.findIndex((item) => item.id === localId)
  if (index < 0) return { messages, changed: false }
  const sent = results.filter((result) => result.ok)
  if (!sent.length) return { messages: messages.filter((item) => item.id !== localId), changed: true }
  const row = messages[index]
  const sentPlatforms = [...new Set(sent.map((result) => result.platform))]
  const idCopies = sendResultCopies(row, sent)
  const next: ChatMessage = { ...row, platform: sentPlatforms[0] || row.platform, platforms: sentPlatforms.length ? sentPlatforms : row.platforms }
  if (idCopies.length === 1) {
    next.id = idCopies[0].id
    next.sourceId = idCopies[0].sourceId || row.sourceId
    next.copies = undefined
  } else if (idCopies.length > 1) {
    next.copies = idCopies
  }
  return { messages: messages.map((item, itemIndex) => itemIndex === index ? next : item), changed: true }
}

/** Map a Twitch badge set name to a short dock label (`broadcaster`→`HOST`, `moderator`→`MOD`, etc.). */
