import { useRef, useState } from 'react'
import { useApp, type Source } from '../store/store'
import type { FolderNode } from '../types'
import { ACCEPT_ATTR, filterAccepted } from '../lib/files'
import {
  Alert,
  Archive,
  Calendar,
  Caret,
  Chat,
  Drafts,
  FolderIcon,
  Inbox,
  Journal,
  Junk,
  NoteIcon,
  Outbox,
  Pencil,
  Plus,
  Send,
  Spinner,
  Tasks,
  Trash,
  Users,
} from './icons'

/** Pick a folder icon: by name for the well-known mail folders (which all share
 *  the IPF.Note class), then by container class for the item-type folders. */
function folderIcon(node: FolderNode) {
  const name = node.name.trim().toLowerCase()
  const cls = (node.containerClass || '').toLowerCase()

  if (name === 'inbox') return Inbox
  if (name === 'sent items' || name === 'sent' || name === 'sent mail') return Send
  if (name === 'deleted items' || name === 'deleted' || name === 'trash') return Trash
  if (name === 'drafts' || name === 'draft') return Drafts
  if (name === 'outbox') return Outbox
  if (name === 'junk email' || name === 'junk e-mail' || name === 'junk' || name === 'spam')
    return Junk
  if (name === 'archive') return Archive
  if (name === 'conversation history') return Chat

  if (cls.startsWith('ipf.appointment') || name === 'calendar') return Calendar
  if (cls.startsWith('ipf.contact') || name === 'contacts') return Users
  if (cls.startsWith('ipf.task') || name === 'tasks') return Tasks
  if (cls.startsWith('ipf.stickynote') || name === 'notes') return NoteIcon
  if (cls.startsWith('ipf.journal') || name === 'journal') return Journal

  return FolderIcon
}

/** Sort rank for a folder, following Outlook's canonical order: the standard
 *  mail folders first (Inbox at the top), then the user's own folders, then the
 *  calendar/contacts/tasks/notes/journal folders last. Lower sorts first. */
function folderRank(node: FolderNode): number {
  const name = node.name.trim().toLowerCase()
  const cls = (node.containerClass || '').toLowerCase()

  const byName: Record<string, number> = {
    inbox: 0,
    drafts: 1,
    draft: 1,
    'sent items': 2,
    sent: 2,
    'sent mail': 2,
    'deleted items': 3,
    deleted: 3,
    trash: 3,
    'junk email': 4,
    'junk e-mail': 4,
    junk: 4,
    spam: 4,
    outbox: 5,
    'rss feeds': 6,
    'rss subscriptions': 6,
    archive: 7,
    'conversation history': 8,
  }
  if (name in byName) return byName[name]

  if (cls.startsWith('ipf.appointment') || name === 'calendar') return 90
  if (cls.startsWith('ipf.contact') || name === 'contacts') return 91
  if (cls.startsWith('ipf.task') || name === 'tasks') return 92
  if (cls.startsWith('ipf.stickynote') || name === 'notes') return 93
  if (cls.startsWith('ipf.journal') || name === 'journal') return 94

  return 50 // the user's own folders, between the standard mail and PIM folders
}

/** Order folders by rank, breaking ties alphabetically. */
function sortFolders(nodes: FolderNode[]): FolderNode[] {
  return [...nodes].sort(
    (a, b) =>
      folderRank(a) - folderRank(b) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

export function NavPane() {
  const sources = useApp((s) => s.sources)
  const [mailboxesOpen, setMailboxesOpen] = useState(true)

  return (
    <nav className="flex h-full min-h-0 flex-col border-r border-slate-800 bg-slate-900/40">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-slate-800 px-3">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="h-7 w-7" />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-slate-100">PST Viewer</div>
          <div className="text-[11px] text-slate-400">Local · Offline · Private</div>
        </div>
      </div>

      <button
        onClick={() => setMailboxesOpen((o) => !o)}
        className="flex shrink-0 items-center gap-1 px-2.5 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:text-slate-200"
      >
        <Caret className={`h-3.5 w-3.5 transition-transform ${mailboxesOpen ? 'rotate-90' : ''}`} />
        Mailboxes
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {mailboxesOpen &&
          sources.map((source) => <SourceTree key={source.id} source={source} />)}
      </div>

      <NavAddFiles />
    </nav>
  )
}

function NavAddFiles() {
  const addFiles = useApp((s) => s.addFiles)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="shrink-0 border-t border-slate-800 p-2">
      <button
        onClick={() => input.current?.click()}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-700/60"
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
    </div>
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
            className="text-slate-400 opacity-0 transition hover:text-slate-200 group-hover:opacity-100"
            data-tip="Rename"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => removeSource(source.id)}
          className="text-slate-400 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
          data-tip="Remove mailbox"
        >
          <Trash className="h-4 w-4" />
        </button>
      </div>

      {source.status === 'parsing' && (
        <p className="px-3 pb-1 text-[11px] text-slate-400">Reading folders…</p>
      )}
      {source.status === 'error' && (
        <p className="px-3 pb-1 text-[11px] text-rose-400" data-tip={source.error}>
          {source.error || 'Could not open this file.'}
        </p>
      )}
      {source.status === 'ready' && !source.indexed && source.indexProgress && (
        <p className="px-3 pb-1 text-[11px] text-slate-400">Indexing for search… {pct}%</p>
      )}
      {source.status === 'ready' &&
        source.indexed &&
        !source.ocrDone &&
        source.ocrProgress &&
        source.ocrProgress.total > 0 && (
          <p className="px-3 pb-1 text-[11px] text-slate-400">
            Reading images… {source.ocrProgress.done}/{source.ocrProgress.total}
          </p>
        )}
      {source.status === 'ready' && source.index && (
        <ul className="ml-3 space-y-px border-l border-slate-700/60 pl-2">
          {sortFolders(source.index.rootFolder.children).map((child) => (
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
  const Icon = folderIcon(node)

  return (
    <li>
      <div
        onClick={() => selectFolder(sourceId, node.id)}
        className={`flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-sm transition ${
          selected
            ? 'bg-sky-500/15 font-medium text-sky-100'
            : 'text-slate-300 hover:bg-slate-800/60'
        }`}
        style={{ paddingLeft: depth * 14 + 2 }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              toggleFolder(sourceId, node.id)
            }}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-200"
          >
            <Caret className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <Icon className={`h-4 w-4 shrink-0 ${selected ? 'text-sky-300' : 'text-slate-400'}`} />
        <span className="min-w-0 flex-1 truncate" data-tip={node.name}>
          {node.name}
        </span>
        {node.messageCount > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
            {node.messageCount}
          </span>
        )}
      </div>

      {expanded && hasChildren && (
        <ul>
          {sortFolders(node.children).map((child) => (
            <FolderRow key={child.id} sourceId={sourceId} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}
