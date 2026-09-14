import type { Platform } from './types.js'

/**
 * In-memory OAuth state store. The OAuth `state` value is a single-use nonce:
 * it is generated before redirecting the user to the provider and must round-
 * trip back on the callback, where it is deleted. Entries are swept on access
 * once older than the TTL, and the map is capped so a flood of stale states
 * can't grow unbounded.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
export const OAUTH_STATE_MAX = 32

export type OAuthPending = { platform: Platform; createdAt: number; codeVerifier?: string }

export function createOAuthStateStore(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
  const ttlMs = options.ttlMs ?? OAUTH_STATE_TTL_MS
  const max = options.max ?? OAUTH_STATE_MAX
  const now = options.now ?? Date.now
  const map = new Map<string, OAuthPending>()

  function pruneExpired() {
    const t = now()
    // Lazy sweep: only expired entries are removed, and only when the store is touched.
    for (const [key, value] of map) {
      if (t - value.createdAt > ttlMs) map.delete(key)
    }
  }

  return {
    set(key: string, value: OAuthPending) {
      pruneExpired()
      if (map.has(key)) map.delete(key)
      // Evict the oldest entry when the cap is reached.
      while (map.size >= max) {
        const oldest = map.keys().next().value as string | undefined
        if (oldest === undefined) break
        map.delete(oldest)
      }
      map.set(key, value)
    },
    get(key: string) {
      pruneExpired()
      const value = map.get(key)
      if (!value) return
      if (now() - value.createdAt > ttlMs) {
        // TTL expired between prune and lookup; clean up now.
        map.delete(key)
        return
      }
      // Callers must call `delete(key)` themselves after consuming the value.
      return value
    },
    delete(key: string) {
      map.delete(key)
    },
    size() {
      pruneExpired()
      return map.size
    },
    pruneExpired,
  }
}
