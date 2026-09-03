import { useEffect, type ReactNode } from 'react'
import { Close } from './icons'

/**
 * The one popup style for the whole app (modeled on the attachment preview):
 * dim backdrop, rounded slate panel with a titled header row and a square
 * close button. Surfaces use the theme tokens, so runtime branding applies.
 */
export function Dialog({
  title,
  onClose,
  children,
  size = 'md',
  headerExtra,
  fillHeight = false,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  /** Panel width: sm (settings-like), md (documents), lg (attachment-like). */
  size?: 'sm' | 'md' | 'lg'
  /** Extra controls rendered before the close button. */
  headerExtra?: ReactNode
  /** Stretch to the full available height (viewer-style dialogs). */
  fillHeight?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const width = size === 'sm' ? 'max-w-lg' : size === 'md' ? 'max-w-3xl' : 'max-w-4xl'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className={`flex ${fillHeight ? 'h-full' : ''} max-h-[88vh] w-full ${width} flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
          <span className="min-w-0 truncate text-sm font-medium text-slate-200">{title}</span>
          <div className="flex shrink-0 items-center gap-2">
            {headerExtra}
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            >
              <Close className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="scroll-clear min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  )
}
