import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AttachmentMeta, EmbeddedMessageResult } from '../../types'
import { pst } from '../../worker/client'
import { detectType, type DetectedType } from '../../lib/detectType'
import { pdfjs } from '../../lib/pdf'
import { Close, Download, FileGeneric, Spinner } from '../icons'
import { MessageView } from '../MessageView'

interface PreviewProps {
  sourceId: string
  messageId: string
  meta: AttachmentMeta
  onClose: () => void
}

export function AttachmentPreview({ sourceId, messageId, meta, onClose }: PreviewProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
          <span className="min-w-0 truncate text-sm font-medium text-slate-200" data-tip={meta.name}>
            {meta.name}
          </span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            data-tip="Close (Esc)"
          >
            <Close className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {meta.isEmbeddedMessage ? (
            <EmbeddedView sourceId={sourceId} messageId={messageId} index={meta.index} />
          ) : (
            <FileView sourceId={sourceId} messageId={messageId} meta={meta} />
          )}
        </div>
      </div>
    </div>
  )
}

interface LoadedFile {
  bytes: Uint8Array
  blobUrl: string
  detected: DetectedType
  name: string
}

function FileView({
  sourceId,
  messageId,
  meta,
}: {
  sourceId: string
  messageId: string
  meta: AttachmentMeta
}) {
  const [file, setFile] = useState<LoadedFile | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    let url: string | undefined
    setFile(null)
    setError(false)
    pst
      .getAttachmentData(sourceId, messageId, meta.index)
      .then((res) => {
        if (!alive) return
        if (!res) {
          setError(true)
          return
        }
        const bytes = new Uint8Array(res.data)
        const detected = detectType(bytes, res.name || meta.name, res.mime || meta.mime)
        url = URL.createObjectURL(
          new Blob([bytes], { type: detected.mime || 'application/octet-stream' }),
        )
        setFile({ bytes, blobUrl: url, detected, name: res.name || meta.name })
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [sourceId, messageId, meta])

  if (error) return <Centered>Could not load this attachment.</Centered>
  if (!file) {
    return (
      <Centered>
        <Spinner className="mb-2 h-5 w-5 text-sky-400" />
        Loading attachment…
      </Centered>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/60 px-4 py-2 text-xs text-slate-500">
        <span className="truncate">{file.detected.mime || 'application/octet-stream'}</span>
        <a
          href={file.blobUrl}
          download={downloadName(file.name, file.detected.ext)}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-sky-500/15 px-3 py-1.5 font-medium text-sky-300 transition hover:bg-sky-500/25"
        >
          <Download className="h-4 w-4" /> Download
        </a>
      </div>
      <div className="scroll-clear min-h-0 flex-1 overflow-auto bg-slate-900">
        <Renderer file={file} />
      </div>
    </div>
  )
}

const SPREADSHEET_EXT = new Set(['xlsx', 'xls', 'ods', 'csv'])

function Renderer({ file }: { file: LoadedFile }) {
  const { ext } = file.detected
  if (SPREADSHEET_EXT.has(ext)) return <SpreadsheetView bytes={file.bytes} />
  if (ext === 'docx') return <DocxView bytes={file.bytes} />

  switch (file.detected.category) {
    case 'image':
      return (
        <div className="flex min-h-full items-center justify-center p-4">
          <img src={file.blobUrl} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      )
    case 'pdf':
      return <PdfView bytes={file.bytes} />
    case 'text':
      return <TextView bytes={file.bytes} />
    case 'audio':
      return (
        <div className="flex min-h-full items-center justify-center p-8">
          <audio controls src={file.blobUrl} className="w-full max-w-lg" />
        </div>
      )
    case 'video':
      return (
        <div className="flex min-h-full items-center justify-center p-4">
          <video controls src={file.blobUrl} className="max-h-full max-w-full" />
        </div>
      )
    default:
      return <DownloadPrompt detected={file.detected} />
  }
}

function PdfView({ bytes }: { bytes: Uint8Array }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Copy: pdf.js takes ownership of the buffer it is handed.
    const task = pdfjs.getDocument({ data: bytes.slice() })
    task.promise
      .then(async (doc) => {
        const container = containerRef.current
        if (cancelled || !container) return
        container.replaceChildren()
        const targetWidth = Math.max(320, container.clientWidth - 24)
        for (let p = 1; p <= doc.numPages; p++) {
          const page = await doc.getPage(p)
          if (cancelled) return
          const unscaled = page.getViewport({ scale: 1 })
          const scale = Math.min(2, targetWidth / unscaled.width)
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.className = 'mx-auto mb-3 max-w-full shadow-lg'
          container.appendChild(canvas)
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          await page.render({ canvas, canvasContext: ctx, viewport }).promise
          if (cancelled) return
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [bytes])

  if (error) return <Centered>Could not render this PDF. Use Download to save it.</Centered>
  return <div ref={containerRef} className="p-3" />
}

function TextView({ bytes }: { bytes: Uint8Array }) {
  const text = useMemo(() => {
    const capped = bytes.subarray(0, 2_000_000)
    return new TextDecoder('utf-8', { fatal: false }).decode(capped)
  }, [bytes])
  return (
    <pre className="m-0 whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-slate-200">
      {text}
      {bytes.length > 2_000_000 && '\n\n… (truncated preview, download for full file)'}
    </pre>
  )
}

function SpreadsheetView({ bytes }: { bytes: Uint8Array }) {
  const [state, setState] = useState<{ sheets: string[]; tables: string[] } | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setState(null)
    setError(false)
    setActive(0)
    import('xlsx')
      .then((XLSX) => {
        if (!alive) return
        const wb = XLSX.read(bytes, { type: 'array' })
        const sheets = wb.SheetNames
        const tables = sheets.map((name) => {
          const raw = XLSX.utils.sheet_to_html(wb.Sheets[name])
          const doc = new DOMParser().parseFromString(raw, 'text/html')
          return doc.querySelector('table')?.outerHTML ?? '<p style="padding:1rem">(empty sheet)</p>'
        })
        setState({ sheets, tables })
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
    }
  }, [bytes])

  if (error) return <Centered>Could not open this spreadsheet. Use Download to save it.</Centered>
  if (!state) {
    return (
      <Centered>
        <Spinner className="mb-2 h-5 w-5 text-sky-400" />
        Loading spreadsheet…
      </Centered>
    )
  }
  return (
    <div className="flex h-full flex-col">
      {state.sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900 px-2 py-1.5">
          {state.sheets.map((name, i) => (
            <button
              key={`${name}-${i}`}
              onClick={() => setActive(i)}
              className={`shrink-0 rounded px-2.5 py-1 text-xs ${
                i === active ? 'bg-sky-500 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              {name || `Sheet ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <div
        key={active}
        className="scroll-clear-light sheet-view min-h-0 flex-1 bg-white"
        dangerouslySetInnerHTML={{ __html: state.tables[active] }}
      />
    </div>
  )
}

function DocxView({ bytes }: { bytes: Uint8Array }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setError(false)
    setLoading(true)
    const el = ref.current
    import('docx-preview')
      .then((dp) => {
        if (!alive || !el) return undefined
        el.innerHTML = ''
        return dp.renderAsync(bytes, el, undefined, {
          inWrapper: true,
          className: 'docx',
        })
      })
      .then(() => {
        if (alive) setLoading(false)
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
      if (el) el.innerHTML = ''
    }
  }, [bytes])

  if (error) return <Centered>Could not open this document. Use Download to save it.</Centered>
  return (
    <div className="min-h-full bg-slate-300 p-4">
      {loading && (
        <div className="py-8 text-center text-sm text-slate-600">
          <Spinner className="mx-auto mb-2 h-5 w-5 text-sky-500" />
          Loading document…
        </div>
      )}
      <div ref={ref} />
    </div>
  )
}

function EmbeddedView({
  sourceId,
  messageId,
  index,
}: {
  sourceId: string
  messageId: string
  index: number
}) {
  const [result, setResult] = useState<EmbeddedMessageResult | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setResult(null)
    setError(false)
    pst
      .getEmbeddedMessageContent(sourceId, messageId, index)
      .then((r) => {
        if (!alive) return
        if (!r) setError(true)
        else setResult(r)
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
    }
  }, [sourceId, messageId, index])

  if (error) return <Centered>Could not open this embedded message.</Centered>
  if (!result) {
    return (
      <Centered>
        <Spinner className="mb-2 h-5 w-5 text-sky-400" />
        Loading message…
      </Centered>
    )
  }
  return (
    <div className="h-full overflow-hidden">
      <MessageView sourceId={sourceId} messageId={result.id} content={result.content} />
    </div>
  )
}

function DownloadPrompt({ detected }: { detected: DetectedType }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center text-slate-400">
      <FileGeneric className="h-12 w-12 text-slate-600" />
      <div>
        No inline preview for{' '}
        <span className="font-medium text-slate-200">.{detected.ext || 'file'}</span> files.
      </div>
      <div className="text-xs text-slate-500">Use the Download button above to save it.</div>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center text-sm text-slate-500">
      {children}
    </div>
  )
}

function downloadName(name: string, ext: string): string {
  if (!ext) return name || 'attachment'
  if (new RegExp(`\\.${ext}$`, 'i').test(name)) return name
  return `${name || 'attachment'}.${ext}`
}
