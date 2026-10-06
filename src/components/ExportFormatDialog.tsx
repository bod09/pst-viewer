import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Dialog } from './Dialog'
import type { ExportFormat } from '../lib/bulkExport'

/**
 * The choice of format for a folder's export, opened from the folder's export
 * button or with E. A small dialog, so it closes like every other popup: the
 * X in the header, Escape or a click outside. Focus starts on the first
 * choice; Tab and the arrow keys move between the two, and Enter picks one.
 *
 * Rendered into the document body, so that a role="dialog" never sits inside
 * the folder list's role="tree" in the DOM.
 */
export function ExportFormatDialog({
  folderName,
  hasSubfolders,
  onChoose,
  onClose,
}: {
  folderName: string
  hasSubfolders: boolean
  onChoose: (format: ExportFormat) => void
  onClose: () => void
}) {
  const first = useRef<HTMLButtonElement>(null)
  const promptId = useId()

  // React runs the Dialog's effect (which focuses its panel) before this one,
  // so the first choice takes focus last.
  useEffect(() => {
    first.current?.focus()
  }, [])

  const onArrow = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const choices = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const at = choices.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    choices[(at + step + choices.length) % choices.length].focus()
  }

  const choice =
    'w-full rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-left text-sm font-medium text-slate-200 transition hover:bg-slate-700/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500'

  return createPortal(
    <Dialog title={`Export ${folderName}`} onClose={onClose} size="sm">
      <div className="space-y-3 p-4">
        <p id={promptId} className="text-xs leading-relaxed text-slate-400">
          {hasSubfolders
            ? 'Save this folder and its subfolders as:'
            : 'Save this folder as:'}
        </p>
        <div role="group" aria-labelledby={promptId} className="space-y-2" onKeyDown={onArrow}>
          <button ref={first} className={choice} onClick={() => onChoose('eml')}>
            .eml files, one per message
          </button>
          <button className={choice} onClick={() => onChoose('mbox')}>
            {hasSubfolders ? '.mbox files, one per folder' : 'An .mbox file'}
          </button>
        </div>
      </div>
    </Dialog>,
    document.body,
  )
}
