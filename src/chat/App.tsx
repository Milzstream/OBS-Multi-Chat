import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Gamepad2, Hash, Link2, Radio, Send, SlidersHorizontal, Users } from 'lucide-react'
import { ScrollPausedBadge, useAutoScroll } from '../autoScroll'
import { CHAT_ROW_ESTIMATE, CHAT_ROW_ESTIMATE_COMPACT, useVirtualWindow } from '../virtualList'
import { mentionMatcher, moderationAcceptsReason, moderationNeedsDockConfirm, moderationStatus, moderationTargets, postYoutubePrivacy, preferredCategory, selectedSendPlatforms, streamDashboardUrl, streamTitleTip, visibleChatMessages, youtubeStudioUrl, type YoutubePrivacyNotice } from '../chat-helpers'
import { YoutubePrivacyBanner } from '../YoutubePrivacyBanner'
import { chatDockFields, chatSliceStamp, sameHealth, samePrivacy, sameQuota, sameStringList, subscribeDockSse } from '../sse'
import { CHAT_COMPACT_KEY, CHAT_FILTER_KEY, CHAT_FILTERS, parseStoredBoolean, parseStoredFilter, readLocalPref, writeLocalPref, type ChatFilter } from '../dock-prefs'
import { MessageItem } from './MessageItem'
import { ModMenu } from './ModMenu'
import { platformIcon, platformMeta } from './platform'
import { PlatformStat } from './PlatformStat'
import { StreamControls } from './StreamControls'
import type { BackendState, ChatMessage, Connection, Health, ModMenuState, Platform, StreamDetailsByPlatform, YoutubeQuotaStatus } from './types'

/**
 * The chat dock UI: platform connections and live state, the message feed
 * with filtering, moderator actions, composer, stream controls, and settings.
 * Owns the SSE connection to Relay's backend via `subscribeDockSse` and keeps
 * the feed glued to the live edge via `useAutoScroll`.
 */
const initialConnections: Connection[] = [
  { platform: 'Twitch', viewers: 0, handle: '', connected: false, live: false },
  { platform: 'Kick', viewers: 0, handle: '', connected: false, live: false },
  { platform: 'YouTube', viewers: 0, handle: '', connected: false, live: false },
]
const initialStreamDetails: StreamDetailsByPlatform = { Twitch: { title: '', category: '' }, Kick: { title: '', category: '' }, YouTube: { title: '', category: '' } }
const initialHealth: Record<Platform, Health> = { Twitch: { status: 'ok', message: '' }, Kick: { status: 'ok', message: '' }, YouTube: { status: 'ok', message: '' } }

