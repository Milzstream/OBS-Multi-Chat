/**
 * On-stream alert looks: parse, field-level cascade, and {token} fill.
 * No filesystem I/O. Asset bytes are `server/alert-assets.ts`.
 */

import type { AlertAssetRef, AlertLook, AlertLooks, AlertPlatform, AlertSettings, AlertTextAlign, AlertTextBox } from '../types.js'

export const ALERT_LOOK_PLATFORMS: readonly AlertPlatform[] = ['Twitch', 'Kick', 'YouTube', 'StreamElements']
export const ALERT_LOOK_KINDS = ['follow', 'subscription', 'gift', 'cheer', 'raid', 'donation', 'membership', 'superchat', 'merch'] as const

export const ALERT_TOKENS = ['name', 'amount', 'message', 'kind', 'platform', 'months', 'viewers', 'plan', 'gifter'] as const
export type AlertToken = (typeof ALERT_TOKENS)[number]

/**
 * Outfit is loaded for the docks. The rest are common Windows faces used
 * until this PC's installed list arrives, or when enumeration fails.
 */
export const ALERT_FONTS = [
  'Outfit',
  'Arial',
  'Arial Black',
  'Comic Sans MS',
  'Courier New',
  'Georgia',
  'Impact',
  'Segoe UI',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
] as const

/** Ids from the first Font picker. Stored looks keep working after the switch to family names. */
const ALERT_FONT_LEGACY: Record<string, string> = {
  outfit: 'Outfit',
  impact: 'Impact',
  arial: 'Arial',
  'arial-black': 'Arial Black',
  georgia: 'Georgia',
  times: 'Times New Roman',
  verdana: 'Verdana',
  tahoma: 'Tahoma',
  trebuchet: 'Trebuchet MS',
  comic: 'Comic Sans MS',
  courier: 'Courier New',
  segoe: 'Segoe UI',
}

const ALERT_FONT_MAX = 80
const ALERT_FONT_LIST_MAX = 2000
const ALERT_FONT_UNSAFE = /[\u0000-\u001f\u007f\\"<>{};,]|url\s*\(/i

/**
 * Persist a CSS family name, not a stylesheet. Quotes, braces, and `url(`
 * are dropped so a look cannot inject CSS. Legacy picker ids map to names.
 */
export function parseAlertFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed) return
  const legacy = ALERT_FONT_LEGACY[trimmed.toLowerCase()]
  if (legacy) return legacy
  if (trimmed.length > ALERT_FONT_MAX) return
  if (ALERT_FONT_UNSAFE.test(trimmed)) return
  if (!/\p{L}/u.test(trimmed)) return
  return trimmed
}

/** Overlay stack. Missing / unsafe names inherit Outfit from the page. */
export function alertFontCss(family?: string): string | undefined {
  const name = parseAlertFontFamily(family)
  if (!name) return
  if (name.toLowerCase() === 'outfit') return 'Outfit, sans-serif'
  return `"${name}", Outfit, sans-serif`
}

/** Outfit first, then unique safe names in A–Z order. */
export function mergeAlertFontList(installed: readonly string[]): string[] {
  const seen = new Set<string>(['outfit'])
  const rest: string[] = []
  for (const raw of installed) {
    const name = parseAlertFontFamily(raw)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rest.push(name)
    if (rest.length >= ALERT_FONT_LIST_MAX) break
  }
  rest.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return ['Outfit', ...rest]
}

/** Keep a saved family visible even when this PC no longer lists it. */
export function alertFontSelectOptions(list: readonly string[], selected?: string): string[] {
  const fonts = mergeAlertFontList(list)
  const current = parseAlertFontFamily(selected)
  if (!current || fonts.some((name) => name.toLowerCase() === current.toLowerCase())) return fonts
  return [fonts[0], current, ...fonts.slice(1)]
}

/** UUID on disk. User-supplied paths never reach here. */
export const ALERT_ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ALERT_ASSET_MIME = {
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/webm': 'video',
  'video/mp4': 'video',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
} as const

export type AlertAssetKind = 'image' | 'video' | 'audio'
export type AlertAssetMime = keyof typeof ALERT_ASSET_MIME

const MIME_ALIAS: Record<string, AlertAssetMime> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-pn-wav': 'audio/wav',
  'audio/vorbis': 'audio/ogg',
  'audio/ogg; codecs=vorbis': 'audio/ogg',
}

export function isAlertAssetId(id: string) {
  return ALERT_ASSET_ID_RE.test(id)
}

export function canonicalAlertMime(value: string): AlertAssetMime | undefined {
  const raw = String(value || '').trim().toLowerCase()
  const base = raw.split(';')[0].trim() as AlertAssetMime
  if (base in ALERT_ASSET_MIME) return base
  return MIME_ALIAS[base] || MIME_ALIAS[raw]
}

