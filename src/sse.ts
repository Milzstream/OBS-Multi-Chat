export const SSE_STALL_MS = 20_000
export const SSE_RELOAD_AFTER = 5

export type SseFrameType = 'snapshot' | 'chat' | 'activity' | 'presence' | 'settings' | 'ping'

export function sseSeqIsGap(lastSeq: number | null, incoming: number, type: string) {
  if (type === 'snapshot' || type === 'ping') return false
  if (lastSeq == null) return true
  return incoming !== lastSeq + 1
}

export function subscribeDockSse(handlers: {
  onSnapshot: (data: Record<string, unknown>) => void
  onChat?: (data: Record<string, unknown>) => void
  onActivity?: (data: Record<string, unknown>) => void
  onPresence?: (data: Record<string, unknown>) => void
  onSettings?: (data: Record<string, unknown>) => void
  onStatus: (online: boolean) => void
}) {
  let source: EventSource | null = null
  let lastSeq: number | null = null
  let lastEventAt = Date.now()
  let failures = 0
  let closed = false
  let reconnectTimer: number | undefined
  let connecting = false

  const applyFrame = (type: SseFrameType, data: Record<string, unknown>) => {
    lastEventAt = Date.now()
    if (type === 'ping') return
    const seq = Number(data.seq)
    if (!Number.isFinite(seq)) return
    if (sseSeqIsGap(lastSeq, seq, type)) {
      void resync()
      return
    }
    lastSeq = seq
    failures = 0
    handlers.onStatus(true)
    if (type === 'snapshot') handlers.onSnapshot(data)
    else if (type === 'chat') handlers.onChat?.(data)
    else if (type === 'activity') handlers.onActivity?.(data)
    else if (type === 'presence') handlers.onPresence?.(data)
    else if (type === 'settings') handlers.onSettings?.(data)
  }

  const resync = async () => {
    try {
      const response = await fetch('/api/state')
      if (!response.ok) throw new Error('state')
      const remote = await response.json() as Record<string, unknown>
      const seq = Number(remote.seq)
      if (Number.isFinite(seq)) lastSeq = seq
      handlers.onSnapshot(remote)
      handlers.onStatus(true)
      failures = 0
    } catch {
      handlers.onStatus(false)
    }
  }

  const connect = () => {
    if (closed || connecting) return
    connecting = true
    source?.close()
    const next = new EventSource('/events')
    source = next
    const types: SseFrameType[] = ['snapshot', 'chat', 'activity', 'presence', 'settings', 'ping']
    for (const type of types) {
      next.addEventListener(type, (event) => {
        connecting = false
        try { applyFrame(type, JSON.parse((event as MessageEvent).data) as Record<string, unknown>) } catch { /* ignore bad frames */ }
      })
    }
    next.onerror = () => {
      handlers.onStatus(false)
      if (closed) return
      if (next.readyState === EventSource.CLOSED) scheduleReconnect()
      else void resync()
    }
  }

  const scheduleReconnect = () => {
    if (closed || reconnectTimer != null) return
    lastEventAt = Date.now()
    failures += 1
    if (failures >= SSE_RELOAD_AFTER) {
      window.location.reload()
      return
    }
    const delay = Math.min(8_000, 500 * 2 ** failures)
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      connecting = false
      void resync()
      connect()
    }, delay)
  }

  const stallTimer = window.setInterval(() => {
    if (closed) return
    if (Date.now() - lastEventAt > SSE_STALL_MS) scheduleReconnect()
  }, 5_000)

  void resync()
  connect()

  return () => {
    closed = true
    connecting = false
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
    window.clearInterval(stallTimer)
    source?.close()
    source = null
  }
}
