/**
 * Alert media on disk: `data/alerts/<uuid>` plus a `.meta` sidecar.
 * Serve only through GET `/alerts/assets/:id`. Never write a user path.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Express, Request, Response } from 'express'
import {
  ALERT_ASSET_ID_RE,
  alertAssetKind,
  canonicalAlertMime,
  isAlertAssetId,
  parseAlertAsset,
  type AlertAssetMime,
} from './logic/alert-looks.js'
import type { AlertAssetRef } from './types.js'

/** Caps in one place. Images/GIF a few MB, video enough for a short clip, audio smaller. */
export const ALERT_ASSET_MAX_BYTES = {
  image: 4 * 1024 * 1024,
  video: 8 * 1024 * 1024,
  audio: 2 * 1024 * 1024,
} as const

/** Base64 JSON body for POST `/api/alerts/assets` (8 MB video ≈ 11 MB JSON). */
export const ALERT_ASSET_JSON_LIMIT = '12mb'

export function alertAssetMaxBytes(mime: string) {
  const kind = alertAssetKind(mime)
  return kind ? ALERT_ASSET_MAX_BYTES[kind] : 0
}

export function isAlertAssetJsonPath(pathname: string) {
  return pathname.replace(/\/+$/, '') === '/api/alerts/assets'
}

/**
 * Resolve `data/alerts/<uuid>` inside `dataDir`. `..`, absolute paths, and
 * non-UUID ids are rejected.
 */
export function resolveAlertAssetPath(dataDir: string, id: string) {
  const trimmed = String(id || '').trim().toLowerCase()
  if (!ALERT_ASSET_ID_RE.test(trimmed) || trimmed.includes('..') || /[/\\]/.test(String(id || ''))) return
  const root = path.resolve(dataDir, 'alerts')
  const file = path.resolve(root, trimmed)
  const rel = path.relative(root, file)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
  if (rel.split(/[/\\]/).length !== 1) return
  if (path.basename(file) !== trimmed) return
  return file
}

export function sniffAlertMime(bytes: Buffer): AlertAssetMime | undefined {
  if (bytes.length < 12) return
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
  const tag4 = bytes.toString('ascii', 0, 4)
  const tag8 = bytes.toString('ascii', 8, 12)
  if (tag4 === 'RIFF' && tag8 === 'WEBP') return 'image/webp'
  if (tag4 === 'RIFF' && tag8 === 'WAVE') return 'audio/wav'
  if (tag4 === 'OggS') return 'audio/ogg'
  if (tag4 === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08)) return 'audio/mpeg'
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12)
    if (brand === 'M4A ' || brand === 'M4B ' || brand.startsWith('mp4a')) return
    return 'video/mp4'
  }
}

function decodeAlertAssetData(data: string) {
  const raw = String(data || '').trim()
  if (!raw) return
  const comma = raw.indexOf(',')
  const payload = /^data:/i.test(raw) && comma >= 0 ? raw.slice(comma + 1) : raw
  try {
    const bytes = Buffer.from(payload, 'base64')
    return bytes.length ? bytes : undefined
  } catch {
    return
  }
}

function originalFileName(name: unknown) {
  const raw = typeof name === 'string' ? name : ''
  const base = path.basename(raw.replace(/\\/g, '/')).trim()
  return base.slice(0, 200) || 'alert'
}

export type AlertAssetRead = { mime: AlertAssetMime; body: Buffer; name: string }

export function readAlertAsset(dataDir: string, id: string): AlertAssetRead | undefined {
  const file = resolveAlertAssetPath(dataDir, id)
  if (!file) return
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return
    const body = fs.readFileSync(file)
    if (!body.length) return
    let mime = sniffAlertMime(body)
    let name = 'alert'
    try {
      const meta = JSON.parse(fs.readFileSync(`${file}.meta`, 'utf8')) as { mime?: unknown; name?: unknown }
      const fromMeta = typeof meta.mime === 'string' ? canonicalAlertMime(meta.mime) : undefined
      if (fromMeta) mime = fromMeta
      if (typeof meta.name === 'string' && meta.name.trim()) name = originalFileName(meta.name)
    } catch { /* sidecar is optional; sniff is enough to serve */ }
    if (!mime) return
    return { mime, body, name }
  } catch {
    return
  }
}

export type SaveAlertAssetInput = { name?: unknown; mime?: unknown; data?: unknown }
export type SaveAlertAssetResult =
  | { ok: true; asset: AlertAssetRef }
  | { ok: false; status: number; error: string }

export function saveAlertAsset(dataDir: string, input: SaveAlertAssetInput, newId: () => string = () => crypto.randomUUID()): SaveAlertAssetResult {
  if (typeof input.data !== 'string') return { ok: false, status: 400, error: 'File data is required' }
  const bytes = decodeAlertAssetData(input.data)
  if (!bytes) return { ok: false, status: 400, error: 'File data is not valid' }
  const sniffed = sniffAlertMime(bytes)
  if (!sniffed) return { ok: false, status: 400, error: 'That file type is not supported' }
  const claimed = typeof input.mime === 'string' && input.mime.trim() ? canonicalAlertMime(input.mime) : undefined
  if (claimed && claimed !== sniffed) return { ok: false, status: 400, error: 'That file does not match its type' }
  const mime = sniffed
  const max = alertAssetMaxBytes(mime)
  if (!max || bytes.length > max) return { ok: false, status: 400, error: 'That file is too large' }
  let id = String(newId() || '').toLowerCase()
  if (!isAlertAssetId(id)) id = crypto.randomUUID()
  const file = resolveAlertAssetPath(dataDir, id)
  if (!file) return { ok: false, status: 500, error: 'Could not store that file' }
  const name = originalFileName(input.name)
  const asset = parseAlertAsset({ id, mime, name })
  if (!asset) return { ok: false, status: 400, error: 'That file type is not supported' }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    fs.writeFileSync(`${file}.meta`, JSON.stringify({ mime: asset.mime, name: asset.name }), { encoding: 'utf8', mode: 0o600 })
    return { ok: true, asset }
  } catch {
    return { ok: false, status: 500, error: 'Could not store that file' }
  }
}

export function registerAlertAssetRoutes(app: Express, dataDir: string) {
  app.get('/alerts/assets/:id', (request: Request, response: Response) => {
    const id = String(request.params.id || '')
    const asset = readAlertAsset(dataDir, id)
    if (!asset) return response.status(404).end()
    response.setHeader('Content-Type', asset.mime)
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    response.setHeader('Content-Length', String(asset.body.length))
    response.end(asset.body)
  })
  app.post('/api/alerts/assets', (request: Request, response: Response) => {
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as SaveAlertAssetInput
    const result = saveAlertAsset(dataDir, body)
    if (!result.ok) return response.status(result.status).json({ error: result.error })
    response.json(result.asset)
  })
}
