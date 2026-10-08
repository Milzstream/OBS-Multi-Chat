import crypto from 'node:crypto'
import path from 'node:path'
import { spawn, type SpawnOptions } from 'node:child_process'
import type { NextFunction, Request, Response } from 'express'

/**
 * Local control API helpers: hardening and URL allowlists for the docks.
 *
 * The process binds to loopback unless LAN is opted in (`RELAY_BIND` not
 * loopback, or `RELAY_LAN=1`). Off this computer:
 * - A watch token (query `token` or `relay_watch` cookie) can only read
 *   `/watch`, `/api/state`, `/events`, and `/api/media`. It cannot send,
 *   moderate, open links, or read JWTs. Neighbors on the Wi-Fi do not get
 *   that token unless the streamer shares the watch URL.
 * - `RELAY_API_TOKEN` is a header secret for tools (`x-relay-token` or
 *   `Authorization: Bearer`). It is never read from the query string, so a
 *   watch URL cannot be reused as a write credential. A matching Origin is
 *   not permission to write.
 * - Shutdown, the companion, and the operator docks stay on this computer
 *   even with the API token. OAuth from another device requires the header.
 * HTTP only, no TLS.
 */

export type LocalApiOptions = {
  port: number
  bindHost: string
  lanEnabled: boolean
  apiToken?: string
  watchToken?: string
  /** Test seam. Production leaves this unset and uses the socket address. */
  peerAddress?: (request: Request) => string | undefined
}

export type ControlRequestInfo = {
  method: string
  path: string
  ip?: string
  origin?: string
  referer?: string
  host?: string
  /** Header secret only (`x-relay-token` or Bearer). Never a query value. */
  token?: string
  watchToken?: string
  watchTokenFrom?: 'query' | 'cookie'
}

export type AccessClass = 'public' | 'read' | 'write' | 'secret' | 'operator' | 'oauth'

export const WATCH_COOKIE = 'relay_watch'
const WATCH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const PUBLIC_FILE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|txt|webmanifest)$/i

const PROFILE_HOSTS = {
  twitch: new Set(['www.twitch.tv', 'twitch.tv']),
  twitchDashboard: new Set(['dashboard.twitch.tv']),
  kick: new Set(['kick.com', 'www.kick.com']),
  youtube: new Set(['www.youtube.com', 'youtube.com']),
  studio: new Set(['studio.youtube.com']),
}

/** True for the loopback aliases a local process would resolve to. */
export function isLoopbackHost(host: string) {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return value === '127.0.0.1' || value === 'localhost' || value === '::1'
}

/**
 * Resolve the HTTP bind host from env. Defaults to loopback-only. `RELAY_LAN=1`
 * (or any non-loopback `RELAY_BIND`) switches to the LAN. Writes from off this
 * computer then require `RELAY_API_TOKEN`; the watch link uses its own view token.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): { host: string; lanEnabled: boolean } {
  const raw = String(env.RELAY_BIND || '').trim()
  const lanFlag = env.RELAY_LAN === '1' || /^true$/i.test(String(env.RELAY_LAN || ''))
  if (lanFlag) return { host: raw || '0.0.0.0', lanEnabled: true }
  if (raw) return { host: raw, lanEnabled: !isLoopbackHost(raw) }
  return { host: '127.0.0.1', lanEnabled: false }
}

export function isLoopbackAddress(address?: string | null) {
  const host = String(address || '').replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * CORS check: allow loopback origins always, and LAN origins only when LAN is
 * enabled and the origin host/port resolves back to this machine's bind
 * address.
 */
