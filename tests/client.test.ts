import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { preferredCategory, selectedSendPlatforms, visibleChatMessages } from '../src/chat-helpers.ts'

describe('chat dock helpers', () => {
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
})
