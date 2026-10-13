import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { fetchTimed, type FetchLike } from './fetch-timed.js'

/**
 * Kick chat, activity, and moderation over Kick's public Pusher WebSocket, plus
 * profile-picture lookups that work around Kick's Cloudflare challenge.
 *
 * This file owns reading. Sending and OAuth live in server.ts.
 *
 * All payload shapes matched here are the unofficial Pusher message payloads
 * that Kick's site uses, not the official Kick REST API.
 */

export type KickChatMessage = { id?: string; user: string; text: string; userId?: string; slug?: string; color?: string; avatar?: string; badges?: { type?: string; text?: string }[]; emotes?: any[] }
export type KickActivity = { id?: string; kind: 'follow' | 'subscription' | 'gift' | 'cheer' | 'raid'; user: string; userId?: string; slug?: string; amount?: string; months?: number; viewers?: number; message?: string; time?: string }
export type KickModeration = { action: 'delete' | 'ban' | 'unban'; messageId?: string; userId?: string; user?: string; slug?: string }

const KICK_CLIENT_ID = `relay-${process.pid}`
export const BROWSER_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
}

/** Resolve an Edge or Chrome path for headless lookups when Cloudflare blocks Node fetch. */
function browserPath() {
  const candidates = [
    process.env.BROWSER_PATH,
    // deprecated alias kept for backward compatibility
    process.env.KICK_BROWSER_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
}

export function parseJson(value: unknown) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as any } catch { return undefined }
  }
  return value as any
}

export type KickSocketFrame = {
  event: string
  channel?: string
  handshake?: 'connect' | 'ping' | 'subscribed' | 'error'
  error?: string
  message?: KickChatMessage
  moderation?: KickModeration
  activity?: KickActivity
}

export function readKickSocketFrame(raw: unknown): KickSocketFrame | undefined {
  const payload = typeof raw === 'string' ? parseJson(raw) : raw
  if (!payload || typeof payload !== 'object') return
  const event = String((payload as { event?: unknown }).event || '')
  if (!event) return
  const channelValue = (payload as { channel?: unknown }).channel
  const channel = channelValue ? String(channelValue) : undefined
  if (event === 'pusher:error') {
    const data = parseJson((payload as { data?: unknown }).data) || (payload as { data?: { message?: unknown } }).data
    return { event, channel, handshake: 'error', error: String((data as { message?: unknown })?.message || 'Pusher error') }
  }
  if (event === 'pusher:connection_established') return { event, channel, handshake: 'connect' }
  if (event === 'pusher:ping') return { event, channel, handshake: 'ping' }
  if (event === 'pusher_internal:subscription_succeeded') return { event, channel, handshake: 'subscribed' }
  const data = parseJson((payload as { data?: unknown }).data)
  if (/ChatMessage/i.test(event)) {
    const message = parseKickChatMessage(data)
    return message ? { event, channel, message } : { event, channel }
  }
  const moderation = kickEventToModeration(event, data)
  const activity = kickEventToActivity(event, data)
  const rawTime = data?.created_at || data?.createdAt || data?.timestamp
  return {
    event,
    channel,
    moderation,
    activity: activity && rawTime ? { ...activity, time: String(rawTime) } : activity,
  }
}

export function kickRealtimeRequest(clientId = KICK_CLIENT_ID) {
  return {
    client: { id: clientId, type: 'web' },
    capabilities: { accepted_providers: [{ provider: 'pusher' }, { provider: 'centrifugo' }] },
  }
}

export function kickRealtimePlan(payload: any): { provider: 'centrifugo'; url: string } | { provider: 'pusher'; url: string } | undefined {
  const connections = payload?.data?.connections || payload?.connections || []
  for (const item of connections) {
    const credentials = item?.credentials || {}
    if (item?.provider === 'centrifugo' && credentials.url) return { provider: 'centrifugo', url: String(credentials.url) }
    if (item?.provider === 'pusher' && credentials.app_key && credentials.cluster) {
      return { provider: 'pusher', url: `wss://ws-${credentials.cluster}.pusher.com/app/${credentials.app_key}?protocol=7&client=js&version=8.4.0&flash=false` }
    }
  }
}

export function kickRealtimeToken(payload: any) {
  const token = payload?.data?.token || payload?.token
  return typeof token === 'string' && token ? token : undefined
}

