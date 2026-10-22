/**
 * Cross-platform moderation payloads and applying deletes/bans to stored chat.
 */

import type { ChatMessage, ChatModeration, Platform } from '../types.js'
import { normalizeChatHandle } from './chat-merge.js'

export const MODERATION_REASON_MAX = 500

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
  const cleaned = normalizeModerationReason(reason)
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


export function chatUserMatches(message: ChatMessage, target: { userId?: string; user?: string }) {
  if (target.userId && message.userId) return message.userId.toLowerCase() === target.userId.toLowerCase()
  if (target.user) return normalizeChatHandle(message.user) === normalizeChatHandle(target.user)
  return false
}

export function messageOnPlatform(message: ChatMessage, platform: Platform) {
  return (message.platforms || [message.platform]).includes(platform)
}

/**
 * Apply one moderation change to the stored history: `delete` flags a single
 * message id; `ban`, `timeout`, and `unban` flag every stored message from
 * that user so the whole thread disappears (or reappears on unban).
 */
export function applyChatModeration(messages: ChatMessage[], change: ChatModeration): { messages: ChatMessage[]; changed: boolean } {
  if (change.action === 'delete') {
    if (!change.messageId) return { messages, changed: false }
    let changed = false
    const next = messages.map((item) => {
      if (item.id !== change.messageId || item.deleted) return item
      changed = true
      return { ...item, deleted: true }
    })
    return { messages: changed ? next : messages, changed }
  }
  if (!change.userId && !change.user) return { messages, changed: false }
  const hide = change.action === 'ban' || change.action === 'timeout'
  if (!hide && change.action !== 'unban') return { messages, changed: false }
  let changed = false
  const next = messages.map((item) => {
    if (!messageOnPlatform(item, change.platform) || !chatUserMatches(item, change)) return item
    if (hide ? item.deleted : !item.deleted) return item
    changed = true
    return { ...item, deleted: hide }
  })
  return { messages: changed ? next : messages, changed }
}

/**
 * Collapse duplicate YouTube messages that come from both data sources: the
 * official Data API and the unofficial site poll both deliver the same chat,
 * and this folds pick-ups into their originals. Distant duplicates 20s apart
 * are only merged when they are the streamer's own posts.
 */
