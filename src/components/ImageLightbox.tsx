import { useEffect, useState } from 'react'
import { Close } from './icons'

/**
 * Full-screen image viewer. Opens fit-to-screen; click the image to toggle
 * actual size (1:1) for closer inspection, pan by scrolling. Close with the X,
 * a click on the backdrop, or Escape.
 */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-slate-800/80 p-2 text-slate-200 transition hover:bg-slate-700"
        data-tip="Close (Esc)"
      >
        <Close className="h-5 w-5" />
      </button>
      <div
        className={`flex max-h-full max-w-full ${zoomed ? 'scroll-clear' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt=""
          onClick={() => setZoomed((z) => !z)}
          className={
            zoomed
              ? 'max-w-none cursor-zoom-out'
              : 'max-h-[90vh] max-w-[94vw] cursor-zoom-in object-contain'
          }
        />
      </div>
    </div>
  )
}