export function alertAssetKind(mime: string): AlertAssetKind | undefined {
  const canonical = canonicalAlertMime(mime)
  return canonical ? ALERT_ASSET_MIME[canonical] : undefined
}

export function alertAssetUrl(id: string) {
  return `/alerts/assets/${encodeURIComponent(id)}`
}

const LOOK_DISPLAY_MIN = 1
const LOOK_DISPLAY_MAX = 30

function clampLookSeconds(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return
  return Math.min(LOOK_DISPLAY_MAX, Math.max(LOOK_DISPLAY_MIN, Math.round(number * 2) / 2))
}

function clampPercent(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return
  return Math.min(100, Math.max(0, number))
}

function parseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const hex = value.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return hex.toLowerCase()
}

function parseAlign(value: unknown): AlertTextAlign | undefined {
  if (value === 'left' || value === 'center' || value === 'right') return value
}

function parseFontWeight(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return
  const stepped = Math.round(number / 100) * 100
  if (stepped < 100 || stepped > 900) return
  return stepped
}

export function parseAlertAsset(value: unknown): AlertAssetRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const raw = value as { id?: unknown; mime?: unknown; name?: unknown }
  if (typeof raw.id !== 'string' || !isAlertAssetId(raw.id)) return
  const mime = typeof raw.mime === 'string' ? canonicalAlertMime(raw.mime) : undefined
  if (!mime) return
  const name = typeof raw.name === 'string' ? raw.name.replace(/[/\\]/g, '').trim().slice(0, 200) : ''
  return { id: raw.id.toLowerCase(), mime, name }
}

function parseAssetField(value: unknown): AlertAssetRef | null | undefined {
  if (value === undefined) return
  if (value === null) return null
  return parseAlertAsset(value)
}

export function parseAlertTextBox(value: unknown): AlertTextBox | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const raw = value as Partial<AlertTextBox>
  if (typeof raw.text !== 'string') return
  const x = clampPercent(raw.x)
  const y = clampPercent(raw.y)
  if (x == null || y == null) return
  const width = raw.width === undefined ? undefined : clampPercent(raw.width)
  const fontSize = raw.fontSize === undefined ? undefined : clampPercent(raw.fontSize)
  const box: AlertTextBox = { text: raw.text.slice(0, 500), x, y }
  if (width != null) box.width = width
  const align = parseAlign(raw.align)
  if (align) box.align = align
  const color = parseColor(raw.color)
  if (color) box.color = color
  if (fontSize != null && fontSize > 0) box.fontSize = fontSize
  const fontWeight = parseFontWeight(raw.fontWeight)
  if (fontWeight) box.fontWeight = fontWeight
  const fontFamily = parseAlertFontFamily(raw.fontFamily)
  if (fontFamily) box.fontFamily = fontFamily
  return box
}

function parseTextBoxesField(value: unknown): AlertTextBox[] | null | undefined {
  if (value === undefined) return
  if (value === null) return null
  if (!Array.isArray(value)) return
  return value.map(parseAlertTextBox).filter((box): box is AlertTextBox => Boolean(box)).slice(0, 8)
}

function parseDisplaySecField(value: unknown): number | null | undefined {
  if (value === undefined) return
  if (value === null) return null
  return clampLookSeconds(value)
}

export function parseAlertLook(value: unknown): AlertLook | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const raw = value as Record<string, unknown>
  const look: AlertLook = {}
  const image = parseAssetField(raw.image)
  if (image !== undefined) look.image = image
  const video = parseAssetField(raw.video)
  if (video !== undefined) look.video = video
  const audio = parseAssetField(raw.audio)
  if (audio !== undefined) look.audio = audio
  const textBoxes = parseTextBoxesField(raw.textBoxes)
  if (textBoxes !== undefined) look.textBoxes = textBoxes
  const displaySec = parseDisplaySecField(raw.displaySec)
  if (displaySec !== undefined) look.displaySec = displaySec
  if (!Object.keys(look).length) return
  return look
}

function lookSlotKey(value: string) {
  const [platform, kind, extra] = value.split(':')
  if (extra !== undefined) return
  if (!ALERT_LOOK_PLATFORMS.includes(platform as AlertPlatform)) return
  if (!ALERT_LOOK_KINDS.includes(kind as (typeof ALERT_LOOK_KINDS)[number])) return
  return `${platform}:${kind}`
}

function looksHasContent(looks: AlertLooks) {
  if (looks.default) return true
  if (looks.platforms && Object.keys(looks.platforms).length) return true
  if (looks.kinds && Object.keys(looks.kinds).length) return true
  if (looks.slots && Object.keys(looks.slots).length) return true
  return false
}

