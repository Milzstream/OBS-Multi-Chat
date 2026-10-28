import crypto from 'node:crypto'
import WebSocket from 'ws'
import { fetchTimed } from './fetch-timed.js'
import {
  TWITCH_EVENTSUB_DEFAULT_URL,
  applyLiveStreamDetails,
  normalizeAvatar,
  normalizeTags,
  parseTwitchChatLine,
  parseTwitchModerationLine,
  partsFromTwitchFragments,
  sanitizeIrcMessage,
  summarizeApiError,
  twitchBadgesFromList,
  twitchEventSubCloseAction,
  twitchEventSubConnectPlan,
  twitchEventSubRetryDelay,
  twitchEventSubSubscribeStillCurrent,
  twitchEventSubWatchdogShouldClose,
  twitchEventToActivity,
  twitchModerationBanData,
} from './logic.js'
import type { Account, AppSettings, ChatMessage, ChatModeration, Health, Platform, StreamInfoMap, Token, TokenPlatform } from './types.js'
import type { ActivityEvent } from './activity.js'

export type TwitchLiveDeps = {
  tokens: Partial<Record<TokenPlatform, Token>>
  state: { accounts: Account[]; messages: ChatMessage[]; streamInfo: StreamInfoMap; health: Record<Platform, Health> }
  settings: AppSettings
  ensureToken: (platform: Platform) => Promise<Token | undefined>
  refreshAccessToken: (platform: Platform) => Promise<Token | undefined>
  setHealth: (platform: Platform, status: Health['status'], message?: string) => void
  setActivityWarning: (key: string, message?: string) => void
  setChatWarning: (key: string, message?: string) => void
  addMessage: (message: ChatMessage, options?: { preload?: boolean; ingest?: 'official' | 'innertube'; source?: string }) => void
  /** `always` skips the native-backup setting, for alerts StreamElements does not send. */
  addNativeActivity: (event: ActivityEvent, options?: { always?: boolean }) => void
  applyChatModerationToState: (change: ChatModeration) => boolean
  restorePlatformConnection: (platform: Platform) => void
  scheduleChatSave: () => void
  broadcast: () => void
}

