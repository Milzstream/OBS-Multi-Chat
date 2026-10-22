import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isEndedYouTubeChat,
  parseYouTubeQuotaInput,
  quotaWarnAt,
  youtubeApiErrorReason,
  youtubeQuotaCost,
  youtubeQuotaHealthStatus,
  youtubeQuotaLabel,
} from '../server/logic.js'

describe('YouTube quota', () => {
  it('charges the documented unit costs', () => {
    assert.equal(youtubeQuotaCost('/liveBroadcasts?part=snippet'), 1)
    assert.equal(youtubeQuotaCost('/liveBroadcasts?part=snippet', 'PUT'), 50)
    assert.equal(youtubeQuotaCost('/liveChat/messages?part=snippet', 'GET'), 1)
    assert.equal(youtubeQuotaCost('/liveChat/messages?part=snippet', 'POST'), 50)
    assert.equal(youtubeQuotaCost('/liveChat/bans?part=snippet', 'POST'), 50)
    assert.equal(youtubeQuotaCost('/liveChat/bans?part=snippet', 'DELETE'), 50)
    assert.equal(youtubeQuotaCost('/channels?mine=true'), 1)
    assert.equal(youtubeQuotaCost('/videos?id=abc'), 1)
    assert.equal(youtubeQuotaCost('/videos?part=status', 'PUT'), 50)
    assert.equal(youtubeQuotaCost('/unmapped-endpoint', 'GET'), 1)
  })

  it('labels insert vs list vs delete', () => {
    assert.equal(youtubeQuotaLabel('/liveChat/messages?part=snippet', 'POST'), 'liveChatMessages.insert')
    assert.equal(youtubeQuotaLabel('/liveChat/messages?liveChatId=x', 'GET'), 'liveChatMessages.list')
    assert.equal(youtubeQuotaLabel('/liveChat/messages?id=x', 'DELETE'), 'liveChatMessages.delete')
    assert.equal(youtubeQuotaLabel('/liveChat/bans?part=snippet', 'POST'), 'liveChatBans.insert')
    assert.equal(youtubeQuotaLabel('/videos?chart=mostPopular', 'GET'), 'videos.list')
    assert.equal(youtubeQuotaLabel('/videos?part=status', 'PUT'), 'videos.update')
    assert.equal(youtubeQuotaLabel('/liveBroadcasts?status=active', 'GET'), 'liveBroadcasts.list')
    assert.equal(youtubeQuotaLabel('/liveBroadcasts?part=snippet', 'PUT'), 'liveBroadcasts.update')
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
