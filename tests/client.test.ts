import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { applyExactCategory, assignTagPlatforms, categoryPickNote, chatProfileUrl, commitTypedCategory, dockAvatarSrc, exactCategoryMatch, kickProfileSlug, mergeCategoryResults, moderationAcceptsReason, moderationNeedsDockConfirm, moderationPlatformLabel, moderationStatus, moderationTargets, nextOptionIndex, platformStatTip, preferredCategory, selectedSendPlatforms, sharedStreamTags, streamDashboardUrl, streamTitleTip, tagAssignments, tagPlatforms, unifiedCategoryQuery, visibleChatMessages, youtubeBanConfirmLabel, youtubePrivacyMessage, youtubeStudioUrl } from '../src/chat-helpers.ts'
import { applySettingsPatch, mergeJwtDraft, mergePolledSettings, restoreSettingsKeys, settingsInFlightKeys, settingsSaveError } from '../src/ConsoleApp.tsx'
import { activityDockFields, applyActivitySlice, chatDockFields, chatSliceStamp, sameHealth, sameStringList, sseReconnectStillNeeded, sseSeqFromState, sseSeqIsGap, sseStateIsStale } from '../src/sse.ts'
import { YoutubePrivacyBanner } from '../src/YoutubePrivacyBanner.tsx'
import { ConnectionSettings } from '../src/ConnectionSettings.tsx'
import { ACTIVITY_FILTERS, ACTIVITY_KIND_FILTER_KEY, CHAT_FILTERS, parseStoredBoolean, parseStoredFilter, parseStoredStringSet } from '../src/dock-prefs.ts'
import { ACTIVITY_KIND_GROUP_IDS, visibleActivityEvents } from '../src/activity/format.ts'
import { nextPinState } from '../src/autoScroll.tsx'
import { indexFromRows, scrollTopForIndex, virtualWindow } from '../src/virtualList.ts'

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
    assert.equal(unifiedCategoryQuery('Valorant', 'Valorant', 'Just Chatting (IRL)', false), 'Valorant')
    assert.equal(unifiedCategoryQuery('Old', 'Minecraft', 'Minecraft', false), 'Minecraft')
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

  it('opens the channel-scoped Twitch viewer card and the YouTube channel page', () => {
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'Ada' }, 'Milz'), 'https://www.twitch.tv/popout/milz/viewercard/ada')
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'Ada Lovelace', handle: 'ada' }, 'Milz'), 'https://www.twitch.tv/popout/milz/viewercard/ada')
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'Ada' }), 'https://www.twitch.tv/ada')
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'not a login' }), undefined)
    assert.equal(chatProfileUrl({ platform: 'Twitch', user: 'TestUser' }), undefined)
    assert.equal(chatProfileUrl({ platform: 'Kick', user: 'SuperIOgame_Tyle88', handle: 'superiogame-tyle88' }), 'https://kick.com/superiogame-tyle88')
    assert.equal(chatProfileUrl({ platform: 'YouTube', user: 'Ada', userId: 'UC1234567890123456789012' }), 'https://www.youtube.com/channel/UC1234567890123456789012')
    assert.equal(chatProfileUrl({ platform: 'YouTube', user: '@Ada' }), 'https://www.youtube.com/@ada')
    assert.equal(moderationAcceptsReason('Twitch'), true)
    assert.equal(moderationAcceptsReason('Kick'), true)
    assert.equal(moderationAcceptsReason('YouTube'), false)
    assert.equal(moderationStatus('ban', 'Ada', 'spam'), 'Banned Ada: spam')
    assert.equal(moderationStatus('timeout', 'Ada'), 'Timed out Ada')
    assert.equal(moderationStatus('ban', 'Ada', '  '), 'Banned Ada')
    assert.equal(youtubePrivacyMessage({ title: 'Night stream', privacy: 'unlisted' }), 'YouTube “Night stream” is unlisted.')
  })

  it('lists every YouTube live title on the tile tooltip, and Twitch or Kick show theirs', () => {
    assert.equal(platformStatTip({ platform: 'Twitch', live: true, connected: true, viewers: 12, title: 'Night stream' }), 'Twitch · live\nNight stream\n12 viewers\nConnected\nOpen Twitch dashboard')
    assert.equal(platformStatTip({ platform: 'Kick', live: true, connected: true, viewers: 3, title: 'Just chatting' }), 'Kick · live\nJust chatting\n3 viewers\nConnected\nOpen Kick dashboard')
    assert.equal(platformStatTip({ platform: 'YouTube', live: true, connected: true, viewers: 9, streams: [{ title: 'Only one', viewers: 9 }] }), 'YouTube · live\nOnly one\n9 viewers\nConnected\nOpen YouTube dashboard')
    assert.equal(platformStatTip({ platform: 'YouTube', live: true, connected: true, viewers: 16, streams: [{ title: 'Horizontal', viewers: 12 }, { title: 'Late night', label: 'Shorts', viewers: 4 }] }), 'YouTube · live\nHorizontal · 12 viewers\nShorts: Late night · 4 viewers\n16 combined viewers\nConnected\nOpen YouTube dashboard')
  })

  it('keeps the full broadcast title on the privacy warning for hover, and clips the line', () => {
    const title = 'A scheduled title that is longer than the dock'
    const html = renderToStaticMarkup(createElement(YoutubePrivacyBanner, {
      notice: { videoId: 'abcdefghijk', title, privacy: 'unlisted' },
      className: 'health-banner warn youtube-privacy',
      onPublic: () => undefined,
      onDismiss: () => undefined,
    }))
    assert.match(html, /class="youtube-privacy-text"/)
    assert.match(html, /title="A scheduled title that is longer than the dock"/)
    assert.match(html, /YouTube “A scheduled title that is longer than the dock” is unlisted\./)
    const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    assert.match(css, /\.youtube-privacy-text \{[^}]*text-overflow: ellipsis/)
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
    assert.deepEqual(assignTagPlatforms('English', []), [])
    assert.deepEqual(assignTagPlatforms('first-play', ['Twitch']), [])
    assert.deepEqual(assignTagPlatforms('English', ['Kick']), ['Kick'])
    assert.deepEqual(moderationTargets({ platform: 'Twitch', id: 'm1', copies: [{ platform: 'Twitch', id: 'm1', userId: '1' }, { platform: 'Kick', id: 'm2', userId: '2' }] }).map((item) => item.platform), ['Twitch', 'Kick'])
    assert.equal(moderationPlatformLabel({ platform: 'Twitch', copies: [{ platform: 'Twitch' }, { platform: 'Kick' }] }), 'Twitch, Kick')
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
    assert.deepEqual(applyActivitySlice([{ id: 'a1' }, { id: 'a0' }], { activityEvent: { id: 'a2' }, activityTruncated: true }).map((item) => item.id), ['a2', 'a1'])
    assert.equal(sseReconnectStillNeeded(3, 3), true)
    assert.equal(sseReconnectStillNeeded(3, 4), false)
    assert.equal(sseSeqFromState(8, 4), 8)
    assert.equal(sseSeqFromState(8, 9), 9)
    assert.equal(sseStateIsStale(8, 4), true)
    assert.equal(sseStateIsStale(8, 8), false)
    assert.equal(sseStateIsStale(null, 4), false)
    assert.deepEqual(applyActivitySlice([{ id: 'a1' }], slice), [{ id: 'a1' }])
    const snapshot = activityDockFields({
      seq: 1,
      streamelements: { connected: true, handle: 'Ada', missing: [] },
    })
    assert.equal(snapshot.streamelements && (snapshot.streamelements as { connected: boolean }).connected, true)
  })
})

