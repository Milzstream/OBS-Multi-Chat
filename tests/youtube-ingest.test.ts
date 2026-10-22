import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chatTextMatches,
  collapseYouTubeDuplicates,
  foldChatText,
  isOwnChatMessage,
  isStoredChatMessage,
  isTruncatedText,
  labelYouTubeTargets,
  applyOutgoingSendResult,
  mergeIncomingChat,
  youtubeInsertedMessageId,
  preferChatText,
  youtubeOfficialModeration,
  youtubeOfficialToActivity,
  youtubeSameAuthor,
  youtubeSameChatFor,
  youtubeTitleIsShorts,
} from '../server/logic.js'
import { chat, own } from './helpers.js'

describe('YouTube shorts labels', () => {
  it('tags Shorts only when a sibling title has #shortsfeed', () => {
    assert.equal(youtubeTitleIsShorts('Night stream #shortsfeed'), true)
    assert.equal(youtubeTitleIsShorts('just shorts in the title'), false)
    const labeled = labelYouTubeTargets([
      { videoId: 'liveVideoId1', liveChatId: 'A', title: 'Main stream' },
      { videoId: 'shortVideoId', liveChatId: 'B', title: 'Clip #shortsfeed' },
    ])
    assert.equal(labeled[0].label, 'Live')
    assert.equal(labeled[1].label, 'Shorts')
    const single = labelYouTubeTargets([{ videoId: 'only', liveChatId: 'A', title: 'Clip #shortsfeed' }])
    assert.equal(single[0].label, undefined)
  })
})

describe('YouTube chat matching', () => {
  const targets = [
    { videoId: 'videoLive01', liveChatId: 'CHAT_LIVE' },
    { videoId: 'videoShorts1', liveChatId: 'CHAT_SHORTS' },
  ]

  it('treats a video id and its liveChatId as the same chat', () => {
    assert.equal(youtubeSameChatFor('CHAT_LIVE', 'videoLive01', targets), true)
    assert.equal(youtubeSameChatFor('CHAT_LIVE', 'CHAT_SHORTS', targets), false)
    assert.equal(youtubeSameChatFor(undefined, 'CHAT_LIVE', targets), true)
  })

  it('matches authors by channel id when present', () => {
    assert.equal(youtubeSameAuthor(chat({ id: '1', user: 'A', text: 'x', userId: 'UC1' }), chat({ id: '2', user: 'B', text: 'x', userId: 'uc1' })), true)
    assert.equal(youtubeSameAuthor(chat({ id: '1', user: 'Same', text: 'x' }), chat({ id: '2', user: 'same', text: 'x' })), true)
    assert.equal(youtubeSameAuthor(chat({ id: '1', user: 'A', text: 'x', userId: 'UC1' }), chat({ id: '2', user: 'A', text: 'x', userId: 'UC2' })), false)
  })

  it('folds emoji so InnerTube and official copies merge', () => {
    assert.equal(foldChatText(chat({ id: '1', user: 'A', text: 'Hello 😀' })), 'hello')
    assert.equal(
      foldChatText(chat({ id: '1', user: 'A', text: 'hi', parts: [{ type: 'text', text: 'Hello' }, { type: 'emote', name: ':y:', url: 'x' }] })),
      'hello',
    )
  })

  it('collapses duplicate InnerTube and official rows within two seconds', () => {
    const official = chat({ id: 'yt-1', user: 'Ada', text: 'hi', userId: 'UC1', sourceId: 'CHAT_LIVE', ingest: 'official', time: '2026-09-02T12:00:00.000Z' })
    const inner = chat({ id: 'inner-1', user: 'Ada', text: 'hi 👋', userId: 'UC1', sourceId: 'videoLive01', ingest: 'innertube', time: '2026-09-02T12:00:01.000Z', avatar: 'https://yt.example/a.jpg' })
    const result = collapseYouTubeDuplicates([official, inner], targets)
    assert.equal(result.changed, true)
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].avatar, 'https://yt.example/a.jpg')
    assert.equal(result.messages[0].ingest, 'innertube')
  })

  it('does not collapse copies from different live chats', () => {
    const live = chat({ id: 'a', user: 'Ada', text: 'hi', sourceId: 'CHAT_LIVE', time: '2026-09-02T12:00:00.000Z' })
    const shorts = chat({ id: 'b', user: 'Ada', text: 'hi', sourceId: 'CHAT_SHORTS', time: '2026-09-02T12:00:00.500Z' })
    const result = collapseYouTubeDuplicates([live, shorts], targets)
    assert.equal(result.changed, false)
    assert.equal(result.messages.length, 2)
  })

  it('collapses host copies from Live and Shorts', () => {
    const host = [{ title: 'Owner', label: 'HOST' }]
    const live = chat({ id: 'a', user: 'milzstream', text: 'hello', sourceId: 'CHAT_LIVE', sourceLabel: 'Live', badges: host, time: '2026-09-02T12:00:00.000Z' })
    const shorts = chat({ id: 'b', user: 'milzstream', text: 'hello', sourceId: 'CHAT_SHORTS', sourceLabel: 'Shorts', badges: host, time: '2026-09-02T12:00:00.500Z' })
    const result = collapseYouTubeDuplicates([live, shorts], targets)
    assert.equal(result.changed, true)
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].sourceLabel, undefined)
  })

  it('matches truncated YouTube URL text with the full send', () => {
    const full = 'Wow Character: https://classic-armory.org/character/us/tbc-anniversary/dreamscythe/Tuskinrader'
    const clipped = 'Wow Character: https://classic-armory.org/character/...'
    assert.equal(isTruncatedText(clipped), true)
    assert.equal(chatTextMatches(full, clipped), true)
    assert.equal(preferChatText(full, clipped), full)
    assert.equal(isOwnChatMessage(chat({ id: '1', user: 'Host', text: 'x', userId: 'UC1' }), { ownHandles: own('other'), ownUserIds: ['UC1'] }), true)
  })
})

