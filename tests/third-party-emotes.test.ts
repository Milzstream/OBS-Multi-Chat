import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyThirdPartyEmotes, bttvEmotes, ffzEmotes, mergeEmoteMaps, sevenTvEmotes } from '../server/logic.js'
import { isSafeMediaUrl } from '../server/local-api.js'
import { createThirdPartyEmotes, EMOTE_REFRESH_MS, EMOTE_RETRY_MS } from '../server/third-party-emotes.js'
import { dockAvatarSrc } from '../src/chat-helpers.ts'

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'emotes', `${name}.json`), 'utf8'))

describe('third-party emote sets', () => {
  it('reads 7TV global sets and user connections', () => {
    const global = sevenTvEmotes(fixture('7tv-global'))
    assert.equal(global.get('reckH'), 'https://cdn.7tv.app/emote/01FGH8NE3800064MEQW00DNBNG/2x.webp')
    assert.equal(global.has('PETPET'), true)
    const channel = sevenTvEmotes(fixture('7tv-user'))
    assert.deepEqual([...channel.keys()], ['GAMBA', 'zyzzBass'])
    assert.equal(sevenTvEmotes({ emotes: [{ name: 'x', data: { host: { url: '//evil.example/x' } } }] }).size, 0)
  })

  it('reads BTTV global and channel emotes and skips modifiers', () => {
    const global = bttvEmotes(fixture('bttv-global'))
    assert.equal(global.get(':tf:'), 'https://cdn.betterttv.net/emote/54fa8f1401e468494b85b537/2x')
    assert.equal(global.has('c!'), false)
    assert.deepEqual([...bttvEmotes(fixture('bttv-user')).keys()], ['RareHug'])
  })

  it('reads FFZ default global sets and room sets', () => {
    const global = ffzEmotes(fixture('ffz-global'))
    assert.equal(global.get('ZrehplaR'), 'https://cdn.frankerfacez.com/emote/9/2')
    assert.equal(ffzEmotes(fixture('ffz-room')).get('WideHard'), 'https://cdn.frankerfacez.com/emote/246878/2')
    assert.equal(ffzEmotes({ default_sets: [1], sets: { 1: { emoticons: [{ name: 'a' }] }, 2: { emoticons: [{ name: 'b', urls: { 1: 'https://cdn.frankerfacez.com/emote/2/1' } }] } } }).size, 0)
  })

  it('lets the first set win a name clash', () => {
    const merged = mergeEmoteMaps(new Map([['KEKW', 'channel']]), undefined, new Map([['KEKW', 'global'], ['OMEGALUL', 'global']]))
    assert.equal(merged.get('KEKW'), 'channel')
    assert.equal(merged.get('OMEGALUL'), 'global')
  })
})

