import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AlertLookView } from '../src/alerts/AlertsApp.tsx'
import { alertSoundGroup, alertTemplateValues, createAlertPresenter, createAlertTracker, enqueueAlerts, fillAlertTemplate, isAlertAllowed, neutralAlertColor, neutralAlertLabel, neutralAlertText, parseAlertSettings, resolveAlertLook, usesCustomAlertLook } from '../src/alerts/alerts.ts'
import { dockView } from '../src/dock-view.ts'
import { alertFontCss, alertFontSelectOptions, clampAlertSeconds, defaultAppSettings, mergeAlertFontList, parseAlertDisabled, parseAlertFontFamily, parseAlertLooks, parseAppSettings } from '../server/logic.js'

const ASSET = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mime: 'image/png', name: 'banner.png' }
const SOUND = { id: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', mime: 'audio/mpeg', name: 'cheer.mp3' }

const NOW = Date.parse('2026-01-01T12:00:00Z')
const event = (id: string, secondsAgo = 1, extra: Record<string, string> = {}) => ({ id, platform: 'Twitch', kind: 'follow', user: 'Ada', time: new Date(NOW - secondsAgo * 1000).toISOString(), ...extra })

test('alert tracker ignores history present at connect', () => {
  const tracker = createAlertTracker(() => NOW)
  assert.deepEqual(tracker.ingest([event('a'), event('b')], true), [])
  assert.deepEqual(tracker.ingest([event('a'), event('b')], true), [])
  assert.deepEqual(tracker.ingest([event('a')]), [])
})

test('alert tracker returns new events oldest first and only once', () => {
  const tracker = createAlertTracker(() => NOW)
  tracker.ingest([event('a')], true)
  assert.deepEqual(tracker.ingest([event('c', 1), event('b', 5), event('a')]).map((item) => item.id), ['b', 'c'])
  assert.deepEqual(tracker.ingest([event('c'), event('b')]), [])
})

test('alert tracker ignores nothing before priming and skips stale backfill', () => {
  const tracker = createAlertTracker(() => NOW)
  assert.deepEqual(tracker.ingest([event('x')]), [])
  tracker.ingest([], true)
  assert.deepEqual(tracker.ingest([event('old', 3600), event('new', 2)]).map((item) => item.id), ['new'])
})

test('queue keeps arrival order and drops the oldest waiting alerts past the cap', () => {
  assert.deepEqual(enqueueAlerts([1, 2], [3], 5), [1, 2, 3])
  assert.deepEqual(enqueueAlerts([1, 2, 3], [4, 5], 3), [3, 4, 5])
})

test('type filters and sound groups', () => {
  const disabled = ['YouTube:membership']
  assert.equal(isAlertAllowed({ platform: 'YouTube', kind: 'membership' }, disabled), false)
  assert.equal(isAlertAllowed({ platform: 'YouTube', kind: 'subscription' }, disabled), true)
  assert.equal(isAlertAllowed({ platform: 'Twitch', kind: 'membership' }, disabled), true)
  assert.equal(alertSoundGroup('gift'), 'sub')
  assert.equal(alertSoundGroup('membership'), 'sub')
  assert.equal(alertSoundGroup('merch'), 'donation')
  assert.equal(alertSoundGroup('raid'), 'raid')
  assert.equal(alertSoundGroup('superchat'), 'superchat')
  assert.equal(isAlertAllowed({ platform: 'Twitch', kind: 'cheer' }, ['Twitch:cheer']), false)
  assert.equal(isAlertAllowed({ platform: 'Twitch', kind: 'cheer' }, []), true)
  assert.equal(isAlertAllowed({ platform: 'Twitch', kind: 'cheer', powerUp: 'gigantify' }, []), false)
  assert.equal(isAlertAllowed({ platform: 'Twitch', kind: 'cheer', powerUp: 'celebration' }, []), false)
})

test('client alert settings default to off with sound on', () => {
  assert.deepEqual(parseAlertSettings(undefined), { enabled: false, sound: true, showPlatform: true, displaySec: 5, disabled: [] })
})

test('server alert settings are validated and persisted shape', () => {
  assert.deepEqual(defaultAppSettings().alerts, { enabled: false, sound: true, showPlatform: true, displaySec: 5, disabled: [] })
  assert.equal(clampAlertSeconds(0), 1)
  assert.equal(clampAlertSeconds(999), 30)
  assert.equal(clampAlertSeconds('abc', 7), 7)
  assert.deepEqual(parseAlertDisabled(['Twitch:follow', 'Twitch:follow', 'Bogus:follow', 'Twitch:nope', 'Twitch:follow:x', 4]), ['Twitch:follow'])
  const parsed = parseAppSettings({ alerts: { enabled: true, sound: false, showPlatform: false, displaySec: 8, disabled: ['Kick:cheer'] } })
  assert.deepEqual(parsed.alerts, { enabled: true, sound: false, showPlatform: false, displaySec: 8, disabled: ['Kick:cheer'] })
})

test('platform-neutral labels, colors and text', () => {
  assert.equal(neutralAlertLabel({ platform: 'YouTube', kind: 'subscription' }), 'FOLLOW')
  assert.equal(neutralAlertLabel({ platform: 'Twitch', kind: 'follow' }), 'FOLLOW')
  assert.equal(neutralAlertLabel({ platform: 'Twitch', kind: 'subscription' }), 'SUBSCRIBER')
  assert.equal(neutralAlertLabel({ platform: 'YouTube', kind: 'membership' }), 'SUBSCRIBER')
  assert.equal(neutralAlertLabel({ platform: 'YouTube', kind: 'superchat' }), 'CHEER')
  assert.equal(neutralAlertLabel({ platform: 'Kick', kind: 'cheer' }), 'CHEER')
  assert.equal(neutralAlertColor({ platform: 'YouTube', kind: 'subscription' }), neutralAlertColor({ platform: 'Twitch', kind: 'follow' }))
  assert.equal(neutralAlertText('100 Kicks · hi'), '100 Bits · hi')
})

test('/alerts mounts the alert page', () => {
  assert.equal(dockView('/alerts'), 'alerts')
  assert.equal(dockView('/alerts/'), 'alerts')
})

test('gift bomb plays as one alert', () => {
  const feed = createAlertPresenter(() => NOW)
  feed.ingest([], true)
  const gift = event('g', 2, { kind: 'gift', user: 'Ada', amount: '5 gifts' })
  const subs = [1, 2, 3, 4, 5].map((n) => event(`s${n}`, 1, { kind: 'subscription', user: `u${n}`, giftedBy: 'Ada' }))
  assert.deepEqual(feed.ingest([gift, ...subs]).map((item) => item.id), ['g'])
})

test('lone gifted sub plays as one synthetic gift', () => {
  const feed = createAlertPresenter(() => NOW)
  feed.ingest([], true)
  const first = feed.ingest([event('s1', 1, { kind: 'subscription', user: 'Bob', giftedBy: 'Ada' })])
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'gift')
  assert.equal(first[0].user, 'Ada')
  assert.equal(first[0].id, 'gift-group-s1')
  assert.deepEqual(feed.ingest([event('s2', 1, { kind: 'subscription', user: 'Cal', giftedBy: 'Ada' })]).map((item) => item.id), [])
})

