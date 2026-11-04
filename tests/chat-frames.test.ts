import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { applyChatModeration, applyOutgoingSendResult, chatSseFields, collapseYouTubeDuplicates, mergeIncomingChat, sseNamedEvent } from '../server/logic.js'
import type { ChatMessage, Platform } from '../server/types.js'
import { applyChatFrame, sseFrameIsCovered, SSE_STALL_MS, subscribeDockSse } from '../src/sse.ts'
import { chat, own } from './helpers.js'

const row = (id: string, extra: Partial<ChatMessage> = {}) => chat({ id, user: `user-${id}`, text: `text ${id}`, platform: 'Twitch', ...extra })
const ids = (rows: { id: string }[]) => rows.map((item) => item.id)
const wire = (fields: unknown) => JSON.parse(sseNamedEvent('chat', { seq: 1, ...(fields as object) }).split('data: ')[1]) as Record<string, unknown>

/** Diff, send over JSON, apply. Every server change has to land exactly on the server's list. */
function roundTrip(previous: ChatMessage[], next: ChatMessage[]) {
  const fields = chatSseFields(previous, next)
  if (!fields) {
    assert.deepEqual(JSON.parse(JSON.stringify(previous)), JSON.parse(JSON.stringify(next)))
    return { fields, messages: previous }
  }
  const applied = applyChatFrame<ChatMessage>(previous, wire(fields))
  assert.equal(applied.inSync, true)
  assert.deepEqual(applied.messages, JSON.parse(JSON.stringify(next)))
  return { fields, messages: applied.messages }
}

describe('chatSseFields', () => {
  const base = [row('a'), row('b'), row('c')]

  it('sends nothing when the list did not change', () => {
    assert.equal(chatSseFields(base, base), undefined)
    assert.equal(chatSseFields(base, [...base]), undefined)
    assert.equal(chatSseFields(base, base.map((item) => ({ ...item }))), undefined)
  })

  it('sends only the new row, plus the id it trimmed at the cap', () => {
    const next = mergeIncomingChat(base, row('d'), undefined, { ownHandles: own('me'), recentOutgoing: [], max: 3 }).messages
    assert.deepEqual(chatSseFields(base, next), { added: [next[2]], updated: [], removed: ['a'], total: 3 })
    roundTrip(base, next)
  })

  it('sends a changed row without the rest of the list', () => {
    const next = base.map((item) => item.id === 'b' ? { ...item, avatar: 'https://static-cdn.jtvnw.net/x.png' } : item)
    assert.deepEqual(chatSseFields(base, next), { added: [], updated: [{ id: 'b', row: next[1] }], removed: [], total: 3 })
    roundTrip(base, next)
  })

  it('names the old id when an echo swaps a row id in place', () => {
    const next = base.map((item) => item.id === 'b' ? { ...item, id: 'b-platform' } : item)
    assert.deepEqual(chatSseFields(base, next), { added: [], updated: [{ id: 'b', row: next[1] }], removed: [], total: 3 })
    assert.deepEqual(ids(roundTrip(base, next).messages), ['a', 'b-platform', 'c'])
  })

  it('removes a row from the middle', () => {
    assert.deepEqual(chatSseFields(base, [base[0], base[2]]), { added: [], updated: [], removed: ['b'], total: 2 })
    roundTrip(base, [base[0], base[2]])
  })

  it('falls back to the whole list when a row lands mid-list or moves', () => {
    const inserted = [base[0], row('x'), base[1], base[2]]
    assert.deepEqual(chatSseFields(base, inserted), { messages: inserted })
    roundTrip(base, inserted)
    const moved = [base[1], base[0], base[2]]
    assert.deepEqual(chatSseFields(base, moved), { messages: moved })
    roundTrip(base, moved)
    const movedLast = [base[1], base[2], base[0]]
    assert.deepEqual(chatSseFields(base, movedLast), { messages: movedLast })
    roundTrip(base, movedLast)
  })

  it('falls back to the whole list on duplicate ids', () => {
    const doubled = [base[0], base[0]]
    assert.deepEqual(chatSseFields(doubled, base), { messages: base })
    assert.deepEqual(chatSseFields(base, doubled), { messages: doubled })
    // Removing by id here would take both copies out of the dock.
    assert.deepEqual(chatSseFields(doubled, [base[0]]), { messages: [base[0]] })
  })

  it('handles an empty list on either side', () => {
    roundTrip([], base)
    roundTrip(base, [])
  })
})

