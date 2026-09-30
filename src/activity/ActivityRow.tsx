import { Bell, DollarSign, Gift, Heart, ShoppingBag, Swords, Twitch, UserPlus, Youtube, Zap } from 'lucide-react'
import { chatProfileUrl, openDockUrl, profileLinkTitle } from '../chat-helpers'
import { activitySubtitle, kindLabel } from './format'

/**
 * One activity row for the dock: platform and kind icons, user, subtitle,
 * kind label, and relative age. Also derives the profile link a row can open.
 */

export type ActivityPlatform = 'Twitch' | 'Kick' | 'YouTube' | 'StreamElements'
export type ActivityKind = 'follow' | 'subscription' | 'gift' | 'cheer' | 'raid' | 'donation' | 'membership' | 'superchat' | 'merch'
export type ActivityEvent = {
  id: string
  platform: ActivityPlatform
  kind: ActivityKind
  user: string
  userId?: string
  handle?: string
  amount?: string
  months?: number
  viewers?: number
  message?: string
  time: string
  profileUrl?: string
  source?: ActivityPlatform
}

export const platformColor: Record<ActivityPlatform, string> = {
  Twitch: '#a970ff',
  Kick: '#62c554',
  YouTube: '#ff5b62',
  StreamElements: '#f3af61',
}

function kindColor(event: ActivityEvent) {
  if (event.kind === 'follow') return platformColor[event.platform]
  if (event.kind === 'subscription' || event.kind === 'membership' || event.kind === 'gift') return '#ff4d57'
  if (event.kind === 'donation' || event.kind === 'merch') return '#f3af61'
  if (event.kind === 'raid') return '#f3af61'
  if (event.kind === 'cheer') return event.platform === 'Twitch' ? '#00d4ff' : platformColor[event.platform]
  return platformColor[event.platform]
}

export function PlatformMark({ platform, size = 13 }: { platform: ActivityPlatform; size?: number }) {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  if (platform === 'Kick') return <span className="kick-mark">K</span>
  return <Bell size={size} strokeWidth={2.5} />
}

function KindIcon({ kind }: { kind: ActivityKind }) {
  const size = 13
  if (kind === 'follow') return <UserPlus size={size} />
  if (kind === 'gift') return <Gift size={size} />
  if (kind === 'cheer' || kind === 'superchat') return <Zap size={size} />
  if (kind === 'donation') return <DollarSign size={size} />
  if (kind === 'merch') return <ShoppingBag size={size} />
  if (kind === 'raid') return <Swords size={size} />
  return <Heart size={size} />
}

/**
 * Derive the profile URL a row links out to. Twitch uses the viewer card when
 * the broadcaster login is known, otherwise the public profile. YouTube is the
 * channel page. A stored URL is only a fallback for events we cannot rebuild.
 */
export function profileHref(event: ActivityEvent, channelLogin?: string) {
  const source = event.source || event.platform
  return chatProfileUrl({ platform: source, user: event.user, userId: event.userId, handle: event.handle }, channelLogin) || event.profileUrl
}

export function ActivityRow({ event, age, channelLogin }: { event: ActivityEvent; age: string; channelLogin?: string }) {
  const source = event.source || event.platform
  const color = platformColor[event.platform]
  const badge = kindColor(event)
  const detail = activitySubtitle(event)
  const href = profileHref(event, source === 'Twitch' ? channelLogin : undefined)
  const openProfile = () => {
    if (!href) return
    openDockUrl(href)
  }
  return (
    <button type="button" className={href ? 'activity-row activity-row-link' : 'activity-row'} style={{ ['--row-color' as string]: color }} title={href ? profileLinkTitle(source) : undefined} onClick={href ? openProfile : undefined}>
      <span className="activity-icon" style={{ color: platformColor[source] }} title={source}><PlatformMark platform={source} /></span>
      <span className="activity-icon" style={{ color }}><KindIcon kind={event.kind} /></span>
      <div className="activity-copy">
        <strong>{event.user}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
      <span className="activity-kind" style={{ background: badge, color: '#fff' }}>{kindLabel[event.kind]}</span>
      <time className="activity-age">{age}</time>
    </button>
  )
}
