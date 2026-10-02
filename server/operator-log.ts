/**
 * Companion-window lines for a quiet dock. Counts are batched. A poll that
 * added nothing is not logged, so an empty chat cannot fill the 1500-line buffer.
 */

export const LIVE_CHECK_REPEAT_MS = 60_000

/**
 * A finished live-status poll. Unchanged results repeat about once a minute so
 * Twitch and Kick are visible the way YouTube quota lines are, without a line
 * every 15 seconds for the whole day.
 */
export function liveCheckLine(previous: { key: string; at: number } | undefined, next: { platform: string; live: boolean; viewers: number }, manual = false, now = Date.now(), repeatMs = LIVE_CHECK_REPEAT_MS) {
  const key = `${next.live}:${next.viewers}`
  const status = next.live ? `live, ${next.viewers.toLocaleString()} viewers` : 'offline'
  const line = `${next.platform} check: ${status}${manual ? ' (check live)' : ''}`
  if (manual || !previous || previous.key !== key || now - previous.at >= repeatMs) return { key, at: now, line }
  return { key, at: previous.at }
}

export function moderationLogLine(action: string, platform: string, user?: string) {
  const who = String(user || 'unknown').replace(/[\r\n]/g, ' ').trim() || 'unknown'
  return `${action} ${platform}: ${who}`
}

export function activityLogLine(event: { platform: string; kind: string; user: string }) {
  const user = String(event.user || 'unknown').replace(/[\r\n]/g, ' ').trim() || 'unknown'
  return `${event.platform} ${event.kind}: ${user}`
}

export function ingestSummary(platform: string, source: string, count: number) {
  if (count <= 0) return
  return `${platform}: ${count} message${count === 1 ? '' : 's'} (${source})`
}

/**
 * Fold a raid or a history seed into one line. `note(0)` is ignored so a
 * quiet poll never prints "0 messages".
 */
export function createIngestLog(write: (line: string) => void, waitMs = 1000, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }) {
  const counts = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  function flush() {
    if (timer) timers.clear(timer)
    timer = undefined
    for (const [key, count] of counts) {
      const [platform, source] = key.split('\0')
      const line = ingestSummary(platform, source, count)
      if (line) write(line)
    }
    counts.clear()
  }
  function note(platform: string, source: string, count = 1) {
    if (count <= 0) return
    const key = `${platform}\0${source}`
    counts.set(key, (counts.get(key) || 0) + count)
    if (timer) return
    timer = timers.set(() => {
      timer = undefined
      flush()
    }, waitMs)
  }
  return { note, flush }
}
