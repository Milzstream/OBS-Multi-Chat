import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyLiveStreamDetails,
  defaultAppSettings,
  isMoreSpecificCategory,
  kickStreamDetails,
  loadStreamInfo,
  loadYouTubeQuota,
  oauthAuthorizeUrl,
  parseAppSettings,
  YOUTUBE_OAUTH_SCOPES,
} from '../server/logic.js'

describe('stream details', () => {
  it('keeps a more specific category when the live feed is generic', () => {
    assert.equal(isMoreSpecificCategory('Science & Technology', 'Science'), true)
    assert.equal(isMoreSpecificCategory('Just Chatting (IRL)', 'Just Chatting'), true)
    assert.equal(isMoreSpecificCategory('Games', 'Just Chatting'), false)
    const kept = applyLiveStreamDetails(
      { title: 'Old', category: 'Just Chatting (IRL)', categoryId: 'keep' },
      { title: 'Live title', category: 'Just Chatting' },
    )
    assert.equal(kept.category, 'Just Chatting (IRL)')
    assert.equal(kept.title, 'Live title')
    assert.equal(kept.categoryId, 'keep')
  })

  it('takes the live category when it is at least as specific', () => {
    const next = applyLiveStreamDetails(
      { title: 'Old', category: 'Games' },
      { title: 'Now', category: 'Science & Technology', categoryId: 'sci' },
    )
    assert.equal(next.category, 'Science & Technology')
    assert.equal(next.categoryId, 'sci')
  })

  it('picks the most specific Kick category candidate', () => {
    const details = kickStreamDetails({
      stream_title: 'Friday',
      category: { name: 'Just Chatting', id: '1' },
      livestream: { categories: [{ name: 'Just Chatting (IRL)', id: '3' }] },
    })
    assert.equal(details.title, 'Friday')
    assert.equal(details.category, 'Just Chatting (IRL)')
    assert.equal(details.categoryId, '3')
  })
})

describe('settings', () => {
  it('defaults and normalizes persisted settings', () => {
    const defaults = defaultAppSettings()
    assert.equal(defaults.activityFallback, true)
    assert.equal(defaults.youtubeQuota.used, 0)
    const parsed = parseAppSettings({
      activityFallback: false,
      ignoreMissingJwt: true,
      dropOldAlerts: true,
      streamInfo: { Twitch: { title: ' A ', category: 'IRL', categoryId: '9' }, Kick: null },
      youtubeQuota: { day: '2026-09-02', used: '12', limit: '10000' },
    })
    assert.equal(parsed.activityFallback, false)
    assert.equal(parsed.streamInfo.Twitch.title, 'A')
    assert.equal(parsed.streamInfo.Kick.category, '')
    assert.deepEqual(loadYouTubeQuota({ day: '2026-09-02', used: 12, limit: 10000 }), { day: '2026-09-02', used: 12, limit: 10000 })
    assert.equal(loadStreamInfo(undefined).Twitch.title, '')
  })
})

describe('OAuth URLs', () => {
  it('requests YouTube force-ssl so chat sending is in scope', () => {
    const url = oauthAuthorizeUrl('YouTube', {
      clientId: 'id',
      redirectUri: 'http://localhost:4173/oauth/callback',
      state: 'abc',
    })
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://accounts.google.com')
    assert.equal(parsed.searchParams.get('access_type'), 'offline')
    assert.equal(parsed.searchParams.get('scope'), YOUTUBE_OAUTH_SCOPES)
    assert.match(parsed.searchParams.get('scope') || '', /youtube\.force-ssl/)
  })

  it('builds Twitch and Kick authorize URLs', () => {
    const twitch = new URL(oauthAuthorizeUrl('Twitch', { clientId: 't', redirectUri: 'http://localhost:4173/oauth/callback', state: 's' }))
    assert.equal(twitch.searchParams.get('force_verify'), 'true')
    assert.match(twitch.searchParams.get('scope') || '', /user:write:chat/)
    const kick = new URL(oauthAuthorizeUrl('Kick', { clientId: 'k', redirectUri: 'http://localhost:4173/oauth/callback', state: 's', codeChallenge: 'chal' }))
    assert.equal(kick.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(kick.searchParams.get('code_challenge'), 'chal')
  })
})
