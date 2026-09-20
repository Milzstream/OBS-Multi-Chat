import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { obsAuthToken, obsStreamStopped, obsWebSocketUrl } from '../server/obs-ws.js'

describe('OBS websocket helpers', () => {
  it('builds the Identify auth hash and treats stream stop events as stopped', () => {
    const token = obsAuthToken('secret', 'salt', 'challenge')
    assert.equal(typeof token, 'string')
    assert.ok(token.length > 10)
    assert.equal(obsAuthToken('secret', 'salt', 'challenge'), token)
    assert.equal(obsStreamStopped('StreamStopped'), true)
    assert.equal(obsStreamStopped('StreamStateChanged', { outputActive: false }), true)
    assert.equal(obsStreamStopped('StreamStateChanged', { outputActive: true }), false)
    assert.equal(obsWebSocketUrl('', 0), 'ws://127.0.0.1:4455')
    assert.equal(obsWebSocketUrl('127.0.0.1', 4455), 'ws://127.0.0.1:4455')
  })
})
