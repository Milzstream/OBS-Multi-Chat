import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, FlaskConical, Hash, Radio, Settings2, Twitch, Youtube } from 'lucide-react'
import { ActivityRow, platformColor, type ActivityEvent, type ActivityKind, type ActivityPlatform } from './ActivityRow'
import { ConnectionSettings } from '../ConnectionSettings'
import { ScrollPausedBadge, useAutoScroll } from '../autoScroll'
import { ACTIVITY_FILTER_KEY, ACTIVITY_FILTERS, parseStoredFilter, readLocalPref, writeLocalPref, type ActivityFilter } from '../dock-prefs'
import { activityDockFields, subscribeDockSse } from '../sse'

/**
 * The activity dock: renders follows, subs, tips, raids, and more from the
 * server's SSE stream, with a platform filter, relative-time aging, test-alert
 * injector, settings, and the same live-edge scroll convention as chat.
 */

type Filter = ActivityFilter
type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean }

const tests: { label: string; platform: ActivityPlatform; kind: ActivityKind; amount?: string; viewers?: number; message: string; source?: ActivityPlatform }[] = [
  { label: 'Twitch follow', platform: 'Twitch', kind: 'follow', message: 'Test follow' },
  { label: 'Kick follow', platform: 'Kick', kind: 'follow', message: 'Test follow' },
  { label: 'YouTube subscribe', platform: 'YouTube', kind: 'follow', message: 'Test YouTube subscriber' },
  { label: 'YouTube Super Chat', platform: 'YouTube', kind: 'superchat', amount: '$4.99', message: 'Test Super Chat' },
  { label: 'Twitch sub', platform: 'Twitch', kind: 'subscription', message: 'Test sub' },
  { label: 'Twitch cheer', platform: 'Twitch', kind: 'cheer', amount: '100 Bits', message: 'Test cheer' },
  { label: 'Twitch raid', platform: 'Twitch', kind: 'raid', viewers: 42, message: 'Test raid' },
  { label: 'SE donation', platform: 'StreamElements', kind: 'donation', amount: '$5.00', message: 'Test donation', source: 'Twitch' },
  { label: 'SE merch', platform: 'StreamElements', kind: 'merch', amount: 'Hoodie', message: 'Test shop sale' },
]

const initialConnections: Connection[] = [
  { platform: 'Twitch', viewers: 0, handle: '', connected: false, live: false },
  { platform: 'Kick', viewers: 0, handle: '', connected: false, live: false },
  { platform: 'YouTube', viewers: 0, handle: '', connected: false, live: false },
]

const platformRoutes: Record<Platform, string> = { Twitch: 'twitch', Kick: 'kick', YouTube: 'youtube' }

