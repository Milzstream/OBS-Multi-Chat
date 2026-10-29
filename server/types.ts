/**
 * Shared types and constants for the Relay Chat Dock: the unified chat message
 * shape, moderation actions, settings, and the per-platform limits and OAuth
 * scopes. Every platform reader (`kick-chat.ts`, `youtube-chat.ts`,
 * `streamelements.ts`, the Twitch IRC/EventSub code) maps its own payloads
 * onto these shapes.
 */

export type Platform = 'Twitch' | 'Kick' | 'YouTube'
export type TokenPlatform = Platform | 'StreamElements'
export type StreamPlatform = 'Twitch' | 'Kick'
export type StreamInfoPlatform = StreamPlatform | 'YouTube'
export type Token = { accessToken: string; refreshToken?: string; expiresAt?: number; user?: string; userId?: string; channelId?: string; liveChatId?: string; liveChatIds?: string[]; provider?: string }
export type AccountStream = { title: string; viewers?: number; label?: string }
export type Account = { platform: Platform; connected: boolean; live: boolean; viewers: number; handle: string; channelId?: string; streams?: AccountStream[] }
/** `big` is a Twitch Power-up gigantified emote, drawn large on its own line. */
export type MessagePart = { type: 'text'; text: string } | { type: 'emote'; name: string; url: string; big?: boolean }
export type ChatBadge = { title: string; url?: string; label?: string }
export type ChatMessageCopy = { platform: Platform; id: string; userId?: string; sourceId?: string }
export type ChatMessage = { id: string; platform: Platform; platforms?: Platform[]; copies?: ChatMessageCopy[]; user: string; text: string; time: string; emotes?: string[]; parts?: MessagePart[]; userId?: string; handle?: string; sourceId?: string; sourceLabel?: string; originalText?: string; avatar?: string; color?: string; badges?: ChatBadge[]; deleted?: boolean; ingest?: 'official' | 'innertube' }
// Aggregate moderation action across platforms. `timeout` (Twitch) and `ban`
// both hide a user's messages; `unban` restores them. Timeout durations live
// in the per-platform source, so this type stays duration-free.
export type ChatModeration = { action: 'delete' | 'timeout' | 'ban' | 'unban'; platform: Platform; messageId?: string; userId?: string; user?: string }
export type StreamDetails = { title: string; category: string; categoryId?: string; tags?: string[] }
export type StreamInfoMap = Record<StreamInfoPlatform, StreamDetails>
export type Health = { status: 'ok' | 'warn' | 'down'; message: string }
// `connecting` covers the window where JWTs are hydrating or the Astro socket
// is (re)subscribing. The docks stay quiet during it, so a restart or a saved
// JWT does not flash a StreamElements alert that clears a second later.
export type StreamElementsStatus = { connected: boolean; handle: string; missing: string[]; connecting: boolean }
export type YoutubeQuota = { day: string; used: number; limit?: number; blockedUntil?: number }
export type YoutubeQuotaStatus = { used: number; limit: number }
export type YoutubePrivacy = 'public' | 'unlisted' | 'private'
export type YoutubePrivacyNotice = { videoId: string; title: string; privacy: 'unlisted' | 'private' }
export type YoutubePrivacyWatch = { videoId: string; title: string; until: number }
/** Same shape the docks render as a connection tile. */
export type Connection = Account
export type LiveStreamTip = AccountStream
/** Per-platform automatic live-status polls. Missing or true means on. Chat sockets are not gated by this. */
export type AutoLiveCheck = Record<Platform, boolean>
/** Platforms that can have an on-stream look. StreamElements is tips/merch, not a chat dock. */
export type AlertPlatform = 'Twitch' | 'Kick' | 'YouTube' | 'StreamElements'

/** Uploaded alert file. Bytes live at `data/alerts/<id>`; this is what settings.json stores. */
export type AlertAssetRef = {
  id: string
  mime: string
  name: string
}

export type AlertTextAlign = 'left' | 'center' | 'right'

/** One placed line on the overlay. `x` / `y` / `width` / `fontSize` are percents of the OBS source. */
export type AlertTextBox = {
  text: string
  x: number
  y: number
  width?: number
  align?: AlertTextAlign
  color?: string
  fontSize?: number
  fontWeight?: number
}

/**
 * One visual + sound recipe. `null` on an override clears that field from a less-specific look.
 * Missing fields inherit.
 */
export type AlertLook = {
  image?: AlertAssetRef | null
  video?: AlertAssetRef | null
  audio?: AlertAssetRef | null
  textBoxes?: AlertTextBox[] | null
  displaySec?: number | null
}

/** Cascade: `slots` (`Platform:kind`) → `kinds` → `platforms` → `default` → the pill. */
export type AlertLooks = {
  default?: AlertLook
  platforms?: Partial<Record<AlertPlatform, AlertLook>>
  kinds?: Partial<Record<string, AlertLook>>
  slots?: Record<string, AlertLook>
}

/** On-stream alert page settings. `disabled` holds `Platform:kind` keys the page skips. */
export type AlertSettings = {
  enabled: boolean
  sound: boolean
  showPlatform: boolean
  displaySec: number
  disabled: string[]
  looks?: AlertLooks
}

export type AppSettings = {
  alerts: AlertSettings
  activityFallback: boolean
  ignoreMissingJwt: boolean
  dropOldAlerts: boolean
  translateChat: boolean
  /** Extra words that highlight a chat line, on top of the connected account names. */
  mentionKeywords: string[]
  autoLiveCheck: AutoLiveCheck
  streamInfo: StreamInfoMap
  youtubeQuota: YoutubeQuota
  /** Readonly LAN watch link. Unset means follow RELAY_LAN / RELAY_BIND. */
  lanWatch?: boolean
}

// Chat-history cap: `CHAT_MAX` is the default, `RELAY_CHAT_MAX` may pull it
// down to `CHAT_MAX_MIN` or up to `CHAT_MAX_HARD`. Activity uses the same
// bounds via `RELAY_ACTIVITY_MAX` / `ACTIVITY_MAX`.
export const CHAT_MAX = 5000
export const CHAT_MAX_MIN = 100
export const CHAT_MAX_HARD = 1_000_000
export const ACTIVITY_MAX = 5000
export const STREAM_TAG_MAX = 10
export const TWITCH_TAG_MAX_LENGTH = 25
// YouTube's free daily Data API budget in quota units.
export const YOUTUBE_QUOTA_LIMIT = 10_000
// Kick is the stricter set: read/write chat and moderation only — no billing permissions.
export const YOUTUBE_OAUTH_SCOPES = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl'
export const TWITCH_OAUTH_SCOPES = 'user:read:email chat:read chat:edit user:read:chat user:write:chat channel:manage:broadcast channel:moderate moderator:manage:banned_users moderator:manage:chat_messages moderator:read:followers channel:read:subscriptions bits:read'
export const KICK_OAUTH_SCOPES = 'user:read channel:read channel:write chat:write events:subscribe moderation:ban moderation:chat_message:manage'
