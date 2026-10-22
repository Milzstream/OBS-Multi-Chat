import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  resolveYouTubeLiveChatIds,
  syncYouTubeTokenChatIds,
  youtubeLiveChatMessageBody,
  youtubeSendGuard,
} from '../server/logic.js'

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
