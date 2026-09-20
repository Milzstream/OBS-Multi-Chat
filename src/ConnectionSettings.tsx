import { useRef, useState, type ReactNode } from 'react'
import { Bell } from 'lucide-react'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean }
type StreamElementsStatus = { connected: boolean; handle: string; missing?: string[] }
type JwtPreview = { configured: boolean; last4: string }

const platformMeta: Record<Platform, { color: string }> = {
  Twitch: { color: '#a970ff' },
  Kick: { color: '#62c554' },
  YouTube: { color: '#ff5b62' },
}

const JWT_PLATFORMS: Platform[] = ['Twitch', 'Kick', 'YouTube']

/**
 * The connection settings popover: per-platform connect/disconnect and live
 * checks, Chat / Activity / Companion sections. JWT edits stay local and never
 * echo the full token. Companion (OBS websocket / end YouTube) is chat-dock only.
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
  showCompanionOptions,
  jwtSlots,
  endYouTubeOnObsStop,
  obsConnected,
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
  onCompanionSettings,
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
  showCompanionOptions?: boolean
  jwtSlots?: Record<string, JwtPreview>
  endYouTubeOnObsStop?: boolean
  obsConnected?: boolean
  platformIcon: (platform: Platform, size?: number) => ReactNode
  onClose: () => void
  onConnect: (platform: Platform) => void
  onDisconnect: (platform: Platform) => void
  onCheckLive: (platform: Platform) => Promise<void> | void
  onToggleFallback: () => void
  onToggleIgnoreMissing: () => void
  onToggleDropOld: () => void
  onToggleTranslateChat: () => void
  onJwtChange?: (platform: Platform, jwt: string) => void
  onCompanionSettings?: (body: { endYouTubeOnObsStop?: boolean }) => void
  note?: string
}) {
  const missing = streamelements.missing || []
  const [checking, setChecking] = useState<Partial<Record<Platform, boolean>>>({})
  const [jwtDraft, setJwtDraft] = useState<Record<string, string>>({ Twitch: '', Kick: '', YouTube: '' })
  const jwtTimers = useRef<Partial<Record<Platform, number>>>({})
  const jwtDirty = useRef<Partial<Record<Platform, boolean>>>({})
  const checkLive = async (platform: Platform) => {
    if (checking[platform]) return
    setChecking((current) => ({ ...current, [platform]: true }))
    try { await onCheckLive(platform) } finally { setChecking((current) => ({ ...current, [platform]: false })) }
  }
  const commitJwt = (platform: Platform, value: string) => {
    if (!jwtDirty.current[platform]) return
    jwtDirty.current[platform] = false
    onJwtChange?.(platform, value.trim())
    setJwtDraft((current) => ({ ...current, [platform]: '' }))
  }
  const queueJwt = (platform: Platform, value: string) => {
    jwtDirty.current[platform] = true
    setJwtDraft((current) => ({ ...current, [platform]: value }))
    if (jwtTimers.current[platform]) window.clearTimeout(jwtTimers.current[platform])
    jwtTimers.current[platform] = window.setTimeout(() => commitJwt(platform, value), 700)
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
            const slot = jwtSlots?.[platform]
            const placeholder = slot?.configured ? `Configured · ${slot.last4}` : 'Paste JWT'
            return (
              <label key={platform} className="settings-jwt">
                <span>{platform} JWT</span>
                <input
                  value={jwtDraft[platform] || ''}
                  placeholder={placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => queueJwt(platform, event.target.value)}
                  onBlur={(event) => {
                    if (jwtTimers.current[platform]) window.clearTimeout(jwtTimers.current[platform])
                    commitJwt(platform, event.target.value)
                  }}
                />
              </label>
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
      {showCompanionOptions ? (
        <>
          <div className="settings-divider" />
          <span className="settings-section-title">COMPANION</span>
          <label className="settings-toggle">
            <span>End YouTube live when OBS stops streaming</span>
            <input type="checkbox" checked={Boolean(endYouTubeOnObsStop)} onChange={() => onCompanionSettings?.({ endYouTubeOnObsStop: !endYouTubeOnObsStop })} />
          </label>
          <p className="settings-note">OBS WebSocket {obsConnected ? 'connected' : 'disconnected'} (local 127.0.0.1:4455, or RELAY_OBS_HOST / RELAY_OBS_PORT / RELAY_OBS_PASSWORD). Fires only when OBS Stop Streaming, not on internet drop. Ends every YouTube live this companion is tracking, including Live + Shorts.</p>
        </>
      ) : null}
    </aside>
  )
}
