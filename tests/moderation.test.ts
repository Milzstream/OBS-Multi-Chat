import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyChatModeration,
  kickModerationBanPayload,
  normalizeModerationReason,
  twitchModerationBanData,
  youtubeLiveChatBanSnippet,
} from '../server/logic.js'
import { chat } from './helpers.js'

describe('moderation reasons', () => {
  it('omits a blank reason and caps Twitch at 500 characters', () => {
    assert.equal(normalizeModerationReason('  '), undefined)
    assert.equal(normalizeModerationReason('spam\nwave'), 'spam wave')
    assert.equal(normalizeModerationReason('x'.repeat(600))?.length, 500)
    const twitch = twitchModerationBanData('9', 'timeout', 600, 'spam')
    assert.deepEqual(twitch, { user_id: '9', duration: 600, reason: 'spam' })
    assert.equal('reason' in twitchModerationBanData('9', 'ban', undefined, '   '), false)
    const kick = kickModerationBanPayload('1', '9', 'timeout', 600, 'spam')
    assert.equal(kick.duration, 10)
    assert.equal(kick.reason, 'spam')
    assert.equal('reason' in kickModerationBanPayload('1', '9', 'unban', undefined, 'spam'), false)
    assert.equal('duration' in kickModerationBanPayload('1', '9', 'ban'), false)
  })

  it('does not attach a reason to YouTube live chat bans', () => {
    const banned = youtubeLiveChatBanSnippet('chat', 'UC1', 'ban')
    assert.equal(banned.type, 'permanent')
    assert.equal('reason' in banned, false)
    assert.equal('banDurationSeconds' in banned, false)
    const timed = youtubeLiveChatBanSnippet('chat', 'UC1', 'timeout', 60)
    assert.equal(timed.type, 'temporary')
    assert.equal(timed.banDurationSeconds, 60)
    assert.equal('reason' in timed, false)
  })
})

describe('chat moderation', () => {
  it('lines out a single deleted message and a banned user, then restores on unban', () => {
    const ada = chat({ id: '1', platform: 'Kick', user: 'Ada', userId: '9', text: 'hi' })
    const ada2 = chat({ id: '2', platform: 'Kick', user: 'Ada', userId: '9', text: 'yo' })
    const pat = chat({ id: '3', platform: 'Kick', user: 'Pat', userId: '8', text: 'ok' })
    const deleted = applyChatModeration([ada, ada2, pat], { action: 'delete', platform: 'Kick', messageId: '1' })
    assert.equal(deleted.messages[0].deleted, true)
    assert.equal(deleted.messages[1].deleted, undefined)
    const banned = applyChatModeration(deleted.messages, { action: 'ban', platform: 'Kick', userId: '9', user: 'Ada' })
    assert.equal(banned.messages.length, 3)
    assert.equal(banned.messages.filter((item) => item.deleted).length, 2)
    const restored = applyChatModeration(banned.messages, { action: 'unban', platform: 'Kick', userId: '9' })
    assert.equal(restored.messages.every((item) => !item.deleted), true)
  })

  it('does not line out the same chatter on another platform', () => {
    const kick = chat({ id: '1', platform: 'Kick', user: 'Ada', userId: '9', text: 'hi' })
    const twitch = chat({ id: '2', platform: 'Twitch', user: 'Ada', userId: '99', text: 'hi' })
    const result = applyChatModeration([kick, twitch], { action: 'timeout', platform: 'Kick', userId: '9' })
    assert.equal(result.messages[0].deleted, true)
    assert.equal(result.messages[1].deleted, undefined)
  })
})
