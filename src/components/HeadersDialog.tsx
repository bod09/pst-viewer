import { useEffect, useState } from 'react'
import { Close } from './icons'

/** Modal showing a message's raw transport (RFC822) headers, with copy-to-clipboard. */
export function HeadersDialog({ headers, onClose }: { headers: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(headers)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable; the text is still selectable */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">Original headers</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={copy}
              className="rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100"
              data-tip="Close (Esc)"
            >
              <Close className="h-5 w-5" />
            </button>
          </div>
        </div>
        <pre className="scroll-clear m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-slate-300">
          {headers}
        </pre>
      </div>
    </div>
  )
}
