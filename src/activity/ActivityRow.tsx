import { Bell, DollarSign, Gift, Heart, ShoppingBag, Swords, Twitch, UserPlus, Youtube, Zap } from 'lucide-react'

export type ActivityPlatform = 'Twitch' | 'Kick' | 'YouTube' | 'StreamElements'
export type ActivityKind = 'follow' | 'subscription' | 'gift' | 'cheer' | 'raid' | 'donation' | 'membership' | 'superchat' | 'merch'
export type ActivityEvent = {
  id: string
  platform: ActivityPlatform
  kind: ActivityKind
  user: string
  userId?: string
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

const kindLabel: Record<ActivityKind, string> = {
  follow: 'FOLLOW',
  subscription: 'SUBSCRIPTION',
  gift: 'GIFT',
  cheer: 'CHEER',
  raid: 'RAID',
  donation: 'DONATION',
  membership: 'MEMBER',
  superchat: 'SUPER CHAT',
  merch: 'MERCH',
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

function subtitle(event: ActivityEvent) {
  const bits: string[] = []
  if (event.amount) bits.push(event.amount)
  if (event.months) bits.push(`${event.months} mo`)
  if (event.viewers != null) bits.push(`${event.viewers.toLocaleString()} viewers`)
  if (event.message) bits.push(event.message)
  return bits.join(' · ')
}

export function profileHref(event: ActivityEvent) {
  if (event.profileUrl) return event.profileUrl
  const handle = event.user.replace(/^@+/, '').trim()
  if (!handle || /^anonymous$/i.test(handle) || handle === 'TestUser') return
  const source = event.source || event.platform
  if (source === 'Twitch') return `https://www.twitch.tv/${encodeURIComponent(handle)}`
  if (source === 'Kick') return `https://kick.com/${encodeURIComponent(handle)}`
  if (source === 'YouTube') {
    if (event.userId && /^UC[\w-]{20,}$/i.test(event.userId)) return `https://www.youtube.com/channel/${encodeURIComponent(event.userId)}`
    return `https://www.youtube.com/@${encodeURIComponent(handle)}`
  }
  return `https://www.twitch.tv/${encodeURIComponent(handle)}`
}

export function ActivityRow({ event, age }: { event: ActivityEvent; age: string }) {
  const source = event.source || event.platform
  const color = platformColor[event.platform]
  const badge = kindColor(event)
  const detail = subtitle(event)
  const href = profileHref(event)
  const openProfile = () => {
    if (!href) return
    void fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: href }) })
  }
  return (
    <button type="button" className={href ? 'activity-row activity-row-link' : 'activity-row'} style={{ ['--row-color' as string]: color }} title={href ? `Open ${event.user} on ${source}` : undefined} onClick={href ? openProfile : undefined}>
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
