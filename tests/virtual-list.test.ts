import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { holdSettlesPinned, keyLeavesEdge, movedAwayFromEdge, nextPinState, scrollLeavesEdge, scrolledPastEdge } from '../src/autoScroll.tsx'
import { consumeCodeScroll, recordRowHeights, rowOffsets, scrollListTo, virtualWindow } from '../src/virtualList.ts'

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
    assert.deepEqual(virtualWindow({ count: 0, scrollTop: 0, viewportHeight: 320, estimate: 56 }), { start: 0, end: 0, padTop: 0, padBottom: 0 })
  })

  it('uses measured heights, so spacers match the rows they stand in for', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f']
    const heights = new Map([['a', 100], ['b', 20], ['c', 200]])
    const offsets = rowOffsets(keys, heights, 50)
    assert.deepEqual(offsets, [0, 100, 120, 320, 370, 420, 470])
    const window = virtualWindow({ count: 6, scrollTop: 330, viewportHeight: 60, estimate: 50, overscan: 1, offsets })
    assert.equal(window.start, 2)
    assert.equal(window.padTop, 120)
    assert.equal(window.end, 6)
    assert.equal(window.padBottom, 0)
    const top = virtualWindow({ count: 6, scrollTop: 0, viewportHeight: 50, estimate: 50, overscan: 0, offsets })
    assert.equal(top.start, 0)
    assert.equal(top.end, 2)
    assert.equal(top.padBottom, 350)
  })

  it('keeps enough rows to fill the viewport from the end when live', () => {
    const keys = Array.from({ length: 50 }, (_, index) => `m${index}`)
    const tall = new Map(keys.map((key) => [key, 200]))
    const window = virtualWindow({ count: 50, scrollTop: 0, viewportHeight: 400, estimate: 44, overscan: 2, pin: 'bottom', live: true, offsets: rowOffsets(keys, tall, 44) })
    assert.equal(window.end, 50)
    assert.equal(window.start, 45)
    assert.equal(window.padTop, 45 * 200)
  })

  it('records heights from row tops, and reports only real changes', () => {
    const heights = new Map<string, number>()
    const keys = ['a', 'b', 'c', 'd']
    assert.equal(recordRowHeights(heights, keys, 1, [10, 40.25, 100]), true)
    assert.equal(heights.get('b'), 30.25)
    assert.equal(heights.get('c'), 59.75)
    assert.equal(heights.has('a'), false)
    assert.equal(recordRowHeights(heights, keys, 1, [10, 40.5, 100]), false)
    assert.equal(recordRowHeights(heights, keys, 1, [10, 50, 100]), true)
    assert.equal(recordRowHeights(heights, keys, 1, []), false)
    assert.equal(recordRowHeights(heights, keys, 3, [0, 10, 20]), true)
    assert.equal(heights.size, 3)
  })
})

describe('auto-scroll pinning', () => {
  it('ignores scrolls made by code, unpins on moving away, and re-pins at the edge', () => {
    assert.equal(nextPinState(false, true, true), true)
    assert.equal(nextPinState(true, true, false), false)
    assert.equal(nextPinState(false, false, true), false)
    assert.equal(nextPinState(true, false, false), true)
    // Still inside the edge zone, but heading away: a smooth scroll's first small steps must not re-pin.
    assert.equal(nextPinState(true, false, false, true), false)
    // A clamp drops scrollTop while the viewport is still on the live edge, so a pinned list stays pinned.
    assert.equal(nextPinState(true, false, true, true), true)
  })

  it('settles a leave-edge gesture back onto the edge unless the user scrolled past it', () => {
    assert.equal(scrolledPastEdge('bottom', 1000, 990), false)
    assert.equal(scrolledPastEdge('bottom', 1000, 900), true)
    assert.equal(scrolledPastEdge('top', 0, 40), false)
    assert.equal(scrolledPastEdge('top', 0, 100), true)
    assert.equal(holdSettlesPinned(true, true), true)
    assert.equal(holdSettlesPinned(false, false), true)
    assert.equal(holdSettlesPinned(false, true), false)
  })

  it('marks a code scroll for one scroll event only, so returning to that spot later counts as the user', () => {
    const list = { scrollTop: 100, dataset: {} as DOMStringMap }
    scrollListTo(list, 0)
    assert.equal(consumeCodeScroll(list), true)
    list.scrollTop = 800
    assert.equal(consumeCodeScroll(list), false)
    list.scrollTop = 0
    assert.equal(consumeCodeScroll(list), false)
  })

  it('leaves no mark when the code scroll did not move the list, and reads a mixed move as the user', () => {
    const list = { scrollTop: 0, dataset: {} as DOMStringMap }
    scrollListTo(list, 0)
    assert.equal(list.dataset.codeScrollTop, undefined)
    assert.equal(consumeCodeScroll(list), false)
    scrollListTo(list, 500)
    list.scrollTop = 350
    assert.equal(consumeCodeScroll(list), false)
    assert.equal(list.dataset.codeScrollTop, undefined)
  })

  it('reads direction against each live edge', () => {
    assert.equal(movedAwayFromEdge('bottom', 500, 490), true)
    assert.equal(movedAwayFromEdge('bottom', 500, 510), false)
    assert.equal(movedAwayFromEdge('bottom', 500, 499.5), false)
    assert.equal(movedAwayFromEdge('top', 10, 30), true)
    assert.equal(movedAwayFromEdge('top', 30, 10), false)
    assert.equal(scrollLeavesEdge('bottom', -100), true)
    assert.equal(scrollLeavesEdge('bottom', 100), false)
    assert.equal(scrollLeavesEdge('top', 100), true)
    assert.equal(scrollLeavesEdge('top', -100), false)
    assert.equal(keyLeavesEdge('bottom', 'PageUp'), true)
    assert.equal(keyLeavesEdge('bottom', 'PageDown'), false)
    assert.equal(keyLeavesEdge('top', 'End'), true)
    assert.equal(keyLeavesEdge('top', 'a'), false)
  })
})
