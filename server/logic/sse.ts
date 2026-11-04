/**
 * SSE payload helpers and activity delta detection.
 */

export function activityAppendedEvent<T extends { id: string }>(previous: T[], next: T[]) {
  if (!next.length) return
  const added = next[0]
  if (!added?.id || previous.some((item) => item.id === added.id)) return
  const rest = next.slice(1)
  if (rest.length === previous.length && rest.every((item, i) => item.id === previous[i]?.id)) return added
  if (rest.length === previous.length - 1 && rest.every((item, i) => item.id === previous[i]?.id)) return added
}

/** Copy activity rows so a later in-place fill-in (plan, gifter) can still be diffed. */
export function snapshotActivityEvents<T extends object>(events: T[]): T[] {
  return events.map((event) => ({ ...event }))
}

function activityRowsMatch<T extends { id: string }>(previous: T[], next: T[]) {
  return previous.length === next.length && previous.every((item, i) => item.id === next[i]?.id && JSON.stringify(item) === JSON.stringify(next[i]))
}

/** Build the activity SSE slice: one new event, warnings only, or a full replace. */
export function activitySseFields<T extends { id: string }>(previous: T[], next: T[], warnings: string[]) {
  const appended = activityAppendedEvent(previous, next)
  if (appended) {
    const truncated = previous.length > 0 && next.length === previous.length
    return { activityEvent: appended, activityWarnings: warnings, ...(truncated ? { activityTruncated: true } : {}) }
  }
  if (activityRowsMatch(previous, next)) return { activityWarnings: warnings }
  return { activity: next, activityWarnings: warnings }
}

export type ChatSseDelta<T> = {
  added: T[]
  /** `id` is the id the dock knows the row by. An echo can swap the row's own id in place. */
  updated: { id: string; row: T }[]
  removed: string[]
  /** Row count after applying. A dock that lands on another count has drifted and resyncs. */
  total: number
}

/**
 * Build the chat SSE slice: nothing, new and changed rows, or the whole list
 * when a row moved or landed mid-list. Rows are replaced, never mutated, so a
 * reference check finds every change without serializing 5000 rows per message.
 */
export function chatSseFields<T extends { id: string }>(previous: T[], next: T[]): ChatSseDelta<T> | { messages: T[] } | undefined {
  if (previous === next) return
  const previousIds = new Set(previous.map((row) => row.id))
  const nextIds = new Set(next.map((row) => row.id))
  if (previousIds.size !== previous.length || nextIds.size !== next.length) return { messages: next }
  const delta: ChatSseDelta<T> = { added: [], updated: [], removed: [], total: next.length }
  let from = 0
  let to = 0
  while (from < previous.length && to < next.length) {
    const before = previous[from]
    const after = next[to]
    if (before === after) {
      from += 1
      to += 1
    } else if (before.id === after.id) {
      if (JSON.stringify(before) !== JSON.stringify(after)) delta.updated.push({ id: before.id, row: after })
      from += 1
      to += 1
    } else if (nextIds.has(before.id)) {
      return { messages: next }
    } else if (previousIds.has(after.id)) {
      delta.removed.push(before.id)
      from += 1
    } else {
      delta.updated.push({ id: before.id, row: after })
      from += 1
      to += 1
    }
  }
  for (; from < previous.length; from += 1) delta.removed.push(previous[from].id)
  for (; to < next.length; to += 1) delta.added.push(next[to])
  return delta.added.length || delta.updated.length || delta.removed.length ? delta : undefined
}

export function sseBroadcastEvent(data: unknown, previous?: string) {
  const json = JSON.stringify(data)
  if (json === previous) return { json, payload: undefined, unchanged: true as const }
  return { json, payload: `data: ${json}\n\n`, unchanged: false as const }
}

export function sseNamedEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function sseChangedKeys(previous: Record<string, string>, next: Record<string, string>) {
  return Object.keys(next).filter((key) => previous[key] !== next[key])
}