describe('YouTube message ingest', () => {
  it('merges a dock send with the YouTube echo', () => {
    const outgoing = chat({ id: 'local', platform: 'Twitch', platforms: ['Twitch', 'YouTube'], user: 'Host', text: 'hello', time: '2026-09-02T12:00:00.000Z' })
    const echo = chat({ id: 'yt-echo', user: 'Host', text: 'hello', sourceId: 'CHAT', time: '2026-09-02T12:00:01.000Z' })
    const result = mergeIncomingChat([outgoing], echo, { ingest: 'innertube' }, {
      ownHandles: own('Host'),
      recentOutgoing: [{ id: 'local', text: 'hello', platforms: ['Twitch', 'YouTube'], at: Date.parse('2026-09-02T12:00:00.000Z') }],
    })
    assert.equal(result.changed, true)
    assert.equal(result.messages.length, 1)
    assert.deepEqual(result.messages[0].platforms, ['Twitch', 'YouTube'])
    assert.equal(result.messages[0].sourceId, 'CHAT')
  })

  it('merges truncated Live and Shorts host echoes into the dock send', () => {
    const full = 'Wow Character: https://classic-armory.org/character/us/tbc-anniversary/dreamscythe/Tuskinrader'
    const clipped = 'Wow Character: https://classic-armory.org/character/...'
    const outgoing = chat({
      id: 'local',
      platform: 'Twitch',
      platforms: ['Twitch', 'Kick', 'YouTube'],
      user: 'milzstream',
      text: full,
      time: '2026-09-02T16:59:00.000Z',
    })
    const live = chat({
      id: 'yt-live',
      user: 'milzstream',
      text: clipped,
      sourceId: 'CHAT_LIVE',
      sourceLabel: 'Live',
      badges: [{ title: 'Owner', label: 'HOST' }],
      time: '2026-09-02T16:59:04.000Z',
    })
    const shorts = chat({
      id: 'yt-shorts',
      user: 'milzstream',
      text: clipped,
      sourceId: 'CHAT_SHORTS',
      sourceLabel: 'Shorts',
      badges: [{ title: 'Owner', label: 'HOST' }],
      time: '2026-09-02T16:59:05.000Z',
    })
    const youtubeTargets = [
      { videoId: 'videoLive01', liveChatId: 'CHAT_LIVE' },
      { videoId: 'videoShorts1', liveChatId: 'CHAT_SHORTS' },
    ]
    const ctx = {
      ownHandles: own('milzstream'),
      recentOutgoing: [{ id: 'local', text: full, platforms: ['Twitch', 'Kick', 'YouTube'] as const, at: Date.parse('2026-09-02T16:59:00.000Z') }],
      targets: youtubeTargets,
    }
    const afterLive = mergeIncomingChat([outgoing], live, { ingest: 'innertube' }, ctx)
    assert.equal(afterLive.changed, true)
    assert.equal(afterLive.messages.length, 1)
    assert.equal(afterLive.messages[0].text, full)
    assert.equal(afterLive.messages[0].sourceLabel, undefined)
    assert.equal(afterLive.messages[0].badges?.[0].label, 'HOST')
    const afterShorts = mergeIncomingChat(afterLive.messages, shorts, { ingest: 'innertube' }, ctx)
    assert.equal(afterShorts.messages.length, 1)
    assert.deepEqual(afterShorts.messages[0].platforms, ['Twitch', 'Kick', 'YouTube'])
    assert.equal(afterShorts.messages[0].text, full)
    assert.equal(afterShorts.messages[0].sourceLabel, undefined)
  })

  it('keeps a second identical own send instead of folding it into the first', () => {
    const first = chat({ id: 'local-1', platform: 'Twitch', platforms: ['Twitch'], user: 'Host', text: 'lol', time: '2026-09-02T12:00:00.000Z' })
    const second = chat({ id: 'local-2', platform: 'Twitch', platforms: ['Twitch'], user: 'Host', text: 'lol', time: '2026-09-02T12:00:05.000Z' })
    const recent = [
      { id: 'local-1', text: 'lol', platforms: ['Twitch'] as const, at: Date.parse(first.time) },
      { id: 'local-2', text: 'lol', platforms: ['Twitch'] as const, at: Date.parse(second.time) },
    ]
    const inserted = mergeIncomingChat([first], second, undefined, { ownHandles: own('Host'), recentOutgoing: recent })
    assert.equal(inserted.messages.length, 2)
    assert.deepEqual(inserted.messages.map((item) => item.id), ['local-1', 'local-2'])
    const echo = chat({ id: 'helix-2', platform: 'Twitch', user: 'Host', text: 'lol', time: '2026-09-02T12:00:06.000Z' })
    const echoed = mergeIncomingChat(inserted.messages, echo, undefined, { ownHandles: own('Host'), recentOutgoing: recent })
    assert.equal(echoed.messages.length, 2)
    assert.equal(echoed.messages[0].id, 'local-1')
    assert.equal(echoed.messages[1].id, 'helix-2')
  })

  it('merges a Kick echo into the unified send after Twitch already replaced the dock id', () => {
    const outgoing = chat({
      id: 'local',
      platform: 'Twitch',
      platforms: ['Twitch', 'Kick', 'YouTube'],
      user: 'Host',
      text: 'hello',
      time: '2026-09-02T12:00:00.000Z',
    })
    const recent = [{ id: 'local', text: 'hello', platforms: ['Twitch', 'Kick', 'YouTube'] as const, at: Date.parse(outgoing.time) }]
    const ctx = { ownHandles: own('Host'), recentOutgoing: recent }
    const afterTwitch = mergeIncomingChat([outgoing], chat({
      id: 'helix-1',
      platform: 'Twitch',
      user: 'Host',
      text: 'hello',
      time: '2026-09-02T12:00:01.000Z',
    }), undefined, ctx)
    assert.equal(afterTwitch.messages.length, 1)
    assert.equal(afterTwitch.messages[0].id, 'helix-1')
    const afterKick = mergeIncomingChat(afterTwitch.messages, chat({
      id: 'kick-1',
      platform: 'Kick',
      user: 'milzstream',
      text: 'hello',
      time: '2026-09-02T12:00:02.000Z',
    }), undefined, ctx)
    assert.equal(afterKick.messages.length, 1)
    assert.deepEqual(afterKick.messages[0].platforms, ['Twitch', 'Kick', 'YouTube'])
    assert.equal(afterKick.messages[0].copies?.find((copy) => copy.platform === 'Kick')?.id, 'kick-1')
  })

  it('merges a Twitch echo into the unified send after Kick already replaced the dock id', () => {
    const outgoing = chat({
      id: 'local',
      platform: 'Twitch',
      platforms: ['Twitch', 'Kick'],
      user: 'Host',
      text: 'hello',
      time: '2026-09-02T12:00:00.000Z',
    })
    const recent = [{ id: 'local', text: 'hello', platforms: ['Twitch', 'Kick'] as const, at: Date.parse(outgoing.time) }]
    const ctx = { ownHandles: own('Host'), recentOutgoing: recent }
    const afterKick = mergeIncomingChat([outgoing], chat({
      id: 'kick-1',
      platform: 'Kick',
      user: 'milzstream',
      text: 'hello',
      time: '2026-09-02T12:00:01.000Z',
    }), undefined, ctx)
    assert.equal(afterKick.messages.length, 1)
    assert.equal(afterKick.messages[0].id, 'kick-1')
    const afterTwitch = mergeIncomingChat(afterKick.messages, chat({
      id: 'helix-1',
      platform: 'Twitch',
      user: 'Host',
      text: 'hello',
      time: '2026-09-02T12:00:02.000Z',
    }), undefined, ctx)
    assert.equal(afterTwitch.messages.length, 1)
    assert.deepEqual(afterTwitch.messages[0].platforms, ['Twitch', 'Kick'])
    assert.equal(afterTwitch.messages[0].copies?.find((copy) => copy.platform === 'Twitch')?.id, 'helix-1')
  })

  it('does not delete an earlier own line when a later identical send fails', () => {
    const messages = [
      chat({ id: 'local-1', platform: 'Twitch', user: 'Host', text: 'lol', time: '2026-09-02T12:00:00.000Z' }),
      chat({ id: 'local-2', platform: 'Twitch', user: 'Host', text: 'lol', time: '2026-09-02T12:00:05.000Z' }),
    ]
    const failed = applyOutgoingSendResult(messages, 'local-2', [{ platform: 'Twitch', ok: false, error: 'timed out' }])
    assert.deepEqual(failed.messages.map((item) => item.id), ['local-1'])
    const missing = applyOutgoingSendResult(messages, 'already-echoed', [{ platform: 'Twitch', ok: false }])
    assert.equal(missing.changed, false)
    assert.equal(missing.messages.length, 2)
  })

  it('stores the platform message id on the row this send created', () => {
    const messages = [
      chat({ id: 'local-1', platform: 'Twitch', user: 'Host', text: 'lol', time: '2026-09-02T12:00:00.000Z' }),
      chat({ id: 'local-2', platform: 'Twitch', platforms: ['Twitch', 'YouTube'], user: 'Host', text: 'lol', time: '2026-09-02T12:00:05.000Z' }),
    ]
    const applied = applyOutgoingSendResult(messages, 'local-2', [
      { platform: 'Twitch', ok: true, id: 'helix-2' },
      { platform: 'YouTube', ok: true, sent: [{ id: 'yt-live', sourceId: 'CHAT_LIVE' }, { id: 'yt-shorts', sourceId: 'CHAT_SHORTS' }] },
    ])
    assert.equal(applied.messages[0].id, 'local-1')
    const sent = applied.messages[1]
    assert.deepEqual(sent.platforms, ['Twitch', 'YouTube'])
    assert.deepEqual(sent.copies?.map((copy) => copy.id), ['helix-2', 'yt-live', 'yt-shorts'])
    assert.equal(youtubeInsertedMessageId('{"id":"LCC.abc","snippet":{"liveChatId":"CHAT_LIVE"}}'), 'LCC.abc')
    assert.equal(youtubeInsertedMessageId('not-json'), undefined)
  })

  it('merges own Live and Shorts YouTube copies without a dock send', () => {
    const youtubeTargets = [
      { videoId: 'videoLive01', liveChatId: 'CHAT_LIVE' },
      { videoId: 'videoShorts1', liveChatId: 'CHAT_SHORTS' },
    ]
    const live = chat({
      id: 'yt-live',
      user: 'Host',
      text: 'hello',
      sourceId: 'CHAT_LIVE',
      sourceLabel: 'Live',
      badges: [{ title: 'Owner', label: 'HOST' }],
      time: '2026-09-02T12:00:00.000Z',
    })
    const shorts = chat({
      id: 'yt-shorts',
      user: 'Host',
      text: 'hello',
      sourceId: 'CHAT_SHORTS',
      sourceLabel: 'Shorts',
      badges: [{ title: 'Owner', label: 'HOST' }],
      time: '2026-09-02T12:00:01.000Z',
    })
    const result = mergeIncomingChat([live], shorts, { ingest: 'innertube' }, {
      ownHandles: own('Host'),
      recentOutgoing: [],
      targets: youtubeTargets,
    })
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].sourceLabel, undefined)
  })

  it('rejects stored chat rows that are missing required fields', () => {
    assert.equal(isStoredChatMessage({ id: '1', platform: 'YouTube', user: 'A', text: 'x', time: 't' }), true)
    assert.equal(isStoredChatMessage({ id: '1', platform: 'TikTok', user: 'A', text: 'x', time: 't' }), false)
    assert.equal(isStoredChatMessage({ platform: 'YouTube', user: 'A', text: 'x', time: 't' }), false)
  })
})

