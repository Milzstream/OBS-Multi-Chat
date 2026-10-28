import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { activityIsDuplicate, createActivityStore, normalizeSubTier, parseActivityTime, profileUrl } from '../server/activity.js'
import { missingStreamElementsMessage, twitchEventToActivity } from '../server/logic.js'
import { activityFromStreamElements, postStreamElementsMock, STREAMELEMENTS_HISTORY_TYPES, STREAMELEMENTS_REPAIR_TYPES, streamElementsEmulatePlan, streamElementsHistoryUrl, streamElementsMockActivity, streamElementsMockActivityUrl, StreamElementsClient } from '../server/streamelements.js'
import { ActivityWarningBanner, activityWarningKey, shouldShowActivityWarning } from '../src/activity/ActivityApp.tsx'
import { kindColor, platformColor, profileHref } from '../src/activity/ActivityRow.tsx'
import { activityKindLabel, activityListRows, activityPlanColor, activityPlanLabel, activitySubtitle, GIFT_GROUP_MS, kindLabel, pillTextColor } from '../src/activity/format.ts'

describe('activity time and profiles', () => {
  it('parses unix seconds, millis, ISO, and $date wrappers', () => {
    assert.equal(parseActivityTime(1_700_000_000), new Date(1_700_000_000 * 1000).toISOString())
    assert.equal(parseActivityTime(1_700_000_000_000), new Date(1_700_000_000_000).toISOString())
    assert.equal(parseActivityTime('2026-09-02T12:00:00.000Z'), '2026-09-02T12:00:00.000Z')
    assert.equal(parseActivityTime({ $date: '2026-09-02T12:00:00.000Z' }), '2026-09-02T12:00:00.000Z')
    assert.match(parseActivityTime(''), /^\d{4}-\d{2}-\d{2}T/)
  })

  it('builds platform profile URLs and skips test users', () => {
    assert.equal(profileUrl('Twitch', 'Ada'), 'https://www.twitch.tv/ada')
    assert.equal(profileUrl('Kick', 'superiogame_tyle88'), 'https://kick.com/superiogame-tyle88')
    assert.equal(profileUrl('Kick', 'SuperIOgame_Tyle88', undefined, 'superiogame-tyle88'), 'https://kick.com/superiogame-tyle88')
    assert.equal(profileUrl('Kick', 'ada'), 'https://kick.com/ada')
    assert.equal(profileUrl('YouTube', 'Ada', 'UC1234567890123456789012'), 'https://www.youtube.com/channel/UC1234567890123456789012')
    assert.equal(profileUrl('YouTube', '@Ada'), 'https://www.youtube.com/@ada')
    assert.equal(profileUrl('Twitch', 'TestUser'), undefined)
    assert.equal(profileUrl('Twitch', 'Anonymous'), undefined)
  })

  it('prefers the mod view over a stored public profile URL', () => {
    const base = { id: '1', kind: 'follow' as const, user: 'Ada', time: '2026-09-02T12:00:00.000Z', profileUrl: 'https://www.twitch.tv/ada' }
    assert.equal(profileHref({ ...base, platform: 'Twitch' }, 'milz'), 'https://www.twitch.tv/popout/milz/viewercard/ada')
    assert.equal(profileHref({ ...base, platform: 'Twitch' }), 'https://www.twitch.tv/ada')
    assert.equal(profileHref({ ...base, platform: 'StreamElements', source: 'YouTube', userId: 'UC1234567890123456789012' }), 'https://www.youtube.com/channel/UC1234567890123456789012')
    assert.equal(profileHref({ ...base, platform: 'StreamElements', kind: 'merch', profileUrl: 'https://www.twitch.tv/ada' }), 'https://www.twitch.tv/ada')
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
      assert.equal(store.remove('follow-1'), true)
      assert.equal(store.list().some((event) => event.id === 'follow-1'), false)
      assert.equal(store.remove('missing'), false)
      assert.equal(activityIsDuplicate(
        { id: 'native', platform: 'Twitch', kind: 'follow', user: 'cooluser', userId: '9', time: '2026-09-02T12:00:00.000Z' },
        { id: 'se', platform: 'Twitch', kind: 'follow', user: 'Cool User', handle: 'cooluser', userId: '9', time: '2026-09-01T12:00:00.000Z' },
      ), true)
      assert.equal(activityIsDuplicate(
        { id: 'a', platform: 'Twitch', kind: 'cheer', user: 'Ada', amount: '50 Bits', time: '2026-09-02T12:00:00.000Z' },
        { id: 'b', platform: 'Twitch', kind: 'cheer', user: 'Ada', amount: '100 Bits', time: '2026-09-02T12:00:05.000Z' },
      ), false)
      assert.equal(activityIsDuplicate(
        { id: 'a', platform: 'Twitch', kind: 'follow', user: 'Ada', userId: '1', time: '2026-08-01T12:00:00.000Z' },
        { id: 'b', platform: 'Twitch', kind: 'follow', user: 'Ada', userId: '1', time: '2026-09-02T12:00:00.000Z' },
      ), false)
    } finally {
      try { fs.unlinkSync(file) } catch { /* ignore */ }
    }
  })

  it('keeps Power-up Bits spends distinct from a cheer of the same amount', () => {
    const file = path.join(os.tmpdir(), `relay-activity-powerup-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      const store = createActivityStore(file)
      const cheer = { id: 'cheer-1', platform: 'Twitch' as const, kind: 'cheer' as const, user: 'Ada', userId: '7', amount: '100 Bits', time: '2026-09-02T12:00:00.000Z' }
      const gigantify = { ...cheer, id: 'twitch-bits-msg-1', powerUp: 'gigantify' as const, time: '2026-09-02T12:00:05.000Z' }
      const effect = { ...cheer, id: 'twitch-bits-msg-2', powerUp: 'message-effect' as const, time: '2026-09-02T12:00:08.000Z' }
      assert.equal(store.add(cheer), true)
      assert.equal(store.add(gigantify), true)
      assert.equal(store.add(effect), true)
      assert.equal(store.add({ ...gigantify }), false)
      const ids = store.list().map((event) => event.id)
      assert.equal(ids.includes('cheer-1'), true)
      assert.equal(ids.includes('twitch-bits-msg-1'), true)
      assert.equal(ids.includes('twitch-bits-msg-2'), true)
      assert.equal(activityIsDuplicate(cheer, gigantify), false)
      assert.equal(activityIsDuplicate(gigantify, effect), false)
      assert.equal(activityIsDuplicate(gigantify, { ...gigantify }), true)
    } finally {
      try { fs.unlinkSync(file) } catch { /* ignore */ }
    }
  })

  it('folds a Twitch sub notice into the channel.subscribe row and keeps its Prime plan', () => {
    const file = path.join(os.tmpdir(), `relay-activity-notice-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      const store = createActivityStore(file)
      const now = '2026-09-02T12:00:00.000Z'
      const subscribe = { ...twitchEventToActivity('channel.subscribe', { user_login: 'ada', user_id: '7', tier: '1000' }, now)!, feed: 'native' as const }
      const notice = { ...twitchEventToActivity('channel.chat.notification', { notice_type: 'sub', chatter_user_id: '7', chatter_user_login: 'ada', sub: { sub_tier: '1000', is_prime: true } }, '2026-09-02T12:00:01.000Z', 'n1')!, feed: 'native' as const }
      assert.equal(twitchEventToActivity('channel.chat.notification', { notice_type: 'sub', chatter_user_id: '7', sub: {} }, now)?.feed, 'twitch-notice')
      assert.equal(store.add(subscribe), true)
      // addNativeActivity keeps a feed the parser already set, so the notice stays on its own wire.
      assert.equal(store.add({ ...notice, feed: 'twitch-notice' }), 'updated')
      assert.equal(store.list().length, 1)
      assert.equal(store.list()[0].tier, 'prime')
      // A second channel.subscribe for the same person is a second spend and stays its own row.
      assert.equal(store.add({ ...subscribe, id: 'twitch-sub-7-again', time: '2026-09-02T12:00:30.000Z' }), true)
    } finally {
      fs.rmSync(file, { force: true })
      fs.rmSync(`${file}.bak`, { force: true })
    }
  })

  it('collapses a cheer across feeds and keeps two sends on the same feed', () => {
    const file = path.join(os.tmpdir(), `relay-activity-feed-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      const store = createActivityStore(file)
      const native = { id: 'twitch-cheer-1', platform: 'Twitch' as const, kind: 'cheer' as const, user: 'Ada', userId: '7', amount: '100 Bits', feed: 'native' as const, time: '2026-09-02T12:00:00.000Z' }
      const se = { ...native, id: 'se-cheer-1', feed: 'streamelements' as const, time: '2026-09-02T12:00:05.000Z' }
      const nativeAgain = { ...native, id: 'twitch-cheer-2', time: '2026-09-02T12:00:08.000Z' }
      assert.equal(store.add(native), true)
      assert.equal(store.add(se), false)
      assert.equal(store.add(nativeAgain), true)
      const ids = store.list().map((event) => event.id)
      assert.equal(ids.includes('twitch-cheer-1'), true)
      assert.equal(ids.includes('se-cheer-1'), false)
      assert.equal(ids.includes('twitch-cheer-2'), true)
      assert.equal(activityIsDuplicate(native, se), true)
      assert.equal(activityIsDuplicate(native, nativeAgain), false)
      assert.equal(activityIsDuplicate(
        { ...se, time: '2026-09-02T12:00:00.000Z' },
        { ...se, id: 'se-cheer-2', time: '2026-09-02T12:00:05.000Z' },
      ), false)
    } finally {
      try { fs.unlinkSync(file) } catch { /* ignore */ }
    }
  })

  it('rewrites a dead viewer-card URL back to the public profile', () => {
    const file = path.join(os.tmpdir(), `relay-activity-card-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      fs.writeFileSync(file, JSON.stringify([{ id: 'follow-1', platform: 'Twitch', kind: 'follow', user: 'Ada', time: '2026-09-02T12:00:00.000Z', profileUrl: 'https://www.twitch.tv/popout/viewercard/ada?popout=' }]))
      const store = createActivityStore(file)
      assert.equal(store.list()[0]?.profileUrl, 'https://www.twitch.tv/ada')
    } finally {
      try { fs.unlinkSync(file) } catch { /* ignore */ }
    }
  })

  it('caps real events at the configured max and still keeps test rows in memory only', () => {
    const file = path.join(os.tmpdir(), `relay-activity-cap-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      const store = createActivityStore(file, 2)
      assert.equal(store.add({ id: 'f1', platform: 'Twitch', kind: 'follow', user: 'Ada', time: '2026-09-02T12:00:00.000Z' }), true)
      assert.equal(store.add({ id: 'f2', platform: 'Twitch', kind: 'follow', user: 'Mel', time: '2026-09-02T12:01:00.000Z' }), true)
      assert.equal(store.add({ id: 'f3', platform: 'Twitch', kind: 'follow', user: 'Pat', time: '2026-09-02T12:02:00.000Z' }), true)
      assert.equal(store.add({ id: 'test-keep', platform: 'Twitch', kind: 'follow', user: 'TestUser', time: '2026-09-02T12:03:00.000Z' }), true)
      const ids = store.list().map((event) => event.id)
      assert.deepEqual(ids.filter((id) => id !== 'test-keep').slice(0, 2), ['f3', 'f2'])
      assert.equal(ids.includes('f1'), false)
      assert.equal(ids.includes('test-keep'), true)
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string }[]
      assert.deepEqual(saved.map((event) => event.id), ['f3', 'f2'])
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

  it('maps Power-ups from channel.bits.use and leaves plain cheers to channel.cheer', () => {
    const gigantify = twitchEventToActivity('channel.bits.use', {
      user_id: '7', user_login: 'ada', user_name: 'Ada', bits: 30, type: 'power_up',
      power_up: { type: 'gigantify_an_emote', emote: { id: '25', name: 'Kappa' } },
      message: { text: 'look Kappa', fragments: [] },
    }, now, 'msg-1')
    assert.equal(gigantify?.kind, 'cheer')
    assert.equal(gigantify?.powerUp, 'gigantify')
    assert.equal(gigantify?.amount, '30 Bits')
    assert.equal(gigantify?.message, 'Kappa')
    assert.equal(gigantify?.id, 'twitch-bits-msg-1')
    assert.equal(activityKindLabel(gigantify!), 'GIGANTIFY')

    const effect = twitchEventToActivity('channel.bits.use', { user_name: 'Ada', bits: 100, type: 'power_up', power_up: { type: 'message_effect', message_effect_id: 'cosmic' }, message: { text: 'hello' } }, now)
    assert.equal(effect?.powerUp, 'message-effect')
    assert.equal(effect?.message, 'hello')
    assert.equal(activityKindLabel(effect!), 'MESSAGE EFFECT')

    const celebration = twitchEventToActivity('channel.bits.use', { user_name: 'Ada', bits: 250, type: 'power_up', power_up: { type: 'celebration' } }, now)
    assert.equal(celebration?.powerUp, 'celebration')
    assert.equal(celebration?.message, undefined)

    assert.equal(twitchEventToActivity('channel.bits.use', { user_name: 'Ada', bits: 100, type: 'cheer', message: { text: 'Cheer100' } }, now), undefined)
  })

  it('shows custom Power-ups with their title and keeps unknown types as a generic Power-up', () => {
    const custom = twitchEventToActivity('channel.bits.use', {
      user_name: 'Ada', bits: 50, type: 'custom_power_up',
      custom_power_up: { title: 'Hydrate!', reward_id: 'r1' },
      message: { text: 'drink water' },
    }, now, 'msg-2')
    assert.equal(custom?.kind, 'cheer')
    assert.equal(custom?.powerUp, 'custom')
    assert.equal(custom?.amount, '50 Bits')
    assert.equal(custom?.message, 'Hydrate! · drink water')
    assert.equal(activityKindLabel(custom!), 'POWER-UP')
    assert.equal(twitchEventToActivity('channel.bits.use', { user_name: 'Ada', bits: 50, type: 'custom_power_up', custom_power_up: { title: 'Hydrate!' } }, now)?.message, 'Hydrate!')

    const newBuiltIn = twitchEventToActivity('channel.bits.use', { user_name: 'Ada', bits: 20, type: 'power_up', power_up: { type: 'confetti_rain', emote: { name: 'Kappa' } } }, now)
    assert.equal(newBuiltIn?.powerUp, 'other')
    assert.equal(newBuiltIn?.message, 'Kappa')
    assert.equal(activityKindLabel(newBuiltIn!), 'POWER-UP')

    const newTopLevel = twitchEventToActivity('channel.bits.use', { user_name: 'Ada', bits: 10, type: 'mystery_spend' }, now)
    assert.equal(newTopLevel?.powerUp, 'other')
    assert.equal(newTopLevel?.amount, '10 Bits')

    assert.equal(twitchEventToActivity('channel.bits.use', { user_name: 'Ada', bits: 0, type: 'power_up', power_up: { type: 'celebration' } }, now), undefined)
  })

  it('keeps the plain CHEER label when there is no Power-up', () => {
    assert.equal(activityKindLabel({ platform: 'Twitch', kind: 'cheer' }), 'CHEER')
    assert.equal(activityKindLabel({ platform: 'Kick', kind: 'cheer' }), 'KICKS')
  })
})

describe('gifted subs', () => {
  const base = Date.parse('2026-10-11T20:20:00.000Z')
  const at = (seconds: number) => new Date(base + seconds * 1000).toISOString()
  const ev = (id: string, kind: string, user: string, seconds: number, extra: Record<string, unknown> = {}) => ({ id, platform: 'Twitch' as string, kind, user, time: at(seconds), ...extra })
  const newestFirst = <T extends { time: string }>(events: T[]) => [...events].sort((left, right) => Date.parse(right.time) - Date.parse(left.time))
  const shape = (rows: Array<{ event: { user: string; amount?: string; tier?: string }; nested: boolean; synthetic?: boolean }>) => rows.map((row) => `${row.nested ? '  ' : ''}${row.event.user}${row.synthetic ? '*' : ''}${row.event.amount ? ` ${row.event.amount}` : ''}${row.event.tier ? ` ${row.event.tier}` : ''}`)

  it('reads the gifter from StreamElements and Twitch sub_gift notices', () => {
    const se = activityFromStreamElements({ type: 'subscriber', provider: 'twitch', _id: 'g1', createdAt: at(0), data: { username: 'vannyventure', displayName: 'VannyVenture', providerId: '80955688', tier: '1000', sender: 'gin1336', gifted: true, amount: 1 } })
    assert.equal(se?.kind, 'subscription')
    assert.equal(se?.giftedBy, 'gin1336')
    assert.equal(se?.tier, '1000')
    assert.equal(activityFromStreamElements({ type: 'subscriber', provider: 'twitch', _id: 'g2', data: { username: 'ada', tier: 'prime' } })?.giftedBy, undefined)
    assert.equal(activityFromStreamElements({ type: 'communitygiftpurchase', provider: 'twitch', _id: 'g3', data: { username: 'gin1336', amount: 5, tier: '2000' } })?.tier, '2000')

    const native = twitchEventToActivity('channel.chat.notification', { notice_type: 'sub_gift', chatter_user_name: 'GIN1336', chatter_user_login: 'gin1336', sub_gift: { recipient_user_id: '80955688', recipient_user_login: 'vannyventure', sub_tier: '1000', duration_months: 1 } }, at(0), 'n9')
    assert.equal(native?.user, 'vannyventure')
    assert.equal(native?.giftedBy, 'GIN1336')
    assert.equal(native?.tier, '1000')
    assert.equal(twitchEventToActivity('channel.chat.notification', { notice_type: 'sub_gift', chatter_is_anonymous: true, sub_gift: { recipient_user_login: 'ada' } }, at(0))?.giftedBy, 'Anonymous')
    assert.equal(twitchEventToActivity('channel.subscription.gift', { user_name: 'Gin', total: 5, tier: '3000' }, at(0))?.tier, '3000')
    assert.equal(activitySubtitle({ giftedBy: 'gin1336', months: 1 }), 'Gift from gin1336 · 1 mo')
  })

  it('nests gifted subs under the matching gift row, oldest first', () => {
    const events = newestFirst([
      ev('gift', 'gift', 'GIN1336', 0, { handle: 'gin1336', amount: '2 gifts', tier: '1000' }),
      ev('r1', 'subscription', 'Ada', 2, { giftedBy: 'gin1336', tier: '1000' }),
      ev('r2', 'subscription', 'Mel', 1, { giftedBy: 'gin1336', tier: '1000' }),
      ev('own', 'subscription', 'Pat', 30, { tier: 'prime' }),
      ev('follow', 'follow', 'Rosa', 60),
    ])
    assert.deepEqual(shape(activityListRows(events, true)), ['Rosa', 'Pat prime', 'GIN1336 2 gifts 1000', '  Mel 1000', '  Ada 1000'])
    assert.deepEqual(shape(activityListRows(events, false)), ['Rosa', 'Pat prime', 'Ada 1000', 'Mel 1000', 'GIN1336 2 gifts 1000'])
  })

  it('gives a gift row no more subs than it gifted', () => {
    const events = newestFirst([
      ev('gift', 'gift', 'gin1336', 0, { amount: '2 gifts' }),
      ev('a', 'subscription', 'Ada', 1, { giftedBy: 'gin1336' }),
      ev('b', 'subscription', 'Bea', 2, { giftedBy: 'gin1336' }),
      ev('c', 'subscription', 'Cal', 40, { giftedBy: 'gin1336' }),
    ])
    assert.deepEqual(shape(activityListRows(events, true)), ['gin1336* 1 gift', '  Cal', 'gin1336 2 gifts', '  Ada', '  Bea'])
  })

  it('makes up a gift row for gifted subs with no gift row, and splits by gifter and time', () => {
    const later = GIFT_GROUP_MS / 1000 + 60
    const events = newestFirst([
      ev('v', 'subscription', 'VannyVenture', 0, { giftedBy: 'gin1336', tier: '1000' }),
      ev('w', 'subscription', 'Willow', 10, { giftedBy: 'gin1336', tier: '2000' }),
      ev('x', 'subscription', 'Xan', 5, { giftedBy: 'someoneelse', tier: '1000' }),
      ev('y', 'subscription', 'Yara', later, { giftedBy: 'gin1336', tier: '1000' }),
    ])
    const rows = activityListRows(events, true)
    assert.deepEqual(shape(rows), ['gin1336* 1 gift 1000', '  Yara 1000', 'gin1336* 2 gifts', '  VannyVenture 1000', '  Willow 2000', 'someoneelse* 1 gift 1000', '  Xan 1000'])
    assert.equal(rows.filter((row) => row.synthetic).every((row) => row.event.kind === 'gift' && row.event.id.startsWith('gift-group-')), true)
  })

  it('leaves a gift from another platform or far away in time alone', () => {
    const events = newestFirst([
      ev('gift', 'gift', 'gin1336', 0, { amount: '1 gift' }),
      ev('k', 'subscription', 'KickKid', 1, { giftedBy: 'gin1336', platform: 'Kick' }),
      ev('far', 'subscription', 'Late', GIFT_GROUP_MS / 1000 + 5, { giftedBy: 'gin1336' }),
    ])
    assert.deepEqual(shape(activityListRows(events, true)), ['gin1336* 1 gift', '  Late', 'gin1336* 1 gift', '  KickKid', 'gin1336 1 gift'])
  })

  it('fills older rows from history without adding rows that are not stored', () => {
    const file = path.join(os.tmpdir(), `relay-activity-fill-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      const store = createActivityStore(file)
      const stored = { id: '6acbf0327f7cecfdcde49ce8', platform: 'Twitch' as const, kind: 'subscription' as const, user: 'VannyVenture', handle: 'vannyventure', time: at(0) }
      assert.equal(store.add(stored), true)
      assert.equal(store.add({ ...stored, giftedBy: 'gin1336', tier: '1000' }, { fillOnly: true }), 'updated')
      assert.equal(store.list()[0].giftedBy, 'gin1336')
      assert.equal(store.list()[0].tier, '1000')
      assert.equal(store.add({ id: 'deleted-long-ago', platform: 'Twitch', kind: 'subscription', user: 'Gone', time: at(10) }, { fillOnly: true }), false)
      assert.equal(store.list().length, 1)
    } finally {
      fs.rmSync(file, { force: true })
      fs.rmSync(`${file}.bak`, { force: true })
    }
  })

  it('asks for a longer window of only subs and gifts when repairing', () => {
    const url = new URL(streamElementsHistoryUrl('chan', Date.parse('2026-10-28T12:00:00.000Z'), 60, STREAMELEMENTS_REPAIR_TYPES))
    assert.equal(url.searchParams.get('after'), '2026-08-29T12:00:00.000Z')
    assert.deepEqual(url.searchParams.getAll('types'), ['subscriber', 'subscription', 'communitygiftpurchase'])
  })

  it('fills in a gifter missing from the first copy of a gifted sub', () => {
    const file = path.join(os.tmpdir(), `relay-activity-gift-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      const store = createActivityStore(file)
      const row = { id: 'n1', platform: 'Twitch' as const, kind: 'subscription' as const, user: 'vannyventure', userId: '80955688', time: at(0) }
      assert.equal(store.add(row), true)
      assert.equal(store.add({ ...row, id: 'se1', giftedBy: 'gin1336', time: at(3) }), 'updated')
      assert.equal(store.list()[0].giftedBy, 'gin1336')
      assert.equal(store.add({ ...row, id: 'se2', giftedBy: 'other', time: at(4) }), false)
      assert.equal(store.list()[0].giftedBy, 'gin1336')
    } finally {
      fs.rmSync(file, { force: true })
      fs.rmSync(`${file}.bak`, { force: true })
    }
  })
})

describe('activity colors', () => {
  const at = '2026-09-02T12:00:00.000Z'
  const event = (platform: 'Twitch' | 'Kick' | 'YouTube', kind: 'subscription' | 'gift' | 'membership' | 'cheer') => ({ id: 'x', platform, kind, user: 'Ada', time: at })

  it('colors Twitch subs and gift subs Twitch purple and leaves other subs red', () => {
    assert.equal(kindColor(event('Twitch', 'subscription')), platformColor.Twitch)
    assert.equal(kindColor({ ...event('Twitch', 'subscription'), tier: 'prime' }), platformColor.Twitch)
    assert.equal(kindColor(event('Twitch', 'gift')), platformColor.Twitch)
    assert.equal(kindColor(event('Kick', 'subscription')), '#ff4d57')
    assert.equal(kindColor(event('YouTube', 'membership')), '#ff4d57')
    assert.equal(kindColor(event('Twitch', 'cheer')), '#00d4ff')
  })
})

describe('Twitch sub plans', () => {
  const now = '2026-09-02T12:00:00.000Z'

  it('normalizes Prime and tier codes from either source', () => {
    assert.equal(normalizeSubTier('Prime'), 'prime')
    assert.equal(normalizeSubTier('prime'), 'prime')
    assert.equal(normalizeSubTier('2000'), '2000')
    assert.equal(normalizeSubTier(3000), '3000')
    assert.equal(normalizeSubTier(''), undefined)
    assert.equal(normalizeSubTier('gold'), undefined)
  })

  it('reads the plan from StreamElements Twitch subs only', () => {
    const prime = activityFromStreamElements({ type: 'subscriber', provider: 'twitch', data: { username: 'ada', displayName: 'Ada', tier: 'prime', amount: 1 }, _id: 'p1', createdAt: now })
    assert.equal(prime?.tier, 'prime')
    assert.equal(activityKindLabel(prime!), 'SUBSCRIPTION')
    assert.equal(activityPlanLabel(prime!), 'PRIME')
    const kick = activityFromStreamElements({ type: 'subscriber', provider: 'kick', data: { username: 'ada', tier: 'prime' }, _id: 'k1', createdAt: now })
    assert.equal(kick?.tier, undefined)
    const cheer = activityFromStreamElements({ type: 'cheer', provider: 'twitch', data: { username: 'ada', amount: 100, tier: 'prime' }, _id: 'c1', createdAt: now })
    assert.equal(cheer?.tier, undefined)
  })

  it('reads Prime from sub and resub chat notifications and ignores other notices', () => {
    const sub = twitchEventToActivity('channel.chat.notification', { notice_type: 'sub', chatter_user_id: '7', chatter_user_login: 'ada', chatter_user_name: 'Ada', sub: { sub_tier: '1000', is_prime: true, duration_months: 1 } }, now, 'n1')
    assert.equal(sub?.kind, 'subscription')
    assert.equal(sub?.tier, 'prime')
    assert.equal(sub?.months, undefined)
    assert.equal(sub?.id, 'twitch-notice-n1')
    const resub = twitchEventToActivity('channel.chat.notification', { notice_type: 'resub', chatter_user_id: '7', chatter_user_login: 'ada', resub: { sub_tier: '2000', is_prime: false, cumulative_months: 14 }, message: { text: 'still here' } }, now)
    assert.equal(resub?.tier, '2000')
    assert.equal(resub?.months, 14)
    assert.equal(resub?.message, 'still here')
    assert.equal(twitchEventToActivity('channel.chat.notification', { notice_type: 'raid', raid: { viewer_count: 5 } }, now), undefined)
    assert.equal(twitchEventToActivity('channel.chat.notification', { notice_type: 'community_sub_gift' }, now), undefined)
    assert.equal(twitchEventToActivity('channel.subscribe', { user_name: 'Ada', user_id: '7', tier: '3000' }, now)?.tier, '3000')
  })

  it('keeps SUBSCRIPTION as the pill and puts the plan on its own chip', () => {
    assert.equal(activityKindLabel({ platform: 'Twitch', kind: 'subscription', tier: 'prime' }), 'SUBSCRIPTION')
    assert.equal(activityPlanLabel({ kind: 'subscription', tier: 'prime' }), 'PRIME')
    assert.equal(activityPlanLabel({ kind: 'subscription', tier: '1000' }), 'TIER 1')
    assert.equal(activityPlanLabel({ kind: 'subscription', tier: '3000' }), 'TIER 3')
    assert.equal(activityPlanLabel({ kind: 'subscription' }), undefined)
    assert.equal(activityPlanLabel({ kind: 'gift', tier: '1000' }), 'TIER 1')
    assert.equal(activityPlanLabel({ kind: 'follow', tier: '1000' }), undefined)
    assert.notEqual(activityPlanColor('prime'), activityPlanColor('2000'))
    assert.equal(activitySubtitle({ months: 6 }), '6 mo')
  })

  it('puts near-black text on the bright pill colors and white on dark ones', () => {
    for (const color of ['#a970ff', '#ff4d57', '#00d4ff', '#f3af61', '#62c554', '#4aa3ff']) assert.equal(pillTextColor(color), '#0d1013', color)
    assert.equal(pillTextColor('#202729'), '#fff')
    assert.equal(pillTextColor('not-a-color'), '#fff')
  })

  it('lets a later copy that knows Prime upgrade the first copy, and never downgrades it', () => {
    const file = path.join(os.tmpdir(), `relay-activity-prime-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    try {
      const store = createActivityStore(file)
      const native = { id: 'twitch-sub-7', platform: 'Twitch' as const, kind: 'subscription' as const, user: 'ada', userId: '7', tier: '1000' as const, time: now }
      assert.equal(store.add(native), true)
      assert.equal(store.add({ ...native, id: 'twitch-notice-n1', tier: 'prime', time: '2026-09-02T12:00:01.000Z' }), 'updated')
      assert.equal(store.list().length, 1)
      assert.equal(store.list()[0].tier, 'prime')
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { tier?: string }[]
      assert.equal(saved[0].tier, 'prime')
      assert.equal(store.add({ ...native, id: 'se-1', tier: '1000', time: '2026-09-02T12:00:02.000Z' }), false)
      assert.equal(store.list()[0].tier, 'prime')
      assert.equal(store.add({ ...native, id: 'se-2', tier: undefined, time: '2026-09-02T12:00:03.000Z' }), false)

      const fill = { id: 'se-mel', platform: 'Twitch' as const, kind: 'subscription' as const, user: 'Mel', userId: '8', time: now }
      assert.equal(store.add(fill), true)
      assert.equal(store.add({ ...fill, id: 'native-mel', tier: '2000' }), 'updated')
      assert.equal(store.list().find((event) => event.userId === '8')?.tier, '2000')
    } finally {
      fs.rmSync(file, { force: true })
      fs.rmSync(`${file}.bak`, { force: true })
    }
  })
})