describe('real server changes survive the round trip', () => {
  it('avatar backfill', () => {
    const before = [row('a'), row('b')]
    const next = before.map((item) => ({ ...item, avatar: item.id === 'a' ? 'https://static-cdn.jtvnw.net/a.png' : item.avatar }))
    assert.equal(roundTrip(before, next).messages[0].avatar, 'https://static-cdn.jtvnw.net/a.png')
  })

  it('moderation strikethrough on one row and on every row from a user', () => {
    const before = [row('a', { userId: '1' }), row('b', { userId: '2' }), row('c', { userId: '1' })]
    const deleted = applyChatModeration(before, { action: 'delete', platform: 'Twitch', messageId: 'b' }).messages
    assert.equal(roundTrip(before, deleted).messages[1].deleted, true)
    const banned = applyChatModeration(before, { action: 'ban', platform: 'Twitch', userId: '1' }).messages
    const { fields, messages } = roundTrip(before, banned)
    assert.deepEqual(messages.map((item) => Boolean(item.deleted)), [true, false, true])
    assert.equal((fields as { updated: unknown[] }).updated.length, 2)
  })

  it('translation', () => {
    const before = [row('a', { text: 'hola' })]
    const next = [{ ...before[0], text: 'hello', originalText: 'hola', parts: [{ type: 'text' as const, text: 'hello' }] }]
    const { messages } = roundTrip(before, next)
    assert.equal(messages[0].text, 'hello')
    assert.equal(messages[0].originalText, 'hola')
  })

  it('unified send: optimistic row, echo merge with id swap, failed send removal', () => {
    const at = Date.now()
    const time = new Date(at).toISOString()
    const outgoing = { id: 'local', text: 'gg', platforms: ['Twitch', 'Kick'] as Platform[], at }
    const ctx = { ownHandles: own('me'), recentOutgoing: [outgoing] }
    const before = [row('old')]
    const sent = mergeIncomingChat(before, chat({ id: 'local', user: 'me', text: 'gg', platform: 'Twitch', platforms: ['Twitch', 'Kick'], time }), undefined, ctx).messages
    assert.deepEqual(ids(roundTrip(before, sent).messages), ['old', 'local'])
    const echoed = mergeIncomingChat(sent, chat({ id: 'twitch-1', user: 'me', text: 'gg', platform: 'Twitch', time }), undefined, ctx)
    assert.equal(echoed.messages.length, 2)
    assert.deepEqual(ids(roundTrip(sent, echoed.messages).messages), ['old', 'twitch-1'])
    const failed = applyOutgoingSendResult(sent, 'local', [{ platform: 'Twitch', ok: false }]).messages
    assert.deepEqual(ids(roundTrip(sent, failed).messages), ['old'])
  })

  it('YouTube duplicate collapse', () => {
    const before = [
      chat({ id: 'y1', user: 'ann', text: 'hi there', platform: 'YouTube', sourceId: 'live' }),
      row('t1'),
      chat({ id: 'y2', user: 'ann', text: 'hi there', platform: 'YouTube', sourceId: 'live' }),
    ]
    const collapsed = collapseYouTubeDuplicates(before)
    assert.equal(collapsed.changed, true)
    assert.deepEqual(ids(roundTrip(before, collapsed.messages).messages), ['y1', 't1'])
  })

  it('stays identical to the server through a long random run', () => {
    let seed = 42
    const roll = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    let server: ChatMessage[] = []
    let dock: ChatMessage[] = []
    let nextId = 0
    for (let step = 0; step < 3000; step++) {
      const previous = server
      const pick = server.length ? server[roll(server.length)] : undefined
      const action = roll(11)
      if (action === 10 && pick) server = [...server.filter((item) => item !== pick), pick]
      else if (action < 6 || !pick) server = [...server, row(`r${nextId++}`)].slice(-50)
      else if (action === 6) server = server.map((item) => item === pick ? { ...item, avatar: `a${step}` } : item)
      else if (action === 7) server = server.map((item) => item === pick ? { ...item, id: `r${nextId++}` } : item)
      else if (action === 8) server = server.filter((item) => item !== pick)
      else server = server.map((item) => item === pick ? { ...item, deleted: !item.deleted } : item)
      const fields = chatSseFields(previous, server)
      if (fields) {
        const applied = applyChatFrame<ChatMessage>(dock, wire(fields))
        assert.equal(applied.inSync, true)
        dock = applied.messages
      }
      assert.deepEqual(dock, JSON.parse(JSON.stringify(server)))
    }
  })
})

