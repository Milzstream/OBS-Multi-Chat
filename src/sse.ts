export const SSE_STALL_MS = 20_000
export const SSE_RELOAD_AFTER = 5

/**
 * The docks' SSE client: subscribes to Relay's `/events` stream, tracks the
 * frame-sequence cursor to detect dropped frames, and reconnects with
 * exponential backoff that hard-reloads the dock after repeated failures.
 */

export type SseFrameType = 'snapshot' | 'chat' | 'activity' | 'presence' | 'settings' | 'ping'

/**
 * A dropped frame means state was missed, so force a resync instead of
 * applying a frame that follows a gap. Snapshots and pings are never
 * sequence-gated.
 */
export function sseSeqIsGap(lastSeq: number | null, incoming: number, type: string) {
  if (type === 'snapshot' || type === 'ping') return false
  if (lastSeq == null) return true
  return incoming !== lastSeq + 1
}

/** `/api/state` at seq N already holds frames up to N, so one still in the pipe is not a gap. */
export function sseFrameIsCovered(lastSeq: number | null, incoming: number, type: string) {
  if (type === 'snapshot' || type === 'ping') return false
  return lastSeq != null && incoming <= lastSeq
}

/**
 * Turn the dock's rows plus one `chat` frame into the next rows. The server's
 * list can move ahead of its last frame, so `/api/state` may already hold what
 * a delta carries: an added or updated row that is present replaces in place.
 * `inSync` is false when the result cannot match the server's and needs a resync.
 */
export function applyChatFrame<T extends { id: string }>(previous: T[], frame: Record<string, unknown>): { messages: T[]; inSync: boolean } {
  if (Array.isArray(frame.messages)) return { messages: frame.messages as T[], inSync: true }
  if (!Array.isArray(frame.added) || !Array.isArray(frame.updated) || !Array.isArray(frame.removed)) return { messages: previous, inSync: false }
  const added = frame.added as T[]
  const updated = frame.updated as { id: string; row: T }[]
  const removed = new Set(frame.removed as string[])
  const replacements = new Map<string, T>()
  for (const row of added) replacements.set(row.id, row)
  for (const { id, row } of updated) {
    replacements.set(id, row)
    replacements.set(row.id, row)
  }
  const placed = new Set<T>()
  const messages: T[] = []
  for (const row of previous) {
    if (removed.has(row.id)) continue
    const replacement = replacements.get(row.id)
    if (replacement) placed.add(replacement)
    messages.push(replacement || row)
  }
  for (const row of added) if (!placed.has(row)) messages.push(row)
  const inSync = messages.length === frame.total && updated.every(({ row }) => placed.has(row))
  return { messages, inSync }
}

function mixStamp(hash: number, value: string) {
  let next = hash
  for (let i = 0; i < value.length; i++) next = (Math.imul(next, 33) + value.charCodeAt(i)) >>> 0
  return next
}

/**
 * Cheap fingerprint of a chat list so the dock can skip `setMessages` when a
 * snapshot changes nothing. Chat frames only arrive on a real change and do not
 * need it. Must include every in-place field the row renders: Twitch and
 * Kick backfill `avatar` onto the same id about 400ms later, and hashing only
 * id/deleted/text left letter fallbacks until an OBS refresh (#152).
 */
export type ChatSliceRow = {
  id: string
  deleted?: boolean
  text?: string
  avatar?: string
  color?: string
  originalText?: string
  sourceLabel?: string
  platform?: string
  platforms?: string[]
  badges?: { title?: string; url?: string; label?: string }[]
  parts?: { type?: string; url?: string; text?: string }[]
}

export function chatSliceStamp(messages: ChatSliceRow[]) {
  let hash = messages.length >>> 0
  for (const message of messages) {
    hash = mixStamp(hash, message.id)
    hash = mixStamp(hash, message.deleted ? '1' : '0')
    hash = mixStamp(hash, message.text || '')
    hash = mixStamp(hash, message.avatar || '')
    hash = mixStamp(hash, message.color || '')
    hash = mixStamp(hash, message.originalText || '')
    hash = mixStamp(hash, message.sourceLabel || '')
    hash = mixStamp(hash, message.platform || '')
    if (message.platforms) for (const platform of message.platforms) hash = mixStamp(hash, platform)
    if (message.badges) {
      for (const badge of message.badges) hash = mixStamp(hash, badge.url || badge.label || badge.title || '')
    }
    if (message.parts) {
      for (const part of message.parts) hash = mixStamp(hash, part.type === 'emote' ? part.url || '' : part.text || '')
    }
  }
  return hash
}

export function sameStringList(prev: string[], next: string[]) {
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false
  return true
}

export function sameHealth(prev: Record<string, { status?: string; message?: string }>, next: Record<string, { status?: string; message?: string }>) {
  for (const key of ['Twitch', 'Kick', 'YouTube']) {
    if (prev[key]?.status !== next[key]?.status || prev[key]?.message !== next[key]?.message) return false
  }
  return true
}

