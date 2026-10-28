import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  gigantifyLastEmote,
  kickEmoteUrl,
  needsTranslation,
  normalizeAvatar,
  parseKickParts,
  parseTwitchChatLine,
  parseTwitchEmoteParts,
  parseTwitchModerationLine,
  partsFromTwitchFragments,
  sanitizeIrcMessage,
  twitchBadgeLabel,
  twitchBadgesFromTag,
  twitchEmoteUrl,
  twitchEventSubCloseAction,
  twitchEventSubConnectPlan,
  twitchEventSubRetryDelay,
  twitchEventSubSubscribeStillCurrent,
  twitchEventSubWatchdogShouldClose,
  TWITCH_EVENTSUB_DEFAULT_URL,
} from '../server/logic.js'
import { MessageItem } from '../src/chat/MessageItem.tsx'

describe('Twitch IRC', () => {
  it('marks the last emote of a gigantified IRC message big at the largest scale', () => {
    const line = '@display-name=Ada;emotes=25:0-4,11-15;id=g1;msg-id=gigantified-emote-message;user-id=99 :ada!ada@ada.tmi.twitch.tv PRIVMSG #ada :Kappa then Kappa'
    const parsed = parseTwitchChatLine(line)
    assert.ok(parsed && parsed !== 'ping')
    const emotes = parsed.parts!.filter((part) => part.type === 'emote')
    assert.equal(emotes.length, 2)
    assert.equal(emotes[0].big, undefined)
    assert.equal(emotes[0].url, twitchEmoteUrl('25'))
    assert.equal(emotes[1].big, true)
    assert.equal(emotes[1].url, twitchEmoteUrl('25', '3.0'))
  })

  it('leaves ordinary IRC messages and emote-free parts alone', () => {
    const parsed = parseTwitchChatLine('@display-name=Ada;emotes=25:0-4;id=n1 :ada!ada@ada.tmi.twitch.tv PRIVMSG #ada :Kappa')
    assert.ok(parsed && parsed !== 'ping')
    assert.equal(parsed.parts!.some((part) => part.type === 'emote' && part.big), false)
    const text = [{ type: 'text' as const, text: 'no emotes' }]
    assert.equal(gigantifyLastEmote(text), text)
  })

  it('gigantifies EventSub fragments the same way', () => {
    const parts = gigantifyLastEmote(partsFromTwitchFragments([
      { type: 'text', text: 'hype ' },
      { type: 'emote', text: 'PogChamp', emote: { id: '305954156' } },
    ], 'hype PogChamp'))
    const emote = parts[1]
    assert.equal(emote.type === 'emote' && emote.big, true)
    assert.equal(emote.type === 'emote' && emote.url, twitchEmoteUrl('305954156', '3.0'))
  })

  it('parses PRIVMSG tags, badges, and emotes', () => {
    const now = new Date('2026-09-02T12:00:00.000Z')
    const urls = new Map([['broadcaster/1', 'https://badge.example/host.png']])
    const line = '@badge-info=;badges=broadcaster/1,subscriber/12;color=#FF0000;display-name=Ada;emotes=25:6-10;id=abc;user-id=99 :ada!ada@ada.tmi.twitch.tv PRIVMSG #ada :hello Kappa there'
    const parsed = parseTwitchChatLine(line, { now, urls })
    assert.notEqual(parsed, 'ping')
    assert.ok(parsed && parsed !== 'ping')
    assert.equal(parsed.user, 'Ada')
    assert.equal(parsed.handle, 'ada')
    assert.equal(parsed.userId, '99')
    assert.equal(parsed.color, '#FF0000')
    assert.equal(parsed.text, 'hello Kappa there')
    assert.equal(parsed.badges?.[0].label, 'HOST')
    assert.equal(parsed.badges?.[0].url, 'https://badge.example/host.png')
    assert.equal(parsed.parts?.[1].type, 'emote')
    assert.equal(parsed.emotes?.[0], '25')
  })

  it('unescapes IRCv3 tag values in display names', () => {
    const now = new Date('2026-09-02T12:00:00.000Z')
    const line = '@display-name=Cool\\sUser;color=#1\\:2 :cooluser!cooluser@cooluser.tmi.twitch.tv PRIVMSG #ada :hi'
    const parsed = parseTwitchChatLine(line, { now })
    assert.ok(parsed && parsed !== 'ping')
    assert.equal(parsed.user, 'Cool User')
    assert.equal(parsed.color, '#1;2')
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
    assert.equal(normalizeAvatar('https://files.kick.com/images/user/1/profile_image/conversion/abc-fullsize.webp'), 'https://files.kick.com/images/user/1/profile_image/conversion/abc-fullsize.webp')
  })

  it('detects non-English text for translation', () => {
    assert.equal(needsTranslation('hello'), false)
    assert.equal(needsTranslation('こんにちは'), true)
    assert.equal(needsTranslation('Привет chat'), true)
  })
})