describe('applyChatFrame', () => {
  const base = [row('a'), row('b')]

  it('takes a whole-list frame as is', () => {
    assert.deepEqual(applyChatFrame(base, { messages: [row('z')] }), { messages: [row('z')], inSync: true })
  })

  it('keeps untouched rows by reference', () => {
    const { messages } = applyChatFrame(base, { added: [row('c')], updated: [], removed: [], total: 3 })
    assert.equal(messages[0], base[0])
    assert.equal(messages[1], base[1])
  })

  it('does not double a row that /api/state already returned', () => {
    const newer = row('b', { avatar: 'x' })
    const { messages, inSync } = applyChatFrame(base, { added: [newer], updated: [], removed: [], total: 2 })
    assert.equal(inSync, true)
    assert.deepEqual(ids(messages), ['a', 'b'])
    assert.equal(messages[1].avatar, 'x')
  })

  it('applies an id swap that /api/state already returned', () => {
    const swapped = row('b2')
    const { messages, inSync } = applyChatFrame([base[0], swapped], { added: [], updated: [{ id: 'b', row: swapped }], removed: [], total: 2 })
    assert.equal(inSync, true)
    assert.deepEqual(ids(messages), ['a', 'b2'])
  })

  it('ignores a removal that already happened', () => {
    assert.equal(applyChatFrame([base[0]], { added: [], updated: [], removed: ['b'], total: 1 }).inSync, true)
  })

  it('reports drift: an unknown row, a wrong count, or a bad frame', () => {
    assert.equal(applyChatFrame(base, { added: [], updated: [{ id: 'nope', row: row('nope') }], removed: [], total: 2 }).inSync, false)
    assert.equal(applyChatFrame(base, { added: [row('c')], updated: [], removed: [], total: 9 }).inSync, false)
    assert.equal(applyChatFrame(base, { seq: 1 }).inSync, false)
  })

  it('leaves frames at or behind the cursor to the state that covers them', () => {
    assert.equal(sseFrameIsCovered(5, 5, 'chat'), true)
    assert.equal(sseFrameIsCovered(5, 4, 'activity'), true)
    assert.equal(sseFrameIsCovered(5, 6, 'chat'), false)
    assert.equal(sseFrameIsCovered(null, 1, 'chat'), false)
    assert.equal(sseFrameIsCovered(5, 1, 'snapshot'), false)
  })
})

class FakeEventSource {
  static CLOSED = 2
  static instances: FakeEventSource[] = []
  readyState = 1
  onerror: (() => void) | null = null
  listeners = new Map<string, (event: { data: string }) => void>()
  constructor(public url: string) { FakeEventSource.instances.push(this) }
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener) }
  close() { this.readyState = 2 }
  send(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) }) }
}

