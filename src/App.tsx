import { FormEvent, KeyboardEvent, MouseEvent, useEffect, useRef, useState } from 'react'
import { Check, Gamepad2, Hash, Link2, Radio, Send, Settings2, SlidersHorizontal, Twitch, Users, Youtube } from 'lucide-react'
import { ConnectionSettings } from './ConnectionSettings'
import { ScrollPausedBadge, useAutoScroll } from './autoScroll'
import { dockAvatarSrc, kickProfileSlug, mergeCategoryResults, nextOptionIndex, preferredCategory, selectedSendPlatforms, tagAssignments, tagPlatforms, visibleChatMessages, youtubeStudioUrl, type MergedCategory, type TagAssignment, type TagPlatform } from './chat-helpers'
import { chatDockFields, subscribeDockSse } from './sse'
import { CHAT_COMPACT_KEY, CHAT_FILTER_KEY, CHAT_FILTERS, parseStoredBoolean, parseStoredFilter, readLocalPref, writeLocalPref, type ChatFilter } from './dock-prefs'

/**
 * The chat dock UI: platform connections and live state, the message feed
 * with filtering, moderator actions, composer, stream controls, and settings.
 * Owns the SSE connection to Relay's backend via `subscribeDockSse` and keeps
 * the feed glued to the live edge via `useAutoScroll`.
 */

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean; channelId?: string }
type StreamPlatform = 'Twitch' | 'Kick'
type StreamDetails = { title: string; category: string; categoryId?: string; tags?: string[] }
type StreamDetailsByPlatform = { Twitch: StreamDetails; Kick: StreamDetails; YouTube: StreamDetails }
type CategoryOption = { id: string; name: string }
type MessagePart = { type: 'text'; text: string } | { type: 'emote'; name: string; url: string }
type ChatBadge = { title: string; url?: string; label?: string }
type ChatMessage = { id: string; platform: Platform; platforms?: Platform[]; user: string; text: string; time: string; emotes?: string[]; parts?: MessagePart[]; userId?: string; handle?: string; sourceId?: string; sourceLabel?: string; originalText?: string; avatar?: string; color?: string; badges?: ChatBadge[]; deleted?: boolean }
type Health = { status: 'ok' | 'warn' | 'down'; message: string }
type StreamElementsStatus = { connected: boolean; handle: string; missing?: string[] }
type YoutubeQuotaStatus = { used: number; limit: number }
type BackendState = { accounts: Connection[]; streamInfo: StreamDetailsByPlatform; messages: ChatMessage[]; health: Record<Platform, Health>; streamelements?: StreamElementsStatus; activityFallback?: boolean; ignoreMissingJwt?: boolean; dropOldAlerts?: boolean; translateChat?: boolean; translateError?: string; youtubeQuota?: YoutubeQuotaStatus }

const platformMeta: Record<Platform, { color: string; route: string }> = {
  Twitch: { color: '#a970ff', route: 'twitch' },
  Kick: { color: '#62c554', route: 'kick' },
  YouTube: { color: '#ff5b62', route: 'youtube' },
}
const initialConnections: Connection[] = [
  { platform: 'Twitch', viewers: 0, handle: '', connected: false, live: false },
  { platform: 'Kick', viewers: 0, handle: '', connected: false, live: false },
  { platform: 'YouTube', viewers: 0, handle: '', connected: false, live: false },
]
const initialStreamDetails: StreamDetailsByPlatform = { Twitch: { title: '', category: '' }, Kick: { title: '', category: '' }, YouTube: { title: '', category: '' } }
const initialHealth: Record<Platform, Health> = { Twitch: { status: 'ok', message: '' }, Kick: { status: 'ok', message: '' }, YouTube: { status: 'ok', message: '' } }

const platformIcon = (platform: Platform, size = 14) => {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  return <span className="kick-mark">K</span>
}

