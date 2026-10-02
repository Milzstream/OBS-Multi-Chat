import React, { useState, type ReactNode } from 'react'

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
 *
 * Auto (default on) is the repeating live-status poll. Unchecking it does not
 * stop chat that is already connected. Check live still runs immediately.
 */

export function ConnectionSettings({
  connections,
  platformIcon,
  onClose,
  onConnect,
  onDisconnect,
  onCheckLive,
  autoLiveCheck,
  onToggleAutoLiveCheck,
  note,
  embedded,
}: {
  connections: Connection[]
  platformIcon: (platform: Platform, size?: number) => ReactNode
  onClose?: () => void
  onConnect: (platform: Platform) => void
  onDisconnect: (platform: Platform) => void
  onCheckLive: (platform: Platform) => Promise<void> | void
  autoLiveCheck?: Partial<Record<Platform, boolean>>
  onToggleAutoLiveCheck?: (platform: Platform, enabled: boolean) => void
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
                <label className="live-auto" title="Automatically check if this platform is live. Uncheck to pause status polls until you press Check live. Chat that is already connected keeps updating.">
                  <input
                    type="checkbox"
                    aria-label={`Auto-check ${connection.platform} live`}
                    checked={autoLiveCheck?.[connection.platform] !== false}
                    onChange={(event) => onToggleAutoLiveCheck?.(connection.platform, event.target.checked)}
                  />
                  <span>Auto</span>
                </label>
                <button type="button" className="live-check" disabled={checking[connection.platform]} title="Run a live check now. This still runs if Auto is off, and does not change the automatic interval." onClick={() => void checkLive(connection.platform)}>
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
