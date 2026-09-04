import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chatTextMatches,
  collapseYouTubeDuplicates,
  foldChatText,
  isEndedYouTubeChat,
  isOwnChatMessage,
  isStoredChatMessage,
  isTruncatedText,
  labelYouTubeTargets,
  mergeIncomingChat,
  parseYouTubeQuotaInput,
  preferChatText,
  quotaWarnAt,
  resolveYouTubeLiveChatIds,
  syncYouTubeTokenChatIds,
  youtubeApiErrorReason,
  youtubeBadges,
  youtubeLiveChatMessageBody,
  youtubeOfficialToActivity,
  youtubeQuotaCost,
  youtubeQuotaHealthStatus,
  youtubeQuotaLabel,
  youtubeSameAuthor,
  youtubeSameChatFor,
  youtubeSendGuard,
  youtubeTitleIsShorts,
} from '../server/logic.js'
import {
  authorBadges,
  classifyChatItem,
  extractSession,
  extractVideoId,
  nextContinuation,
  parseActions,
  parseYouTubeTitle,
  parseYouTubeViewers,
  expandRunText,
  runLinkUrl,
  runsToParts,
} from '../server/youtube-chat.js'
import { chat, own } from './helpers.js'

describe('YouTube send', () => {
  it('resolves live chat ids from targets after the Shorts labeling change', () => {
    const token = { liveChatId: undefined as string | undefined, liveChatIds: [] as string[] }
    const targets = [
      { videoId: 'abcdefghijk', liveChatId: 'CHAT_LIVE' },
      { videoId: 'lmnopqrstuv', liveChatId: 'CHAT_SHORTS' },
    ]
    assert.deepEqual(resolveYouTubeLiveChatIds(targets, token), ['CHAT_LIVE', 'CHAT_SHORTS'])
    assert.deepEqual(resolveYouTubeLiveChatIds([], token), [])
    syncYouTubeTokenChatIds(targets, token)
    assert.equal(token.liveChatId, 'CHAT_LIVE')
    assert.deepEqual(token.liveChatIds, ['CHAT_LIVE', 'CHAT_SHORTS'])
    assert.deepEqual(resolveYouTubeLiveChatIds([], token), ['CHAT_LIVE', 'CHAT_SHORTS'])
  })

  it('prefers target chat ids over a stale token', () => {
    const token = { liveChatId: 'OLD', liveChatIds: ['OLD'] }
    const targets = [{ videoId: 'abcdefghijk', liveChatId: 'NEW' }]
    assert.deepEqual(resolveYouTubeLiveChatIds(targets, token), ['NEW'])
    syncYouTubeTokenChatIds(targets, token)
    assert.equal(token.liveChatId, 'NEW')
  })

  it('clears token chat ids when there are no live targets', () => {
    const token = { liveChatId: 'STALE', liveChatIds: ['STALE'] }
    syncYouTubeTokenChatIds([], token)
    assert.equal(token.liveChatId, undefined)
    assert.deepEqual(token.liveChatIds, [])
    assert.deepEqual(resolveYouTubeLiveChatIds([], token), [])
  })

  it('blocks sending when chat ids are missing or quota is exhausted', () => {
    assert.deepEqual(youtubeSendGuard({ connected: false, quotaBlocked: false, chatIds: ['x'] }), { ok: false, error: 'Not connected' })
    assert.deepEqual(youtubeSendGuard({ connected: true, quotaBlocked: true, chatIds: ['x'] }), { ok: false, error: 'YouTube API quota exceeded until midnight Pacific' })
    assert.deepEqual(youtubeSendGuard({ connected: true, quotaBlocked: false, chatIds: [] }), { ok: false, error: 'YouTube chat is not live' })
    assert.deepEqual(youtubeSendGuard({ connected: true, quotaBlocked: false, chatIds: ['CHAT'] }), { ok: true })
  })

  it('builds the official liveChatMessages.insert body', () => {
    assert.deepEqual(youtubeLiveChatMessageBody('CHAT', 'hello'), {
      snippet: { liveChatId: 'CHAT', type: 'textMessageEvent', textMessageDetails: { messageText: 'hello' } },
    })
  })
})

