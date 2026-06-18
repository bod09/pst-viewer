import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store/store'
import { DropZone } from './DropZone'
import { NavPane } from './NavPane'
import { MessageList } from './MessageList'
import { ReaderPane } from './ReaderPane'
import { SearchBar } from './SearchBar'
import { SearchResults } from './SearchResults'
import { Resizer } from './Resizer'
import { ACCEPT_ATTR, dragHasFiles, filterAccepted } from '../lib/files'
import { Plus, Printer, Search, Spinner } from './icons'

export function AppShell() {
  const sources = useApp((s) => s.sources)
  const addFiles = useApp((s) => s.addFiles)
  const isSearching = useApp((s) => s.searchQuery.trim().length > 0)
  const navWidth = useApp((s) => s.navWidth)
  const listWidth = useApp((s) => s.listWidth)
  const setNavWidth = useApp((s) => s.setNavWidth)
  const setListWidth = useApp((s) => s.setListWidth)
  const [dragging, setDragging] = useState(false)

  // Global drag & drop: dropping anywhere on the window adds files.
  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      depth++
      setDragging(true)
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onOver = (e: DragEvent) => {
      if (dragHasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer?.files?.length) {
        const accepted = filterAccepted(e.dataTransfer.files)
        if (accepted.length) addFiles(accepted)
      }
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [addFiles])

  return (
    <div className="relative h-full bg-slate-950 text-slate-200">
      {sources.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex h-full min-h-0">
          <div style={{ width: navWidth }} className="h-full min-h-0 shrink-0">
            <NavPane />
          </div>
          <Resizer width={navWidth} min={200} max={520} onResize={setNavWidth} />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ContentHeader />
            <ExportBar />
            <div className="flex min-h-0 flex-1">
              <div style={{ width: listWidth }} className="h-full min-h-0 shrink-0">
                {isSearching ? <SearchResults /> : <MessageList />}
              </div>
              <Resizer width={listWidth} min={280} max={680} onResize={setListWidth} />
              <div className="min-h-0 min-w-0 flex-1">
                <ReaderPane />
              </div>
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-sky-500/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-sky-400 bg-slate-900/80 px-10 py-8 text-lg font-medium text-sky-200">
            Drop to add PST / OST / ZIP files
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="relative h-full">
      <div className="absolute left-4 top-3 z-10 flex items-center gap-2.5">
        <img src="/icon.svg" alt="" className="h-7 w-7" />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-slate-100">PST Viewer</div>
          <div className="text-[11px] text-slate-500">Local · Offline · Private</div>
        </div>
      </div>
      <DropZone />
    </div>
  )
}

function ContentHeader() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-slate-800 bg-slate-900/60 px-4">
      <div className="w-full max-w-md">
        <SearchBar />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <OcrButton />
        <AddFilesButton />
      </div>
    </header>
  )
}

function ExportBar() {
  const count = useApp((s) => Object.keys(s.exportSel).length)
  const exporting = useApp((s) => s.exporting)
  const exportSelected = useApp((s) => s.exportSelected)
  const clearExport = useApp((s) => s.clearExport)
  if (count === 0) return null

  const btn =
    'flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-white transition disabled:opacity-60'

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm">
      <span className="text-sky-100">
        <span className="font-semibold">{count}</span> message{count === 1 ? '' : 's'} selected
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={clearExport}
          className="rounded-md px-3 py-1.5 text-slate-300 transition hover:bg-slate-800/60"
        >
          Clear
        </button>
        {count === 1 ? (
          <button
            onClick={() => exportSelected('asc')}
            disabled={exporting}
            className={`${btn} bg-sky-500 hover:bg-sky-400`}
          >
            {exporting ? <Spinner className="h-4 w-4" /> : <Printer className="h-4 w-4" />}
            Save as PDF
          </button>
        ) : (
          <>
            <button
              onClick={() => exportSelected('asc')}
              disabled={exporting}
              className={`${btn} bg-sky-500 hover:bg-sky-400`}
              data-tip="Merge with the oldest email first"
            >
              {exporting ? <Spinner className="h-4 w-4" /> : <Printer className="h-4 w-4" />}
              Merge ↑ oldest first
            </button>
            <button
              onClick={() => exportSelected('desc')}
              disabled={exporting}
              className={`${btn} bg-sky-500 hover:bg-sky-400`}
              data-tip="Merge with the newest email first"
            >
              {exporting ? <Spinner className="h-4 w-4" /> : <Printer className="h-4 w-4" />}
              Merge ↓ newest first
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function OcrButton() {
  const state = useApp((s) => s.ocrState)
  const progress = useApp((s) => s.ocrProgress)
  const enableOcr = useApp((s) => s.enableOcr)

  if (state === 'running') {
    return (
      <span className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-sm text-slate-300">
        <Spinner className="h-4 w-4 text-sky-400" />
        OCR {progress.total ? `${progress.done}/${progress.total}` : '…'}
      </span>
    )
  }
  if (state === 'done') {
    return (
      <span
        className="flex items-center gap-1.5 rounded-lg border border-emerald-600/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300"
        data-tip="Text inside images is now searchable"
      >
        ✓ Images searchable
      </span>
    )
  }
  return (
    <button
      onClick={enableOcr}
      data-tip="Recognize text inside image attachments so it becomes searchable"
      className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-sm font-medium text-slate-200 transition hover:bg-slate-700/60"
    >
      <Search className="h-4 w-4" />
      {state === 'error' ? 'Retry image OCR' : 'Search images'}
    </button>
  )
}

function AddFilesButton() {
  const addFiles = useApp((s) => s.addFiles)
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        onClick={() => input.current?.click()}
        className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-sm font-medium text-slate-200 transition hover:bg-slate-700/60"
      >
        <Plus className="h-4 w-4" />
        Add files
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        hidden
        onChange={(e) => {
          const accepted = filterAccepted(e.target.files ?? [])
          if (accepted.length) addFiles(accepted)
          e.target.value = ''
        }}
      />
    </>
  )
}
