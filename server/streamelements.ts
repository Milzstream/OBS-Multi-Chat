import crypto from 'node:crypto'
import WebSocket from 'ws'
import { parseActivityTime, type ActivityEvent, type ActivityKind, type ActivityPlatform } from './activity.js'

export type StreamElementsChannel = { channelId: string; handle: string; jwt: string; provider?: string }

const ASTRO_URL = 'wss://astro.streamelements.com'
const API_BASE = 'https://api.streamelements.com/kappa/v2'
const SE_ONLY_TYPES = new Set(['tip', 'merch', 'purchase', 'redemption', 'charitycampaigndonation', 'giveaway', 'elixir', 'stars'])

function decodeJwt(jwt: string) {
  const parts = jwt.split('.')
  if (parts.length < 2) return
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - parts[1].length % 4) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return
  }
}

function formatAmount(amount: unknown, currency?: unknown) {
  const value = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(value)) return String(amount || '')
  const code = String(currency || 'USD').toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(value)
  } catch {
    return `${value} ${code}`.trim()
  }
}

function sourceFromProvider(provider: string): ActivityPlatform {
  const value = provider.toLowerCase()
  if (value === 'twitch') return 'Twitch'
  if (value === 'kick') return 'Kick'
  if (value === 'youtube') return 'YouTube'
  return 'StreamElements'
}

function platformFromProvider(provider: string, type: string): ActivityPlatform {
  if (SE_ONLY_TYPES.has(type)) return 'StreamElements'
  return sourceFromProvider(provider)
}

function kindFromSe(type: string, platform: ActivityPlatform): ActivityKind | undefined {
  if (type === 'follow' || type === 'follower' || type === 'fan') return 'follow'
  if (type === 'subscriber') return platform === 'YouTube' ? 'follow' : 'subscription'
  if (type === 'communitygiftpurchase') return 'gift'
  if (type === 'cheer' || type === 'cheerpurchase') return 'cheer'
  if (type === 'raid' || type === 'host') return 'raid'
  if (type === 'sponsor' || type === 'supporter') return 'membership'
  if (type === 'superchat') return 'superchat'
  if (type === 'tip' || type === 'charitycampaigndonation') return 'donation'
  if (type === 'merch' || type === 'purchase' || type === 'redemption') return 'merch'
  return
}

function pickUser(data: any) {
  return String(data?.displayName || data?.username || data?.name || data?.user?.username || data?.donation?.user?.username || 'Anonymous').replace(/^@+/, '') || 'Anonymous'
}

export function activityFromStreamElements(payload: any): ActivityEvent | undefined {
  const root = payload?.topic || payload?.type === 'message' ? (payload.data || payload) : payload
  const inner = root?.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : root
  const type = String(root?.type || inner?.type || (payload?.topic === 'channel.tips' ? 'tip' : '')).toLowerCase()
  if (!type || type === 'event' || type === 'message' || type.startsWith('hypetrain') || type === 'channelpointsredemption') return
  const provider = String(root?.provider || inner?.provider || (type === 'tip' || type === 'merch' ? 'StreamElements' : ''))
  const source = sourceFromProvider(provider)
  const platform = platformFromProvider(provider, type)
  const kind = kindFromSe(type, source)
  if (!kind) return
  const amountValue = inner?.amount ?? inner?.quantity ?? root?.donation?.amount ?? inner?.donation?.amount
  const currency = inner?.currency || root?.donation?.currency || inner?.donation?.currency
  const gifted = Number(inner?.gifted || inner?.amount || inner?.quantity)
  const months = Number(inner?.months || inner?.amount)
  const viewers = Number(inner?.viewers || inner?.raiders)
  const item = inner?.item?.name || inner?.item || inner?.product
  let amount: string | undefined
  if (kind === 'donation' || kind === 'superchat') amount = formatAmount(amountValue, currency) || undefined
  else if (kind === 'cheer' && amountValue != null) amount = `${amountValue} Bits`
  else if (kind === 'gift' && Number.isFinite(gifted) && gifted > 0) amount = `${gifted} gift${gifted === 1 ? '' : 's'}`
  else if (kind === 'merch') amount = [item, amountValue != null ? formatAmount(amountValue, currency) : ''].filter(Boolean).join(' · ') || undefined
  const user = pickUser(inner?.donation?.user ? { ...inner, ...inner.donation.user } : inner)
  const userId = String(inner?.providerId || inner?.userId || inner?.channelId || '').trim() || undefined
  return {
    id: String(root?._id || root?.activityId || inner?._id || payload?.id || crypto.randomUUID()),
    platform,
    source,
    kind,
    user,
    userId,
    amount,
    months: kind === 'subscription' || kind === 'membership' ? (Number.isFinite(months) && months > 0 ? months : undefined) : undefined,
    viewers: kind === 'raid' && Number.isFinite(viewers) ? viewers : undefined,
    message: String(inner?.message || inner?.comment || root?.donation?.message || '').trim() || undefined,
    time: parseActivityTime(root?.createdAt || inner?.createdAt || payload?.ts),
  }
}

