import { useEffect, useRef, useState } from 'react'
import { Bell, Twitch, Youtube } from 'lucide-react'
import { ConnectionSettings } from './ConnectionSettings'
import { postYoutubePrivacy, type YoutubePrivacyNotice } from './chat-helpers'
import { YoutubePrivacyBanner } from './YoutubePrivacyBanner'
import { ALERT_PLATFORMS, ALERT_TYPES, DEFAULT_ALERT_SETTINGS, alertKey, parseAlertSettings, type AlertPlatform, type AlertSettings } from './alerts/alerts'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type LogLine = { id: number; time: string; level: 'log' | 'info' | 'warn' | 'error'; text: string }
type ConsoleInfo = { version: string; envPath: string; dataDir?: string; chatUrl: string; activityUrl: string; alertsUrl?: string; watchUrl?: string | null; lanEnabled?: boolean }
type AutoLiveCheck = Record<Platform, boolean>
type Settings = {
  translateChat: boolean
  translateError: string
  activityFallback: boolean
  ignoreMissingJwt: boolean
  dropOldAlerts: boolean
  autoLiveCheck: AutoLiveCheck
  streamelements: { connected: boolean; handle: string; missing?: string[]; connecting?: boolean }
  youtubeQuota: { used: number; limit: number }
}

const JWT_PLATFORMS: Platform[] = ['Twitch', 'Kick', 'YouTube']
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean }
const emptyConnections: Connection[] = [
  { platform: 'Twitch', viewers: 0, handle: '', connected: false, live: false },
  { platform: 'Kick', viewers: 0, handle: '', connected: false, live: false },
  { platform: 'YouTube', viewers: 0, handle: '', connected: false, live: false },
]

