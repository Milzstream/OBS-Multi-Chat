import { fetchTimed, type FetchLike } from './fetch-timed.js'
import { isSafeMediaUrl } from './local-api.js'

export const MEDIA_MAX_BYTES = 2 * 1024 * 1024
export const MEDIA_TIMEOUT_MS = 8_000
const MEDIA_REDIRECTS = 3
const REDIRECT = new Set([301, 302, 303, 307, 308])
const IMAGE_TYPES = new Set(['image/webp', 'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/avif'])

export type MediaResult = { ok: true; contentType: string; body: Buffer } | { ok: false; status: number }

/**
 * "Just bytes" labels. Kick's emote bucket on S3 serves some emotes as
 * `binary/octet-stream`, so these are let through only when the bytes
 * themselves turn out to be an image.
 */
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream'])

export function mediaImageType(header: string | null) {
  const type = header?.split(';')[0]?.trim().toLowerCase()
  if (!type || !IMAGE_TYPES.has(type)) return
  return type
}

/** True for a missing or generic content type, where the bytes have to say what the file is. */
export function mediaTypeIsGeneric(header: string | null) {
  const type = header?.split(';')[0]?.trim().toLowerCase()
  return !type || GENERIC_TYPES.has(type)
}

function startsWith(body: Uint8Array, bytes: number[], offset = 0) {
  return body.length >= offset + bytes.length && bytes.every((byte, index) => body[offset + index] === byte)
}

function ascii(text: string) {
  return [...text].map((char) => char.charCodeAt(0))
}

/** Image type from the file's first bytes, for the formats the docks can show. Anything else is not an image. */
export function sniffImageType(body: Uint8Array) {
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(body, ascii('GIF87a')) || startsWith(body, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(body, ascii('RIFF')) && startsWith(body, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(body, ascii('ftypavif'), 4) || startsWith(body, ascii('ftypavis'), 4)) return 'image/avif'
  return
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
    const header = response.headers.get('content-type')
    const declaredType = mediaImageType(header)
    // An explicit non-image type (text/html, application/json, ...) is refused without reading the body.
    if (!declaredType && !mediaTypeIsGeneric(header)) {
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
    const contentType = declaredType || sniffImageType(body)
    if (!contentType) return { ok: false, status: 502 }
    return { ok: true, contentType, body }
  }
  return { ok: false, status: 502 }
}
