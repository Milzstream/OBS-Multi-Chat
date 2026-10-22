import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { youtubeBadges } from '../server/logic.js'
import {
  authorBadges,
  classifyChatItem,
  extractSession,
  extractVideoId,
  innerTubeRetryDelay,
  isRequestTimeout,
  noteYoutubeBrowserMiss,
  youtubeBrowserAllowed,
  YOUTUBE_BROWSER_MISS_TTL_MS,
  nextContinuation,
  parseActions,
  parseModerationActions,
  parseYouTubeTitle,
  parseYouTubeViewers,
  youtubeViewersWhileLive,
  expandRunText,
  runLinkUrl,
  runsToParts,
} from '../server/youtube-chat.js'

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
    assert.equal(parseYouTubeViewers('"concurrentViewers":"42"'), 42)
    assert.equal(parseYouTubeViewers('"videoDetails":{"viewCount":"9000"}'), undefined)
    assert.equal(youtubeViewersWhileLive(false, 0, 9000), undefined)
    assert.deepEqual(youtubeViewersWhileLive(true, 3, 12), { viewers: 12 })
    assert.equal(youtubeViewersWhileLive(true, 12, 12), undefined)
    assert.equal(parseYouTubeTitle(html), 'Night stream')
    assert.equal(extractVideoId('"isReplay":true ' + html), undefined)
    assert.equal(extractVideoId('<link rel="canonical" href="https://www.youtube.com/watch?v=mPDDhBtFW_Jw">'), undefined)
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

describe('YouTube InnerTube moderation', () => {
  it('parses deleted items and author wipes', () => {
    const payload = {
      continuationContents: {
        liveChatContinuation: {
          actions: [
            { markChatItemAsDeletedAction: { targetItemId: 'm1' } },
            { markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'UC1' } },
          ],
        },
      },
    }
    assert.deepEqual(parseModerationActions(payload), [
      { action: 'delete', messageId: 'm1' },
      { action: 'ban', userId: 'UC1' },
    ])
  })

  it('backs off a dead chat on its own and skips a browser that already failed', () => {
    assert.equal(innerTubeRetryDelay(1), 4_000)
    assert.equal(innerTubeRetryDelay(8), 20_000)
    const missed = new Set<string>()
    assert.equal(youtubeBrowserAllowed('video', missed), true)
    missed.add('video')
    assert.equal(youtubeBrowserAllowed('video', missed), false)
    assert.equal(youtubeBrowserAllowed('other', missed), true)
  })

  it('does not keep a browser miss after a timeout, and expires a real miss', () => {
    const missed = new Map<string, number>()
    assert.equal(isRequestTimeout(new Error('Request timed out after 12000ms')), true)
    assert.equal(isRequestTimeout(Object.assign(new Error('Timeout 30000ms exceeded'), { name: 'TimeoutError' })), true)
    noteYoutubeBrowserMiss('video', new Error('Request timed out after 12000ms'), missed, 1_000)
    assert.equal(youtubeBrowserAllowed('video', missed, 1_000), true)
    noteYoutubeBrowserMiss('video', new Error('browser miss'), missed, 1_000)
    assert.equal(youtubeBrowserAllowed('video', missed, 1_000), false)
    assert.equal(youtubeBrowserAllowed('video', missed, 1_000 + YOUTUBE_BROWSER_MISS_TTL_MS), true)
    assert.equal(missed.has('video'), false)
  })
})