test('two gifts play as two alerts', () => {
  const feed = createAlertPresenter(() => NOW)
  feed.ingest([], true)
  const g1 = event('g1', 2, { kind: 'gift', user: 'Ada', amount: '3 gifts' })
  const g2 = event('g2', 1, { kind: 'gift', user: 'Ada', amount: '2 gifts' })
  assert.deepEqual(feed.ingest([g1, g2]).map((item) => item.id), ['g1', 'g2'])
})

test('gifted subs after a primed gift do not play', () => {
  const feed = createAlertPresenter(() => NOW)
  feed.ingest([event('g', 2, { kind: 'gift', user: 'Ada', amount: '5 gifts' })], true)
  assert.deepEqual(feed.ingest([event('s1', 1, { kind: 'subscription', user: 'Bob', giftedBy: 'Ada' })]).map((item) => item.id), [])
})

test('real gift after a synthetic gift does not play again', () => {
  const feed = createAlertPresenter(() => NOW)
  feed.ingest([], true)
  assert.equal(feed.ingest([event('s1', 2, { kind: 'subscription', user: 'Bob', giftedBy: 'Ada' })])[0].id, 'gift-group-s1')
  assert.deepEqual(feed.ingest([event('g', 1, { kind: 'gift', user: 'Ada', amount: '5 gifts' })]).map((item) => item.id), [])
})

