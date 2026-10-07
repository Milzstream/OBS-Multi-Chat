/**
 * Which dock the SPA mounts. `/watch` is the readonly LAN page and must win
 * over `?view=activity`, so a shared link cannot fall through to the chat dock.
 */
export type DockView = 'chat' | 'activity' | 'companion' | 'watch'

export function dockView(pathname: string, search = ''): DockView {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/console') return 'companion'
  if (path === '/watch') return 'watch'
  if (path === '/activity' || new URLSearchParams(search).get('view') === 'activity') return 'activity'
  return 'chat'
}
