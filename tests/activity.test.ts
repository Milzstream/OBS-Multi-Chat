import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { activityIsDuplicate, createActivityStore, parseActivityTime, profileUrl } from '../server/activity.js'
import { missingStreamElementsMessage, twitchEventToActivity } from '../server/logic.js'
import { activityFromStreamElements, StreamElementsClient } from '../server/streamelements.js'
import { ActivityWarningBanner, shouldShowActivityWarning } from '../src/activity/ActivityApp.tsx'
import { profileHref } from '../src/activity/ActivityRow.tsx'
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
    const member = activityFromStreamElements({ type: 'subscriber', provider: 'youtube', data: { displayName: 'Mel', username: 'mel' }, _id: 'mem1' })
    assert.equal(member?.kind, 'membership')
    assert.equal(member?.handle, 'mel')
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
    const base = { warnings: [] as string[], missingJwts: [] as string[], seConnected: false, seConnecting: true, seReady: true, ignoreMissingJwt: false, dismissed: false }
    // A restart hydrates the JWTs after the dock's first snapshot. That window
    // used to flash “StreamElements not configured” for a second.
    assert.equal(shouldShowActivityWarning(base), false)
    assert.equal(shouldShowActivityWarning({ ...base, seConnected: true, seConnecting: true }), false)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false }), true)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false, seConnected: true }), false)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false, seConnected: true, missingJwts: ['Kick'] }), true)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false, seConnected: true, ignoreMissingJwt: true }), false)
    // Backend warnings still speak up, and a dismissal still holds.
    assert.equal(shouldShowActivityWarning({ ...base, warnings: ['StreamElements disconnected — retrying alerts'] }), true)
    assert.equal(shouldShowActivityWarning({ ...base, seConnecting: false, dismissed: true }), false)
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

  it('never warns after a stop, so a restart cannot leave a stale alert', async (t) => {
    const { client, sockets, messages } = testClient(t)
    await client.start([channel], () => undefined, (message) => messages.push(message))
    sockets[0].fire('close')
    await client.stop()
    await wait(1_100)
    assert.deepEqual(messages, [])
  })
})