type BackendState = {
  accounts?: Connection[]
  activity?: ActivityEvent[]
  activityWarnings?: string[]
  streamelements?: { connected: boolean; handle: string; missing?: string[] }
  activityFallback?: boolean
  ignoreMissingJwt?: boolean
  dropOldAlerts?: boolean
  translateChat?: boolean
  translateError?: string
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

function platformIcon(platform: Platform | ActivityPlatform, size = 13) {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  if (platform === 'StreamElements') return <Bell size={size} strokeWidth={2.5} />
  return <span className="kick-mark">K</span>
}

export function ActivityWarningBanner({ messages, missingJwts, seConnected, onDismiss }: { messages: string[]; missingJwts: string[]; seConnected: boolean; onDismiss: () => void }) {
  const warningMessages = [...new Set(messages)]
  return (
    <div className="activity-setup">
      <button type="button" className="activity-setup-close" aria-label="Dismiss warning" onClick={onDismiss}>×</button>
      {warningMessages.length ? (
        <>
          <strong>Activity warning</strong>
          {warningMessages.map((message) => <span key={message}>{message}</span>)}
        </>
      ) : (
        <>
          <strong>{seConnected ? 'StreamElements JWTs missing' : 'StreamElements not configured'}</strong>
          <span>{missingJwts.length ? `Add STREAMELEMENTS_JWT_${missingJwts.map((item) => item.toUpperCase()).join(', STREAMELEMENTS_JWT_')} in the environment file.` : 'Add StreamElements JWTs in the environment file.'}</span>
          <span>Save, then restart this app.</span>
        </>
      )}
    </div>
  )
}

export default function ActivityApp() {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [activityWarnings, setActivityWarnings] = useState<string[]>([])
  const [missingJwts, setMissingJwts] = useState<string[]>([])
  const [seConnected, setSeConnected] = useState(false)
  const [seReady, setSeReady] = useState(false)
  const [streamelements, setStreamelements] = useState({ connected: false, handle: '', missing: [] as string[] })
  const [connections, setConnections] = useState(initialConnections)
  const [activityFallback, setActivityFallback] = useState(true)
  const [ignoreMissingJwt, setIgnoreMissingJwt] = useState(false)
  const [dropOldAlerts, setDropOldAlerts] = useState(false)
  const [translateChat, setTranslateChat] = useState(true)
  const [translateError, setTranslateError] = useState('')
  const [dismissedWarning, setDismissedWarning] = useState(false)
  const [filter, setFilter] = useState<Filter>(() => parseStoredFilter(readLocalPref(ACTIVITY_FILTER_KEY), ACTIVITY_FILTERS, 'All'))
  const [now, setNow] = useState(Date.now())
  const [backendOnline, setBackendOnline] = useState(false)
  const [showTests, setShowTests] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [testStatus, setTestStatus] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = 'Relay Activity'
  }, [])

  useEffect(() => {
    writeLocalPref(ACTIVITY_FILTER_KEY, filter)
  }, [filter])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    // Subscribe to Relay's SSE stream. activityDockFields ignores omitted keys
    // so an activity/settings slice cannot flash “StreamElements not configured”.
    const applySnapshot = (remote: BackendState) => {
      const fields = activityDockFields(remote as unknown as Record<string, unknown>)
      if (fields.activity) setEvents(fields.activity as ActivityEvent[])
      if (fields.activityWarnings) setActivityWarnings(fields.activityWarnings as string[])
      if (fields.streamelements) {
        const streamelements = fields.streamelements as { connected: boolean; handle: string; missing?: string[] }
        setMissingJwts(streamelements.missing || [])
        setSeConnected(Boolean(streamelements.connected))
        setStreamelements({ connected: streamelements.connected, handle: streamelements.handle, missing: streamelements.missing || [] })
        setSeReady(true)
      }
      if (fields.accounts?.length) setConnections(fields.accounts as Connection[])
      if (typeof fields.activityFallback === 'boolean') setActivityFallback(fields.activityFallback)
      if (typeof fields.ignoreMissingJwt === 'boolean') setIgnoreMissingJwt(fields.ignoreMissingJwt)
      if (typeof fields.dropOldAlerts === 'boolean') setDropOldAlerts(fields.dropOldAlerts)
      if (typeof fields.translateChat === 'boolean') setTranslateChat(fields.translateChat)
      if (typeof fields.translateError === 'string') setTranslateError(fields.translateError)
      setBackendOnline(true)
    }
    const asState = (data: Record<string, unknown>) => data as unknown as BackendState
    return subscribeDockSse({
      onSnapshot: (data) => applySnapshot(asState(data)),
      onActivity: (data) => applySnapshot(asState(data)),
      onPresence: (data) => applySnapshot(asState(data)),
      onSettings: (data) => applySnapshot(asState(data)),
      onStatus: setBackendOnline,
    })
  }, [])

  const visible = useMemo(() => {
    // Filter rows by the active platform, then order newest-first so new
    // alerts land at the top of the list
    const rows = filter === 'All' ? events : events.filter((event) => event.platform === filter)
    return [...rows].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0))
  }, [events, filter])
  const { paused, onScroll, resume } = useAutoScroll(listRef, 'top', visible[0]?.id)
  const warningMessages = [...new Set(activityWarnings)]
  const showSetup = !dismissedWarning && (warningMessages.length > 0 || (seReady && !ignoreMissingJwt && (missingJwts.length > 0 || !seConnected)))

  const sendTest = (item: (typeof tests)[number]) => {
    setShowTests(false)
    void fetch('/api/activity/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: item.platform, kind: item.kind, user: 'TestUser', amount: item.amount, viewers: item.viewers, message: item.message, source: item.source || item.platform }),
    }).then(async (response) => {
      setTestStatus(response.ok ? `Sent ${item.label}` : 'Test failed')
      window.setTimeout(() => setTestStatus(''), 2500)
    }).catch(() => setTestStatus('Test failed'))
  }

  const connectPlatform = (platform: Platform) => {
    window.open(`/oauth/${platformRoutes[platform]}`, '_blank', 'width=640,height=760,noopener,noreferrer')
  }
  const disconnectPlatform = (platform: Platform) => {
    setConnections((current) => current.map((connection) => connection.platform === platform ? { ...connection, connected: false, live: false, viewers: 0, handle: '' } : connection))
    void fetch(`/api/disconnect/${platform}`, { method: 'POST' })
  }
  const checkLive = (platform: Platform) => fetch(`/api/live-check/${platform}`, { method: 'POST' }).then((response) => { if (!response.ok) return Promise.reject() }).catch(() => undefined)
  const patchSettings = (body: { activityFallback?: boolean; ignoreMissingJwt?: boolean; dropOldAlerts?: boolean; translateChat?: boolean }) => {
    if (typeof body.activityFallback === 'boolean') setActivityFallback(body.activityFallback)
    if (typeof body.ignoreMissingJwt === 'boolean') {
      setIgnoreMissingJwt(body.ignoreMissingJwt)
      if (body.ignoreMissingJwt) setDismissedWarning(true)
    }
    if (typeof body.dropOldAlerts === 'boolean') setDropOldAlerts(body.dropOldAlerts)
    if (typeof body.translateChat === 'boolean') setTranslateChat(body.translateChat)
    void fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  return (
    <main className="activity-app">
      <header className="activity-topbar">
        <Bell size={15} />
        <span className="activity-title">ACTIVITY</span>
        <nav className="activity-filters">
          {ACTIVITY_FILTERS.map((item) => (
            <button key={item} type="button" className={filter === item ? 'activity-filter active' : 'activity-filter'} aria-label={item === 'StreamElements' ? 'SE' : item} title={item === 'StreamElements' ? 'SE' : item} onClick={() => setFilter(item)}>
              {item === 'All' ? <Hash size={13} /> : <span style={{ color: platformColor[item] }}>{platformIcon(item, 13)}</span>}
            </button>
          ))}
        </nav>
        <div className="activity-top-actions">
          {!backendOnline ? <small>offline</small> : testStatus ? <small className="activity-test-status">{testStatus}</small> : null}
          <button type="button" className="activity-test-toggle" aria-label="Send test alerts" disabled={!backendOnline} onClick={() => { setShowSettings(false); setShowTests((open) => !open) }}>
            <FlaskConical size={14} />
          </button>
          <button type="button" className="activity-test-toggle" aria-label="Open settings" onClick={() => { setShowTests(false); setShowSettings((open) => !open) }}>
            <Settings2 size={15} />
          </button>
        </div>
      </header>
      {showTests ? (
        <div className="activity-test-menu">
          <p>Injects a local test row. Does not hit Twitch, Kick, YouTube, or StreamElements.</p>
          {tests.map((item) => (
            <button key={item.label} type="button" onClick={() => sendTest(item)}>
              <span style={{ color: platformColor[item.platform] }}>{platformIcon(item.platform, 12)}</span>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {showSettings && <ConnectionSettings
        connections={connections}
        streamelements={streamelements}
        activityFallback={activityFallback}
        ignoreMissingJwt={ignoreMissingJwt}
        dropOldAlerts={dropOldAlerts}
        translateChat={translateChat}
        translateError={translateError}
        showActivityOptions
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
      {showSetup ? (
        <ActivityWarningBanner messages={warningMessages} missingJwts={missingJwts} seConnected={seConnected} onDismiss={() => setDismissedWarning(true)} />
      ) : null}
      <section className="activity-feed">
        <div className="activity-list" ref={listRef} onScroll={onScroll}>
          {visible.length ? visible.map((event) => (
            <ActivityRow key={event.id} event={event} age={relativeTime(event.time, now)} />
          )) : (
            <div className="empty-chat activity-empty">
              <div className="empty-icon"><Radio size={20} /></div>
              <strong>{events.length ? 'No matching activity' : 'Waiting for activity'}</strong>
              <span>{events.length ? 'Try another platform filter.' : 'Use the flask to send a test row, or connect accounts in settings.'}</span>
            </div>
          )}
        </div>
        {paused ? <ScrollPausedBadge onResume={resume} /> : null}
      </section>
    </main>
  )
}
