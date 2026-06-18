import { create } from 'zustand'
import * as Comlink from 'comlink'
import { pst } from '../worker/client'
import { extractPstsFromZip } from '../lib/zip'
import { buildPrintDocument, printHtmlDocument } from '../lib/printExport'
import type { FolderNode, MessageContent, MessageMeta, SearchHit, SourceIndex } from '../types'

export type WorkerStatus = 'idle' | 'ready' | 'error'
export type SourceStatus = 'parsing' | 'ready' | 'error'

export interface Source {
  id: string
  fileName: string
  size: number
  label: string
  status: SourceStatus
  error?: string
  index?: SourceIndex
  indexProgress?: { done: number; total: number }
  indexed?: boolean
}

interface Selection {
  sourceId: string | null
  folderId: string | null
  messageId: string | null
}

interface AppState {
  workerStatus: WorkerStatus
  sources: Source[]
  selection: Selection
  messages: MessageMeta[]
  messagesLoading: boolean
  messageContent: MessageContent | null
  contentLoading: boolean
  expanded: Record<string, boolean>

  searchQuery: string
  searchResults: SearchHit[]
  searching: boolean

  /** Messages picked for PDF export, keyed `${sourceId}:${messageId}`. */
  exportSel: Record<string, { sourceId: string; messageId: string }>
  exporting: boolean

  ocrState: 'idle' | 'running' | 'done' | 'error'
  ocrProgress: { done: number; total: number }

  /** Persisted panel widths (px). */
  navWidth: number
  listWidth: number
  setNavWidth: (w: number) => void
  setListWidth: (w: number) => void

  setWorkerStatus: (s: WorkerStatus) => void
  addFiles: (files: File[]) => void
  removeSource: (id: string) => void
  clearSources: () => void
  renameSource: (id: string, label: string) => void
  toggleFolder: (sourceId: string, folderId: string) => void
  selectFolder: (sourceId: string, folderId: string) => void
  selectMessage: (messageId: string | null) => void

  setSearchQuery: (q: string) => void
  runSearch: () => void
  clearSearch: () => void
  openHit: (hit: SearchHit) => void

  toggleExport: (sourceId: string, messageId: string) => void
  clearExport: () => void
  exportSelected: (direction?: 'asc' | 'desc') => void
  exportSingle: (sourceId: string, messageId: string) => void

  enableOcr: () => void
}

let counter = 0
const uid = () => `s${++counter}-${Date.now().toString(36)}`
const stripExt = (n: string) => n.replace(/\.[^.]+$/, '')
const fkey = (sourceId: string, folderId: string) => `${sourceId}:${folderId}`
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const NAV_W_KEY = 'pstviewer.navWidth'
const LIST_W_KEY = 'pstviewer.listWidth'
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

/** The "no mailboxes loaded" state — resets all per-session state (but not
 *  persisted panel widths or worker status). */
function freshState(): Partial<AppState> {
  return {
    sources: [],
    selection: { sourceId: null, folderId: null, messageId: null },
    messages: [],
    messagesLoading: false,
    messageContent: null,
    contentLoading: false,
    expanded: {},
    searchQuery: '',
    searchResults: [],
    searching: false,
    exportSel: {},
    exporting: false,
    ocrState: 'idle',
    ocrProgress: { done: 0, total: 0 },
  }
}

