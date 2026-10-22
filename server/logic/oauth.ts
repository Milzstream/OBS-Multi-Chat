/**
 * OAuth authorize URLs and token-refresh health banners.
 */

import { KICK_OAUTH_SCOPES, TWITCH_OAUTH_SCOPES, YOUTUBE_OAUTH_SCOPES, type Health, type Platform } from '../types.js'

export function oauthAuthorizeUrl(platform: Platform, options: { clientId: string; redirectUri: string; state: string; codeChallenge?: string }) {
  const params = new URLSearchParams({ client_id: options.clientId, redirect_uri: options.redirectUri, response_type: 'code', state: options.state })
  if (platform === 'Twitch') {
    params.set('scope', TWITCH_OAUTH_SCOPES)
    params.set('force_verify', 'true')
  }
  if (platform === 'Kick') {
    params.set('scope', KICK_OAUTH_SCOPES)
    if (options.codeChallenge) {
      params.set('code_challenge', options.codeChallenge)
      params.set('code_challenge_method', 'S256')
    }
  }
  if (platform === 'YouTube') {
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
    params.set('scope', YOUTUBE_OAUTH_SCOPES)
  }
  return platform === 'Twitch' ? `https://id.twitch.tv/oauth2/authorize?${params}` : platform === 'Kick' ? `https://id.kick.com/oauth/authorize?${params}` : `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export function tokenRefreshFailureMessage(platform: Platform) {
  return `${platform} token refresh failed - reconnect in settings`
}

export function tokenRefreshRetryMessage(platform: Platform) {
  return `${platform} token refresh failed — retrying`
}

export function isTokenRefreshHealthMessage(message: string) {
  return /token refresh failed/i.test(message)
}

export function shouldKeepTokenRefreshBanner(health: Health, connected: boolean) {
  return isTokenRefreshHealthMessage(health.message) && !connected
}

/**
 * Kick's first realtime handshake does extra HTTP before the socket is up.
 * "Not connected yet" on launch is that handshake, not a drop — wait until a
 * connect attempt has actually failed (or the socket later drops).
 */

export function isPermanentTokenRefreshError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout|AbortError|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network|socket|429|502|503|504/i.test(text)) return false
  return /invalid_grant|invalid_token|unauthorized_client|invalid_client|invalid_request|\b400\b|\b401\b/i.test(text)
}