describe('YouTube quota', () => {
  it('charges the documented unit costs', () => {
    assert.equal(youtubeQuotaCost('/liveBroadcasts?part=snippet'), 1)
    assert.equal(youtubeQuotaCost('/liveChat/messages?part=snippet', 'GET'), 1)
    assert.equal(youtubeQuotaCost('/liveChat/messages?part=snippet', 'POST'), 50)
    assert.equal(youtubeQuotaCost('/liveChat/bans?part=snippet', 'POST'), 50)
    assert.equal(youtubeQuotaCost('/liveChat/bans?part=snippet', 'DELETE'), 50)
    assert.equal(youtubeQuotaCost('/channels?mine=true'), 1)
    assert.equal(youtubeQuotaCost('/videos?id=abc'), 1)
    assert.equal(youtubeQuotaCost('/unmapped-endpoint', 'GET'), 1)
  })

  it('labels insert vs list vs delete', () => {
    assert.equal(youtubeQuotaLabel('/liveChat/messages?part=snippet', 'POST'), 'liveChatMessages.insert')
    assert.equal(youtubeQuotaLabel('/liveChat/messages?liveChatId=x', 'GET'), 'liveChatMessages.list')
    assert.equal(youtubeQuotaLabel('/liveChat/messages?id=x', 'DELETE'), 'liveChatMessages.delete')
    assert.equal(youtubeQuotaLabel('/liveChat/bans?part=snippet', 'POST'), 'liveChatBans.insert')
    assert.equal(youtubeQuotaLabel('/videos?chart=mostPopular', 'GET'), 'videos.list')
    assert.equal(youtubeQuotaLabel('/liveBroadcasts?status=active', 'GET'), 'liveBroadcasts.list')
    assert.equal(youtubeQuotaLabel('/playlists', 'PATCH'), 'playlists PATCH')
  })

  it('parses console quota input', () => {
    assert.deepEqual(parseYouTubeQuotaInput('35'), { kind: 'used', used: 35 })
    assert.deepEqual(parseYouTubeQuotaInput('used 35/10000'), { kind: 'used', used: 35, limit: 10000 })
    assert.deepEqual(parseYouTubeQuotaInput('remaining 200'), { kind: 'remaining', remaining: 200 })
    assert.equal(parseYouTubeQuotaInput('quota?')?.kind, 'help')
    assert.equal(parseYouTubeQuotaInput('hello'), undefined)
  })

  it('warns at 80% and blocks at the cap', () => {
    assert.equal(quotaWarnAt(10_000), 8_000)
    assert.equal(youtubeQuotaHealthStatus(100, 10_000, false), undefined)
    assert.match(youtubeQuotaHealthStatus(8_000, 10_000, false)?.message || '', /80% used/)
    assert.match(youtubeQuotaHealthStatus(10_000, 10_000, false)?.message || '', /quota reached/)
    assert.match(youtubeQuotaHealthStatus(10, 10_000, true)?.message || '', /quota reached/)
  })

  it('reads API error reasons and ended-chat markers', () => {
    assert.equal(youtubeApiErrorReason(JSON.stringify({ error: { errors: [{ reason: 'liveChatEnded' }] } })), 'liveChatEnded')
    assert.equal(youtubeApiErrorReason('plain boom'), 'plain boom')
    assert.equal(isEndedYouTubeChat('live chat is no longer live'), true)
    assert.equal(isEndedYouTubeChat(new Error('liveChatNotFound')), true)
    assert.equal(isEndedYouTubeChat('quotaExceeded'), false)
  })
})

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