test('follows still play beside a gift bomb', () => {
  const feed = createAlertPresenter(() => NOW)
  feed.ingest([], true)
  const gift = event('g', 2, { kind: 'gift', user: 'Ada', amount: '1 gift' })
  const sub = event('s1', 1, { kind: 'subscription', user: 'Bob', giftedBy: 'Ada' })
  const follow = event('f', 1, { kind: 'follow', user: 'Zoe' })
  assert.deepEqual(feed.ingest([gift, sub, follow]).map((item) => item.id), ['g', 'f'])
})

test('an ungifted sub still plays', () => {
  const feed = createAlertPresenter(() => NOW)
  feed.ingest([], true)
  assert.deepEqual(feed.ingest([event('own', 1, { kind: 'subscription', user: 'Pat' })]).map((item) => item.id), ['own'])
})

test('Power-ups stay out of the on-stream overlay', () => {
  const feed = createAlertPresenter(() => NOW)
  feed.ingest([], true)
  const row = event('p', 1, { kind: 'cheer', powerUp: 'gigantify' })
  const out = feed.ingest([row])
  assert.equal(out.length, 1)
  assert.equal(isAlertAllowed(out[0], []), false)
  assert.equal(isAlertAllowed(event('c', 1, { kind: 'cheer' }), []), true)
})

test('old alert settings still parse without a looks object', () => {
  const parsed = parseAppSettings({ alerts: { enabled: true, sound: false, showPlatform: false, displaySec: 8, disabled: ['Kick:cheer'], extra: 1, kindSchema: { Twitch: { powerup: true } } } })
  assert.deepEqual(parsed.alerts, { enabled: true, sound: false, showPlatform: false, displaySec: 8, disabled: ['Kick:cheer'] })
  assert.equal('looks' in parsed.alerts, false)
  assert.deepEqual(parseAlertLooks(undefined), undefined)
  assert.deepEqual(parseAlertLooks({}), undefined)
  const withLooks = parseAppSettings({ alerts: { enabled: true, looks: { default: { image: ASSET } } } })
  assert.equal(withLooks.alerts.looks?.default?.image?.id, ASSET.id)
})

test('look cascade is platform+kind, then kind, then platform, then default, field by field', () => {
  const settings = parseAlertSettings({
    enabled: true,
    looks: {
      default: { image: ASSET, audio: SOUND, textBoxes: [{ text: '{name}', x: 10, y: 20 }], displaySec: 6 },
      platforms: { Twitch: { audio: { ...SOUND, name: 'twitch.mp3' } } },
      kinds: { follow: { textBoxes: [{ text: 'FOLLOW {name}', x: 5, y: 5 }] } },
      slots: { 'Twitch:follow': { image: { ...ASSET, name: 'follow.png' } } },
    },
  })
  const twitchFollow = resolveAlertLook(settings, { platform: 'Twitch', kind: 'follow' })
  assert.equal(twitchFollow?.image?.name, 'follow.png')
  assert.equal(twitchFollow?.audio?.name, 'twitch.mp3')
  assert.equal(twitchFollow?.textBoxes?.[0]?.text, 'FOLLOW {name}')
  assert.equal(twitchFollow?.displaySec, 6)

  const kickFollow = resolveAlertLook(settings, { platform: 'Kick', kind: 'follow' })
  assert.equal(kickFollow?.image?.name, 'banner.png')
  assert.equal(kickFollow?.audio?.name, 'cheer.mp3')
  assert.equal(kickFollow?.textBoxes?.[0]?.text, 'FOLLOW {name}')

  const twitchCheer = resolveAlertLook(settings, { platform: 'Twitch', kind: 'cheer' })
  assert.equal(twitchCheer?.image?.name, 'banner.png')
  assert.equal(twitchCheer?.audio?.name, 'twitch.mp3')
  assert.equal(twitchCheer?.textBoxes?.[0]?.text, '{name}')

  const kickCheer = resolveAlertLook(settings, { platform: 'Kick', kind: 'cheer' })
  assert.equal(kickCheer?.image?.name, 'banner.png')
  assert.equal(kickCheer?.audio?.name, 'cheer.mp3')
  assert.equal(kickCheer?.textBoxes?.[0]?.text, '{name}')
})

