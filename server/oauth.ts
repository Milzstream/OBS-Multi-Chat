import crypto from 'node:crypto'
import { isPermanentTokenRefreshError, isTokenRefreshHealthMessage, oauthAuthorizeUrl, shareInFlight, tokenRefreshFailureMessage, tokenRefreshRetryMessage } from './logic.js'
import type { Account, Health, Platform, Token, TokenPlatform } from './types.js'
import type { createOAuthStateStore } from './oauth-state.js'

export type OAuthDeps = {
  tokens: Partial<Record<TokenPlatform, Token>>
  state: { accounts: Account[]; health: Record<Platform, Health> }
  oauthStates: ReturnType<typeof createOAuthStateStore>
  redirectUri: string
  twitchApi: (endpoint: string, token: Token, options?: RequestInit) => Promise<any>
  youtubeApi: (endpoint: string, token: Token, options?: RequestInit) => Promise<any>
  kickApi: (endpoint: string, token?: Token, options?: RequestInit, retried?: boolean) => Promise<Response>
  saveTokens: () => void
  restorePlatformConnection: (platform: Platform) => void
  setHealth: (platform: Platform, status: Health['status'], message?: string) => void
}

/** Authorize URL, code exchange, and access-token refresh for Twitch, Kick, and YouTube. */
export function createOAuth(d: OAuthDeps) {
  const {
    tokens,
    state,
    oauthStates,
    redirectUri,
    twitchApi,
    youtubeApi,
    kickApi,
    saveTokens,
    restorePlatformConnection,
    setHealth,
  } = d
  const refreshLocks = new Map<Platform, Promise<Token | undefined>>()

  function authorizationUrl(platform: Platform) {
    const clientId = process.env[`${platform.toUpperCase()}_CLIENT_ID`]
    if (!clientId) return null
    const stateValue = crypto.randomBytes(24).toString('hex')
    const codeVerifier = platform === 'Kick' ? crypto.randomBytes(32).toString('base64url') : undefined
    oauthStates.set(stateValue, { platform, createdAt: Date.now(), codeVerifier })
    const codeChallenge = platform === 'Kick' ? crypto.createHash('sha256').update(codeVerifier!).digest('base64url') : undefined
    return oauthAuthorizeUrl(platform, { clientId, redirectUri, state: stateValue, codeChallenge })
  }

  async function exchangeCode(platform: Platform, code: string, codeVerifier?: string): Promise<Token> {
    const json = await requestToken(platform, {
      client_id: process.env[`${platform.toUpperCase()}_CLIENT_ID`] || '',
      client_secret: process.env[`${platform.toUpperCase()}_CLIENT_SECRET`] || '',
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      ...(platform === 'Kick' ? { code_verifier: codeVerifier || '' } : {}),
    })
    const token: Token = { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined }
    if (platform === 'Twitch') {
      const user = await twitchApi('/helix/users', token)
      token.user = user.data?.[0]?.login || 'Twitch'
      token.userId = user.data?.[0]?.id
    } else if (platform === 'YouTube') {
      try { await hydrateYouTubeToken(token) } catch { token.user = token.user || 'YouTube' }
    } else await hydrateKickToken(token)
    return token
  }

  async function hydrateYouTubeToken(token: Token) {
    const channels = await youtubeApi('/channels?part=snippet&mine=true', token)
    const item = channels.items?.[0]
    const channel = item?.snippet
    const handle = String(channel?.customUrl || '').replace(/^@/, '')
    token.channelId = item?.id || token.channelId
    token.user = channel?.title || handle || token.user || 'YouTube'
  }

  async function hydrateKickToken(token: Token) {
    const [userResponse, channelResponse] = await Promise.all([kickApi('/users', token), kickApi('/channels', token)])
    const userPayload = userResponse.ok ? await userResponse.json() as any : undefined
    const channelPayload = channelResponse.ok ? await channelResponse.json() as any : undefined
    const user = userPayload?.data?.[0]
    const channel = channelPayload?.data?.[0]
    token.user = channel?.slug || user?.name || token.user || 'Kick'
    token.userId = channel?.broadcaster_user_id ? String(channel.broadcaster_user_id) : user?.user_id ? String(user.user_id) : token.userId
  }

  async function requestToken(platform: Platform, body: Record<string, string>) {
    const endpoint = platform === 'Twitch' ? 'https://id.twitch.tv/oauth2/token' : platform === 'Kick' ? 'https://id.kick.com/oauth/token' : 'https://oauth2.googleapis.com/token'
    const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
    if (!result.ok) throw new Error(`${platform} token request: ${result.status} ${await result.text()}`)
    return result.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>
  }

  async function ensureToken(platform: Platform): Promise<Token | undefined> {
    const token = tokens[platform]
    if (!token) return
    if (!token.expiresAt || token.expiresAt - 120_000 > Date.now()) return token
    if (!token.refreshToken) {
      markTokenRefreshFailure(platform)
      return
    }
    return refreshAccessToken(platform)
  }

  async function refreshAccessToken(platform: Platform): Promise<Token | undefined> {
    return shareInFlight(refreshLocks, platform, () => refreshAccessTokenNow(platform))
  }

  async function refreshAccessTokenNow(platform: Platform): Promise<Token | undefined> {
    const token = tokens[platform]
    if (!token?.refreshToken) {
      markTokenRefreshFailure(platform)
      return
    }
    try {
      const json = await requestToken(platform, {
        client_id: process.env[`${platform.toUpperCase()}_CLIENT_ID`] || '',
        client_secret: process.env[`${platform.toUpperCase()}_CLIENT_SECRET`] || '',
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      })
      tokens[platform] = {
        ...token,
        accessToken: json.access_token,
        refreshToken: json.refresh_token || token.refreshToken,
        expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : token.expiresAt,
      }
      saveTokens()
      console.log(`${platform} access token refreshed`)
      restorePlatformConnection(platform)
      return tokens[platform]
    } catch (error) {
      console.error(`${platform} token refresh:`, error instanceof Error ? error.message : error)
      if (isPermanentTokenRefreshError(error)) markTokenRefreshFailure(platform)
      else setHealth(platform, 'warn', tokenRefreshRetryMessage(platform))
      return
    }
  }

  function markTokenRefreshFailure(platform: Platform) {
    const account = state.accounts.find((item) => item.platform === platform)
    if (account) Object.assign(account, { connected: false, live: false, viewers: 0 })
    setHealth(platform, 'down', tokenRefreshFailureMessage(platform))
  }

  return {
    authorizationUrl,
    exchangeCode,
    hydrateYouTubeToken,
    hydrateKickToken,
    requestToken,
    ensureToken,
    refreshAccessToken,
    refreshAccessTokenNow,
    markTokenRefreshFailure,
  }
}

export type OAuth = ReturnType<typeof createOAuth>
