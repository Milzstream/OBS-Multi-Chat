import { useEffect, useRef, useState, type RefObject, type UIEvent } from 'react'
import { Pause } from 'lucide-react'

const EDGE = 72

function atLiveEdge(el: HTMLElement, pin: 'top' | 'bottom') {
  if (pin === 'top') return el.scrollTop <= EDGE
  return el.scrollHeight - el.scrollTop - el.clientHeight <= EDGE
}

function snap(el: HTMLElement, pin: 'top' | 'bottom') {
  el.scrollTop = pin === 'top' ? 0 : el.scrollHeight
}

export function useAutoScroll(listRef: RefObject<HTMLElement | null>, pin: 'top' | 'bottom', liveKey: string | undefined) {
  const pinned = useRef(true)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const el = listRef.current
    if (!el || !pinned.current) return
    snap(el, pin)
  }, [liveKey, listRef, pin])

  const onScroll = (event: UIEvent<HTMLElement>) => {
    const el = event.currentTarget
    const live = atLiveEdge(el, pin)
    pinned.current = live
    setPaused(!live)
  }

  const resume = () => {
    const el = listRef.current
    pinned.current = true
    setPaused(false)
    if (el) snap(el, pin)
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
