/**
 * Companion alert designer: look targets, sample events, inherit labels,
 * and field writes. Preview uses these so editing default is not hidden by
 * a more-specific slot. No I/O.
 */

import { alertAssetKind, mergeAlertLook } from '../../server/logic/alert-looks'
import type { AlertAssetRef, AlertLook, AlertLooks, AlertPlatform, AlertTextBox } from '../../server/types'
import type { ActivityEvent } from '../activity/ActivityRow'
import { ALERT_TYPES } from './alerts'

export const ALERT_PREVIEW_WIDTH = 1000
export const ALERT_PREVIEW_HEIGHT = 250

/** Issue #160 v1 kind list. No Power-up. */
export const DESIGNER_KINDS = [
  { kind: 'follow', label: 'Follow' },
  { kind: 'subscription', label: 'Sub' },
  { kind: 'gift', label: 'Gift' },
  { kind: 'cheer', label: 'Cheer' },
  { kind: 'raid', label: 'Raid' },
  { kind: 'donation', label: 'Donation' },
  { kind: 'merch', label: 'Merch' },
  { kind: 'superchat', label: 'Super Chat' },
  { kind: 'membership', label: 'Membership' },
] as const

const KIND_LABEL = Object.fromEntries(DESIGNER_KINDS.map((item) => [item.kind, item.label])) as Record<string, string>

const KIND_PLATFORM: Record<string, AlertPlatform> = {
  follow: 'Twitch',
  subscription: 'Twitch',
  gift: 'Twitch',
  cheer: 'Twitch',
  raid: 'Twitch',
  donation: 'StreamElements',
  merch: 'StreamElements',
  superchat: 'YouTube',
  membership: 'YouTube',
}

export type LookTarget = { platform?: AlertPlatform; kind?: string }
export type LookLayerId = 'default' | 'platform' | 'kind' | 'slot'
export type AlertLookField = 'image' | 'video' | 'audio' | 'textBoxes' | 'displaySec'

export type InheritInfo = {
  own: boolean
  cleared: boolean
  from: string
  label: string
}

export type LookLayer = { id: LookLayerId; label: string; look?: AlertLook }

export function lookTargetKind(target: LookTarget): LookLayerId {
  if (target.platform && target.kind) return 'slot'
  if (target.platform) return 'platform'
  if (target.kind) return 'kind'
  return 'default'
}

export function lookTargetId(target: LookTarget) {
  if (target.platform && target.kind) return `${target.platform}:${target.kind}`
  if (target.platform) return target.platform
  if (target.kind) return `kind:${target.kind}`
  return 'default'
}

export function designerKindLabel(kind?: string) {
  if (!kind) return ''
  return KIND_LABEL[kind] || kind
}

export function designerKindsFor(platform?: AlertPlatform) {
  if (!platform) return DESIGNER_KINDS.map((item) => ({ kind: item.kind, label: item.label }))
  return ALERT_TYPES[platform].map((item) => ({ kind: item.kind, label: item.label }))
}

export function samplePlatformFor(target: LookTarget): AlertPlatform {
  if (target.platform) return target.platform
  if (target.kind && KIND_PLATFORM[target.kind]) return KIND_PLATFORM[target.kind]
  return 'Twitch'
}

export function sampleKindFor(target: LookTarget) {
  if (target.kind) return target.kind
  if (target.platform) return ALERT_TYPES[target.platform][0].kind
  return 'follow'
}

/** Sample event so the preview does not need a JWT or the flask. */
export function sampleAlertEvent(target: LookTarget): ActivityEvent {
  const platform = samplePlatformFor(target)
  const kind = sampleKindFor(target)
  const event: ActivityEvent = {
    id: 'sample',
    platform,
    kind: kind as ActivityEvent['kind'],
    user: 'Ada',
    time: '2026-01-01T12:00:00.000Z',
  }
  if (kind === 'subscription' || kind === 'membership') event.months = 4
  if (kind === 'subscription' && platform === 'Twitch') event.tier = '1000'
  if (kind === 'gift') {
    event.amount = '5 gifts'
    event.giftedBy = 'Cal'
  }
  if (kind === 'cheer') event.amount = platform === 'Kick' ? '100 Kicks' : '100 Bits'
  if (kind === 'raid') event.viewers = 12
  if (kind === 'donation') {
    event.amount = '$5'
    event.message = 'Thanks!'
  }
  if (kind === 'merch') {
    event.amount = '$20'
    event.message = 'Hat'
  }
  if (kind === 'superchat') {
    event.amount = '$5'
    event.message = 'Hi'
  }
  return event
}

function looksHasContent(looks: AlertLooks) {
  if (looks.default) return true
  if (looks.platforms && Object.keys(looks.platforms).length) return true
  if (looks.kinds && Object.keys(looks.kinds).length) return true
  if (looks.slots && Object.keys(looks.slots).length) return true
  return false
}

