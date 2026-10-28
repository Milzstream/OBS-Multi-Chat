/**
 * Display formatting for the activity dock: the human-readable label shown for
 * each alert kind and the subtitle line shown under the user's name.
 */

export const kindLabel = {
  follow: 'FOLLOW',
  subscription: 'SUBSCRIPTION',
  gift: 'GIFT',
  cheer: 'CHEER',
  raid: 'RAID',
  donation: 'DONATION',
  membership: 'MEMBER',
  superchat: 'SUPER CHAT',
  merch: 'MERCH',
} as const

const powerUpLabel: Record<string, string> = {
  gigantify: 'GIGANTIFY',
  'message-effect': 'MESSAGE EFFECT',
  celebration: 'CELEBRATION',
  custom: 'POWER-UP',
  other: 'POWER-UP',
}

export function activityKindLabel(event: { platform: string; kind: string; powerUp?: string }) {
  if (event.kind === 'cheer' && event.powerUp && powerUpLabel[event.powerUp]) return powerUpLabel[event.powerUp]
  if (event.platform === 'YouTube' && event.kind === 'subscription') return 'SUBSCRIBER'
  if (event.platform === 'Kick' && event.kind === 'cheer') return 'KICKS'
  return kindLabel[event.kind as keyof typeof kindLabel] || event.kind.toUpperCase()
}

const planLabel: Record<string, string> = { prime: 'PRIME', '1000': 'TIER 1', '2000': 'TIER 2', '3000': 'TIER 3' }

/** Twitch sub plan shown as its own chip beside the kind pill. Subs and gift subs carry one. */
export function activityPlanLabel(event: { kind: string; tier?: string }) {
  if ((event.kind !== 'subscription' && event.kind !== 'gift') || !event.tier) return
  return planLabel[event.tier]
}

/** Prime gets Prime blue so it stands out; paid tiers share a light Twitch purple. */
export function activityPlanColor(tier?: string) {
  return tier === 'prime' ? '#4fc3ff' : '#c4a3ff'
}

function luminance(hex: string) {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255)
  const [r, g, b] = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Near-black or white, whichever reads better on a pill color. The bright alert colors all get near-black. */
export function pillTextColor(background: string) {
  if (!/^#[0-9a-f]{6}$/i.test(background)) return '#fff'
  const light = luminance(background)
  const onDark = (light + 0.05) / (luminance('#0d1013') + 0.05)
  const onWhite = 1.05 / (light + 0.05)
  return onDark >= onWhite ? '#0d1013' : '#fff'
}

export const ACTIVITY_KIND_GROUPS = [
  { id: 'follow', label: 'Follow', kinds: ['follow'] },
  { id: 'sub', label: 'Sub / gift', kinds: ['subscription', 'gift'] },
  { id: 'cheer', label: 'Cheer / raid', kinds: ['cheer', 'raid'] },
  { id: 'donation', label: 'Donation / merch', kinds: ['donation', 'merch'] },
  { id: 'superchat', label: 'Super Chat / membership', kinds: ['superchat', 'membership'] },
] as const

export type ActivityKindGroupId = (typeof ACTIVITY_KIND_GROUPS)[number]['id']
export const ACTIVITY_KIND_GROUP_IDS = ACTIVITY_KIND_GROUPS.map((group) => group.id)

const kindsByGroup = new Map<string, readonly string[]>(ACTIVITY_KIND_GROUPS.map((group) => [group.id, group.kinds]))

/** Filter by platform and kind-group ids, then newest-first. Empty kind set hides every row. */
export function visibleActivityEvents<T extends { platform: string; kind: string; time: string }>(events: T[], platformFilter: string, kindGroupIds: readonly string[]) {
  const kinds = new Set(kindGroupIds.flatMap((id) => kindsByGroup.get(id) || []))
  const restrictKinds = kindGroupIds.length !== ACTIVITY_KIND_GROUPS.length
  const rows = events.filter((event) => {
    if (platformFilter !== 'All' && event.platform !== platformFilter) return false
    if (restrictKinds && !kinds.has(event.kind)) return false
    return true
  })
  return [...rows].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0))
}

/** Build the row's subtitle by joining whatever fields the event has: gifter, amount, streak months, viewer count, and/or message. */
export function activitySubtitle(event: { amount?: string; months?: number; viewers?: number; message?: string; giftedBy?: string }) {
  const bits: string[] = []
  if (event.giftedBy) bits.push(`Gift from ${event.giftedBy}`)
  if (event.amount) bits.push(event.amount)
  if (event.months) bits.push(`${event.months} mo`)
  if (event.viewers != null) bits.push(`${event.viewers.toLocaleString()} viewers`)
  if (event.message) bits.push(event.message)
  return bits.join(' · ')
}

