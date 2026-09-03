import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createActivityStore, parseActivityTime, profileUrl } from '../server/activity.js'
import { missingStreamElementsMessage, twitchEventToActivity } from '../server/logic.js'
import { activityFromStreamElements } from '../server/streamelements.js'
import { activitySubtitle, kindLabel } from '../src/activity/format.ts'

describe('activity time and profiles', () => {
  it('parses unix seconds, millis, ISO, and $date wrappers', () => {
    assert.equal(parseActivityTime(1_700_000_000), new Date(1_700_000_000 * 1000).toISOString())
    assert.equal(parseActivityTime(1_700_000_000_000), new Date(1_700_000_000_000).toISOString())
    assert.equal(parseActivityTime('2026-09-02T12:00:00.000Z'), '2026-09-02T12:00:00.000Z')
    assert.equal(parseActivityTime({ $date: '2026-09-02T12:00:00.000Z' }), '2026-09-02T12:00:00.000Z')
    assert.match(parseActivityTime(''), /^\d{4}-\d{2}-\d{2}T/)
  })

  it('builds platform profile URLs and skips test users', () => {
    assert.equal(profileUrl('Twitch', 'Ada'), 'https://www.twitch.tv/Ada')
    assert.equal(profileUrl('Kick', 'ada'), 'https://kick.com/ada')
    assert.equal(profileUrl('YouTube', 'Ada', 'UC1234567890123456789012'), 'https://www.youtube.com/channel/UC1234567890123456789012')
    assert.equal(profileUrl('YouTube', '@Ada'), 'https://www.youtube.com/@Ada')
    assert.equal(profileUrl('Twitch', 'TestUser'), undefined)
    assert.equal(profileUrl('Twitch', 'Anonymous'), undefined)
  })
})

describe('activity store', () => {
  it('dedupes by id and near-duplicate events, and drops test rows from disk', () => {
    const file = path.join(os.tmpdir(), `relay-activity-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      const store = createActivityStore(file)
      const base = { platform: 'Twitch' as const, kind: 'follow' as const, user: 'Ada', time: '2026-09-02T12:00:00.000Z' }
      assert.equal(store.add({ ...base, id: 'follow-1' }), true)
      assert.equal(store.add({ ...base, id: 'follow-1' }), false)
      assert.equal(store.add({ ...base, id: 'follow-2', time: '2026-09-02T12:00:05.000Z' }), false)
      assert.equal(store.add({ ...base, id: 'test-row', user: 'TestUser', time: '2026-09-02T12:01:00.000Z' }), true)
      assert.equal(store.list().some((event) => event.id === 'test-row'), true)
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string }[]
      assert.equal(saved.some((event) => event.id === 'test-row'), false)
      assert.equal(saved.some((event) => event.id === 'follow-1'), true)
    } finally {
      try { fs.unlinkSync(file) } catch { /* ignore */ }
    }
  })
})

describe('Twitch EventSub activity', () => {
  const now = '2026-09-02T12:00:00.000Z'

  it('maps follows, subs, gifts, cheers, and raids', () => {
    assert.equal(twitchEventToActivity('channel.follow', { user_login: 'ada', user_id: '1', followed_at: now }, now)?.kind, 'follow')
    assert.equal(twitchEventToActivity('channel.subscribe', { is_gift: true, user_id: '1' }, now), undefined)
    assert.equal(twitchEventToActivity('channel.subscribe', { user_name: 'Ada', user_id: '1' }, now)?.kind, 'subscription')
    assert.equal(twitchEventToActivity('channel.subscription.message', { user_name: 'Ada', user_id: '1', cumulative_months: 8, message: { text: 'hi' } }, now)?.months, 8)
    assert.equal(twitchEventToActivity('channel.subscription.gift', { is_anonymous: true, total: 5 }, now)?.user, 'Anonymous')
    assert.equal(twitchEventToActivity('channel.cheer', { user_name: 'Ada', bits: 100, message: 'pog' }, now)?.amount, '100 Bits')
    assert.equal(twitchEventToActivity('channel.raid', { from_broadcaster_user_login: 'host', from_broadcaster_user_id: '9', viewers: 40 }, now)?.viewers, 40)
  })
})

describe('StreamElements activity', () => {
  it('maps tips, follows, cheers, and merch', () => {
    const tip = activityFromStreamElements({ type: 'tip', provider: 'twitch', data: { username: 'Ada', amount: 5, currency: 'USD', message: 'thanks' }, _id: 't1', createdAt: '2026-09-02T12:00:00.000Z' })
    assert.equal(tip?.platform, 'StreamElements')
    assert.equal(tip?.kind, 'donation')
    assert.equal(tip?.source, 'Twitch')
    assert.match(tip?.amount || '', /\$5/)
    const follow = activityFromStreamElements({ type: 'follow', provider: 'youtube', data: { displayName: 'Mel' }, _id: 'f1' })
    assert.equal(follow?.kind, 'follow')
    assert.equal(follow?.platform, 'YouTube')
    const cheer = activityFromStreamElements({ type: 'cheer', provider: 'twitch', data: { username: 'Pat', amount: 50 }, _id: 'c1' })
    assert.equal(cheer?.amount, '50 Bits')
    const merch = activityFromStreamElements({ type: 'merch', provider: 'streamelements', data: { username: 'Ada', item: { name: 'Hat' }, amount: 20, currency: 'USD' }, _id: 'm1' })
    assert.equal(merch?.kind, 'merch')
    assert.equal(activityFromStreamElements({ type: 'hypetrainstart' }), undefined)
  })

  it('explains missing JWTs', () => {
    assert.match(missingStreamElementsMessage(['Twitch', 'Kick', 'YouTube']) || '', /STREAMELEMENTS_JWT_TWITCH/)
    assert.match(missingStreamElementsMessage(['Kick']) || '', /STREAMELEMENTS_JWT_KICK/)
    assert.equal(missingStreamElementsMessage([]), undefined)
  })
})

describe('activity display', () => {
  it('builds subtitles and kind labels', () => {
    assert.equal(activitySubtitle({ amount: '$5.00', months: 3, viewers: 12, message: 'hi' }), '$5.00 · 3 mo · 12 viewers · hi')
    assert.equal(kindLabel.superchat, 'SUPER CHAT')
    assert.equal(kindLabel.follow, 'FOLLOW')
  })
})
