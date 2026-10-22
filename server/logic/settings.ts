/**
 * Persisted AppSettings, alerts, auto live-check, StreamElements missing-JWT copy.
 */

import { type AlertSettings, type AppSettings, type AutoLiveCheck, type Platform } from '../types.js'
import { emptyStreamInfo, loadStreamInfo } from './stream-info.js'
import { loadYouTubeQuota } from './youtube-quota.js'

export function missingStreamElementsMessage(missing: string[]) {
  if (!missing.length) return
  const keys = missing.map((platform) => `STREAMELEMENTS_JWT_${platform.toUpperCase()}`).join(', ')
  if (missing.length === 3) return `Add STREAMELEMENTS_JWT_TWITCH, STREAMELEMENTS_JWT_KICK, and STREAMELEMENTS_JWT_YOUTUBE in the Relay Chat Dock window or production.env.`
  return `Missing StreamElements JWT${missing.length === 1 ? '' : 's'} for ${missing.join(', ')}. Add ${keys} in the Relay Chat Dock window or production.env.`
}


export function defaultAutoLiveCheck(): AutoLiveCheck {
  return { Twitch: true, Kick: true, YouTube: true }
}

/**
 * Missing keys stay on. Only an explicit `false` turns a platform's automatic
 * live-status poll off, so older settings.json files keep today's behavior.
 */
export function parseAutoLiveCheck(value: unknown): AutoLiveCheck {
  const defaults = defaultAutoLiveCheck()
  if (!value || typeof value !== 'object') return defaults
  const parsed = value as Partial<Record<Platform, unknown>>
  return {
    Twitch: parsed.Twitch === false ? false : defaults.Twitch,
    Kick: parsed.Kick === false ? false : defaults.Kick,
    YouTube: parsed.YouTube === false ? false : defaults.YouTube,
  }
}

/** Apply a partial `{ Twitch?: boolean }` patch. Non-booleans are ignored. */
export function mergeAutoLiveCheck(current: AutoLiveCheck, patch: unknown): AutoLiveCheck {
  if (!patch || typeof patch !== 'object') return current
  const incoming = patch as Partial<Record<Platform, unknown>>
  const next = { ...current }
  for (const platform of ['Twitch', 'Kick', 'YouTube'] as const) {
    if (typeof incoming[platform] === 'boolean') next[platform] = incoming[platform]
  }
  return next
}

/**
 * Automatic live-status polls run only while that platform's Auto box is checked.
 * A manual Check live always runs. This does not gate chat sockets — callers
 * keep those up separately so an already-connected chat keeps updating.
 */

export const ALERT_DISPLAY_MIN = 1
export const ALERT_DISPLAY_MAX = 30
const ALERT_PLATFORMS = ['Twitch', 'Kick', 'YouTube', 'StreamElements']
const ALERT_KINDS = ['follow', 'subscription', 'gift', 'cheer', 'raid', 'donation', 'membership', 'superchat', 'merch']

export function defaultAlertSettings(): AlertSettings {
  return { enabled: false, sound: true, showPlatform: true, displaySec: 5, disabled: [] }
}

/** Clamp a display time to whole-or-half seconds the page can honor. */
export function clampAlertSeconds(value: unknown, fallback = 5) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(ALERT_DISPLAY_MAX, Math.max(ALERT_DISPLAY_MIN, Math.round(number * 2) / 2))
}

/** Keep only well-formed `Platform:kind` keys, deduped. */
export function parseAlertDisabled(value: unknown) {
  if (!Array.isArray(value)) return []
  const keys = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const [platform, kind, extra] = item.split(':')
    if (extra === undefined && ALERT_PLATFORMS.includes(platform) && ALERT_KINDS.includes(kind)) keys.add(item)
  }
  return [...keys]
}

export function parseAlertSettings(value: unknown): AlertSettings {
  const defaults = defaultAlertSettings()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const parsed = value as Partial<AlertSettings>
  return {
    enabled: parsed.enabled === true,
    sound: parsed.sound !== false,
    showPlatform: parsed.showPlatform !== false,
    displaySec: clampAlertSeconds(parsed.displaySec, defaults.displaySec),
    disabled: parseAlertDisabled(parsed.disabled),
  }
}

export function defaultAppSettings(): AppSettings {
  return {
    alerts: defaultAlertSettings(),
    activityFallback: true,
    ignoreMissingJwt: false,
    dropOldAlerts: false,
    translateChat: true,
    autoLiveCheck: defaultAutoLiveCheck(),
    streamInfo: emptyStreamInfo(),
    youtubeQuota: { day: '', used: 0 },
  }
}

/** Coerce the persisted settings JSON into a known-good shape, filling missing keys with app defaults. */
export function parseAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return defaultAppSettings()
  const parsed = value as Partial<AppSettings>
  return {
    alerts: parseAlertSettings(parsed.alerts),
    activityFallback: parsed.activityFallback !== false,
    ignoreMissingJwt: parsed.ignoreMissingJwt === true,
    dropOldAlerts: parsed.dropOldAlerts === true,
    translateChat: parsed.translateChat !== false,
    autoLiveCheck: parseAutoLiveCheck(parsed.autoLiveCheck),
    streamInfo: loadStreamInfo(parsed.streamInfo),
    youtubeQuota: loadYouTubeQuota(parsed.youtubeQuota),
    ...(typeof parsed.lanWatch === 'boolean' ? { lanWatch: parsed.lanWatch } : {}),
  }
}