function App() {
  const [connections, setConnections] = useState(initialConnections)
  const [activeFilter, setActiveFilter] = useState<ChatFilter>(() => parseStoredFilter(readLocalPref(CHAT_FILTER_KEY), CHAT_FILTERS, 'All'))
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([])
  const sendOptOutRef = useRef<Set<Platform>>(new Set())
  const [composer, setComposer] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [compactMode, setCompactMode] = useState(() => parseStoredBoolean(readLocalPref(CHAT_COMPACT_KEY), true))
  const [showControls, setShowControls] = useState(false)
  const [streamDetails, setStreamDetails] = useState(initialStreamDetails)
  const [streamTitle, setStreamTitle] = useState('')
  const [backendOnline, setBackendOnline] = useState(false)
  const [sendStatus, setSendStatus] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [health, setHealth] = useState(initialHealth)
  const [youtubeQuota, setYoutubeQuota] = useState<YoutubeQuotaStatus>({ used: 0, limit: 10_000 })
  const [streamelements, setStreamelements] = useState<StreamElementsStatus>({ connected: false, handle: '' })
  const [activityFallback, setActivityFallback] = useState(true)
  const [ignoreMissingJwt, setIgnoreMissingJwt] = useState(false)
  const [dropOldAlerts, setDropOldAlerts] = useState(false)
  const [translateChat, setTranslateChat] = useState(true)
  const [translateError, setTranslateError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; message: ChatMessage } | null>(null)
  const liveConnections = connections.filter((connection) => connection.connected && connection.live)
  const connectedAccounts = connections.filter((connection) => connection.connected)
  const combinedViewers = liveConnections.reduce((total, connection) => total + connection.viewers, 0)
  const hasChat = liveConnections.length > 0
  const headerTitle = streamTitle || streamDetails.Twitch.title || streamDetails.Kick.title || 'RELAY'
  const twitchGame = streamDetails.Twitch.category
  const kickGame = streamDetails.Kick.category
  const headerGame = preferredCategory(twitchGame, kickGame)
  const headerTip = [headerTitle, twitchGame && `Twitch: ${twitchGame}`, kickGame && `Kick: ${kickGame}`].filter(Boolean).join('\n')
  const visibleMessages = visibleChatMessages(messages, activeFilter)
  const chatListRef = useRef<HTMLDivElement>(null)
  // Auto-scroll: keeps the feed pinned to the bottom while the user is not
  // scrolling up, snapping again whenever a new tail message arrives
  const { paused: chatPaused, onScroll: onChatScroll, resume: resumeChatScroll } = useAutoScroll(chatListRef, 'bottom', visibleMessages[visibleMessages.length - 1]?.id)
  useEffect(() => {
    writeLocalPref(CHAT_FILTER_KEY, activeFilter)
  }, [activeFilter])
  useEffect(() => {
    writeLocalPref(CHAT_COMPACT_KEY, String(compactMode))
  }, [compactMode])
  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close) }
  }, [])

  useEffect(() => {
    const connected = connections.filter((connection) => connection.connected).map((connection) => connection.platform)
    setSelectedPlatforms(selectedSendPlatforms(connected, sendOptOutRef.current))
  }, [connections])

  useEffect(() => {
    // Subscribe to Relay's SSE stream; every frame type funnels back into
    // applySnapshot so the dock mirrors backend state (messages, health, ...)
    const applySnapshot = (remote: BackendState) => {
      const fields = chatDockFields(remote as unknown as Record<string, unknown>)
      if (fields.accounts) setConnections((prev) => JSON.stringify(prev) !== JSON.stringify(fields.accounts) ? fields.accounts as Connection[] : prev)
      if (fields.messages) setMessages((prev) => JSON.stringify(prev) !== JSON.stringify(fields.messages) ? fields.messages as ChatMessage[] : prev)
      if (fields.health) {
        const health = fields.health as Record<Platform, Health>
        setHealth((prev) => JSON.stringify(prev) !== JSON.stringify(health) ? health : prev)
      }
      if (fields.youtubeQuota) {
        const youtubeQuota = fields.youtubeQuota as YoutubeQuotaStatus
        setYoutubeQuota((prev) => JSON.stringify(prev) !== JSON.stringify(youtubeQuota) ? youtubeQuota : prev)
      }
      if (fields.streamelements) {
        const streamelements = fields.streamelements as StreamElementsStatus
        setStreamelements((prev) => JSON.stringify(prev) !== JSON.stringify(streamelements) ? streamelements : prev)
      }
      if (typeof remote.activityFallback === 'boolean') {
        const activityFallback = remote.activityFallback
        setActivityFallback((prev) => prev !== activityFallback ? activityFallback : prev)
      }
      if (typeof remote.ignoreMissingJwt === 'boolean') {
        const ignoreMissingJwt = remote.ignoreMissingJwt
        setIgnoreMissingJwt((prev) => prev !== ignoreMissingJwt ? ignoreMissingJwt : prev)
      }
      if (typeof remote.dropOldAlerts === 'boolean') {
        const dropOldAlerts = remote.dropOldAlerts
        setDropOldAlerts((prev) => prev !== dropOldAlerts ? dropOldAlerts : prev)
      }
      if (typeof remote.translateChat === 'boolean') {
        const translateChat = remote.translateChat
        setTranslateChat((prev) => prev !== translateChat ? translateChat : prev)
      }
      if (typeof remote.translateError === 'string') {
        const translateError = remote.translateError
        setTranslateError((prev) => prev !== translateError ? translateError : prev)
      }
      setBackendOnline(true)
      if (fields.streamInfo) {
        const incoming = fields.streamInfo as StreamDetailsByPlatform
        const streamInfo = { ...initialStreamDetails, ...incoming, YouTube: { ...initialStreamDetails.YouTube, ...incoming.YouTube } }
        setStreamDetails((prev) => JSON.stringify(prev) !== JSON.stringify(streamInfo) ? streamInfo : prev)
        setStreamTitle((prev) => {
          const newTitle = streamInfo.Twitch.title || streamInfo.Kick.title
          return prev !== newTitle ? newTitle : prev
        })
      }
    }
    const asState = (data: Record<string, unknown>) => data as unknown as BackendState
    return subscribeDockSse({
      onSnapshot: (data) => applySnapshot(asState(data)),
      onChat: (data) => {
        const messages = data.messages as ChatMessage[] | undefined
        if (Array.isArray(messages)) setMessages((prev) => JSON.stringify(prev) !== JSON.stringify(messages) ? messages : prev)
      },
      onPresence: (data) => applySnapshot(asState(data)),
      onSettings: (data) => applySnapshot(asState(data)),
      onStatus: setBackendOnline,
    })
  }, [])

  const connectPlatform = (platform: Platform) => {
    window.open(`/oauth/${platformMeta[platform].route}`, '_blank', 'width=640,height=760,noopener,noreferrer')
  }
  const disconnectPlatform = (platform: Platform) => {
    setConnections((current) => current.map((connection) => connection.platform === platform ? { ...connection, connected: false, live: false, viewers: 0, handle: '' } : connection))
    sendOptOutRef.current.delete(platform)
    setSelectedPlatforms((current) => current.filter((item) => item !== platform))
    void fetch(`/api/disconnect/${platform}`, { method: 'POST' })
  }
  const checkLive = (platform: Platform) => fetch(`/api/live-check/${platform}`, { method: 'POST' }).then((response) => { if (!response.ok) return Promise.reject() }).catch(() => undefined)
  const patchSettings = (body: { activityFallback?: boolean; ignoreMissingJwt?: boolean; dropOldAlerts?: boolean; translateChat?: boolean }) => {
    if (typeof body.activityFallback === 'boolean') setActivityFallback(body.activityFallback)
    if (typeof body.ignoreMissingJwt === 'boolean') setIgnoreMissingJwt(body.ignoreMissingJwt)
    if (typeof body.dropOldAlerts === 'boolean') setDropOldAlerts(body.dropOldAlerts)
    if (typeof body.translateChat === 'boolean') setTranslateChat(body.translateChat)
    void fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }
  const togglePlatform = (platform: Platform) => {
    if (!connections.find((connection) => connection.platform === platform)?.connected) return
    setSelectedPlatforms((current) => {
      if (current.includes(platform)) {
        sendOptOutRef.current.add(platform)
        return current.filter((item) => item !== platform)
      }
      sendOptOutRef.current.delete(platform)
      return [...current, platform]
    })
  }
  const sendMessage = (event: FormEvent) => {
    event.preventDefault()
    if (!composer.trim() || selectedPlatforms.length === 0 || !backendOnline) return
    const text = composer.trim()
    setComposer('')
    void fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platforms: selectedPlatforms, text }) }).then((response) => response.json()).then((result: { results: { platform: Platform; ok: boolean; error?: string }[] }) => { const failed = result.results.filter((item) => !item.ok); setSendStatus(failed.length ? failed.map((item) => `${item.platform}: ${item.error || 'failed'}`).join(' | ') : 'Sent'); window.setTimeout(() => setSendStatus(''), 4000) }).catch(() => setSendStatus('Message request failed'))
  }
  const moderate = (action: 'delete' | 'timeout' | 'ban' | 'unban', duration?: number) => {
    if (!menu) return
    const target = menu.message
    setMenu(null)
    if (action === 'ban' && !window.confirm(`Ban ${target.user} on ${target.platform}?`)) return
    void fetch('/api/moderate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, platform: target.platform, messageId: target.id, userId: target.userId, sourceId: target.sourceId, duration }) }).then((response) => response.json()).then((result: { ok: boolean; error?: string }) => {
      if (!result.ok) setSendStatus(`${target.platform}: ${result.error || 'moderation failed'}`)
      else setSendStatus(action === 'delete' ? 'Message deleted' : action === 'ban' ? `Banned ${target.user}` : action === 'unban' ? `Unbanned ${target.user}` : `Timed out ${target.user}`)
      window.setTimeout(() => setSendStatus(''), 4000)
    }).catch(() => setSendStatus('Moderation request failed'))
  }
  const saveStreamInfo = async (title: string, details: StreamDetailsByPlatform) => {
    setStreamTitle(title)
    setStreamDetails(details)
    try {
      const response = await fetch('/api/stream-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, Twitch: details.Twitch, Kick: details.Kick }) })
      const result = await response.json() as { results: { platform: 'Twitch' | 'Kick'; ok: boolean; error?: string; warning?: string; skipped?: boolean }[] }
      const rows = result.results || []
      const failed = rows.filter((item) => !item.ok)
      const warnings = rows.filter((item) => item.warning)
      const updated = rows.filter((item) => item.ok && !item.skipped && !item.warning).map((item) => item.platform)
      if (failed.length) {
        const prefix = updated.length ? `Updated ${updated.join(' + ')}. ` : ''
        return { ok: false, message: `${prefix}${failed.map((item) => `${item.platform}: ${item.error || 'failed'}`).join(' | ')}` }
      }
      if (!updated.length && !warnings.length) return { ok: true, message: 'Nothing to update' }
      if (warnings.length) {
        const prefix = updated.length ? `Updated ${updated.join(' + ')}. ` : ''
        return { ok: true, warn: true, message: `${prefix}${warnings.map((item) => item.warning).join(' ')}` }
      }
      return { ok: true, message: `Updated ${updated.join(' + ')}` }
    } catch {
      return { ok: false, message: 'Could not set title, categories, and tags' }
    }
  }

  return (
    <main className={compactMode ? 'app compact' : 'app'}>
      <header className="topbar"><button type="button" className="stream-ref" title={headerTip} onClick={() => setShowControls((open) => !open)}><span className="stream-title">{headerTitle}</span>{headerGame ? <span className="stream-game">{headerGame}</span> : null}</button><div className="header-actions"><button className="icon-button" aria-label="Stream controls" onClick={() => setShowControls((open) => !open)}><Gamepad2 size={16} /></button><button className="settings-button" onClick={() => setShowSettings((open) => !open)} aria-label="Open settings"><Settings2 size={17} /></button></div></header>
      <section className="presence-panel"><div className="platform-rollup">{connections.map((connection) => <PlatformStat key={connection.platform} connection={connection} health={health[connection.platform]} quota={connection.platform === 'YouTube' ? youtubeQuota : undefined} onConnect={() => connectPlatform(connection.platform)} />)}</div><div className="viewer-total"><Users size={15} /><span><b>{combinedViewers.toLocaleString()}</b> combined viewers</span><span className={hasChat ? 'live-pill' : 'offline-pill'}><span /> {hasChat ? 'LIVE' : 'OFFLINE'}</span><span className="pulse-line" /></div>{(['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => { const item = health[platform]; return item.status !== 'ok' && item.message ? <div key={platform} className={`health-banner ${item.status}`}>{item.message}</div> : null })}</section>
      <section className="chat-section"><div className="chat-toolbar"><div className="filter-tabs">{(['All', 'Twitch', 'Kick', 'YouTube'] as const).map((filter) => <button key={filter} className={activeFilter === filter ? 'filter active' : 'filter'} onClick={() => setActiveFilter(filter)}>{filter === 'All' ? <Hash size={13} /> : platformIcon(filter, 13)}<span className="filter-label">{filter}</span>{filter !== 'All' && <i />}</button>)}</div><button className="toolbar-icon" onClick={() => setCompactMode((mode) => !mode)} aria-label="Toggle compact chat"><SlidersHorizontal size={16} /></button></div><div className="chat-feed"><div className="chat-list" ref={chatListRef} onScroll={onChatScroll}>{visibleMessages.length ? visibleMessages.map((message) => <MessageItem key={message.id} message={message} showTranslationMark={translateChat} onModerate={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, message: item }) }} />) : <div className="empty-chat"><div className="empty-icon"><Radio size={20} /></div><strong>{connectedAccounts.length ? 'Waiting for chat' : 'No messages yet'}</strong><span>{connectedAccounts.length ? 'Live chat will show up here.' : 'Open settings to connect an account.'}</span><button onClick={() => setShowSettings(true)}>Open connection settings</button></div>}</div>{chatPaused ? <ScrollPausedBadge onResume={resumeChatScroll} /> : null}</div></section>
      <section className="composer-section"><div className="send-to"><span>SEND TO</span>{(['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => { const connection = connections.find((item) => item.platform === platform)!; return <button key={platform} disabled={!connection.connected} className={selectedPlatforms.includes(platform) ? 'destination selected' : 'destination'} onClick={() => togglePlatform(platform)} aria-label={`Send to ${platform}`}><span style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 14)}</span>{selectedPlatforms.includes(platform) && <Check size={11} />}</button> })}</div><form className="composer" onSubmit={sendMessage}><input disabled={!backendOnline} value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={!backendOnline ? 'Start Relay backend to send' : 'Send a message...'} /><button className="send-button" disabled={selectedPlatforms.length === 0 || !backendOnline} type="submit" aria-label="Send message"><Send size={16} /></button></form>{sendStatus ? <div className="composer-footer"><span><Link2 size={12} /> {sendStatus}</span></div> : null}</section>
      {showControls && <StreamControls title={streamTitle} details={streamDetails} connections={connections} onSave={saveStreamInfo} onClose={() => setShowControls(false)} />}
      {showSettings && <ConnectionSettings
        connections={connections}
        streamelements={streamelements}
        activityFallback={activityFallback}
        ignoreMissingJwt={ignoreMissingJwt}
        dropOldAlerts={dropOldAlerts}
        translateChat={translateChat}
        translateError={translateError}
        showActivityOptions={false}
        platformIcon={platformIcon}
        onClose={() => setShowSettings(false)}
        onConnect={connectPlatform}
        onDisconnect={disconnectPlatform}
        onCheckLive={checkLive}
        onToggleFallback={() => patchSettings({ activityFallback: !activityFallback })}
        onToggleIgnoreMissing={() => patchSettings({ ignoreMissingJwt: !ignoreMissingJwt })}
        onToggleDropOld={() => patchSettings({ dropOldAlerts: !dropOldAlerts })}
        onToggleTranslateChat={() => patchSettings({ translateChat: !translateChat })}
        note="Connect accounts here for backup or chat."
      />}
      {menu && <div className="mod-menu" style={{ left: Math.max(6, Math.min(menu.x, window.innerWidth - 168)), top: Math.max(6, Math.min(menu.y, window.innerHeight - (menu.message.deleted ? 90 : 190))) }} onClick={(event) => event.stopPropagation()}><div className="mod-menu-user">{menu.message.user} · {menu.message.platform}</div>{menu.message.deleted ? <button type="button" onClick={() => moderate('unban')}>Unban / untimeout</button> : <><button type="button" onClick={() => moderate('delete')}>Delete message</button><button type="button" onClick={() => moderate('timeout', 60)}>Timeout 1m</button><button type="button" onClick={() => moderate('timeout', 600)}>Timeout 10m</button><button type="button" onClick={() => moderate('timeout', 3600)}>Timeout 1h</button><button type="button" className="danger" onClick={() => moderate('ban')}>Ban</button></>}</div>}
      <div className="resize-hint"><span>RESIZABLE</span></div>
    </main>
  )
}

function PlatformStat({ connection, health, quota, onConnect }: { connection: Connection; health?: Health; quota?: YoutubeQuotaStatus; onConnect: () => void }) {
  const meta = platformMeta[connection.platform]
  const handle = connection.connected && connection.handle && !['YouTube account', 'Kick account', 'YouTube', 'Kick', 'Twitch'].includes(connection.handle) ? connection.handle : connection.platform
  const status = !connection.connected ? '' : health?.status === 'down' ? 'down' : health?.status === 'warn' ? 'warn' : connection.live ? 'ok' : ''
  const tip = [
    `${connection.platform}${connection.live ? ' · live' : connection.connected ? ' · offline' : ' · not connected'}`,
    connection.connected ? `${connection.viewers.toLocaleString()} viewers` : '',
    quota ? `Quota ${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()}` : '',
    health?.message || (status === 'ok' ? 'Connected' : ''),
  ].filter(Boolean).join('\n')
  return <button type="button" className={`platform-stat${connection.connected ? ' connected' : ''}${connection.live ? ' live' : ''}${status === 'down' ? ' down' : ''}`} style={{ color: meta.color, borderColor: status === 'down' ? '#ff5b62' : connection.live ? meta.color : `${meta.color}66`, background: `${meta.color}18` }} title={tip} onClick={() => { if (!connection.connected) onConnect() }} aria-label={tip.replace(/\n/g, ' ')}><span className="platform-stat-top">{platformIcon(connection.platform, 13)}<span className="platform-stat-name">{handle}</span>{status ? <span className={`status-dot ${status}`} /> : null}</span><strong>{connection.connected ? connection.viewers.toLocaleString() : '—'}</strong></button>
}

function displayLetter(name: string) {
  const cleaned = name.replace(/^@+/, '')
  return (cleaned.match(/[\p{L}\p{N}]/u)?.[0] || cleaned[0] || '?').toUpperCase()
}

function Avatar({ name, src, color }: { name: string; src?: string; color: string }) {
  const [failed, setFailed] = useState(false)
  const showImage = Boolean(src) && !failed
  return <div className="avatar" style={{ backgroundColor: showImage ? 'transparent' : color }}>{showImage ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : displayLetter(name)}</div>
}

function getChatProfileUrl(message: ChatMessage): string | undefined {
  const handle = message.user.replace(/^@+/, '').trim().toLowerCase()
  if (!handle || /^anonymous$/i.test(handle) || handle === 'testuser') return
  const platform = message.platform
  if (platform === 'Twitch') return `https://www.twitch.tv/${encodeURIComponent(handle)}`
  if (platform === 'Kick') return `https://kick.com/${encodeURIComponent(kickProfileSlug(message.user, message.handle))}`
  if (platform === 'YouTube') {
    if (message.userId && /^UC[\w-]{20,}$/i.test(message.userId)) return `https://www.youtube.com/channel/${encodeURIComponent(message.userId)}`
    return `https://www.youtube.com/@${encodeURIComponent(handle)}`
  }
  return `https://www.twitch.tv/${encodeURIComponent(handle)}`
}

function MessageItem({ message, showTranslationMark, onModerate }: { message: ChatMessage; showTranslationMark: boolean; onModerate: (event: MouseEvent, message: ChatMessage) => void }) {
  const platforms = message.platforms || [message.platform]
  const parts = message.parts?.length ? message.parts : [{ type: 'text' as const, text: message.text }]
  const name = message.user.replace(/^@+/, '')
  const profileUrl = getChatProfileUrl(message)
  const openProfile = (event: React.MouseEvent) => {
    if (!profileUrl) return
    event.stopPropagation()
    void fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: profileUrl }) }).catch(err => console.error('Failed to open profile:', err))
  }
  return <article className={message.deleted ? 'message deleted' : 'message'} onContextMenu={(event) => onModerate(event, message)}><Avatar name={name} src={dockAvatarSrc(message.avatar)} color={message.color || platformMeta[platforms[0]].color} /><div className="message-body"><div className="message-meta"><span className="platform-dot">{platforms.map((platform) => <span key={platform} style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 11)}</span>)}</span>{message.sourceLabel ? <span className="source-tag">{message.sourceLabel}</span> : null}{(message.badges || []).map((badge, index) => badge.url ? <img key={`${badge.title}-${index}`} className="chat-badge" src={badge.url} alt={badge.title} title={badge.title} referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : badge.label ? <span key={`${badge.title}-${index}`} className="chat-badge-label" title={badge.title}>{badge.label}</span> : null)}<strong style={message.color ? { color: message.color } : undefined} onClick={profileUrl ? openProfile : undefined} className={profileUrl ? 'clickable-username' : ''}>{name}</strong><time>{new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p title={showTranslationMark ? message.originalText || undefined : undefined}>{parts.map((part, index) => part.type === 'emote' ? <img key={`${part.url}-${index}`} className="emote" src={part.url} alt={part.name} title={part.name} /> : <span key={index}>{part.text}</span>)}{showTranslationMark && message.originalText ? <span className="translated-mark" title={message.originalText}>EN</span> : null}</p></div></article>
}

