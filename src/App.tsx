import { FormEvent, useEffect, useState } from 'react'
import { Check, CircleHelp, Gamepad2, Hash, Link2, MessageCircle, MoreHorizontal, Radio, Send, Settings2, SlidersHorizontal, Twitch, Users, Youtube } from 'lucide-react'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean }
type StreamDetails = { title: string; category: string }
type ChatMessage = { id: string; platform: Platform; user: string; text: string; time: string; emotes?: string[] }
type BackendState = { accounts: Connection[]; streamInfo: StreamDetails; messages: ChatMessage[] }

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
const initialStreamDetails: StreamDetails = { title: '', category: '' }

const platformIcon = (platform: Platform, size = 14) => {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  return <span className="kick-mark">K</span>
}

function App() {
  const [connections, setConnections] = useState(initialConnections)
  const [activeFilter, setActiveFilter] = useState<'All' | Platform>('All')
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([])
  const [composer, setComposer] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [compactMode, setCompactMode] = useState(false)
  const [showControls, setShowControls] = useState(false)
  const [streamDetails, setStreamDetails] = useState(initialStreamDetails)
  const [backendOnline, setBackendOnline] = useState(false)
    const [messages, setMessages] = useState<ChatMessage[]>([])
  const liveConnections = connections.filter((connection) => connection.connected && connection.live)
  const combinedViewers = liveConnections.reduce((total, connection) => total + connection.viewers, 0)
  const hasChat = liveConnections.length > 0
  const visibleMessages = activeFilter === 'All' ? messages : messages.filter((message) => message.platform === activeFilter)

  useEffect(() => {
    fetch('/api/state').then((response) => response.ok ? response.json() as Promise<BackendState> : Promise.reject()).then((remote) => { setConnections(remote.accounts); setStreamDetails(remote.streamInfo); setBackendOnline(true) }).catch(() => setBackendOnline(false))
    const events = new EventSource('/events')
    events.onmessage = (event) => { const remote = JSON.parse(event.data) as BackendState; setConnections(remote.accounts); setStreamDetails(remote.streamInfo); setBackendOnline(true) }
    events.onerror = () => setBackendOnline(false)
    return () => events.close()
  }, [])

  const connectPlatform = (platform: Platform) => {
    window.open(`/oauth/${platformMeta[platform].route}`, '_blank', 'width=640,height=760,noopener,noreferrer')
  }
  const disconnectPlatform = (platform: Platform) => {
    setConnections((current) => current.map((connection) => connection.platform === platform ? { ...connection, connected: false, live: false, viewers: 0, handle: '' } : connection))
    setSelectedPlatforms((current) => current.filter((item) => item !== platform))
  }
  const togglePlatform = (platform: Platform) => {
    if (!connections.find((connection) => connection.platform === platform)?.connected) return
    setSelectedPlatforms((current) => current.includes(platform) ? current.filter((item) => item !== platform) : [...current, platform])
  }
  const sendMessage = (event: FormEvent) => {
    event.preventDefault()
    if (!composer.trim() || selectedPlatforms.length === 0 || !hasChat || !backendOnline) return
    void fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platforms: selectedPlatforms, text: composer.trim() }) })
    setComposer('')
  }
  const saveStreamInfo = (details: StreamDetails) => {
    setStreamDetails(details)
    void fetch('/api/stream-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(details) })
  }

  return (
    <main className={compactMode ? 'app compact' : 'app'}>
      <header className="topbar"><div className="brand"><span className="brand-mark"><MessageCircle size={16} /></span><span>RELAY</span><span className="brand-sub">CHAT DOCK</span></div><div className="header-actions"><button className="icon-button" aria-label="Stream controls" onClick={() => setShowControls((open) => !open)}><Gamepad2 size={16} /></button><button className="icon-button" aria-label="Help"><CircleHelp size={17} /></button><button className="icon-button" aria-label="More options"><MoreHorizontal size={19} /></button><button className="settings-button" onClick={() => setShowSettings((open) => !open)} aria-label="Open settings"><Settings2 size={17} /></button></div></header>
      <section className="presence-panel"><div className="section-heading"><div><p className="eyebrow">STREAM CONNECTIONS</p><h1>{hasChat ? 'Your live chats, together.' : 'Connect your live chats.'}</h1></div><span className={hasChat ? 'live-pill' : 'offline-pill'}><span /> {hasChat ? 'LIVE' : 'OFFLINE'}</span></div><div className="platform-rollup">{connections.map((connection) => <PlatformCard key={connection.platform} connection={connection} onConnect={() => connectPlatform(connection.platform)} onDisconnect={() => disconnectPlatform(connection.platform)} />)}</div><div className="viewer-total"><Users size={15} /><span><b>{combinedViewers.toLocaleString()}</b> combined viewers</span><span className="pulse-line" /></div></section>
      <section className="chat-section"><div className="chat-toolbar"><div className="filter-tabs">{(['All', 'Twitch', 'Kick', 'YouTube'] as const).map((filter) => <button key={filter} className={activeFilter === filter ? 'filter active' : 'filter'} onClick={() => setActiveFilter(filter)}>{filter === 'All' ? <Hash size={13} /> : platformIcon(filter, 13)}<span>{filter}</span>{filter !== 'All' && <i />}</button>)}</div><button className="toolbar-icon" onClick={() => setCompactMode((mode) => !mode)} aria-label="Toggle compact chat"><SlidersHorizontal size={16} /></button></div><div className="chat-list">{!hasChat ? <div className="empty-chat"><div className="empty-icon"><Radio size={20} /></div><strong>No live chat yet</strong><span>Connect an account and go live to see messages here.</span><button onClick={() => setShowSettings(true)}>Open connection settings</button></div> : liveConnections.filter((connection) => activeFilter === 'All' || connection.platform === activeFilter).map((connection) => <div className="connected-placeholder" key={connection.platform}><span style={{ color: platformMeta[connection.platform].color }}>{platformIcon(connection.platform, 14)}</span><span>Waiting for {connection.platform} chat messages...</span></div>)}</div></section>
      <section className="composer-section"><div className="send-to"><span>SEND TO</span>{(['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => { const connection = connections.find((item) => item.platform === platform)!; return <button key={platform} disabled={!connection.connected} className={selectedPlatforms.includes(platform) ? 'destination selected' : 'destination'} onClick={() => togglePlatform(platform)} aria-label={`Send to ${platform}`}><span style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 14)}</span>{selectedPlatforms.includes(platform) && <Check size={11} />}</button> })}<span className="send-label">{selectedPlatforms.length ? `${selectedPlatforms.length} CHANNEL${selectedPlatforms.length === 1 ? '' : 'S'}` : 'CONNECT A CHANNEL'}</span></div><form className="composer" onSubmit={sendMessage}><input disabled={!hasChat || !backendOnline} value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={!backendOnline ? 'Start Relay backend to send' : hasChat ? 'Send a message to your community...' : 'Go live to send messages'} /><button className="send-button" disabled={!hasChat || selectedPlatforms.length === 0 || !backendOnline} type="submit" aria-label="Send message"><Send size={16} /></button></form><div className="composer-footer"><span><Link2 size={12} /> {backendOnline ? 'Connected to Relay backend' : 'Relay backend is offline'}</span><span className="shortcut">ENTER <span>to send</span></span></div></section>
      {showControls && <StreamControls details={streamDetails} connections={connections} onChange={setStreamDetails} onSave={saveStreamInfo} onClose={() => setShowControls(false)} />}
      {showSettings && <aside className="settings-popover"><div className="popover-title"><span>CONNECTION SETTINGS</span><button onClick={() => setShowSettings(false)} aria-label="Close settings">×</button></div><p className="settings-note">Connect with OAuth. Add client IDs in <strong>.env.local</strong>; tokens stay on your server and never enter OBS.</p>{connections.map((connection) => <div className="connection-row" key={connection.platform}><span style={{ color: platformMeta[connection.platform].color }}>{platformIcon(connection.platform, 14)}</span><div><strong>{connection.platform}</strong><small>{connection.connected ? connection.handle : 'Not connected'}</small></div>{connection.connected ? <button className="disconnect" onClick={() => disconnectPlatform(connection.platform)}>Disconnect</button> : <button className="connect" onClick={() => connectPlatform(connection.platform)}>Connect</button>}</div>)}<div className="settings-divider" /><strong className="settings-section-title">UNIFIED STREAM INFO</strong><p className="settings-note">One title and category are sent to both Twitch and Kick.</p><StreamFields details={streamDetails} disabled={!connections.some((connection) => connection.connected && connection.platform !== 'YouTube')} onChange={setStreamDetails} onSave={saveStreamInfo} /><label><span>Pause on hover</span><input type="checkbox" defaultChecked /></label></aside>}
      <div className="resize-hint"><span>RESIZABLE</span></div>
    </main>
  )
}

function PlatformCard({ connection, onConnect, onDisconnect }: { connection: Connection; onConnect: () => void; onDisconnect: () => void }) {

  function ChatMessage({ message }: { message: ChatMessage }) {
    return <article className="message"><div className="avatar" style={{ backgroundColor: platformMeta[message.platform].color }}>{message.user.slice(0, 1).toUpperCase()}</div><div className="message-body"><div className="message-meta"><span className="platform-dot" style={{ color: platformMeta[message.platform].color }}>{platformIcon(message.platform, 11)}</span><strong>{message.user}</strong><time>{new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p>{message.text}</p></div></article>
  }
  const meta = platformMeta[connection.platform]
  return <article className="platform-card"><span className="platform-card-icon" style={{ color: meta.color }}>{platformIcon(connection.platform, 16)}</span><div className="platform-card-copy"><strong>{connection.platform}</strong><span>{connection.connected ? connection.handle : 'Account not connected'}</span></div><div className="platform-card-viewers"><strong>{connection.live ? connection.viewers.toLocaleString() : '-'}</strong><span>{connection.live ? 'viewers' : 'offline'}</span></div>{connection.connected ? <button className="status-button connected" onClick={onDisconnect} aria-label={`Disconnect ${connection.platform}`}><span /> Connected</button> : <button className="status-button" onClick={onConnect}>Connect</button>}</article>
}

function StreamFields({ details, disabled, onChange, onSave }: { details: StreamDetails; disabled: boolean; onChange: (details: StreamDetails) => void; onSave: (details: StreamDetails) => void }) {
  return <div className="stream-fields"><div className="stream-fields-heading"><span style={{ color: '#b5c0bd' }}><Radio size={13} /></span><strong>Twitch + Kick</strong><small>{disabled ? 'Connect Twitch or Kick' : 'Unified metadata'}</small></div><input disabled={disabled} value={details.title} onChange={(event) => onChange({ ...details, title: event.target.value })} placeholder="Unified stream title" /><input disabled={disabled} value={details.category} onChange={(event) => onChange({ ...details, category: event.target.value })} placeholder="Unified category / game" /><button disabled={disabled} className="update-stream" onClick={() => onSave(details)}>Set on Twitch & Kick</button></div>
}

function StreamControls({ details, connections, onChange, onSave, onClose }: { details: StreamDetails; connections: Connection[]; onChange: (details: StreamDetails) => void; onSave: (details: StreamDetails) => void; onClose: () => void }) {
  const connected = connections.some((connection) => connection.platform !== 'YouTube' && connection.connected)
  return <aside className="controls-popover"><div className="popover-title"><span>STREAM CONTROLS</span><button onClick={onClose} aria-label="Close stream controls">×</button></div><div className="control-tabs"><span className="unified-badge">TWITCH + KICK</span></div><p className="settings-note">Update the same title and category on both platforms.</p><StreamFields details={details} disabled={!connected} onChange={onChange} onSave={onSave} /></aside>
}

export default App