function lookHasKeys(look: AlertLook) {
  return Object.keys(look).length > 0
}

function stripNulls(look: AlertLook): AlertLook {
  const next: AlertLook = {}
  if (look.image) next.image = look.image
  if (look.video) next.video = look.video
  if (look.audio) next.audio = look.audio
  if (look.textBoxes) next.textBoxes = look.textBoxes
  if (look.displaySec) next.displaySec = look.displaySec
  return next
}

export function readLookLayer(looks: AlertLooks | undefined, target: LookTarget): AlertLook | undefined {
  if (!looks) return
  const mode = lookTargetKind(target)
  if (mode === 'default') return looks.default
  if (mode === 'platform') return looks.platforms?.[target.platform!]
  if (mode === 'kind') return looks.kinds?.[target.kind!]
  return looks.slots?.[`${target.platform}:${target.kind}`]
}

export function writeLookLayer(looks: AlertLooks | undefined, target: LookTarget, look: AlertLook | undefined): AlertLooks | undefined {
  const next: AlertLooks = {}
  if (looks?.default) next.default = looks.default
  if (looks?.platforms) next.platforms = { ...looks.platforms }
  if (looks?.kinds) next.kinds = { ...looks.kinds }
  if (looks?.slots) next.slots = { ...looks.slots }

  const mode = lookTargetKind(target)
  const stored = look && lookHasKeys(mode === 'default' ? stripNulls(look) : look)
    ? (mode === 'default' ? stripNulls(look) : look)
    : undefined

  if (mode === 'default') {
    if (stored) next.default = stored
    else delete next.default
  } else if (mode === 'platform' && target.platform) {
    const platforms = { ...(next.platforms || {}) }
    if (stored) platforms[target.platform] = stored
    else delete platforms[target.platform]
    if (Object.keys(platforms).length) next.platforms = platforms
    else delete next.platforms
  } else if (mode === 'kind' && target.kind) {
    const kinds = { ...(next.kinds || {}) }
    if (stored) kinds[target.kind] = stored
    else delete kinds[target.kind]
    if (Object.keys(kinds).length) next.kinds = kinds
    else delete next.kinds
  } else if (target.platform && target.kind) {
    const slots = { ...(next.slots || {}) }
    const key = `${target.platform}:${target.kind}`
    if (stored) slots[key] = stored
    else delete slots[key]
    if (Object.keys(slots).length) next.slots = slots
    else delete next.slots
  }

  return looksHasContent(next) ? next : undefined
}

export function setLookField<K extends AlertLookField>(
  looks: AlertLooks | undefined,
  target: LookTarget,
  field: K,
  value: AlertLook[K] | undefined,
): AlertLooks | undefined {
  const current = { ...(readLookLayer(looks, target) || {}) }
  if (value === undefined) delete current[field]
  else current[field] = value
  return writeLookLayer(looks, target, current)
}

/** Image or short video in one graphic slot. Setting one clears the other on this layer. */
export function setLookGraphic(looks: AlertLooks | undefined, target: LookTarget, asset: AlertAssetRef | null): AlertLooks | undefined {
  const inherit = lookTargetKind(target) !== 'default'
  if (!asset) {
    let next = setLookField(looks, target, 'image', inherit ? null : undefined)
    next = setLookField(next, target, 'video', inherit ? null : undefined)
    return next
  }
  const kind = alertAssetKind(asset.mime)
  if (kind === 'video') {
    let next = setLookField(looks, target, 'video', asset)
    next = setLookField(next, target, 'image', inherit ? null : undefined)
    return next
  }
  let next = setLookField(looks, target, 'image', asset)
  next = setLookField(next, target, 'video', inherit ? null : undefined)
  return next
}

export function setLookAudio(looks: AlertLooks | undefined, target: LookTarget, asset: AlertAssetRef | null): AlertLooks | undefined {
  const inherit = lookTargetKind(target) !== 'default'
  return setLookField(looks, target, 'audio', asset || (inherit ? null : undefined))
}

export function layersForTarget(looks: AlertLooks | undefined, target: LookTarget): LookLayer[] {
  const mode = lookTargetKind(target)
  const layers: LookLayer[] = [{ id: 'default', label: 'default', look: looks?.default }]
  if (mode === 'platform' || mode === 'slot') {
    layers.push({ id: 'platform', label: target.platform || 'platform', look: looks?.platforms?.[target.platform!] })
  }
  if (mode === 'kind' || mode === 'slot') {
    layers.push({ id: 'kind', label: designerKindLabel(target.kind) || 'kind', look: looks?.kinds?.[target.kind!] })
  }
  if (mode === 'slot') {
    layers.push({
      id: 'slot',
      label: `${target.platform} ${designerKindLabel(target.kind)}`.trim(),
      look: looks?.slots?.[`${target.platform}:${target.kind}`],
    })
  }
  return layers
}