function App() {
  const [connections, setConnections] = useState(initialConnections)
  const [activeFilter, setActiveFilter] = useState<ChatFilter>(() => parseStoredFilter(readLocalPref(CHAT_FILTER_KEY), CHAT_FILTERS, 'All'))
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([])
  const sendOptOutRef = useRef<Set<Platform>>(new Set())
  const [composer, setComposer] = useState('')
  const [compactMode, setCompactMode] = useState(() => parseStoredBoolean(readLocalPref(CHAT_COMPACT_KEY), true))
  const [showControls, setShowControls] = useState(false)
  const [streamDetails, setStreamDetails] = useState(initialStreamDetails)
  const [streamTitle, setStreamTitle] = useState('')
  const [backendOnline, setBackendOnline] = useState(false)
  const [sendStatus, setSendStatus] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const moderatingRef = useRef(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [health, setHealth] = useState(initialHealth)
  const [chatWarnings, setChatWarnings] = useState<string[]>([])
  const [youtubePrivacy, setYoutubePrivacy] = useState<YoutubePrivacyNotice[]>([])
  const [youtubeQuota, setYoutubeQuota] = useState<YoutubeQuotaStatus>({ used: 0, limit: 10_000 })
  const [translateChat, setTranslateChat] = useState(true)
  const [mentionKeywords, setMentionKeywords] = useState<string[]>([])
  const [menu, setMenu] = useState<ModMenuState | null>(null)
  const liveConnections = connections.filter((connection) => connection.connected && connection.live)
  const connectedAccounts = connections.filter((connection) => connection.connected)
  const combinedViewers = liveConnections.reduce((total, connection) => total + connection.viewers, 0)
  const hasChat = liveConnections.length > 0
  const headerTitle = streamTitle || streamDetails.Twitch.title || streamDetails.Kick.title || 'RELAY'
  const twitchChannel = connections.find((connection) => connection.platform === 'Twitch' && connection.connected)?.handle
  const twitchGame = streamDetails.Twitch.category
  const kickGame = streamDetails.Kick.category
  const headerGame = preferredCategory(twitchGame, kickGame)
  const youtubeChannelId = connections.find((connection) => connection.platform === 'YouTube')?.channelId
  const headerTip = streamTitleTip(headerTitle, twitchGame, kickGame)
  const visibleMessages = visibleChatMessages(messages, activeFilter)
  const accountNames = connectedAccounts.map((connection) => connection.handle).join('\n')
  const mentionsYou = useMemo(() => mentionMatcher(accountNames.split('\n'), mentionKeywords), [accountNames, mentionKeywords])
  const chatListRef = useRef<HTMLDivElement>(null)
  // Auto-scroll: keeps the feed pinned to the bottom while the user is not
  // scrolling up, snapping again whenever a new tail message arrives
  const { paused: chatPaused, onScroll: onChatPinScroll, resume: resumeChatScroll } = useAutoScroll(chatListRef, 'bottom', visibleMessages[visibleMessages.length - 1]?.id)
  const { start: chatStart, end: chatEnd, padTop: chatPadTop, padBottom: chatPadBottom, onScroll: onChatScroll } = useVirtualWindow(chatListRef, visibleMessages.length, compactMode ? CHAT_ROW_ESTIMATE_COMPACT : CHAT_ROW_ESTIMATE, 'bottom', !chatPaused, onChatPinScroll)
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
    // Subscribe to Relay's SSE stream. chatSliceStamp skips true no-ops and
    // still applies avatar/badge/emote backfills on the same message id.
    const applySnapshot = (remote: BackendState) => {
      const fields = chatDockFields(remote as unknown as Record<string, unknown>)
      if (fields.accounts) setConnections((prev) => JSON.stringify(prev) !== JSON.stringify(fields.accounts) ? fields.accounts as Connection[] : prev)
      if (fields.messages) {
        const messages = fields.messages as ChatMessage[]
        setMessages((prev) => chatSliceStamp(prev) === chatSliceStamp(messages) ? prev : messages)
      }
      if (fields.health) {
        const health = fields.health as Record<Platform, Health>
        setHealth((prev) => sameHealth(prev, health) ? prev : health)
      }
      if (fields.chatWarnings) {
        const chatWarnings = fields.chatWarnings as string[]
        setChatWarnings((prev) => sameStringList(prev, chatWarnings) ? prev : chatWarnings)
      }
      if (fields.youtubePrivacy) {
        const youtubePrivacy = fields.youtubePrivacy as YoutubePrivacyNotice[]
        setYoutubePrivacy((prev) => samePrivacy(prev, youtubePrivacy) ? prev : youtubePrivacy)
      }
      if (fields.youtubeQuota) {
        const youtubeQuota = fields.youtubeQuota as YoutubeQuotaStatus
        setYoutubeQuota((prev) => sameQuota(prev, youtubeQuota) ? prev : youtubeQuota)
      }
      if (fields.mentionKeywords) {
        const words = fields.mentionKeywords
        setMentionKeywords((prev) => sameStringList(prev, words) ? prev : words)
      }
      if (typeof remote.translateChat === 'boolean') {
        const translateChat = remote.translateChat
        setTranslateChat((prev) => prev !== translateChat ? translateChat : prev)
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
        if (Array.isArray(messages)) setMessages((prev) => chatSliceStamp(prev) === chatSliceStamp(messages) ? prev : messages)
      },
      onPresence: (data) => applySnapshot(asState(data)),
      onSettings: (data) => applySnapshot(asState(data)),
      onStatus: setBackendOnline,
    })
  }, [])

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
    if (sendingRef.current || !composer.trim() || selectedPlatforms.length === 0 || !backendOnline) return
    const text = composer.trim()
    sendingRef.current = true
    setSending(true)
    setComposer('')
    const restore = () => setComposer((current) => current.trim() ? current : text)
    void fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platforms: selectedPlatforms, text }) }).then((response) => response.json()).then((result: { results: { platform: Platform; ok: boolean; error?: string }[] }) => {
      const failed = result.results.filter((item) => !item.ok)
      if (failed.length === result.results.length) restore()
      setSendStatus(failed.length ? failed.map((item) => `${item.platform}: ${item.error || 'failed'}`).join(' | ') : 'Sent')
      window.setTimeout(() => setSendStatus(''), 4000)
    }).catch(() => { restore(); setSendStatus('Message request failed') }).finally(() => { sendingRef.current = false; setSending(false) })
  }
  const moderate = (action: 'delete' | 'timeout' | 'ban' | 'unban', duration?: number, reason?: string) => {
    if (!menu || moderatingRef.current) return
    const target = menu.message
    const targets = moderationTargets(target)
    // Twitch/Kick collect an optional reason before sending. `undefined` means the field has not been shown yet; a blank string means the mod left it empty.
    if ((action === 'ban' || action === 'timeout') && targets.some((item) => moderationAcceptsReason(item.platform)) && reason === undefined) {
      setMenu({ ...menu, prompt: { action, duration } })
      return
    }
    if (moderationNeedsDockConfirm(action, targets.map((item) => item.platform), reason)) {
      setMenu({ ...menu, prompt: { action: 'ban', confirmOnly: true } })
      return
    }
    setMenu(null)
    const sentReason = reason?.trim()
    moderatingRef.current = true
    void Promise.all(targets.map((item) => fetch('/api/moderate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, platform: item.platform, messageId: item.messageId, userId: item.userId, sourceId: item.sourceId, duration, ...(sentReason ? { reason: sentReason } : {}) }) }).then((response) => response.json()).then((result: { ok: boolean; error?: string; reason?: string }) => ({ platform: item.platform, ...result })))).then((results) => {
      const failed = results.filter((item) => !item.ok)
      const sent = results.find((item) => item.ok && item.reason)
      setSendStatus(failed.length ? failed.map((item) => `${item.platform}: ${item.error || 'moderation failed'}`).join(' | ') : moderationStatus(action, target.user, sent?.reason))
      window.setTimeout(() => setSendStatus(''), 4000)
    }).catch(() => setSendStatus('Moderation request failed')).finally(() => { moderatingRef.current = false })
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
      <header className="topbar"><button type="button" className="stream-ref" title={headerTip} onClick={() => {
        void fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: youtubeStudioUrl(youtubeChannelId) }) }).then(async (response) => {
          if (response.ok) return
          const data = await response.json().catch(() => ({})) as { error?: string }
          setSendStatus(data.error || 'Could not open YouTube Studio')
        }).catch(() => setSendStatus('Could not open YouTube Studio'))
      }}><span className="stream-title">{headerTitle}</span>{headerGame ? <span className="stream-game">{headerGame}</span> : null}</button><div className="header-actions"><button className="icon-button" aria-label="Stream controls" onClick={() => setShowControls((open) => !open)}><Gamepad2 size={16} /></button></div></header>
      <section className="presence-panel"><div className="platform-rollup">{connections.map((connection) => <PlatformStat key={connection.platform} connection={connection} title={streamDetails[connection.platform]?.title} health={health[connection.platform]} quota={connection.platform === 'YouTube' ? youtubeQuota : undefined} onOpenDashboard={() => { void fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: streamDashboardUrl(connection.platform, connection) }) }).catch((error) => console.error('Failed to open dashboard:', error)) }} />)}</div><div className="viewer-total"><Users size={15} /><span><b>{combinedViewers.toLocaleString()}</b> combined viewers</span><span className={hasChat ? 'live-pill' : 'offline-pill'}><span /> {hasChat ? 'LIVE' : 'OFFLINE'}</span><span className="pulse-line" /></div>{(['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => { const item = health[platform]; return item.status !== 'ok' && item.message ? <div key={platform} className={`health-banner ${item.status}`}>{item.message}</div> : null })}{chatWarnings.map((message) => <div key={message} className="health-banner warn">{message}</div>)}{youtubePrivacy.map((item) => <YoutubePrivacyBanner key={item.videoId} notice={item} className="health-banner warn youtube-privacy" onPublic={() => { void postYoutubePrivacy([item.videoId]).catch((error) => setSendStatus(error instanceof Error ? error.message : 'Could not make the video public')) }} onDismiss={() => { void postYoutubePrivacy([item.videoId], 'dismiss').catch(() => setSendStatus('Could not dismiss the YouTube privacy warning')) }} />)}</section>
      <section className="chat-section"><div className="chat-toolbar"><div className="filter-tabs">{(['All', 'Twitch', 'Kick', 'YouTube'] as const).map((filter) => <button key={filter} className={activeFilter === filter ? 'filter active' : 'filter'} onClick={() => setActiveFilter(filter)}>{filter === 'All' ? <Hash size={13} /> : platformIcon(filter, 13)}<span className="filter-label">{filter}</span>{filter !== 'All' && <i />}</button>)}</div><button className="toolbar-icon" onClick={() => setCompactMode((mode) => !mode)} aria-label="Toggle compact chat"><SlidersHorizontal size={16} /></button></div><div className="chat-feed"><div className="chat-list" ref={chatListRef} onScroll={onChatScroll}>{visibleMessages.length ? <><div className="virtual-spacer" style={{ height: chatPadTop }} aria-hidden="true" />{visibleMessages.slice(chatStart, chatEnd).map((message, offset) => <MessageItem key={message.id} rowIndex={chatStart + offset} message={message} channelLogin={twitchChannel} showTranslationMark={translateChat} mentioned={mentionsYou(message)} onModerate={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, message: item }) }} />)}<div className="virtual-spacer" style={{ height: chatPadBottom }} aria-hidden="true" /></> : <div className="empty-chat"><div className="empty-icon"><Radio size={20} /></div><strong>{connectedAccounts.length ? 'Waiting for chat' : 'No messages yet'}</strong><span>{connectedAccounts.length ? 'Live chat will show up here.' : 'Connect accounts in the Relay Chat Dock window.'}</span></div>}</div>{chatPaused ? <ScrollPausedBadge onResume={resumeChatScroll} /> : null}</div></section>
      <section className="composer-section"><div className="send-to"><span>SEND TO</span>{(['Twitch', 'Kick', 'YouTube'] as Platform[]).map((platform) => { const connection = connections.find((item) => item.platform === platform)!; return <button key={platform} disabled={!connection.connected} className={selectedPlatforms.includes(platform) ? 'destination selected' : 'destination'} onClick={() => togglePlatform(platform)} aria-label={`Send to ${platform}`}><span style={{ color: platformMeta[platform].color }}>{platformIcon(platform, 14)}</span>{selectedPlatforms.includes(platform) && <Check size={11} />}</button> })}</div><form className="composer" onSubmit={sendMessage}><input disabled={!backendOnline} value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={!backendOnline ? 'Start Relay backend to send' : 'Send a message...'} /><button className="send-button" disabled={sending || selectedPlatforms.length === 0 || !backendOnline} type="submit" aria-label="Send message"><Send size={16} /></button></form>{sendStatus ? <div className="composer-footer"><span><Link2 size={12} /> {sendStatus}</span></div> : null}</section>
      {showControls && <StreamControls title={streamTitle} details={streamDetails} connections={connections} onSave={saveStreamInfo} onClose={() => setShowControls(false)} />}
      {menu && <ModMenu menu={menu} onModerate={moderate} onClose={() => setMenu(null)} />}
      <div className="resize-hint"><span>RESIZABLE</span></div>
    </main>
  )
}

export default App