describe('StreamElements activity', () => {
  it('asks for history with types, after, and before, which StreamElements needs to return any rows', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z')
    const url = new URL(streamElementsHistoryUrl('chan id', now))
    assert.equal(url.pathname, '/kappa/v2/activities/chan%20id')
    assert.equal(url.searchParams.get('after'), '2026-10-14T12:00:00.000Z')
    assert.equal(url.searchParams.get('before'), '2026-10-28T12:00:00.000Z')
    assert.deepEqual(url.searchParams.getAll('types'), [...STREAMELEMENTS_HISTORY_TYPES])
    for (const type of STREAMELEMENTS_HISTORY_TYPES) {
      assert.ok(activityFromStreamElements({ type, provider: type === 'kicks' ? 'kick' : 'twitch', data: { username: 'ada', amount: 1 }, _id: type }), type)
    }
  })

  it('maps tips, follows, cheers, and merch', () => {
    const tip = activityFromStreamElements({ type: 'tip', provider: 'twitch', data: { username: 'Ada', amount: 5, currency: 'USD', message: 'thanks' }, _id: 't1', createdAt: '2026-09-02T12:00:00.000Z' })
    assert.equal(tip?.platform, 'StreamElements')
    assert.equal(tip?.kind, 'donation')
    assert.equal(tip?.source, 'Twitch')
    assert.match(tip?.amount || '', /\$5/)
    const follow = activityFromStreamElements({ type: 'follow', provider: 'youtube', data: { displayName: 'Mel' }, _id: 'f1' })
    assert.equal(follow?.kind, 'follow')
    const subscriber = activityFromStreamElements({ type: 'subscriber', provider: 'youtube', data: { displayName: 'Mel', username: 'mel' }, _id: 'sub1' })
    assert.equal(subscriber?.kind, 'subscription')
    assert.equal(subscriber?.platform, 'YouTube')
    assert.equal(subscriber?.handle, 'mel')
    const member = activityFromStreamElements({ type: 'sponsor', provider: 'youtube', data: { displayName: 'Mel', username: 'mel' }, _id: 'mem1' })
    assert.equal(member?.kind, 'membership')
    assert.equal(follow?.platform, 'YouTube')
    const cheer = activityFromStreamElements({ type: 'cheer', provider: 'twitch', data: { username: 'Pat', amount: 50 }, _id: 'c1' })
    assert.equal(cheer?.amount, '50 Bits')
    assert.equal(cheer?.feed, 'streamelements')
    const merch = activityFromStreamElements({ type: 'merch', provider: 'streamelements', data: { username: 'Ada', item: { name: 'Hat' }, amount: 20, currency: 'USD' }, _id: 'm1' })
    assert.equal(merch?.kind, 'merch')
    assert.equal(activityFromStreamElements({ type: 'hypetrainstart' }), undefined)
    const kicks = activityFromStreamElements({ type: 'kicks', provider: 'kick', data: { displayName: 'Ada', amount: 100 }, _id: 'k1' })
    assert.equal(kicks?.platform, 'Kick')
    assert.equal(kicks?.amount, '100 Kicks')
  })

  it('builds the overlay editor mock activity for a Kick follow', async () => {
    const plan = streamElementsEmulatePlan('Kick', 'follow')
    assert.equal(plan?.provider, 'kick')
    assert.equal(plan?.type, 'follow')
    const body = streamElementsMockActivity({ provider: 'kick', type: 'follow', name: 'Faustina', now: new Date('2026-10-11T12:00:00.000Z') })
    assert.equal(body.type, 'follow')
    assert.equal(body.isMock, true)
    assert.equal(body.provider, 'kick')
    assert.equal((body.data as { displayName: string }).displayName, 'Faustina')
    assert.equal(streamElementsMockActivityUrl('channel-1'), 'https://api.streamelements.com/kappa/v2/activities/channel-1/mock')
    let posted = ''
    const response = await postStreamElementsMock(
      { channelId: 'channel-1', handle: 'Milz', jwt: 'jwt', provider: 'kick' },
      body,
      async (url, init) => {
        posted = `${url} ${init?.method} ${init?.body}`
        return new Response('{}', { status: 201 })
      },
    )
    assert.equal(response.status, 201)
    assert.match(posted, /\/activities\/channel-1\/mock POST/)
    assert.match(posted, /"isMock":true/)
    assert.equal(streamElementsEmulatePlan('Kick', 'cheer')?.type, 'kicks')
    assert.equal(streamElementsEmulatePlan('YouTube', 'subscription')?.type, 'subscriber')
    assert.equal(streamElementsEmulatePlan('YouTube', 'membership')?.type, 'sponsor')
  })

  it('explains missing JWTs', () => {
    assert.match(missingStreamElementsMessage(['Twitch', 'Kick', 'YouTube']) || '', /STREAMELEMENTS_JWT_TWITCH/)
    assert.match(missingStreamElementsMessage(['Kick']) || '', /STREAMELEMENTS_JWT_KICK/)
    assert.match(missingStreamElementsMessage(['Kick']) || '', /Relay Chat Dock window/)
    assert.doesNotMatch(missingStreamElementsMessage(['Kick']) || '', /Activity settings/)
    assert.equal(missingStreamElementsMessage([]), undefined)
  })
})

