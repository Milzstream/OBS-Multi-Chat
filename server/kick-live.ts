import crypto from 'node:crypto'
import { kickProfileSlug, type ActivityEvent } from './activity.js'
import { fetchTimed } from './fetch-timed.js'
import { KickChat, createFlushLock, lookupKickProfilePics, type KickActivity, type KickModeration } from './kick-chat.js'
import {
  applyLiveStreamDetails,
  kickBadges,
  kickChannelPollFailure,
  kickModerationBanPayload,
  kickStreamDetails,
  looksLikePlaceholder,
  normalizeAvatar,
  parseKickParts,
} from './logic.js'
import type { Account, ChatMessage, ChatModeration, Health, Platform, StreamInfoMap, Token, TokenPlatform } from './types.js'

export type KickLiveDeps = {
  tokens: Partial<Record<TokenPlatform, Token>>
  state: { accounts: Account[]; messages: ChatMessage[]; streamInfo: StreamInfoMap }
  ensureToken: (platform: Platform) => Promise<Token | undefined>
  refreshAccessToken: (platform: Platform) => Promise<Token | undefined>
  saveTokens: () => void
  restorePlatformConnection: (platform: Platform) => void
  setHealth: (platform: Platform, status: Health['status'], message?: string) => void
  addMessage: (message: ChatMessage, options?: { preload?: boolean; ingest?: 'official' | 'innertube'; source?: string }) => void
  addNativeActivity: (event: ActivityEvent) => void
  applyChatModerationToState: (change: ChatModeration) => boolean
  scheduleChatSave: () => void
  broadcast: () => void
}

