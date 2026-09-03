import { useState } from 'react'
import { Dialog } from './Dialog'

/** Modal showing a message's raw transport (RFC822) headers, with copy-to-clipboard. */
export function HeadersDialog({ headers, onClose }: { headers: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

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
    <Dialog
      title="Original headers"
      onClose={onClose}
      headerExtra={
        <button
          onClick={copy}
          className="rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      }
    >
      <pre className="m-0 whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-slate-300">
        {headers}
      </pre>
    </Dialog>
  )
}
