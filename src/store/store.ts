import { create } from 'zustand'
import * as Comlink from 'comlink'
import { pst } from '../worker/client'
import { scanZipForPsts } from '../lib/zip'
import { buildPrintDocument, printHtmlDocument } from '../lib/printExport'
import { downloadBlob, emlFilename } from '../lib/emlExport'
import {
  canExportToFolder,
  createFreshDirectory,
  describeError,
  EmlTreeWriter,
  ExportDirectory,
  pickExportFolder,
} from '../lib/bulkExport'
import { getCachedOcr, putCachedOcr, hashImageBytes } from '../lib/ocrCache'
import { clearCachedImages } from '../lib/imageCache'
import type { Worker as OcrWorker } from 'tesseract.js'
import type {
  EmlExportStep,
  FolderNode,
  MessageContent,
  MessageMeta,
  OcrTarget,
  SearchHit,
  SourceIndex,
} from '../types'

export type SourceStatus = 'parsing' | 'ready' | 'error'

export interface Source {
  id: string
  fileName: string
  size: number
  label: string
  status: SourceStatus
  error?: string
  /** Raw low-level parser error behind a friendly `error`, shown on hover. */
  errorDetail?: string
  index?: SourceIndex
  indexProgress?: { done: number; total: number }
  indexed?: boolean
  /** Indexing stopped early; search may not cover the whole mailbox. */
  indexFailed?: boolean
  ocrProgress?: { done: number; total: number }
  ocrDone?: boolean
}

/**
 * An export of many messages to .eml files in a folder on disk: what it is
 * doing now, and once it ends, what it did.
 */
export interface EmlExportJob {
  /** What is being exported, for the dialog title. */
  title: string
  /** `unsupported`: this browser cannot write to a folder, so nothing started. */
  status: 'running' | 'done' | 'cancelled' | 'failed' | 'unsupported'
  /** The directory created for this export inside the one the user picked. */
  directory: string
  /** Messages to go, as the folders declare them. */
  total: number
  exported: number
  /** Messages that could not be read and were left out. */
  skipped: number
  /** Messages that were read but could not be saved (a name or path refused), and were left out. */
  unsaved: number
  /** Why messages could not be saved, with how many each. */
  reasons: { reason: string; count: number }[]
  folders: number
  foldersDone: number
  /** The folder being read now. */
  current: string
  /** Why a failed export stopped. */
  error?: string
}

interface Selection {
  sourceId: string | null
  folderId: string | null
  messageId: string | null
}

interface AppState {
  sources: Source[]
  selection: Selection
  messages: MessageMeta[]
  /** Count of messages in the open folder that could not be read (file damage). */
  messagesUnreadable: number
  messagesLoading: boolean
  messageContent: MessageContent | null
  contentLoading: boolean
  expanded: Record<string, boolean>
  /** Folder key expanded only because it was selected while collapsed; it
   *  re-collapses when the selection leaves its subtree. */
  autoExpanded: string | null

  searchQuery: string
  searchResults: SearchHit[]
  searching: boolean

  /** Messages picked for export (PDF or .eml), keyed `${sourceId}:${messageId}`. */
  exportSel: Record<string, { sourceId: string; messageId: string }>
  exporting: boolean
  /** The current or last export to a folder of .eml files, while its dialog is open. */
  emlExport: EmlExportJob | null

  /** Persisted panel widths (px). */
  navWidth: number
  listWidth: number
  setNavWidth: (w: number) => void
  setListWidth: (w: number) => void
  /** Persisted preference: read text inside images (OCR) to make it searchable. */
  ocrEnabled: boolean
  setOcrEnabled: (v: boolean) => void
  /** Persisted preference: show folders that contain no messages. */
  showEmptyFolders: boolean
  setShowEmptyFolders: (v: boolean) => void
  /** Persisted preference: let messages load images from the internet. */
  allowRemoteContent: boolean
  setAllowRemoteContent: (v: boolean) => void
  addFiles: (files: File[]) => void
  removeSource: (id: string) => void
  clearSources: () => void
  renameSource: (id: string, label: string) => void
  toggleFolder: (sourceId: string, folderId: string) => void
  selectFolder: (sourceId: string, folderId: string) => Promise<void>
  selectMessage: (messageId: string | null) => void
  /** Try the open message again after it failed to load. */
  retryMessage: () => void

  setSearchQuery: (q: string) => void
  runSearch: () => void
  clearSearch: () => void
  openHit: (hit: SearchHit) => void

  toggleExport: (sourceId: string, messageId: string) => void
  clearExport: () => void
  exportSelected: (direction?: 'asc' | 'desc') => void
  exportSingle: (sourceId: string, messageId: string) => void
  exportEml: (sourceId: string, messageId: string) => void
  /** Export a folder and its subfolders, or with no folder the whole mailbox, as .eml files. */
  exportFolderEml: (sourceId: string, folderId?: string) => void
  /** Export the messages picked in the selection bar as .eml files. */
  exportSelectedEml: () => void
  cancelEmlExport: () => void
  closeEmlExport: () => void
}

