function loopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function allowlistedHttps(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return false
  if (/[\u0000-\u0020\u007f<>"'\\|`]/.test(raw)) return false
  let parsed
  try { parsed = new URL(raw) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return false
  const host = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname
  if (host === 'www.twitch.tv' || host === 'twitch.tv') return /^\/[A-Za-z0-9_]{1,25}\/?$/.test(pathname) || /^\/popout\/[A-Za-z0-9_]{1,25}\/viewercard\/[A-Za-z0-9_]{1,25}\/?$/.test(pathname)
  if (host === 'dashboard.twitch.tv') return pathname === '/stream-manager' || pathname === '/stream-manager/' || pathname === '/stream' || pathname === '/stream/' || /^\/u\/[A-Za-z0-9_]{1,25}\/(stream-manager|stream)\/?$/.test(pathname)
  if (host === 'kick.com' || host === 'www.kick.com') return /^\/[A-Za-z0-9_-]{1,50}\/?$/.test(pathname) || /^\/dashboard(\/stream)?\/?$/.test(pathname)
  if (host === 'www.youtube.com' || host === 'youtube.com') return /^\/channel\/UC[\w-]{20,}\/?$/.test(pathname) || /^\/@[A-Za-z0-9._-]{1,60}\/?$/.test(pathname)
  if (host === 'studio.youtube.com') return pathname === '/' || pathname === '/livestreaming' || pathname === '/livestreaming/' || /^\/channel\/UC[\w-]{20,}(\/livestreaming)?\/?$/.test(pathname)
  return false
}

export function isAppWindowUrl(raw, port) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' || !loopbackHost(url.hostname)) return false
    if (port != null && String(url.port) !== String(port)) return false
    const pathname = url.pathname.replace(/\/$/, '') || '/'
    return pathname === '/console'
  } catch {
    return false
  }
}

export function isAppOauthUrl(raw, port) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' || !loopbackHost(url.hostname)) return false
    if (port != null && String(url.port) !== String(port)) return false
    return url.pathname === '/oauth' || url.pathname.startsWith('/oauth/')
  } catch {
    return false
  }
}

export function externalOpenAllowed(raw, port) {
  if (isAppOauthUrl(raw, port)) return true
  return allowlistedHttps(raw)
}