/** Twitch EventSub, IRC, Helix send, and moderation. Socket/timer state is closed over here. */
export function createTwitchLive(d: TwitchLiveDeps) {
  const {
    tokens,
    state,
    settings,
    ensureToken,
    refreshAccessToken,
    setHealth,
    setActivityWarning,
    setChatWarning,
    addMessage,
    addNativeActivity,
    applyChatModerationToState,
    restorePlatformConnection,
    scheduleChatSave,
    broadcast,
  } = d

  let twitchEventSubSessionId = ''
  let twitchIrc: WebSocket | undefined
  let twitchIrcReady = false
  let twitchEventSub: WebSocket | undefined
  let twitchEventSubGeneration = 0
  let twitchEventSubReady = false
  let twitchEventSubUnsupported = false
  let twitchKeepaliveMs = 10_000
  let twitchLastEventSub = 0
  let twitchEventSubResuming = false
  let twitchEventSubResumeSocket: WebSocket | undefined
  let twitchEventSubRetry: NodeJS.Timeout | undefined
  let twitchEventSubRetryAttempt = 0
  const twitchBadgeUrls = new Map<string, string>()
  const twitchAvatars = new Map<string, string>()
  const twitchAvatarPending = new Set<string>()
  let twitchBadgesLoaded = false
  let twitchAvatarTimer: NodeJS.Timeout | undefined

  async function twitchApi(endpoint: string, token: Token, options: RequestInit = {}, networkRetried = false, authRetried = false): Promise<any> {
    let response: Response
    try {
      response = await fetchTimed(`https://api.twitch.tv${endpoint}`, {
        ...options,
        headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID || '', Authorization: `Bearer ${token.accessToken}`, ...options.headers },
      })
    } catch (error) {
      if (!networkRetried) return twitchApi(endpoint, token, options, true, authRetried)
      throw error
    }
    if (response.status === 401 && !authRetried) {
      const refreshed = await refreshAccessToken('Twitch')
      if (refreshed) return twitchApi(endpoint, refreshed, options, networkRetried, true)
    }
    if ((response.status === 502 || response.status === 503 || response.status === 504) && !networkRetried) {
      await new Promise((resolve) => setTimeout(resolve, 800))
      return twitchApi(endpoint, token, options, true, authRetried)
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`Twitch API ${response.status}: ${summarizeApiError(response.status, text)}`)
    return text ? JSON.parse(text) : {}
  }

  function closeTwitchChat() {
    twitchEventSubGeneration += 1
    twitchEventSubReady = false
    twitchEventSubUnsupported = false
    twitchEventSubSessionId = ''
    twitchEventSubResuming = false
    twitchEventSubResumeSocket = undefined
    twitchEventSubRetryAttempt = 0
    cancelTwitchEventSubRetry()
    twitchIrcReady = false
    detachTwitchEventSub(twitchEventSub)
    twitchIrc?.close()
    twitchEventSub = undefined
    twitchIrc = undefined
  }

  function detachTwitchEventSub(socket?: WebSocket) {
    if (!socket) return
    socket.removeAllListeners()
    try { socket.close() } catch { /* already closed */ }
  }

  /** Connect Twitch EventSub over websocket; Twitch may ask us to reopen on a reconnect_url or we simply retry after a drop on a fresh session. */
  function cancelTwitchEventSubRetry() {
    if (twitchEventSubRetry) clearTimeout(twitchEventSubRetry)
    twitchEventSubRetry = undefined
  }

  function scheduleTwitchEventSubReconnect() {
    if (twitchEventSubRetry || twitchEventSubResuming) return
    if (!tokens.Twitch || twitchEventSubUnsupported) return
    const delay = twitchEventSubRetryDelay(twitchEventSubRetryAttempt)
    twitchEventSubRetryAttempt += 1
    twitchEventSubRetry = setTimeout(() => {
      twitchEventSubRetry = undefined
      connectTwitchEventSub()
    }, delay)
  }

  function connectTwitchEventSub(url = TWITCH_EVENTSUB_DEFAULT_URL) {
    // Reconnect generations: a stale socket's events are dropped once a newer session wins
    if (!tokens.Twitch?.userId || twitchEventSubUnsupported) return
    const plan = twitchEventSubConnectPlan(url, twitchEventSubGeneration)
    twitchEventSubGeneration = plan.generation
    const generation = plan.generation
    const socket = new WebSocket(url)
    if (plan.resume) {
      twitchEventSubResuming = true
      twitchEventSubResumeSocket = socket
    } else {
      twitchEventSub = socket
      twitchEventSubReady = false
      twitchLastEventSub = 0
      twitchEventSubResuming = false
      twitchEventSubResumeSocket = undefined
    }
    socket.on('message', (data) => {
      if (generation !== twitchEventSubGeneration) return
      twitchLastEventSub = Date.now()
      let payload: any
      try { payload = JSON.parse(String(data)) } catch { return }
      const type = payload?.metadata?.message_type
      if (type === 'session_welcome') {
        const previous = twitchEventSub
        twitchEventSub = socket
        if (previous && previous !== socket) detachTwitchEventSub(previous)
        twitchEventSubResuming = false
        twitchEventSubResumeSocket = undefined
        twitchEventSubRetryAttempt = 0
        cancelTwitchEventSubRetry()
        twitchLastEventSub = Date.now()
        twitchKeepaliveMs = Number(payload.payload?.session?.keepalive_timeout_seconds || 10) * 1000
        if (plan.resume) { twitchEventSubReady = true; console.log('Twitch EventSub resumed') }
        else {
          twitchEventSubSessionId = String(payload.payload.session.id || '')
          void subscribeTwitchEvents(twitchEventSubSessionId, generation)
        }
      } else if (type === 'notification') {
        handleTwitchEventSub(payload)
      } else if (type === 'session_reconnect' && payload.payload?.session?.reconnect_url) {
        // Resume on Twitch's inherited socket so subscriptions survive the transfer
        connectTwitchEventSub(payload.payload.session.reconnect_url)
      } else if (type === 'revocation') {
        console.error('Twitch EventSub revoked:', payload.payload?.subscription?.status)
        twitchEventSubReady = false
        connectTwitchIrc()
      }
    })
    socket.on('close', () => {
      const action = twitchEventSubCloseAction(twitchEventSub === socket, generation, twitchEventSubGeneration, twitchEventSubResuming, twitchEventSubResumeSocket === socket)
      if (action === 'ignore') return
      if (action === 'resume-failed') {
        twitchEventSubResuming = false
        twitchEventSubResumeSocket = undefined
        twitchEventSubReady = false
        scheduleTwitchEventSubReconnect()
        return
      }
      twitchEventSub = undefined
      twitchEventSubReady = false
      twitchEventSubResuming = false
      twitchEventSubResumeSocket = undefined
      scheduleTwitchEventSubReconnect()
    })
    socket.on('error', (error) => { console.error('Twitch EventSub:', error.message); socket.close() })
  }

  const twitchEventSubs: { type: string; version: string; condition: (userId: string) => Record<string, string>; activity?: boolean; always?: boolean }[] = [
    { type: 'channel.chat.message', version: '1', condition: (userId) => ({ broadcaster_user_id: userId, user_id: userId }) },
    { type: 'channel.chat.message_delete', version: '1', condition: (userId) => ({ broadcaster_user_id: userId, user_id: userId }) },
    { type: 'channel.chat.clear_user_messages', version: '1', condition: (userId) => ({ broadcaster_user_id: userId, user_id: userId }) },
    { type: 'channel.unban', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }) },
    { type: 'channel.follow', version: '2', condition: (userId) => ({ broadcaster_user_id: userId, moderator_user_id: userId }), activity: true },
    { type: 'channel.subscribe', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true },
    { type: 'channel.subscription.gift', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true },
    { type: 'channel.subscription.message', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true },
    { type: 'channel.cheer', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true },
    // Power-ups (gigantify, message effects, celebrations) spend Bits without a `channel.cheer`.
    { type: 'channel.bits.use', version: '1', condition: (userId) => ({ broadcaster_user_id: userId }), activity: true, always: true },
    { type: 'channel.raid', version: '1', condition: (userId) => ({ to_broadcaster_user_id: userId }), activity: true },
  ]

  async function subscribeTwitchEvents(sessionId: string, generation = twitchEventSubGeneration) {
    const token = await ensureToken('Twitch')
    if (!token?.userId) return
    const transport = { method: 'websocket', session_id: sessionId }
    let chatOk = false
    let activityFailed = false
    let moderationFailed = false
    for (const spec of twitchEventSubs) {
      if (spec.activity && !spec.always && !settings.activityFallback) continue
      try {
        await twitchApi('/helix/eventsub/subscriptions', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: spec.type, version: spec.version, condition: spec.condition(token.userId), transport }),
        })
        if (spec.type === 'channel.chat.message') chatOk = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/409|already exists|Conflict/i.test(message)) {
          if (spec.type === 'channel.chat.message') chatOk = true
          continue
        }
        if (spec.activity) activityFailed = true
        else {
          console.error(`Twitch EventSub ${spec.type}:`, message)
          if (spec.type === 'channel.chat.message' && (message.includes('403') || message.includes('401') || message.includes('scope'))) {
            twitchEventSubUnsupported = true
            console.log('Twitch chat falling back to IRC. Reconnect Twitch in settings to grant user:read:chat if you want EventSub.')
          }
          if (spec.type === 'channel.unban' && (message.includes('403') || message.includes('401') || message.includes('scope'))) moderationFailed = true
        }
      }
    }
    if (!twitchEventSubSubscribeStillCurrent(generation, sessionId, twitchEventSubGeneration, twitchEventSubSessionId || '')) {
      console.log('Twitch EventSub subscribe finished for a session that is no longer current')
      return
    }
    if (chatOk) {
      twitchEventSubReady = true
      twitchIrc?.close()
      setHealth('Twitch', 'ok')
      console.log(`Twitch EventSub connected (${token.user})`)
    } else connectTwitchIrc()
    if (activityFailed) {
      console.log('Twitch native alert backup needs a reconnect in settings (follow, sub, bits scopes).')
      setActivityWarning('twitch-scopes', 'Reconnect Twitch to enable native follow/sub/bits backup')
    } else setActivityWarning('twitch-scopes')
    if (moderationFailed) {
      console.log('Twitch EventSub unban needs the channel:moderate scope. Reconnect Twitch in settings to restore struck-through messages on unban.')
      setChatWarning('twitch-moderate', 'Reconnect Twitch to grant channel:moderate so unbans restore struck-through messages')
    } else setChatWarning('twitch-moderate')
  }

  function handleTwitchEventSub(payload: any) {
    const type = String(payload?.metadata?.subscription_type || '')
    const event = payload?.payload?.event
    if (type === 'channel.chat.message') {
      addMessage({
        id: event?.message_id || crypto.randomUUID(),
        platform: 'Twitch',
        user: event?.chatter_user_name || event?.chatter_user_login || 'Twitch user',
        handle: event?.chatter_user_login || undefined,
        userId: event?.chatter_user_id ? String(event.chatter_user_id) : undefined,
        color: event?.color || undefined,
        badges: twitchBadgesFromList(event?.badges, twitchBadgeUrls),
        avatar: normalizeAvatar(twitchAvatars.get(String(event?.chatter_user_id || ''))),
        text: event?.message?.text || '',
        time: new Date().toISOString(),
        parts: partsFromTwitchFragments(event?.message?.fragments, event?.message?.text || ''),
        emotes: (event?.message?.fragments || []).filter((item: any) => item.type === 'emote').map((item: any) => item.emote?.id).filter(Boolean),
      }, { source: 'EventSub' })
      setHealth('Twitch', 'ok')
      return
    }
    if (type === 'channel.chat.message_delete') {
      applyChatModerationToState({ action: 'delete', platform: 'Twitch', messageId: event?.message_id ? String(event.message_id) : undefined, user: event?.target_user_name || event?.target_user_login })
      return
    }
    if (type === 'channel.chat.clear_user_messages') {
      applyChatModerationToState({ action: 'ban', platform: 'Twitch', userId: event?.target_user_id ? String(event.target_user_id) : undefined, user: event?.target_user_name || event?.target_user_login })
      return
    }
    if (type === 'channel.unban') {
      applyChatModerationToState({ action: 'unban', platform: 'Twitch', userId: event?.user_id ? String(event.user_id) : undefined, user: event?.user_name || event?.user_login })
      return
    }
    const activity = twitchEventToActivity(type, event, payload?.metadata?.message_timestamp || new Date().toISOString(), payload?.metadata?.message_id)
    if (activity) addNativeActivity(activity, { always: Boolean(activity.powerUp) })
  }

  function watchTwitchEventSub() {
    if (!twitchEventSub) return
    if (twitchEventSubWatchdogShouldClose(twitchEventSubReady, twitchLastEventSub, Date.now(), twitchKeepaliveMs)) twitchEventSub.close()
  }

  function ensureTwitchChat() {
    if (!tokens.Twitch) return
    if (twitchEventSubReady) return
    if (twitchIrc && twitchIrc.readyState === WebSocket.OPEN) return
    if (twitchIrc) {
      try { twitchIrc.close() } catch { twitchIrc = undefined; twitchIrcReady = false; connectTwitchIrc(); return }
    }
    connectTwitchIrc()
  }

  function connectTwitchIrc() {
    if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady) return
    void ensureToken('Twitch').then(() => {
      if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady) return
      openTwitchIrc()
    })
  }

  function openTwitchIrc() {
    if (!tokens.Twitch?.user || twitchIrc || twitchEventSubReady) return
    const nick = tokens.Twitch.user.toLowerCase()
    twitchIrcReady = false
    twitchIrc = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    twitchIrc.on('open', () => {
      const token = tokens.Twitch
      if (!token || !twitchIrc) return
      twitchIrc.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n')
      twitchIrc.send(`PASS oauth:${token.accessToken}\r\n`)
      twitchIrc.send(`NICK ${nick}\r\n`)
    })
    twitchIrc.on('message', (data) => {
      const raw = String(data)
      if (raw.includes('NOTICE * :Login authentication failed') || raw.includes('NOTICE * :Improperly formatted auth')) {
        console.error('Twitch IRC authentication failed; reconnect Twitch to refresh its token and chat scopes.')
        setHealth('Twitch', 'down', 'Twitch chat login failed — reconnect Twitch in settings')
        void refreshAccessToken('Twitch').then(() => twitchIrc?.close())
        return
      }
      if (raw.includes(' 001 ')) {
        twitchIrc?.send(`JOIN #${nick}\r\n`)
        console.log(`Twitch IRC connected as ${nick}`)
      }
      if (raw.includes(' 366 ')) {
        twitchIrcReady = true
        setHealth('Twitch', 'ok')
        console.log(`Twitch IRC joined #${nick}`)
      }
      parseTwitchLines(raw).forEach((message) => addMessage(message, { source: 'IRC' }))
    })
    twitchIrc.on('close', () => {
      twitchIrc = undefined
      twitchIrcReady = false
      if (tokens.Twitch && !twitchEventSubReady) setTimeout(connectTwitchIrc, 5_000)
    })
    twitchIrc.on('error', (error) => {
      if (!/closed before the connection was established/i.test(error.message)) console.error('Twitch IRC:', error.message)
      twitchIrc?.close()
    })
  }

  function parseTwitchLines(raw: string): ChatMessage[] {
    return raw.split(/\r?\n/).flatMap((line) => {
      const parsed = parseTwitchChatLine(line, { urls: twitchBadgeUrls })
      if (parsed === 'ping') { twitchIrc?.send('PONG :tmi.twitch.tv\r\n'); return [] }
      if (parsed) return [{ ...parsed, avatar: parsed.userId ? twitchAvatars.get(parsed.userId) : undefined }]
      const moderation = parseTwitchModerationLine(line)
      if (moderation) applyChatModerationToState(moderation)
      return []
    })
  }

  async function ensureTwitchBadges() {
    const token = await ensureToken('Twitch')
    if (!token?.userId || twitchBadgesLoaded) return
    try {
      const [globalBadges, channelBadges] = await Promise.all([
        twitchApi('/helix/chat/badges/global', token),
        twitchApi(`/helix/chat/badges?broadcaster_id=${token.userId}`, token),
      ])
      twitchBadgeUrls.clear()
      for (const set of [...(globalBadges.data || []), ...(channelBadges.data || [])]) {
        for (const version of set.versions || []) {
          twitchBadgeUrls.set(`${set.set_id}/${version.id}`, version.image_url_2x || version.image_url_1x)
        }
      }
      twitchBadgesLoaded = true
    } catch (error) {
      console.error('Twitch badges:', error instanceof Error ? error.message : error)
    }
  }

  function queueTwitchAvatar(userId?: string) {
    if (!userId || twitchAvatars.has(userId) || twitchAvatarPending.has(userId)) return
    twitchAvatarPending.add(userId)
    if (twitchAvatarTimer) clearTimeout(twitchAvatarTimer)
    twitchAvatarTimer = setTimeout(() => { void flushTwitchAvatars() }, 400)
  }

  async function flushTwitchAvatars() {
    const token = await ensureToken('Twitch')
    if (!token) return
    const ids = [...twitchAvatarPending].slice(0, 80)
    ids.forEach((id) => twitchAvatarPending.delete(id))
    if (!ids.length) return
    try {
      const result = await twitchApi(`/helix/users?${ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`, token)
      for (const user of result.data || []) {
        const avatar = normalizeAvatar(user.profile_image_url)
        if (user.id && avatar) twitchAvatars.set(String(user.id), avatar)
      }
      let changed = false
      state.messages = state.messages.map((item) => {
        if (item.platform !== 'Twitch' || !item.userId) return item
        const avatar = twitchAvatars.get(item.userId)
        if (!avatar || item.avatar === avatar) return item
        changed = true
        return { ...item, avatar }
      })
      if (changed) {
        scheduleChatSave()
        broadcast()
      }
    } catch (error) {
      console.error('Twitch avatars:', error instanceof Error ? error.message : error)
    }
    if (twitchAvatarPending.size) queueTwitchAvatar([...twitchAvatarPending][0])
  }

  async function pollTwitch() {
    const token = await ensureToken('Twitch')
    if (!token) return
    const streams = await twitchApi(`/helix/streams?user_id=${token.userId}`, token)
    const account = state.accounts.find((item) => item.platform === 'Twitch')!
    const stream = streams.data?.[0]
    restorePlatformConnection('Twitch')
    Object.assign(account, { live: Boolean(stream), viewers: stream?.viewer_count || 0, handle: token.user || account.handle })
    if (stream) {
      state.streamInfo.Twitch = applyLiveStreamDetails(state.streamInfo.Twitch, { title: stream.title || '', category: stream.game_name || '', categoryId: stream.game_id || undefined, tags: normalizeTags(stream.tags) })
    } else {
      const channel = await twitchApi(`/helix/channels?broadcaster_id=${token.userId}`, token)
      const info = channel.data?.[0]
      if (info) state.streamInfo.Twitch = applyLiveStreamDetails(state.streamInfo.Twitch, { title: info.title || '', category: info.game_name || '', categoryId: info.game_id || undefined, tags: normalizeTags(info.tags) })
    }
    void ensureTwitchBadges()
    ensureTwitchChat()
  }

  async function sendTwitchMessage(text: string) {
    const safeText = sanitizeIrcMessage(text)
    const nick = tokens.Twitch?.user?.toLowerCase()
    if (twitchIrc?.readyState === WebSocket.OPEN && twitchIrcReady && nick) {
      twitchIrc.send(`PRIVMSG #${nick} :${safeText}\r\n`)
      return { ok: true }
    }
    const helix = await sendTwitchHelix(text)
    if (helix.ok) return helix
    await waitForTwitchIrc()
    if (twitchIrc?.readyState === WebSocket.OPEN && twitchIrcReady && nick) {
      twitchIrc.send(`PRIVMSG #${nick} :${safeText}\r\n`)
      return { ok: true }
    }
    return { ok: false, error: helix.error || 'Twitch chat is not ready; reconnect Twitch and try again' }
  }

  async function sendTwitchHelix(text: string) {
    const token = await ensureToken('Twitch')
    if (!token?.userId) return { ok: false, error: 'Twitch user id missing' }
    try {
      const result = await twitchApi('/helix/chat/messages', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcaster_id: token.userId, sender_id: token.userId, message: text }),
      })
      if (result.data?.[0]?.is_sent === false) return { ok: false, error: result.data[0].drop_reason?.message || 'Twitch dropped the message' }
      return { ok: true, id: result.data?.[0]?.message_id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function moderateTwitch(body: { action: string; messageId?: string; userId?: string; duration?: number; reason?: string }) {
    const token = await ensureToken('Twitch')
    if (!token?.userId) return { ok: false, error: 'Twitch is not connected' }
    const id = token.userId
    if (body.action === 'delete') {
      if (!body.messageId) return { ok: false, error: 'Message id is required' }
      await twitchApi(`/helix/moderation/chat?broadcaster_id=${id}&moderator_id=${id}&message_id=${encodeURIComponent(body.messageId)}`, token, { method: 'DELETE' })
      return { ok: true }
    }
    if (!body.userId) return { ok: false, error: 'User id is required' }
    if (body.action === 'unban') {
      await twitchApi(`/helix/moderation/bans?broadcaster_id=${id}&moderator_id=${id}&user_id=${encodeURIComponent(body.userId)}`, token, { method: 'DELETE' })
      return { ok: true }
    }
    const data = twitchModerationBanData(body.userId, body.action, body.duration, body.reason)
    await twitchApi(`/helix/moderation/bans?broadcaster_id=${id}&moderator_id=${id}`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    })
    return { ok: true, ...(data.reason ? { reason: data.reason } : {}) }
  }

  async function waitForTwitchIrc() {
    if (!twitchIrc && !twitchEventSubReady) connectTwitchIrc()
    for (let attempt = 0; attempt < 40 && (!twitchIrc || twitchIrc.readyState !== WebSocket.OPEN || !twitchIrcReady); attempt++) {
      if (twitchEventSubReady) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  return {
    twitchApi,
    closeTwitchChat,
    detachTwitchEventSub,
    cancelTwitchEventSubRetry,
    scheduleTwitchEventSubReconnect,
    connectTwitchEventSub,
    subscribeTwitchEvents,
    handleTwitchEventSub,
    watchTwitchEventSub,
    ensureTwitchChat,
    connectTwitchIrc,
    openTwitchIrc,
    parseTwitchLines,
    ensureTwitchBadges,
    queueTwitchAvatar,
    flushTwitchAvatars,
    pollTwitch,
    sendTwitchMessage,
    sendTwitchHelix,
    moderateTwitch,
    waitForTwitchIrc,
    get twitchEventSubReady() { return twitchEventSubReady },
    get twitchIrcReady() { return twitchIrcReady },
    get twitchEventSubSessionId() { return twitchEventSubSessionId },
    get twitchEventSubUnsupported() { return twitchEventSubUnsupported },
    set twitchEventSubUnsupported(value: boolean) { twitchEventSubUnsupported = value },
    get twitchBadgesLoaded() { return twitchBadgesLoaded },
    set twitchBadgesLoaded(value: boolean) { twitchBadgesLoaded = value },
  }
}

export type TwitchLive = ReturnType<typeof createTwitchLive>
