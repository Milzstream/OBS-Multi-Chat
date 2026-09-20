import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dockAvatarSrc, kickProfileSlug, mergeCategoryResults, nextOptionIndex, preferredCategory, selectedSendPlatforms, sharedStreamTags, streamDashboardUrl, tagAssignments, tagPlatforms, visibleChatMessages, youtubeStudioUrl } from '../src/chat-helpers.ts'
import { activityDockFields, applyActivitySlice, chatDockFields, sseSeqIsGap } from '../src/sse.ts'
import { ACTIVITY_FILTERS, ACTIVITY_KIND_FILTER_KEY, CHAT_FILTERS, parseStoredBoolean, parseStoredFilter, parseStoredStringSet } from '../src/dock-prefs.ts'
import { ACTIVITY_KIND_GROUP_IDS, visibleActivityEvents } from '../src/activity/format.ts'
import { virtualWindow } from '../src/virtualList.ts'

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
    assert.equal(youtubeStudioUrl(), 'https://studio.youtube.com/livestreaming')
    assert.equal(youtubeStudioUrl('UC1234567890123456789012'), 'https://studio.youtube.com/channel/UC1234567890123456789012/livestreaming')
    assert.equal(youtubeStudioUrl('not-a-channel'), 'https://studio.youtube.com/livestreaming')
    assert.equal(streamDashboardUrl('Twitch', { handle: 'Ada' }), 'https://dashboard.twitch.tv/u/ada/stream-manager')
    assert.equal(streamDashboardUrl('Kick', { handle: 'ada' }), 'https://kick.com/dashboard/stream')
    assert.equal(streamDashboardUrl('YouTube', { channelId: 'UC1234567890123456789012' }), 'https://studio.youtube.com/channel/UC1234567890123456789012/livestreaming')
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

  it('marks which platforms can take a tag', () => {
    assert.deepEqual(tagPlatforms('English'), ['Twitch', 'Kick'])
    assert.deepEqual(tagPlatforms('first-play'), ['Kick'])
    assert.deepEqual(tagPlatforms('こんにちは'), [])
  })

  it('builds per-tag platform assignments from the three lists', () => {
    const assigned = tagAssignments(['English'], ['English', 'first-play'])
    const english = assigned.find((item) => item.tag === 'English')
    assert.deepEqual(english?.platforms, ['Twitch', 'Kick'])
    assert.deepEqual(assigned.find((item) => item.tag === 'first-play')?.platforms, ['Kick'])
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
    assert.equal(slice.activityEvent, undefined)
    const delta = activityDockFields({ seq: 10, activityEvent: { id: 'a2', kind: 'follow' } })
    assert.equal(slice.activity?.length, 1)
    assert.equal((delta.activityEvent as { id: string }).id, 'a2')
    assert.equal(delta.activity, undefined)
    assert.deepEqual(applyActivitySlice([{ id: 'a1' }], delta).map((item) => item.id), ['a2', 'a1'])
    assert.deepEqual(applyActivitySlice([{ id: 'a1' }], slice), [{ id: 'a1' }])
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
    assert.deepEqual(parseStoredStringSet(null, ACTIVITY_KIND_GROUP_IDS), [...ACTIVITY_KIND_GROUP_IDS])
    assert.deepEqual(parseStoredStringSet('[]', ACTIVITY_KIND_GROUP_IDS), [])
    assert.deepEqual(parseStoredStringSet('["follow"]', ACTIVITY_KIND_GROUP_IDS), ['follow'])
    assert.deepEqual(parseStoredStringSet('["nope"]', ACTIVITY_KIND_GROUP_IDS), [...ACTIVITY_KIND_GROUP_IDS])
    assert.deepEqual(parseStoredStringSet('not-json', ACTIVITY_KIND_GROUP_IDS), [...ACTIVITY_KIND_GROUP_IDS])
    assert.equal(ACTIVITY_KIND_FILTER_KEY, 'relay.activity.kindFilter')
  })
})

describe('activity kind filters', () => {
  it('combines platform and kind-group filters, newest first', () => {
    const events = [
      { id: '1', platform: 'Twitch', kind: 'follow', time: '2026-09-02T12:00:00.000Z' },
      { id: '2', platform: 'Twitch', kind: 'subscription', time: '2026-09-02T12:01:00.000Z' },
      { id: '3', platform: 'Kick', kind: 'gift', time: '2026-09-02T12:02:00.000Z' },
      { id: '4', platform: 'StreamElements', kind: 'donation', time: '2026-09-02T12:03:00.000Z' },
    ]
    assert.deepEqual(visibleActivityEvents(events, 'All', ACTIVITY_KIND_GROUP_IDS).map((item) => item.id), ['4', '3', '2', '1'])
    assert.deepEqual(visibleActivityEvents(events, 'Twitch', ['follow']).map((item) => item.id), ['1'])
    assert.deepEqual(visibleActivityEvents(events, 'All', ['sub']).map((item) => item.id), ['3', '2'])
    assert.equal(visibleActivityEvents(events, 'All', []).length, 0)
  })
})

describe('virtual list window', () => {
  it('windows from the live edge when pinned, and from scrollTop when paused', () => {
    const liveBottom = virtualWindow({ count: 100, scrollTop: 0, viewportHeight: 320, estimate: 56, pin: 'bottom', live: true })
    assert.equal(liveBottom.end, 100)
    assert.ok(liveBottom.start < 100)
    assert.equal(liveBottom.padBottom, 0)
    const liveTop = virtualWindow({ count: 100, scrollTop: 0, viewportHeight: 320, estimate: 52, pin: 'top', live: true })
    assert.equal(liveTop.start, 0)
    assert.equal(liveTop.padTop, 0)
    assert.ok(liveTop.end < 100)
    const paused = virtualWindow({ count: 100, scrollTop: 1120, viewportHeight: 320, estimate: 56, pin: 'bottom', live: false })
    assert.ok(paused.start > 0)
    assert.ok(paused.end < 100)
    assert.ok(paused.padTop > 0)
    assert.ok(paused.padBottom > 0)
  })
})