describe('Twitch moderation lines', () => {
  it('parses CLEARMSG, timed CLEARCHAT, and permanent CLEARCHAT', () => {
    assert.deepEqual(parseTwitchModerationLine('@login=ada;target-msg-id=abc :tmi.twitch.tv CLEARMSG #host :nope'), { action: 'delete', platform: 'Twitch', messageId: 'abc', user: 'ada' })
    assert.deepEqual(parseTwitchModerationLine('@ban-duration=600;target-user-id=9 :tmi.twitch.tv CLEARCHAT #host :ada'), { action: 'timeout', platform: 'Twitch', userId: '9', user: 'ada' })
    assert.deepEqual(parseTwitchModerationLine('@target-user-id=9 :tmi.twitch.tv CLEARCHAT #host :ada'), { action: 'ban', platform: 'Twitch', userId: '9', user: 'ada' })
    assert.equal(parseTwitchModerationLine('@room-id=1 :tmi.twitch.tv CLEARCHAT #host'), undefined)
  })
})

describe('Twitch EventSub reconnect', () => {
  it('keeps the old generation on resume and only reconnects the current socket', () => {
    const resume = twitchEventSubConnectPlan('wss://eventsub.wss.twitch.tv/ws?session=abc', 4)
    assert.equal(resume.resume, true)
    assert.equal(resume.generation, 4)
    assert.equal(resume.keepPreviousUntilWelcome, true)
    const fresh = twitchEventSubConnectPlan(TWITCH_EVENTSUB_DEFAULT_URL, 4)
    assert.equal(fresh.resume, false)
    assert.equal(fresh.generation, 5)
    assert.equal(twitchEventSubCloseAction(false, 5, 5), 'ignore')
    assert.equal(twitchEventSubCloseAction(true, 4, 5), 'ignore')
    assert.equal(twitchEventSubCloseAction(true, 5, 5), 'reconnect')
    assert.equal(twitchEventSubCloseAction(true, 4, 4, true, false), 'ignore')
    assert.equal(twitchEventSubCloseAction(false, 4, 4, true, true), 'resume-failed')
    assert.equal(twitchEventSubRetryDelay(0), 3_000)
    assert.equal(twitchEventSubRetryDelay(4), 30_000)
    assert.equal(twitchEventSubWatchdogShouldClose(false, 1, 100_000, 10_000), false)
    assert.equal(twitchEventSubWatchdogShouldClose(true, 0, 100_000, 10_000), false)
    assert.equal(twitchEventSubWatchdogShouldClose(true, 1, 20_000, 10_000), true)
    assert.equal(twitchEventSubSubscribeStillCurrent(5, 'session-a', 5, 'session-a'), true)
    assert.equal(twitchEventSubSubscribeStillCurrent(5, 'session-a', 6, 'session-a'), false)
    assert.equal(twitchEventSubSubscribeStillCurrent(5, '', 5, ''), false)
  })
})

describe('gigantified emote rendering', () => {
  // tsx runs tests with the classic JSX transform, and MessageItem does not import React itself.
  ;(globalThis as { React?: typeof React }).React ??= React

  it('draws a big emote with the emote-big class and a normal one without it', () => {
    const html = renderToStaticMarkup(createElement(MessageItem, {
      message: {
        id: 'g1',
        platform: 'Twitch',
        user: 'Ada',
        text: 'Kappa Kappa',
        time: '2026-09-02T12:00:00.000Z',
        parts: [
          { type: 'emote', name: 'Kappa', url: twitchEmoteUrl('25') },
          { type: 'text', text: ' ' },
          { type: 'emote', name: 'Kappa', url: twitchEmoteUrl('25', '3.0'), big: true },
        ],
      },
      rowIndex: 0,
      showTranslationMark: false,
      onModerate: () => {},
    }))
    assert.equal((html.match(/class="emote emote-big"/g) || []).length, 1)
    assert.equal((html.match(/class="emote"/g) || []).length, 1)
  })
})
