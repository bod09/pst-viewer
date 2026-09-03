import { create } from 'zustand'
import * as Comlink from 'comlink'
import { pst } from '../worker/client'
import { scanZipForPsts } from '../lib/zip'
import { buildPrintDocument, printHtmlDocument } from '../lib/printExport'
import { buildEml, downloadBlob, emlFilename, type EmlAttachment } from '../lib/emlExport'
import { getCachedOcr, putCachedOcr, hashImageBytes } from '../lib/ocrCache'
import type { Worker as OcrWorker } from 'tesseract.js'
import type { FolderNode, MessageContent, MessageMeta, OcrTarget, SearchHit, SourceIndex } from '../types'

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
  ocrProgress?: { done: number; total: number }
  ocrDone?: boolean
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

  /** Messages picked for PDF export, keyed `${sourceId}:${messageId}`. */
  exportSel: Record<string, { sourceId: string; messageId: string }>
  exporting: boolean

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
  addFiles: (files: File[]) => void
  removeSource: (id: string) => void
  clearSources: () => void
  renameSource: (id: string, label: string) => void
  toggleFolder: (sourceId: string, folderId: string) => void
  selectFolder: (sourceId: string, folderId: string) => Promise<void>
  selectMessage: (messageId: string | null) => void

  setSearchQuery: (q: string) => void
  runSearch: () => void
  clearSearch: () => void
  openHit: (hit: SearchHit) => void

  toggleExport: (sourceId: string, messageId: string) => void
  clearExport: () => void
  exportSelected: (direction?: 'asc' | 'desc') => void
  exportSingle: (sourceId: string, messageId: string) => void
  exportEml: (sourceId: string, messageId: string) => void
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
              set((s) => ({
                sources: s.sources.map((src) => (src.id === id ? { ...src, indexed: true } : src)),
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
        // Removing the last mailbox returns to a clean slate.
        if (sources.length === 0) return freshState()

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
          messageContent: wasSelected ? null : s.messageContent,
          searchResults: s.searchResults.filter((h) => h.sourceId !== id),
          exportSel,
        }
      })
    },

    clearSources: () => {
      for (const src of get().sources) void pst.closeSource(src.id)
      set(freshState())
    },

    renameSource: (id, label) =>
      set((s) => ({
        sources: s.sources.map((src) => (src.id === id ? { ...src, label } : src)),
      })),

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
      pst
        .getMessageContent(sourceId, messageId)
        .then((content) => {
          const sel = get().selection
          if (sel.messageId !== messageId || sel.sourceId !== sourceId) return
          set({ messageContent: content, contentLoading: false })
        })
        .catch(() => {
          const sel = get().selection
          if (sel.messageId === messageId && sel.sourceId === sourceId) {
            set({ messageContent: null, contentLoading: false })
          }
        })
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
        .search(query, 200)
        .then((searchResults) => {
          if (get().searchQuery.trim() !== query) return // stale
          set({ searchResults, searching: false })
        })
        .catch(() => {
          if (get().searchQuery.trim() === query) set({ searchResults: [], searching: false })
        })
    },

    clearSearch: () => set({ searchQuery: '', searchResults: [], searching: false }),

    openHit: (hit) => {
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
      if (!picks.length || get().exporting) return
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
          if (valid.length) printHtmlDocument(buildPrintDocument(valid))
        })
        .finally(() => {
          clearTimeout(safety)
          set({ exporting: false })
        })
    },

    exportSingle: (sourceId, messageId) => {
      if (get().exporting) return
      set({ exporting: true })
      const safety = setTimeout(() => set({ exporting: false }), 30000)
      pst
        .getMessageContent(sourceId, messageId)
        .then((content) => {
          if (content) printHtmlDocument(buildPrintDocument([content]))
        })
        .finally(() => {
          clearTimeout(safety)
          set({ exporting: false })
        })
    },

    exportEml: (sourceId, messageId) => {
      if (get().exporting) return
      set({ exporting: true })
      const safety = setTimeout(() => set({ exporting: false }), 30000)
      pst
        .getMessageContent(sourceId, messageId)
        .then(async (content) => {
          if (!content) return
          const files: EmlAttachment[] = []
          for (const a of content.attachments) {
            if (a.isInline || a.isEmbeddedMessage) continue
            const d = await pst.getAttachmentData(sourceId, messageId, a.index)
            if (d) files.push({ name: a.name || d.name, mime: a.mime || d.mime, data: d.data })
          }
          downloadBlob(
            new Blob([buildEml(content, files)], { type: 'message/rfc822' }),
            emlFilename(content),
          )
        })
        .finally(() => {
          clearTimeout(safety)
          set({ exporting: false })
        })
    },
  }
})