export function readKickCentrifugoFrame(raw: string) {
  const payload = parseJson(raw)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  if (!Object.keys(payload).length) return { kind: 'ping' as const }
  if (payload.error) return { kind: 'error' as const, message: String(payload.error.message || payload.error.code || 'realtime error') }
  if (payload.connect) return { kind: 'connected' as const }
  if (payload.subscribe && payload.id) return { kind: 'subscribed' as const, id: Number(payload.id) }
  const data = payload.push?.pub?.data
  if (!data || typeof data !== 'object' || !data.event) return
  return {
    kind: 'publication' as const,
    channel: payload.push.channel ? String(payload.push.channel) : undefined,
    frame: { event: String(data.event), channel: payload.push.channel, data: typeof data.data === 'string' ? data.data : data.data },
  }
}

export function chatroomIdFrom(payload: any): number | undefined {
  const id = payload?.chatroom?.id ?? payload?.chatroom_id ?? payload?.data?.chatroom?.id
  const numeric = Number(id)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
}

const kickProfilePicCache = new Map<string, string>()

export function isKickSlug(slug: string) {
  return /^[a-z0-9_-]{1,50}$/i.test(slug.trim())
}

/** Build a PowerShell invocation that fetches a Kick channel payload with a browser User-Agent, for machines where Node fetch is Cloudflare-blocked. */
export function kickChannelPowershell(slug: string) {
  const key = slug.trim().toLowerCase()
  if (!isKickSlug(key)) return
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(key)}`
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', `Invoke-WebRequest -Uri '${url}' -Headers @{Accept='application/json'; 'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'; Referer='https://kick.com/${key}'} -UseBasicParsing | Select-Object -ExpandProperty Content`],
  }
}

export function rememberKickProfilePic(slug: string, payload: any) {
  const key = slug.trim().toLowerCase()
  const pic = kickProfilePicFromChannel(payload)
  if (key && pic) kickProfilePicCache.set(key, pic)
}

export const KICK_PAGE_FETCH_MS = 12_000

export function kickPageFetch(url: string, init: RequestInit = {}, fetchImpl?: FetchLike, ms = KICK_PAGE_FETCH_MS) {
  return fetchTimed(url, init, ms, fetchImpl ?? fetch)
}

export function createFlushLock() {
  let running = false
  let pending = false
  return {
    async run(task: () => Promise<void>) {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        do {
          pending = false
          await task()
        } while (pending)
      } finally {
        running = false
      }
    },
  }
}

export function kickSocketShouldStay(readyState?: number) {
  return readyState === WebSocket.CONNECTING || readyState === WebSocket.OPEN
}

export function dropSocket(socket?: { removeAllListeners: (event?: string) => void; on: (event: string, listener: () => void) => void; terminate: () => void }) {
  if (!socket) return
  socket.removeAllListeners('message')
  socket.removeAllListeners('close')
  socket.on('error', () => undefined)
  try { socket.terminate() } catch { /* already closed */ }
}

/** Resolve a channel's public chatroom id. Node fetch is often Cloudflare-blocked; Windows PowerShell then a real browser are the fallbacks. */
export async function resolveKickChatroomId(slug: string, cached?: number): Promise<number> {
  if (cached && cached > 0) return cached
  const key = slug.trim().toLowerCase()
  if (!isKickSlug(key)) throw new Error(`Could not resolve Kick chatroom id for ${slug}`)
  for (const url of [
    `https://kick.com/api/v2/channels/${encodeURIComponent(key)}`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(key)}`,
  ]) {
    try {
      const response = await kickPageFetch(url, { headers: { ...BROWSER_HEADERS, Referer: `https://kick.com/${encodeURIComponent(key)}` } })
      if (!response.ok) continue
      const payload = await response.json()
      rememberKickProfilePic(key, payload)
      const id = chatroomIdFrom(payload)
      if (id) return id
    } catch { /* Cloudflare often blocks Node fetch; fall through */ }
  }
  try {
    const payload = await fetchKickChannelPayloadWindows(key)
    rememberKickProfilePic(key, payload)
    const id = chatroomIdFrom(payload)
    if (id) return id
  } catch { /* powershell missing or blocked */ }
  const fromBrowser = await resolveChatroomIdWithBrowser(key)
  if (fromBrowser) return fromBrowser
  throw new Error(`Could not resolve Kick chatroom id for ${key}`)
}

