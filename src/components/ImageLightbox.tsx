import { useEffect, useRef, useState } from 'react'
import { Close } from './icons'

/**
 * Full-screen image viewer. Opens fit-to-screen; click the image to zoom in
 * (enlarged so small text is readable, even for images smaller than the screen).
 * When zoomed, drag the image to pan (or use the scrollbars); click it again to
 * fit. Close with the X, the backdrop, or Escape.
 */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false)
  const [natural, setNatural] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Drag-to-pan bookkeeping in a ref so panning does not re-render on every move.
  const drag = useRef({ active: false, startX: 0, startY: 0, left: 0, top: 0, moved: 0 })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    drag.current.moved = 0
    // Mouse/pen drag pans the overflow; touch keeps its native swipe-to-scroll.
    if (!zoomed || e.pointerType === 'touch') return
    const sc = scrollRef.current
    if (!sc) return
    drag.current.active = true
    drag.current.startX = e.clientX
    drag.current.startY = e.clientY
    drag.current.left = sc.scrollLeft
    drag.current.top = sc.scrollTop
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is best-effort; panning still works while the pointer is over the image */
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = drag.current
    if (!d.active) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy))
    const sc = scrollRef.current
    if (sc) {
      sc.scrollLeft = d.left - dx
      sc.scrollTop = d.top - dy
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!drag.current.active) return
    drag.current.active = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onImgClick = (e: React.MouseEvent) => {
    e.stopPropagation() // an image click must never close the lightbox
    // A click toggles zoom; a drag (the pointer travelled) only pans.
    if (drag.current.moved < 6) setZoomed((z) => !z)
  }

  return (
    <div
      ref={scrollRef}
      className="fixed inset-0 z-50 overflow-auto bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="fixed right-4 top-4 z-10 rounded-full bg-slate-800/80 p-2 text-slate-200 transition hover:bg-slate-700"
        data-tip="Close (Esc)"
      >
        <Close className="h-5 w-5" />
      </button>
      <div className="flex min-h-full w-max min-w-full items-center justify-center p-4">
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
          onClick={onImgClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className={
            zoomed
              ? 'h-auto max-w-none cursor-grab select-none active:cursor-grabbing'
              : 'max-h-[88vh] max-w-[92vw] cursor-zoom-in select-none object-contain'
          }
          // Zoom to at least 1.6x the screen width so it always visibly enlarges,
          // and to the image's full resolution when that is larger.
          style={zoomed ? { width: `max(${natural || 0}px, 160vw)` } : undefined}
        />
      </div>
    </div>
  )
}