describe('YouTube official activity', () => {
  it('maps super chats, members, and gifts', () => {
    const superchat = youtubeOfficialToActivity({
      id: 'sc1',
      snippet: { type: 'superChatEvent', publishedAt: '2026-09-02T12:00:00.000Z', superChatDetails: { amountDisplayString: '$4.99', userComment: 'hi' } },
      authorDetails: { displayName: 'Ada', channelId: 'UC1' },
    })
    assert.equal(superchat?.kind, 'superchat')
    assert.equal(superchat?.amount, '$4.99')
    const member = youtubeOfficialToActivity({ id: 'n1', snippet: { type: 'newSponsorEvent', newSponsorDetails: { memberLevelName: 'Gold' } }, authorDetails: { displayName: 'Mel' } })
    assert.equal(member?.kind, 'membership')
    const gift = youtubeOfficialToActivity({ id: 'g1', snippet: { type: 'membershipGiftingEvent', membershipGiftingDetails: { giftMembershipsCount: 5 } }, authorDetails: { displayName: 'Pat' } })
    assert.equal(gift?.amount, '5 gifts')
  })

  it('maps official delete and ban events', () => {
    assert.deepEqual(youtubeOfficialModeration({ snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'm1' } } }), { action: 'delete', platform: 'YouTube', messageId: 'm1' })
    const banned = youtubeOfficialModeration({ snippet: { type: 'userBannedEvent', userBannedDetails: { bannedUserDetails: { channelId: 'UC1', displayName: '@Ada' } } } })
    assert.equal(banned?.action, 'ban')
    assert.equal(banned?.userId, 'UC1')
    assert.equal(banned?.user, 'Ada')
  })
})