describe('activity display', () => {
  it('builds subtitles and kind labels', () => {
    assert.equal(activitySubtitle({ amount: '$5.00', months: 3, viewers: 12, message: 'hi' }), '$5.00 · 3 mo · 12 viewers · hi')
    assert.equal(kindLabel.superchat, 'SUPER CHAT')
    assert.equal(kindLabel.follow, 'FOLLOW')
  })

  it('renders backend warnings and deduplicates them in the activity banner', () => {
    const markup = renderToStaticMarkup(createElement(ActivityWarningBanner, { messages: ['Reconnect Twitch', 'Reconnect Twitch', 'StreamElements offline'], missingJwts: [], seConnected: true, onDismiss: () => undefined }))
    assert.match(markup, /Activity warning/)
    assert.equal(markup.match(/Reconnect Twitch/g)?.length, 1)
    assert.match(markup, /StreamElements offline/)
  })

  it('renders the existing missing-JWT fallback when there are no backend warnings', () => {
    const markup = renderToStaticMarkup(createElement(ActivityWarningBanner, { messages: [], missingJwts: ['Twitch'], seConnected: false, onDismiss: () => undefined }))
    assert.match(markup, /StreamElements not configured/)
    assert.match(markup, /STREAMELEMENTS_JWT_TWITCH/)
    assert.match(markup, /Relay Chat Dock window/)
    assert.doesNotMatch(markup, /Activity settings/)
  })

  it('stays quiet while StreamElements is still connecting, and warns once it settles', () => {
    const base = { warnings: [] as string[], missingJwts: [] as string[], seConnected: false, seConnecting: true, seReady: true, ignoreMissingJwt: false, dismissed: [] as string[] }
    // A restart hydrates the JWTs after the dock's first snapshot. That window
    // used to flash “StreamElements not configured” for a second.
    assert.equal(shouldShowActivityWarning(base), false)
    assert.equal(shouldShowActivityWarning({ ...base, seConnected: true, seConnecting: true }), false)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false }), true)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false, seConnected: true }), false)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false, seConnected: true, missingJwts: ['Kick'] }), true)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false, seConnected: true, ignoreMissingJwt: true }), false)
    // Backend warnings still speak up, and a dismissal still holds for that warning only.
    assert.equal(shouldShowActivityWarning({ ...base, warnings: ['StreamElements disconnected — retrying alerts'] }), true)
    const settled = { ...base, seConnecting: false }
    const setupKey = activityWarningKey(settled)
    assert.equal(shouldShowActivityWarning({ ...settled, dismissed: [setupKey] }), false)
    assert.equal(shouldShowActivityWarning({ ...settled, warnings: ['Reconnect Twitch'], dismissed: [setupKey] }), true)
    const reconnect = { ...base, warnings: ['Reconnect Twitch'] }
    assert.equal(shouldShowActivityWarning({ ...reconnect, dismissed: [activityWarningKey(reconnect)] }), false)
    assert.equal(shouldShowActivityWarning({ ...reconnect, warnings: ['Reconnect Twitch', 'StreamElements offline'], dismissed: [activityWarningKey(reconnect)] }), true)
    // Nothing has reported a StreamElements status yet.
    assert.equal(shouldShowActivityWarning({ ...base, seReady: false, seConnecting: false }), false)
  })
})

