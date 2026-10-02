import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { activityLogLine, createIngestLog, ingestSummary, liveCheckLine, moderationLogLine } from '../server/operator-log.js'

describe('operator log', () => {
  it('logs a live change once, and always logs a manual check', () => {
    const first = liveCheckLine(undefined, { platform: 'Twitch', live: false, viewers: 0 })
    assert.equal(first?.line, 'Twitch offline')
    assert.equal(liveCheckLine(first?.key, { platform: 'Twitch', live: false, viewers: 0 }), undefined)
    assert.match(liveCheckLine(first?.key, { platform: 'Twitch', live: false, viewers: 0 }, true)?.line || '', /check live/)
    assert.match(liveCheckLine(first?.key, { platform: 'Kick', live: true, viewers: 12 })?.line || '', /12 viewers/)
  })

  it('batches added messages and skips a zero count', () => {
    const lines: string[] = []
    let pending: (() => void) | undefined
    const log = createIngestLog((line) => lines.push(line), 1000, {
      set: (fn) => { pending = fn as () => void; return 1 as unknown as ReturnType<typeof setTimeout> },
      clear: () => { pending = undefined },
    })
    log.note('Twitch', 'EventSub', 0)
    log.note('Twitch', 'EventSub')
    log.note('Twitch', 'EventSub', 39)
    assert.deepEqual(lines, [])
    pending?.()
    assert.deepEqual(lines, ['Twitch: 40 messages (EventSub)'])
    assert.equal(ingestSummary('Kick', 'socket', 0), undefined)
    assert.equal(moderationLogLine('ban', 'Kick', 'Ada'), 'ban Kick: Ada')
    assert.equal(activityLogLine({ platform: 'YouTube', kind: 'membership', user: 'Mel' }), 'YouTube membership: Mel')
  })
})
