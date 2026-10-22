import { platformStatTip } from '../chat-helpers'
import { platformIcon, platformMeta } from './platform'
import type { Connection, Health, YoutubeQuotaStatus } from './types'

export function PlatformStat({ connection, title, health, quota, onOpenDashboard }: { connection: Connection; title?: string; health?: Health; quota?: YoutubeQuotaStatus; onOpenDashboard: () => void }) {
  const meta = platformMeta[connection.platform]
  const handle = connection.connected && connection.handle && !['YouTube account', 'Kick account', 'YouTube', 'Kick', 'Twitch'].includes(connection.handle) ? connection.handle : connection.platform
  const status = !connection.connected ? '' : health?.status === 'down' ? 'down' : health?.status === 'warn' ? 'warn' : connection.live ? 'ok' : ''
  const tip = platformStatTip({ platform: connection.platform, live: connection.live, connected: connection.connected, viewers: connection.viewers, title, streams: connection.streams, quota, health: health?.message || (status === 'ok' ? 'Connected' : '') })
  return <button type="button" className={`platform-stat${connection.connected ? ' connected' : ''}${connection.live ? ' live' : ''}${status === 'down' ? ' down' : ''}`} style={{ color: meta.color, borderColor: status === 'down' ? '#ff5b62' : connection.live ? meta.color : `${meta.color}66`, background: `${meta.color}18` }} title={tip} onClick={() => { if (connection.connected) onOpenDashboard() }} aria-label={tip.replace(/\n/g, ' ')}><span className="platform-stat-top">{platformIcon(connection.platform, 13)}<span className="platform-stat-name">{handle}</span>{status ? <span className={`status-dot ${status}`} /> : null}</span><strong>{connection.connected ? connection.viewers.toLocaleString() : '—'}</strong></button>
}
