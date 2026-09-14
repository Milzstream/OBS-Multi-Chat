/**
 * Persisting dock preferences to localStorage: compact mode and chat filter
 * for the chat dock, activity filter for the activity dock. Every read/write
 * is guarded for environments where localStorage is unavailable.
 */

export const CHAT_COMPACT_KEY = 'relay.chat.compactMode'
export const CHAT_FILTER_KEY = 'relay.chat.filter'
export const ACTIVITY_FILTER_KEY = 'relay.activity.filter'

export const CHAT_FILTERS = ['All', 'Twitch', 'Kick', 'YouTube'] as const
export const ACTIVITY_FILTERS = ['All', 'Twitch', 'Kick', 'YouTube', 'StreamElements'] as const

export type ChatFilter = (typeof CHAT_FILTERS)[number]
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]

// Defaults merge: stored values are trusted only if they match exactly,
// otherwise the caller's default wins (handles old/corrupt entries)
export function parseStoredBoolean(raw: string | null, fallback: boolean) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

export function parseStoredFilter<T extends string>(raw: string | null, allowed: readonly T[], fallback: T) {
  if (raw && (allowed as readonly string[]).includes(raw)) return raw as T
  return fallback
}

// localStorage is missing in OBS's sandboxed webview (or private mode), so
// reads/writes must never throw and just no-op
export function readLocalPref(key: string) {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocalPref(key: string, value: string) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    // OBS private mode / disabled storage should not break the dock
  }
}
