import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { activityDockFields, applyActivitySlice, chatDockFields, chatSliceStamp, sameHealth, sameStringList, sseReconnectStillNeeded, sseSeqFromState, sseSeqIsGap, sseStateIsStale } from '../src/sse.ts'

describe('SSE seq gaps', () => {
  it('treats snapshots and pings as resync-safe, and flags skipped deltas', () => {
    assert.equal(sseSeqIsGap(3, 3, 'snapshot'), false)
    assert.equal(sseSeqIsGap(3, 3, 'ping'), false)
    assert.equal(sseSeqIsGap(null, 1, 'chat'), true)
    assert.equal(sseSeqIsGap(3, 4, 'chat'), false)
    assert.equal(sseSeqIsGap(3, 5, 'chat'), true)
  })

  it('does not treat a presence slice as a chat replacement', () => {
    const presence = chatDockFields({
      seq: 4,
      accounts: [{ platform: 'Twitch', viewers: 3 }],
      health: { Twitch: { status: 'ok', message: '' } },
    })
    assert.equal(presence.messages, undefined)
    assert.equal(presence.accounts?.length, 1)
    const snapshot = chatDockFields({
      seq: 4,
      messages: [{ id: '1', text: 'hi' }],
      accounts: [{ platform: 'Kick', viewers: 1 }],
    })
    assert.equal(snapshot.messages?.length, 1)
    assert.equal(snapshot.accounts?.length, 1)
  })

  it('does not treat an activity slice as StreamElements disconnecting', () => {
    const slice = activityDockFields({
      seq: 9,
      activity: [{ id: 'a1' }],
      activityWarnings: ['Reconnect Twitch'],
    })
    assert.equal(slice.activity?.length, 1)
    assert.deepEqual(slice.activityWarnings, ['Reconnect Twitch'])
    assert.equal(slice.streamelements, undefined)
    assert.equal(slice.activityEvent, undefined)
    const delta = activityDockFields({ seq: 10, activityEvent: { id: 'a2', kind: 'follow' } })
    assert.equal(slice.activity?.length, 1)
    assert.equal((delta.activityEvent as { id: string }).id, 'a2')
    assert.equal(delta.activity, undefined)
    assert.deepEqual(applyActivitySlice([{ id: 'a1' }], delta).map((item) => item.id), ['a2', 'a1'])
    assert.deepEqual(applyActivitySlice([{ id: 'a1' }, { id: 'a0' }], { activityEvent: { id: 'a2' }, activityTruncated: true }).map((item) => item.id), ['a2', 'a1'])
    assert.equal(sseReconnectStillNeeded(3, 3), true)
    assert.equal(sseReconnectStillNeeded(3, 4), false)
    assert.equal(sseSeqFromState(8, 4), 8)
    assert.equal(sseSeqFromState(8, 9), 9)
    assert.equal(sseStateIsStale(8, 4), true)
    assert.equal(sseStateIsStale(8, 8), false)
    assert.equal(sseStateIsStale(null, 4), false)
    assert.deepEqual(applyActivitySlice([{ id: 'a1' }], slice), [{ id: 'a1' }])
    const snapshot = activityDockFields({
      seq: 1,
      streamelements: { connected: true, handle: 'Ada', missing: [] },
    })
    assert.equal(snapshot.streamelements && (snapshot.streamelements as { connected: boolean }).connected, true)
  })
})

describe('chat frame compare', () => {
  it('changes when the tail, a delete, or translated text changes, without matching a full stringify', () => {
    const previous = [{ id: '1', text: 'hi' }, { id: '2', text: 'yo' }]
    assert.equal(chatSliceStamp(previous), chatSliceStamp([{ id: '1', text: 'hi' }, { id: '2', text: 'yo' }]))
    assert.notEqual(chatSliceStamp(previous), chatSliceStamp([{ id: '1', text: 'hi' }, { id: '2', text: 'yo', deleted: true }]))
    assert.notEqual(chatSliceStamp(previous), chatSliceStamp([{ id: '1', text: 'hi' }, { id: '2', text: 'hello' }]))
    assert.equal(sameStringList(['a'], ['a']), true)
    assert.equal(sameHealth({ Twitch: { status: 'ok', message: '' } }, { Twitch: { status: 'warn', message: 'down' } }), false)
  })

  it('treats an avatar backfill on the same id as a changed chat slice', () => {
    const before = [{ id: '1', text: 'hi' }]
    const after = [{ id: '1', text: 'hi', avatar: 'https://static-cdn.jtvnw.net/x.png' }]
    assert.notEqual(chatSliceStamp(before), chatSliceStamp(after))
    assert.equal(chatSliceStamp(after), chatSliceStamp([{ id: '1', text: 'hi', avatar: 'https://static-cdn.jtvnw.net/x.png' }]))
  })

  it('changes when color, badges, emotes, or source label backfill on the same id', () => {
    const before = [{ id: '1', text: 'hi', platform: 'Twitch' }]
    assert.notEqual(chatSliceStamp(before), chatSliceStamp([{ ...before[0], color: '#a970ff' }]))
    assert.notEqual(chatSliceStamp(before), chatSliceStamp([{ ...before[0], badges: [{ title: 'mod', url: 'https://static-cdn.jtvnw.net/badges/mod.png' }] }]))
    assert.notEqual(chatSliceStamp(before), chatSliceStamp([{ ...before[0], parts: [{ type: 'emote', url: 'https://static-cdn.jtvnw.net/emote.png' }] }]))
    assert.notEqual(chatSliceStamp(before), chatSliceStamp([{ ...before[0], sourceLabel: 'Shorts' }]))
    assert.notEqual(chatSliceStamp(before), chatSliceStamp([{ ...before[0], originalText: 'hola' }]))
    assert.notEqual(chatSliceStamp(before), chatSliceStamp([{ ...before[0], platforms: ['Twitch', 'Kick'] }]))
  })
})
