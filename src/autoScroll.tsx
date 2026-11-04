import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react'
import { Pause } from 'lucide-react'
import { consumeCodeScroll, scrollListTo } from './virtualList'

/**
 * Scroll container for the docks: keeps the list glued to its live edge (the
 * bottom for chat, the top for activity) while the user has not scrolled away
 * from it, and pauses/resumes auto-scroll when they do.
 *
 * Scrolling away pauses on the input itself. In fast chat the next message would
 * otherwise snap the list back before it ever got far from the edge.
 */

const EDGE = 72

/**
 * True when the scroll container is within `EDGE` px of its live edge — the
 * bottom for chat (new messages) or the top for activity (newest rows).
 */
function atLiveEdge(listEl: HTMLElement, pin: 'top' | 'bottom') {
  if (pin === 'top') return listEl.scrollTop <= EDGE
  return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight <= EDGE
}

function snap(listEl: HTMLElement, pin: 'top' | 'bottom') {
  scrollListTo(listEl, pin === 'top' ? 0 : listEl.scrollHeight)
}

export function nextPinState(atEdge: boolean, codeScroll: boolean, wasPinned: boolean, movedAway = false) {
  if (codeScroll) return wasPinned
  if (movedAway) return false
  return atEdge
}

export function movedAwayFromEdge(pin: 'top' | 'bottom', previousTop: number, top: number) {
  return pin === 'top' ? top > previousTop + 1 : top < previousTop - 1
}

/** True when this much scrolling (wheel `deltaY`, or a drag's opposite) heads away from the live edge. */
export function scrollLeavesEdge(pin: 'top' | 'bottom', deltaY: number) {
  return pin === 'top' ? deltaY > 0 : deltaY < 0
}

export function keyLeavesEdge(pin: 'top' | 'bottom', key: string) {
  return (pin === 'top' ? ['ArrowDown', 'PageDown', 'End'] : ['ArrowUp', 'PageUp', 'Home']).includes(key)
}

export function useAutoScroll(listRef: RefObject<HTMLElement | null>, pin: 'top' | 'bottom') {
  // pinned starts true so the list begins glued to the live edge; any user
  // scroll away from that edge unpins it and pauses auto-scroll
  const pinned = useRef(true)
  const lastTop = useRef(0)
  const [paused, setPaused] = useState(false)

  // Every commit, not only on a new row: measuring a row can grow the list too.
  useLayoutEffect(() => {
    const listEl = listRef.current
    if (listEl && pinned.current) snap(listEl, pin)
  })

  useEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    let cancelled = false
    const snapIfPinned = () => {
      if (!cancelled && pinned.current) snap(listEl, pin)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(snapIfPinned)
    observer?.observe(listEl)
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts
    void fonts?.ready.then(snapIfPinned).catch(() => undefined)

    const leaveEdge = () => {
      if (!pinned.current || listEl.scrollHeight <= listEl.clientHeight + 1) return
      pinned.current = false
      setPaused(true)
    }
    const onWheel = (event: WheelEvent) => {
      if (scrollLeavesEdge(pin, event.deltaY)) leaveEdge()
    }
    let touchY = 0
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0 }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY
      if (scrollLeavesEdge(pin, touchY - y)) leaveEdge()
      touchY = y
    }
    // The scrollbar reports the list itself as the target, past its client width.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === listEl && event.offsetX >= listEl.clientWidth) leaveEdge()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyLeavesEdge(pin, event.key)) leaveEdge()
    }
    listEl.addEventListener('wheel', onWheel, { passive: true })
    listEl.addEventListener('touchstart', onTouchStart, { passive: true })
    listEl.addEventListener('touchmove', onTouchMove, { passive: true })
    listEl.addEventListener('pointerdown', onPointerDown)
    listEl.addEventListener('keydown', onKeyDown)
    return () => {
      cancelled = true
      observer?.disconnect()
      listEl.removeEventListener('wheel', onWheel)
      listEl.removeEventListener('touchstart', onTouchStart)
      listEl.removeEventListener('touchmove', onTouchMove)
      listEl.removeEventListener('pointerdown', onPointerDown)
      listEl.removeEventListener('keydown', onKeyDown)
    }
  }, [listRef, pin])

  const onScroll = (event: UIEvent<HTMLElement>) => {
    const listEl = event.currentTarget
    const codeScroll = consumeCodeScroll(listEl)
    const movedAway = !codeScroll && movedAwayFromEdge(pin, lastTop.current, listEl.scrollTop)
    lastTop.current = listEl.scrollTop
    const live = nextPinState(atLiveEdge(listEl, pin), codeScroll, pinned.current, movedAway)
    pinned.current = live
    setPaused(!live)
  }

  const resume = () => {
    const listEl = listRef.current
    pinned.current = true
    setPaused(false)
    if (listEl) snap(listEl, pin)
  }

  return { paused, onScroll, resume }
}

export function ScrollPausedBadge({ onResume }: { onResume: () => void }) {
  return (
    // The badge floats over the list without being inside it, so pass the wheel along or scrolling stops under the cursor.
    <button type="button" className="scroll-paused" onClick={onResume} onWheel={(event) => event.currentTarget.previousElementSibling?.scrollBy(0, event.deltaY)}>
      <Pause size={12} fill="currentColor" />
      AUTO SCROLL PAUSED
    </button>
  )
}