describe('auto live check toggle', () => {
  const connection = { platform: 'Twitch' as const, viewers: 1, handle: 'ada', connected: true, live: false }
  const render = (autoLiveCheck?: { Twitch: boolean }) => renderToStaticMarkup(createElement(ConnectionSettings, {
    connections: [connection],
    platformIcon: () => null,
    onConnect: () => undefined,
    onDisconnect: () => undefined,
    onCheckLive: () => undefined,
    autoLiveCheck,
    onToggleAutoLiveCheck: () => undefined,
  }))
  const checkbox = (html: string, label: string) => html.split('<input').find((part) => part.includes(`aria-label="${label}"`)) || ''

  it('checks Auto by default and leaves it unchecked when that platform is off', () => {
    const on = render()
    assert.match(checkbox(on, 'Auto-check Twitch live'), /checked/)
    assert.match(on, />Auto</)
    assert.match(on, /Check live/)
    const off = render({ Twitch: false })
    assert.doesNotMatch(checkbox(off, 'Auto-check Twitch live'), /checked/)
  })
})

describe('stream category commit', () => {
  it('commits typed text, keeps an exact id, and does not replace a name with a longer near-match', () => {
    assert.equal(exactCategoryMatch('minecraft', [{ id: '1', name: 'Minecraft' }, { id: '2', name: 'Minecraft Dungeons' }])?.id, '1')
    assert.equal(exactCategoryMatch('Mine', [{ id: '2', name: 'Minecraft' }]), undefined)
    const typed = commitTypedCategory({ category: 'Old', categoryId: '9' }, 'Minecraft')
    assert.equal(typed.category, 'Minecraft')
    assert.equal(typed.categoryId, undefined)
    const kept = commitTypedCategory({ category: 'Minecraft', categoryId: '1' }, 'minecraft')
    assert.equal(kept.categoryId, '1')
    const resolved = applyExactCategory({ category: 'Just Chatting', categoryId: undefined }, { id: '3', name: 'Just Chatting (IRL)' })
    assert.equal(resolved.category, 'Just Chatting')
    assert.equal(resolved.categoryId, undefined)
    const exact = applyExactCategory({ category: 'Minecraft' }, { id: '1', name: 'Minecraft' })
    assert.equal(exact.categoryId, '1')
    assert.match(categoryPickNote('Just Chatting', '1', undefined), /Kick was not changed/)
    assert.equal(categoryPickNote('IRL', '1', '2'), '')
    assert.match(streamTitleTip('Friday', 'IRL', ''), /Opens YouTube Studio/)
  })
})

