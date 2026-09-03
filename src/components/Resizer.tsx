import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/** A vertical drag handle that resizes the panel to its left. */
export function Resizer({
  width,
  min,
  max,
  onResize,
}: {
  width: number
  min: number
  max: number
  onResize: (w: number) => void
}) {
  const start = useRef({ x: 0, w: 0 })
  const [dragging, setDragging] = useState(false)
  // Read inside the listeners without re-subscribing on every resize.
  const latest = useRef({ min, max, onResize })
  latest.current = { min, max, onResize }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    start.current = { x: e.clientX, w: width }
    setDragging(true)
  }

  // Tied to the dragging state so unmounting mid-drag (or a cancelled pointer)
  // still restores the cursor and drops the listeners. Otherwise the whole app
  // keeps a resize cursor and unselectable text for the rest of the session.
  useEffect(() => {
    if (!dragging) return
    const move = (ev: PointerEvent) => {
      const { min: lo, max: hi, onResize: cb } = latest.current
      cb(Math.min(hi, Math.max(lo, start.current.w + (ev.clientX - start.current.x))))
    }
    const stop = () => setDragging(false)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging])

  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-slate-800 transition-colors hover:bg-sky-500/60"
    >
      {/* Wider invisible hit area for easier grabbing. */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
    </div>
  )
}
