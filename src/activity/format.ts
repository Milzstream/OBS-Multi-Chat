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