export async function hydrateStreamElements(jwt: string): Promise<StreamElementsChannel> {
  const headers = { Authorization: `Bearer ${jwt}`, Accept: 'application/json' }
  for (const path of ['/channels/me', '/users/current', '/users/me']) {
    try {
      const response = await fetch(`${API_BASE}${path}`, { headers })
      if (!response.ok) continue
      const json = await response.json() as any
      const channel = json?.channel || json?.channels?.[0] || json
      const channelId = String(channel?._id || channel?.id || json?._id || json?.id || '')
      const handle = String(channel?.displayName || channel?.username || json?.displayName || json?.username || '')
      const provider = String(channel?.provider || json?.provider || '')
      if (channelId) return { jwt, channelId, handle: handle || 'StreamElements', provider: provider || undefined }
    } catch { /* try next */ }
  }
  const payload = decodeJwt(jwt)
  const channelId = String(payload?.channel_id || payload?.channelId || payload?.id || '')
  const handle = String(payload?.channel || payload?.username || payload?.name || 'StreamElements')
  if (!channelId) throw new Error('StreamElements JWT did not include a channel id. Copy the token from Dashboard → account → channels.')
  return { jwt, channelId, handle, provider: payload?.provider ? String(payload.provider) : undefined }
}

export async function fetchRecentActivities(channel: StreamElementsChannel): Promise<ActivityEvent[]> {
  const headers = { Authorization: `Bearer ${channel.jwt}`, Accept: 'application/json' }
  const after = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const urls = [
    `${API_BASE}/activities/${encodeURIComponent(channel.channelId)}?limit=50&after=${encodeURIComponent(after)}`,
    `${API_BASE}/activities/${encodeURIComponent(channel.channelId)}?limit=50`,
    `${API_BASE}/tips/${encodeURIComponent(channel.channelId)}?limit=25`,
  ]
  const events: ActivityEvent[] = []
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers })
      if (!response.ok) continue
      const json = await response.json() as any
      const rows = Array.isArray(json) ? json : Array.isArray(json?.docs) ? json.docs : Array.isArray(json?.data) ? json.data : []
      for (const row of rows) {
        const event = activityFromStreamElements(url.includes('/tips/') ? { type: 'tip', provider: 'StreamElements', data: row, _id: row?._id, createdAt: row?.createdAt } : row)
        if (event) events.push(event)
      }
      if (events.length) break
    } catch (error) {
      console.error('StreamElements activity backfill:', error instanceof Error ? error.message : error)
    }
  }
  return events
}

export class StreamElementsClient {
  private ws?: WebSocket
  private pingTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private connecting?: Promise<void>
  private channels: StreamElementsChannel[] = []
  private onActivity?: (event: ActivityEvent) => void
  private onStatus?: (message?: string) => void
  private closed = true
  private attempt = 0

  get connected() { return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed) }

  async start(channels: StreamElementsChannel[], onActivity: (event: ActivityEvent) => void, onStatus?: (message?: string) => void) {
    this.channels = channels
    this.onActivity = onActivity
    this.onStatus = onStatus
    this.closed = false
    if (this.ws?.readyState === WebSocket.OPEN) return
    await this.connect()
  }

  async stop() {
    this.closed = true
    this.channels = []
    this.onActivity = undefined
    this.onStatus = undefined
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    await this.disconnectSocket()
  }

  private async connect() {
    if (this.closed || !this.channels.length) return
    if (this.connecting) return this.connecting
    this.connecting = this.openSocket().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async openSocket() {
    await this.disconnectSocket()
    const socket = new WebSocket(ASTRO_URL)
    this.ws = socket
    socket.on('open', () => { this.attempt = 0 })
    socket.on('message', (data) => this.handle(String(data)))
    socket.on('close', () => {
      if (this.ws !== socket) return
      this.ws = undefined
      this.scheduleReconnect()
    })
    socket.on('error', (error) => { console.error('StreamElements:', error.message); socket.close() })
  }

  private handle(raw: string) {
    let payload: any
    try { payload = JSON.parse(raw) } catch { return }
    const type = String(payload?.type || '')
    if (type === 'welcome') {
      this.subscribe()
      this.startPing()
      return
    }
    if (type === 'response') {
      if (payload.error) {
        const message = String(payload.data?.message || payload.error)
        console.error('StreamElements subscribe:', message)
        this.onStatus?.(`StreamElements: ${message}`)
      } else {
        this.onStatus?.()
      }
      return
    }
    if (type === 'message' && (payload.topic === 'channel.activities' || payload.topic === 'channel.tips')) {
      const event = activityFromStreamElements(payload.topic === 'channel.tips'
        ? { type: 'tip', provider: 'StreamElements', data: payload.data, _id: payload.data?._id, createdAt: payload.data?.createdAt, id: payload.id, ts: payload.ts }
        : payload)
      if (event) this.onActivity?.(event)
      return
    }
    if (type === 'reconnect' && payload.data?.reconnect_token) {
      this.openReconnect(String(payload.data.reconnect_token))
    }
  }

  private subscribe() {
    if (!this.channels.length || this.ws?.readyState !== WebSocket.OPEN) return
    let delay = 0
    for (const channel of this.channels) {
      for (const topic of ['channel.activities', 'channel.tips']) {
        const payload = JSON.stringify({
          type: 'subscribe',
          nonce: crypto.randomUUID(),
          data: {
            topic,
            room: channel.channelId,
            token: channel.jwt,
            token_type: 'jwt',
          },
        })
        const wait = delay
        setTimeout(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload) }, wait)
        delay += 120
      }
    }
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping()
    }, 25_000)
  }

  private openReconnect(token: string) {
    const socket = new WebSocket(`${ASTRO_URL}/?reconnect_token=${encodeURIComponent(token)}`)
    const previous = this.ws
    this.ws = socket
    socket.on('message', (data) => this.handle(String(data)))
    socket.on('close', () => {
      if (this.ws !== socket) return
      this.ws = undefined
      this.scheduleReconnect()
    })
    socket.on('error', () => socket.close())
    try { previous?.close() } catch { /* ignore */ }
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return
    const delay = Math.min(20_000, 1_000 * 2 ** this.attempt++)
    this.onStatus?.('StreamElements disconnected — retrying alerts')
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
