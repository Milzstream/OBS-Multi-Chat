import type { Account, ChatMessage, Health, Platform, StreamDetails, StreamInfoMap, YoutubeQuotaStatus } from '../../server/types'
import type { YoutubePrivacyNotice } from '../chat-helpers'

export type { Account, ChatMessage, Health, Platform, StreamDetails, StreamInfoMap, YoutubePrivacyNotice, YoutubeQuotaStatus }

export type Connection = Account
export type StreamPlatform = 'Twitch' | 'Kick'
export type StreamDetailsByPlatform = StreamInfoMap
export type CategoryOption = { id: string; name: string }
export type ModPrompt = { action: 'timeout' | 'ban'; duration?: number; confirmOnly?: boolean }
export type ModMenuState = { x: number; y: number; message: ChatMessage; prompt?: ModPrompt }
export type BackendState = {
  accounts: Connection[]
  streamInfo: StreamDetailsByPlatform
  messages: ChatMessage[]
  health: Record<Platform, Health>
  translateChat?: boolean
  mentionKeywords?: string[]
  youtubeQuota?: YoutubeQuotaStatus
  youtubePrivacy?: YoutubePrivacyNotice[]
}
