import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    start.current = { x: e.clientX, w: width }
    const move = (ev: PointerEvent) => {
      onResize(Math.min(max, Math.max(min, start.current.w + (ev.clientX - start.current.x))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

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
