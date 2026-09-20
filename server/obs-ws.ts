import crypto from 'node:crypto'
import WebSocket from 'ws'

/**
 * Minimal obs-websocket (protocol 5) client: Identify, watch stream stop,
 * reconnect. No scene/source control. Used so YouTube lives can be ended when
 * OBS stops streaming.
 */

export const OBS_EVENT_OUTPUTS = 1 << 6

export function obsAuthToken(password: string, salt: string, challenge: string) {
  const secret = crypto.createHash('sha256').update(String(password) + salt).digest('base64')
  return crypto.createHash('sha256').update(secret + challenge).digest('base64')
}

export function obsStreamStopped(eventType: string, eventData?: { outputActive?: boolean }) {
  if (eventType === 'StreamStopped') return true
  return eventType === 'StreamStateChanged' && eventData?.outputActive === false
}

export function obsWebSocketUrl(host: string, port: number) {
  const hostname = String(host || '127.0.0.1').trim() || '127.0.0.1'
  const n = Math.floor(Number(port) || 4455)
  return `ws://${hostname}:${n > 0 && n < 65536 ? n : 4455}`
}

export function createObsWebSocket(options: {
  getConfig: () => { host: string; port: number; password: string }
  onStatus: (connected: boolean) => void
  onStreamStopped: () => void
}) {
  let socket: WebSocket | undefined
  let closed = true
  let reconnectTimer: NodeJS.Timeout | undefined
  let identified = false

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, 4000)
  }

  function connect() {
    if (closed) return
    const { host, port, password } = options.getConfig()
    const url = obsWebSocketUrl(host, port)
    try { socket?.close() } catch { /* ignore */ }
    identified = false
    options.onStatus(false)
    let next: WebSocket
    try {
      next = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    socket = next
    next.on('message', (raw) => {
      let frame: { op?: number; d?: Record<string, unknown> }
      try { frame = JSON.parse(String(raw)) as { op?: number; d?: Record<string, unknown> } } catch { return }
      if (frame.op === 0) {
        const auth = frame.d?.authentication as { challenge?: string; salt?: string } | undefined
        const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: OBS_EVENT_OUTPUTS }
        if (auth?.challenge && auth?.salt) identify.authentication = obsAuthToken(password, auth.salt, auth.challenge)
        next.send(JSON.stringify({ op: 1, d: identify }))
        return
      }
      if (frame.op === 2) {
        identified = true
        options.onStatus(true)
        return
      }
      if (frame.op === 5) {
        const eventType = String(frame.d?.eventType || '')
        const eventData = (frame.d?.eventData || {}) as { outputActive?: boolean }
        if (obsStreamStopped(eventType, eventData)) options.onStreamStopped()
      }
    })
    next.on('close', () => {
      if (socket !== next) return
      identified = false
      options.onStatus(false)
      scheduleReconnect()
    })
    next.on('error', () => { /* close handler reconnects */ })
  }

  return {
    get connected() { return Boolean(socket && socket.readyState === WebSocket.OPEN && identified) },
    start() {
      closed = false
      connect()
    },
    stop() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      try { socket?.close() } catch { /* ignore */ }
      socket = undefined
      identified = false
      options.onStatus(false)
    },
    reconnect() {
      if (closed) return
      try { socket?.close() } catch { /* ignore */ }
    },
  }
}
