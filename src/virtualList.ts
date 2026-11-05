import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react'

/**
 * Window a long list to the on-screen slice plus overscan. Spacers keep
 * scrollHeight honest so chat (pin bottom) and activity (pin top) auto-scroll
 * still see the live edge. No extra list library.
 *
 * Rows wrap, so their heights are measured once rendered and `estimate` only
 * stands in for rows not seen yet. While the list is paused the top visible
 * row is held in place, so a measurement or a new row never moves the view.
 */

export const CHAT_ROW_ESTIMATE = 56
export const CHAT_ROW_ESTIMATE_COMPACT = 44
export const ACTIVITY_ROW_ESTIMATE = 52
export const VIRTUAL_OVERSCAN = 8

/** Row tops from the measured heights, with one extra entry for the total height. */
export function rowOffsets(keys: readonly string[], heights: ReadonlyMap<string, number>, estimate: number) {
  const offsets = new Array<number>(keys.length + 1)
  offsets[0] = 0
  for (let index = 0; index < keys.length; index++) offsets[index + 1] = offsets[index] + (heights.get(keys[index]) ?? estimate)
  return offsets
}

function uniformOffsets(count: number, estimate: number) {
  return Array.from({ length: count + 1 }, (_, index) => index * estimate)
}

/** First row whose bottom is below `top`. */
function rowAt(offsets: readonly number[], top: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle + 1] > top) high = middle
    else low = middle + 1
  }
  return low
}

export function virtualWindow(options: {
  count: number
  scrollTop: number
  viewportHeight: number
  estimate: number
  overscan?: number
  pin?: 'top' | 'bottom'
  live?: boolean
  offsets?: readonly number[]
}) {
  const count = Math.max(0, options.count)
  const estimate = Math.max(1, options.estimate)
  const overscan = options.overscan ?? VIRTUAL_OVERSCAN
  const viewportHeight = Math.max(0, options.viewportHeight)
  const offsets = options.offsets ?? uniformOffsets(count, estimate)
  const total = offsets[count]
  if (options.live && options.pin === 'bottom') {
    let first = count
    while (first > 0 && total - offsets[first] < viewportHeight) first -= 1
    const start = Math.max(0, first - 1 - overscan)
    return { start, end: count, padTop: offsets[start], padBottom: 0 }
  }
  const scrollTop = Math.max(0, options.scrollTop)
  if (count === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  if (scrollTop >= total) return { start: count - 1, end: count, padTop: offsets[count - 1], padBottom: 0 }
  const first = rowAt(offsets, scrollTop)
  let shown = first
  while (shown < count && offsets[shown] - offsets[first] < viewportHeight) shown += 1
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, shown + 1 + overscan)
  return { start, end, padTop: offsets[start], padBottom: total - offsets[end] }
}

/**
 * Store heights from rendered row tops: one top per row plus the bottom edge of
 * the last row, so margins count. Returns true when a height changed.
 */
export function recordRowHeights(heights: Map<string, number>, keys: readonly string[], start: number, tops: readonly number[]) {
  let changed = false
  for (let index = 0; index + 1 < tops.length; index++) {
    const key = keys[start + index]
    if (key === undefined) break
    const height = tops[index + 1] - tops[index]
    const known = heights.get(key)
    if (known !== undefined && Math.abs(known - height) <= 0.5) continue
    heights.set(key, height)
    changed = true
  }
  return changed
}

type ScrollableList = Pick<HTMLElement, 'scrollTop' | 'dataset'>

/** Scroll the list from code, and remember the spot so its scroll event is not read as the user's. */
export function scrollListTo(listEl: ScrollableList, top: number) {
  const before = listEl.scrollTop
  listEl.scrollTop = top
  // No move means no scroll event, and a leftover mark would swallow the user's next one.
  if (listEl.scrollTop !== before) listEl.dataset.codeScrollTop = String(listEl.scrollTop)
}

/** Answer for one scroll event: did code put the list here? */
export function consumeCodeScroll(listEl: ScrollableList) {
  const expected = listEl.dataset.codeScrollTop
  delete listEl.dataset.codeScrollTop
  return expected !== undefined && Math.abs(listEl.scrollTop - Number(expected)) <= 1
}