test('a more specific look can clear an inherited graphic with null', () => {
  const settings = parseAlertSettings({
    looks: {
      default: { image: ASSET, textBoxes: [{ text: '{name}', x: 0, y: 0 }] },
      slots: { 'Twitch:follow': { image: null } },
    },
  })
  const look = resolveAlertLook(settings, { platform: 'Twitch', kind: 'follow' })
  assert.equal(look?.image, undefined)
  assert.equal(look?.textBoxes?.[0]?.text, '{name}')
  assert.equal(usesCustomAlertLook(look), true)
})

test('token replace collapses empty values and leaves unknown {tokens} as written', () => {
  const values = { name: 'Ada', amount: '', message: '', kind: 'FOLLOW', platform: 'Twitch', months: '', viewers: '', plan: '', gifter: '' }
  assert.equal(fillAlertTemplate('{name} {amount}', { ...values, amount: '100 Bits' }), 'Ada 100 Bits')
  assert.equal(fillAlertTemplate('{name} {amount}', values), 'Ada')
  assert.equal(fillAlertTemplate('{name}  {amount}', values), 'Ada')
  assert.equal(fillAlertTemplate('hey {unknown}', values), 'hey {unknown}')
  assert.equal(fillAlertTemplate('{NAME}', values), '{NAME}')
  assert.equal(fillAlertTemplate('{name} {message}', { ...values, message: 'hi there' }), 'Ada hi there')
  const follow = alertTemplateValues({ platform: 'Twitch', kind: 'follow', user: 'Ada' }, true)
  assert.equal(follow.name, 'Ada')
  assert.equal(follow.kind, 'FOLLOW')
  assert.equal(follow.platform, 'Twitch')
  const hidden = alertTemplateValues({ platform: 'YouTube', kind: 'subscription', user: 'Bea' }, false)
  assert.equal(hidden.kind, 'FOLLOW')
  assert.equal(hidden.platform, '')
  const sub = alertTemplateValues({ platform: 'Twitch', kind: 'subscription', user: 'Ada', months: 4, tier: 'prime', giftedBy: 'Cal' }, true)
  assert.equal(sub.plan, 'PRIME')
  assert.equal(sub.months, '4')
  assert.equal(sub.gifter, 'Cal')
})

test('custom look vs pill fallback', () => {
  const follow = { id: 'a', platform: 'Twitch' as const, kind: 'follow' as const, user: 'Ada', time: '2026-01-01T12:00:00.000Z' }
  const pillSettings = parseAlertSettings({ enabled: true })
  assert.equal(usesCustomAlertLook(resolveAlertLook(pillSettings, follow)), false)

  const audioOnly = parseAlertSettings({ enabled: true, looks: { default: { audio: SOUND } } })
  assert.equal(usesCustomAlertLook(resolveAlertLook(audioOnly, follow)), false)

  const custom = parseAlertSettings({
    enabled: true,
    looks: { default: { image: ASSET, textBoxes: [{ text: '{name} followed', x: 8, y: 40, width: 80, align: 'center', fontFamily: 'impact' }] } },
  })
  const look = resolveAlertLook(custom, follow)
  assert.equal(usesCustomAlertLook(look), true)
  assert.ok(look)
  const html = renderToStaticMarkup(createElement(AlertLookView, { event: follow, settings: custom, look }))
  assert.match(html, /alert-look/)
  assert.match(html, /Ada followed/)
  assert.match(html, /\/alerts\/assets\/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/)
  assert.doesNotMatch(html, /alert-pill/)
  assert.match(html, /font-size:8em/)
  assert.match(html, /font-family:[^>]*Impact/)
})

