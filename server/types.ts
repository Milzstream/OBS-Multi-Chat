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
export type Account = { platform: Platform; connected: boolean; live: boolean; viewers: number; handle: string }
export type MessagePart = { type: 'text'; text: string } | { type: 'emote'; name: string; url: string }
export type ChatBadge = { title: string; url?: string; label?: string }
export type ChatMessage = { id: string; platform: Platform; platforms?: Platform[]; user: string; text: string; time: string; emotes?: string[]; parts?: MessagePart[]; userId?: string; handle?: string; sourceId?: string; sourceLabel?: string; originalText?: string; avatar?: string; color?: string; badges?: ChatBadge[]; deleted?: boolean; ingest?: 'official' | 'innertube' }
// Aggregate moderation action across platforms. `timeout` (Twitch) and `ban`
// both hide a user's messages; `unban` restores them. Timeout durations live
// in the per-platform source, so this type stays duration-free.
export type ChatModeration = { action: 'delete' | 'timeout' | 'ban' | 'unban'; platform: Platform; messageId?: string; userId?: string; user?: string }
export type StreamDetails = { title: string; category: string; categoryId?: string; tags?: string[] }
export type StreamInfoMap = Record<StreamInfoPlatform, StreamDetails>
export type Health = { status: 'ok' | 'warn' | 'down'; message: string }
export type StreamElementsStatus = { connected: boolean; handle: string; missing: string[] }
export type YoutubeQuota = { day: string; used: number; limit?: number }
export type YoutubeQuotaStatus = { used: number; limit: number }
export type AppSettings = { activityFallback: boolean; ignoreMissingJwt: boolean; dropOldAlerts: boolean; translateChat: boolean; streamInfo: StreamInfoMap; youtubeQuota: YoutubeQuota }

// Chat-history cap: `CHAT_MAX` is the default, `RELAY_CHAT_MAX` may pull it
// down to `CHAT_MAX_MIN` or up to `CHAT_MAX_HARD`.
export const CHAT_MAX = 5000
export const CHAT_MAX_MIN = 100
export const CHAT_MAX_HARD = 1_000_000
export const STREAM_TAG_MAX = 10
export const TWITCH_TAG_MAX_LENGTH = 25
// YouTube's free daily Data API budget in quota units.
export const YOUTUBE_QUOTA_LIMIT = 10_000
// Kick is the stricter set: read/write chat and moderation only — no billing permissions.
export const YOUTUBE_OAUTH_SCOPES = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl'
export const TWITCH_OAUTH_SCOPES = 'user:read:email chat:read chat:edit user:read:chat user:write:chat channel:manage:broadcast moderator:manage:banned_users moderator:manage:chat_messages moderator:read:followers channel:read:subscriptions bits:read'
export const KICK_OAUTH_SCOPES = 'user:read channel:read channel:write chat:write events:subscribe moderation:ban moderation:chat_message:manage'