async function fetchKickChannelPayloadWindows(slug: string) {
  if (process.platform !== 'win32') return
  const plan = kickChannelPowershell(slug)
  if (!plan) return
  const { execFile } = await import('node:child_process')
  const text = await new Promise<string>((resolve, reject) => {
    execFile(plan.command, plan.args, { timeout: 20_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout || ''))
    })
  })
  return parseJson(text.trim())
}

async function loadChromium() {
  try {
    const specifier = ['playwright', 'core'].join('-')
    const playwright = await import(specifier) as { chromium: { launch: (options: object) => Promise<any> } }
    return playwright.chromium
  } catch {
    return undefined
  }
}

async function fetchKickChannelPayloadsWithBrowser(slugs: string[]): Promise<Map<string, any>> {
  const found = new Map<string, any>()
  const executablePath = browserPath()
  const chromium = await loadChromium()
  if (!executablePath || !chromium || !slugs.length) return found
  let browser: any
  try {
    browser = await chromium.launch({ headless: true, executablePath })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: BROWSER_HEADERS['User-Agent'] })
    await page.goto(`https://kick.com/${encodeURIComponent(slugs[0])}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const payloads = await page.evaluate(async (channelSlugs: string[]) => {
      const out: Record<string, unknown> = {}
      for (const channelSlug of channelSlugs) {
        const response = await fetch(`/api/v2/channels/${encodeURIComponent(channelSlug)}`, { headers: { Accept: 'application/json' } })
        if (response.ok) out[channelSlug] = await response.json()
      }
      return out
    }, slugs)
    for (const [slug, payload] of Object.entries(payloads || {})) found.set(slug, payload)
  } catch (error) {
    console.error('Kick profile lookup:', error instanceof Error ? error.message : error)
  } finally {
    await browser?.close()
  }
  return found
}

export async function lookupKickProfilePics(slugs: string[]): Promise<Map<string, string>> {
  const pics = new Map<string, string>()
  const missing: string[] = []
  for (const slug of slugs) {
    const key = slug.trim().toLowerCase()
    if (!key) continue
    const cached = kickProfilePicCache.get(key)
    if (cached) {
      pics.set(key, cached)
      continue
    }
    try {
      const response = await kickPageFetch(`https://kick.com/api/v2/channels/${encodeURIComponent(key)}`, {
        headers: { ...BROWSER_HEADERS, Referer: `https://kick.com/${encodeURIComponent(key)}` },
      })
      if (response.ok) {
        const pic = kickProfilePicFromChannel(await response.json())
        if (pic) {
          pics.set(key, pic)
          kickProfilePicCache.set(key, pic)
          continue
        }
      }
    } catch { /* Cloudflare often blocks Node fetch */ }
    try {
      const payload = await fetchKickChannelPayloadWindows(key)
      const pic = kickProfilePicFromChannel(payload)
      if (pic) {
        pics.set(key, pic)
        kickProfilePicCache.set(key, pic)
        continue
      }
    } catch { /* powershell missing or blocked */ }
    missing.push(key)
  }
  if (!missing.length) return pics
  const fromBrowser = await fetchKickChannelPayloadsWithBrowser(missing)
  for (const [slug, payload] of fromBrowser) {
    const pic = kickProfilePicFromChannel(payload)
    if (pic) {
      pics.set(slug.toLowerCase(), pic)
      rememberKickProfilePic(slug, payload)
    }
  }
  return pics
}

