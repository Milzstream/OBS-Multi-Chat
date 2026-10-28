import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Filter, FlaskConical, Hash, Radio, Twitch, Youtube } from 'lucide-react'
import { ActivityRow, platformColor, type ActivityEvent, type ActivityKind, type ActivityPlatform } from './ActivityRow'
import { ScrollPausedBadge, useAutoScroll } from '../autoScroll'
import { ACTIVITY_FILTER_KEY, ACTIVITY_FILTERS, ACTIVITY_GROUP_GIFTS_KEY, ACTIVITY_KIND_FILTER_KEY, parseStoredBoolean, parseStoredFilter, parseStoredStringSet, readLocalPref, writeLocalPref, type ActivityFilter } from '../dock-prefs'
import { ACTIVITY_KIND_GROUP_IDS, ACTIVITY_KIND_GROUPS, activityListRows, visibleActivityEvents } from './format'
import { activityDockFields, applyActivitySlice, subscribeDockSse } from '../sse'
import { ACTIVITY_ROW_ESTIMATE, useVirtualWindow } from '../virtualList'

/**
 * The activity dock: renders follows, subs, tips, raids, and more from the
 * server's SSE stream, with platform and kind filters, a virtualized feed,
 * relative-time aging, test-alert injector, settings, and the same live-edge
 * scroll convention as chat.
 */

type Filter = ActivityFilter

const tests: { label: string; platform: ActivityPlatform; kind: ActivityKind }[] = [
  { label: 'Twitch follow', platform: 'Twitch', kind: 'follow' },
  { label: 'Twitch sub', platform: 'Twitch', kind: 'subscription' },
  { label: 'Twitch cheer', platform: 'Twitch', kind: 'cheer' },
  { label: 'Twitch raid', platform: 'Twitch', kind: 'raid' },
  { label: 'Kick follow', platform: 'Kick', kind: 'follow' },
  { label: 'Kick sub', platform: 'Kick', kind: 'subscription' },
  { label: 'Kick KICKs', platform: 'Kick', kind: 'cheer' },
  { label: 'YouTube subscriber', platform: 'YouTube', kind: 'subscription' },
  { label: 'YouTube member', platform: 'YouTube', kind: 'membership' },
  { label: 'YouTube Super Chat', platform: 'YouTube', kind: 'superchat' },
  { label: 'SE donation', platform: 'StreamElements', kind: 'donation' },
  { label: 'SE merch', platform: 'StreamElements', kind: 'merch' },
]

type BackendState = {
  activity?: ActivityEvent[]
  activityWarnings?: string[]
  accounts?: { platform: string; handle?: string; connected?: boolean }[]
  streamelements?: { connected: boolean; handle: string; missing?: string[]; connecting?: boolean }
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

function platformIcon(platform: ActivityPlatform, size = 13) {
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
          <span>{missingJwts.length ? `Add STREAMELEMENTS_JWT_${missingJwts.map((item) => item.toUpperCase()).join(', STREAMELEMENTS_JWT_')} in the Relay Chat Dock window or production.env.` : 'Add StreamElements JWTs in the Relay Chat Dock window or production.env.'}</span>
          <span>Paste a JWT in the Relay Chat Dock window. No restart needed.</span>
        </>
      )}
    </div>
  )
}

export function activityWarningKey(state: {
  warnings: string[]
  missingJwts: string[]
  seConnected: boolean
  seConnecting: boolean
  seReady: boolean
  ignoreMissingJwt: boolean
}) {
  if (state.warnings.length) return `warn:${[...new Set(state.warnings)].sort().join('\n')}`
  if (!state.seReady || state.seConnecting || state.ignoreMissingJwt) return ''
  if (state.missingJwts.length || !state.seConnected) return `setup:${state.seConnected ? 'partial' : 'missing'}:${[...state.missingJwts].sort().join(',')}`
  return ''
}

export function shouldShowActivityWarning(state: {
  warnings: string[]
  missingJwts: string[]
  seConnected: boolean
  seConnecting: boolean
  seReady: boolean
  ignoreMissingJwt: boolean
  dismissed: readonly string[]
}) {
  const key = activityWarningKey(state)
  if (!key) return false
  return !state.dismissed.includes(key)
}

