import { useEffect, useRef, useState } from 'react'
import { Twitch, Youtube } from 'lucide-react'
import { ConnectionSettings } from './ConnectionSettings'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type LogLine = { id: number; time: string; level: 'log' | 'info' | 'warn' | 'error'; text: string }
type ConsoleInfo = { version: string; envPath: string; dataDir?: string; chatUrl: string; activityUrl: string }
type Settings = {
  translateChat: boolean
  translateError: string
  activityFallback: boolean
  ignoreMissingJwt: boolean
  dropOldAlerts: boolean
  streamelements: { connected: boolean; handle: string; missing?: string[] }
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

export default function ConsoleApp() {
  const [connections, setConnections] = useState<Connection[]>(emptyConnections)
  const [info, setInfo] = useState<ConsoleInfo | null>(null)
  const [settings, setSettings] = useState<Settings>({
    translateChat: true,
    translateError: '',
    activityFallback: true,
    ignoreMissingJwt: false,
    dropOldAlerts: false,
    streamelements: { connected: false, handle: '' },
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
  const logRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

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
      void fetch('/api/state').then((response) => response.ok ? response.json() : null).then((data) => {
        if (cancelled || !data || typeof data !== 'object') return
        const remote = data as Partial<Settings> & { accounts?: Connection[] }
        if (Array.isArray(remote.accounts) && remote.accounts.length) setConnections(remote.accounts)
        setSettings((current) => ({
          translateChat: typeof remote.translateChat === 'boolean' ? remote.translateChat : current.translateChat,
          translateError: typeof remote.translateError === 'string' ? remote.translateError : current.translateError,
          activityFallback: typeof remote.activityFallback === 'boolean' ? remote.activityFallback : current.activityFallback,
          ignoreMissingJwt: typeof remote.ignoreMissingJwt === 'boolean' ? remote.ignoreMissingJwt : current.ignoreMissingJwt,
          dropOldAlerts: typeof remote.dropOldAlerts === 'boolean' ? remote.dropOldAlerts : current.dropOldAlerts,
          streamelements: remote.streamelements && typeof remote.streamelements === 'object' ? remote.streamelements : current.streamelements,
          youtubeQuota: remote.youtubeQuota && typeof remote.youtubeQuota === 'object' ? remote.youtubeQuota : current.youtubeQuota,
        }))
      }).catch(() => undefined)
    }
    const loadJwts = () => {
      void fetch('/api/jwts').then((response) => response.ok ? response.json() : null).then((tokens) => {
        if (cancelled || !tokens || typeof tokens !== 'object') return
        const record = tokens as Record<string, unknown>
        setJwtDraft({
          Twitch: String(record.Twitch || ''),
          Kick: String(record.Kick || ''),
          YouTube: String(record.YouTube || ''),
        })
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

  const patchSettings = (body: Partial<Pick<Settings, 'translateChat' | 'activityFallback' | 'ignoreMissingJwt' | 'dropOldAlerts'>>) => {
    setSettings((current) => ({ ...current, ...body }))
    void fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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
  const quit = () => {
    void fetch('/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  }

  const missing = settings.streamelements.missing || []

  return (
    <main className="console-app">
      <header className="console-top">
        <div>
          <strong>Relay Chat Dock{info?.version ? ` v${info.version}` : ''}</strong>
          <span>Closing this window stops the OBS docks.</span>
        </div>
        <button type="button" className="console-quit" onClick={quit}>Quit</button>
      </header>
      <section className="console-meta">
        <div>
          <span>Data</span>
          <code>{info?.dataDir || '…'}</code>
        </div>
        <div>
          <span>Configuration</span>
          <code>{info?.envPath || '…'}</code>
        </div>
        <div>
          <span>Chat dock</span>
          <code>{info?.chatUrl || '…'}</code>
          {info?.chatUrl ? <button type="button" onClick={() => void copy('chat', info.chatUrl)}>{copied === 'chat' ? 'Copied' : 'Copy'}</button> : null}
        </div>
        <div>
          <span>Activity dock</span>
          <code>{info?.activityUrl || '…'}</code>
          {info?.activityUrl ? <button type="button" onClick={() => void copy('activity', info.activityUrl)}>{copied === 'activity' ? 'Copied' : 'Copy'}</button> : null}
        </div>
      </section>
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
            note="Connect opens in your browser. Chat and activity stay in the OBS docks."
          />
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
          <p className="settings-note">{settings.streamelements.connected ? settings.streamelements.handle : 'Not configured'}{missing.length ? ` · missing ${missing.join(', ')}` : ''}</p>
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

        </aside>
      </div>
    </main>
  )
}
