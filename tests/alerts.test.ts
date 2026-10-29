import assert from 'node:assert/strict'
import test from 'node:test'
import { alertSoundGroup, createAlertPresenter, createAlertTracker, enqueueAlerts, isAlertAllowed, neutralAlertColor, neutralAlertLabel, neutralAlertText, parseAlertSettings } from '../src/alerts/alerts.ts'
import { dockView } from '../src/dock-view.ts'
import { clampAlertSeconds, defaultAppSettings, parseAlertDisabled, parseAppSettings } from '../server/logic.js'

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
