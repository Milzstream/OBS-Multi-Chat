import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

export type KickChatMessage = { id?: string; user: string; text: string; userId?: string; color?: string; avatar?: string; badges?: { type?: string; text?: string }[]; emotes?: any[] }

const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false'
const BROWSER_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
}

function browserPath() {
  const candidates = [
    process.env.KICK_BROWSER_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
}

function parseJson(value: unknown) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as any } catch { return undefined }
  }
  return value as any
}

function chatroomIdFrom(payload: any): number | undefined {
  const id = payload?.chatroom?.id ?? payload?.chatroom_id ?? payload?.data?.chatroom?.id
  const numeric = Number(id)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
}

export async function resolveKickChatroomId(slug: string, cached?: number): Promise<number> {
  if (cached && cached > 0) return cached
  for (const url of [
    `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(slug)}`,
  ]) {
    try {
      const response = await fetch(url, { headers: BROWSER_HEADERS })
      if (!response.ok) continue
      const id = chatroomIdFrom(await response.json())
      if (id) return id
    } catch { /* Cloudflare often blocks Node fetch; fall through */ }
  }
  const fromBrowser = await resolveChatroomIdWithBrowser(slug)
  if (fromBrowser) return fromBrowser
  throw new Error(`Could not resolve Kick chatroom id for ${slug}`)
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
    return chatroomIdFrom(payload)
  } catch (error) {
    console.error('Kick chatroom lookup:', error instanceof Error ? error.message : error)
    return undefined
  } finally {
    await browser?.close()
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
  private closed = true
  private attempt = 0

  get currentChatroomId() { return this.chatroomId }
  get connected() { return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed) }

  async start(slug: string, onMessage: (message: KickChatMessage) => void, cachedChatroomId?: number) {
    this.onMessage = onMessage
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
    console.log(`Kick chat connecting to chatroom ${this.chatroomId} (${this.slug})`)
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

  private handle(raw: string) {
    let payload: any
    try { payload = JSON.parse(raw) } catch { return }
    const event = String(payload?.event || '')
    if (event === 'pusher:connection_established') {
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
      console.log(`Kick chat subscribed: ${this.slug} (#${this.chatroomId})`)
      return
    }
    if (!/ChatMessage/i.test(event)) return
    const message = parseJson(payload.data)
    const text = String(message?.content || '').trim()
    const user = String(message?.sender?.username || message?.sender?.slug || 'Kick user')
    const emotes = message?.emotes || message?.metadata?.emotes
    if (!text && !emotes?.length) return
    this.onMessage?.({
      id: message?.id ? String(message.id) : undefined,
      user,
      text: text || ' ',
      userId: message?.sender?.id != null ? String(message.sender.id) : undefined,
      color: message?.sender?.identity?.color,
      avatar: message?.sender?.profile_picture || message?.sender?.profilepic || message?.sender?.avatar,
      badges: message?.sender?.identity?.badges,
      emotes,
    })
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
