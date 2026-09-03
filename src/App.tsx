import { FormEvent, MouseEvent, useEffect, useRef, useState } from 'react'
import { Check, Gamepad2, Hash, Link2, Radio, Send, Settings2, SlidersHorizontal, Twitch, Users, Youtube } from 'lucide-react'
import { ConnectionSettings } from './ConnectionSettings'
import { ScrollPausedBadge, useAutoScroll } from './autoScroll'
import { preferredCategory, selectedSendPlatforms, visibleChatMessages } from './chat-helpers'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean }
type StreamPlatform = 'Twitch' | 'Kick'
type StreamDetails = { title: string; category: string; categoryId?: string }
type StreamDetailsByPlatform = Record<StreamPlatform, StreamDetails>
type CategoryOption = { id: string; name: string }
type MessagePart = { type: 'text'; text: string } | { type: 'emote'; name: string; url: string }
type ChatBadge = { title: string; url?: string; label?: string }
type ChatMessage = { id: string; platform: Platform; platforms?: Platform[]; user: string; text: string; time: string; emotes?: string[]; parts?: MessagePart[]; userId?: string; sourceId?: string; sourceLabel?: string; originalText?: string; avatar?: string; color?: string; badges?: ChatBadge[]; deleted?: boolean }
type Health = { status: 'ok' | 'warn' | 'down'; message: string }
type StreamElementsStatus = { connected: boolean; handle: string; missing?: string[] }
type YoutubeQuotaStatus = { used: number; limit: number }
type BackendState = { accounts: Connection[]; streamInfo: StreamDetailsByPlatform; messages: ChatMessage[]; health: Record<Platform, Health>; streamelements?: StreamElementsStatus; activityFallback?: boolean; ignoreMissingJwt?: boolean; dropOldAlerts?: boolean; youtubeQuota?: YoutubeQuotaStatus }

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
const initialStreamDetails: StreamDetailsByPlatform = { Twitch: { title: '', category: '' }, Kick: { title: '', category: '' } }
const initialHealth: Record<Platform, Health> = { Twitch: { status: 'ok', message: '' }, Kick: { status: 'ok', message: '' }, YouTube: { status: 'ok', message: '' } }

const platformIcon = (platform: Platform, size = 14) => {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  return <span className="kick-mark">K</span>
}