/**
 * Remembers only that *a* mailbox was open in this tab, so that if the browser
 * reloads the page (it discards tabs to reclaim memory) the empty screen can
 * explain itself rather than look like lost work. Deliberately just a flag:
 * recording which files someone opened would leave exactly the trace this
 * tool exists to avoid. Per-tab, and gone when the tab closes.
 */
const HAD_MAILBOX_KEY = 'pstviewer.hadMailbox'

export function noteMailboxOpen(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(HAD_MAILBOX_KEY, '1')
    else sessionStorage.removeItem(HAD_MAILBOX_KEY)
  } catch {
    /* private mode, or storage disabled: the note is a nicety */
  }
}

/** True when this tab had a mailbox open before the page was reloaded. */
export function tookMailboxWithIt(): boolean {
  try {
    const had = sessionStorage.getItem(HAD_MAILBOX_KEY) === '1'
    sessionStorage.removeItem(HAD_MAILBOX_KEY)
    return had
  } catch {
    return false
  }
}

let counter = 0
const uid = () => `s${++counter}-${Date.now().toString(36)}`
const stripExt = (n: string) => n.replace(/\.[^.]+$/, '')
const fkey = (sourceId: string, folderId: string) => `${sourceId}:${folderId}`
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const NAV_W_KEY = 'pstviewer.navWidth'
const LIST_W_KEY = 'pstviewer.listWidth'
const OCR_KEY = 'pstviewer.ocrEnabled'
const EMPTY_FOLDERS_KEY = 'pstviewer.showEmptyFolders'
const REMOTE_CONTENT_KEY = 'pstviewer.allowRemoteContent'

function readBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? def : v === 'true'
  } catch {
    return def
  }
}
function writeBool(key: string, v: boolean) {
  try {
    localStorage.setItem(key, String(v))
  } catch {
    /* ignore */
  }
}
function readNum(key: string, def: number): number {
  try {
    const v = localStorage.getItem(key)
    const n = v ? parseInt(v, 10) : NaN
    return Number.isFinite(n) ? n : def
  } catch {
    return def
  }
}
function writeNum(key: string, n: number) {
  try {
    localStorage.setItem(key, String(Math.round(n)))
  } catch {
    /* ignore */
  }
}

/** Whether targetId is ancestorId itself or lives anywhere inside its subtree. */
function folderContains(root: FolderNode, ancestorId: string, targetId: string): boolean {
  const find = (n: FolderNode): FolderNode | null => {
    if (n.id === ancestorId) return n
    for (const c of n.children) {
      const hit = find(c)
      if (hit) return hit
    }
    return null
  }
  const anc = find(root)
  if (!anc) return false
  const has = (n: FolderNode): boolean => n.id === targetId || n.children.some(has)
  return has(anc)
}

function firstFolderWithMessages(node: FolderNode): string | null {
  for (const child of node.children) {
    if (child.messageCount > 0) return child.id
    const deeper = firstFolderWithMessages(child)
    if (deeper) return deeper
  }
  return null
}

/** The folder with this id in a tree, or null. */
function findFolder(node: FolderNode, id: string): FolderNode | null {
  if (node.id === id) return node
  for (const child of node.children) {
    const hit = findFolder(child, id)
    if (hit) return hit
  }
  return null
}

/** How many levels of subfolders a folder has (0 for none). */
function levelsBelow(node: FolderNode): number {
  return node.children.reduce((n, c) => Math.max(n, levelsBelow(c) + 1), 0)
}

/** The folders from just below the root down to `id`; empty if it is not found. */
function folderPath(root: FolderNode | undefined, id: string): FolderNode[] {
  const walk = (node: FolderNode): FolderNode[] | null => {
    if (node.id === id) return [node]
    for (const child of node.children) {
      const rest = walk(child)
      if (rest) return [node, ...rest]
    }
    return null
  }
  return root ? (walk(root)?.slice(1) ?? []) : []
}

function dedupeLabel(label: string, fileName: string, sources: Source[], selfId: string): string {
  const taken = new Set(sources.filter((s) => s.id !== selfId).map((s) => s.label))
  if (!taken.has(label)) return label
  const withFile = `${label} (${stripExt(fileName)})`
  if (!taken.has(withFile)) return withFile
  let i = 2
  while (taken.has(`${withFile} (${i})`)) i++
  return `${withFile} (${i})`
}

/** The "no mailboxes loaded" state: resets all per-session state (but not
 *  persisted panel widths or worker status). */
function freshState(): Partial<AppState> {
  return {
    sources: [],
    selection: { sourceId: null, folderId: null, messageId: null },
    messages: [],
    messagesUnreadable: 0,
    messagesLoading: false,
    messageContent: null,
    contentLoading: false,
    expanded: {},
    autoExpanded: null,
    searchQuery: '',
    searchResults: [],
    searching: false,
    exportSel: {},
    exporting: false,
    emlExport: null,
  }
}

