/**
 * Pure logic for the on-stream alert page: which alert types can be toggled,
 * which sound group an event plays, and the one-at-a-time arrival queue.
 */

import { activityKindLabel, activityListRows, GIFT_GROUP_MS, type ActivityListRow } from '../activity/format'

export type AlertPlatform = 'Twitch' | 'Kick' | 'YouTube' | 'StreamElements'
export type AlertSoundGroup = 'follow' | 'sub' | 'cheer' | 'donation' | 'superchat' | 'raid'
export type AlertSettings = { enabled: boolean; sound: boolean; showPlatform: boolean; displaySec: number; disabled: string[]; kindSchema: number }
export type AlertEvent = { id: string; platform: string; kind: string; time: string }
export type AlertPresentEvent = AlertEvent & { user?: string; handle?: string; amount?: string; tier?: string; giftedBy?: string; powerUp?: string }

/** Power-up is its own disabled key. Older files inherit from Cheer once. Keep in sync with `server/logic/settings.ts`. */
export const ALERT_KIND_SCHEMA = 2
export const ALERT_POWERUP_KIND = 'powerup'

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { enabled: false, sound: true, showPlatform: true, displaySec: 5, disabled: [], kindSchema: ALERT_KIND_SCHEMA }

/** Platform-neutral wording and colors, so a pill never reveals which service the alert came from. */
export function neutralAlertLabel(event: { platform: string; kind: string; powerUp?: string }) {
  if (event.kind === 'cheer' && event.powerUp) return activityKindLabel(event)
  if (event.kind === 'follow') return 'FOLLOW'
  if (event.platform === 'YouTube' && event.kind === 'subscription') return 'FOLLOW'
  if (event.kind === 'subscription' || event.kind === 'membership') return 'SUBSCRIBER'
  if (event.kind === 'gift') return 'GIFT'
  if (event.kind === 'cheer' || event.kind === 'superchat') return 'CHEER'
  if (event.kind === 'raid') return 'RAID'
  if (event.kind === 'merch') return 'MERCH'
  return 'DONATION'
}

const NEUTRAL_COLORS: Record<string, string> = {
  FOLLOW: '#4aa3ff',
  SUBSCRIBER: '#ff4d57',
  GIFT: '#ff4d57',
  CHEER: '#00d4ff',
  GIGANTIFY: '#00d4ff',
  'MESSAGE EFFECT': '#00d4ff',
  CELEBRATION: '#00d4ff',
  'POWER-UP': '#00d4ff',
  RAID: '#f3af61',
  MERCH: '#f3af61',
  DONATION: '#f3af61',
}

export function neutralAlertColor(event: { platform: string; kind: string; powerUp?: string }) {
  return NEUTRAL_COLORS[neutralAlertLabel(event)]
}

/** Rewrite platform-specific currency words in an alert subtitle. */
export function neutralAlertText(text: string) {
  return text.replace(/\bkicks?\b/gi, 'Bits')
}

/** An alert older than this when it first appears is backfill, not something that just happened. */
export const ALERT_MAX_AGE_MS = 10 * 60 * 1000

export const ALERT_TYPES: Record<AlertPlatform, readonly { kind: string; label: string }[]> = {
  Twitch: [
    { kind: 'follow', label: 'Follow' },
    { kind: 'subscription', label: 'Subscription' },
    { kind: 'gift', label: 'Gift subs' },
    { kind: 'cheer', label: 'Cheer' },
    { kind: ALERT_POWERUP_KIND, label: 'Power-up' },
    { kind: 'raid', label: 'Raid' },
  ],
  Kick: [
    { kind: 'follow', label: 'Follow' },
    { kind: 'subscription', label: 'Subscription' },
    { kind: 'gift', label: 'Gifted subs' },
    { kind: 'cheer', label: 'KICKs' },
    { kind: 'raid', label: 'Raid' },
  ],
  YouTube: [
    { kind: 'subscription', label: 'Subscriber' },
    { kind: 'membership', label: 'Member' },
    { kind: 'gift', label: 'Gifted memberships' },
    { kind: 'superchat', label: 'Super Chat' },
  ],
  StreamElements: [
    { kind: 'donation', label: 'Donation' },
    { kind: 'merch', label: 'Merch' },
  ],
}

export const ALERT_PLATFORMS = Object.keys(ALERT_TYPES) as AlertPlatform[]

export function alertKey(platform: string, kind: string) {
  return `${platform}:${kind}`
}

/** Cheer rows with `powerUp` use the Power-up slot, not Cheer. */
export function alertKindKey(event: { kind: string; powerUp?: string }) {
  return event.powerUp ? ALERT_POWERUP_KIND : event.kind
}

export function isAlertAllowed(event: { platform: string; kind: string; powerUp?: string }, disabled: readonly string[]) {
  return !disabled.includes(alertKey(event.platform, alertKindKey(event)))
}

export function alertSoundGroup(kind: string): AlertSoundGroup {
  if (kind === 'follow') return 'follow'
  if (kind === 'subscription' || kind === 'membership' || kind === 'gift') return 'sub'
  if (kind === 'cheer' || kind === ALERT_POWERUP_KIND) return 'cheer'
  if (kind === 'donation' || kind === 'merch') return 'donation'
  if (kind === 'superchat') return 'superchat'
  return 'raid'
}

