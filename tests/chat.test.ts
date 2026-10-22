import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activityAppendedEvent,
  activitySseFields,
  parseActivityMax,
  parseChatMax,
  parseTranslatedText,
  pruneYouTubeSeenIds,
  resolveTranslateConfig,
  sseBroadcastEvent,
  sseChangedKeys,
  sseNamedEvent,
  summarizeApiError,
  translateFailureMessage,
  shareInFlight,
  restoreYouTubeQuotaBlock,
  youtubeBanChatIds,
  youtubeLiveChatCursor,
  youtubeLiveChatListQuery,
  youtubeScrapedTarget,
} from '../server/logic.js'

describe('YouTube chat memory', () => {
  it('prunes seen ids that are no longer in retained chat history', () => {
    const seen = new Set(['keep', 'drop'])
    pruneYouTubeSeenIds(seen, [{ id: 'keep', platform: 'YouTube', user: 'Ada', text: 'hi', time: '2026-09-02T12:00:00.000Z' }])
    assert.deepEqual([...seen], ['keep'])
  })
})

describe('API errors', () => {
  it('summarizes gateway and JSON errors', () => {
    assert.equal(summarizeApiError(504, '<html>Gateway Timeout</html>'), 'Gateway Timeout (Twitch CDN busy)')
    assert.equal(summarizeApiError(400, JSON.stringify({ message: 'missing scope' })), 'missing scope')
    assert.equal(summarizeApiError(500, '<p>nope</p>'), 'nope')
  })
})

describe('SSE broadcast cache', () => {
  it('skips an unchanged payload', () => {
    const first = sseBroadcastEvent({ n: 1 })
    assert.equal(first.unchanged, false)
    assert.match(first.payload || '', /^data: /)
    const second = sseBroadcastEvent({ n: 1 }, first.json)
    assert.equal(second.unchanged, true)
    assert.equal(second.payload, undefined)
  })

  it('emits named events and lists changed slices', () => {
    assert.equal(sseNamedEvent('chat', { seq: 2 }), 'event: chat\ndata: {"seq":2}\n\n')
    assert.deepEqual(sseChangedKeys({ chat: 'a', activity: 'b' }, { chat: 'a', activity: 'c' }), ['activity'])
    assert.deepEqual(sseChangedKeys({ chat: 'a' }, { chat: 'a' }), [])
  })
})

describe('chat history cap', () => {
  it('defaults to 5000 and clamps RELAY_CHAT_MAX', () => {
    assert.equal(parseChatMax({}), 5000)
    assert.equal(parseChatMax({ RELAY_CHAT_MAX: '20000' }), 20_000)
    assert.equal(parseChatMax({ RELAY_CHAT_MAX: '1' }), 100)
    assert.equal(parseChatMax({ RELAY_CHAT_MAX: '99999999' }), 1_000_000)
    assert.equal(parseChatMax({ RELAY_CHAT_MAX: 'nope' }), 5000)
  })
})

describe('activity history cap and SSE deltas', () => {
  it('defaults to 5000 and clamps RELAY_ACTIVITY_MAX', () => {
    assert.equal(parseActivityMax({}), 5000)
    assert.equal(parseActivityMax({ RELAY_ACTIVITY_MAX: '20000' }), 20_000)
    assert.equal(parseActivityMax({ RELAY_ACTIVITY_MAX: '1' }), 100)
    assert.equal(parseActivityMax({ RELAY_ACTIVITY_MAX: '99999999' }), 1_000_000)
    assert.equal(parseActivityMax({ RELAY_ACTIVITY_MAX: 'nope' }), 5000)
  })

  it('sends one new event, warnings only, or a full replace', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }
    assert.equal(activityAppendedEvent([a, b], [c, a, b])?.id, 'c')
    assert.equal(activityAppendedEvent([a, b], [c, a])?.id, 'c')
    assert.equal(activityAppendedEvent([a, b], [c, b]), undefined)
    assert.deepEqual(activitySseFields([a], [b, a], ['w']), { activityEvent: b, activityWarnings: ['w'] })
    assert.deepEqual(activitySseFields([a, b], [c, a], []), { activityEvent: c, activityWarnings: [], activityTruncated: true })
    assert.deepEqual(activitySseFields([a], [a], ['w']), { activityWarnings: ['w'] })
    assert.deepEqual(activitySseFields([a], [c, b], []), { activity: [c, b], activityWarnings: [] })
  })
})

describe('translation providers', () => {
  it('prefers LibreTranslate URL, then Google v2, then unofficial gtx', () => {
    assert.equal(resolveTranslateConfig({ TRANSLATE_URL: 'https://lt.example/translate' }).provider, 'libre')
    assert.equal(resolveTranslateConfig({ TRANSLATE_API_KEY: 'k' }).provider, 'google-v2')
    assert.equal(resolveTranslateConfig({}).provider, 'gtx')
    assert.equal(parseTranslatedText('gtx', [[['Hello', 'hola']]], 'hola'), 'Hello')
    assert.equal(parseTranslatedText('google-v2', { data: { translations: [{ translatedText: 'Hello' }] } }, 'hola'), 'Hello')
    assert.equal(parseTranslatedText('libre', { translatedText: 'Hello' }, 'hola'), 'Hello')
    assert.equal(parseTranslatedText('gtx', [[['hola', 'hola']]], 'hola'), undefined)
    assert.match(translateFailureMessage('gtx'), /TRANSLATE_API_KEY/)
  })
})

describe('0.7.4 relay fixes', () => {
  it('shares one in-flight refresh per platform', async () => {
    const locks = new Map<string, Promise<number>>()
    let calls = 0
    const run = () => shareInFlight(locks, 'Twitch', async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return calls
    })
    const [first, second] = await Promise.all([run(), run()])
    assert.equal(calls, 1)
    assert.equal(first, 1)
    assert.equal(second, 1)
  })

  it('keeps a scraped video off the previous live chat id', () => {
    assert.deepEqual(youtubeScrapedTarget({ videoId: 'newVideo123', title: 'Night' }), { videoId: 'newVideo123', title: 'Night' })
    assert.equal(youtubeScrapedTarget({ videoId: 'sameVideo12', title: 'Night' }, { liveChatId: 'CHAT' }).liveChatId, 'CHAT')
    const targets = [{ videoId: 'newVideo123' }]
    assert.deepEqual(youtubeBanChatIds('newVideo123', targets, { liveChatId: 'OLD' }), [])
    assert.deepEqual(youtubeBanChatIds('CHAT', [{ videoId: 'v', liveChatId: 'CHAT' }]), ['CHAT'])
  })

  it('continues an official YouTube chat poll from nextPageToken', () => {
    assert.match(youtubeLiveChatListQuery('CHAT', 'PAGE'), /pageToken=PAGE/)
    assert.equal(youtubeLiveChatCursor({ nextPageToken: 'PAGE', pollingIntervalMillis: 10_000 }).pageToken, 'PAGE')
    assert.equal(youtubeLiveChatCursor({}).waitMs, 45_000)
  })

  it('restores a same-day YouTube quota block without a saved timestamp', () => {
    const now = Date.parse('2026-10-02T18:00:00.000Z')
    assert.equal(restoreYouTubeQuotaBlock({ day: '2026-10-01', used: 10_000, limit: 10_000 }, now), 0)
    const until = restoreYouTubeQuotaBlock({ day: '2026-10-02', used: 10_000, limit: 10_000 }, now)
    assert.ok(until > now)
    assert.equal(restoreYouTubeQuotaBlock({ day: '2026-10-02', used: 10, limit: 10_000, blockedUntil: now + 1000 }, now), now + 1000)
  })
})