/** Twitch/Kick category field. Arrow keys only move the open list; closed input keeps default caret behavior. */
function StreamFields({ platform, details, disabled, onChange }: { platform: StreamPlatform; details: StreamDetails; disabled: boolean; onChange: (details: StreamDetails) => void }) {
  const [options, setOptions] = useState<CategoryOption[]>([])
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const typingRef = useRef(false)
  const pickedRef = useRef(false)
  const visible = options.slice(0, 8)
  useEffect(() => {
    if (disabled || details.category.trim().length < 2) { setOptions([]); setOpen(false); return }
    if (pickedRef.current) { pickedRef.current = false; setOpen(false); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetch(`/api/categories/${platform.toLowerCase()}?query=${encodeURIComponent(details.category.trim())}`, { signal: controller.signal }).then((response) => response.ok ? response.json() as Promise<CategoryOption[]> : Promise.reject()).then((items) => { setOptions(items); setOpen(typingRef.current && items.length > 0) }).catch((error: { name?: string }) => { if (error.name !== 'AbortError') { setOptions([]); setOpen(false) } })
    }, 200)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [details.category, disabled, platform])
  useEffect(() => { setHighlight(0) }, [details.category, open])
  const pick = (option: CategoryOption) => { pickedRef.current = true; typingRef.current = false; setOpen(false); setOptions([]); onChange({ ...details, category: option.name, categoryId: option.id }) }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || visible.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((current) => nextOptionIndex(current, visible.length, 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((current) => nextOptionIndex(current, visible.length, -1))
      return
    }
    if (event.key === 'Enter') {
      const option = visible[highlight]
      if (!option) return
      event.preventDefault()
      pick(option)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }
  return <div className="stream-fields"><div className="stream-fields-heading"><span style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 13)}</span><strong>{platform} category</strong><small>{disabled ? `Connect ${platform}` : 'Platform-specific'}</small></div><input disabled={disabled} autoComplete="off" value={details.category} onChange={(event) => { pickedRef.current = false; typingRef.current = true; onChange({ ...details, category: event.target.value, categoryId: options.find((option) => option.name === event.target.value)?.id }) }} onKeyDown={onKeyDown} onBlur={() => { typingRef.current = false; window.setTimeout(() => setOpen(false), 120) }} placeholder={`${platform} category / game`} aria-expanded={open} aria-autocomplete="list" />{open && visible.length > 0 && <ul className="category-options" role="listbox">{visible.map((option, index) => <li key={option.id}><button type="button" className={index === highlight ? 'active' : undefined} aria-selected={index === highlight} onMouseEnter={() => setHighlight(index)} onMouseDown={(event) => { event.preventDefault(); pick(option) }}>{option.name}</button></li>)}</ul>}</div>
}

