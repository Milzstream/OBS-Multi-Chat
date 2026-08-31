import { useState, type ReactNode } from 'react'
import { Bell } from 'lucide-react'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean }
type StreamElementsStatus = { connected: boolean; handle: string; missing?: string[] }

const platformMeta: Record<Platform, { color: string }> = {
  Twitch: { color: '#a970ff' },
  Kick: { color: '#62c554' },
  YouTube: { color: '#ff5b62' },
}

export function ConnectionSettings({
  connections,
  streamelements,
  activityFallback,
  ignoreMissingJwt,
  dropOldAlerts,
  showActivityOptions,
  platformIcon,
  onClose,
  onConnect,
  onDisconnect,
  onCheckLive,
  onToggleFallback,
  onToggleIgnoreMissing,
  onToggleDropOld,
  note,
}: {
  connections: Connection[]
  streamelements: StreamElementsStatus
  activityFallback: boolean
  ignoreMissingJwt: boolean
  dropOldAlerts: boolean
  showActivityOptions: boolean
  platformIcon: (platform: Platform, size?: number) => ReactNode
  onClose: () => void
  onConnect: (platform: Platform) => void
  onDisconnect: (platform: Platform) => void
  onCheckLive: (platform: Platform) => Promise<void> | void
  onToggleFallback: () => void
  onToggleIgnoreMissing: () => void
  onToggleDropOld: () => void
  note?: string
}) {
  const missing = streamelements.missing || []
  const [checking, setChecking] = useState<Partial<Record<Platform, boolean>>>({})
  const checkLive = async (platform: Platform) => {
    if (checking[platform]) return
    setChecking((current) => ({ ...current, [platform]: true }))
    try { await onCheckLive(platform) } finally { setChecking((current) => ({ ...current, [platform]: false })) }
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
      {showActivityOptions ? (
        <>
          <div className="settings-divider" />
          <span className="settings-section-title">ACTIVITY ALERTS</span>
          <p className="settings-note">Add StreamElements JWTs in the environment file, then restart.</p>
          <div className="connection-row">
            <span style={{ color: '#f3af61' }}><Bell size={14} /></span>
            <div>
              <strong>StreamElements</strong>
              <small>{streamelements.connected ? streamelements.handle : 'Not configured'}{missing.length ? ` · missing ${missing.join(', ')}` : ''}</small>
            </div>
          </div>
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
