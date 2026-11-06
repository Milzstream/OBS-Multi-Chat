/**
 * Cross-platform moderation payloads and applying deletes/bans to stored chat.
 */

import type { ChatMessage, ChatModeration, Platform } from '../types.js'
import { normalizeChatHandle } from './chat-merge.js'

export const MODERATION_REASON_MAX = 500
export const KICK_MODERATION_REASON_MAX = 100

/**
 * Optional ban/timeout reason. Empty, whitespace, and control characters become
 * `undefined` so the platform call omits the field. Does not block the ban.
 */
export function normalizeModerationReason(raw: unknown) {
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return
  return [...text].slice(0, MODERATION_REASON_MAX).join('')
}

/** Helix ban/timeout body. Duration is seconds. Reason is omitted when blank — not the old hardcoded default. */
export function twitchModerationBanData(userId: string, action: string, duration?: number, reason?: unknown) {
  const data: { user_id: string; duration?: number; reason?: string } = { user_id: userId }
  const cleaned = normalizeModerationReason(reason)
  if (cleaned) data.reason = cleaned
  if (action === 'timeout') data.duration = Math.max(1, Number(duration || 60))
  return data
}

/** Kick ban/timeout body. Duration is minutes; the dock sends seconds. Unban omits duration and reason. */
export function kickModerationBanPayload(broadcasterUserId: string, userId: string, action: string, durationSeconds?: number, reason?: unknown) {
  const payload: { broadcaster_user_id: number; user_id: number; duration?: number; reason?: string } = {
    broadcaster_user_id: Number(broadcasterUserId),
    user_id: Number(userId),
  }
  if (action === 'unban') return payload
  const cleaned = kickModerationReason(reason)
  if (cleaned) payload.reason = cleaned
  if (action === 'timeout') payload.duration = Math.max(1, Math.round(Number(durationSeconds || 60) / 60) || 1)
  return payload
}

/**
 * YouTube `liveChat/bans` snippet. There is no reason field (only liveChatId,
 * type, banDurationSeconds, and bannedUserDetails), so a dock reason is not
 * attached and the UI hides the field for YouTube.
 */
export function youtubeLiveChatBanSnippet(liveChatId: string, userId: string, action: string, duration?: number) {
  return {
    liveChatId,
    type: action === 'timeout' ? 'temporary' : 'permanent',
    ...(action === 'timeout' ? { banDurationSeconds: Math.max(1, Number(duration || 60)) } : {}),
    bannedUserDetails: { channelId: userId },
  }
}


export function kickModerationReason(raw: unknown) {
  const cleaned = normalizeModerationReason(raw)
  if (!cleaned) return
  return [...cleaned].slice(0, KICK_MODERATION_REASON_MAX).join('')
}

function messageIdMatches(message: ChatMessage, messageId: string) {
  return message.id === messageId || Boolean(message.copies?.some((copy) => copy.id === messageId))
}

export function chatUserMatches(message: ChatMessage, target: { userId?: string; user?: string }) {
  if (target.userId) {
    const ids = [message.userId, ...(message.copies || []).map((copy) => copy.userId)].filter((id): id is string => Boolean(id))
    if (ids.length) return ids.some((id) => id.toLowerCase() === target.userId!.toLowerCase())
  }
  if (target.user) return normalizeChatHandle(message.user) === normalizeChatHandle(target.user)
  return false
}

export function messageOnPlatform(message: ChatMessage, platform: Platform) {
  return (message.platforms || [message.platform]).includes(platform)
}

/**
 * Apply one moderation change to the stored history. `delete` strikes the row
 * whose id or copy id matches, and marks it so unban cannot restore it.
 * `ban` and `timeout` strike every stored row from that user on that platform.
 * `unban` restores those rows, not a message deleted on its own.
 */
export function applyChatModeration(messages: ChatMessage[], change: ChatModeration): { messages: ChatMessage[]; changed: boolean } {
  if (change.action === 'delete') {
    if (!change.messageId) return { messages, changed: false }
    let changed = false
    const next = messages.map((item) => {
      if (!messageIdMatches(item, change.messageId!)) return item
      if (item.deleted && item.removed === 'message') return item
      changed = true
      return { ...item, deleted: true, removed: 'message' as const }
    })
    return { messages: changed ? next : messages, changed }
  }
  if (!change.userId && !change.user) return { messages, changed: false }
  const hide = change.action === 'ban' || change.action === 'timeout'
  if (!hide && change.action !== 'unban') return { messages, changed: false }
  let changed = false
  const next = messages.map((item) => {
    if (!messageOnPlatform(item, change.platform) || !chatUserMatches(item, change)) return item
    if (hide) {
      if (item.removed === 'message' || item.deleted) return item
      changed = true
      return { ...item, deleted: true, removed: 'user' as const }
    }
    if (!item.deleted || item.removed === 'message') return item
    changed = true
    return { ...item, deleted: undefined, removed: undefined }
  })
  return { messages: changed ? next : messages, changed }
}