function rowElements(listEl: HTMLElement) {
  const children = [...listEl.children]
  const rows = children.filter((child) => !child.classList.contains('virtual-spacer'))
  return { rows, bottom: children[children.length - 1] }
}

export function useVirtualWindow(
  listRef: RefObject<HTMLElement | null>,
  keys: readonly string[],
  estimate: number,
  pin: 'top' | 'bottom',
  live: boolean,
  onScrollExtra?: (event: UIEvent<HTMLElement>) => void,
) {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(320)
  const [, setMeasured] = useState(0)
  const heights = useRef(new Map<string, number>())
  const anchor = useRef<{ key: string; top: number } | null>(null)
  const listWidth = useRef(0)
  const previousEstimate = useRef(estimate)

  const offsets = rowOffsets(keys, heights.current, estimate)
  const slice = virtualWindow({ count: keys.length, scrollTop, viewportHeight, estimate, pin, live, offsets })
  const rendered = useRef({ keys, start: slice.start, live })
  rendered.current = { keys, start: slice.start, live }

  /**
   * Remember the top visible row and its place in the content, to hold it while
   * paused. Content position only changes when the layout does, so the user
   * scrolling between captures is never mistaken for a shift and undone.
   */
  const captureAnchor = (listEl: HTMLElement) => {
    const listTop = listEl.getBoundingClientRect().top
    const { rows } = rowElements(listEl)
    for (let index = 0; index < rows.length; index++) {
      const box = rows[index].getBoundingClientRect()
      if (box.bottom <= listTop) continue
      anchor.current = { key: rendered.current.keys[rendered.current.start + index], top: box.top - listTop + listEl.scrollTop }
      return
    }
    anchor.current = null
  }

  useLayoutEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    const { rows, bottom } = rowElements(listEl)
    const tops = rows.map((row) => row.getBoundingClientRect().top)
    if (rows.length && bottom) tops.push(bottom.getBoundingClientRect().top)
    let changed = recordRowHeights(heights.current, keys, slice.start, tops)
    if (previousEstimate.current !== estimate) {
      // Compact mode changes every row, so the heights not on screen are stale.
      previousEstimate.current = estimate
      heights.current.clear()
      changed = true
    }
    if (heights.current.size > keys.length * 2 + 200) {
      const current = new Set(keys)
      for (const key of heights.current.keys()) if (!current.has(key)) heights.current.delete(key)
    }
    if (live) {
      anchor.current = null
    } else if (!anchor.current) {
      captureAnchor(listEl)
    } else {
      const index = keys.indexOf(anchor.current.key)
      if (index < 0) {
        captureAnchor(listEl)
      } else {
        // A row left the window when chat trimmed its oldest lines, so fall back to its computed spot.
        const inWindow = index >= slice.start && index < slice.end
        const top = inWindow ? rows[index - slice.start].getBoundingClientRect().top - listEl.getBoundingClientRect().top + listEl.scrollTop : offsets[index]
        const moved = top - anchor.current.top
        if (Math.abs(moved) > 0.5) {
          anchor.current.top = top
          scrollListTo(listEl, listEl.scrollTop + moved)
          setScrollTop(listEl.scrollTop)
        }
      }
    }
    if (changed) setMeasured((version) => version + 1)
  })

  useEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    const update = () => {
      setViewportHeight(listEl.clientHeight)
      setScrollTop(listEl.scrollTop)
      // A new width re-wraps every row, so the heights not on screen are stale.
      if (listWidth.current && listWidth.current !== listEl.clientWidth) {
        heights.current.clear()
        setMeasured((version) => version + 1)
      }
      listWidth.current = listEl.clientWidth
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(listEl)
    return () => observer?.disconnect()
  }, [listRef])

  const onScroll = (event: UIEvent<HTMLElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
    setViewportHeight(event.currentTarget.clientHeight)
    if (!rendered.current.live) captureAnchor(event.currentTarget)
    onScrollExtra?.(event)
  }

  return { ...slice, onScroll }
}
