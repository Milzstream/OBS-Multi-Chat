import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ACTIVITY_FILTERS, ACTIVITY_KIND_FILTER_KEY, CHAT_FILTERS, parseStoredBoolean, parseStoredFilter, parseStoredStringSet } from '../src/dock-prefs.ts'
import { ACTIVITY_KIND_GROUP_IDS, visibleActivityEvents } from '../src/activity/format.ts'

describe('dock UI prefs', () => {
  it('restores compact mode and platform filters, and keeps current defaults on junk', () => {
    assert.equal(parseStoredBoolean(null, true), true)
    assert.equal(parseStoredBoolean('false', true), false)
    assert.equal(parseStoredBoolean('true', false), true)
    assert.equal(parseStoredBoolean('nope', true), true)
    assert.equal(parseStoredFilter(null, CHAT_FILTERS, 'All'), 'All')
    assert.equal(parseStoredFilter('Kick', CHAT_FILTERS, 'All'), 'Kick')
    assert.equal(parseStoredFilter('Nope', CHAT_FILTERS, 'All'), 'All')
    assert.equal(parseStoredFilter('StreamElements', ACTIVITY_FILTERS, 'All'), 'StreamElements')
    assert.equal(parseStoredFilter('Twitch', ACTIVITY_FILTERS, 'All'), 'Twitch')
    assert.deepEqual(parseStoredStringSet(null, ACTIVITY_KIND_GROUP_IDS), [...ACTIVITY_KIND_GROUP_IDS])
    assert.deepEqual(parseStoredStringSet('[]', ACTIVITY_KIND_GROUP_IDS), [])
    assert.deepEqual(parseStoredStringSet('["follow"]', ACTIVITY_KIND_GROUP_IDS), ['follow'])
    assert.deepEqual(parseStoredStringSet('["nope"]', ACTIVITY_KIND_GROUP_IDS), [...ACTIVITY_KIND_GROUP_IDS])
    assert.deepEqual(parseStoredStringSet('not-json', ACTIVITY_KIND_GROUP_IDS), [...ACTIVITY_KIND_GROUP_IDS])
    assert.equal(ACTIVITY_KIND_FILTER_KEY, 'relay.activity.kindFilter')
  })
})

describe('activity kind filters', () => {
  it('combines platform and kind-group filters, newest first', () => {
    const events = [
      { id: '1', platform: 'Twitch', kind: 'follow', time: '2026-09-02T12:00:00.000Z' },
      { id: '2', platform: 'Twitch', kind: 'subscription', time: '2026-09-02T12:01:00.000Z' },
      { id: '3', platform: 'Kick', kind: 'gift', time: '2026-09-02T12:02:00.000Z' },
      { id: '4', platform: 'StreamElements', kind: 'donation', time: '2026-09-02T12:03:00.000Z' },
    ]
    assert.deepEqual(visibleActivityEvents(events, 'All', ACTIVITY_KIND_GROUP_IDS).map((item) => item.id), ['4', '3', '2', '1'])
    assert.deepEqual(visibleActivityEvents(events, 'Twitch', ['follow']).map((item) => item.id), ['1'])
    assert.deepEqual(visibleActivityEvents(events, 'All', ['sub']).map((item) => item.id), ['3', '2'])
    assert.equal(visibleActivityEvents(events, 'All', []).length, 0)
  })
})
