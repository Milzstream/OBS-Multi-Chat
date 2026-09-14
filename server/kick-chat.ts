import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

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
export type KickActivity = { id?: string; kind: 'follow' | 'subscription' | 'gift' | 'cheer' | 'raid'; user: string; userId?: string; slug?: string; amount?: string; months?: number; viewers?: number; message?: string }
export type KickModeration = { action: 'delete' | 'ban' | 'unban'; messageId?: string; userId?: string; user?: string; slug?: string }

/** Kick's public Pusher app, used by the site for all real-time chat events. */
const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false'
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

/** Resolve a channel's public chatroom id, trying plain Node fetch (v2 then v1 endpoints) before falling back to a real browser when Cloudflare blocks it. */
export async function resolveKickChatroomId(slug: string, cached?: number): Promise<number> {
  if (cached && cached > 0) return cached
  for (const url of [
    `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(slug)}`,
  ]) {
    try {
      const response = await fetch(url, { headers: BROWSER_HEADERS })
      if (!response.ok) continue
      const payload = await response.json()
      rememberKickProfilePic(slug, payload)
      const id = chatroomIdFrom(payload)
      if (id) return id
    } catch { /* Cloudflare often blocks Node fetch; fall through */ }
  }
  const fromBrowser = await resolveChatroomIdWithBrowser(slug)
  if (fromBrowser) return fromBrowser
  throw new Error(`Could not resolve Kick chatroom id for ${slug}`)
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
      const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(key)}`, {
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

  get currentChatroomId() { return this.chatroomId }
  get connected() { return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed) }

  async start(slug: string, onMessage: (message: KickChatMessage) => void, cachedChatroomId?: number, onActivity?: (event: KickActivity) => void, onModeration?: (event: KickModeration) => void) {
    this.onMessage = onMessage
    this.onActivity = onActivity
    this.onModeration = onModeration
    this.closed = false
    if (this.slug !== slug) {
      this.slug = slug
      this.chatroomId = cachedChatroomId
      await this.disconnectSocket()
    } else if (cachedChatroomId && !this.chatroomId) {
      this.chatroomId = cachedChatroomId
    }
    if (this.ws?.readyState === WebSocket.OPEN) return
    await this.connect()
  }

  async stop() {
    this.closed = true
    this.slug = undefined
    this.chatroomId = undefined
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
    if (!this.chatroomId) this.chatroomId = await resolveKickChatroomId(this.slug!, this.chatroomId)
    await this.disconnectSocket()
    console.log(`Kick chat connecting (${this.slug})`)
    const socket = new WebSocket(PUSHER_URL)
    this.ws = socket
    socket.on('open', () => { this.attempt = 0 })
    socket.on('message', (data) => this.handle(String(data)))
    socket.on('close', () => {
      if (this.ws !== socket) return
      this.ws = undefined
      this.scheduleReconnect()
    })
    socket.on('error', (error) => { console.error('Kick chat:', error.message); socket.close() })
  }

  /** Handle the raw Pusher protocol: connect/subscribe handshake, pings, then chat/activity/moderation events. */
  private handle(raw: string) {
    let payload: any
    try { payload = JSON.parse(raw) } catch { return }
    const event = String(payload?.event || '')
    // Pusher handshake: first subscribe, then keep the socket alive with pings
    if (event === 'pusher:connection_established') {
      // Chatroom id resolves to two channels depending on client version; subscribe to both
      this.ws?.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` } }))
      this.ws?.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatroom_${this.chatroomId}` } }))
      this.startPing()
      return
    }
    if (event === 'pusher:ping') {
      this.ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }))
      return
    }
    if (event === 'pusher_internal:subscription_succeeded') {
      if (String(payload?.channel || '').includes('.v2')) console.log(`Kick chat connected (${this.slug})`)
      return
    }
    const data = parseJson(payload.data)
    if (/ChatMessage/i.test(event)) {
      const message = parseKickChatMessage(data)
      if (message) this.onMessage?.(message)
      return
    }
    const moderation = kickEventToModeration(event, data)
    if (moderation) this.onModeration?.(moderation)
    const activity = kickEventToActivity(event, data)
    if (activity) this.onActivity?.(activity)
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }))
    }, 60_000)
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return
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
    if (!socket) return
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.once('error', () => resolve())
      try { socket.close() } catch { resolve() }
      setTimeout(resolve, 500)
    })
  }
}
