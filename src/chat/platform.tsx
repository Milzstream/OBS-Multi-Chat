import { Twitch, Youtube } from 'lucide-react'
import type { Platform } from '../../server/types'

export const platformMeta: Record<Platform, { color: string; route: string }> = {
  Twitch: { color: '#a970ff', route: 'twitch' },
  Kick: { color: '#62c554', route: 'kick' },
  YouTube: { color: '#ff5b62', route: 'youtube' },
}

export const platformIcon = (platform: Platform, size = 14) => {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  return <span className="kick-mark">K</span>
}