test('text boxes keep a safe family name, map legacy ids, and drop CSS injection', () => {
  const looks = parseAlertLooks({
    default: {
      textBoxes: [
        { text: '{name}', x: 8, y: 40, fontFamily: 'Impact', fontSize: 10, fontWeight: 700 },
        { text: 'nope', x: 8, y: 50, fontFamily: 'url("https://evil.example")' },
        { text: 'legacy', x: 8, y: 60, fontFamily: 'comic' },
        { text: 'custom', x: 8, y: 70, fontFamily: 'Bebas Neue' },
        { text: 'inject', x: 8, y: 80, fontFamily: 'Arial; color: red' },
      ],
    },
  })
  assert.equal(looks?.default?.textBoxes?.[0]?.fontFamily, 'Impact')
  assert.equal(looks?.default?.textBoxes?.[0]?.fontSize, 10)
  assert.equal(looks?.default?.textBoxes?.[1]?.fontFamily, undefined)
  assert.equal(looks?.default?.textBoxes?.[2]?.fontFamily, 'Comic Sans MS')
  assert.equal(looks?.default?.textBoxes?.[3]?.fontFamily, 'Bebas Neue')
  assert.equal(looks?.default?.textBoxes?.[4]?.fontFamily, undefined)
  assert.equal(parseAlertFontFamily('outfit'), 'Outfit')
  assert.equal(parseAlertFontFamily('Public Pixel'), 'Public Pixel')
  assert.equal(parseAlertFontFamily('foo <bar>'), undefined)
  assert.equal(alertFontCss('outfit'), 'Outfit, sans-serif')
  assert.equal(alertFontCss('Impact'), '"Impact", Outfit, sans-serif')
  assert.equal(alertFontCss('Bebas Neue'), '"Bebas Neue", Outfit, sans-serif')
  assert.equal(alertFontCss('url(https://evil.example)'), undefined)
  assert.deepEqual(mergeAlertFontList(['Bebas Neue', 'arial', 'url(x)', 'Outfit', 'Bebas Neue']), ['Outfit', 'Arial', 'Bebas Neue'])
  assert.deepEqual(alertFontSelectOptions(['Arial'], 'Airborne Pilot')[0], 'Outfit')
  assert.ok(alertFontSelectOptions(['Arial'], 'Airborne Pilot').includes('Airborne Pilot'))
})

test('look parse drops unknown keys, bad assets, and a Power-up kind slot', () => {
  const looks = parseAlertLooks({
    default: { image: ASSET, css: 'evil', extra: 1 },
    kinds: { powerup: { image: ASSET }, follow: { image: ASSET } },
    slots: { 'Twitch:powerup': { image: ASSET }, 'Twitch:follow': { image: { id: '../secret', mime: 'image/png', name: 'x.png' } } },
    platforms: { Discord: { image: ASSET } },
  })
  assert.equal(looks?.default?.image?.id, ASSET.id)
  assert.equal(looks?.kinds?.follow?.image?.id, ASSET.id)
  assert.equal(looks?.kinds?.powerup, undefined)
  assert.equal(looks?.slots?.['Twitch:follow'], undefined)
  assert.equal(looks?.slots?.['Twitch:powerup'], undefined)
  assert.equal(looks?.platforms?.Twitch, undefined)
})
