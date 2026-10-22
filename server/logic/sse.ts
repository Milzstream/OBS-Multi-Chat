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

/** Build the activity SSE slice: one new event, warnings only, or a full replace. */
export function activitySseFields<T extends { id: string }>(previous: T[], next: T[], warnings: string[]) {
  const appended = activityAppendedEvent(previous, next)
  if (appended) {
    const truncated = previous.length > 0 && next.length === previous.length
    return { activityEvent: appended, activityWarnings: warnings, ...(truncated ? { activityTruncated: true } : {}) }
  }
  const sameList = previous.length === next.length && previous.every((item, i) => item.id === next[i]?.id)
  if (sameList) return { activityWarnings: warnings }
  return { activity: next, activityWarnings: warnings }
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