export const useApp = create<AppState>((set, get) => {
  /** Open one PST/OST File: register a source, parse it, then index it. */
  const startSource = (file: File) => {
    const id = uid()
    const source: Source = {
      id,
      fileName: file.name,
      size: file.size,
      label: stripExt(file.name),
      status: 'parsing',
    }
    // A newly added mailbox isn't covered by a prior OCR run, so re-enable the
    // OCR action (drop a stale "done" state).
    set((s) => ({
      sources: [...s.sources, source],
      ocrState: s.ocrState === 'done' ? 'idle' : s.ocrState,
    }))

    pst
      .openSource(id, file)
      .then((index) => {
        set((s) => ({
          sources: s.sources.map((src) =>
            src.id === id
              ? {
                  ...src,
                  status: 'ready' as const,
                  index,
                  label: dedupeLabel(index.suggestedLabel || src.label, file.name, s.sources, id),
                }
              : src,
          ),
          expanded: { ...s.expanded, [fkey(id, index.rootFolder.id)]: true },
        }))

        if (!get().selection.folderId) {
          const target = firstFolderWithMessages(index.rootFolder)
          if (target) get().selectFolder(id, target)
        }

        // Background full-text indexing with progress.
        void pst
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
          .then(() => {
            set((s) => ({
              sources: s.sources.map((src) => (src.id === id ? { ...src, indexed: true } : src)),
            }))
          })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        set((s) => ({
          sources: s.sources.map((src) =>
            src.id === id ? { ...src, status: 'error', error: message } : src,
          ),
        }))
      })
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

    extractPstsFromZip(file)
      .then((entries) => {
        set((s) => ({ sources: s.sources.filter((x) => x.id !== scanId) }))
        if (entries.length === 0) {
          set((s) => ({
            sources: [
              ...s.sources,
              {
                id: uid(),
                fileName: file.name,
                size: file.size,
                label: stripExt(file.name),
                status: 'error',
                error: 'No PST/OST files found in this zip.',
              },
            ],
          }))
          return
        }
        for (const entry of entries) startSource(entry.file)
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

  return {
    workerStatus: 'idle',
    sources: [],
    selection: { sourceId: null, folderId: null, messageId: null },
    messages: [],
    messagesLoading: false,
    messageContent: null,
    contentLoading: false,
    expanded: {},
    searchQuery: '',
    searchResults: [],
    searching: false,
    exportSel: {},
    exporting: false,
    ocrState: 'idle',
    ocrProgress: { done: 0, total: 0 },
    navWidth: readNum(NAV_W_KEY, 272),
    listWidth: readNum(LIST_W_KEY, 380),

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

    setWorkerStatus: (workerStatus) => set({ workerStatus }),

    addFiles: (files) => {
      for (const file of files) {
        if (/\.zip$/i.test(file.name)) handleZip(file)
        else startSource(file)
      }
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
        return { expanded: { ...s.expanded, [key]: !s.expanded[key] } }
      }),

    selectFolder: (sourceId, folderId) => {
      set({
        selection: { sourceId, folderId, messageId: null },
        messages: [],
        messagesLoading: true,
        messageContent: null,
        contentLoading: false,
      })
      pst
        .getFolderMessages(sourceId, folderId)
        .then((messages) => {
          const sel = get().selection
          if (sel.sourceId !== sourceId || sel.folderId !== folderId) return
          messages.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
          set({ messages, messagesLoading: false })
        })
        .catch(() => {
          const sel = get().selection
          if (sel.sourceId === sourceId && sel.folderId === folderId) {
            set({ messages: [], messagesLoading: false })
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
          if (get().selection.messageId !== messageId) return
          set({ messageContent: content, contentLoading: false })
        })
        .catch(() => {
          if (get().selection.messageId === messageId) {
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
          if (get().selection.messageId !== hit.messageId) return
          set({ messageContent: content, contentLoading: false })
        })
        .catch(() => {
          if (get().selection.messageId === hit.messageId) {
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
      Promise.all(picks.map((p) => pst.getMessageContent(p.sourceId, p.messageId)))
        .then((contents) => {
          const valid = contents.filter((c): c is MessageContent => c != null)
          const dir = direction === 'desc' ? -1 : 1
          valid.sort((a, b) => dir * ((a.date ?? 0) - (b.date ?? 0)))
          if (valid.length) printHtmlDocument(buildPrintDocument(valid))
        })
        .finally(() => set({ exporting: false }))
    },

    exportSingle: (sourceId, messageId) => {
      if (get().exporting) return
      set({ exporting: true })
      pst
        .getMessageContent(sourceId, messageId)
        .then((content) => {
          if (content) printHtmlDocument(buildPrintDocument([content]))
        })
        .finally(() => set({ exporting: false }))
    },

    enableOcr: () => {
      if (get().ocrState === 'running') return
      set({ ocrState: 'running', ocrProgress: { done: 0, total: 0 } })
      ;(async () => {
        const { createOcrWorker, recognizeImage } = await import('../lib/ocr')
        const worker = await createOcrWorker()
        try {
          const targets: Array<{ sourceId: string; messageId: string; index: number }> = []
          for (const src of get().sources) {
            if (src.status !== 'ready') continue
            const list = await pst.listImageAttachments(src.id)
            for (const t of list) targets.push({ sourceId: src.id, messageId: t.messageId, index: t.index })
          }
          set({ ocrProgress: { done: 0, total: targets.length } })

          for (let i = 0; i < targets.length; i++) {
            const t = targets[i]
            try {
              const data = await pst.getAttachmentData(t.sourceId, t.messageId, t.index)
              if (data) {
                const blob = new Blob([data.data], { type: data.mime || 'image/png' })
                const text = await recognizeImage(worker, blob)
                if (text) await pst.addOcrText(t.sourceId, t.messageId, text)
              }
            } catch {
              // skip an unreadable image
            }
            set({ ocrProgress: { done: i + 1, total: targets.length } })
          }
          set({ ocrState: 'done' })
          get().runSearch()
        } finally {
          await worker.terminate()
        }
      })().catch(() => set({ ocrState: 'error' }))
    },
  }
})
