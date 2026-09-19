import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dockAvatarSrc, kickProfileSlug, mergeCategoryResults, nextOptionIndex, preferredCategory, selectedSendPlatforms, sharedStreamTags, visibleChatMessages, youtubeStudioUrl } from '../src/chat-helpers.ts'
import { activityDockFields, chatDockFields, sseSeqIsGap } from '../src/sse.ts'
import { ACTIVITY_FILTERS, CHAT_FILTERS, parseStoredBoolean, parseStoredFilter } from '../src/dock-prefs.ts'

describe('chat dock helpers', () => {
  it('proxies Kick CDN avatars through the local media route', () => {
    assert.equal(dockAvatarSrc('https://files.kick.com/images/user/1/a.webp'), '/api/media?u=https%3A%2F%2Ffiles.kick.com%2Fimages%2Fuser%2F1%2Fa.webp')
    assert.equal(dockAvatarSrc('https://static-cdn.jtvnw.net/jtv_user_pictures/x.png'), 'https://static-cdn.jtvnw.net/jtv_user_pictures/x.png')
    assert.equal(dockAvatarSrc(undefined), undefined)
  })

  it('uses a Kick slug when present and otherwise converts underscores', () => {
    assert.equal(kickProfileSlug('SuperIOgame_Tyle88', 'superiogame-tyle88'), 'superiogame-tyle88')
    assert.equal(kickProfileSlug('SuperIOgame_Tyle88'), 'superiogame-tyle88')
  })

  it('prefers the longer category name when both platforms have one', () => {
    assert.equal(preferredCategory('Just Chatting', 'Just Chatting (IRL)'), 'Just Chatting (IRL)')
    assert.equal(preferredCategory('', 'Kick Game'), 'Kick Game')
    assert.equal(preferredCategory('Twitch Game', ''), 'Twitch Game')
  })

  it('filters messages by platform including merged multi-platform rows', () => {
    const messages = [
      { id: '1', platform: 'Twitch' as const, text: 'a' },
      { id: '2', platform: 'YouTube' as const, platforms: ['Twitch', 'YouTube'] as const, text: 'b' },
      { id: '3', platform: 'Kick' as const, text: 'c' },
    ]
    assert.equal(visibleChatMessages(messages, 'All').length, 3)
    assert.deepEqual(visibleChatMessages(messages, 'YouTube').map((item) => item.id), ['2'])
    assert.deepEqual(visibleChatMessages(messages, 'Twitch').map((item) => item.id), ['1', '2'])
  })

  it('selects connected send destinations and honors opt-out', () => {
    assert.deepEqual(selectedSendPlatforms(['Twitch', 'YouTube']), ['Twitch', 'YouTube'])
    assert.deepEqual(selectedSendPlatforms(['Twitch', 'Kick', 'YouTube'], ['YouTube']), ['Twitch', 'Kick'])
    assert.deepEqual(selectedSendPlatforms([]), [])
  })

  it('clamps category-list highlight and does not wrap', () => {
    assert.equal(nextOptionIndex(0, 8, 1), 1)
    assert.equal(nextOptionIndex(7, 8, 1), 7)
    assert.equal(nextOptionIndex(0, 8, -1), 0)
    assert.equal(nextOptionIndex(3, 0, 1), 0)
  })

  it('builds YouTube Studio URLs without inventing a channel path', () => {
    assert.equal(youtubeStudioUrl(), 'https://studio.youtube.com')
    assert.equal(youtubeStudioUrl('UC1234567890123456789012'), 'https://studio.youtube.com/channel/UC1234567890123456789012/livestreaming')
    assert.equal(youtubeStudioUrl('not-a-channel'), 'https://studio.youtube.com')
  })

  it('merges Twitch and Kick category hits by name and keeps platform ids', () => {
    const merged = mergeCategoryResults(
      [{ id: 't1', name: 'Just Chatting' }, { id: 't2', name: 'Art' }],
      [{ id: 'k1', name: 'just chatting' }, { id: 'k2', name: 'Music' }],
    )
    assert.equal(merged[0].name, 'Just Chatting')
    assert.equal(merged[0].twitchId, 't1')
    assert.equal(merged[0].kickId, 'k1')
    const art = merged.find((item) => item.name === 'Art')
    assert.equal(art?.twitchId, 't2')
    assert.equal(art?.kickId, undefined)
    const music = merged.find((item) => item.name === 'Music')
    assert.equal(music?.kickId, 'k2')
    assert.equal(music?.twitchId, undefined)
  })

  it('unions tag lists without duplicates', () => {
    assert.deepEqual(sharedStreamTags(['English'], ['english', 'IRL'], ['IRL']), ['English', 'IRL'])
  })
})

describe('SSE seq gaps', () => {
  it('treats snapshots and pings as resync-safe, and flags skipped deltas', () => {
    assert.equal(sseSeqIsGap(3, 3, 'snapshot'), false)
    assert.equal(sseSeqIsGap(3, 3, 'ping'), false)
    assert.equal(sseSeqIsGap(null, 1, 'chat'), true)
    assert.equal(sseSeqIsGap(3, 4, 'chat'), false)
    assert.equal(sseSeqIsGap(3, 5, 'chat'), true)
  })

  it('does not treat a presence slice as a chat replacement', () => {
    const presence = chatDockFields({
      seq: 4,
      accounts: [{ platform: 'Twitch', viewers: 3 }],
      health: { Twitch: { status: 'ok', message: '' } },
    })
    assert.equal(presence.messages, undefined)
    assert.equal(presence.accounts?.length, 1)
    const snapshot = chatDockFields({
      seq: 4,
      messages: [{ id: '1', text: 'hi' }],
      accounts: [{ platform: 'Kick', viewers: 1 }],
    })
    assert.equal(snapshot.messages?.length, 1)
    assert.equal(snapshot.accounts?.length, 1)
  })

  it('does not treat an activity slice as StreamElements disconnecting', () => {
    const slice = activityDockFields({
      seq: 9,
      activity: [{ id: 'a1' }],
      activityWarnings: ['Reconnect Twitch'],
    })
    assert.equal(slice.activity?.length, 1)
    assert.deepEqual(slice.activityWarnings, ['Reconnect Twitch'])
    assert.equal(slice.streamelements, undefined)
    const snapshot = activityDockFields({
      seq: 1,
      streamelements: { connected: true, handle: 'Ada', missing: [] },
    })
    assert.equal(snapshot.streamelements && (snapshot.streamelements as { connected: boolean }).connected, true)
  })
})

describe('dock UI prefs', () => {
  it('restores compact mode and platform filters, and keeps current defaults on junk', () => {
    assert.equal(parseStoredBoolean(null, true), true)
    assert.equal(parseStoredBoolean('false', true), false)
    assert.equal(parseStoredBoolean('true', false), true)
    assert.equal(parseStoredBoolean('nope', true), true)
    assert.equal(parseStoredFilter(null, CHAT_FILTERS, 'All'), 'All')
    assert.equal(parseStoredFilter('Kick', CHAT_FILTERS, 'All'), 'Kick')
    assert.equal(parseStoredFilter('Nope', CHAT_FILTERS, 'All'), 'All')
    assert.equal(parseStoredFilter('StreamElements', ACTIVITY_FILTERS, 'All'), 'StreamElements')
    assert.equal(parseStoredFilter('Twitch', ACTIVITY_FILTERS, 'All'), 'Twitch')
  })
})