/** Old denylists only had Cheer. Copy that off-state onto Power-up so a quiet Cheer stays quiet. */
export function migrateAlertDisabled(disabled: readonly string[], kindSchema?: number) {
  if (kindSchema === ALERT_KIND_SCHEMA) return [...disabled]
  const keys = new Set(disabled)
  if (keys.has('Twitch:cheer')) keys.add(alertKey('Twitch', ALERT_POWERUP_KIND))
  return [...keys]
}

export function parseAlertSettings(value: unknown): AlertSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_ALERT_SETTINGS }
  const raw = value as Partial<AlertSettings>
  const seconds = Number(raw.displaySec)
  return {
    enabled: raw.enabled === true,
    sound: raw.sound !== false,
    showPlatform: raw.showPlatform !== false,
    displaySec: Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_ALERT_SETTINGS.displaySec,
    disabled: migrateAlertDisabled(Array.isArray(raw.disabled) ? raw.disabled.filter((item): item is string => typeof item === 'string') : [], raw.kindSchema),
    kindSchema: ALERT_KIND_SCHEMA,
  }
}

/**
 * Remembers which events the page has already seen. The first snapshot only
 * primes the set, so an OBS refresh never replays the feed. After that, every
 * unseen id comes back oldest-first so alerts play in arrival order.
 */
export function createAlertTracker(now: () => number = Date.now) {
  const seen = new Set<string>()
  let primed = false
  const remember = (id: string) => {
    seen.add(id)
    if (seen.size > 10_000) seen.delete(seen.values().next().value as string)
  }
  return {
    primed: () => primed,
    ingest<T extends AlertEvent>(events: readonly T[], prime = false): T[] {
      if (prime && !primed) {
        for (const event of events) remember(event.id)
        primed = true
        return []
      }
      if (!primed) return []
      const fresh: T[] = []
      for (const event of events) {
        if (seen.has(event.id)) continue
        remember(event.id)
        const age = now() - (Date.parse(event.time) || now())
        if (age > ALERT_MAX_AGE_MS) continue
        fresh.push(event)
      }
      return fresh.sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0))
    },
  }
}

function eventTime(event: { time: string }) {
  return Date.parse(event.time) || 0
}

function isGiftedSub(event: { kind: string; giftedBy?: string }) {
  return event.kind === 'subscription' && Boolean(event.giftedBy)
}

function giftParent<T extends { id: string }>(rows: ActivityListRow<T>[], childId: string) {
  let parent: ActivityListRow<T> | undefined
  for (const row of rows) {
    if (!row.nested) {
      parent = row
      continue
    }
    if (row.event.id === childId) return parent
  }
}

function childIds<T extends { id: string }>(rows: ActivityListRow<T>[], parentId: string) {
  const ids: string[] = []
  let take = false
  for (const row of rows) {
    if (!row.nested) {
      take = row.event.id === parentId
      continue
    }
    if (take) ids.push(row.event.id)
  }
  return ids
}

/**
 * On-stream feed: same prime/dedupe as the tracker, then gift bombs collapse
 * to one alert using the activity dock's grouping window.
 */
export function createAlertPresenter(now: () => number = Date.now) {
  const tracker = createAlertTracker(now)
  let recent: AlertPresentEvent[] = []
  const presented = new Set<string>()

  function groupedRows(events: readonly AlertPresentEvent[]) {
    const newestFirst = events
      .map((event) => ({ ...event, user: event.user || '' }))
      .sort((left, right) => eventTime(right) - eventTime(left))
    return activityListRows(newestFirst, true)
  }

  function collapse<T extends AlertPresentEvent>(event: T): T | undefined {
    if (event.kind !== 'gift' && !isGiftedSub(event)) return event
    const asOf = eventTime(event) || now()
    recent = [...recent.filter((item) => Math.abs(asOf - eventTime(item)) <= GIFT_GROUP_MS), event]
    const rows = groupedRows(recent)
    if (isGiftedSub(event)) {
      const parent = giftParent(rows, event.id)
      if (!parent || presented.has(parent.event.id) || !parent.synthetic) return
      presented.add(parent.event.id)
      return parent.event as T
    }
    if (presented.has(event.id)) return
    if (childIds(rows, event.id).some((id) => presented.has(`gift-group-${id}`))) {
      presented.add(event.id)
      return
    }
    presented.add(event.id)
    return event
  }

  return {
    primed: () => tracker.primed(),
    ingest<T extends AlertPresentEvent>(events: readonly T[], prime = false): T[] {
      const seeding = prime && !tracker.primed()
      const fresh = tracker.ingest(events, prime)
      if (seeding) {
        const asOf = now()
        recent = events.filter((event) => event.kind === 'gift' && Math.abs(asOf - eventTime(event)) <= GIFT_GROUP_MS)
        return []
      }
      const out: T[] = []
      for (const event of fresh) {
        const item = collapse(event)
        if (item) out.push(item)
      }
      return out
    },
  }
}

/** Append in arrival order. When over the cap, the oldest waiting alerts are dropped. */
export function enqueueAlerts<T>(queue: readonly T[], incoming: readonly T[], cap: number): T[] {
  const next = [...queue, ...incoming]
  const limit = Math.max(1, Math.floor(cap) || 1)
  return next.length > limit ? next.slice(next.length - limit) : next
}
