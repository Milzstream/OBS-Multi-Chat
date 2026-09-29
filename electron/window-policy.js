export function isAppWindowUrl(raw) {
  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false
    const pathname = url.pathname.replace(/\/$/, '') || '/'
    return pathname === '/console'
  } catch {
    return false
  }
}