describe('StreamElements connection', () => {
  type Handler = (payload?: unknown) => void

  function fakeSocket() {
    const handlers: Record<string, Handler[]> = {}
    const add = (event: string, handler: Handler) => {
      handlers[event] = [...(handlers[event] || []), handler]
      return socket
    }
    const socket = {
      readyState: 1,
      sent: [] as string[],
      on: (event: string, handler: Handler) => add(event, handler),
      once(event: string, handler: Handler) {
        const wrapper: Handler = (payload) => {
          socket.off(event, wrapper)
          handler(payload)
        }
        return add(event, wrapper)
      },
      off(event: string, handler: Handler) { handlers[event] = (handlers[event] || []).filter((item) => item !== handler) },
      send(payload: string) { socket.sent.push(payload) },
      ping() { return undefined },
      close() { socket.fire('close') },
      fire(event: string, payload?: unknown) { for (const handler of [...(handlers[event] || [])]) handler(payload) },
    }
    return socket
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const channel = { channelId: 'c1', handle: 'Ada', jwt: 'jwt', provider: 'twitch' }
  const warn = 'StreamElements disconnected — retrying alerts'

  /** A client on a short clock: it retries at once, but waits 1s before it complains. */
  function testClient(t: TestContext) {
    const sockets: ReturnType<typeof fakeSocket>[] = []
    const messages: (string | undefined)[] = []
    const client = new StreamElementsClient({
      open: () => {
        const socket = fakeSocket()
        sockets.push(socket)
        return socket
      },
      reconnectBaseMs: 20,
      graceMs: 1_000,
    })
    t.after(() => client.stop())
    /** Astro's welcome, the staggered subscribe sends, then the ack. */
    const ack = async (index: number) => {
      sockets[index].fire('message', JSON.stringify({ type: 'welcome' }))
      await wait(160)
      sockets[index].fire('message', JSON.stringify({ type: 'response' }))
    }
    /** Every alert the dock has been given, ignoring the acks that clear them. */
    const alerts = () => messages.filter((message): message is string => Boolean(message))
    return { client, sockets, messages, alerts, ack }
  }

  it('subscribes to both StreamElements topics and clears the warning on the ack', async (t) => {
    const { client, sockets, messages, ack } = testClient(t)
    await client.start([channel], () => undefined, (message) => messages.push(message))
    await ack(0)
    assert.equal(sockets[0].sent.length, 2)
    assert.deepEqual(sockets[0].sent.map((payload) => JSON.parse(payload).data.topic), ['channel.activities', 'channel.tips'])
    assert.equal(client.connected, true)
  })

  it('does not warn about a socket that comes back inside the grace period', async (t) => {
    const { client, sockets, messages, alerts, ack } = testClient(t)
    await client.start([channel], () => undefined, (message) => messages.push(message))
    await ack(0)

    // A routine Astro drop. The old client warned right here, so the dock
    // flashed a disconnect alert for a second on every reconnect.
    sockets[0].fire('close')
    await wait(60)
    assert.equal(sockets.length, 2, 'the client retried the socket')
    await ack(1)
    assert.deepEqual(alerts(), [], 'a reconnected socket never raised an alert')
    assert.equal(client.connected, true)
  })

  it('warns when the socket stays down past the grace period, and clears on recovery', async (t) => {
    const { client, sockets, messages, alerts, ack } = testClient(t)
    await client.start([channel], () => undefined, (message) => messages.push(message))
    await ack(0)

    sockets[0].fire('close')
    await wait(1_100)
    assert.deepEqual(alerts(), [warn])
    assert.equal(client.connected, false)

    await ack(1)
    assert.deepEqual(messages.at(-1), undefined, 'recovery clears the warning')
    assert.equal(client.connected, true)
  })

  it('does not warn when Astro says the topic is already subscribed', async (t) => {
    const { client, sockets, messages, alerts, ack } = testClient(t)
    await client.start([channel, { ...channel, jwt: 'other-jwt' }], () => undefined, (message) => messages.push(message))
    await ack(0)
    assert.equal(sockets[0].sent.length, 2, 'one channel id is one subscribe per topic')
    sockets[0].fire('message', JSON.stringify({ type: 'response', error: 'err', data: { message: 'already subscribed to topic' } }))
    assert.deepEqual(alerts(), [])
    assert.equal(client.connected, true)
  })

  it('does not subscribe again when Astro hands back a reconnect token', async (t) => {
    const { client, sockets, messages, alerts, ack } = testClient(t)
    await client.start([channel], () => undefined, (message) => messages.push(message))
    await ack(0)
    sockets[0].fire('message', JSON.stringify({ type: 'reconnect', data: { reconnect_token: 'resume' } }))
    assert.equal(sockets.length, 2)
    sockets[1].fire('open')
    sockets[1].fire('message', JSON.stringify({ type: 'welcome' }))
    await wait(200)
    assert.equal(sockets[1].sent.length, 0)
    assert.deepEqual(alerts(), [])
    assert.equal(client.connected, true)
  })

  it('never warns after a stop, so a restart cannot leave a stale alert', async (t) => {
    const { client, sockets, messages } = testClient(t)
    await client.start([channel], () => undefined, (message) => messages.push(message))
    sockets[0].fire('close')
    await client.stop()
    await wait(1_100)
    assert.deepEqual(messages, [])
  })
})