function App() {
  const [connections, setConnections] = useState(initialConnections)
  const [activeFilter, setActiveFilter] = useState<'All' | Platform>('All')
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([])
  const sendOptOutRef = useRef<Set<Platform>>(new Set())
  const [composer, setComposer] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [compactMode, setCompactMode] = useState(true)
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
  const { paused: chatPaused, onScroll: onChatScroll, resume: resumeChatScroll } = useAutoScroll(chatListRef, 'bottom', visibleMessages[visibleMessages.length - 1]?.id)
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
    const apply = (remote: BackendState) => {
      setConnections(remote.accounts)
      setMessages(remote.messages)
      if (remote.health) setHealth(remote.health)
      if (remote.youtubeQuota) setYoutubeQuota(remote.youtubeQuota)
      if (remote.streamelements) setStreamelements(remote.streamelements)
      if (typeof remote.activityFallback === 'boolean') setActivityFallback(remote.activityFallback)
      if (typeof remote.ignoreMissingJwt === 'boolean') setIgnoreMissingJwt(remote.ignoreMissingJwt)
      if (typeof remote.dropOldAlerts === 'boolean') setDropOldAlerts(remote.dropOldAlerts)
      setBackendOnline(true)
      setStreamDetails(remote.streamInfo)
      setStreamTitle(remote.streamInfo.Twitch.title || remote.streamInfo.Kick.title)
    }
    fetch('/api/state').then((response) => response.ok ? response.json() as Promise<BackendState> : Promise.reject()).then(apply).catch(() => setBackendOnline(false))
    const events = new EventSource('/events')
    events.onmessage = (event) => apply(JSON.parse(event.data) as BackendState)
    events.onerror = () => setBackendOnline(false)
    return () => events.close()
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
  const patchSettings = (body: { activityFallback?: boolean; ignoreMissingJwt?: boolean; dropOldAlerts?: boolean }) => {
    if (typeof body.activityFallback === 'boolean') setActivityFallback(body.activityFallback)
    if (typeof body.ignoreMissingJwt === 'boolean') setIgnoreMissingJwt(body.ignoreMissingJwt)
    if (typeof body.dropOldAlerts === 'boolean') setDropOldAlerts(body.dropOldAlerts)
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
  const moderate = (action: 'delete' | 'timeout' | 'ban', duration?: number) => {
    if (!menu) return
    const target = menu.message
    setMenu(null)
    if (action === 'ban' && !window.confirm(`Ban ${target.user} on ${target.platform}?`)) return
    void fetch('/api/moderate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, platform: target.platform, messageId: target.id, userId: target.userId, sourceId: target.sourceId, duration }) }).then((response) => response.json()).then((result: { ok: boolean; error?: string }) => {
      if (!result.ok) setSendStatus(`${target.platform}: ${result.error || 'moderation failed'}`)
      else setSendStatus(action === 'delete' ? 'Message deleted' : action === 'ban' ? `Banned ${target.user}` : `Timed out ${target.user}`)
      window.setTimeout(() => setSendStatus(''), 4000)
    }).catch(() => setSendStatus('Moderation request failed'))
  }
  const saveStreamInfo = async (title: string, details: StreamDetailsByPlatform) => {
    setStreamTitle(title)
    setStreamDetails(details)
    try {
      const response = await fetch('/api/stream-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, Twitch: details.Twitch, Kick: details.Kick }) })
      const result = await response.json() as { results: { platform: StreamPlatform; ok: boolean; error?: string }[] }
      const ok = (result.results || []).filter((item) => item.ok).map((item) => item.platform)
      const failed = (result.results || []).filter((item) => !item.ok)
      const text = failed.length
        ? (ok.length ? `Updated ${ok.join(' + ')}. ${failed.map((item) => `${item.platform}: ${item.error || 'failed'}`).join(' | ')}` : failed.map((item) => `${item.platform}: ${item.error || 'failed'}`).join(' | '))
        : `Title and categories set on ${ok.join(' + ') || 'Twitch + Kick'}`
      return { ok: failed.length === 0, message: text }
    } catch {
      return { ok: false, message: 'Could not set title and categories' }
    }
  }

  return (
    <main className={compactMode ? 'app compact' : 'app'}>
      <header className="topbar"><button type="button" className="stream-ref" title={headerTip} onClick={() => setShowControls((open) => !open)}><span className="stream-title">{headerTitle}</span>{headerGame ? <span className="stream-game">{headerGame}</span> : null}</button><div className="header-actions"><button className="icon-button" aria-label="Stream controls" onClick={() => setShowControls((open) => !open)}><Gamepad2 size={16} /></button><button className="settings-button" onClick={() => setShowSettings((open) => !open)} aria-label="Open settings"><Settings2 size={17} /></button></div></header>
      <section className="presence-panel"><div className="platform-rollup">{connections.map((connection) => <PlatformStat key={connection.platform} connection={connection} health={health[connection.platform]} quota={connection.platform === 'YouTube' ? youtubeQuota : undefined} onConnect={() => connectPlatform(connection.platform)} />)}</div><div className="viewer-total"><Users size={15} /><span><b>{combinedViewers.toLocaleString()}</b> combined viewers</span><span className={hasChat ? 'live-pill' : 'offline-pill'}><span /> {hasChat ? 'LIVE' : 'OFFLINE'}</span><span className="pulse-line" /></div>{(['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => { const item = health[platform]; return item.status !== 'ok' && item.message ? <div key={platform} className={`health-banner ${item.status}`}>{item.message}</div> : null })}</section>
      <section className="chat-section"><div className="chat-toolbar"><div className="filter-tabs">{(['All', 'Twitch', 'Kick', 'YouTube'] as const).map((filter) => <button key={filter} className={activeFilter === filter ? 'filter active' : 'filter'} onClick={() => setActiveFilter(filter)}>{filter === 'All' ? <Hash size={13} /> : platformIcon(filter, 13)}<span className="filter-label">{filter}</span>{filter !== 'All' && <i />}</button>)}</div><button className="toolbar-icon" onClick={() => setCompactMode((mode) => !mode)} aria-label="Toggle compact chat"><SlidersHorizontal size={16} /></button></div><div className="chat-feed"><div className="chat-list" ref={chatListRef} onScroll={onChatScroll}>{visibleMessages.length ? visibleMessages.map((message) => <MessageItem key={message.id} message={message} onModerate={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, message: item }) }} />) : <div className="empty-chat"><div className="empty-icon"><Radio size={20} /></div><strong>{connectedAccounts.length ? 'Waiting for chat' : 'No messages yet'}</strong><span>{connectedAccounts.length ? 'Live chat will show up here.' : 'Open settings to connect an account.'}</span><button onClick={() => setShowSettings(true)}>Open connection settings</button></div>}</div>{chatPaused ? <ScrollPausedBadge onResume={resumeChatScroll} /> : null}</div></section>
      <section className="composer-section"><div className="send-to"><span>SEND TO</span>{(['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => { const connection = connections.find((item) => item.platform === platform)!; return <button key={platform} disabled={!connection.connected} className={selectedPlatforms.includes(platform) ? 'destination selected' : 'destination'} onClick={() => togglePlatform(platform)} aria-label={`Send to ${platform}`}><span style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 14)}</span>{selectedPlatforms.includes(platform) && <Check size={11} />}</button> })}</div><form className="composer" onSubmit={sendMessage}><input disabled={!backendOnline} value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={!backendOnline ? 'Start Relay backend to send' : 'Send a message...'} /><button className="send-button" disabled={selectedPlatforms.length === 0 || !backendOnline} type="submit" aria-label="Send message"><Send size={16} /></button></form>{sendStatus ? <div className="composer-footer"><span><Link2 size={12} /> {sendStatus}</span></div> : null}</section>
      {showControls && <StreamControls title={streamTitle} details={streamDetails} connections={connections} onSave={saveStreamInfo} onClose={() => setShowControls(false)} />}
      {showSettings && <ConnectionSettings
        connections={connections}
        streamelements={streamelements}
        activityFallback={activityFallback}
        ignoreMissingJwt={ignoreMissingJwt}
        dropOldAlerts={dropOldAlerts}
        showActivityOptions={false}
        platformIcon={platformIcon}
        onClose={() => setShowSettings(false)}
        onConnect={connectPlatform}
        onDisconnect={disconnectPlatform}
        onCheckLive={checkLive}
        onToggleFallback={() => patchSettings({ activityFallback: !activityFallback })}
        onToggleIgnoreMissing={() => patchSettings({ ignoreMissingJwt: !ignoreMissingJwt })}
        onToggleDropOld={() => patchSettings({ dropOldAlerts: !dropOldAlerts })}
        note="Connect accounts here for backup or chat."
      />}
      {menu && <div className="mod-menu" style={{ left: Math.max(6, Math.min(menu.x, window.innerWidth - 168)), top: Math.max(6, Math.min(menu.y, window.innerHeight - 190)) }} onClick={(event) => event.stopPropagation()}><div className="mod-menu-user">{menu.message.user} · {menu.message.platform}</div><button type="button" onClick={() => moderate('delete')}>Delete message</button><button type="button" onClick={() => moderate('timeout', 60)}>Timeout 1m</button><button type="button" onClick={() => moderate('timeout', 600)}>Timeout 10m</button><button type="button" onClick={() => moderate('timeout', 3600)}>Timeout 1h</button><button type="button" className="danger" onClick={() => moderate('ban')}>Ban</button></div>}
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

function MessageItem({ message, onModerate }: { message: ChatMessage; onModerate: (event: MouseEvent, message: ChatMessage) => void }) {
  const platforms = message.platforms || [message.platform]
  const parts = message.parts?.length ? message.parts : [{ type: 'text' as const, text: message.text }]
  const name = message.user.replace(/^@+/, '')
  return <article className={message.deleted ? 'message deleted' : 'message'} onContextMenu={(event) => onModerate(event, message)}><Avatar name={name} src={message.avatar} color={message.color || platformMeta[platforms[0]].color} /><div className="message-body"><div className="message-meta"><span className="platform-dot">{platforms.map((platform) => <span key={platform} style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 11)}</span>)}</span>{message.sourceLabel ? <span className="source-tag">{message.sourceLabel}</span> : null}{(message.badges || []).map((badge, index) => badge.url ? <img key={`${badge.title}-${index}`} className="chat-badge" src={badge.url} alt={badge.title} title={badge.title} referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : badge.label ? <span key={`${badge.title}-${index}`} className="chat-badge-label" title={badge.title}>{badge.label}</span> : null)}<strong style={message.color ? { color: message.color } : undefined}>{name}</strong><time>{new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p title={message.originalText || undefined}>{message.deleted ? <span className="deleted-text">Message deleted</span> : parts.map((part, index) => part.type === 'emote' ? <img key={`${part.url}-${index}`} className="emote" src={part.url} alt={part.name} title={part.name} /> : <span key={index}>{part.text}</span>)}{message.originalText ? <span className="translated-mark" title={message.originalText}>EN</span> : null}</p></div></article>
}

function StreamFields({ platform, details, disabled, onChange }: { platform: StreamPlatform; details: StreamDetails; disabled: boolean; onChange: (details: StreamDetails) => void }) {
  const [options, setOptions] = useState<CategoryOption[]>([])
  const [open, setOpen] = useState(false)
  const typingRef = useRef(false)
  const pickedRef = useRef(false)
  useEffect(() => {
    if (disabled || details.category.trim().length < 2) { setOptions([]); setOpen(false); return }
    if (pickedRef.current) { pickedRef.current = false; setOpen(false); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetch(`/api/categories/${platform.toLowerCase()}?query=${encodeURIComponent(details.category.trim())}`, { signal: controller.signal }).then((response) => response.ok ? response.json() as Promise<CategoryOption[]> : Promise.reject()).then((items) => { setOptions(items); setOpen(typingRef.current && items.length > 0) }).catch((error: { name?: string }) => { if (error.name !== 'AbortError') { setOptions([]); setOpen(false) } })
    }, 200)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [details.category, disabled, platform])
  const pick = (option: CategoryOption) => { pickedRef.current = true; typingRef.current = false; setOpen(false); setOptions([]); onChange({ ...details, category: option.name, categoryId: option.id }) }
  return <div className="stream-fields"><div className="stream-fields-heading"><span style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 13)}</span><strong>{platform} category</strong><small>{disabled ? `Connect ${platform}` : 'Platform-specific'}</small></div><input disabled={disabled} autoComplete="off" value={details.category} onChange={(event) => { pickedRef.current = false; typingRef.current = true; onChange({ ...details, category: event.target.value, categoryId: options.find((option) => option.name === event.target.value)?.id }) }} onBlur={() => { typingRef.current = false; window.setTimeout(() => setOpen(false), 120) }} placeholder={`${platform} category / game`} />{open && options.length > 0 && <ul className="category-options">{options.slice(0, 8).map((option) => <li key={option.id}><button type="button" onMouseDown={(event) => { event.preventDefault(); pick(option) }}>{option.name}</button></li>)}</ul>}</div>
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

function StreamControls({ title, details, connections, onSave, onClose }: { title: string; details: StreamDetailsByPlatform; connections: Connection[]; onSave: (title: string, details: StreamDetailsByPlatform) => Promise<{ ok: boolean; message: string }>; onClose: () => void }) {
  const [draftTitle, setDraftTitle] = useState(title || details.Twitch.title || details.Kick.title)
  const [draftDetails, setDraftDetails] = useState(details)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null)
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
      }))
    })()
    return () => { cancelled = true }
  }, [title, details])
  const save = async () => {
    setSaving(true)
    const result = await onSave(draftTitle, draftDetails)
    setStatus({ text: result.message, ok: result.ok })
    if (result.ok) editedRef.current = false
    setSaving(false)
  }
  return <aside className="controls-popover"><div className="popover-title"><span>STREAM CONTROLS</span><button onClick={onClose} aria-label="Close stream controls">×</button></div><div className="control-tabs"><span className="unified-badge">TWITCH + KICK</span></div><p className="settings-note">One title, separate platform categories.</p><input className="unified-title" value={draftTitle} onChange={(event) => { editedRef.current = true; setDraftTitle(event.target.value) }} placeholder="Shared stream title" />{(['Twitch', 'Kick'] as StreamPlatform[]).map((platform) => <StreamFields key={platform} platform={platform} details={draftDetails[platform]} disabled={!connections.find((connection) => connection.platform === platform)?.connected} onChange={(next) => { editedRef.current = true; setDraftDetails((current) => ({ ...current, [platform]: next })) }} />)}<button className="update-stream" disabled={saving} onClick={() => { void save() }}>{saving ? 'Saving...' : 'Set title and categories'}</button>{status ? <div className={`stream-status ${status.ok ? 'ok' : 'error'}`}>{status.text}</div> : null}</aside>
}

export default App