describe('subscribeDockSse chat frames', () => {
  const realFetch = globalThis.fetch
  let states: { resolve: (body: unknown) => void; reject: (error: Error) => void; url: string }[] = []
  let frames: { seq: number; messages: { id: string }[] }[] = []
  let snapshots: Record<string, unknown>[] = []
  let stop: () => void = () => undefined

  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  const answerState = async (index: number, body: unknown) => {
    states[index].resolve(body)
    await flush()
  }
  const open = (extra: Partial<Parameters<typeof subscribeDockSse>[0]> = {}) => {
    stop = subscribeDockSse({
      onSnapshot: (data) => snapshots.push(data),
      onChat: (data) => frames.push(data),
      onStatus: () => undefined,
      ...extra,
    })
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]
  }
  const delta = (seq: number, added: string[], total: number) => ({ seq, added: added.map((id) => ({ id })), updated: [], removed: [], total })
  const lastIds = () => ids(frames[frames.length - 1].messages)

  beforeEach(() => {
    states = []
    frames = []
    snapshots = []
    FakeEventSource.instances = []
    Object.assign(globalThis, {
      EventSource: FakeEventSource,
      window: { setInterval: () => 1, clearInterval: () => undefined, setTimeout: () => 1, clearTimeout: () => undefined, location: { reload: () => undefined } },
      fetch: (url: string) => new Promise((resolve, reject) => {
        states.push({ url, reject, resolve: (body) => resolve({ ok: true, json: async () => body }) })
      }),
    })
  })

  afterEach(() => {
    stop()
    globalThis.fetch = realFetch
    delete (globalThis as Record<string, unknown>).EventSource
    delete (globalThis as Record<string, unknown>).window
  })

  it('asks for deltas, keeping the watch token in the same query', () => {
    open({ token: 'view secret' })
    assert.equal(FakeEventSource.instances[0].url, '/events?chat=delta&token=view%20secret')
    assert.equal(states[0].url, '/api/state?token=view%20secret')
  })

  it('hands the dock the whole list, built from the connect snapshot plus each delta', () => {
    const source = open()
    source.send('snapshot', { seq: 1, messages: [{ id: 'a' }] })
    assert.equal(snapshots.length, 1)
    source.send('chat', delta(2, ['b'], 2))
    source.send('chat', { seq: 3, added: [{ id: 'c' }], updated: [{ id: 'a', row: { id: 'a', avatar: 'x' } }], removed: ['b'], total: 2 })
    assert.deepEqual(frames.map((frame) => frame.seq), [2, 3])
    assert.deepEqual(frames[1].messages, [{ id: 'a', avatar: 'x' }, { id: 'c' }])
    assert.equal(states.length, 1)
  })

  it('starts the next delta from a later snapshot', () => {
    const source = open()
    source.send('snapshot', { seq: 1, messages: [{ id: 'a' }] })
    source.send('chat', delta(2, ['b'], 2))
    source.send('snapshot', { seq: 2, messages: [{ id: 'a' }, { id: 'b' }, { id: 'unbroadcast' }] })
    source.send('chat', delta(3, ['unbroadcast', 'c'], 4))
    assert.deepEqual(lastIds(), ['a', 'b', 'unbroadcast', 'c'])
  })

  it('recovers from a gap through /api/state and replays what arrived meanwhile, in a raid', async () => {
    const source = open()
    source.send('snapshot', { seq: 1, messages: [{ id: 'a' }] })
    source.send('chat', delta(5, ['e'], 5))
    assert.equal(frames.length, 0)
    assert.equal(states.length, 2)
    // A fresh fetch per frame would never finish while frames keep coming.
    source.send('chat', delta(6, ['f'], 6))
    source.send('chat', delta(7, ['g'], 7))
    source.send('chat', delta(8, ['h'], 8))
    assert.equal(states.length, 2)
    await answerState(1, { seq: 6, messages: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id })) })
    assert.deepEqual(lastIds(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    assert.deepEqual(frames.map((frame) => frame.seq), [7, 8])
    source.send('chat', delta(9, ['i'], 9))
    assert.deepEqual(lastIds().slice(-2), ['h', 'i'])
    assert.equal(states.length, 2)
  })

  it('drops a frame the applied state already covers without resyncing again', async () => {
    const source = open()
    await answerState(0, { seq: 5, messages: [{ id: 'a' }] })
    source.send('chat', delta(4, ['stale'], 2))
    source.send('chat', delta(5, ['stale'], 2))
    assert.equal(states.length, 1)
    assert.equal(frames.length, 0)
    source.send('chat', delta(6, ['b'], 2))
    assert.deepEqual(lastIds(), ['a', 'b'])
  })

  it('resyncs when a delta does not fit the rows the dock has', async () => {
    const source = open()
    source.send('snapshot', { seq: 1, messages: [{ id: 'a' }] })
    source.send('chat', delta(2, ['b'], 99))
    assert.equal(frames.length, 0)
    assert.equal(states.length, 2)
    await answerState(1, { seq: 2, messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    assert.deepEqual(ids(snapshots[snapshots.length - 1].messages as { id: string }[]), ['a', 'b', 'c'])
    source.send('chat', delta(3, ['d'], 4))
    assert.deepEqual(lastIds(), ['a', 'b', 'c', 'd'])
  })

  it('tries again on the next frame after /api/state fails', async () => {
    const source = open()
    source.send('snapshot', { seq: 1, messages: [{ id: 'a' }] })
    source.send('chat', delta(3, ['c'], 3))
    states[1].reject(new Error('down'))
    await flush()
    source.send('chat', delta(4, ['d'], 4))
    assert.equal(states.length, 3)
    await answerState(2, { seq: 4, messages: ['a', 'b', 'c', 'd'].map((id) => ({ id })) })
    source.send('chat', delta(5, ['e'], 5))
    assert.deepEqual(lastIds(), ['a', 'b', 'c', 'd', 'e'])
  })

  it('retries a hung /api/state once it has stalled', (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const source = open()
    source.send('snapshot', { seq: 1, messages: [{ id: 'a' }] })
    source.send('chat', delta(3, ['c'], 3))
    assert.equal(states.length, 2)
    context.mock.timers.tick(SSE_STALL_MS)
    source.send('chat', delta(4, ['d'], 4))
    assert.equal(states.length, 3)
  })

  it('a snapshot during catch-up ends it', () => {
    const source = open()
    source.send('snapshot', { seq: 1, messages: [{ id: 'a' }] })
    source.send('chat', delta(3, ['c'], 3))
    source.send('chat', delta(4, ['d'], 4))
    source.send('snapshot', { seq: 3, messages: ['a', 'b', 'c'].map((id) => ({ id })) })
    assert.deepEqual(lastIds(), ['a', 'b', 'c', 'd'])
    assert.equal(states.length, 2)
  })

  it('keeps the seq cursor on docks that ignore chat, without holding its rows', () => {
    const activity: Record<string, unknown>[] = []
    const source = open({ onChat: undefined, onActivity: (data) => activity.push(data) })
    source.send('snapshot', { seq: 1, messages: [{ id: 'a' }] })
    source.send('chat', delta(2, ['b'], 99))
    source.send('activity', { seq: 3, activityEvent: { id: 'x' } })
    assert.equal(activity.length, 1)
    assert.equal(states.length, 1)
  })
})
