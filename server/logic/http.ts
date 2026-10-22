/**
 * HTTP error summarization, avatar URL cleanup, in-flight request sharing.
 */

export function summarizeApiError(status: number, text: string) {
  if (/504|Gateway Timeout/i.test(text) || status === 504) return 'Gateway Timeout (Twitch CDN busy)'
  if (/502|Bad Gateway/i.test(text) || status === 502) return 'Bad Gateway'
  if (/503|Service Unavailable/i.test(text) || status === 503) return 'Service Unavailable'
  try {
    const json = JSON.parse(text) as { message?: string; error?: string }
    return json.message || json.error || `HTTP ${status}`
  } catch {
    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return plain.slice(0, 160) || `HTTP ${status}`
  }
}


export function normalizeAvatar(url?: string) {
  if (!url) return
  let next = String(url).trim()
  if (!next) return
  if (next.startsWith('//')) next = `https:${next}`
  else if (next.startsWith('http://')) next = `https://${next.slice(7)}`
  if (/default-user|\/photo\.jpg(\?|$)/i.test(next)) return
  return next.replace(/=s\d+/i, '=s88')
}


export function shareInFlight<K, T>(locks: Map<K, Promise<T>>, key: K, run: () => Promise<T>): Promise<T> {
  const existing = locks.get(key)
  if (existing) return existing
  const pending = run().finally(() => {
    if (locks.get(key) === pending) locks.delete(key)
  })
  locks.set(key, pending)
  return pending
}