export default function ActivityApp() {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [activityWarnings, setActivityWarnings] = useState<string[]>([])
  const [missingJwts, setMissingJwts] = useState<string[]>([])
  const [seConnected, setSeConnected] = useState(false)
  const [seConnecting, setSeConnecting] = useState(true)
  const [seReady, setSeReady] = useState(false)
  const [ignoreMissingJwt, setIgnoreMissingJwt] = useState(false)
  const [dismissedWarnings, setDismissedWarnings] = useState<string[]>([])
  const [filter, setFilter] = useState<Filter>(() => parseStoredFilter(readLocalPref(ACTIVITY_FILTER_KEY), ACTIVITY_FILTERS, 'All'))
  const [kindFilter, setKindFilter] = useState<string[]>(() => parseStoredStringSet(readLocalPref(ACTIVITY_KIND_FILTER_KEY), ACTIVITY_KIND_GROUP_IDS))
  const [groupGifts, setGroupGifts] = useState(() => parseStoredBoolean(readLocalPref(ACTIVITY_GROUP_GIFTS_KEY), true))
  const [now, setNow] = useState(Date.now())
  const [backendOnline, setBackendOnline] = useState(false)
  const [showTests, setShowTests] = useState(false)
  const [showKinds, setShowKinds] = useState(false)
  const [testStatus, setTestStatus] = useState('')
  const [twitchChannel, setTwitchChannel] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = 'Relay Activity'
  }, [])

  useEffect(() => {
    writeLocalPref(ACTIVITY_FILTER_KEY, filter)
  }, [filter])

  useEffect(() => {
    writeLocalPref(ACTIVITY_KIND_FILTER_KEY, JSON.stringify(kindFilter))
  }, [kindFilter])

  useEffect(() => {
    writeLocalPref(ACTIVITY_GROUP_GIFTS_KEY, String(groupGifts))
  }, [groupGifts])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    // Subscribe to Relay's SSE stream. activityDockFields ignores omitted keys
    // so an activity/settings slice cannot flash “StreamElements not configured”.
    const applySnapshot = (remote: BackendState) => {
      const fields = activityDockFields(remote as unknown as Record<string, unknown>)
      if (fields.activity || fields.activityEvent) setEvents((previous) => applyActivitySlice(previous, fields) as ActivityEvent[])
      if (fields.activityWarnings) setActivityWarnings(fields.activityWarnings as string[])
      if (fields.accounts) {
        const accounts = fields.accounts as { platform?: string; handle?: string; connected?: boolean }[]
        const twitch = accounts.find((account) => account.platform === 'Twitch' && account.connected)
        setTwitchChannel(twitch?.handle || '')
      }
      if (fields.streamelements) {
        const streamelements = fields.streamelements as { connected: boolean; handle: string; missing?: string[]; connecting?: boolean }
        setMissingJwts(streamelements.missing || [])
        setSeConnected(Boolean(streamelements.connected))
        setSeConnecting(Boolean(streamelements.connecting))
        setSeReady(true)
      }
      if (typeof fields.ignoreMissingJwt === 'boolean') setIgnoreMissingJwt(fields.ignoreMissingJwt)
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

  const visible = useMemo(() => activityListRows(visibleActivityEvents(events, filter, kindFilter), groupGifts), [events, filter, kindFilter, groupGifts])
  const { paused, onScroll: onPinScroll, resume } = useAutoScroll(listRef, 'top', visible[0]?.event.id)
  const { start, end, padTop, padBottom, onScroll } = useVirtualWindow(listRef, visible.length, ACTIVITY_ROW_ESTIMATE, 'top', !paused, onPinScroll)
  const kindsRestricted = kindFilter.length !== ACTIVITY_KIND_GROUP_IDS.length
  const warningMessages = [...new Set(activityWarnings)]
  const warningState = { warnings: warningMessages, missingJwts, seConnected, seConnecting, seReady, ignoreMissingJwt }
  const showSetup = shouldShowActivityWarning({ ...warningState, dismissed: dismissedWarnings })

  const sendTest = (item: (typeof tests)[number]) => {
    setShowTests(false)
    void fetch('/api/activity/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: item.platform, kind: item.kind }),
    }).then(async (response) => {
      const result = await response.json().catch(() => ({})) as { error?: string; name?: string }
      setTestStatus(response.ok ? `Emulated ${result.name || item.label}. It plays on stream.` : (result.error || 'Emulate failed'))
      window.setTimeout(() => setTestStatus(''), 4000)
    }).catch(() => setTestStatus('Emulate failed'))
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
          <button type="button" className={showKinds || kindsRestricted ? 'activity-test-toggle active' : 'activity-test-toggle'} aria-label="Filter activity kinds" title="Filter by kind" aria-expanded={showKinds} onClick={() => { setShowTests(false); setShowKinds((open) => !open) }}>
            <Filter size={14} />
          </button>
          <button type="button" className="activity-test-toggle" aria-label="Send test alerts" disabled={!backendOnline} onClick={() => { setShowKinds(false); setShowTests((open) => !open) }}>
            <FlaskConical size={14} />
          </button>
        </div>
      </header>
      {showKinds ? (
        <div className="activity-kind-popover" role="dialog" aria-label="Activity kinds">
          {ACTIVITY_KIND_GROUPS.map((group) => {
            const on = kindFilter.includes(group.id)
            return (
              <label key={group.id} className="settings-toggle">
                <span>{group.label}</span>
                <input type="checkbox" checked={on} onChange={() => setKindFilter((current) => on ? current.filter((id) => id !== group.id) : [...current, group.id])} />
              </label>
            )
          })}
          <label className="settings-toggle activity-view-toggle">
            <span>Group gifted subs under the gifter</span>
            <input type="checkbox" checked={groupGifts} onChange={() => setGroupGifts((on) => !on)} />
          </label>
        </div>
      ) : null}
      {showTests ? (
        <div className="activity-test-menu">
          <p>Fires that StreamElements emulate with Preview LIVE on. Your overlay will play it.</p>
          {tests.map((item) => (
            <button key={item.label} type="button" onClick={() => sendTest(item)}>
              <span style={{ color: platformColor[item.platform] }}>{platformIcon(item.platform, 12)}</span>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {showSetup ? (
        <ActivityWarningBanner messages={warningMessages} missingJwts={missingJwts} seConnected={seConnected} onDismiss={() => {
          const key = activityWarningKey(warningState)
          if (!key) return
          setDismissedWarnings((current) => current.includes(key) ? current : [...current, key])
        }} />
      ) : null}
      <section className="activity-feed">
        <div className="activity-list" ref={listRef} onScroll={onScroll}>
          {visible.length ? (
            <>
              <div className="virtual-spacer" style={{ height: padTop }} aria-hidden="true" />
              {visible.slice(start, end).map(({ event, nested, synthetic }) => (
                <ActivityRow key={event.id} event={event} age={relativeTime(event.time, now)} channelLogin={twitchChannel} nested={nested} onDelete={synthetic ? undefined : (id) => {
                  setEvents((current) => current.filter((item) => item.id !== id))
                  void fetch('/api/activity/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then((response) => {
                    if (!response.ok) setTestStatus('Could not delete that alert')
                  }).catch(() => setTestStatus('Could not delete that alert'))
                }} />
              ))}
              <div className="virtual-spacer" style={{ height: padBottom }} aria-hidden="true" />
            </>
          ) : (
            <div className="empty-chat activity-empty">
              <div className="empty-icon"><Radio size={20} /></div>
              <strong>{events.length ? 'No matching activity' : 'Waiting for activity'}</strong>
              <span>{events.length ? 'Try another platform or kind filter.' : 'Use the flask to send a test row, or connect accounts in settings.'}</span>
            </div>
          )}
        </div>
        {paused ? <ScrollPausedBadge onResume={resume} /> : null}
      </section>
    </main>
  )
}
