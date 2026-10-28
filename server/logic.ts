/**
 * Pure helper functions for the Relay Chat Dock. Implementations live in
 * `server/logic/`. This barrel keeps existing `./logic.js` imports working.
 * This file owns no network calls, no in-memory state, and no side effects.
 */

export {
  ACTIVITY_MAX,
  CHAT_MAX,
  CHAT_MAX_HARD,
  CHAT_MAX_MIN,
  KICK_OAUTH_SCOPES,
  STREAM_TAG_MAX,
  TWITCH_OAUTH_SCOPES,
  TWITCH_TAG_MAX_LENGTH,
  YOUTUBE_OAUTH_SCOPES,
  YOUTUBE_QUOTA_LIMIT,
} from './types.js'

export type {
  YoutubePrivacy,
  YoutubePrivacyNotice,
  YoutubePrivacyWatch,
} from './types.js'

export { parseActivityMax, parseChatMax } from './logic/limits.js'
export { activityAppendedEvent, activitySseFields, sseBroadcastEvent, sseChangedKeys, sseNamedEvent } from './logic/sse.js'
export { looksLikePlaceholder, kickBadges, kickCategorySkipped, kickChannelPatch, kickChannelPollFailure, kickEmoteUrl, kickStreamDetails, parseKickParts, shouldWarnKickChatDown } from './logic/kick.js'
export { normalizeAvatar, shareInFlight, summarizeApiError } from './logic/http.js'
export {
  LIVE_STATUS_POLL_MS,
  YOUTUBE_STATUS_LIVE_MS,
  headerNumber,
  isDailyQuotaHeader,
  isEndedYouTubeChat,
  loadYouTubeQuota,
  nextPacificMidnight,
  pacificDate,
  parseYouTubeQuotaInput,
  quotaFromHeaders,
  quotaWarnAt,
  restoreYouTubeQuotaBlock,
  shouldPollLiveStatus,
  shouldRunYouTubeMaintenance,
  shouldRunYouTubeStatusCheck,
  youtubeApiErrorReason,
  youtubeQuotaCost,
  youtubeQuotaHealthStatus,
  youtubeQuotaLabel,
  youtubeStatusIntervalMs,
} from './logic/youtube-quota.js'
export {
  YOUTUBE_PRIVACY_RECHECK_MS,
  YOUTUBE_PRIVACY_WATCH_MS,
  nextYoutubePrivacyWatch,
  youtubePrivacyMessage,
  youtubePrivacyNotices,
  youtubePrivacyRecheckIds,
  youtubePrivacyValue,
  youtubePublicVideoBody,
  youtubeVideoId,
} from './logic/youtube-privacy.js'
export {
  descriptionWithTagLine,
  labelYouTubeTargets,
  loadYoutubeBanIds,
  looksLikeTagLine,
  parseTagsFromDescription,
  pruneYouTubeSeenIds,
  resolveYouTubeLiveChatIds,
  sortedYouTubeBadges,
  syncYouTubeTokenChatIds,
  youtubeBadges,
  youtubeBanChatIds,
  youtubeBanRecord,
  youtubeChatKeysFor,
  youtubeChatLabel,
  youtubeInsertedMessageId,
  youtubeLiveChatCursor,
  youtubeLiveChatListQuery,
  youtubeLiveChatMessageBody,
  youtubeOfficialModeration,
  youtubeOfficialToActivity,
  youtubeSameChatFor,
  youtubeScrapedTarget,
  youtubeSendGuard,
  youtubeTagLine,
  youtubeTagWriteNeeded,
  youtubeTitleIsShorts,
} from './logic/youtube.js'
export {
  MODERATION_REASON_MAX,
  applyChatModeration,
  chatUserMatches,
  kickModerationBanPayload,
  messageOnPlatform,
  normalizeModerationReason,
  twitchModerationBanData,
  youtubeLiveChatBanSnippet,
} from './logic/moderation.js'
export {
  applyOutgoingSendResult,
  chatCopyKey,
  chatMessageCopies,
  chatTextMatches,
  closestRecentOutgoing,
  collapseYouTubeDuplicates,
  foldChatText,
  foldRawText,
  isOwnChatMessage,
  isStoredChatMessage,
  isTruncatedText,
  mergeChatCopies,
  mergeIncomingChat,
  mergedSourceLabel,
  normalizeChatHandle,
  preferChatText,
  rowMatchesOutgoing,
  truncatedFoldMatches,
  youtubeSameAuthor,
} from './logic/chat-merge.js'
export type { OutgoingSendResult } from './logic/chat-merge.js'
export {
  TWITCH_EVENTSUB_DEFAULT_URL,
  parseIrcTags,
  parseTwitchChatLine,
  parseTwitchEmoteParts,
  parseTwitchModerationLine,
  partsFromTwitchFragments,
  sanitizeIrcMessage,
  twitchBadgeLabel,
  twitchBadgesFromList,
  twitchBadgesFromTag,
  gigantifyLastEmote,
  twitchEmoteUrl,
  twitchEventSubCloseAction,
  twitchEventSubConnectPlan,
  twitchEventSubRetryDelay,
  twitchEventSubSubscribeStillCurrent,
  twitchEventSubWatchdogShouldClose,
  twitchEventToActivity,
  unescapeIrcTag,
} from './logic/twitch-irc.js'
export {
  applyLiveStreamDetails,
  emptyStreamDetails,
  emptyStreamInfo,
  isKickTag,
  isMoreSpecificCategory,
  isTwitchTag,
  kickTagsForApi,
  loadStreamInfo,
  normalizeStreamDetails,
  normalizeTags,
  streamDetailsUnchanged,
  tagsEqual,
  twitchTagsForApi,
} from './logic/stream-info.js'
export {
  ALERT_DISPLAY_MAX,
  ALERT_DISPLAY_MIN,
  clampAlertSeconds,
  defaultAlertSettings,
  defaultAppSettings,
  defaultAutoLiveCheck,
  mergeAutoLiveCheck,
  missingStreamElementsMessage,
  parseAlertDisabled,
  parseAlertSettings,
  parseAppSettings,
  parseAutoLiveCheck,
  parseMentionKeywords,
} from './logic/settings.js'
export {
  isPermanentTokenRefreshError,
  isTokenRefreshHealthMessage,
  oauthAuthorizeUrl,
  shouldKeepTokenRefreshBanner,
  tokenRefreshFailureMessage,
  tokenRefreshRetryMessage,
} from './logic/oauth.js'
export {
  needsTranslation,
  parseTranslatedText,
  resolveTranslateConfig,
  translateFailureMessage,
} from './logic/translate.js'
export type { TranslateProvider } from './logic/translate.js'
export { applyThirdPartyEmotes, bttvEmotes, ffzEmotes, mergeEmoteMaps, sevenTvEmotes } from './logic/third-party-emotes.js'
export type { EmoteMap } from './logic/third-party-emotes.js'
