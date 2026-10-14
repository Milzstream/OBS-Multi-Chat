import assert from 'node:assert/strict'
import test from 'node:test'
import { alertSoundGroup, createAlertTracker, enqueueAlerts, isAlertAllowed, parseAlertSettings } from '../src/alerts/alerts.ts'
import { dockView } from '../src/dock-view.ts'
import { clampAlertSeconds, defaultAppSettings, parseAlertDisabled, parseAppSettings } from '../server/logic.js'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const event = (id: string, secondsAgo = 1, extra: Record<string, string> = {}) => ({ id, platform: 'Twitch', kind: 'follow', time: new Date(NOW - secondsAgo * 1000).toISOString(), ...extra })

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
})

test('client alert settings default to off with sound on', () => {
  assert.deepEqual(parseAlertSettings(undefined), { enabled: false, sound: true, displaySec: 5, disabled: [] })
})

test('server alert settings are validated and persisted shape', () => {
  assert.deepEqual(defaultAppSettings().alerts, { enabled: false, sound: true, displaySec: 5, disabled: [] })
  assert.equal(clampAlertSeconds(0), 1)
  assert.equal(clampAlertSeconds(999), 30)
  assert.equal(clampAlertSeconds('abc', 7), 7)
  assert.deepEqual(parseAlertDisabled(['Twitch:follow', 'Twitch:follow', 'Bogus:follow', 'Twitch:nope', 'Twitch:follow:x', 4]), ['Twitch:follow'])
  const parsed = parseAppSettings({ alerts: { enabled: true, sound: false, displaySec: 8, disabled: ['Kick:cheer'] } })
  assert.deepEqual(parsed.alerts, { enabled: true, sound: false, displaySec: 8, disabled: ['Kick:cheer'] })
})

test('/alerts mounts the alert page', () => {
  assert.equal(dockView('/alerts'), 'alerts')
  assert.equal(dockView('/alerts/'), 'alerts')
})
