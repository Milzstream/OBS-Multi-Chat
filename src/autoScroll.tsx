import { useEffect, useRef, useState, type RefObject, type UIEvent } from 'react'
import { Pause } from 'lucide-react'

/**
 * Scroll container for the docks: keeps the list glued to its live edge (the
 * bottom for chat, the top for activity) while the user has not scrolled away
 * from it, and pauses/resumes auto-scroll when they do.
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
  listEl.scrollTop = pin === 'top' ? 0 : listEl.scrollHeight
}

export function nextPinState(atEdge: boolean, snapping: boolean, wasPinned: boolean) {
  if (snapping) return wasPinned
  return atEdge
}

export function useAutoScroll(listRef: RefObject<HTMLElement | null>, pin: 'top' | 'bottom', liveKey: string | undefined) {
  // pinned starts true so the list begins glued to the live edge; any user
  // scroll away from that edge unpins it and pauses auto-scroll
  const pinned = useRef(true)
  const [paused, setPaused] = useState(false)

  const markSnap = (listEl: HTMLElement) => {
    listEl.dataset.snapping = '1'
    snap(listEl, pin)
    requestAnimationFrame(() => { delete listEl.dataset.snapping })
  }

  useEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    let cancelled = false
    const snapIfPinned = () => {
      if (cancelled || !pinned.current) return
      markSnap(listEl)
    }
    snapIfPinned()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(snapIfPinned)
    observer?.observe(listEl)
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts
    void fonts?.ready.then(snapIfPinned).catch(() => undefined)
    return () => { cancelled = true; observer?.disconnect() }
  }, [liveKey, listRef, pin])

  const onScroll = (event: UIEvent<HTMLElement>) => {
    const listEl = event.currentTarget
    const snapping = listEl.dataset.snapping === '1'
    const live = nextPinState(atLiveEdge(listEl, pin), snapping, pinned.current)
    pinned.current = live
    setPaused(!live)
  }

  const resume = () => {
    const listEl = listRef.current
    pinned.current = true
    setPaused(false)
    if (listEl) markSnap(listEl)
  }

  return { paused, onScroll, resume }
}

export function ScrollPausedBadge({ onResume }: { onResume: () => void }) {
  return (
    <button type="button" className="scroll-paused" onClick={onResume}>
      <Pause size={12} fill="currentColor" />
      AUTO SCROLL PAUSED
    </button>
  )
}