describe('chat frame compare', () => {
  it('changes when the tail, a delete, or translated text changes, without matching a full stringify', () => {
    const previous = [{ id: '1', text: 'hi' }, { id: '2', text: 'yo' }]
    assert.equal(chatSliceStamp(previous), chatSliceStamp([{ id: '1', text: 'hi' }, { id: '2', text: 'yo' }]))
    assert.notEqual(chatSliceStamp(previous), chatSliceStamp([{ id: '1', text: 'hi' }, { id: '2', text: 'yo', deleted: true }]))
    assert.notEqual(chatSliceStamp(previous), chatSliceStamp([{ id: '1', text: 'hi' }, { id: '2', text: 'hello' }]))
    assert.equal(sameStringList(['a'], ['a']), true)
    assert.equal(sameHealth({ Twitch: { status: 'ok', message: '' } }, { Twitch: { status: 'warn', message: 'down' } }), false)
  })
})

describe('dock moderation confirm', () => {
  it('asks for a YouTube ban in the dock and leaves Twitch on the reason prompt', () => {
    assert.equal(moderationNeedsDockConfirm('ban', ['YouTube'], undefined), true)
    assert.equal(moderationNeedsDockConfirm('ban', ['YouTube'], ''), false)
    assert.equal(moderationNeedsDockConfirm('ban', ['Twitch'], undefined), false)
    assert.equal(moderationNeedsDockConfirm('timeout', ['YouTube'], undefined), false)
    assert.equal(youtubeBanConfirmLabel('Ada', 'YouTube'), 'Ban Ada on YouTube?')
    assert.equal(moderationAcceptsReason('YouTube'), false)
  })
})

describe('companion settings poll', () => {
  const current = {
    translateChat: true,
    translateError: '',
    activityFallback: true,
    ignoreMissingJwt: false,
    dropOldAlerts: false,
    autoLiveCheck: { Twitch: true, Kick: true, YouTube: true },
    streamelements: { connected: false, handle: '', connecting: true },
    youtubeQuota: { used: 1, limit: 10000 },
  }

  it('keeps an in-flight toggle and an edited JWT when a poll returns the old value', () => {
    const keys = settingsInFlightKeys({ translateChat: false, autoLiveCheck: { Kick: false } })
    assert.deepEqual(keys, ['translateChat', 'autoLiveCheck.Kick'])
    const optimistic = { ...current, translateChat: false, autoLiveCheck: { ...current.autoLiveCheck, Kick: false } }
    const polled = mergePolledSettings(optimistic, {
      translateChat: true,
      activityFallback: false,
      autoLiveCheck: { Twitch: true, Kick: true, YouTube: false },
    }, new Set(keys))
    assert.equal(polled.translateChat, false)
    assert.equal(polled.activityFallback, false)
    assert.equal(polled.autoLiveCheck.Kick, false)
    assert.equal(polled.autoLiveCheck.YouTube, false)
    const draft = mergeJwtDraft({ Twitch: 'pasted', Kick: '', YouTube: '' }, { Twitch: '', Kick: 'server', YouTube: 'yt' }, new Set(['Twitch']))
    assert.equal(draft.Twitch, 'pasted')
    assert.equal(draft.Kick, 'server')
    assert.equal(draft.YouTube, 'yt')
  })

  it('applies the server value after the post settles, and shows the error body on failure', () => {
    const optimistic = applySettingsPatch(current, { translateChat: false })
    assert.equal(optimistic.translateChat, false)
    const restored = restoreSettingsKeys(optimistic, current, ['translateChat'])
    assert.equal(restored.translateChat, true)
    assert.equal(settingsSaveError(false, 503, { error: 'watch bind failed' }), 'watch bind failed')
    assert.equal(settingsSaveError(false, 500, {}), 'Could not save settings (500)')
    assert.equal(settingsSaveError(true, 200, {}), '')
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
    const past = virtualWindow({ count: 100, scrollTop: 100_000, viewportHeight: 320, estimate: 56, pin: 'bottom', live: false })
    assert.equal(past.start, 99)
    assert.equal(past.end, 100)
    assert.equal(indexFromRows(80, [{ index: 4, top: 40, height: 70 }, { index: 5, top: 110, height: 40 }], 0), 4)
    assert.equal(scrollTopForIndex(4, 56), 224)
    assert.equal(nextPinState(false, true, true), true)
    assert.equal(nextPinState(false, false, true), false)
  })
})