/** Combined Twitch+Kick category search. Shared names are one row; platform-only hits keep their icon. */
function UnifiedCategoryField({ twitch, kick, twitchEnabled, kickEnabled, onChange }: { twitch: StreamDetails; kick: StreamDetails; twitchEnabled: boolean; kickEnabled: boolean; onChange: (next: { Twitch: StreamDetails; Kick: StreamDetails }) => void }) {
  const [query, setQuery] = useState(preferredCategory(twitch.category, kick.category))
  const [options, setOptions] = useState<MergedCategory[]>([])
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const typingRef = useRef(false)
  const pickedRef = useRef(false)
  const visible = options.slice(0, 8)
  useEffect(() => {
    if (!typingRef.current) setQuery(preferredCategory(twitch.category, kick.category))
  }, [twitch.category, kick.category])
  useEffect(() => {
    if ((!twitchEnabled && !kickEnabled) || query.trim().length < 2) { setOptions([]); setOpen(false); return }
    if (pickedRef.current) { pickedRef.current = false; setOpen(false); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const load = async (platform: StreamPlatform) => {
        const response = await fetch(`/api/categories/${platform.toLowerCase()}?query=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        if (!response.ok) return [] as CategoryOption[]
        return response.json() as Promise<CategoryOption[]>
      }
      void Promise.all([
        twitchEnabled ? load('Twitch') : Promise.resolve([] as CategoryOption[]),
        kickEnabled ? load('Kick') : Promise.resolve([] as CategoryOption[]),
      ]).then(([twitchHits, kickHits]) => {
        const merged = mergeCategoryResults(twitchHits, kickHits)
        setOptions(merged)
        setOpen(typingRef.current && merged.length > 0)
      }).catch((error: { name?: string }) => { if (error.name !== 'AbortError') { setOptions([]); setOpen(false) } })
    }, 200)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, twitchEnabled, kickEnabled])
  useEffect(() => { setHighlight(0) }, [query, open])
  const pick = (option: MergedCategory) => {
    pickedRef.current = true
    typingRef.current = false
    setOpen(false)
    setOptions([])
    setQuery(option.name)
    onChange({
      Twitch: option.twitchId ? { ...twitch, category: option.name, categoryId: option.twitchId } : twitch,
      Kick: option.kickId ? { ...kick, category: option.name, categoryId: option.kickId } : kick,
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || visible.length === 0) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((current) => nextOptionIndex(current, visible.length, 1)); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((current) => nextOptionIndex(current, visible.length, -1)); return }
    if (event.key === 'Enter') {
      const option = visible[highlight]
      if (!option) return
      event.preventDefault()
      pick(option)
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
  }
  return (
    <div className="stream-fields">
      <div className="stream-fields-heading"><strong>Category</strong><small>Twitch + Kick</small></div>
      <input disabled={!twitchEnabled && !kickEnabled} autoComplete="off" value={query} onChange={(event) => { pickedRef.current = false; typingRef.current = true; setQuery(event.target.value) }} onKeyDown={onKeyDown} onBlur={() => { typingRef.current = false; window.setTimeout(() => setOpen(false), 120) }} placeholder="Category / game" aria-expanded={open} aria-autocomplete="list" />
      {open && visible.length > 0 && (
        <ul className="category-options" role="listbox">
          {visible.map((option, index) => (
            <li key={`${option.twitchId || ''}-${option.kickId || ''}-${option.name}`}>
              <button type="button" className={index === highlight ? 'active' : undefined} aria-selected={index === highlight} onMouseEnter={() => setHighlight(index)} onMouseDown={(event) => { event.preventDefault(); pick(option) }}>
                <span>{option.name}</span>
                <span className="category-option-platforms">
                  {option.twitchId ? <span style={{ color: platformMeta.Twitch.color }}>{platformIcon('Twitch', 12)}</span> : null}
                  {option.kickId ? <span style={{ color: platformMeta.Kick.color }}>{platformIcon('Kick', 12)}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Chip input for stream tags. Destination toggles pick Twitch / Kick / YouTube for the next chip. */
function TagEditor({ tags, disabled, connected, onChange }: { tags: TagAssignment[]; disabled: boolean; connected: Record<TagPlatform, boolean>; onChange: (tags: TagAssignment[]) => void }) {
  const [draft, setDraft] = useState('')
  const [dest, setDest] = useState<Record<TagPlatform, boolean>>({ Twitch: true, Kick: true })
  const selected = (['Twitch', 'Kick'] as TagPlatform[]).filter((platform) => dest[platform] && connected[platform])
  const commit = (raw: string) => {
    const pieces = raw.split(/[\s,]+/).map((item) => item.trim().replace(/^#+/, '')).filter(Boolean)
    if (!pieces.length) return
    const next = tags.map((item) => ({ tag: item.tag, platforms: [...item.platforms] }))
    for (const piece of pieces) {
      const allowed = tagPlatforms(piece)
      const platforms = (selected.length ? allowed.filter((platform) => selected.includes(platform)) : allowed)
      const use = platforms.length ? platforms : allowed
      if (!use.length) continue
      const existing = next.find((item) => item.tag.toLowerCase() === piece.toLowerCase())
      if (existing) {
        existing.platforms = [...new Set([...existing.platforms, ...use])]
        continue
      }
      if (next.length >= 10) break
      next.push({ tag: piece, platforms: use })
    }
    setDraft('')
    onChange(next)
  }
  return (
    <div className="tag-editor">
      {tags.map((item) => {
        return (
          <button type="button" key={item.tag} className="tag-chip" disabled={disabled} onClick={() => onChange(tags.filter((entry) => entry.tag !== item.tag))} title={item.platforms.join(' + ')}>
            <span className="tag-chip-platforms">{item.platforms.map((platform) => <i key={platform} style={{ background: platformMeta[platform].color }} />)}</span>
            {item.tag} ×
          </button>
        )
      })}
      {tags.length < 10 ? (
        <input disabled={disabled} value={draft} autoComplete="off" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); commit(draft) }
          if (event.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1))
        }} onBlur={() => { if (draft.trim()) commit(draft) }} placeholder="Tags" />
      ) : null}
      <div className="tag-dest">
        {(['Twitch', 'Kick'] as TagPlatform[]).map((platform) => (
          <button type="button" key={platform} className={dest[platform] ? 'active' : undefined} disabled={disabled || !connected[platform]} style={{ color: platformMeta[platform].color }} aria-pressed={dest[platform]} aria-label={`${platform} tags`} title={platform} onClick={() => setDest((current) => ({ ...current, [platform]: !current[platform] }))}>
            {platformIcon(platform, 12)}
          </button>
        ))}
      </div>
    </div>
  )
}

function isMoreSpecificCategory(specific: string, general: string) {
  const a = specific.trim().toLowerCase()
  const b = general.trim().toLowerCase()
  if (!a || !b || a === b || !a.startsWith(b)) return false
  const next = a[b.length]
  return next === ' ' || next === ':' || next === '-' || next === '('
}

function bestCategoryMatch(query: string, options: CategoryOption[]) {
  const lower = query.trim().toLowerCase()
  if (!options.length) return
  const exact = options.find((option) => option.name.toLowerCase() === lower)
  if (exact) return exact
  const moreSpecific = options.filter((option) => isMoreSpecificCategory(option.name, query))
    .sort((left, right) => left.name.length - right.name.length)
  if (moreSpecific.length) return moreSpecific[0]
  const containsQuery = options.filter((option) => option.name.toLowerCase().includes(lower))
    .sort((left, right) => Math.abs(left.name.length - query.length) - Math.abs(right.name.length - query.length))
  return containsQuery[0]
}

function applyResolvedCategory(current: StreamDetails, match?: CategoryOption): StreamDetails {
  if (!match) return current
  const currentName = current.category.trim()
  if (!currentName) return { ...current, category: match.name, categoryId: match.id }
  if (match.name.toLowerCase() === currentName.toLowerCase()) return { ...current, category: match.name, categoryId: match.id }
  if (isMoreSpecificCategory(currentName, match.name)) return current
  return { ...current, category: match.name, categoryId: match.id }
}

async function resolveCategory(platform: StreamPlatform, query: string) {
  const text = query.trim()
  if (text.length < 2) return
  try {
    const response = await fetch(`/api/categories/${platform.toLowerCase()}?query=${encodeURIComponent(text)}`)
    if (!response.ok) return
    return bestCategoryMatch(text, await response.json() as CategoryOption[])
  } catch {
    return
  }
}

function StreamControls({ title, details, connections, onSave, onClose }: { title: string; details: StreamDetailsByPlatform; connections: Connection[]; onSave: (title: string, details: StreamDetailsByPlatform) => Promise<{ ok: boolean; warn?: boolean; message: string }>; onClose: () => void }) {
  const [draftTitle, setDraftTitle] = useState(title || details.Twitch.title || details.Kick.title)
  const [draftDetails, setDraftDetails] = useState(details)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null)
  const [splitCategories, setSplitCategories] = useState(() => {
    const twitch = details.Twitch.category.trim().toLowerCase()
    const kick = details.Kick.category.trim().toLowerCase()
    return Boolean(twitch && kick && twitch !== kick)
  })
  const editedRef = useRef(false)
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 4500)
    return () => window.clearTimeout(timer)
  }, [status])
  useEffect(() => {
    if (editedRef.current) return
    setDraftTitle(title || details.Twitch.title || details.Kick.title)
    setDraftDetails(details)
    let cancelled = false
    void (async () => {
      const [twitchMatch, kickMatch] = await Promise.all([
        details.Twitch.categoryId || !details.Twitch.category.trim() ? undefined : resolveCategory('Twitch', details.Twitch.category),
        details.Kick.categoryId || !details.Kick.category.trim() ? undefined : resolveCategory('Kick', details.Kick.category),
      ])
      if (cancelled || editedRef.current) return
      setDraftDetails((current) => ({
        Twitch: applyResolvedCategory(current.Twitch, twitchMatch),
        Kick: applyResolvedCategory(current.Kick, kickMatch),
        YouTube: current.YouTube,
      }))
    })()
    return () => { cancelled = true }
  }, [title, details])
  const save = async () => {
    setSaving(true)
    const result = await onSave(draftTitle, draftDetails)
    setStatus({ text: result.message, kind: result.ok ? (result.warn ? 'warn' : 'ok') : 'error' })
    if (result.ok) editedRef.current = false
    setSaving(false)
  }
  const youtubeConnected = Boolean(connections.find((connection) => connection.platform === 'YouTube')?.connected)
  const twitchConnected = Boolean(connections.find((connection) => connection.platform === 'Twitch')?.connected)
  const kickConnected = Boolean(connections.find((connection) => connection.platform === 'Kick')?.connected)
  const tagsDisabled = !twitchConnected && !kickConnected
  const youtubeChannelId = connections.find((connection) => connection.platform === 'YouTube')?.channelId
  const openYouTubeStudio = () => {
    void fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: youtubeStudioUrl(youtubeChannelId) }) }).catch((error) => console.error('Failed to open YouTube Studio:', error))
  }
  const setTags = (tags: TagAssignment[]) => {
    editedRef.current = true
    setDraftDetails((current) => ({
      ...current,
      Twitch: { ...current.Twitch, tags: tags.filter((item) => item.platforms.includes('Twitch')).map((item) => item.tag) },
      Kick: { ...current.Kick, tags: tags.filter((item) => item.platforms.includes('Kick')).map((item) => item.tag) },
    }))
  }
  return (
    <aside className="controls-popover">
      <div className="popover-title"><span>STREAM CONTROLS</span><button onClick={onClose} aria-label="Close stream controls">×</button></div>
      <div className="control-tabs"><span className="unified-badge">TWITCH + KICK</span><button type="button" className="controls-link" disabled={!youtubeConnected} onClick={openYouTubeStudio}>Open YouTube Studio</button></div>
      <div className="stream-fields">
        <div className="stream-fields-heading"><strong>Title</strong></div>
        <input value={draftTitle} onChange={(event) => { editedRef.current = true; setDraftTitle(event.target.value) }} placeholder="Shared stream title" />
      </div>
      {splitCategories
        ? (['Twitch', 'Kick'] as StreamPlatform[]).map((platform) => <StreamFields key={platform} platform={platform} details={draftDetails[platform]} disabled={!connections.find((connection) => connection.platform === platform)?.connected} onChange={(next) => { editedRef.current = true; setDraftDetails((current) => ({ ...current, [platform]: next })) }} />)
        : <UnifiedCategoryField twitch={draftDetails.Twitch} kick={draftDetails.Kick} twitchEnabled={twitchConnected} kickEnabled={kickConnected} onChange={(next) => { editedRef.current = true; setDraftDetails((current) => ({ ...current, ...next })) }} />}
      <button type="button" className="controls-link" onClick={() => setSplitCategories((open) => !open)}>{splitCategories ? 'Use one category search' : 'Twitch / Kick separately'}</button>
      <div className="stream-fields">
        <div className="stream-fields-heading"><strong>Tags</strong></div>
        <TagEditor tags={tagAssignments(draftDetails.Twitch.tags, draftDetails.Kick.tags)} disabled={tagsDisabled} connected={{ Twitch: twitchConnected, Kick: kickConnected }} onChange={setTags} />
      </div>
      <button className="update-stream" disabled={saving} onClick={() => { void save() }}>{saving ? 'Saving...' : 'Set title, categories, and tags'}</button>
      {status ? <div className={`stream-status ${status.kind}`}>{status.text}</div> : null}
    </aside>
  )
}

export default App
