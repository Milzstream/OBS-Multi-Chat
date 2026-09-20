import { useEffect, useState, type ReactNode } from 'react'
import { Bell } from 'lucide-react'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean }
type StreamElementsStatus = { connected: boolean; handle: string; missing?: string[] }
const platformMeta: Record<Platform, { color: string }> = {
  Twitch: { color: '#a970ff' },
  Kick: { color: '#62c554' },
  YouTube: { color: '#ff5b62' },
}

const JWT_PLATFORMS: Platform[] = ['Twitch', 'Kick', 'YouTube']

/**
 * The connection settings popover: per-platform connect/disconnect and live
 * checks, plus Chat / Activity sections. JWT fields stay masked until focused.
 */

export function ConnectionSettings({
  connections,
  streamelements,
  activityFallback,
  ignoreMissingJwt,
  dropOldAlerts,
  translateChat,
  translateError,
  showActivityOptions,
  platformIcon,
  onClose,
  onConnect,
  onDisconnect,
  onCheckLive,
  onToggleFallback,
  onToggleIgnoreMissing,
  onToggleDropOld,
  onToggleTranslateChat,
  onJwtChange,
  note,
}: {
  connections: Connection[]
  streamelements: StreamElementsStatus
  activityFallback: boolean
  ignoreMissingJwt: boolean
  dropOldAlerts: boolean
  translateChat: boolean
  translateError?: string
  showActivityOptions: boolean
  platformIcon: (platform: Platform, size?: number) => ReactNode
  onClose: () => void
  onConnect: (platform: Platform) => void
  onDisconnect: (platform: Platform) => void
  onCheckLive: (platform: Platform) => Promise<void> | void
  onToggleFallback: () => void
  onToggleIgnoreMissing: () => void
  onToggleDropOld: () => void
  onToggleTranslateChat: () => void
  onJwtChange?: (platform: Platform, jwt: string) => Promise<string | void> | void
  note?: string
}) {
  const missing = streamelements.missing || []
  const [checking, setChecking] = useState<Partial<Record<Platform, boolean>>>({})
  const [jwtSaved, setJwtSaved] = useState<Record<string, string>>({ Twitch: '', Kick: '', YouTube: '' })
  const [jwtDraft, setJwtDraft] = useState<Record<string, string>>({ Twitch: '', Kick: '', YouTube: '' })
  const [jwtFocus, setJwtFocus] = useState<Platform | null>(null)
  const [jwtBusy, setJwtBusy] = useState<Partial<Record<Platform, boolean>>>({})
  const [jwtError, setJwtError] = useState<Partial<Record<Platform, string>>>({})
  useEffect(() => {
    if (!showActivityOptions) return
    let cancelled = false
    void fetch('/api/jwts').then((response) => response.ok ? response.json() : null).then((tokens) => {
      if (cancelled || !tokens || typeof tokens !== 'object') return
      const next = {
        Twitch: String((tokens as Record<string, unknown>).Twitch || ''),
        Kick: String((tokens as Record<string, unknown>).Kick || ''),
        YouTube: String((tokens as Record<string, unknown>).YouTube || ''),
      }
      setJwtSaved(next)
      setJwtDraft(next)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [showActivityOptions])
  const checkLive = async (platform: Platform) => {
    if (checking[platform]) return
    setChecking((current) => ({ ...current, [platform]: true }))
    try { await onCheckLive(platform) } finally { setChecking((current) => ({ ...current, [platform]: false })) }
  }
  const saveJwt = async (platform: Platform) => {
    const value = jwtDraft[platform].trim()
    if (!value || jwtBusy[platform]) return
    setJwtBusy((current) => ({ ...current, [platform]: true }))
    try {
      const error = await onJwtChange?.(platform, value)
      if (error) setJwtError((current) => ({ ...current, [platform]: error }))
      else {
        setJwtError((current) => ({ ...current, [platform]: '' }))
        setJwtSaved((current) => ({ ...current, [platform]: value }))
        setJwtDraft((current) => ({ ...current, [platform]: value }))
      }
    } catch {
      setJwtError((current) => ({ ...current, [platform]: 'Could not save JWT' }))
    } finally {
      setJwtBusy((current) => ({ ...current, [platform]: false }))
    }
  }
  return (
    <aside className="settings-popover">
      <div className="popover-title"><span>CONNECTION SETTINGS</span><button type="button" onClick={onClose} aria-label="Close settings">×</button></div>
      {note ? <p className="settings-note">{note}</p> : null}
      {connections.map((connection) => (
        <div className="connection-row" key={connection.platform}>
          <span style={{ color: platformMeta[connection.platform].color }}>{platformIcon(connection.platform, 14)}</span>
          <div>
            <strong>{connection.platform}</strong>
            <small>{connection.connected ? connection.handle : 'Not connected'}</small>
          </div>
          {connection.connected
            ? (
              <div className="connection-actions">
                <button type="button" className="live-check" disabled={checking[connection.platform]} title="Run a live check now without waiting for the next automatic poll" onClick={() => void checkLive(connection.platform)}>
                  {checking[connection.platform] ? 'Checking…' : 'Check live'}
                </button>
                <button type="button" className="disconnect" onClick={() => onDisconnect(connection.platform)}>Disconnect</button>
              </div>
            )
            : <button type="button" className="connect" onClick={() => onConnect(connection.platform)}>Connect</button>}
        </div>
      ))}
      <div className="settings-divider" />
      <span className="settings-section-title">CHAT</span>
      <label className="settings-toggle">
        <span>Translate non-English chat to English</span>
        <input type="checkbox" checked={translateChat} onChange={onToggleTranslateChat} />
      </label>
      {translateChat && translateError ? <p className="settings-note">{translateError}</p> : null}
      {showActivityOptions ? (
        <>
          <div className="settings-divider" />
          <span className="settings-section-title">ACTIVITY ALERTS</span>
          <div className="connection-row">
            <span style={{ color: '#f3af61' }}><Bell size={14} /></span>
            <div>
              <strong>StreamElements</strong>
              <small>{streamelements.connected ? streamelements.handle : 'Not configured'}{missing.length ? ` · missing ${missing.join(', ')}` : ''}</small>
            </div>
          </div>
          {JWT_PLATFORMS.map((platform) => {
            const draft = jwtDraft[platform] || ''
            const dirty = draft.trim() !== (jwtSaved[platform] || '').trim()
            const showSave = jwtFocus === platform && dirty && Boolean(draft.trim())
            return (
              <div key={platform} className="settings-jwt">
                <span>{platform} JWT</span>
                <div className="settings-jwt-field">
                  <input
                    type={jwtFocus === platform ? 'text' : 'password'}
                    value={draft}
                    placeholder="Paste JWT"
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={() => setJwtFocus(platform)}
                    onBlur={() => setJwtFocus((current) => current === platform ? null : current)}
                    onChange={(event) => {
                      setJwtDraft((current) => ({ ...current, [platform]: event.target.value }))
                      if (jwtError[platform]) setJwtError((current) => ({ ...current, [platform]: '' }))
                    }}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveJwt(platform) } }}
                  />
                  {showSave ? (
                    <button type="button" disabled={Boolean(jwtBusy[platform])} onMouseDown={(event) => event.preventDefault()} onClick={() => void saveJwt(platform)}>
                      {jwtBusy[platform] ? '…' : 'Save'}
                    </button>
                  ) : null}
                </div>
                {jwtError[platform] ? <p className="settings-jwt-error">{jwtError[platform]}</p> : null}
              </div>
            )
          })}
          <label className="settings-toggle">
            <span>Use connected accounts as backup for StreamElements</span>
            <input type="checkbox" checked={activityFallback} onChange={onToggleFallback} />
          </label>
          <label className="settings-toggle">
            <span>Ignore missing StreamElements JWT alerts</span>
            <input type="checkbox" checked={ignoreMissingJwt} onChange={onToggleIgnoreMissing} />
          </label>
          <label className="settings-toggle">
            <span>Drop alerts older than 30 days</span>
            <input type="checkbox" checked={dropOldAlerts} onChange={onToggleDropOld} />
          </label>
        </>
      ) : null}
    </aside>
  )
}