describe('applying third-party emotes', () => {
  const emotes = new Map([['KEKW', 'https://cdn.7tv.app/emote/a/2x.webp'], ['RareHug', 'https://cdn.betterttv.net/emote/b/2x']])

  it('turns exact whole words into emotes and keeps the spacing', () => {
    const parts = applyThirdPartyEmotes([{ type: 'text', text: 'lol KEKW  that  RareHug' }], emotes)
    assert.deepEqual(parts, [
      { type: 'text', text: 'lol ' },
      { type: 'emote', name: 'KEKW', url: 'https://cdn.7tv.app/emote/a/2x.webp' },
      { type: 'text', text: '  that  ' },
      { type: 'emote', name: 'RareHug', url: 'https://cdn.betterttv.net/emote/b/2x' },
    ])
  })

  it('is case-sensitive, ignores partial words, and keeps platform emotes', () => {
    const kappa = { type: 'emote' as const, name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' }
    const parts = applyThirdPartyEmotes([kappa, { type: 'text', text: ' kekw KEKWW KEKW' }], emotes)
    assert.deepEqual(parts, [kappa, { type: 'text', text: ' kekw KEKWW ' }, { type: 'emote', name: 'KEKW', url: 'https://cdn.7tv.app/emote/a/2x.webp' }])
  })

  it('returns the same array when nothing matched', () => {
    const parts = [{ type: 'text' as const, text: 'nothing to see' }]
    assert.equal(applyThirdPartyEmotes(parts, emotes), parts)
    assert.equal(applyThirdPartyEmotes(parts, new Map()), parts)
  })
})

describe('third-party emote loader', () => {
  const responses: Record<string, unknown> = {
    'https://7tv.io/v3/users/twitch/71092938': fixture('7tv-user'),
    'https://7tv.io/v3/emote-sets/global': fixture('7tv-global'),
    'https://api.betterttv.net/3/cached/users/twitch/71092938': fixture('bttv-user'),
    'https://api.betterttv.net/3/cached/emotes/global': fixture('bttv-global'),
    'https://api.frankerfacez.com/v1/room/id/71092938': fixture('ffz-room'),
    'https://api.frankerfacez.com/v1/set/global': fixture('ffz-global'),
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('loads all three services for Twitch in the background and caches them', async () => {
    const calls: string[] = []
    const lines: string[] = []
    const loader = createThirdPartyEmotes({ fetchImpl: async (url) => { calls.push(url); return json(responses[url]) }, log: (line) => lines.push(line) })
    assert.equal(loader.emotesFor('Twitch', '71092938').size, 0)
    await loader.ready('Twitch', '71092938')
    const emotes = loader.emotesFor('Twitch', '71092938')
    for (const name of ['GAMBA', 'RareHug', 'WideHard', 'reckH', ':tf:', 'ZrehplaR']) assert.equal(emotes.has(name), true, name)
    assert.equal(calls.length, 6)
    assert.equal(loader.emotesFor('Twitch', '71092938'), emotes)
    assert.equal(calls.length, 6)
    assert.ok(lines.includes('7TV emotes: 2 for Twitch'))
  })

  it('uses only 7TV for Kick and YouTube, and treats 404 as no emotes', async () => {
    const calls: string[] = []
    const loader = createThirdPartyEmotes({
      fetchImpl: async (url) => {
        calls.push(url)
        return url.includes('/users/') ? json({ error: 'user not found' }, 404) : json(responses[url])
      },
      log: () => {},
    })
    await loader.ready('Kick', '668')
    await loader.ready('YouTube', 'UCabcdefghijklmnopqrstuv')
    assert.deepEqual(calls.sort(), ['https://7tv.io/v3/emote-sets/global', 'https://7tv.io/v3/users/kick/668'])
    assert.deepEqual([...loader.emotesFor('Kick', '668').keys()], ['reckH', 'PETPET'])
    assert.deepEqual([...loader.emotesFor('YouTube', 'UCabcdefghijklmnopqrstuv').keys()], ['reckH', 'PETPET'])
    assert.equal(loader.emotesFor('Kick', undefined).size, 0)
  })

  it('treats 7TV 400 invalid platform as no channel set', async () => {
    const calls: string[] = []
    const lines: string[] = []
    const loader = createThirdPartyEmotes({
      fetchImpl: async (url) => {
        calls.push(url)
        return url.includes('/users/') ? json({ status: 'Bad Request', error: 'invalid platform' }, 400) : json(responses[url])
      },
      log: (line) => lines.push(line),
    })
    await loader.ready('Kick', '668')
    assert.deepEqual([...loader.emotesFor('Kick', '668').keys()], ['reckH', 'PETPET'])
    assert.equal(lines.some((line) => line.includes('could not load')), false)
    assert.ok(calls.includes('https://7tv.io/v3/users/kick/668'))
  })

  it('keeps the last good set when a refresh fails and retries sooner', async () => {
    let clock = 1_000_000
    let fail = false
    const loader = createThirdPartyEmotes({
      now: () => clock,
      fetchImpl: async (url) => fail ? json({}, 500) : json(responses[url] ?? {}),
      log: () => {},
    })
    await loader.ready('Kick', '1')
    assert.equal(loader.emotesFor('Kick', '1').has('reckH'), true)
    fail = true
    clock += EMOTE_REFRESH_MS
    await loader.ready('Kick', '1')
    assert.equal(loader.emotesFor('Kick', '1').has('reckH'), true)
    fail = false
    clock += EMOTE_RETRY_MS - 1
    await loader.ready('Kick', '1')
    clock += 1
    await loader.ready('Kick', '1')
    assert.equal(loader.emotesFor('Kick', '1').has('reckH'), true)
  })
})

describe('third-party emote images', () => {
  it('lets the media proxy and the docks load 7TV, BTTV, and FFZ images', () => {
    for (const url of ['https://cdn.7tv.app/emote/a/2x.webp', 'https://cdn.betterttv.net/emote/b/2x', 'https://cdn.frankerfacez.com/emote/9/2']) {
      assert.equal(isSafeMediaUrl(url), true, url)
      assert.equal(dockAvatarSrc(url), `/api/media?u=${encodeURIComponent(url)}`)
    }
    assert.equal(isSafeMediaUrl('https://evil.7tv.app.example/x'), false)
  })
})