export const useApp = create<AppState>((set, get) => {
  /** Register a source and run the shared open → index → OCR flow. */
  const openSource = (
    seed: { fileName: string; size: number; label: string },
    open: (id: string) => Promise<SourceIndex>,
    failMessage: string,
  ) => {
    const id = uid()
    const source: Source = { id, ...seed, status: 'parsing' }
    set((s) => ({ sources: [...s.sources, source] }))

    open(id)
      .then((index) => {
        set((s) => ({
          sources: s.sources.map((src) =>
            src.id === id
              ? {
                  ...src,
                  status: 'ready' as const,
                  index,
                  label: dedupeLabel(index.suggestedLabel || src.label, seed.fileName, s.sources, id),
                }
              : src,
          ),
          expanded: { ...s.expanded, [fkey(id, index.rootFolder.id)]: true },
        }))
        noteMailboxOpen(true)

        // The worker needs the sidebar label so `mailbox:` can match it.
        void pst.setSourceLabel(id, get().sources.find((s) => s.id === id)?.label ?? '')

        // Show the first folder's messages before the background indexer
        // starts reading the whole file; both compete for the same reads.
        let firstListing: Promise<void> = Promise.resolve()
        if (!get().selection.folderId) {
          const target = firstFolderWithMessages(index.rootFolder)
          if (target) firstListing = get().selectFolder(id, target)
        }

        // Background full-text indexing with progress.
        void firstListing.then(() =>
          pst
            .indexSource(
              id,
              Comlink.proxy((done: number, total: number) => {
                set((s) => ({
                  sources: s.sources.map((src) =>
                    src.id === id ? { ...src, indexProgress: { done, total } } : src,
                  ),
                }))
              }),
            )
            .then((result) => {
              // A pass can finish without covering the mailbox: folder reads
              // that fail (a browser briefly out of memory on a big file) are
              // skipped rather than thrown. Say so instead of presenting a
              // fraction of the mail as a finished index.
              const incomplete = result ? !result.complete : false
              set((s) => ({
                sources: s.sources.map((src) =>
                  src.id === id ? { ...src, indexed: true, indexFailed: incomplete } : src,
                ),
              }))
              if (result?.fromCache) {
                // Restored from the on-device index cache; its docs already
                // carry any OCR text from the original pass.
                patchSource(id, { ocrDone: true })
                if (get().searchQuery.trim()) get().runSearch()
              } else {
                // Then OCR this mailbox's images so their text is searchable too.
                enqueueOcr(id)
              }
            })
            .catch(() => {
              // Indexing failed (a damaged region, or the worker gave up). Stop
              // reporting progress that will never finish: the mailbox stays
              // readable, and search covers whatever was indexed before it
              // failed. Marking it done also releases the staged documents.
              patchSource(id, { indexed: true, indexProgress: undefined, indexFailed: true })
              enqueueOcr(id)
            }),
        )
      })
      .catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err)
        set((s) => ({
          sources: s.sources.map((src) =>
            src.id === id ? { ...src, status: 'error', error: failMessage, errorDetail: raw } : src,
          ),
        }))
      })
  }

  /** Open one PST/OST File: register a source, parse it, then index it. */
  const startSource = (file: File) =>
    openSource(
      { fileName: file.name, size: file.size, label: stripExt(file.name) },
      (id) => pst.openSource(id, file),
      // Shown only after built-in recovery has also failed. Give the user
      // something actionable rather than a low-level reader message.
      'This file could not be opened as a mailbox, even with built-in recovery. ' +
        'It may be too damaged, or not a PST/OST at all. As a last resort, Microsoft’s ' +
        'Inbox Repair Tool (scanpst.exe) can sometimes reconstruct a damaged mailbox.',
    )

  /** Open a batch of standalone .msg/.eml files as one synthetic mailbox. */
  const startMsgSource = (files: File[]) => {
    if (!files.length) return
    const exts = new Set(files.map((f) => (/\.eml$/i.test(f.name) ? '.eml' : '.msg')))
    const batchName = exts.size === 1 ? `${files.length} ${[...exts][0]} files` : `${files.length} message files`
    const seed =
      files.length === 1
        ? { fileName: files[0].name, size: files[0].size, label: stripExt(files[0].name) }
        : {
            fileName: batchName,
            size: files.reduce((n, f) => n + f.size, 0),
            label: 'Messages',
          }
    openSource(
      seed,
      (id) => pst.openMsgSource(id, files),
      (files.length === 1
        ? 'This file could not be opened as an email message.'
        : 'None of these files could be opened as email messages.') +
        ' It may be corrupt, or not really an Outlook .msg / RFC822 .eml file.',
    )
  }

  /** Scan a zip for PST/OST files and open each one found. */
  const handleZip = (file: File) => {
    const scanId = uid()
    set((s) => ({
      sources: [
        ...s.sources,
        {
          id: scanId,
          fileName: file.name,
          size: file.size,
          label: `Scanning ${stripExt(file.name)}…`,
          status: 'parsing',
        },
      ],
    }))

    scanZipForPsts(file)
      .then(({ psts, msgs, otherFiles }) => {
        set((s) => ({ sources: s.sources.filter((x) => x.id !== scanId) }))
        if (psts.length === 0 && msgs.length === 0) {
          const sample = otherFiles.slice(0, 5).join(', ')
          const detail = otherFiles.length
            ? ` It contains ${otherFiles.length} other file${otherFiles.length === 1 ? '' : 's'}` +
              `${sample ? ` (${sample}${otherFiles.length > 5 ? ', …' : ''})` : ''}. Did you pick the right zip?`
            : ' The zip is empty.'
          set((s) => ({
            sources: [
              ...s.sources,
              {
                id: uid(),
                fileName: file.name,
                size: file.size,
                label: stripExt(file.name),
                status: 'error',
                error: `No PST, OST, MSG, or EML files found in this zip.${detail}`,
              },
            ],
          }))
          return
        }
        for (const entry of psts) startSource(entry.file)
        startMsgSource(msgs.map((entry) => entry.file))
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        set((s) => ({
          sources: s.sources.map((x) =>
            x.id === scanId ? { ...x, status: 'error', error: `Could not read zip: ${message}` } : x,
          ),
        }))
      })
  }

  // Skip images smaller than this for OCR: tracking pixels, spacers and tiny
  // icons hold no readable text but dominate image counts in real mail.
  const MIN_OCR_BYTES = 1024

  // Automatic background OCR: after a mailbox is indexed, recognize text in its
  // image attachments so it becomes searchable too. One image at a time, reusing
  // a single Tesseract worker across queued mailboxes; never blocks the UI.
  // The UI's `exporting` flag is released by a safety timer so the buttons can
  // never stay stuck, but the real work may still be running; this guard is
  // what actually prevents a second export starting on top of the first.
  let exportInFlight = false

  // Export to a folder of .eml files (see runEmlExport). Set by Cancel, and
  // checked at every step the worker sends, so an export stops within the
  // message it is on rather than at the end of a folder.
  let emlCancel = false
  // True while the folder picker is open, before an export has started.
  let emlPicking = false

  const patchEmlExport = (patch: Partial<EmlExportJob>) =>
    set((s) => (s.emlExport ? { emlExport: { ...s.emlExport, ...patch } } : {}))

  /**
   * Run one export of messages to .eml files.
   *
   * Asks where to save, makes a new directory there (never writing into or
   * over anything already on disk), then lets `read` drive the worker, which
   * produces one message at a time. Each message is written straight to its
   * file as it arrives, so memory stays flat however big the export is. A
   * message the worker cannot read, or one that cannot be saved (a name or
   * path the disk refuses), is counted and left out; only a failure every
   * later write would hit too stops the export (see EmlTreeWriter).
   *
   * Must be called straight from a click: the folder picker needs it.
   */
  const runEmlExport = (
    job: Pick<EmlExportJob, 'title' | 'total' | 'folders'>,
    directoryName: string,
    read: (ctx: {
      root: ExportDirectory
      /** A sink for the worker, writing each message into the directory `dirOf` names. */
      sink: (
        dirOf: (folderId: string) => ExportDirectory,
      ) => (step: EmlExportStep) => Promise<boolean>
      /** True once the export should end (cancelled, or it cannot go on). */
      stopped: () => boolean
      /** Report the folder now being read, a folder finished, or messages lost unread. */
      progress: (p: { current?: string; folderDone?: boolean; skipped?: number }) => void
    }) => Promise<void>,
  ): void => {
    // The picker is open, or an export is running: a second click does nothing.
    if (emlPicking || get().emlExport?.status === 'running') return
    const start: EmlExportJob = {
      ...job,
      status: 'running',
      directory: '',
      exported: 0,
      skipped: 0,
      unsaved: 0,
      reasons: [],
      foldersDone: 0,
      current: '',
    }
    if (!canExportToFolder()) {
      set({ emlExport: { ...start, status: 'unsupported' } })
      return
    }

    void (async () => {
      let picked: FileSystemDirectoryHandle | null
      emlPicking = true
      try {
        picked = await pickExportFolder()
      } catch (err) {
        set({ emlExport: { ...start, status: 'failed', error: describeError(err) } })
        return
      } finally {
        emlPicking = false
      }
      if (!picked) return // the user closed the picker
      emlCancel = false
      set({ emlExport: start })

      const writer = new EmlTreeWriter(() => emlCancel)
      let foldersDone = 0
      let current = ''
      let failure: string | null = null
      // The dialog is redrawn a few times a second, not once per message.
      let shown = 0
      const show = (now = false) => {
        const t = performance.now()
        if (!now && t - shown < 150) return
        shown = t
        patchEmlExport({
          exported: writer.exported,
          skipped: writer.unreadable,
          unsaved: writer.unsaved,
          reasons: [...writer.reasons].map(([reason, count]) => ({ reason, count })),
          foldersDone,
          current,
        })
      }

      try {
        const root = await createFreshDirectory(picked, directoryName, 'Mail export')
        patchEmlExport({ directory: root.nameOnDisk })
        await read({
          root,
          sink: (dirOf) => async (step) => {
            const go = await writer.step(step, dirOf)
            show()
            return go
          },
          stopped: () => emlCancel || writer.fatal !== null,
          progress: (p) => {
            if (p.current !== undefined) current = p.current
            if (p.folderDone) foldersDone++
            if (p.skipped) writer.unreadable += p.skipped
            show(true)
          },
        })
      } catch (err) {
        failure = describeError(err)
      }
      await writer.discard()
      failure ??= writer.fatal
      show(true)
      patchEmlExport({
        status: failure ? 'failed' : emlCancel ? 'cancelled' : 'done',
        error: failure ?? undefined,
      })
    })()
  }

  /**
   * Fetch a message into the reader.
   *
   * One quiet retry first: a read can fail for a moment (the worker busy
   * behind a long job, a hiccup reaching the file) and recovering without
   * telling anyone is better than showing an error that a second click would
   * have fixed. Only a repeated failure is worth the user's attention.
   */
  const loadMessage = async (sourceId: string, messageId: string): Promise<void> => {
    const stale = () => {
      const sel = get().selection
      return sel.messageId !== messageId || sel.sourceId !== sourceId
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await pst.getMessageContent(sourceId, messageId)
        if (stale()) return
        if (content) {
          set({ messageContent: content, contentLoading: false })
          return
        }
      } catch {
        /* fall through to the retry, then to the error state */
      }
      if (stale()) return
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250))
    }
    if (!stale()) set({ messageContent: null, contentLoading: false })
  }

  const ocrQueue: string[] = []
  let ocrActive = false
  const hasSource = (id: string) => get().sources.some((s) => s.id === id)
  const patchSource = (id: string, patch: Partial<Source>) =>
    set((s) => ({ sources: s.sources.map((src) => (src.id === id ? { ...src, ...patch } : src)) }))

  const drainOcr = async () => {
    if (ocrActive) return
    ocrActive = true
    let lib: typeof import('../lib/ocr') | null = null
    let pool: import('../lib/ocr').OcrPool | null = null
    try {
      while (ocrQueue.length) {
        if (!get().ocrEnabled) {
          // OCR switched off: finish the sources without an OCR pass.
          for (const id of ocrQueue.splice(0)) {
            if (!hasSource(id)) continue
            patchSource(id, { ocrDone: true, ocrProgress: undefined })
            void pst.releaseSearchDocs(id)
          }
          break
        }
        const sourceId = ocrQueue.shift() as string
        if (!hasSource(sourceId)) continue
        let targets: OcrTarget[] = []
        try {
          targets = await pst.listOcrImages(sourceId)
        } catch {
          /* ignore */
        }
        if (!targets.length) {
          patchSource(sourceId, { ocrDone: true })
          void pst.releaseSearchDocs(sourceId)
          continue
        }
        if (!lib) lib = await import('../lib/ocr').catch(() => null)
        if (!pool && lib) pool = await lib.createOcrPool(lib.ocrConcurrency()).catch(() => null)
        if (!lib || !pool) {
          patchSource(sourceId, { ocrDone: true }) // engine unavailable; skip silently
          void pst.releaseSearchDocs(sourceId)
          continue
        }
        const ocrLib = lib
        const engines = pool.workers
        patchSource(sourceId, { ocrProgress: { done: 0, total: targets.length } })

        // One lane per engine, each taking the next image off the shared list,
        // so several images are read at once on a multi-core machine.
        let next = 0
        let finished = 0
        const lane = async (engine: OcrWorker) => {
          for (;;) {
            const i = next++
            if (i >= targets.length) return
            if (!hasSource(sourceId) || !get().ocrEnabled) return
            const t = targets[i]
            try {
              const data =
                t.kind === 'body'
                  ? await pst.getBodyImageData(sourceId, t.messageId, t.ref)
                  : await pst.getAttachmentData(sourceId, t.messageId, t.ref)
              // Skip tiny images: too small to hold readable text (see MIN_OCR_BYTES).
              if (data && data.data.byteLength >= MIN_OCR_BYTES) {
                // Reuse cached text (keyed by image content) so a re-opened
                // mailbox, or an image shared across emails, is read only once.
                const hash = await hashImageBytes(data.data)
                let text = hash ? await getCachedOcr(hash) : undefined
                if (text === undefined) {
                  const blob = new Blob([data.data], { type: data.mime || 'image/png' })
                  text = await ocrLib.recognizeImage(engine, blob)
                  if (hash) await putCachedOcr(hash, text)
                }
                if (text) await pst.addOcrText(sourceId, t.messageId, t.kind, t.ref, text)
              }
            } catch {
              /* skip unreadable image */
            }
            finished++
            patchSource(sourceId, { ocrProgress: { done: finished, total: targets.length } })
          }
        }
        await Promise.all(engines.map(lane))
        patchSource(sourceId, { ocrDone: true, ocrProgress: undefined })
        void pst.releaseSearchDocs(sourceId)
        if (get().searchQuery.trim()) get().runSearch()
      }
    } finally {
      if (pool) await pool.terminate()
      ocrActive = false
      if (ocrQueue.length) void drainOcr()
    }
  }
  const enqueueOcr = (sourceId: string) => {
    if (!get().ocrEnabled) {
      // Preference is off: mark done without reading, recognizing, or caching.
      patchSource(sourceId, { ocrDone: true })
      void pst.releaseSearchDocs(sourceId)
      return
    }
    if (!ocrQueue.includes(sourceId)) ocrQueue.push(sourceId)
    void drainOcr()
  }

  return {
    sources: [],
    selection: { sourceId: null, folderId: null, messageId: null },
    messages: [],
    messagesUnreadable: 0,
    messagesLoading: false,
    messageContent: null,
    contentLoading: false,
    expanded: {},
    autoExpanded: null,
    searchQuery: '',
    searchResults: [],
    searching: false,
    exportSel: {},
    exporting: false,
    emlExport: null,
    navWidth: readNum(NAV_W_KEY, 272),
    listWidth: readNum(LIST_W_KEY, 380),
    ocrEnabled: readBool(OCR_KEY, true),

    // Turning OCR back on applies to mailboxes opened from then on (a mailbox
    // indexed while it was off has already released its staged search docs).
    setOcrEnabled: (v) => {
      writeBool(OCR_KEY, v)
      set({ ocrEnabled: v })
    },
    showEmptyFolders: readBool(EMPTY_FOLDERS_KEY, false),
    setShowEmptyFolders: (v) => {
      writeBool(EMPTY_FOLDERS_KEY, v)
      set({ showEmptyFolders: v })
    },
    // On by default, like a normal mail client: messages look as they were
    // sent. Turning it off keeps everything on this device.
    allowRemoteContent: readBool(REMOTE_CONTENT_KEY, true),
    setAllowRemoteContent: (v) => {
      writeBool(REMOTE_CONTENT_KEY, v)
      set({ allowRemoteContent: v })
      // Turning it off should not leave a record of what was already fetched.
      if (!v) void clearCachedImages()
    },

    setNavWidth: (w) => {
      const v = clamp(w, 200, 520)
      writeNum(NAV_W_KEY, v)
      set({ navWidth: v })
    },
    setListWidth: (w) => {
      const v = clamp(w, 280, 680)
      writeNum(LIST_W_KEY, v)
      set({ listWidth: v })
    },

    addFiles: (files) => {
      // Group .msg/.eml files dropped together into one "Messages" mailbox
      // instead of creating a source per file.
      const msgs: File[] = []
      for (const file of files) {
        if (/\.zip$/i.test(file.name)) handleZip(file)
        else if (/\.(msg|eml)$/i.test(file.name)) msgs.push(file)
        else startSource(file)
      }
      startMsgSource(msgs)
    },

    removeSource: (id) => {
      void pst.closeSource(id)
      set((s) => {
        const sources = s.sources.filter((src) => src.id !== id)
        // Removing the last mailbox returns to a clean slate. Closing them by
        // hand is not something to explain later.
        if (sources.length === 0) {
          noteMailboxOpen(false)
          return freshState()
        }

        const wasSelected = s.selection.sourceId === id
        // Drop anything tied to the removed source.
        const exportSel = Object.fromEntries(
          Object.entries(s.exportSel).filter(([, v]) => v.sourceId !== id),
        )
        return {
          sources,
          selection: wasSelected
            ? { sourceId: null, folderId: null, messageId: null }
            : s.selection,
          messages: wasSelected ? [] : s.messages,
          // Otherwise the removed mailbox's damage warning stays pinned above
          // an empty pane, attributed to nothing.
          messagesUnreadable: wasSelected ? 0 : s.messagesUnreadable,
          messageContent: wasSelected ? null : s.messageContent,
          searchResults: s.searchResults.filter((h) => h.sourceId !== id),
          exportSel,
        }
      })
    },

    clearSources: () => {
      noteMailboxOpen(false)
      for (const src of get().sources) void pst.closeSource(src.id)
      set(freshState())
    },

    renameSource: (id, label) => {
      set((s) => ({
        sources: s.sources.map((src) => (src.id === id ? { ...src, label } : src)),
      }))
      // Keep `mailbox:` searching by the name actually shown in the sidebar.
      void pst.setSourceLabel(id, label)
    },

    toggleFolder: (sourceId, folderId) =>
      set((s) => {
        const key = fkey(sourceId, folderId)
        // Folders render expanded when unset, so the first toggle collapses.
        // A manual toggle makes the state deliberate, ending any auto-expand.
        return {
          expanded: { ...s.expanded, [key]: !(s.expanded[key] ?? true) },
          autoExpanded: s.autoExpanded === key ? null : s.autoExpanded,
        }
      }),

    selectFolder: (sourceId, folderId) => {
      set((s) => {
        const key = fkey(sourceId, folderId)
        const expanded = { ...s.expanded }
        let autoExpanded = s.autoExpanded

        // A deliberately collapsed folder that was only opened by selection
        // closes again once the selection moves out of its subtree.
        if (autoExpanded && autoExpanded !== key) {
          const [aSrc, aId] = [
            autoExpanded.slice(0, autoExpanded.indexOf(':')),
            autoExpanded.slice(autoExpanded.indexOf(':') + 1),
          ]
          const root = s.sources.find((x) => x.id === aSrc)?.index?.rootFolder
          const stillInside =
            aSrc === sourceId && root ? folderContains(root, aId, folderId) : false
          if (!stillInside) {
            expanded[autoExpanded] = false
            autoExpanded = null
          }
        }
        // Selecting a collapsed folder reveals its subfolders, temporarily.
        if ((s.expanded[key] ?? true) === false) {
          expanded[key] = true
          autoExpanded = key
        }

        return {
          selection: { sourceId, folderId, messageId: null },
          messages: [],
          messagesUnreadable: 0,
          messagesLoading: true,
          messageContent: null,
          contentLoading: false,
          expanded,
          autoExpanded,
        }
      })
      return pst
        .getFolderMessages(sourceId, folderId)
        .then(({ messages, unreadable }) => {
          const sel = get().selection
          if (sel.sourceId !== sourceId || sel.folderId !== folderId) return
          messages.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
          set({ messages, messagesUnreadable: unreadable, messagesLoading: false })
        })
        .catch(() => {
          const sel = get().selection
          if (sel.sourceId === sourceId && sel.folderId === folderId) {
            set({ messages: [], messagesUnreadable: 0, messagesLoading: false })
          }
        })
    },

    selectMessage: (messageId) => {
      const sourceId = get().selection.sourceId
      set((s) => ({
        selection: { ...s.selection, messageId },
        messageContent: null,
        contentLoading: messageId != null,
      }))
      if (!messageId || !sourceId) return
      void loadMessage(sourceId, messageId)
    },

    /** Load the open message again, after it failed to load. */
    retryMessage: () => {
      const { sourceId, messageId } = get().selection
      if (!sourceId || !messageId) return
      set({ messageContent: null, contentLoading: true })
      void loadMessage(sourceId, messageId)
    },

    setSearchQuery: (searchQuery) => set({ searchQuery }),

    runSearch: () => {
      const query = get().searchQuery.trim()
      if (!query) {
        set({ searchResults: [], searching: false })
        return
      }
      set({ searching: true })
      pst
        .search(query)
        .then((searchResults) => {
          if (get().searchQuery.trim() !== query) return // stale
          set({ searchResults, searching: false })
        })
        .catch(() => {
          if (get().searchQuery.trim() === query) set({ searchResults: [], searching: false })
        })
    },

    clearSearch: () =>
      set({ searchQuery: '', searchResults: [], searching: false }),

    openHit: (hit) => {
      // Load the hit's own folder, so clearing the search leaves the list
      // showing the folder the message actually lives in rather than whatever
      // was open before.
      const prev = get().selection
      if (prev.sourceId !== hit.sourceId || prev.folderId !== hit.folderId) {
        void get().selectFolder(hit.sourceId, hit.folderId)
      }
      set((s) => ({
        selection: { sourceId: hit.sourceId, folderId: hit.folderId, messageId: hit.messageId },
        expanded: { ...s.expanded, [fkey(hit.sourceId, hit.folderId)]: true },
        messageContent: null,
        contentLoading: true,
      }))
      pst
        .getMessageContent(hit.sourceId, hit.messageId)
        .then((content) => {
          const sel = get().selection
          if (sel.messageId !== hit.messageId || sel.sourceId !== hit.sourceId) return
          set({ messageContent: content, contentLoading: false })
        })
        .catch(() => {
          const sel = get().selection
          if (sel.messageId === hit.messageId && sel.sourceId === hit.sourceId) {
            set({ messageContent: null, contentLoading: false })
          }
        })
    },

    toggleExport: (sourceId, messageId) =>
      set((s) => {
        const key = `${sourceId}:${messageId}`
        const next = { ...s.exportSel }
        if (next[key]) delete next[key]
        else next[key] = { sourceId, messageId }
        return { exportSel: next }
      }),

    clearExport: () => set({ exportSel: {} }),

    exportSelected: (direction = 'asc') => {
      const picks = Object.values(get().exportSel)
      if (!picks.length || exportInFlight) return
      exportInFlight = true
      set({ exporting: true })
      // Never let the buttons stay disabled if a fetch stalls (e.g. the worker
      // is busy with background OCR); the user can always retry.
      const safety = setTimeout(() => set({ exporting: false }), 30000)
      // allSettled, not all: one unloadable message must not sink the whole merge.
      Promise.allSettled(picks.map((p) => pst.getMessageContent(p.sourceId, p.messageId)))
        .then((results) => {
          const valid = results
            .filter((r): r is PromiseFulfilledResult<MessageContent | null> => r.status === 'fulfilled')
            .map((r) => r.value)
            .filter((c): c is MessageContent => c != null)
          const dir = direction === 'desc' ? -1 : 1
          valid.sort((a, b) => dir * ((a.date ?? 0) - (b.date ?? 0)))
          if (valid.length) printHtmlDocument(buildPrintDocument(valid, get().allowRemoteContent))
        })
        .finally(() => {
          clearTimeout(safety)
          exportInFlight = false
          set({ exporting: false })
        })
    },

    exportSingle: (sourceId, messageId) => {
      if (exportInFlight) return
      exportInFlight = true
      set({ exporting: true })
      const safety = setTimeout(() => set({ exporting: false }), 30000)
      pst
        .getMessageContent(sourceId, messageId)
        .then((content) => {
          if (content) printHtmlDocument(buildPrintDocument([content], get().allowRemoteContent))
        })
        .finally(() => {
          clearTimeout(safety)
          exportInFlight = false
          set({ exporting: false })
        })
    },

    exportEml: (sourceId, messageId) => {
      if (exportInFlight) return
      exportInFlight = true
      set({ exporting: true })
      const safety = setTimeout(() => set({ exporting: false }), 30000)
      // The worker builds the file, the same way a bulk export does, and
      // sends it a piece at a time; the pieces become the download.
      let subject: string | null = null
      const pieces: Uint8Array<ArrayBuffer>[] = []
      const sink = async (step: EmlExportStep): Promise<boolean> => {
        if (step.kind === 'start') subject = step.subject
        else if (step.kind === 'data') pieces.push(step.data as Uint8Array<ArrayBuffer>)
        else if (step.kind === 'skip') subject = null
        return true
      }
      pst
        .exportMessageEml(sourceId, messageId, Comlink.proxy(sink))
        .then(() => {
          if (subject === null) return
          downloadBlob(new Blob(pieces, { type: 'message/rfc822' }), emlFilename(subject))
        })
        .finally(() => {
          clearTimeout(safety)
          exportInFlight = false
          set({ exporting: false })
        })
    },

    exportFolderEml: (sourceId, folderId) => {
      const source = get().sources.find((s) => s.id === sourceId)
      const root = source?.index?.rootFolder
      const top = root && (folderId ? findFolder(root, folderId) : root)
      if (!source || !top) return
      let total = 0
      let folders = 0
      // Progress counts the folders that hold mail; empty ones pass unnoticed.
      const count = (n: FolderNode) => {
        total += n.messageCount
        if (n.messageCount > 0) folders++
        n.children.forEach(count)
      }
      count(top)
      const name = folderId ? top.name : source.label
      runEmlExport({ title: name, total, folders }, name, async (ctx) => {
        const exportOne = async (id: string, dir: ExportDirectory, holdsMail: boolean) => {
          const { notListed } = await pst.exportFolderEml(
            sourceId,
            id,
            Comlink.proxy(ctx.sink(() => dir)),
          )
          if (!ctx.stopped()) ctx.progress({ folderDone: holdsMail, skipped: notListed })
        }
        // Depth first, one folder at a time, each into its own directory.
        const visit = async (node: FolderNode, dir: ExportDirectory): Promise<void> => {
          ctx.progress({ current: node === root ? source.label : node.name })
          await exportOne(node.id, dir, node.messageCount > 0)
          if (ctx.stopped()) return
          for (const child of node.children) {
            await visit(child, dir.child(child.name, levelsBelow(child)))
            if (ctx.stopped()) return
          }
        }
        await visit(top, ctx.root)
      })
    },

    exportSelectedEml: () => {
      const picks = Object.values(get().exportSel)
      if (!picks.length) return
      const sources = get().sources
      // Picks from more than one mailbox get a directory per mailbox on top.
      const several = new Set(picks.map((p) => p.sourceId)).size > 1
      const title = `${picks.length} selected message${picks.length === 1 ? '' : 's'}`
      runEmlExport({ title, total: picks.length, folders: 0 }, 'Selected messages', async (ctx) => {
        // Each message goes where its folder sits in its mailbox, so the
        // export has the same shape as the mailbox, holding just the picks.
        const dirs = new Map<string, ExportDirectory>()
        const below = (
          parent: ExportDirectory,
          key: string,
          node: FolderNode,
          name = node.name,
        ) => {
          let dir = dirs.get(key)
          if (!dir) {
            dir = parent.child(name, levelsBelow(node))
            dirs.set(key, dir)
          }
          return dir
        }
        for (const pick of picks) {
          const source = sources.find((s) => s.id === pick.sourceId)
          const tree = source?.index?.rootFolder
          const dirOf = (folderId: string) => {
            let dir =
              several && tree
                ? below(ctx.root, pick.sourceId, tree, source?.label ?? 'Mailbox')
                : ctx.root
            for (const node of folderPath(tree, folderId)) {
              dir = below(dir, `${pick.sourceId}:${node.id}`, node)
            }
            return dir
          }
          await pst.exportMessageEml(pick.sourceId, pick.messageId, Comlink.proxy(ctx.sink(dirOf)))
          if (ctx.stopped()) return
        }
      })
    },

    cancelEmlExport: () => {
      if (get().emlExport?.status === 'running') emlCancel = true
    },

    closeEmlExport: () => {
      if (get().emlExport?.status !== 'running') set({ emlExport: null })
    },
  }
})