describe('YouTube InnerTube parsing', () => {
  it('extracts a live session and ignores replays', () => {
    const html = `"INNERTUBE_API_KEY":"AIzaKey","INNERTUBE_CLIENT_VERSION":"2.2024.01","VISITOR_DATA":"CgtVisitor","reloadContinuationData":{"continuation":"${'C'.repeat(60)}"} watch?v=abcdefghijk`
    const session = extractSession(html, 'fallback0001')
    assert.equal(session?.apiKey, 'AIzaKey')
    assert.equal(session?.videoId, 'abcdefghijk')
    assert.equal(extractSession('"isReplay":true ' + html, 'fallback0001'), undefined)
  })

  it('parses video id, viewers, and title from watch HTML', () => {
    const html = `<link rel="canonical" href="https://www.youtube.com/watch?v=abcdefghijk"><meta name="title" content="Night stream - YouTube">"concurrentViewers":"1,234"`
    assert.equal(extractVideoId(html), 'abcdefghijk')
    assert.equal(parseYouTubeViewers('1,234 watching now'), 1234)
    assert.equal(parseYouTubeTitle(html), 'Night stream')
    assert.equal(extractVideoId('"isReplay":true ' + html), undefined)
  })

  it('parses text, emotes, badges, superchats, and memberships', () => {
    const payload = {
      continuationContents: {
        liveChatContinuation: {
          actions: [
            { addChatItemAction: { item: { liveChatTextMessageRenderer: {
              id: 'm1',
              timestampUsec: '1690000000000000',
              authorExternalChannelId: 'UC1234567890123456789012',
              authorName: { simpleText: '@Ada' },
              message: { runs: [{ text: 'hi ' }, { emoji: { shortcuts: [':y:'], image: { thumbnails: [{ url: 'https://yt.example/e.png' }] } } }] },
              authorBadges: [{ liveChatAuthorBadgeRenderer: { icon: { iconType: 'OWNER' } } }],
            } } } },
            { addChatItemAction: { item: { liveChatPaidMessageRenderer: {
              id: 'm2',
              timestampUsec: '1690000001000000',
              authorName: { simpleText: 'Pat' },
              purchaseAmountText: { simpleText: '$5.00' },
              message: { runs: [{ text: 'nice' }] },
            } } } },
            { addChatItemAction: { item: { liveChatMembershipItemRenderer: {
              id: 'm3',
              timestampUsec: '1690000002000000',
              authorName: { simpleText: 'Mel' },
              headerSubtext: { runs: [{ text: 'Welcome!' }] },
            } } } },
          ],
          continuations: [{ timedContinuationData: { continuation: 'NEXT', timeoutMs: 4000 } }],
        },
      },
    }
    const messages = parseActions(payload, 'abcdefghijk')
    assert.equal(messages.length, 3)
    assert.equal(messages[0].user, 'Ada')
    assert.equal(messages[0].badges?.[0].label, 'HOST')
    assert.equal(messages[0].parts?.[1].type, 'emote')
    assert.equal(messages[1].activityKind, 'superchat')
    assert.equal(messages[1].amount, '$5.00')
    assert.equal(messages[2].activityKind, 'membership')
    assert.deepEqual(nextContinuation(payload), { continuation: 'NEXT', timeoutMs: 4000, ended: false })
    assert.equal(classifyChatItem({ liveChatPaidStickerRenderer: { purchaseAmountText: { simpleText: '$2' } } })?.activityKind, 'superchat')
    assert.deepEqual(runsToParts([{ text: 'x' }]), [{ type: 'text', text: 'x' }])
    const full = 'https://classic-armory.org/character/us/tbc-anniversary/dreamscythe/Tuskinrader'
    const truncatedLink = {
      text: 'https://classic-armory.org/character/...',
      navigationEndpoint: { urlEndpoint: { url: `https://www.youtube.com/redirect?event=live_chat&q=${encodeURIComponent(full)}` } },
    }
    assert.equal(runLinkUrl(truncatedLink), full)
    assert.equal(expandRunText(truncatedLink), full)
    assert.deepEqual(runsToParts([{ text: 'Wow Character: ' }, truncatedLink]), [{ type: 'text', text: 'Wow Character: ' }, { type: 'text', text: full }])
    assert.equal(expandRunText({ text: `Wow Character: https://classic-armory.org/character/...`, navigationEndpoint: truncatedLink.navigationEndpoint }), `Wow Character: ${full}`)
    assert.equal(expandRunText({ text: '@Ada', navigationEndpoint: { browseEndpoint: { browseId: 'UC1' } } }), '@Ada')
    const parsedLink = parseActions({
      continuationContents: {
        liveChatContinuation: {
          actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: {
            id: 'link1',
            timestampUsec: '1690000003000000',
            authorName: { simpleText: 'Ada' },
            message: { runs: [{ text: 'Wow Character: ' }, truncatedLink] },
          } } } }],
        },
      },
    }, 'abcdefghijk')
    assert.equal(parsedLink[0]?.text, `Wow Character: ${full}`)
    assert.deepEqual(authorBadges({ authorBadges: [{ liveChatAuthorBadgeRenderer: { icon: { iconType: 'MODERATOR' } } }] }), [{ title: 'Moderator', label: 'MOD' }])
    assert.deepEqual(youtubeBadges({ isChatOwner: true, isChatModerator: true }), [{ title: 'Owner', label: 'HOST' }, { title: 'Moderator', label: 'MOD' }])
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
})