function clock(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function platformIcon(platform: Platform, size = 14) {
  if (platform === 'Twitch') return <Twitch size={size} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={size} strokeWidth={2.5} />
  return <span className="kick-mark">K</span>
}

function platformMark(platform: Platform) {
  if (platform === 'Twitch') return <Twitch size={12} strokeWidth={2.5} />
  if (platform === 'YouTube') return <Youtube size={12} strokeWidth={2.5} />
  return <span className="kick-mark">K</span>
}

export const SETTINGS_TOGGLE_KEYS = ['translateChat', 'activityFallback', 'ignoreMissingJwt', 'dropOldAlerts'] as const
export type SettingsToggleKey = typeof SETTINGS_TOGGLE_KEYS[number]
export type SettingsPatch = Partial<Record<SettingsToggleKey, boolean>> & {
  autoLiveCheck?: Partial<AutoLiveCheck>
}

type PolledSettings = {
  translateChat: boolean
  translateError: string
  activityFallback: boolean
  ignoreMissingJwt: boolean
  dropOldAlerts: boolean
  autoLiveCheck: AutoLiveCheck
  streamelements: Settings['streamelements']
  youtubeQuota: Settings['youtubeQuota']
}

export function settingsInFlightKeys(body: SettingsPatch) {
  const keys: string[] = []
  for (const key of SETTINGS_TOGGLE_KEYS) if (typeof body[key] === 'boolean') keys.push(key)
  if (body.autoLiveCheck) {
    for (const platform of ['Twitch', 'Kick', 'YouTube'] as const) {
      if (typeof body.autoLiveCheck[platform] === 'boolean') keys.push(`autoLiveCheck.${platform}`)
    }
  }
  return keys
}

export function mergePolledSettings<T extends PolledSettings>(current: T, remote: Partial<T>, inFlight: ReadonlySet<string>): T {
  const next = { ...current }
  if (!inFlight.has('translateChat') && typeof remote.translateChat === 'boolean') next.translateChat = remote.translateChat
  if (typeof remote.translateError === 'string') next.translateError = remote.translateError
  if (!inFlight.has('activityFallback') && typeof remote.activityFallback === 'boolean') next.activityFallback = remote.activityFallback
  if (!inFlight.has('ignoreMissingJwt') && typeof remote.ignoreMissingJwt === 'boolean') next.ignoreMissingJwt = remote.ignoreMissingJwt
  if (!inFlight.has('dropOldAlerts') && typeof remote.dropOldAlerts === 'boolean') next.dropOldAlerts = remote.dropOldAlerts
  if (remote.autoLiveCheck && typeof remote.autoLiveCheck === 'object') {
    next.autoLiveCheck = {
      Twitch: inFlight.has('autoLiveCheck.Twitch') ? current.autoLiveCheck.Twitch : remote.autoLiveCheck.Twitch !== false,
      Kick: inFlight.has('autoLiveCheck.Kick') ? current.autoLiveCheck.Kick : remote.autoLiveCheck.Kick !== false,
      YouTube: inFlight.has('autoLiveCheck.YouTube') ? current.autoLiveCheck.YouTube : remote.autoLiveCheck.YouTube !== false,
    }
  }
  if (remote.streamelements && typeof remote.streamelements === 'object') next.streamelements = remote.streamelements
  if (remote.youtubeQuota && typeof remote.youtubeQuota === 'object') next.youtubeQuota = remote.youtubeQuota
  return next
}

export function applySettingsPatch<T extends PolledSettings>(current: T, body: SettingsPatch): T {
  const next = { ...current, autoLiveCheck: { ...current.autoLiveCheck } }
  for (const key of SETTINGS_TOGGLE_KEYS) if (typeof body[key] === 'boolean') next[key] = body[key]
  if (body.autoLiveCheck) {
    for (const platform of ['Twitch', 'Kick', 'YouTube'] as const) {
      if (typeof body.autoLiveCheck[platform] === 'boolean') next.autoLiveCheck[platform] = body.autoLiveCheck[platform]
    }
  }
  return next
}

export function restoreSettingsKeys<T extends PolledSettings>(current: T, previous: T, keys: readonly string[]): T {
  const next = { ...current, autoLiveCheck: { ...current.autoLiveCheck } }
  for (const key of keys) {
    if (key.startsWith('autoLiveCheck.')) {
      const platform = key.slice('autoLiveCheck.'.length) as Platform
      next.autoLiveCheck[platform] = previous.autoLiveCheck[platform]
    } else if (key === 'translateChat' || key === 'activityFallback' || key === 'ignoreMissingJwt' || key === 'dropOldAlerts') {
      next[key] = previous[key]
    }
  }
  return next
}

export function mergeJwtDraft(current: Record<Platform, string>, remote: Record<string, unknown>, edited: ReadonlySet<string>) {
  const next = { ...current }
  for (const platform of JWT_PLATFORMS) {
    if (edited.has(platform) || !(platform in remote)) continue
    next[platform] = String(remote[platform] || '')
  }
  return next
}

export function settingsSaveError(ok: boolean, status: number, body: { error?: unknown }) {
  if (ok && !body.error) return ''
  if (typeof body.error === 'string' && body.error.trim()) return body.error.trim()
  return `Could not save settings (${status || 'network'})`
}

export default function ConsoleApp() {
  const [connections, setConnections] = useState<Connection[]>(emptyConnections)
  const [info, setInfo] = useState<ConsoleInfo | null>(null)
  const [settings, setSettings] = useState<Settings>({
    translateChat: true,
    translateError: '',
    activityFallback: true,
    ignoreMissingJwt: false,
    dropOldAlerts: false,
    autoLiveCheck: { Twitch: true, Kick: true, YouTube: true },
    streamelements: { connected: false, handle: '', connecting: true },
    youtubeQuota: { used: 0, limit: 10000 },
  })
  const [lines, setLines] = useState<LogLine[]>([])
  const [jwtDraft, setJwtDraft] = useState<Record<Platform, string>>({ Twitch: '', Kick: '', YouTube: '' })
  const [jwtFocus, setJwtFocus] = useState<Platform | null>(null)
  const [jwtBusy, setJwtBusy] = useState<Partial<Record<Platform, boolean>>>({})
  const [jwtStatus, setJwtStatus] = useState<Partial<Record<Platform, { ok: boolean; text: string }>>>({})
  const [showQuota, setShowQuota] = useState(false)
  const [quotaDraft, setQuotaDraft] = useState('')
  const [quotaStatus, setQuotaStatus] = useState('')
  const [copied, setCopied] = useState('')
  const [youtubePrivacy, setYoutubePrivacy] = useState<YoutubePrivacyNotice[]>([])
  const [privacyStatus, setPrivacyStatus] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [alerts, setAlerts] = useState<AlertSettings>(DEFAULT_ALERT_SETTINGS)
  const [alertPlatform, setAlertPlatform] = useState<AlertPlatform | null>(null)
  const [alertSecDraft, setAlertSecDraft] = useState<string | null>(null)
  const alertsBusy = useRef(0)
  const logRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const settingsRef = useRef(settings)
  const inFlightRef = useRef(new Set<string>())
  const settingsEpoch = useRef(0)
  const jwtEditedRef = useRef(new Set<Platform>())
  settingsRef.current = settings

  useEffect(() => {
    document.title = 'Relay Chat Dock'
    const host = new URLSearchParams(location.search).get('host')
    if (host !== '1') return
    void fetch('/api/console/host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const bye = (event: PageTransitionEvent) => {
      if (event.persisted) return
      navigator.sendBeacon('/api/console/bye', new Blob(['{}'], { type: 'application/json' }))
    }
    window.addEventListener('pagehide', bye)
    return () => window.removeEventListener('pagehide', bye)
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadInfo = () => {
      void fetch('/api/console').then((response) => response.ok ? response.json() : null).then((data) => {
        if (!cancelled && data) setInfo(data as ConsoleInfo)
      }).catch(() => undefined)
    }
    const loadSettings = () => {
      const epoch = settingsEpoch.current
      void fetch('/api/state').then((response) => response.ok ? response.json() : null).then((data) => {
        if (cancelled || epoch !== settingsEpoch.current || !data || typeof data !== 'object') return
        const remote = data as Partial<Settings> & { accounts?: Connection[]; youtubePrivacy?: YoutubePrivacyNotice[]; alerts?: unknown }
        if (remote.alerts && alertsBusy.current === 0) setAlerts(parseAlertSettings(remote.alerts))
        if (Array.isArray(remote.accounts) && remote.accounts.length) setConnections(remote.accounts)
        setSettings((current) => mergePolledSettings(current, remote, inFlightRef.current))
        if (Array.isArray(remote.youtubePrivacy)) setYoutubePrivacy(remote.youtubePrivacy)
      }).catch(() => undefined)
    }
    const loadJwts = () => {
      void fetch('/api/jwts').then((response) => response.ok ? response.json() : null).then((tokens) => {
        if (cancelled || !tokens || typeof tokens !== 'object') return
        setJwtDraft((current) => mergeJwtDraft(current, tokens as Record<string, unknown>, jwtEditedRef.current))
      }).catch(() => undefined)
    }
    loadInfo()
    loadSettings()
    loadJwts()
    const timer = window.setInterval(loadSettings, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    const source = new EventSource('/events/logs')
    source.onmessage = (event) => {
      const line = JSON.parse(event.data) as LogLine
      setLines((current) => current.some((item) => item.id === line.id) ? current : [...current, line].slice(-1500))
    }
    return () => source.close()
  }, [])

  useEffect(() => {
    const node = logRef.current
    if (stickRef.current && node) node.scrollTop = node.scrollHeight
  }, [lines])

  const patchSettings = (body: SettingsPatch) => {
    const keys = settingsInFlightKeys(body)
    if (!keys.length || keys.some((key) => inFlightRef.current.has(key))) return
    const previous = settingsRef.current
    settingsEpoch.current += 1
    for (const key of keys) inFlightRef.current.add(key)
    const optimistic = applySettingsPatch(previous, body)
    settingsRef.current = optimistic
    setSettings(optimistic)
    void fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as Partial<Settings> & { error?: string }
        const error = settingsSaveError(response.ok, response.status, data)
        if (error) {
          setSettingsError(error)
          setSettings((current) => {
            const restored = restoreSettingsKeys(current, previous, keys)
            settingsRef.current = restored
            return restored
          })
          return
        }
        setSettingsError('')
        setSettings((current) => {
          const others = new Set([...inFlightRef.current].filter((key) => !keys.includes(key)))
          const next = mergePolledSettings(current, data, others)
          settingsRef.current = next
          return next
        })
      })
      .catch(() => {
        setSettingsError('Could not save settings')
        setSettings((current) => {
          const restored = restoreSettingsKeys(current, previous, keys)
          settingsRef.current = restored
          return restored
        })
      })
      .finally(() => {
        for (const key of keys) inFlightRef.current.delete(key)
        settingsEpoch.current += 1
      })
  }

  const saveJwt = async (platform: Platform) => {
    if (jwtBusy[platform]) return
    const value = jwtDraft[platform].trim()
    setJwtBusy((current) => ({ ...current, [platform]: true }))
    try {
      const response = await fetch('/api/jwts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [platform]: value }) })
      const data = await response.json() as { error?: string }
      setJwtStatus((current) => ({ ...current, [platform]: { ok: response.ok && !data.error, text: data.error || (value ? 'Saved' : 'Cleared') } }))
    } catch {
      setJwtStatus((current) => ({ ...current, [platform]: { ok: false, text: 'Could not save JWT' } }))
    } finally {
      setJwtBusy((current) => ({ ...current, [platform]: false }))
    }
  }

  const saveQuota = async () => {
    const input = quotaDraft.trim()
    if (!input) return
    try {
      const response = await fetch('/api/youtube-quota', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) })
      const data = await response.json() as { error?: string }
      setQuotaStatus(response.ok ? 'Saved' : data.error || 'Could not save quota')
      if (response.ok) setQuotaDraft('')
    } catch {
      setQuotaStatus('Could not save quota')
    }
  }

  const toggleWatch = async () => {
    const enabled = !info?.lanEnabled
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lanWatch: enabled }) })
      const data = await response.json() as { lanEnabled?: boolean; watchUrl?: string | null }
      if (!response.ok) return
      setInfo((current) => current ? { ...current, lanEnabled: Boolean(data.lanEnabled), watchUrl: data.watchUrl || null } : current)
      if (enabled && data.watchUrl) await copy('watch', data.watchUrl)
    } catch { /* button stays as it was */ }
  }

  const patchAlerts = async (patch: Partial<AlertSettings>) => {
    const previous = alerts
    setAlerts({ ...alerts, ...patch })
    alertsBusy.current += 1
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alerts: patch }) })
      const data = await response.json() as { alerts?: unknown }
      if (!response.ok) throw new Error('save')
      if (data.alerts) setAlerts(parseAlertSettings(data.alerts))
      return true
    } catch {
      setAlerts(previous)
      return false
    } finally {
      alertsBusy.current -= 1
    }
  }

  const toggleAlerts = async () => {
    const enabled = !alerts.enabled
    const saved = await patchAlerts({ enabled })
    if (saved && enabled && info?.alertsUrl) await copy('alerts', info.alertsUrl)
  }

  const commitAlertSeconds = () => {
    if (alertSecDraft == null) return
    const seconds = Number(alertSecDraft)
    setAlertSecDraft(null)
    if (Number.isFinite(seconds) && seconds > 0 && seconds !== alerts.displaySec) void patchAlerts({ displaySec: seconds })
  }

  const toggleAlertType = (platform: AlertPlatform, kind: string) => {
    const key = alertKey(platform, kind)
    const disabled = alerts.disabled.includes(key) ? alerts.disabled.filter((item) => item !== key) : [...alerts.disabled, key]
    void patchAlerts({ disabled })
  }

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied((current) => current === label ? '' : current), 1200)
    } catch { /* selectable text remains */ }
  }

  const connectPlatform = (platform: Platform) => {
    window.open(`/oauth/${platform.toLowerCase()}`, '_blank', 'noopener,noreferrer')
  }
  const disconnectPlatform = (platform: Platform) => {
    setConnections((current) => current.map((item) => item.platform === platform ? { ...item, connected: false, live: false, viewers: 0, handle: '' } : item))
    void fetch(`/api/disconnect/${platform}`, { method: 'POST' })
  }
  const checkLive = (platform: Platform) => fetch(`/api/live-check/${platform}`, { method: 'POST' }).then((response) => { if (!response.ok) return Promise.reject() })
  const toggleAutoLiveCheck = (platform: Platform, enabled: boolean) => {
    patchSettings({ autoLiveCheck: { [platform]: enabled } })
  }

  const missing = settings.streamelements.missing || []

  return (
    <main className="console-app">
      <header className="console-top">
        <div>
          <strong>Relay Chat Dock{info?.version ? ` v${info.version}` : ''}</strong>
          <span>Closing this window stops the OBS docks.</span>
        </div>
        <nav className="console-links">
          <button type="button" title={info?.dataDir || 'Data folder'} disabled={!info?.dataDir} onClick={() => info?.dataDir && void copy('data', info.dataDir)}>{copied === 'data' ? 'Copied' : 'Data'}</button>
          <button type="button" title={info?.envPath || 'Configuration file'} disabled={!info?.envPath} onClick={() => info?.envPath && void copy('config', info.envPath)}>{copied === 'config' ? 'Copied' : 'Config'}</button>
          <button type="button" title={info?.chatUrl || 'Chat dock URL'} disabled={!info?.chatUrl} onClick={() => info?.chatUrl && void copy('chat', info.chatUrl)}>{copied === 'chat' ? 'Copied' : 'Chat dock'}</button>
          <button type="button" title={info?.activityUrl || 'Activity dock URL'} disabled={!info?.activityUrl} onClick={() => info?.activityUrl && void copy('activity', info.activityUrl)}>{copied === 'activity' ? 'Copied' : 'Activity dock'}</button>
          <button
            type="button"
            className={alerts.enabled ? 'watch-on' : 'watch-off'}
            title={alerts.enabled ? `${info?.alertsUrl || 'Alerts are on'}\nRight-click to copy. Click to turn off.` : 'Turn on the on-stream alert page, one OBS browser source for every platform.'}
            onClick={() => void toggleAlerts()}
            onContextMenu={(event) => {
              event.preventDefault()
              if (info?.alertsUrl) void copy('alerts', info.alertsUrl)
            }}
          >{copied === 'alerts' ? 'Copied' : alerts.enabled ? 'Alerts on' : 'Alerts'}</button>
          <button
            type="button"
            className={info?.lanEnabled ? 'watch-on' : 'watch-off'}
            title={info?.lanEnabled ? `${info.watchUrl || 'Watch is on'}\nRight-click to copy. Click to turn off.` : 'Turn on a readonly LAN watch link. Chat and activity docks stay on this computer.'}
            onClick={() => void toggleWatch()}
            onContextMenu={(event) => {
              event.preventDefault()
              if (info?.watchUrl) void copy('watch', info.watchUrl)
            }}
          >{copied === 'watch' ? 'Copied' : info?.lanEnabled ? 'Watch on' : 'Watch'}</button>
        </nav>
      </header>
      {youtubePrivacy.map((item) => (
        <YoutubePrivacyBanner key={item.videoId} notice={item} className="console-privacy" status={privacyStatus} onPublic={() => { void postYoutubePrivacy([item.videoId]).then(() => setPrivacyStatus('Set to public')).catch((error) => setPrivacyStatus(error instanceof Error ? error.message : 'Could not make the video public')) }} onDismiss={() => { void postYoutubePrivacy([item.videoId], 'dismiss').catch(() => setPrivacyStatus('Could not dismiss')) }} />
      ))}
      <div className="console-body">
        <div
          className="console-log"
          ref={logRef}
          onScroll={(event) => {
            const node = event.currentTarget
            stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
          }}
        >
          {lines.some((line) => line.text.trim()) ? lines.filter((line) => line.text.trim()).map((line) => (
            <p key={line.id} className={line.level === 'log' || line.level === 'info' ? 'console-line' : `console-line ${line.level}`}><time>{clock(line.time)}</time><span>{line.text}</span></p>
          )) : <p className="console-line">Waiting for output…</p>}
        </div>
        <aside className="console-settings">
          <ConnectionSettings
            embedded
            connections={connections}
            platformIcon={platformIcon}
            onConnect={connectPlatform}
            onDisconnect={disconnectPlatform}
            onCheckLive={checkLive}
            autoLiveCheck={settings.autoLiveCheck}
            onToggleAutoLiveCheck={toggleAutoLiveCheck}
            note="Connect opens in your browser. Chat and activity stay in the OBS docks. Auto checks whether each platform is live. Uncheck it to pause those status polls until you press Check live."
          />
          {settingsError ? <p className="settings-jwt-error">{settingsError}</p> : null}
          <span className="settings-section-title">CHAT</span>
          <label className="settings-toggle">
            <span>Translate non-English chat to English</span>
            <input type="checkbox" checked={settings.translateChat} onChange={() => patchSettings({ translateChat: !settings.translateChat })} />
          </label>
          {settings.translateChat && settings.translateError ? <p className="settings-note">{settings.translateError}</p> : null}
          <div className="settings-divider" />
          <button type="button" className="console-optional" onClick={() => setShowQuota((open) => !open)}>
            <span>YouTube quota</span>
            <small>{settings.youtubeQuota.used.toLocaleString()} / {settings.youtubeQuota.limit.toLocaleString()}</small>
          </button>
          {showQuota ? (
            <>
              <p className="settings-note">Optional. Queries per day current usage, for example 35 or 35/10000. Ignore the All quotas card.</p>
              <div className="settings-jwt-field">
                <input value={quotaDraft} placeholder="35 or 35/10000" onChange={(event) => { setQuotaDraft(event.target.value); setQuotaStatus('') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveQuota() } }} />
                <button type="button" onClick={() => void saveQuota()}>Save</button>
              </div>
              {quotaStatus ? <p className={quotaStatus === 'Saved' ? 'settings-jwt-ok' : 'settings-jwt-error'}>{quotaStatus}</p> : null}
              <button type="button" className="console-link" onClick={() => void fetch('/api/console/quota-page', { method: 'POST' })}>Open quotas page</button>
            </>
          ) : null}
          <div className="settings-divider" />
          <span className="settings-section-title">STREAMELEMENTS</span>
          <p className="settings-note">{settings.streamelements.connected ? settings.streamelements.handle : settings.streamelements.connecting ? 'Connecting…' : 'Not configured'}{missing.length ? ` · missing ${missing.join(', ')}` : ''}</p>
          {JWT_PLATFORMS.map((platform) => (
            <div key={platform} className="settings-jwt">
              <span className="console-jwt-label"><span style={{ color: platform === 'Twitch' ? '#a970ff' : platform === 'YouTube' ? '#ff5b62' : '#62c554' }}>{platformMark(platform)}</span>{platform} JWT</span>
              <div className="settings-jwt-field">
                <input
                  type={jwtFocus === platform ? 'text' : 'password'}
                  value={jwtDraft[platform]}
                  placeholder="Paste JWT"
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={() => setJwtFocus(platform)}
                  onBlur={() => setJwtFocus((current) => current === platform ? null : current)}
                  onChange={(event) => {
                    jwtEditedRef.current.add(platform)
                    setJwtDraft((current) => ({ ...current, [platform]: event.target.value }))
                    if (jwtStatus[platform]) setJwtStatus((current) => ({ ...current, [platform]: undefined }))
                  }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveJwt(platform) } }}
                />
                {jwtFocus === platform ? (
                  <button type="button" disabled={Boolean(jwtBusy[platform])} onMouseDown={(event) => event.preventDefault()} onClick={() => void saveJwt(platform)}>
                    {jwtBusy[platform] ? '…' : 'Save'}
                  </button>
                ) : null}
              </div>
              {jwtStatus[platform] ? <p className={jwtStatus[platform].ok ? 'settings-jwt-ok' : 'settings-jwt-error'}>{jwtStatus[platform].text}</p> : null}
            </div>
          ))}
          <label className="settings-toggle">
            <span>Use connected accounts as backup for StreamElements</span>
            <input type="checkbox" checked={settings.activityFallback} onChange={() => patchSettings({ activityFallback: !settings.activityFallback })} />
          </label>
          <label className="settings-toggle">
            <span>Ignore missing StreamElements JWT alerts</span>
            <input type="checkbox" checked={settings.ignoreMissingJwt} onChange={() => patchSettings({ ignoreMissingJwt: !settings.ignoreMissingJwt })} />
          </label>
          <label className="settings-toggle">
            <span>Drop alerts older than 30 days</span>
            <input type="checkbox" checked={settings.dropOldAlerts} onChange={() => patchSettings({ dropOldAlerts: !settings.dropOldAlerts })} />
          </label>
          <div className="settings-divider" />
          <span className="settings-section-title">ALERTS</span>
          <p className="settings-note">
            {alerts.enabled && info?.alertsUrl ? <>Add this as an OBS browser source and enable Control audio via OBS for sound: <code>{info.alertsUrl}</code></> : 'Use the Alerts button at the top to turn on the on-stream alert page.'}
          </p>
          <label className="settings-toggle">
            <span>Play alert sounds</span>
            <input type="checkbox" checked={alerts.sound} onChange={() => void patchAlerts({ sound: !alerts.sound })} />
          </label>
          <label className="alert-time">
            <span>Display time (seconds)</span>
            <input
              type="number"
              min={1}
              max={30}
              step={0.5}
              value={alertSecDraft ?? String(alerts.displaySec)}
              onChange={(event) => setAlertSecDraft(event.target.value)}
              onBlur={commitAlertSeconds}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitAlertSeconds() } }}
            />
          </label>
          <div className="alert-platforms">
            {ALERT_PLATFORMS.map((platform) => (
              <button key={platform} type="button" className={alertPlatform === platform ? 'active' : undefined} title={`${platform} alert types`} onClick={() => setAlertPlatform((current) => current === platform ? null : platform)}>
                {platform === 'StreamElements' ? <Bell size={14} strokeWidth={2.5} /> : platformIcon(platform)}
              </button>
            ))}
          </div>
          {alertPlatform ? ALERT_TYPES[alertPlatform].map((type) => (
            <label key={type.kind} className="settings-toggle">
              <span>{type.label}</span>
              <input type="checkbox" checked={!alerts.disabled.includes(alertKey(alertPlatform, type.kind))} onChange={() => toggleAlertType(alertPlatform, type.kind)} />
            </label>
          )) : null}
        </aside>
      </div>
    </main>
  )
}
