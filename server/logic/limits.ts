/**
 * Chat and activity history caps from env.
 */

import { ACTIVITY_MAX, CHAT_MAX, CHAT_MAX_HARD, CHAT_MAX_MIN } from '../types.js'

function parseBoundedMax(rawValue: string | undefined, fallback: number) {
  const raw = String(rawValue || '').trim()
  if (!raw) return fallback
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(CHAT_MAX_HARD, Math.max(CHAT_MAX_MIN, n))
}

/** Resolve the `RELAY_CHAT_MAX` chat-history cap from env, clamped to `CHAT_MAX_MIN..CHAT_MAX_HARD`. */
export function parseChatMax(env: Record<string, string | undefined> = process.env) {
  return parseBoundedMax(env.RELAY_CHAT_MAX, CHAT_MAX)
}

/** Resolve the `RELAY_ACTIVITY_MAX` activity-history cap from env, same bounds as chat. */
export function parseActivityMax(env: Record<string, string | undefined> = process.env) {
  return parseBoundedMax(env.RELAY_ACTIVITY_MAX, ACTIVITY_MAX)
}
