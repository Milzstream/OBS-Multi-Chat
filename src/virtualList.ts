import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react'

/**
 * Window a long list to the on-screen slice plus overscan. Spacers keep
 * scrollHeight honest so chat (pin bottom) and activity (pin top) auto-scroll
 * still see the live edge. No extra list library.
 */

export const CHAT_ROW_ESTIMATE = 56
export const CHAT_ROW_ESTIMATE_COMPACT = 44
export const ACTIVITY_ROW_ESTIMATE = 52
export const VIRTUAL_OVERSCAN = 8

export function virtualWindow(options: {
  count: number
  scrollTop: number
  viewportHeight: number
  estimate: number
  overscan?: number
  pin?: 'top' | 'bottom'
  live?: boolean
}) {
  const count = Math.max(0, options.count)
  const estimate = Math.max(1, options.estimate)
  const overscan = options.overscan ?? VIRTUAL_OVERSCAN
  const viewportHeight = Math.max(0, options.viewportHeight)
  const visible = Math.ceil(viewportHeight / estimate) + 1
  if (options.live && options.pin === 'bottom') {
    const start = Math.max(0, count - visible - overscan)
    return { start, end: count, padTop: start * estimate, padBottom: 0 }
  }
  const scrollTop = Math.max(0, options.scrollTop)
  const rawStart = Math.max(0, Math.floor(scrollTop / estimate) - overscan)
  const start = count === 0 ? 0 : Math.min(rawStart, count - 1)
  const end = Math.min(count, start + visible + overscan * 2)
  return { start, end, padTop: start * estimate, padBottom: Math.max(0, (count - end) * estimate) }
}

export function scrollTopForIndex(index: number, estimate: number) {
  return Math.max(0, index) * Math.max(1, estimate)
}

export function indexFromRows(scrollTop: number, rows: { index: number; top: number; height: number }[], fallback: number) {
  for (const row of rows) {
    if (row.top + row.height > scrollTop + 1) return row.index
  }
  return fallback
}

export function indexOnScreen(list: HTMLElement, estimate: number, fallback: number) {
  const rows = [...list.querySelectorAll<HTMLElement>('[data-row-index]')].map((row) => ({
    index: Number(row.dataset.rowIndex),
    top: row.offsetTop,
    height: row.offsetHeight,
  })).filter((row) => Number.isFinite(row.index))
  return indexFromRows(list.scrollTop, rows, fallback)
}

export function useVirtualWindow(
  listRef: RefObject<HTMLElement | null>,
  count: number,
  estimate: number,
  pin: 'top' | 'bottom',
  live: boolean,
  onScrollExtra?: (event: UIEvent<HTMLElement>) => void,
) {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(320)
  const wasLive = useRef(live)

  useLayoutEffect(() => {
    const listEl = listRef.current
    const leavingLive = wasLive.current && !live && pin === 'bottom'
    wasLive.current = live
    if (!listEl || !leavingLive) return
    const next = scrollTopForIndex(indexOnScreen(listEl, estimate, 0), estimate)
    listEl.dataset.snapping = '1'
    listEl.scrollTop = next
    setScrollTop(next)
    requestAnimationFrame(() => { delete listEl.dataset.snapping })
  }, [live, pin, estimate, listRef])

  useEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    const update = () => {
      setViewportHeight(listEl.clientHeight)
      setScrollTop(listEl.scrollTop)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(listEl)
    return () => observer?.disconnect()
  }, [listRef, count])

  const onScroll = (event: UIEvent<HTMLElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
    setViewportHeight(event.currentTarget.clientHeight)
    onScrollExtra?.(event)
  }

  return { ...virtualWindow({ count, scrollTop, viewportHeight, estimate, pin, live }), onScroll }
}
