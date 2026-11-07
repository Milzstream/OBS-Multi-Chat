import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react'
import { Pause } from 'lucide-react'
import { consumeCodeScroll, scrollListTo } from './virtualList'

/**
 * Scroll container for the docks: keeps the list glued to its live edge (the
 * bottom for chat, the top for activity) while the user has not left it, and
 * pauses auto-scroll once they do.
 *
 * A leave-edge gesture stops the snap immediately so fast chat cannot yank the
 * list back, then follows again if that gesture never left the edge.
 */

const EDGE = 72
const HOLD_MS = 160

function edgeGap(listEl: HTMLElement, pin: 'top' | 'bottom') {
  if (pin === 'top') return listEl.scrollTop
  return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight
}

/**
 * True when the scroll container is within `EDGE` px of its live edge — the
 * bottom for chat (new messages) or the top for activity (newest rows).
 */
function atLiveEdge(listEl: HTMLElement, pin: 'top' | 'bottom') {
  return edgeGap(listEl, pin) <= EDGE
}

function snap(listEl: HTMLElement, pin: 'top' | 'bottom') {
  scrollListTo(listEl, pin === 'top' ? 0 : listEl.scrollHeight)
}

/** Code scrolls keep the previous pin. A clamp still on the edge stays pinned. Heading away after an unpin does not re-pin. */
export function nextPinState(atEdge: boolean, codeScroll: boolean, wasPinned: boolean, movedAway = false) {
  if (codeScroll) return wasPinned
  if (atEdge && wasPinned) return true
  if (movedAway) return false
  return atEdge
}

export function movedAwayFromEdge(pin: 'top' | 'bottom', previousTop: number, top: number) {
  return pin === 'top' ? top > previousTop + 1 : top < previousTop - 1
}

/** True when the gesture itself moved farther than the edge zone, ignoring content that grew underneath. */
export function scrolledPastEdge(pin: 'top' | 'bottom', startTop: number, top: number) {
  return pin === 'top' ? top > startTop + EDGE : top < startTop - EDGE
}

/** Follow again when the viewport is still on the edge, or the gesture never scrolled past it. */
export function holdSettlesPinned(atEdge: boolean, pastEdge: boolean) {
  return atEdge || !pastEdge
}

/** True when this much scrolling (wheel `deltaY`, or a drag's opposite) heads away from the live edge. */
export function scrollLeavesEdge(pin: 'top' | 'bottom', deltaY: number) {
  return pin === 'top' ? deltaY > 0 : deltaY < 0
}

export function keyLeavesEdge(pin: 'top' | 'bottom', key: string) {
  return (pin === 'top' ? ['ArrowDown', 'PageDown', 'End'] : ['ArrowUp', 'PageUp', 'Home']).includes(key)
}

