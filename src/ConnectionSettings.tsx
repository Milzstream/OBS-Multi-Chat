import { useState, type ReactNode } from 'react'

type Platform = 'Twitch' | 'Kick' | 'YouTube'
type Connection = { platform: Platform; viewers: number; handle: string; connected: boolean; live: boolean }
const platformMeta: Record<Platform, { color: string }> = {
  Twitch: { color: '#a970ff' },
  Kick: { color: '#62c554' },
  YouTube: { color: '#ff5b62' },
}

/**
 * Dock connection popover: connect, disconnect, and live checks.
 * Translate, JWTs, and alert options live in the companion window.
 */

export function ConnectionSettings({
  connections,
  platformIcon,
  onClose,
  onConnect,
  onDisconnect,
  onCheckLive,
  note,
  embedded,
}: {
  connections: Connection[]
  platformIcon: (platform: Platform, size?: number) => ReactNode
  onClose?: () => void
  onConnect: (platform: Platform) => void
  onDisconnect: (platform: Platform) => void
  onCheckLive: (platform: Platform) => Promise<void> | void
  note?: string
  embedded?: boolean
}) {
  const [checking, setChecking] = useState<Partial<Record<Platform, boolean>>>({})
  const checkLive = async (platform: Platform) => {
    if (checking[platform]) return
    setChecking((current) => ({ ...current, [platform]: true }))
    try { await onCheckLive(platform) } finally { setChecking((current) => ({ ...current, [platform]: false })) }
  }
  return (
    <aside className={embedded ? 'console-connections' : 'settings-popover'}>
      <div className="popover-title"><span>{embedded ? 'ACCOUNTS' : 'CONNECTION SETTINGS'}</span>{onClose ? <button type="button" onClick={onClose} aria-label="Close settings">×</button> : null}</div>
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
            : <button type="button" className="connect" title={connection.platform === 'YouTube' ? 'Google lists video delete on this permission. Relay only sends and moderates live chat.' : undefined} onClick={() => onConnect(connection.platform)}>Connect</button>}
        </div>
      ))}
    </aside>
  )
}