async function resolveChatroomIdWithBrowser(slug: string): Promise<number | undefined> {
  const executablePath = browserPath()
  const chromium = await loadChromium()
  if (!executablePath || !chromium) return undefined
  let browser: any
  try {
    browser = await chromium.launch({ headless: true, executablePath })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: BROWSER_HEADERS['User-Agent'] })
    await page.goto(`https://kick.com/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const payload = await page.evaluate(async (channelSlug: string) => {
      const response = await fetch(`/api/v2/channels/${encodeURIComponent(channelSlug)}`, { headers: { Accept: 'application/json' } })
      return response.ok ? await response.json() : null
    }, slug)
    if (payload) rememberKickProfilePic(slug, payload)
    return chatroomIdFrom(payload)
  } catch (error) {
    console.error('Kick chatroom lookup:', error instanceof Error ? error.message : error)
    return undefined
  } finally {
    await browser?.close()
  }
}

/** Pick the first image URL found anywhere in the nested sender/identity payload, to survive Kick's ever-changing shape. */
function firstHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const text = value.trim()
      if (/^https?:\/\//i.test(text) || text.startsWith('//')) return text
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const nested = firstHttpUrl(record.url, record.src, record.profile_picture, record.profile_pic, record.profilepic, record.profilePicture, record.avatar, record.profile_thumb)
      if (nested) return nested
    }
  }
}

export function kickAvatarFromSender(sender: any): string | undefined {
  if (!sender) return
  return firstHttpUrl(
    sender.profile_picture,
    sender.profile_pic,
    sender.profilepic,
    sender.profilePicture,
    sender.avatar,
    sender.profile_thumb,
    sender.identity,
    sender.user,
  )
}

export function kickProfilePicFromChannel(payload: any): string | undefined {
  return kickAvatarFromSender(payload?.user || payload?.channel?.user || payload)
}

/** Convert a raw Pusher chat payload into a dock message. Field names come from Kick's site payload, not the official API. */
export function parseKickChatMessage(data: any): KickChatMessage | undefined {
  const text = String(data?.content || '').trim()
  const emotes = data?.emotes || data?.metadata?.emotes
  if (!text && !emotes?.length) return
  return {
    id: data?.id ? String(data.id) : undefined,
    user: String(data?.sender?.username || data?.sender?.slug || 'Kick user'),
    text: text || ' ',
    userId: data?.sender?.id != null ? String(data.sender.id) : undefined,
    slug: data?.sender?.slug || data?.sender?.channel_slug ? String(data.sender.slug || data.sender.channel_slug) : undefined,
    color: data?.sender?.identity?.color,
    avatar: kickAvatarFromSender(data?.sender),
    badges: data?.sender?.identity?.badges,
    emotes,
  }
}

export function pickName(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() && !/^(null|undefined)$/i.test(value.trim())) return value.trim()
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const nested = pickName(record.username, record.slug, record.name, record.user)
      if (nested) return nested
    }
  }
}

/** Kick's URL slug (lowercase, dash-separated), never the display username with spaces. */
function kickSlugFrom(data: any): string | undefined {
  const slug = pickName(data?.slug, data?.channel_slug, data?.user?.slug, data?.sender?.slug)
  return slug ? slug.toLowerCase() : undefined
}

/** Map Kick Pusher event names onto delete / ban / unban. Ignore normal chat lines. */
export function kickEventToModeration(eventName: string, data: any): KickModeration | undefined {
  // Pusher event names arrive escaped, e.g. App\\Events\\MessageDeletedEvent
  const event = eventName.replace(/\\/g, '')
  // Normal chat messages go through parseKickChatMessage instead
  if (/ChatMessage/i.test(event)) return
  // Message removed (one id)
  if (/MessageDeleted|ChatMessageDeleted/i.test(event)) {
    const messageId = data?.message?.id ?? data?.message_id ?? data?.id
    if (messageId == null || messageId === '') return
    return { action: 'delete', messageId: String(messageId) }
  }
  // Timeout ended or ban lifted
  if (/UserUnbanned|BannedUserDeleted|UserUnbannedEvent/i.test(event)) {
    const userId = data?.user?.id ?? data?.banned_user?.id ?? data?.user_id
    const user = pickName(data?.user, data?.banned_user, data?.username)
    const slug = kickSlugFrom(data)
    if (userId == null && !user && !slug) return
    return { action: 'unban', userId: userId != null ? String(userId) : undefined, user, slug }
  }
  // Ban or timeout (Kick sends the same payload shape for both)
  if (/UserBanned|BannedUserAdded|UserTimeout/i.test(event)) {
    const userId = data?.user?.id ?? data?.banned_user?.id ?? data?.user_id
    const user = pickName(data?.user, data?.banned_user, data?.username)
    const slug = kickSlugFrom(data)
    if (userId == null && !user && !slug) return
    return { action: 'ban', userId: userId != null ? String(userId) : undefined, user, slug }
  }
}

/** Map Kick Pusher event names onto activity-dock rows (follows, subs, gifts, cheers, raids). Undefined when the event is not an activity. */
export function kickEventToActivity(eventName: string, data: any): KickActivity | undefined {
  // Pusher event names arrive escaped, e.g. App\\Events\\FollowEvent
  const event = eventName.replace(/\\/g, '')
  // Follower list refreshes are not a single follow; require a concrete user
  if (/FollowersUpdated/i.test(event) && !pickName(data?.username, data?.user, data?.follower)) return
  if (/FollowEvent|FollowersUpdated/i.test(event)) {
    const user = pickName(data?.username, data?.user, data?.follower, data?.follower_username)
    if (!user) return
    return { id: data?.id ? String(data.id) : undefined, kind: 'follow', user, slug: kickSlugFrom(data) }
  }
  if (/SubscriptionEvent/i.test(event) && !/Gifted|LuckyUsers/i.test(event)) {
    const user = pickName(data?.username, data?.user, data?.subscriber)
    if (!user) return
    const months = Number(data?.months || data?.duration)
    return { id: data?.id ? String(data.id) : undefined, kind: 'subscription', user, slug: kickSlugFrom(data), months: Number.isFinite(months) && months > 0 ? months : undefined }
  }
  if (/GiftedSubscriptions/i.test(event)) {
    const user = pickName(data?.gifter_username, data?.gifter, data?.username, data?.user)
    if (!user) return
    const gifted = Array.isArray(data?.gifted_usernames) ? data.gifted_usernames.length : Number(data?.giftedCount || data?.gifted_count)
    return {
      id: data?.id ? String(data.id) : undefined,
        kind: 'gift',
        user,
        slug: kickSlugFrom(data),
        amount: Number.isFinite(gifted) && gifted > 0 ? `${gifted} gift${gifted === 1 ? '' : 's'}` : undefined,
    }
  }
  if (/KicksGifted/i.test(event)) {
    const user = pickName(data?.username, data?.sender, data?.user, data?.gifter)
    if (!user) return
    const amount = data?.amount ?? data?.gifted_amount ?? data?.kicks
    return { id: data?.id ? String(data.id) : undefined, kind: 'cheer', user, slug: kickSlugFrom(data), amount: amount != null ? `${amount} Kicks` : undefined, message: String(data?.message || '').trim() || undefined }
  }
  if (/StreamHost/i.test(event)) {
    const user = pickName(data?.user, data?.username, data?.host, data?.message?.user)
    if (!user) return
    const viewers = Number(data?.message?.numberOfViewers ?? data?.numberOfViewers ?? data?.viewers)
    return { id: data?.id || data?.message?.id ? String(data?.id || data.message.id) : undefined, kind: 'raid', user, slug: kickSlugFrom(data), viewers: Number.isFinite(viewers) ? viewers : undefined }
  }
}

export class KickChat {
  private ws?: WebSocket
  private pingTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private connecting?: Promise<void>
  private chatroomId?: number
  private slug?: string
  private onMessage?: (message: KickChatMessage) => void
  private onActivity?: (event: KickActivity) => void
  private onModeration?: (event: KickModeration) => void
  private closed = true
  private attempt = 0
  private hasFailed = false
  private provider?: 'centrifugo' | 'pusher'
  private token?: string

  get currentChatroomId() { return this.chatroomId }
  get connected() { return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed) }
  get failed() { return this.hasFailed }

  async start(slug: string, onMessage: (message: KickChatMessage) => void, cachedChatroomId?: number, onActivity?: (event: KickActivity) => void, onModeration?: (event: KickModeration) => void) {
    this.onMessage = onMessage
    this.onActivity = onActivity
    this.onModeration = onModeration
    this.closed = false
    if (this.slug !== slug) {
      this.slug = slug
      this.chatroomId = cachedChatroomId
      this.attempt = 0
      this.hasFailed = false
      await this.disconnectSocket()
    } else if (cachedChatroomId && !this.chatroomId) {
      this.chatroomId = cachedChatroomId
    }
    if (kickSocketShouldStay(this.ws?.readyState)) return
    await this.connect()
  }

  async stop() {
    this.closed = true
    this.slug = undefined
    this.chatroomId = undefined
    this.attempt = 0
    this.hasFailed = false
    this.onMessage = undefined
    this.onActivity = undefined
    this.onModeration = undefined
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    await this.disconnectSocket()
  }

  private async connect() {
    if (this.closed || !this.slug) return
    if (this.connecting) return this.connecting
    this.connecting = this.openSocket().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async openSocket() {
    try {
      await this.openSocketNow()
    } catch (error) {
      if (this.closed) return
      console.error('Kick chat:', error instanceof Error ? error.message : error)
      this.scheduleReconnect()
    }
  }

  private async openSocketNow() {
    if (kickSocketShouldStay(this.ws?.readyState)) return
    if (!this.chatroomId) this.chatroomId = await resolveKickChatroomId(this.slug!, this.chatroomId)
    if (kickSocketShouldStay(this.ws?.readyState)) return
    await this.disconnectSocket()
    const plan = await this.realtimePlan()
    this.provider = plan.provider
    this.token = plan.token
    console.log(`Kick chat connecting (${this.slug})`)
    const socket = new WebSocket(plan.url, { headers: { Origin: 'https://kick.com', 'User-Agent': BROWSER_HEADERS['User-Agent'] } })
    this.ws = socket
    socket.on('open', () => {
      if (this.provider !== 'centrifugo' || !this.token || this.ws !== socket) return
      socket.send(JSON.stringify({ id: 1, connect: { token: this.token } }))
    })
    socket.on('message', (data) => this.handle(String(data)))
    socket.on('close', () => {
      if (this.ws !== socket) return
      this.ws = undefined
      this.scheduleReconnect()
    })
    socket.on('error', (error) => {
      if (!/closed before the connection was established/i.test(error.message)) console.error('Kick chat:', error.message)
      socket.close()
    })
  }

  private async realtimePlan() {
    const id = this.chatroomId
    if (!id) throw new Error('Kick chatroom id is missing')
    const headers = { ...BROWSER_HEADERS, 'Content-Type': 'application/json', Origin: 'https://kick.com', 'x-app-platform': 'web' }
    const connection = await kickPageFetch(`https://web.kick.com/api/v1/realtime/channels/${id}/chat/connection`, {
      method: 'POST',
      headers,
      body: JSON.stringify(kickRealtimeRequest()),
    })
    if (!connection.ok) throw new Error(`Kick realtime ${connection.status}`)
    const plan = kickRealtimePlan(await connection.json())
    if (!plan) throw new Error('Kick realtime returned no connection')
    if (plan.provider === 'pusher') return { ...plan, token: undefined }
    const auth = await kickPageFetch('https://web.kick.com/api/v1/realtime/auth/connection', {
      method: 'POST',
      headers,
      body: JSON.stringify({ client_id: KICK_CLIENT_ID }),
    })
    if (!auth.ok) throw new Error(`Kick realtime token ${auth.status}`)
    const token = kickRealtimeToken(await auth.json())
    if (!token) throw new Error('Kick realtime returned no token')
    return { ...plan, token }
  }

  private subscribeCentrifugo() {
    const id = this.chatroomId
    if (!id || this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ id: 2, subscribe: { channel: `chatrooms.${id}.v2` } }))
    this.ws.send(JSON.stringify({ id: 3, subscribe: { channel: `chatroom_${id}` } }))
  }

  /** Handle Pusher or Kick's Centrifugo realtime frames. */
  private handle(raw: string) {
    if (this.provider === 'centrifugo') {
      const live = readKickCentrifugoFrame(raw)
      if (!live) return
      if (live.kind === 'ping') { this.ws?.send('{}'); return }
      if (live.kind === 'error') { console.error('Kick chat:', live.message); this.ws?.close(); return }
      if (live.kind === 'connected') { this.subscribeCentrifugo(); return }
      if (live.kind === 'subscribed') {
        if (live.id === 2) { this.attempt = 0; this.hasFailed = false; console.log(`Kick chat connected (${this.slug})`) }
        return
      }
      this.dispatch(readKickSocketFrame(live.frame))
      return
    }
    const frame = readKickSocketFrame(raw)
    if (frame?.handshake === 'error') { console.error('Kick chat:', frame.error); this.ws?.close(); return }
    this.dispatch(frame)
  }

  private dispatch(frame: KickSocketFrame | undefined) {
    if (!frame) return
    if (frame.handshake === 'connect') {
      this.ws?.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` } }))
      this.ws?.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatroom_${this.chatroomId}` } }))
      this.startPing()
      return
    }
    if (frame.handshake === 'ping') {
      this.ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }))
      return
    }
    if (frame.handshake === 'subscribed') {
      this.attempt = 0
      this.hasFailed = false
      if (String(frame.channel || '').includes('.v2')) console.log(`Kick chat connected (${this.slug})`)
      return
    }
    if (frame.message) this.onMessage?.(frame.message)
    if (frame.moderation) this.onModeration?.(frame.moderation)
    if (frame.activity) this.onActivity?.(frame.activity)
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }))
    }, 60_000)
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return
    this.hasFailed = true
    const delay = Math.min(15_000, 1_000 * 2 ** this.attempt++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, delay)
  }

  private async disconnectSocket() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = undefined
    const socket = this.ws
    this.ws = undefined
    dropSocket(socket)
  }
}