export function useAutoScroll(listRef: RefObject<HTMLElement | null>, pin: 'top' | 'bottom') {
  // pinned starts true so the list begins glued to the live edge. A leave-edge
  // gesture unpins immediately; the badge waits until the user has actually left.
  const pinned = useRef(true)
  const holding = useRef(false)
  const pointerHolding = useRef(false)
  const holdTimer = useRef(0)
  const gestureStart = useRef(0)
  const lastTop = useRef(0)
  const lastGap = useRef(0)
  const beginHoldRef = useRef<(startTop?: number) => boolean>(() => false)
  const [paused, setPaused] = useState(false)
  const [following, setFollowing] = useState(true)

  // Every commit, not only on a new row: measuring a row can grow the list too.
  useLayoutEffect(() => {
    const listEl = listRef.current
    if (listEl && pinned.current && !holding.current) snap(listEl, pin)
  })

  useEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    let cancelled = false
    const snapIfPinned = () => {
      if (!cancelled && pinned.current && !holding.current) snap(listEl, pin)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(snapIfPinned)
    observer?.observe(listEl)
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts
    void fonts?.ready.then(snapIfPinned).catch(() => undefined)

    const releaseHold = () => {
      if (cancelled || pointerHolding.current) return
      holding.current = false
      const pastEdge = scrolledPastEdge(pin, gestureStart.current, listEl.scrollTop)
      if (holdSettlesPinned(atLiveEdge(listEl, pin), pastEdge)) {
        pinned.current = true
        setPaused(false)
        setFollowing(true)
        snap(listEl, pin)
      } else {
        pinned.current = false
        setPaused(true)
        setFollowing(false)
      }
    }
    const scheduleRelease = () => {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = window.setTimeout(releaseHold, HOLD_MS)
    }
    // startTop is the position before a scroll event. Input that has not scrolled yet omits it.
    const beginHold = (startTop?: number) => {
      if (cancelled || listEl.scrollHeight <= listEl.clientHeight + 1) return false
      if (!pinned.current && !holding.current) return false
      if (!holding.current) {
        gestureStart.current = startTop ?? listEl.scrollTop
        holding.current = true
        pinned.current = false
        setFollowing(false)
        if (startTop === undefined) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (cancelled || !holding.current) return
              if (Math.abs(listEl.scrollTop - gestureStart.current) <= 1 && atLiveEdge(listEl, pin)) {
                window.clearTimeout(holdTimer.current)
                holding.current = false
                pinned.current = true
                setPaused(false)
                setFollowing(true)
              }
            })
          })
        }
      }
      scheduleRelease()
      return true
    }
    beginHoldRef.current = beginHold

    const onWheel = (event: WheelEvent) => {
      if (scrollLeavesEdge(pin, event.deltaY)) beginHold()
    }
    let touchY = 0
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0 }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY
      if (scrollLeavesEdge(pin, touchY - y)) beginHold()
      touchY = y
    }
    const onTouchEnd = () => {
      if (holding.current) scheduleRelease()
    }
    // The scrollbar reports the list itself as the target, past its client width.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === listEl && event.offsetX >= listEl.clientWidth && beginHold()) pointerHolding.current = true
    }
    const endPointer = () => {
      if (!pointerHolding.current) return
      pointerHolding.current = false
      scheduleRelease()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyLeavesEdge(pin, event.key)) beginHold()
    }
    listEl.addEventListener('wheel', onWheel, { passive: true })
    listEl.addEventListener('touchstart', onTouchStart, { passive: true })
    listEl.addEventListener('touchmove', onTouchMove, { passive: true })
    listEl.addEventListener('touchend', onTouchEnd)
    listEl.addEventListener('touchcancel', onTouchEnd)
    listEl.addEventListener('pointerdown', onPointerDown)
    listEl.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerup', endPointer)
    window.addEventListener('pointercancel', endPointer)
    return () => {
      cancelled = true
      window.clearTimeout(holdTimer.current)
      holding.current = false
      pointerHolding.current = false
      beginHoldRef.current = () => false
      observer?.disconnect()
      listEl.removeEventListener('wheel', onWheel)
      listEl.removeEventListener('touchstart', onTouchStart)
      listEl.removeEventListener('touchmove', onTouchMove)
      listEl.removeEventListener('touchend', onTouchEnd)
      listEl.removeEventListener('touchcancel', onTouchEnd)
      listEl.removeEventListener('pointerdown', onPointerDown)
      listEl.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerup', endPointer)
      window.removeEventListener('pointercancel', endPointer)
    }
  }, [listRef, pin])

  const onScroll = (event: UIEvent<HTMLElement>) => {
    const listEl = event.currentTarget
    const codeScroll = consumeCodeScroll(listEl)
    const previous = lastTop.current
    const movedAway = !codeScroll && movedAwayFromEdge(pin, previous, listEl.scrollTop)
    if (codeScroll && holding.current) gestureStart.current += listEl.scrollTop - previous
    lastTop.current = listEl.scrollTop
    const gap = edgeGap(listEl, pin)
    const gapGrew = gap > lastGap.current + 1
    lastGap.current = gap
    if (codeScroll) return
    if (!holding.current && movedAway && pinned.current && gapGrew) beginHoldRef.current(previous)
    if (holding.current) {
      if (scrolledPastEdge(pin, gestureStart.current, listEl.scrollTop) && !atLiveEdge(listEl, pin)) {
        pinned.current = false
        setPaused(true)
        setFollowing(false)
      }
      return
    }
    const live = nextPinState(atLiveEdge(listEl, pin), false, pinned.current, movedAway)
    pinned.current = live
    setPaused(!live)
    setFollowing(live)
  }

  const resume = () => {
    window.clearTimeout(holdTimer.current)
    pointerHolding.current = false
    holding.current = false
    pinned.current = true
    setPaused(false)
    setFollowing(true)
    const listEl = listRef.current
    if (listEl) snap(listEl, pin)
  }

  return { paused, following, onScroll, resume }
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
