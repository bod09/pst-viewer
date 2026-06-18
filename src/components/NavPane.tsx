import { useState } from 'react'
import { useApp, type Source } from '../store/store'
import type { FolderNode } from '../types'
import { Alert, Caret, FolderIcon, Pencil, Spinner, Trash } from './icons'

export function NavPane() {
  const sources = useApp((s) => s.sources)
  const [mailboxesOpen, setMailboxesOpen] = useState(true)

  return (
    <nav className="flex h-full min-h-0 flex-col border-r border-slate-800 bg-slate-900/40">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-slate-800 px-3">
        <img src="/icon.svg" alt="" className="h-7 w-7" />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-slate-100">PST Viewer</div>
          <div className="text-[11px] text-slate-500">Local · Offline · Private</div>
        </div>
      </div>

      <button
        onClick={() => setMailboxesOpen((o) => !o)}
        className="flex shrink-0 items-center gap-1 px-2.5 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:text-slate-200"
      >
        <Caret className={`h-3.5 w-3.5 transition-transform ${mailboxesOpen ? 'rotate-90' : ''}`} />
        Mailboxes
      </button>

      {mailboxesOpen && (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {sources.map((source) => (
            <SourceTree key={source.id} source={source} />
          ))}
        </div>
      )}
    </nav>
  )
}

function SourceTree({ source }: { source: Source }) {
  const removeSource = useApp((s) => s.removeSource)
  const renameSource = useApp((s) => s.renameSource)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(source.label)
  const isZip = source.fileName.toLowerCase().endsWith('.zip')

  const startEdit = () => {
    setDraft(source.label)
    setEditing(true)
  }
  const commit = () => {
    const v = draft.trim()
    if (v) renameSource(source.id, v)
    setEditing(false)
  }

  const pct =
    source.indexProgress && source.indexProgress.total > 0
      ? Math.min(100, Math.round((source.indexProgress.done / source.indexProgress.total) * 100))
      : 0

  return (
    <div className="mb-1.5">
      <div className="group flex items-center gap-1.5 rounded-md px-2 py-1.5">
        <span
          className={`flex h-5 shrink-0 items-center rounded px-1 text-[9px] font-bold ${
            isZip ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300'
          }`}
        >
          {isZip ? 'ZIP' : 'PST'}
        </span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="min-w-0 flex-1 rounded bg-slate-800 px-1 py-0.5 text-sm text-slate-100 outline-none ring-1 ring-sky-500"
          />
        ) : (
          <span
            className="min-w-0 flex-1 cursor-text truncate text-sm font-medium text-slate-100"
            data-tip={`${source.label} (double-click to rename)`}
            onDoubleClick={startEdit}
          >
            {source.label}
          </span>
        )}
        {source.status === 'parsing' && <Spinner className="h-3.5 w-3.5 text-sky-400" />}
        {source.status === 'error' && <Alert className="h-4 w-4 text-rose-400" />}
        {source.status === 'ready' && !editing && (
          <button
            onClick={startEdit}
            className="text-slate-600 opacity-0 transition hover:text-slate-200 group-hover:opacity-100"
            data-tip="Rename"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => removeSource(source.id)}
          className="text-slate-600 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
          data-tip="Remove mailbox"
        >
          <Trash className="h-4 w-4" />
        </button>
      </div>

      {source.status === 'parsing' && (
        <p className="px-3 pb-1 text-[11px] text-slate-500">Reading folders…</p>
      )}
      {source.status === 'error' && (
        <p className="px-3 pb-1 text-[11px] text-rose-400" data-tip={source.error}>
          {source.error || 'Could not open this file.'}
        </p>
      )}
      {source.status === 'ready' && !source.indexed && source.indexProgress && (
        <p className="px-3 pb-1 text-[11px] text-slate-500">Indexing for search… {pct}%</p>
      )}
      {source.status === 'ready' && source.index && (
        <ul>
          {source.index.rootFolder.children.map((child) => (
            <FolderRow key={child.id} sourceId={source.id} node={child} depth={0} />
          ))}
        </ul>
      )}
    </div>
  )
}

function FolderRow({
  sourceId,
  node,
  depth,
}: {
  sourceId: string
  node: FolderNode
  depth: number
}) {
  const expanded = useApp((s) => s.expanded[`${sourceId}:${node.id}`] ?? false)
  const selected = useApp(
    (s) => s.selection.sourceId === sourceId && s.selection.folderId === node.id,
  )
  const toggleFolder = useApp((s) => s.toggleFolder)
  const selectFolder = useApp((s) => s.selectFolder)
  const hasChildren = node.children.length > 0

  return (
    <li>
      <div
        onClick={() => selectFolder(sourceId, node.id)}
        className={`flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-sm transition ${
          selected ? 'bg-sky-500/15 text-sky-100' : 'text-slate-300 hover:bg-slate-800/60'
        }`}
        style={{ paddingLeft: depth * 14 + 6 }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              toggleFolder(sourceId, node.id)
            }}
            className="shrink-0 rounded p-0.5 text-slate-500 hover:text-slate-200"
          >
            <Caret className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <FolderIcon className="h-4 w-4 shrink-0 text-slate-500" />
        <span className="min-w-0 flex-1 truncate" data-tip={node.name}>
          {node.name}
        </span>
        {node.messageCount > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
            {node.messageCount}
          </span>
        )}
      </div>

      {expanded && hasChildren && (
        <ul>
          {node.children.map((child) => (
            <FolderRow key={child.id} sourceId={sourceId} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}