/** A gifted sub this close to a gift by the same gifter belongs to it. Gift bombs land within seconds. */
export const GIFT_GROUP_MS = 2 * 60_000

type GroupableEvent = { id: string; platform: string; kind: string; user: string; handle?: string; time: string; amount?: string; tier?: string; giftedBy?: string; source?: string }
export type ActivityListRow<T> = { event: T; nested: boolean; synthetic?: boolean }

function giftKey(value?: string) {
  return String(value || '').replace(/^@+/, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function at(event: { time: string }) {
  return Date.parse(event.time) || 0
}

/**
 * The dock's row list. With grouping on, each gifted sub moves under its
 * gifter's gift row, oldest first. Gifted subs with no gift row nearby (a
 * single sub gifted to one person, or a gift that came from another source)
 * get a gift row made up from them. Expects `events` newest first, as
 * `visibleActivityEvents` returns them.
 */
export function activityListRows<T extends GroupableEvent>(events: T[], groupGifts: boolean): ActivityListRow<T>[] {
  if (!groupGifts) return events.map((event) => ({ event, nested: false }))
  const gifts = events.filter((event) => event.kind === 'gift')
  // A "3 gifts" row takes at most three subs, so a later gift by the same person starts its own group.
  const room = new Map(gifts.map((gift) => [gift.id, Number(String(gift.amount || '').match(/^(\d+)/)?.[1]) || Infinity]))
  const children = new Map<string, T[]>()
  const orphans: T[] = []
  for (const event of [...events].sort((left, right) => at(left) - at(right))) {
    if (event.kind !== 'subscription' || !event.giftedBy) continue
    const key = giftKey(event.giftedBy)
    let best: T | undefined
    for (const gift of gifts) {
      if (gift.platform !== event.platform || (room.get(gift.id) || 0) <= 0) continue
      if (giftKey(gift.user) !== key && giftKey(gift.handle) !== key) continue
      const gap = Math.abs(at(gift) - at(event))
      if (gap > GIFT_GROUP_MS) continue
      if (!best || gap < Math.abs(at(best) - at(event))) best = gift
    }
    if (!best) {
      orphans.push(event)
      continue
    }
    room.set(best.id, (room.get(best.id) || 0) - 1)
    children.set(best.id, [...(children.get(best.id) || []), event])
  }
  // Orphans from the same gifter close together share one made-up gift row.
  const made: Array<{ parent: T; kids: T[] }> = []
  for (const event of [...orphans].sort((left, right) => at(left) - at(right))) {
    const group = made.find((item) => item.parent.platform === event.platform && giftKey(item.parent.user) === giftKey(event.giftedBy) && at(event) - at(item.kids[item.kids.length - 1]) <= GIFT_GROUP_MS)
    if (group) {
      group.kids.push(event)
      continue
    }
    made.push({ parent: { ...event, id: `gift-group-${event.id}`, kind: 'gift', user: event.giftedBy || 'Anonymous', handle: undefined, giftedBy: undefined } as T, kids: [event] })
  }
  for (const group of made) {
    const count = group.kids.length
    const tiers = new Set(group.kids.map((kid) => kid.tier))
    Object.assign(group.parent, {
      time: group.kids[count - 1].time,
      amount: `${count} gift${count === 1 ? '' : 's'}`,
      tier: tiers.size === 1 ? group.kids[0].tier : undefined,
      months: undefined,
      message: undefined,
      userId: undefined,
    })
  }
  const nested = new Set([...children.values(), ...made.map((group) => group.kids)].flat().map((event) => event.id))
  const madeById = new Map(made.map((group) => [group.parent.id, group]))
  const top = [...events.filter((event) => !nested.has(event.id)), ...made.map((group) => group.parent)].sort((left, right) => at(right) - at(left))
  const rows: ActivityListRow<T>[] = []
  for (const event of top) {
    const group = madeById.get(event.id)
    rows.push({ event, nested: false, ...(group ? { synthetic: true } : {}) })
    const kids = group ? group.kids : [...(children.get(event.id) || [])].sort((left, right) => at(left) - at(right))
    for (const kid of kids) rows.push({ event: kid, nested: true })
  }
  return rows
}