export function samePrivacy(prev: { videoId: string }[], next: { videoId: string }[]) {
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) if (prev[i].videoId !== next[i].videoId) return false
  return true
}

export function sameQuota(prev: { used: number; limit: number }, next: { used: number; limit: number }) {
  return prev.used === next.used && prev.limit === next.limit
}

export function chatDockFields(remote: Record<string, unknown>) {
  return {
    messages: Array.isArray(remote.messages) ? remote.messages : undefined,
    accounts: Array.isArray(remote.accounts) ? remote.accounts : undefined,
    health: remote.health && typeof remote.health === 'object' ? remote.health : undefined,
    chatWarnings: Array.isArray(remote.chatWarnings) ? remote.chatWarnings : undefined,
    youtubePrivacy: Array.isArray(remote.youtubePrivacy) ? remote.youtubePrivacy : undefined,
    youtubeQuota: remote.youtubeQuota && typeof remote.youtubeQuota === 'object' ? remote.youtubeQuota : undefined,
    streamelements: remote.streamelements && typeof remote.streamelements === 'object' ? remote.streamelements : undefined,
    streamInfo: remote.streamInfo && typeof remote.streamInfo === 'object' ? remote.streamInfo : undefined,
    mentionKeywords: Array.isArray(remote.mentionKeywords) ? remote.mentionKeywords.filter((item): item is string => typeof item === 'string') : undefined,
  }
}

/**
 * Pull only keys the activity dock understands. Omitted fields stay
 * `undefined` so a chat/activity/settings slice cannot look like
 * “StreamElements disconnected” (#55).
 */
export function applyActivitySlice<T extends { id: string }>(previous: T[], fields: { activity?: unknown; activityEvent?: unknown; activityTruncated?: boolean }) {
  if (Array.isArray(fields.activity)) return fields.activity as T[]
  const added = fields.activityEvent
  if (!added || typeof added !== 'object' || Array.isArray(added) || !('id' in added)) return previous
  const event = added as T
  const next = [event, ...previous.filter((item) => item.id !== event.id)]
  if (fields.activityTruncated && next.length > previous.length) return next.slice(0, previous.length)
  return next
}

/** A frame that arrived during backoff means the scheduled reconnect should not tear the stream down. */
export function sseReconnectStillNeeded(frameGenAtSchedule: number, frameGenNow: number) {
  return frameGenNow === frameGenAtSchedule
}

/** Ignore a late `/api/state` that would rewind the cursor behind a newer frame. */
export function sseSeqFromState(lastSeq: number | null, incoming: number) {
  if (!Number.isFinite(incoming)) return lastSeq
  if (lastSeq == null || incoming >= lastSeq) return incoming
  return lastSeq
}

/** The cursor helper keeps the higher seq, but the payload must not be applied either. */
export function sseStateIsStale(lastSeq: number | null, incoming: number) {
  return lastSeq != null && Number.isFinite(incoming) && incoming < lastSeq
}

export function activityDockFields(remote: Record<string, unknown>) {
  return {
    activity: Array.isArray(remote.activity) ? remote.activity : undefined,
    activityEvent: remote.activityEvent && typeof remote.activityEvent === 'object' && !Array.isArray(remote.activityEvent) ? remote.activityEvent : undefined,
    activityTruncated: remote.activityTruncated === true ? true : undefined,
    activityWarnings: Array.isArray(remote.activityWarnings) ? remote.activityWarnings : undefined,
    streamelements: remote.streamelements && typeof remote.streamelements === 'object' ? remote.streamelements : undefined,
    accounts: Array.isArray(remote.accounts) ? remote.accounts : undefined,
    activityFallback: typeof remote.activityFallback === 'boolean' ? remote.activityFallback : undefined,
    ignoreMissingJwt: typeof remote.ignoreMissingJwt === 'boolean' ? remote.ignoreMissingJwt : undefined,
    dropOldAlerts: typeof remote.dropOldAlerts === 'boolean' ? remote.dropOldAlerts : undefined,
    translateChat: typeof remote.translateChat === 'boolean' ? remote.translateChat : undefined,
    translateError: typeof remote.translateError === 'string' ? remote.translateError : undefined,
  }
}

function withWatchToken(url: string, token: string) {
  if (!token) return url
  const join = url.includes('?') ? '&' : '?'
  return `${url}${join}token=${encodeURIComponent(token)}`
}

/** Frames kept while `/api/state` is in flight. Losing older ones just means one more resync. */
const SSE_HELD_FRAMES_MAX = 1_000

