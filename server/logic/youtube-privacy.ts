/**
 * Unlisted/private broadcast warnings and post-stream recheck lists.
 */

import type { YoutubePrivacy, YoutubePrivacyNotice, YoutubePrivacyWatch } from '../types.js'

export type { YoutubePrivacy, YoutubePrivacyNotice, YoutubePrivacyWatch }

/** How long to keep checking a broadcast after we last saw it live. */
export const YOUTUBE_PRIVACY_WATCH_MS = 30 * 60_000
/** videos.list cadence for ended broadcasts. Live privacy comes from the existing liveBroadcasts.list. */
export const YOUTUBE_PRIVACY_RECHECK_MS = 3 * 60_000

const YOUTUBE_STATUS_KEYS = ['embeddable', 'license', 'publicStatsViewable', 'madeForKids', 'selfDeclaredMadeForKids', 'containsSyntheticMedia'] as const

export function youtubePrivacyValue(raw: unknown): YoutubePrivacy | undefined {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'public' || value === 'unlisted' || value === 'private') return value
  return
}

export function youtubeVideoId(raw: unknown) {
  const id = String(raw || '').trim()
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return
  return id
}

/** Unlisted and private broadcasts only. Public and unknown statuses are not warnings. */
export function youtubePrivacyNotices(items: { videoId?: string; title?: string; privacyStatus?: string }[]): YoutubePrivacyNotice[] {
  const notices: YoutubePrivacyNotice[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const videoId = youtubeVideoId(item.videoId)
    const privacy = youtubePrivacyValue(item.privacyStatus)
    if (!videoId || !privacy || privacy === 'public' || seen.has(videoId)) continue
    seen.add(videoId)
    notices.push({ videoId, title: String(item.title || '').trim() || videoId, privacy })
  }
  return notices
}

export function youtubePrivacyMessage(notice: { title?: string; privacy: string }) {
  const title = String(notice.title || '').trim() || 'stream'
  return `YouTube “${title}” is ${notice.privacy}.`
}

/**
 * videos.update body. Copies the writable status fields we already listed so
 * YouTube does not reject the call for a missing made-for-kids flag, and
 * forces privacyStatus to public.
 */
export function youtubePublicVideoBody(videoId: string, status: Record<string, unknown> = {}) {
  const next: Record<string, unknown> = { privacyStatus: 'public' }
  for (const key of YOUTUBE_STATUS_KEYS) {
    if (status[key] !== undefined) next[key] = status[key]
  }
  return { id: videoId, status: next }
}

/** Refresh the post-stream watch list. Seeing a broadcast live extends its deadline; expired ids drop. */
export function nextYoutubePrivacyWatch(now: number, previous: YoutubePrivacyWatch[], live: { videoId?: string; title?: string }[]): YoutubePrivacyWatch[] {
  const byId = new Map<string, YoutubePrivacyWatch>()
  for (const item of previous) {
    const videoId = youtubeVideoId(item.videoId)
    if (!videoId || item.until <= now) continue
    byId.set(videoId, { videoId, title: item.title || videoId, until: item.until })
  }
  for (const item of live) {
    const videoId = youtubeVideoId(item.videoId)
    if (!videoId) continue
    byId.set(videoId, { videoId, title: String(item.title || byId.get(videoId)?.title || videoId).trim() || videoId, until: now + YOUTUBE_PRIVACY_WATCH_MS })
  }
  return [...byId.values()]
}

/**
 * Ended broadcast ids that should be re-read with videos.list. Live ids are
 * skipped because liveBroadcasts.list already returned their privacy. Open
 * notices stay in the list so a Studio-side fix clears the banner.
 */
export function youtubePrivacyRecheckIds(now: number, lastCheckAt: number, watch: YoutubePrivacyWatch[], liveIds: Iterable<string>, openNotices: { videoId: string }[] = [], minIntervalMs = YOUTUBE_PRIVACY_RECHECK_MS) {
  if (lastCheckAt && now - lastCheckAt < minIntervalMs) return []
  const live = new Set(liveIds)
  const ids = new Set<string>()
  for (const item of watch) {
    if (item.until > now && !live.has(item.videoId)) ids.add(item.videoId)
  }
  for (const notice of openNotices) {
    if (!live.has(notice.videoId)) ids.add(notice.videoId)
  }
  return [...ids]
}

