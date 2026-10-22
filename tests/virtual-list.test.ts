import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nextPinState } from '../src/autoScroll.tsx'
import { indexFromRows, scrollTopForIndex, virtualWindow } from '../src/virtualList.ts'

describe('virtual list window', () => {
  it('windows from the live edge when pinned, and from scrollTop when paused', () => {
    const liveBottom = virtualWindow({ count: 100, scrollTop: 0, viewportHeight: 320, estimate: 56, pin: 'bottom', live: true })
    assert.equal(liveBottom.end, 100)
    assert.ok(liveBottom.start < 100)
    assert.equal(liveBottom.padBottom, 0)
    const liveTop = virtualWindow({ count: 100, scrollTop: 0, viewportHeight: 320, estimate: 52, pin: 'top', live: true })
    assert.equal(liveTop.start, 0)
    assert.equal(liveTop.padTop, 0)
    assert.ok(liveTop.end < 100)
    const paused = virtualWindow({ count: 100, scrollTop: 1120, viewportHeight: 320, estimate: 56, pin: 'bottom', live: false })
    assert.ok(paused.start > 0)
    assert.ok(paused.end < 100)
    assert.ok(paused.padTop > 0)
    assert.ok(paused.padBottom > 0)
    const past = virtualWindow({ count: 100, scrollTop: 100_000, viewportHeight: 320, estimate: 56, pin: 'bottom', live: false })
    assert.equal(past.start, 99)
    assert.equal(past.end, 100)
    assert.equal(indexFromRows(80, [{ index: 4, top: 40, height: 70 }, { index: 5, top: 110, height: 40 }], 0), 4)
    assert.equal(scrollTopForIndex(4, 56), 224)
    assert.equal(nextPinState(false, true, true), true)
    assert.equal(nextPinState(false, false, true), false)
  })
})