export function subscribeDockSse(handlers: {
  onSnapshot: (data: Record<string, unknown>) => void
  /** Receives `messages`, the whole list. Chat deltas are applied here so a drift can resync. */
  onChat?: (data: { seq: number; messages: { id: string }[] }) => void
  onActivity?: (data: Record<string, unknown>) => void
  onPresence?: (data: Record<string, unknown>) => void
  onSettings?: (data: Record<string, unknown>) => void
  onStatus: (online: boolean) => void
  /** View secret from the watch URL. Omitted on the operator docks, which are loopback. */
  token?: string
}) {
  const token = handlers.token?.trim() || ''
  let source: EventSource | null = null
  let lastSeq: number | null = null
  let lastEventAt = Date.now()
  let failures = 0
  let closed = false
  let reconnectTimer: number | undefined
  let connecting = false
  let frameGen = 0
  let resyncGen = 0
  let chatRows: { id: string }[] = []
  // A gap freezes `lastSeq`, so frames that follow are held instead of each one
  // restarting the fetch. In a raid a fresh `/api/state` would never finish.
  let catchingUp = false
  let catchUpStartedAt = 0
  let heldFrames: { type: SseFrameType; data: Record<string, unknown> }[] = []

  const applySnapshot = (data: Record<string, unknown>) => {
    if (handlers.onChat && Array.isArray(data.messages)) chatRows = data.messages as { id: string }[]
    handlers.onSnapshot(data)
  }

  const catchUp = (type: SseFrameType, data: Record<string, unknown>) => {
    heldFrames.push({ type, data })
    if (heldFrames.length > SSE_HELD_FRAMES_MAX) heldFrames.shift()
    // Frames keep the stall watchdog quiet, so a hung fetch has to be retried from here.
    if (catchingUp && Date.now() - catchUpStartedAt < SSE_STALL_MS) return
    catchingUp = true
    catchUpStartedAt = Date.now()
    void resync()
  }

  const releaseHeldFrames = () => {
    catchingUp = false
    const frames = heldFrames
    heldFrames = []
    for (const frame of frames) routeFrame(frame.type, frame.data)
  }

  const applyFrame = (type: SseFrameType, data: Record<string, unknown>) => {
    lastEventAt = Date.now()
    frameGen += 1
    // Ping frames refresh the stall watchdog and clear the failure counter
    if (type === 'ping') {
      failures = 0
      return
    }
    routeFrame(type, data)
  }

  const routeFrame = (type: SseFrameType, data: Record<string, unknown>) => {
    const seq = Number(data.seq)
    if (!Number.isFinite(seq)) return
    if (sseFrameIsCovered(lastSeq, seq, type)) return
    if (type !== 'snapshot' && (catchingUp || sseSeqIsGap(lastSeq, seq, type))) {
      catchUp(type, data)
      return
    }
    let messages: { id: string }[] | undefined
    if (type === 'chat' && handlers.onChat) {
      const applied = applyChatFrame(chatRows, data)
      if (!applied.inSync) {
        catchUp(type, data)
        return
      }
      messages = applied.messages
      chatRows = messages
    }
    lastSeq = seq
    failures = 0
    handlers.onStatus(true)
    if (type === 'snapshot') {
      applySnapshot(data)
      if (catchingUp) releaseHeldFrames()
    } else if (messages) handlers.onChat?.({ seq, messages })
    else if (type === 'activity') handlers.onActivity?.(data)
    else if (type === 'presence') handlers.onPresence?.(data)
    else if (type === 'settings') handlers.onSettings?.(data)
  }

  const resync = async () => {
    const gen = ++resyncGen
    try {
      const response = await fetch(withWatchToken('/api/state', token))
      if (gen !== resyncGen) return
      if (!response.ok) throw new Error('state')
      const remote = await response.json() as Record<string, unknown>
      if (gen !== resyncGen) return
      const incomingSeq = Number(remote.seq)
      // A slower /api/state must not replace chat or activity that a newer SSE frame already showed.
      if (sseStateIsStale(lastSeq, incomingSeq)) {
        if (catchingUp) releaseHeldFrames()
        return
      }
      lastSeq = sseSeqFromState(lastSeq, incomingSeq)
      lastEventAt = Date.now()
      frameGen += 1
      applySnapshot(remote)
      handlers.onStatus(true)
      failures = 0
      if (catchingUp) releaseHeldFrames()
    } catch {
      if (gen !== resyncGen) return
      handlers.onStatus(false)
      // The next frame is still a gap and starts another attempt.
      catchingUp = false
      heldFrames = []
    }
  }

  const connect = () => {
    if (closed || connecting) return
    connecting = true
    source?.close()
    const next = new EventSource(withWatchToken('/events?chat=delta', token))
    source = next
    // Event taxonomy: snapshot = full state, on connect and every 60s; chat/activity = incremental feeds;
    // presence/settings = mirrors of backend settings; ping = keepalive
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
    failures += 1
    if (failures >= SSE_RELOAD_AFTER) {
      window.location.reload()
      return
    }
    // Exponential backoff capped at 8s; after enough failures the backend is
    // presumed gone and reloading re-establishes the whole dock
    const delay = Math.min(8_000, 500 * 2 ** failures)
    const scheduledGen = frameGen
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      if (!sseReconnectStillNeeded(scheduledGen, frameGen)) {
        failures = 0
        return
      }
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
