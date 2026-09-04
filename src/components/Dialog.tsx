import { useEffect, useRef, type ReactNode } from 'react'
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
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Only the innermost dialog closes, so one press does not dismiss a
        // preview and the lightbox opened on top of it together.
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Move focus into the dialog and put it back where it was on close, and keep
  // Tab inside while it is open.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onTab)
    return () => {
      window.removeEventListener('keydown', onTab)
      previous?.focus?.()
    }
  }, [])

  const width = size === 'sm' ? 'max-w-lg' : size === 'md' ? 'max-w-3xl' : 'max-w-4xl'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        className={`flex ${fillHeight ? 'h-full' : ''} max-h-[88vh] w-full ${width} flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl focus:outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
          <span className="min-w-0 truncate text-sm font-medium text-slate-200">{title}</span>
          <div className="flex shrink-0 items-center gap-2">
            {headerExtra}
            <button
              onClick={onClose}
              aria-label="Close"
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
