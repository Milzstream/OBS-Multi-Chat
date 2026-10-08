import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Hash, Radio, Twitch, Users, Youtube } from 'lucide-react'
import { ActivityRow, platformColor, type ActivityEvent, type ActivityPlatform } from './activity/ActivityRow'
import { useAutoScroll, ScrollPausedBadge } from './autoScroll'
import { chatProfileUrl, dockAvatarSrc, preferredCategory, profileLinkTitle, visibleChatMessages, youtubePrivacyMessage, type ChatPlatform, type YoutubePrivacyNotice } from './chat-helpers'
import { ACTIVITY_KIND_GROUP_IDS, visibleActivityEvents } from './activity/format'
import { ACTIVITY_FILTERS, CHAT_FILTERS, type ActivityFilter, type ChatFilter } from './dock-prefs'
import { activityDockFields, applyActivitySlice, chatDockFields, subscribeDockSse } from './sse'
import { ACTIVITY_ROW_ESTIMATE, CHAT_ROW_ESTIMATE_COMPACT, useVirtualWindow } from './virtualList'

/**
 * Readonly LAN page. Chat and activity only: no composer, mod menu, settings,
 * stream controls, or `/api/open`. A username opens that profile in this
 * browser, not on the streaming PC.
 */

type Platform = ChatPlatform
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean; channelId?: string }
type StreamDetails = { title: string; category: string }
type MessagePart = { type: 'text'; text: string } | { type: 'emote'; name: string; url: string }
type ChatBadge = { title: string; url?: string; label?: string }
type ChatMessage = { id: string; platform: Platform; platforms?: Platform[]; user: string; text: string; time: string; parts?: MessagePart[]; userId?: string; handle?: string; avatar?: string; color?: string; badges?: ChatBadge[]; deleted?: boolean; originalText?: string }
type Health = { status: 'ok' | 'warn' | 'down'; message: string }

const platformMeta: Record<Platform, { color: string }> = {
  Twitch: { color: '#a970ff' },
  Kick: { color: '#62c554' },
  YouTube: { color: '#ff5b62' },
}

function platformIcon(platform: Platform | ActivityPlatform, size = 13) {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  if (platform === 'StreamElements') return <Bell size={size} strokeWidth={2.5} />
  return <span className="kick-mark">K</span>
}

function watchMediaSrc(url: string | undefined, token: string) {
  const src = dockAvatarSrc(url)
  if (!src || !token || !src.startsWith('/api/media?')) return src
  return `${src}&token=${encodeURIComponent(token)}`
}

function displayLetter(name: string) {
  const cleaned = name.replace(/^@+/, '')
  return (cleaned.match(/[\p{L}\p{N}]/u)?.[0] || cleaned[0] || '?').toUpperCase()
}