export function isTrustedOrigin(origin: string, options: Pick<LocalApiOptions, 'port' | 'lanEnabled'>, requestHost?: string) {
  let url: URL
  try { url = new URL(origin) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
  if (port !== options.port) return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  if (!options.lanEnabled || !requestHost) return false
  try {
    const expected = new URL(`http://${requestHost}`)
    const expectedHost = expected.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const expectedPort = expected.port ? Number(expected.port) : options.port
    return host === expectedHost && expectedPort === port
  } catch {
    return false
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Route class for the guard. Operator pages and unknown GETs stay on this
 * computer so a LAN client cannot load `/` and use the dock. Static assets
 * stay public so `/watch` can load the same bundle.
 */
export function classifyAccess(method: string, rawPath: string): AccessClass {
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const path = rawPath.split('?')[0].replace(/\/+$/, '') || '/'
  if (verb === 'OPTIONS') return 'public'
  if (path === '/oauth' || path.startsWith('/oauth/')) return 'oauth'
  if (path === '/api/shutdown' || path === '/api/logs' || path === '/events/logs' || path === '/api/console' || path.startsWith('/api/console/')) return 'operator'
  if (path === '/api/jwts' && verb === 'GET') return 'secret'
  if (path.startsWith('/api/categories')) return 'secret'
  if (path.startsWith('/api/') && verb !== 'GET') return 'write'
  if (path === '/api/state' || path === '/events' || path === '/api/media' || path === '/watch') return 'read'
  if (verb === 'GET' && (path.startsWith('/assets/') || PUBLIC_FILE.test(path))) return 'public'
  if (verb === 'GET') return 'operator'
  return 'write'
}

/** Accept a view secret that is safe in a URL and a cookie. Empty and oversized values are ignored. */
export function normalizeWatchToken(raw: string | undefined) {
  const token = String(raw || '').trim()
  if (!WATCH_TOKEN_PATTERN.test(token)) return
  return token
}

/**
 * View secret for the watch URL. `RELAY_WATCH_TOKEN` wins when it is valid and
 * distinct from `RELAY_API_TOKEN`. Otherwise reuse `data/watch-token`, or
 * return a new value the caller should persist. LAN off means no secret.
 */
export function resolveWatchSecret(input: {
  lanEnabled: boolean
  envToken?: string
  apiToken?: string
  stored?: string
  create?: () => string
}): { token?: string; source?: 'env' | 'file' | 'generated'; persist?: string; warning?: string } {
  if (!input.lanEnabled) return {}
  const envRaw = String(input.envToken || '').trim()
  const envToken = normalizeWatchToken(envRaw)
  if (envRaw && !envToken) return { warning: 'RELAY_WATCH_TOKEN was ignored. Use 8–128 letters, numbers, "_" or "-".', ...keptWatchSecret(input) }
  if (envToken && input.apiToken && envToken === input.apiToken) {
    return { warning: 'RELAY_WATCH_TOKEN matches RELAY_API_TOKEN. A different view token was kept so the watch link cannot be reused as a write secret.', ...keptWatchSecret(input) }
  }
  if (envToken) return { token: envToken, source: 'env' }
  return keptWatchSecret(input)
}

function keptWatchSecret(input: { apiToken?: string; stored?: string; create?: () => string }): { token?: string; source?: 'file' | 'generated'; persist?: string } {
  const stored = normalizeWatchToken(input.stored)
  if (stored && stored !== input.apiToken) return { token: stored, source: 'file' }
  const created = normalizeWatchToken(input.create?.())
  if (!created || created === input.apiToken) return {}
  return { token: created, source: 'generated', persist: created }
}

export type LanNic = { address: string; family: string | number; internal: boolean }

function isPrivateIPv4(address: string) {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((part) => Number(part))
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = nums
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  return a === 172 && b >= 16 && b <= 31
}

/** Address to put in the shared watch URL. An explicit non-loopback bind wins; otherwise the first private IPv4. */
export function pickLanIPv4(bindHost: string, interfaces: Record<string, readonly LanNic[] | undefined>) {
  const bound = bindHost.trim()
  if (bound && bound !== '0.0.0.0' && bound !== '::' && bound !== '*' && !isLoopbackHost(bound)) return bound.replace(/^\[|\]$/g, '')
  const found: { address: string; rank: number }[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const v4 = entry.family === 4 || entry.family === 'IPv4'
      if (!v4 || entry.internal || !isPrivateIPv4(entry.address)) continue
      const rank = entry.address.startsWith('192.168.') ? 0 : entry.address.startsWith('10.') ? 1 : 2
      found.push({ address: entry.address, rank })
    }
  }
  found.sort((left, right) => left.rank - right.rank || left.address.localeCompare(right.address))
  return found[0]?.address
}

export function watchUrlFor(host: string | undefined, port: number, token: string | undefined) {
  if (!host || !token) return
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${hostname}:${port}/watch?token=${encodeURIComponent(token)}`
}

export function lanWatchUrl(input: { bindHost: string; port: number; token?: string; interfaces: Record<string, readonly LanNic[] | undefined> }) {
  return watchUrlFor(pickLanIPv4(input.bindHost, input.interfaces), input.port, input.token)
}

export function watchCookieHeader(token: string) {
  return `${WATCH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
}

/** Query `token` wins so a freshly shared link works before the cookie exists. The cookie covers later `/events` calls. */
export function watchTokenFromRequest(queryToken: unknown, cookieHeader: string | undefined): { token: string; from: 'query' | 'cookie' } | undefined {
  const query = typeof queryToken === 'string' ? queryToken.trim() : Array.isArray(queryToken) ? String(queryToken[0] || '').trim() : ''
  if (query) return { token: query, from: 'query' }
  for (const part of String(cookieHeader || '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== WATCH_COOKIE) continue
    try {
      const token = decodeURIComponent(rest.join('=')).trim()
      if (token) return { token, from: 'cookie' }
    } catch { /* ignore a malformed cookie */ }
  }
}

function tokenMatches(expected: string | undefined, presented: string | undefined) {
  if (!expected || !presented) return false
  return safeEqual(presented, expected)
}

function limitedToThisComputer(): { ok: false; status: 403; error: string } {
  return { ok: false, status: 403, error: 'Local control API is limited to this computer. Set RELAY_BIND=0.0.0.0 to allow LAN access.' }
}

/**
 * Authorization gate. Loopback is the operator. Off-box, a trusted Origin is
 * only a cross-origin check — it never grants write, secret, or operator
 * access. The watch token is read-only. The API token is header-only.
 */
export function authorizeLocalControl(request: ControlRequestInfo, options: LocalApiOptions): { ok: true; watchCookie?: boolean } | { ok: false; status: number; error: string } {
  const kind = classifyAccess(request.method, request.path)
  if (kind === 'public') return { ok: true }
  const origin = String(request.origin || '').trim()
  const referer = String(request.referer || '').trim()
  const source = origin || referer
  if (source && !isTrustedOrigin(source, options, request.host)) {
    return { ok: false, status: 403, error: 'Cross-origin control requests are blocked' }
  }
  if (isLoopbackAddress(request.ip)) return { ok: true }
  if (!options.lanEnabled) return limitedToThisComputer()
  const apiOk = tokenMatches(options.apiToken, request.token)
  const watchOk = tokenMatches(options.watchToken, request.watchToken)
  if (kind === 'operator') return { ok: false, status: 403, error: 'Companion and dock controls stay on this computer' }
  if (kind === 'oauth') {
    if (apiOk) return { ok: true }
    return { ok: false, status: 403, error: 'OAuth stays on this computer' }
  }
  if (kind === 'write' || kind === 'secret') {
    if (apiOk) return { ok: true }
    return { ok: false, status: 403, error: 'LAN control requests require RELAY_API_TOKEN' }
  }
  if (apiOk) return { ok: true }
  if (watchOk) return { ok: true, watchCookie: request.watchTokenFrom === 'query' }
  return { ok: false, status: 403, error: 'This watch link needs its view token' }
}

function requestToken(request: Request) {
  const header = String(request.get('x-relay-token') || '').trim()
  const bearer = String(request.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
  return header || bearer
}

function denyControl(request: Request, response: Response, error: string) {
  const path = request.path.replace(/\/+$/, '') || '/'
  const api = path.startsWith('/api') || path.startsWith('/events') || path.startsWith('/oauth')
  if (api) return response.status(403).json({ error })
  const message = path === '/watch'
    ? 'This watch link is missing or has the wrong token. Copy it again from the Relay Chat Dock window.'
    : 'This page stays on the streaming PC. Copy the watch link from the Relay Chat Dock window.'
  return response.status(403).type('html').send(`<!doctype html><meta charset="utf-8"><title>Relay Chat Dock</title><body style="margin:0;padding:28px;background:#111416;color:#eef1f0;font:15px sans-serif"><p>${message}</p></body>`)
}

/** Express middleware for every route. GET is not a free pass: JWTs, state, and the operator pages are classified. */
export function createControlGuard(options: LocalApiOptions) {
  return (request: Request, response: Response, next: NextFunction) => {
    const presented = watchTokenFromRequest(request.query.token, request.get('cookie'))
    const result = authorizeLocalControl({
      method: request.method,
      path: request.path,
      ip: options.peerAddress?.(request) || request.socket.remoteAddress,
      origin: request.get('origin'),
      referer: request.get('referer'),
      host: request.get('host'),
      token: requestToken(request),
      watchToken: presented?.token,
      watchTokenFrom: presented?.from,
    }, options)
    if (!result.ok) return denyControl(request, response, result.error)
    if (result.watchCookie && options.watchToken) response.setHeader('Set-Cookie', watchCookieHeader(options.watchToken))
    next()
  }
}

/** CORS middleware callback: no Origin (same-page fetch) passes, anything else must be a trusted origin. */
export function corsOriginDelegate(options: Pick<LocalApiOptions, 'port' | 'lanEnabled'>) {
  return (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true)
    callback(null, isTrustedOrigin(origin, options))
  }
}

/** Allowlist external links the docks may open: https-only, no auth/port/query/hash, and a path shape per known host (profiles, channel-scoped viewer cards, YouTube Studio). */
export function isSafeExternalUrl(raw: string) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return false
  if (/[\u0000-\u0020\u007f<>"'\\|`]/.test(raw)) return false
  let parsed: URL
  try { parsed = new URL(raw) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  if (parsed.port) return false
  if (parsed.search || parsed.hash) return false
  const host = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname
  if (PROFILE_HOSTS.twitch.has(host)) return /^\/[A-Za-z0-9_]{1,25}\/?$/.test(pathname) || /^\/popout\/[A-Za-z0-9_]{1,25}\/viewercard\/[A-Za-z0-9_]{1,25}\/?$/.test(pathname)
  if (PROFILE_HOSTS.twitchDashboard.has(host)) return pathname === '/stream-manager' || pathname === '/stream-manager/' || pathname === '/stream' || pathname === '/stream/' || /^\/u\/[A-Za-z0-9_]{1,25}\/(stream-manager|stream)\/?$/.test(pathname)
  if (PROFILE_HOSTS.kick.has(host)) return /^\/[A-Za-z0-9_-]{1,50}\/?$/.test(pathname) || /^\/dashboard(\/stream)?\/?$/.test(pathname)
  if (PROFILE_HOSTS.youtube.has(host)) return /^\/channel\/UC[\w-]{20,}\/?$/.test(pathname) || /^\/@[A-Za-z0-9._-]{1,60}\/?$/.test(pathname)
  // Studio home or a channel livestreaming page — no query/hash (checked above).
  if (PROFILE_HOSTS.studio.has(host)) return pathname === '/' || pathname === '/livestreaming' || pathname === '/livestreaming/' || /^\/channel\/UC[\w-]{20,}(\/livestreaming)?\/?$/.test(pathname)
  return false
}

const MEDIA_HOSTS = new Set(['files.kick.com', 'static-cdn.jtvnw.net', 'yt3.ggpht.com', 'yt3.googleusercontent.com'])

/** Allowlist avatar/media URLs to a fixed set of platform image hosts the docks are allowed to hotlink. */
export function isSafeMediaUrl(raw: string) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return false
  let parsed: URL
  try { parsed = new URL(raw) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  return MEDIA_HOSTS.has(parsed.hostname.toLowerCase())
}

export function parseOpenUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  const url = String(raw || '').trim()
  if (!url) return { ok: false, error: 'url is required' }
  if (!isSafeExternalUrl(url)) return { ok: false, error: 'url is not an allowed link' }
  return { ok: true, url }
}

export function browserOpenPlan(url: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; options: SpawnOptions } {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows'
    return {
      command: path.join(systemRoot, 'System32', 'rundll32.exe'),
      args: ['url.dll,FileProtocolHandler', url],
      options: { detached: true, stdio: 'ignore', windowsHide: true },
    }
  }
  if (platform === 'darwin') return { command: 'open', args: [url], options: { detached: true, stdio: 'ignore' } }
  return { command: 'xdg-open', args: [url], options: { detached: true, stdio: 'ignore' } }
}

export function openInDefaultBrowser(url: string, spawnFn: typeof spawn = spawn) {
  const plan = browserOpenPlan(url)
  spawnFn(plan.command, plan.args, plan.options).unref()
}

export function createOpenHandler(open: (url: string) => void = openInDefaultBrowser) {
  return (request: Request, response: Response) => {
    const parsed = parseOpenUrl((request.body as { url?: string } | undefined)?.url)
    if (!parsed.ok) return response.status(400).json({ error: parsed.error })
    try {
      open(parsed.url)
      response.json({ ok: true })
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
