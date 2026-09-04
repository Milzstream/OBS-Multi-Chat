import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  kickBadges,
  kickEmoteUrl,
  looksLikePlaceholder,
  needsTranslation,
  normalizeAvatar,
  parseKickParts,
  parseTwitchChatLine,
  parseTwitchEmoteParts,
  partsFromTwitchFragments,
  pruneYouTubeSeenIds,
  sanitizeIrcMessage,
  summarizeApiError,
  twitchBadgeLabel,
  twitchBadgesFromTag,
  twitchEmoteUrl,
} from '../server/logic.js'
import { chatroomIdFrom, kickEventToActivity, parseJson, pickName } from '../server/kick-chat.js'

describe('Twitch IRC', () => {
  it('parses PRIVMSG tags, badges, and emotes', () => {
    const now = new Date('2026-09-02T12:00:00.000Z')
    const urls = new Map([['broadcaster/1', 'https://badge.example/host.png']])
    const line = '@badge-info=;badges=broadcaster/1,subscriber/12;color=#FF0000;display-name=Ada;emotes=25:6-10;id=abc;user-id=99 :ada!ada@ada.tmi.twitch.tv PRIVMSG #ada :hello Kappa there'
    const parsed = parseTwitchChatLine(line, { now, urls })
    assert.notEqual(parsed, 'ping')
    assert.ok(parsed && parsed !== 'ping')
    assert.equal(parsed.user, 'Ada')
    assert.equal(parsed.userId, '99')
    assert.equal(parsed.color, '#FF0000')
    assert.equal(parsed.text, 'hello Kappa there')
    assert.equal(parsed.badges?.[0].label, 'HOST')
    assert.equal(parsed.badges?.[0].url, 'https://badge.example/host.png')
    assert.equal(parsed.parts?.[1].type, 'emote')
    assert.equal(parsed.emotes?.[0], '25')
  })

  it('returns ping for PING lines and ignores noise', () => {
    assert.equal(parseTwitchChatLine('PING :tmi.twitch.tv'), 'ping')
    assert.equal(parseTwitchChatLine(':tmi.twitch.tv 001 ada :Welcome'), undefined)
  })

  it('sanitizes line breaks and NULs before IRC sends', () => {
    assert.equal(sanitizeIrcMessage('hello\r\nJOIN #other\0world'), 'hello  JOIN #other world')
  })

  it('maps badge labels', () => {
    assert.equal(twitchBadgeLabel('moderator'), 'MOD')
    assert.equal(twitchBadgeLabel('vip'), 'VIP')
    assert.equal(twitchBadgeLabel('bits-leader'), 'BITS')
    assert.deepEqual(twitchBadgesFromTag('moderator/1,unknown/1').map((badge) => badge.label), ['MOD'])
  })
})

describe('Emotes and avatars', () => {
  it('splits Twitch emote ranges and EventSub fragments', () => {
    const parts = parseTwitchEmoteParts('hi Kappa', '25:3-7')
    assert.deepEqual(parts, [
      { type: 'text', text: 'hi ' },
      { type: 'emote', name: 'Kappa', url: twitchEmoteUrl('25') },
    ])
    const fragments = partsFromTwitchFragments([
      { type: 'text', text: 'hi ' },
      { type: 'emote', text: 'Kappa', emote: { id: '25' } },
    ], 'hi Kappa')
    assert.equal(fragments[1].type, 'emote')
  })

  it('parses Kick [emote:id:name] tokens and position lists', () => {
    const tagged = parseKickParts('hey [emote:42:Cat] wow')
    assert.equal(tagged[1].type, 'emote')
    assert.equal(tagged[1].url, kickEmoteUrl('42'))
    const positioned = parseKickParts('hey Cat', [{ id: '9', name: 'Cat', positions: [{ s: 4, e: 6 }] }])
    assert.equal(positioned[1].type, 'emote')
    assert.equal(positioned[1].name, 'Cat')
  })

  it('normalizes avatars and drops placeholders', () => {
    assert.equal(normalizeAvatar('//yt.example/a=s800'), 'https://yt.example/a=s88')
    assert.equal(normalizeAvatar('http://cdn.example/a.png'), 'https://cdn.example/a.png')
    assert.equal(normalizeAvatar('https://yt.example/default-user.png'), undefined)
    assert.equal(normalizeAvatar('https://yt.example/photo.jpg'), undefined)
  })

  it('detects non-English text for translation', () => {
    assert.equal(needsTranslation('hello'), false)
    assert.equal(needsTranslation('こんにちは'), true)
    assert.equal(needsTranslation('Привет chat'), true)
  })
})

describe('YouTube chat memory', () => {
  it('prunes seen ids that are no longer in retained chat history', () => {
    const seen = new Set(['keep', 'drop'])
    pruneYouTubeSeenIds(seen, [{ id: 'keep', platform: 'YouTube', user: 'Ada', text: 'hi', time: '2026-09-02T12:00:00.000Z' }])
    assert.deepEqual([...seen], ['keep'])
  })
})

describe('Kick chat and activity', () => {
  it('reads chatroom ids and names from mixed payloads', () => {
    assert.equal(chatroomIdFrom({ chatroom: { id: '44' } }), 44)
    assert.equal(chatroomIdFrom({ data: { chatroom: { id: 0 } } }), undefined)
    assert.equal(pickName({ username: 'Ada' }), 'Ada')
    assert.equal(parseJson('{"ok":true}').ok, true)
    assert.equal(parseJson('{nope}'), undefined)
  })

  it('maps follows, subs, gifts, kicks, and raids', () => {
    assert.equal(kickEventToActivity('FollowEvent', { username: 'Ada' })?.kind, 'follow')
    assert.equal(kickEventToActivity('SubscriptionEvent', { username: 'Ada', months: 3 })?.months, 3)
    assert.equal(kickEventToActivity('GiftedSubscriptionsEvent', { gifter: 'Pat', gifted_usernames: ['a', 'b'] })?.amount, '2 gifts')
    assert.equal(kickEventToActivity('KicksGifted', { username: 'Mel', amount: 100, message: 'yo' })?.amount, '100 Kicks')
    assert.equal(kickEventToActivity('StreamHost', { username: 'Host', viewers: 12 })?.kind, 'raid')
    assert.equal(kickEventToActivity('FollowersUpdated', {}), undefined)
  })

  it('maps Kick badges and placeholder handles', () => {
    assert.deepEqual(kickBadges([{ type: 'broadcaster', text: 'Host' }, { type: 'moderator' }]).map((badge) => badge.label), ['HOST', 'MOD'])
    assert.equal(looksLikePlaceholder('Kick account'), true)
    assert.equal(looksLikePlaceholder('Ada Live'), true)
    assert.equal(looksLikePlaceholder('adalive'), false)
  })
})

describe('API errors', () => {
  it('summarizes gateway and JSON errors', () => {
    assert.equal(summarizeApiError(504, '<html>Gateway Timeout</html>'), 'Gateway Timeout (Twitch CDN busy)')
    assert.equal(summarizeApiError(400, JSON.stringify({ message: 'missing scope' })), 'missing scope')
    assert.equal(summarizeApiError(500, '<p>nope</p>'), 'nope')
  })
})