/** Kick public API send/moderation and realtime chat start. */
export function createKickLive(d: KickLiveDeps) {
  const {
    tokens,
    state,
    ensureToken,
    refreshAccessToken,
    saveTokens,
    restorePlatformConnection,
    setHealth,
    addMessage,
    addNativeActivity,
    applyChatModerationToState,
    scheduleChatSave,
    broadcast,
  } = d

  const kickChat = new KickChat()
  const kickAvatars = new Map<string, string>()
  const kickAvatarPending = new Set<string>()
  let kickAvatarTimer: NodeJS.Timeout | undefined
  const kickAvatarFlush = createFlushLock()

  /** Keep an already-known Kick chat socket up without calling the channel live-status API. */
  function maintainKickChat() {
    const slug = tokens.Kick?.user
    if (slug && !looksLikePlaceholder(slug)) startKickChat(slug)
  }

  function startKickChat(slug: string) {
    queueKickAvatar(slug)
    void kickChat.start(slug, (message) => {
      const avatar = normalizeAvatar(message.avatar) || (message.slug ? kickAvatars.get(message.slug.toLowerCase()) : undefined)
      addMessage({
      id: message.id || crypto.randomUUID(),
      platform: 'Kick',
      user: message.user,
      userId: message.userId,
      handle: message.slug,
      color: message.color,
      avatar,
      badges: kickBadges(message.badges),
      text: message.text,
      time: new Date().toISOString(),
      parts: parseKickParts(message.text, message.emotes),
      }, { source: 'socket' })
      if (avatar && message.slug) kickAvatars.set(message.slug.toLowerCase(), avatar)
      else queueKickAvatar(message.slug || kickProfileSlug(message.user))
    }, tokens.Kick?.channelId ? Number(tokens.Kick.channelId) : undefined, (event: KickActivity) => addNativeActivity({
      id: event.id || '',
      platform: 'Kick',
      kind: event.kind,
      user: event.user,
      userId: event.userId,
      handle: event.slug,
      amount: event.amount,
      months: event.months,
      viewers: event.viewers,
      message: event.message,
      time: event.time || new Date().toISOString(),
    }), (event: KickModeration) => applyChatModerationToState({
      action: event.action,
      platform: 'Kick',
      messageId: event.messageId,
      userId: event.userId,
      user: event.user,
    })).then(() => {
      if (kickChat.currentChatroomId && tokens.Kick && tokens.Kick.channelId !== String(kickChat.currentChatroomId)) {
        tokens.Kick.channelId = String(kickChat.currentChatroomId)
        saveTokens()
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Kick chat:', message)
      setHealth('Kick', 'down', 'Kick chat failed to connect — messages may be missing')
    })
  }

  // Kick messages do not carry their author's picture, so profile pics are fetched in small batches and backfilled onto the matching rows
  function queueKickAvatar(slug?: string) {
    const key = String(slug || '').trim().toLowerCase()
    if (!key || kickAvatars.has(key) || kickAvatarPending.has(key)) return
    kickAvatarPending.add(key)
    if (kickAvatarTimer) clearTimeout(kickAvatarTimer)
    kickAvatarTimer = setTimeout(() => { void flushKickAvatars() }, 400)
  }

  async function flushKickAvatars() {
    await kickAvatarFlush.run(async () => {
      const slugs = [...kickAvatarPending].slice(0, 5)
      slugs.forEach((slug) => kickAvatarPending.delete(slug))
      if (!slugs.length) return
      const pics = await lookupKickProfilePics(slugs)
      for (const [slug, url] of pics) {
        const avatar = normalizeAvatar(url)
        if (avatar) kickAvatars.set(slug, avatar)
      }
      let changed = false
      state.messages = state.messages.map((item) => {
        if (item.platform !== 'Kick') return item
        const avatar = kickAvatars.get((item.handle || kickProfileSlug(item.user)).toLowerCase())
        if (!avatar || item.avatar === avatar) return item
        changed = true
        return { ...item, avatar }
      })
      if (changed) {
        scheduleChatSave()
        broadcast()
      }
      if (kickAvatarPending.size) queueKickAvatar([...kickAvatarPending][0])
    })
  }

  async function pollKick() {
    const token = await ensureToken('Kick')
    if (!token) return
    const response = await kickApi('/channels', token)
    if (!response.ok) {
      const failure = kickChannelPollFailure(response.status)
      await response.text().catch(() => '')
      if (failure?.refresh) await refreshAccessToken('Kick')
      throw new Error(failure?.message || `Kick status poll failed (${response.status})`)
    }
    const payload = await response.json() as any
    const channel = payload.data?.[0]
    const account = state.accounts.find((item) => item.platform === 'Kick')!
    const slug = channel?.slug || (!looksLikePlaceholder(token.user || '') ? token.user : '')
    if (slug && token.user !== slug) {
      token.user = slug
      saveTokens()
    }
    if (channel?.broadcaster_user_id && token.userId !== String(channel.broadcaster_user_id)) {
      token.userId = String(channel.broadcaster_user_id)
      saveTokens()
    }
    restorePlatformConnection('Kick')
    Object.assign(account, { live: Boolean(channel?.stream?.is_live), viewers: Number(channel?.stream?.viewer_count || 0), handle: slug || account.handle })
    if (channel) state.streamInfo.Kick = applyLiveStreamDetails(state.streamInfo.Kick, kickStreamDetails(channel))
    if (slug) startKickChat(slug)
    else await kickChat.stop()
  }

  async function sendKickMessage(text: string) {
    const token = await ensureToken('Kick')
    if (!token) return { ok: false, error: 'Not connected' }
    const response = await kickApi('/chat', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, type: 'user', ...(token.userId ? { broadcaster_user_id: Number(token.userId) } : {}) }),
    })
    if (response.ok) return { ok: true }
    return { ok: false, error: await response.text() }
  }

  async function moderateKick(body: { action: string; messageId?: string; userId?: string; duration?: number; reason?: string }) {
    const token = await ensureToken('Kick')
    if (!token?.userId) return { ok: false, error: 'Kick is not connected' }
    if (body.action === 'delete') {
      if (!body.messageId) return { ok: false, error: 'Message id is required' }
      const response = await kickApi(`/chat/${encodeURIComponent(body.messageId)}`, token, { method: 'DELETE' })
      if (!response.ok) return { ok: false, error: await response.text() }
      return { ok: true }
    }
    if (!body.userId) return { ok: false, error: 'User id is required' }
    const payload = kickModerationBanPayload(token.userId, body.userId, body.action, body.duration, body.reason)
    const response = await kickApi('/moderation/bans', token, {
      method: body.action === 'unban' ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body.action === 'unban' ? { broadcaster_user_id: payload.broadcaster_user_id, user_id: payload.user_id } : payload),
    })
    if (!response.ok) return { ok: false, error: await response.text() }
    return { ok: true, ...(body.action !== 'unban' && payload.reason ? { reason: payload.reason } : {}) }
  }

  async function kickApi(endpoint: string, token = tokens.Kick!, options: RequestInit = {}, retried = false) {
    const current = token || await ensureToken('Kick')
    if (!current) throw new Error('Kick is not connected')
    const base = process.env.KICK_API_BASE || 'https://api.kick.com/public/v1'
    const response = await fetchTimed(`${base}${endpoint}`, {
      ...options,
      headers: { Authorization: `Bearer ${current.accessToken}`, Accept: 'application/json', ...options.headers },
    })
    if (response.status === 401 && !retried) {
      const refreshed = await refreshAccessToken('Kick')
      if (refreshed) return kickApi(endpoint, refreshed, options, true)
    }
    return response
  }

  return {
    startKickChat,
    maintainKickChat,
    kickApi,
    sendKickMessage,
    moderateKick,
    pollKick,
    queueKickAvatar,
    flushKickAvatars,
    kickChat,
  }
}

export type KickLive = ReturnType<typeof createKickLive>
