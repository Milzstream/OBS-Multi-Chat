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

export function activitySubtitle(event: { amount?: string; months?: number; viewers?: number; message?: string }) {
  const bits: string[] = []
  if (event.amount) bits.push(event.amount)
  if (event.months) bits.push(`${event.months} mo`)
  if (event.viewers != null) bits.push(`${event.viewers.toLocaleString()} viewers`)
  if (event.message) bits.push(event.message)
  return bits.join(' · ')
}