/** Drop unknown keys and malformed assets. Empty / missing looks mean pill-only. */
export function parseAlertLooks(value: unknown): AlertLooks | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const raw = value as Record<string, unknown>
  const looks: AlertLooks = {}
  const fallback = parseAlertLook(raw.default)
  if (fallback) looks.default = fallback
  if (raw.platforms && typeof raw.platforms === 'object' && !Array.isArray(raw.platforms)) {
    const platforms: NonNullable<AlertLooks['platforms']> = {}
    for (const platform of ALERT_LOOK_PLATFORMS) {
      const look = parseAlertLook((raw.platforms as Record<string, unknown>)[platform])
      if (look) platforms[platform] = look
    }
    if (Object.keys(platforms).length) looks.platforms = platforms
  }
  if (raw.kinds && typeof raw.kinds === 'object' && !Array.isArray(raw.kinds)) {
    const kinds: NonNullable<AlertLooks['kinds']> = {}
    const incoming = raw.kinds as Record<string, unknown>
    for (const kind of ALERT_LOOK_KINDS) {
      const look = parseAlertLook(incoming[kind])
      if (look) kinds[kind] = look
    }
    if (Object.keys(kinds).length) looks.kinds = kinds
  }
  if (raw.slots && typeof raw.slots === 'object' && !Array.isArray(raw.slots)) {
    const slots: NonNullable<AlertLooks['slots']> = {}
    for (const [key, item] of Object.entries(raw.slots as Record<string, unknown>)) {
      const slot = lookSlotKey(key)
      const look = parseAlertLook(item)
      if (slot && look) slots[slot] = look
    }
    if (Object.keys(slots).length) looks.slots = slots
  }
  if (!looksHasContent(looks)) return
  return looks
}

function overlayField<T>(overlay: T | null | undefined, base: T | null | undefined): T | undefined {
  if (overlay === undefined) return base ?? undefined
  if (overlay === null) return
  return overlay
}

/** Most-specific overlay wins per field. `null` clears the inherited value. */
export function mergeAlertLook(base: AlertLook, overlay: AlertLook): AlertLook {
  const image = overlayField(overlay.image, base.image)
  const video = overlayField(overlay.video, base.video)
  const audio = overlayField(overlay.audio, base.audio)
  const textBoxes = overlayField(overlay.textBoxes, base.textBoxes)
  const displaySec = overlayField(overlay.displaySec, base.displaySec)
  const look: AlertLook = {}
  if (image) look.image = image
  if (video) look.video = video
  if (audio) look.audio = audio
  if (textBoxes) look.textBoxes = textBoxes
  if (displaySec != null) look.displaySec = displaySec
  return look
}

/**
 * `platform+kind` → `platform` → `kind` → `default`. A Twitch base covers a
 * Follow-for-everyone look. Missing looks (or an empty merge) use the pill.
 */
export function resolveAlertLook(settings: Pick<AlertSettings, 'looks'> | undefined, event: { platform: string; kind: string }): AlertLook | undefined {
  const looks = settings?.looks
  if (!looks) return
  const layers = [
    looks.default,
    looks.kinds?.[event.kind],
    looks.platforms?.[event.platform as AlertPlatform],
    looks.slots?.[`${event.platform}:${event.kind}`],
  ]
  let merged: AlertLook = {}
  for (const layer of layers) {
    if (layer) merged = mergeAlertLook(merged, layer)
  }
  if (!Object.keys(merged).length) return
  return merged
}

/** Graphic or placed text means a custom overlay. Audio-only still uses the pill. */
export function usesCustomAlertLook(look: AlertLook | undefined) {
  if (!look) return false
  if (look.image || look.video) return true
  return Boolean(look.textBoxes && look.textBoxes.length)
}

function takeLookAssetId(ids: Set<string>, ref: AlertAssetRef | null | undefined) {
  if (ref && isAlertAssetId(ref.id)) ids.add(ref.id.toLowerCase())
}

/** Every image / video / audio UUID still referenced by a looks tree. */
export function collectLookAssetIds(looks: AlertLooks | undefined | null): string[] {
  const ids = new Set<string>()
  if (!looks) return []
  const take = (look?: AlertLook | null) => {
    if (!look) return
    takeLookAssetId(ids, look.image)
    takeLookAssetId(ids, look.video)
    takeLookAssetId(ids, look.audio)
  }
  take(looks.default)
  if (looks.platforms) for (const look of Object.values(looks.platforms)) take(look)
  if (looks.kinds) for (const look of Object.values(looks.kinds)) take(look)
  if (looks.slots) for (const look of Object.values(looks.slots)) take(look)
  return [...ids]
}

/**
 * Replace `{name}`-style tokens (case-sensitive). Known empty values collapse
 * leftover whitespace. Unknown `{tokens}` stay as written.
 */
export function fillAlertTemplate(template: string, values: Record<string, string>) {
  const filled = String(template ?? '').replace(/\{([a-z]+)\}/g, (token, key: string) => (
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] ?? '' : token
  ))
  return filled.replace(/[^\S\n]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim()
}
