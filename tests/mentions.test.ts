import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultAppSettings, parseAppSettings, parseMentionKeywords } from '../server/logic.js'
import { mentionMatcher } from '../src/chat-helpers.ts'

const line = (text: string, user = 'viewer', extra: { handle?: string; originalText?: string } = {}) => ({ user, text, ...extra })

describe('mention highlighting', () => {
  const mentions = mentionMatcher(['Threesocks', 'three-socks', 'Socks Live'], ['giveaway'])

  it('matches account names with or without @, in any case, as whole words', () => {
    assert.equal(mentions(line('hi @threesocks')), true)
    assert.equal(mentions(line('THREESOCKS you there?')), true)
    assert.equal(mentions(line('gg three-socks!')), true)
    assert.equal(mentions(line('love socks live streams')), true)
    assert.equal(mentions(line('threesocksfan was here')), false)
    assert.equal(mentions(line('mythreesocks')), false)
  })

  it('matches highlight words and the untranslated original', () => {
    assert.equal(mentions(line('when is the Giveaway?')), true)
    assert.equal(mentions(line('nothing here', 'viewer', { originalText: 'привет threesocks' })), true)
    assert.equal(mentions(line('giveaways are fun')), false)
  })

  it('never highlights your own lines', () => {
    assert.equal(mentions(line('@threesocks testing', 'Threesocks')), false)
    assert.equal(mentions(line('giveaway at 100 subs', 'bot', { handle: 'three-socks' })), false)
  })

  it('treats regex characters in names literally and skips empty input', () => {
    const odd = mentionMatcher(['a.b'], ['c++'])
    assert.equal(odd(line('hey a.b')), true)
    assert.equal(odd(line('hey axb')), false)
    assert.equal(odd(line('I like c++ a lot')), true)
    assert.equal(mentionMatcher([undefined, '', 'x'], [])(line('x marks the spot')), false)
  })
})

describe('highlight word settings', () => {
  it('trims, dedupes, strips @, and caps the list', () => {
    assert.deepEqual(parseMentionKeywords(['  Mod ', 'mod', '@Giveaway', '', 7, 'two  words']), ['Mod', 'Giveaway', 'two words'])
    assert.deepEqual(parseMentionKeywords('mod'), [])
    assert.equal(parseMentionKeywords(Array.from({ length: 30 }, (_, index) => `w${index}`)).length, 20)
    assert.equal(parseMentionKeywords(['x'.repeat(80)])[0].length, 40)
  })

  it('defaults to no extra words and survives a settings round trip', () => {
    assert.deepEqual(defaultAppSettings().mentionKeywords, [])
    assert.deepEqual(parseAppSettings({}).mentionKeywords, [])
    assert.deepEqual(parseAppSettings({ mentionKeywords: ['raid', 'Raid'] }).mentionKeywords, ['raid'])
  })
})
