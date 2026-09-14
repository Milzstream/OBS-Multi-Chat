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

/** Build the row's subtitle by joining whatever fields the event has: amount, streak months, viewer count, and/or message. */
export function activitySubtitle(event: { amount?: string; months?: number; viewers?: number; message?: string }) {
  const bits: string[] = []
  if (event.amount) bits.push(event.amount)
  if (event.months) bits.push(`${event.months} mo`)
  if (event.viewers != null) bits.push(`${event.viewers.toLocaleString()} viewers`)
  if (event.message) bits.push(event.message)
  return bits.join(' · ')
}
