import crypto from 'node:crypto'
import path from 'node:path'
import { spawn, type SpawnOptions } from 'node:child_process'
import type { NextFunction, Request, Response } from 'express'

export type LocalApiOptions = {
  port: number
  bindHost: string
  lanEnabled: boolean
  apiToken?: string
}

export type ControlRequestInfo = {
  method: string
  path: string
  ip?: string
  origin?: string
  referer?: string
  host?: string
  token?: string
}

const PROFILE_HOSTS = {
  twitch: new Set(['www.twitch.tv', 'twitch.tv']),
  kick: new Set(['kick.com', 'www.kick.com']),
  youtube: new Set(['www.youtube.com', 'youtube.com']),
}

export function isLoopbackHost(host: string) {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return value === '127.0.0.1' || value === 'localhost' || value === '::1'
}

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

export function authorizeLocalControl(request: ControlRequestInfo, options: LocalApiOptions): { ok: true } | { ok: false; status: number; error: string } {
  const origin = String(request.origin || '').trim()
  const referer = String(request.referer || '').trim()
  const source = origin || referer
  if (source && !isTrustedOrigin(source, options, request.host)) {
    return { ok: false, status: 403, error: 'Cross-origin control requests are blocked' }
  }
  if (options.apiToken && request.token && safeEqual(request.token, options.apiToken)) return { ok: true }
  if (isLoopbackAddress(request.ip)) return { ok: true }
  if (options.lanEnabled && source && isTrustedOrigin(source, options, request.host)) return { ok: true }
  return {
    ok: false,
    status: 403,
    error: options.lanEnabled
      ? 'LAN control requests require RELAY_API_TOKEN'
      : 'Local control API is limited to this computer. Set RELAY_BIND=0.0.0.0 to allow LAN access.',
  }
}

function requestToken(request: Request) {
  const header = String(request.get('x-relay-token') || '').trim()
  const bearer = String(request.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
  return header || bearer
}

export function createControlGuard(options: LocalApiOptions) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return next()
    if (!request.path.startsWith('/api')) return next()
    const result = authorizeLocalControl({
      method: request.method,
      path: request.path,
      ip: request.socket.remoteAddress,
      origin: request.get('origin'),
      referer: request.get('referer'),
      host: request.get('host'),
      token: requestToken(request),
    }, options)
    if (!result.ok) return response.status(result.status).json({ error: result.error })
    next()
  }
}

export function corsOriginDelegate(options: Pick<LocalApiOptions, 'port' | 'lanEnabled'>) {
  return (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true)
    callback(null, isTrustedOrigin(origin, options))
  }
}

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
  if (PROFILE_HOSTS.twitch.has(host)) return /^\/[A-Za-z0-9_]{1,25}\/?$/.test(pathname)
  if (PROFILE_HOSTS.kick.has(host)) return /^\/[A-Za-z0-9_]{1,25}\/?$/.test(pathname)
  if (PROFILE_HOSTS.youtube.has(host)) return /^\/channel\/UC[\w-]{20,}\/?$/.test(pathname) || /^\/@[A-Za-z0-9._-]{1,60}\/?$/.test(pathname)
  return false
}

export function parseOpenUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  const url = String(raw || '').trim()
  if (!url) return { ok: false, error: 'url is required' }
  if (!isSafeExternalUrl(url)) return { ok: false, error: 'url is not an allowed profile link' }
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
