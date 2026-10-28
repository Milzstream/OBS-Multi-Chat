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

/** Twitch sub plan shown as its own chip beside the kind pill. Only subs carry one. */
export function activityPlanLabel(event: { kind: string; tier?: string }) {
  if (event.kind !== 'subscription' || !event.tier) return
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

/** Build the row's subtitle by joining whatever fields the event has: amount, streak months, viewer count, and/or message. */
export function activitySubtitle(event: { amount?: string; months?: number; viewers?: number; message?: string }) {
  const bits: string[] = []
  if (event.amount) bits.push(event.amount)
  if (event.months) bits.push(`${event.months} mo`)
  if (event.viewers != null) bits.push(`${event.viewers.toLocaleString()} viewers`)
  if (event.message) bits.push(event.message)
  return bits.join(' · ')
}