/**
 * Cascade only through layers up to the edited target, so a Twitch:follow
 * slot does not hide the default look while you are editing default.
 */
export function resolveAlertLookForTarget(looks: AlertLooks | undefined, target: LookTarget): AlertLook | undefined {
  let merged: AlertLook = {}
  for (const layer of layersForTarget(looks, target)) {
    if (layer.look) merged = mergeAlertLook(merged, layer.look)
  }
  if (!Object.keys(merged).length) return
  return merged
}

function inheritFromLayers(
  layers: LookLayer[],
  pick: (look: AlertLook) => unknown,
  none: InheritInfo,
  noun: string,
): InheritInfo {
  let from = ''
  let value: unknown
  for (const layer of layers) {
    if (!layer.look) continue
    const next = pick(layer.look)
    if (next === undefined) continue
    from = layer.label
    value = next
  }
  const targetLayer = layers[layers.length - 1]
  const own = Boolean(from && targetLayer && from === targetLayer.label)
  if (value == null) {
    if (!from) return none
    if (own) return { own: true, cleared: true, from: 'this look', label: `${noun} cleared` }
    return { own: false, cleared: true, from, label: `${noun} cleared on ${from}` }
  }
  const labelFrom = own ? 'this look' : from
  return { own, cleared: false, from: labelFrom, label: `${noun} from ${labelFrom}` }
}

function inheritGraphic(layers: LookLayer[]): InheritInfo {
  let image: AlertAssetRef | null | undefined
  let video: AlertAssetRef | null | undefined
  let imageFrom = ''
  let videoFrom = ''
  for (const layer of layers) {
    const look = layer.look
    if (!look) continue
    if (look.image !== undefined) {
      image = look.image
      imageFrom = layer.label
    }
    if (look.video !== undefined) {
      video = look.video
      videoFrom = layer.label
    }
  }
  const winning = video || image
  const from = video ? videoFrom : imageFrom
  const targetLayer = layers[layers.length - 1]
  const own = Boolean(from && targetLayer && from === targetLayer.label)
  if (!winning) {
    if (!from) return { own: false, cleared: false, from: 'none', label: 'Graphic: none (pill)' }
    if (own) return { own: true, cleared: true, from: 'this look', label: 'Graphic cleared' }
    return { own: false, cleared: true, from, label: `Graphic cleared on ${from}` }
  }
  const labelFrom = own ? 'this look' : from
  return { own, cleared: false, from: labelFrom, label: `Graphic from ${labelFrom}` }
}

export function inheritSources(looks: AlertLooks | undefined, target: LookTarget) {
  const layers = layersForTarget(looks, target)
  return {
    graphic: inheritGraphic(layers),
    sound: inheritFromLayers(
      layers,
      (look) => look.audio,
      { own: false, cleared: false, from: 'none', label: 'Sound: built-in' },
      'Sound',
    ),
    text: inheritFromLayers(
      layers,
      (look) => look.textBoxes,
      { own: false, cleared: false, from: 'none', label: 'Text: none' },
      'Text',
    ),
    time: inheritFromLayers(
      layers,
      (look) => look.displaySec,
      { own: false, cleared: false, from: 'global', label: 'Display time from global' },
      'Display time',
    ),
  }
}

/** Winning image or video after cascade up to the target. */
export function resolvedGraphic(look: AlertLook | undefined): AlertAssetRef | undefined {
  if (look?.video) return look.video
  if (look?.image) return look.image
}

export function defaultTextBox(): AlertTextBox {
  return { text: '{name}', x: 8, y: 40, width: 84, align: 'center', fontSize: 8, color: '#ffffff' }
}

function cloneBoxes(boxes: readonly AlertTextBox[]) {
  return boxes.map((box) => ({ ...box }))
}

/** Own text boxes, or a copy of inherited ones so the first edit stays on this layer. */
export function ownOrCopiedTextBoxes(looks: AlertLooks | undefined, target: LookTarget): AlertTextBox[] {
  const own = readLookLayer(looks, target)?.textBoxes
  if (Array.isArray(own)) return cloneBoxes(own)
  const inherited = resolveAlertLookForTarget(looks, target)?.textBoxes
  return Array.isArray(inherited) ? cloneBoxes(inherited) : []
}

export function setLookTextBoxes(looks: AlertLooks | undefined, target: LookTarget, boxes: AlertTextBox[]): AlertLooks | undefined {
  return setLookField(looks, target, 'textBoxes', boxes.slice(0, 8))
}

export function insertToken(template: string, token: string, start: number, end: number) {
  const piece = `{${token}}`
  const from = Math.max(0, Math.min(start, template.length))
  const to = Math.max(from, Math.min(end, template.length))
  const text = `${template.slice(0, from)}${piece}${template.slice(to)}`
  return { text, cursor: from + piece.length }
}


