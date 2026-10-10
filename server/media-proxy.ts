import { fetchTimed, type FetchLike } from './fetch-timed.js'
import { isSafeMediaUrl } from './local-api.js'

export const MEDIA_MAX_BYTES = 2 * 1024 * 1024
export const MEDIA_TIMEOUT_MS = 8_000
const MEDIA_REDIRECTS = 3
const REDIRECT = new Set([301, 302, 303, 307, 308])
const IMAGE_TYPES = new Set(['image/webp', 'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/avif'])

export type MediaResult = { ok: true; contentType: string; body: Buffer } | { ok: false; status: number }

export function mediaImageType(header: string | null) {
  const type = header?.split(';')[0]?.trim().toLowerCase()
  if (!type || !IMAGE_TYPES.has(type)) return
  return type
}

async function release(response: Response) {
  try { await response.body?.cancel() } catch { /* already closed */ }
}

async function readLimited(response: Response, maxBytes: number) {
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > maxBytes) return
    return body
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return
      }
      chunks.push(Buffer.from(value))
    }
  } catch {
    await reader.cancel().catch(() => {})
    return
  }
  return Buffer.concat(chunks, total)
}

export async function fetchMedia(raw: string, options: { fetchImpl?: FetchLike; timeoutMs?: number; maxBytes?: number } = {}): Promise<MediaResult> {
  if (!isSafeMediaUrl(raw)) return { ok: false, status: 400 }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? MEDIA_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MEDIA_MAX_BYTES
  const deadline = Date.now() + timeoutMs
  let current = raw
  for (let hop = 0; hop <= MEDIA_REDIRECTS; hop++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false, status: 502 }
    let response: Response
    try {
      response = await fetchTimed(current, { headers: { Accept: 'image/*' }, redirect: 'manual' }, remaining, fetchImpl)
    } catch {
      return { ok: false, status: 502 }
    }
    if (REDIRECT.has(response.status)) {
      const location = response.headers.get('location')?.trim()
      await release(response)
      if (!location || hop === MEDIA_REDIRECTS) return { ok: false, status: 502 }
      let next: string
      try { next = new URL(location, current).href } catch { return { ok: false, status: 502 } }
      if (!isSafeMediaUrl(next)) return { ok: false, status: 502 }
      current = next
      continue
    }
    if (!response.ok) {
      await release(response)
      return { ok: false, status: response.status }
    }
    const contentType = mediaImageType(response.headers.get('content-type'))
    if (!contentType) {
      await release(response)
      return { ok: false, status: 502 }
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await release(response)
      return { ok: false, status: 502 }
    }
    const body = await readLimited(response, maxBytes)
    if (!body) return { ok: false, status: 502 }
    return { ok: true, contentType, body }
  }
  return { ok: false, status: 502 }
}
