/**
 * Stream title/category/tag normalize and live overlay.
 */

import { STREAM_TAG_MAX, TWITCH_TAG_MAX_LENGTH, type StreamDetails, type StreamInfoMap } from '../types.js'

export function emptyStreamDetails(): StreamDetails {
  return { title: '', category: '' }
}

export function emptyStreamInfo(): StreamInfoMap {
  return { Twitch: emptyStreamDetails(), Kick: emptyStreamDetails(), YouTube: emptyStreamDetails() }
}

/** Dedupe, trim, cap at 10. `undefined` means the payload omitted tags. */
export function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of value) {
    const tag = String(item || '').trim().replace(/^#+/, '')
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= STREAM_TAG_MAX) break
  }
  return tags
}

export function isTwitchTag(value: string) {
  return new RegExp(`^[A-Za-z0-9]{1,${TWITCH_TAG_MAX_LENGTH}}$`).test(value)
}

/** Twitch rejects spaces and specials; empty array clears channel tags. */
export function twitchTagsForApi(tags?: string[]) {
  if (!tags) return
  return tags.map((tag) => tag.trim().replace(/^#+/, '')).filter(isTwitchTag).slice(0, STREAM_TAG_MAX)
}

export function isKickTag(value: string) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(value)
}

/** Kick is freeform strings with no catalog; keep chips Kick can actually store. */
export function kickTagsForApi(tags?: string[]) {
  if (!tags) return
  return (normalizeTags(tags) || []).filter(isKickTag)
}


export function tagsEqual(left?: string[], right?: string[]) {
  const a = normalizeTags(left) || []
  const b = normalizeTags(right) || []
  if (a.length !== b.length) return false
  return a.every((tag, index) => tag.toLowerCase() === b[index].toLowerCase())
}

export function streamDetailsUnchanged(current: StreamDetails, next: StreamDetails) {
  return current.title === next.title
    && current.category === next.category
    && (current.categoryId || '') === (next.categoryId || '')
    && tagsEqual(current.tags, next.tags)
}

/**
 * Whether a YouTube description PUT would change anything. Uses the snippet we
 * already cached from liveBroadcasts.list — never an extra read (list is 1 unit,
 * update is 50).
 */

export function normalizeStreamDetails(value: unknown): StreamDetails {
  if (!value || typeof value !== 'object') return emptyStreamDetails()
  const item = value as Partial<StreamDetails>
  const title = String(item.title || '').trim()
  const category = String(item.category || '').trim()
  const categoryId = item.categoryId != null && String(item.categoryId).trim() ? String(item.categoryId).trim() : undefined
  const tags = normalizeTags(item.tags)
  return { title, category, ...(categoryId ? { categoryId } : {}), ...(tags ? { tags } : {}) }
}

export function loadStreamInfo(value: unknown): StreamInfoMap {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { Twitch: normalizeStreamDetails(raw.Twitch), Kick: normalizeStreamDetails(raw.Kick), YouTube: normalizeStreamDetails(raw.YouTube) }
}

export function isMoreSpecificCategory(specific: string, general: string) {
  const a = specific.trim().toLowerCase()
  const b = general.trim().toLowerCase()
  if (!a || !b || a === b || !a.startsWith(b)) return false
  const next = a[b.length]
  return next === ' ' || next === ':' || next === '-' || next === '('
}

export function applyLiveStreamDetails(current: StreamDetails, live: StreamDetails): StreamDetails {
  const title = (live.title || current.title || '').trim()
  const liveCategory = (live.category || '').trim()
  const currentCategory = (current.category || '').trim()
  const tags = live.tags !== undefined ? live.tags : current.tags
  const withTags = (details: StreamDetails): StreamDetails => tags !== undefined ? { ...details, tags } : details
  if (!liveCategory) return withTags({ title, category: currentCategory, ...(current.categoryId ? { categoryId: current.categoryId } : {}) })
  if (isMoreSpecificCategory(currentCategory, liveCategory)) {
    return withTags({ title, category: currentCategory, ...(current.categoryId ? { categoryId: current.categoryId } : {}) })
  }
  return withTags({ title, category: liveCategory, ...(live.categoryId ? { categoryId: live.categoryId } : current.categoryId ? { categoryId: current.categoryId } : {}) })
}