function relativeTime(iso: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export default function WatchApp() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [streamTitle, setStreamTitle] = useState('')
  const [streamGame, setStreamGame] = useState('')
  const [health, setHealth] = useState<Record<string, Health>>({})
  const [chatWarnings, setChatWarnings] = useState<string[]>([])
  const [youtubePrivacy, setYoutubePrivacy] = useState<YoutubePrivacyNotice[]>([])
  const [translateChat, setTranslateChat] = useState(true)
  const [chatFilter, setChatFilter] = useState<ChatFilter>('All')
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('All')
  const [twitchChannel, setTwitchChannel] = useState('')
  const [now, setNow] = useState(Date.now())
  const [online, setOnline] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)
  const activityRef = useRef<HTMLDivElement>(null)
  const token = new URLSearchParams(location.search).get('token')?.trim() || ''

  useEffect(() => { document.title = 'Relay Watch' }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const apply = (remote: Record<string, unknown>) => {
      const chat = chatDockFields(remote)
      const activity = activityDockFields(remote)
      if (chat.accounts) {
        const accounts = chat.accounts as Connection[]
        setConnections(accounts)
        setTwitchChannel(accounts.find((item) => item.platform === 'Twitch' && item.connected)?.handle || '')
      }
      if (chat.messages) setMessages(chat.messages as ChatMessage[])
      if (chat.health) setHealth(chat.health as Record<string, Health>)
      if (chat.chatWarnings) setChatWarnings(chat.chatWarnings as string[])
      if (chat.youtubePrivacy) setYoutubePrivacy(chat.youtubePrivacy as YoutubePrivacyNotice[])
      if (chat.streamInfo) {
        const info = chat.streamInfo as { Twitch?: StreamDetails; Kick?: StreamDetails }
        const title = info.Twitch?.title || info.Kick?.title || ''
        setStreamTitle(title)
        setStreamGame(preferredCategory(info.Twitch?.category || '', info.Kick?.category || ''))
      }
      if (activity.activity || activity.activityEvent) setEvents((previous) => applyActivitySlice(previous, activity))
      if (typeof activity.translateChat === 'boolean') setTranslateChat(activity.translateChat)
      setOnline(true)
    }
    return subscribeDockSse({
      token,
      onSnapshot: apply,
      onChat: (data) => {
        const next = data.messages
        if (Array.isArray(next)) setMessages(next as ChatMessage[])
      },
      onActivity: apply,
      onPresence: apply,
      onSettings: apply,
      onStatus: setOnline,
    })
  }, [token])

  const visibleMessages = visibleChatMessages(messages, chatFilter)
  const visibleActivity = useMemo(() => visibleActivityEvents(events, activityFilter, ACTIVITY_KIND_GROUP_IDS), [events, activityFilter])
  const { paused: chatPaused, onScroll: onChatPin, resume: resumeChat } = useAutoScroll(chatRef, 'bottom', visibleMessages[visibleMessages.length - 1]?.id)
  const chatWindow = useVirtualWindow(chatRef, visibleMessages.length, CHAT_ROW_ESTIMATE_COMPACT, 'bottom', !chatPaused, onChatPin)
  const { paused: activityPaused, onScroll: onActivityPin, resume: resumeActivity } = useAutoScroll(activityRef, 'top', visibleActivity[0]?.id)
  const activityWindow = useVirtualWindow(activityRef, visibleActivity.length, ACTIVITY_ROW_ESTIMATE, 'top', !activityPaused, onActivityPin)
  const viewers = connections.filter((item) => item.connected && item.live).reduce((total, item) => total + item.viewers, 0)
  const live = connections.some((item) => item.connected && item.live)
  const notices = [
    ...(['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => health[platform]?.status !== 'ok' ? health[platform]?.message : '').filter(Boolean),
    ...chatWarnings,
    ...youtubePrivacy.map((item) => youtubePrivacyMessage(item)),
  ]

  return (
    <main className="watch-app compact">
      <header className="topbar">
        <div className="stream-ref">
          <span className="stream-title">{streamTitle || 'RELAY'}</span>
          {streamGame ? <span className="stream-game">{streamGame}</span> : null}
        </div>
        <span className={live ? 'live-pill' : 'offline-pill'}><span /> {live ? 'LIVE' : 'OFFLINE'}</span>
        <span className="watch-only">{online ? 'Watch only' : 'Offline'}</span>
      </header>
      <section className="presence-panel">
        <div className="viewer-total"><Users size={15} /><span><b>{viewers.toLocaleString()}</b> combined viewers</span></div>
        {notices.map((message) => <div key={message} className="health-banner warn">{message}</div>)}
      </section>
      <div className="watch-split">
        <section className="watch-pane chat-section">
          <div className="chat-toolbar">
            <div className="filter-tabs">
              {CHAT_FILTERS.map((filter) => (
                <button key={filter} type="button" className={chatFilter === filter ? 'filter active' : 'filter'} onClick={() => setChatFilter(filter)}>
                  {filter === 'All' ? <Hash size={13} /> : platformIcon(filter, 13)}
                  <span className="filter-label">{filter}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="chat-feed">
            <div className="chat-list" ref={chatRef} onScroll={chatWindow.onScroll}>
              {visibleMessages.length ? (
                <>
                  <div className="virtual-spacer" style={{ height: chatWindow.padTop }} aria-hidden="true" />
                  {visibleMessages.slice(chatWindow.start, chatWindow.end).map((message) => <WatchMessage key={message.id} message={message} channelLogin={twitchChannel} showTranslationMark={translateChat} token={token} />)}
                  <div className="virtual-spacer" style={{ height: chatWindow.padBottom }} aria-hidden="true" />
                </>
              ) : (
                <div className="empty-chat">
                  <div className="empty-icon"><Radio size={20} /></div>
                  <strong>Waiting for chat</strong>
                  <span>Messages show up here. This page cannot send or moderate.</span>
                </div>
              )}
            </div>
            {chatPaused ? <ScrollPausedBadge onResume={resumeChat} /> : null}
          </div>
        </section>
        <section className="watch-pane">
          <header className="activity-topbar">
            <span className="activity-title">ACTIVITY</span>
            <nav className="activity-filters">
              {ACTIVITY_FILTERS.map((filter) => (
                <button key={filter} type="button" className={activityFilter === filter ? 'activity-filter active' : 'activity-filter'} aria-label={filter === 'StreamElements' ? 'SE' : filter} title={filter === 'StreamElements' ? 'SE' : filter} onClick={() => setActivityFilter(filter)}>
                  {filter === 'All' ? <Hash size={13} /> : <span style={{ color: platformColor[filter] }}>{platformIcon(filter, 13)}</span>}
                </button>
              ))}
            </nav>
          </header>
          <section className="activity-feed">
            <div className="activity-list" ref={activityRef} onScroll={activityWindow.onScroll}>
              {visibleActivity.length ? (
                <>
                  <div className="virtual-spacer" style={{ height: activityWindow.padTop }} aria-hidden="true" />
                  {visibleActivity.slice(activityWindow.start, activityWindow.end).map((event) => (
                    <ActivityRow key={event.id} event={event} age={relativeTime(event.time, now)} channelLogin={twitchChannel} openIn="browser" />
                  ))}
                  <div className="virtual-spacer" style={{ height: activityWindow.padBottom }} aria-hidden="true" />
                </>
              ) : (
                <div className="empty-chat activity-empty">
                  <div className="empty-icon"><Radio size={20} /></div>
                  <strong>Waiting for activity</strong>
                  <span>Follows, subs, and tips show up here.</span>
                </div>
              )}
            </div>
            {activityPaused ? <ScrollPausedBadge onResume={resumeActivity} /> : null}
          </section>
        </section>
      </div>
    </main>
  )
}

function WatchAvatar({ name, src, color }: { name: string; src?: string; color: string }) {
  const [failed, setFailed] = useState(false)
  const showImage = Boolean(src) && !failed
  return <div className="avatar" style={{ backgroundColor: showImage ? 'transparent' : color }}>{showImage ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : displayLetter(name)}</div>
}

function WatchMessage({ message, channelLogin, showTranslationMark, token }: { message: ChatMessage; channelLogin?: string; showTranslationMark: boolean; token: string }) {
  const platforms = message.platforms || [message.platform]
  const parts = message.parts?.length ? message.parts : [{ type: 'text' as const, text: message.text }]
  const name = message.user.replace(/^@+/, '')
  const profileUrl = chatProfileUrl(message, channelLogin)
  return (
    <article className={message.deleted ? 'message deleted' : 'message'}>
      <WatchAvatar name={name} src={watchMediaSrc(message.avatar, token)} color={message.color || platformMeta[platforms[0]].color} />
      <div className="message-body">
        <div className="message-meta">
          <span className="platform-dot">{platforms.map((platform) => <span key={platform} style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 11)}</span>)}</span>
          {(message.badges || []).map((badge, index) => badge.url ? <img key={`${badge.title}-${index}`} className="chat-badge" src={badge.url} alt={badge.title} title={badge.title} referrerPolicy="no-referrer" /> : badge.label ? <span key={`${badge.title}-${index}`} className="chat-badge-label" title={badge.title}>{badge.label}</span> : null)}
          {profileUrl
            ? <a className="clickable-username" href={profileUrl} target="_blank" rel="noopener noreferrer" title={profileLinkTitle(message.platform)}><strong style={message.color ? { color: message.color } : undefined}>{name}</strong></a>
            : <strong style={message.color ? { color: message.color } : undefined}>{name}</strong>}
          <time>{new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
        </div>
        <p title={showTranslationMark ? message.originalText || undefined : undefined}>
          {parts.map((part, index) => part.type === 'emote' ? <img key={`${part.url}-${index}`} className="emote" src={watchMediaSrc(part.url, token)} alt={part.name} title={part.name} referrerPolicy="no-referrer" /> : <span key={index}>{part.text}</span>)}
          {showTranslationMark && message.originalText ? <span className="translated-mark" title={message.originalText}>EN</span> : null}
        </p>
      </div>
    </article>
  )
}
