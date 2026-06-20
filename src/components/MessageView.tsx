import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useApp } from '../store/store'
import { pst } from '../worker/client'
import type { MessageContent, OcrMatchResult, RecipientInfo } from '../types'
import { formatDate } from '../lib/format'
import { categoryFromNameMime } from '../lib/detectType'
import { sanitizeEmailHtml } from '../lib/sanitizeHtml'
import { queryTerms, termsRegExp } from '../lib/highlight'
import { EmailFrame } from './EmailFrame'
import { ImageLightbox } from './ImageLightbox'
import { AttachmentBar } from './attachments/AttachmentBar'
import { HeadersDialog } from './HeadersDialog'
import {
  AppointmentCardView,
  ContactCardView,
  DistListCardView,
  JournalCardView,
  TaskCardView,
} from './ItemCard'
import { Code, Download, Printer } from './icons'

export function MessageView({
  sourceId,
  messageId,
  content,
}: {
  sourceId: string
  messageId: string
  content: MessageContent
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const [showHeaders, setShowHeaders] = useState(false)
  const searchQuery = useApp((s) => s.searchQuery)
  const terms = useMemo(() => queryTerms(searchQuery), [searchQuery])
  const [ocrMatch, setOcrMatch] = useState<OcrMatchResult>({
    attachmentIndexes: [],
    bodyImageIndexes: [],
  })

  // Which images contain the active search text (via OCR), so we can point the
  // user at the picture their match lives in: a chip, or an image in the body.
  useEffect(() => {
    let alive = true
    if (!searchQuery.trim()) {
      setOcrMatch({ attachmentIndexes: [], bodyImageIndexes: [] })
      return
    }
    pst
      .ocrMatches(sourceId, messageId, searchQuery)
      .then((res) => {
        if (alive) setOcrMatch(res)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sourceId, messageId, searchQuery])

  // cid: → blob URL for inline images; revoked when the message changes.
  const cidUrls = useMemo(() => {
    const map = new Map<string, string>()
    for (const img of content.inlineImages) {
      const blob = new Blob([img.data], { type: img.mime || 'application/octet-stream' })
      map.set(img.cid, URL.createObjectURL(blob))
    }
    return map
  }, [content])

  useEffect(() => {
    return () => {
      for (const url of cidUrls.values()) URL.revokeObjectURL(url)
    }
  }, [cidUrls])

  const sanitizedHtml = useMemo(
    () => (content.html ? sanitizeEmailHtml(content.html, cidUrls) : null),
    [content.html, cidUrls],
  )

  // Inline (cid) images whose OCR text matched the search get outlined in the body.
  const highlightImageUrls = useMemo(() => {
    const urls: string[] = []
    for (const idx of ocrMatch.attachmentIndexes) {
      const att = content.attachments.find((a) => a.index === idx)
      const url = att?.cid ? cidUrls.get(att.cid) : undefined
      if (url) urls.push(url)
    }
    return urls
  }, [ocrMatch.attachmentIndexes, content.attachments, cidUrls])

  // Hide only inline *images* (they render inside the body); everything else,
  // including inline PDFs, stays visible as a downloadable/previewable chip.
  const exportSingle = useApp((s) => s.exportSingle)
  const exportEml = useApp((s) => s.exportEml)
  const exporting = useApp((s) => s.exporting)
  const exportSelectionActive = useApp((s) => Object.keys(s.exportSel).length > 0)

  const visibleAttachments = content.attachments.filter(
    (a) =>
      a.isEmbeddedMessage ||
      !(a.isInline && categoryFromNameMime(a.name, a.mime) === 'image'),
  )
  const from = content.fromName || content.fromEmail || '(unknown sender)'

  return (
    <section className="flex h-full min-h-0 flex-col bg-slate-950">
      <div className="border-b border-slate-800 px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 text-lg font-semibold text-slate-100">{content.subject}</h1>
          <div className="flex shrink-0 items-center gap-2">
            {content.headers && (
              <button
                onClick={() => setShowHeaders(true)}
                className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60"
                data-tip="View the message's original headers"
              >
                <Code className="h-4 w-4" /> Headers
              </button>
            )}
            {!exportSelectionActive && (
              <button
                onClick={() => exportSingle(sourceId, messageId)}
                disabled={exporting}
                className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60 disabled:opacity-60"
                data-tip="Save this email as PDF"
              >
                <Printer className="h-4 w-4" /> PDF
              </button>
            )}
            {content.itemKind === 'email' && !exportSelectionActive && (
              <button
                onClick={() => exportEml(sourceId, messageId)}
                disabled={exporting}
                className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60 disabled:opacity-60"
                data-tip="Save the original email as a .eml file"
              >
                <Download className="h-4 w-4" /> EML
              </button>
            )}
          </div>
        </div>
        {(content.categories.length > 0 ||
          content.importance ||
          content.sensitivity ||
          content.followUp) && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {content.importance === 'high' && <Chip tone="amber">High importance</Chip>}
            {content.importance === 'low' && <Chip tone="slate">Low importance</Chip>}
            {content.followUp === 'flagged' && <Chip tone="amber">Flagged</Chip>}
            {content.followUp === 'complete' && <Chip tone="green">Follow-up complete</Chip>}
            {content.sensitivity && (
              <Chip tone="amber">
                {content.sensitivity.charAt(0).toUpperCase() + content.sensitivity.slice(1)}
              </Chip>
            )}
            {content.categories.map((c) => (
              <Chip key={c} tone="slate">
                {c}
              </Chip>
            ))}
          </div>
        )}
        {content.itemKind === 'email' && (
          <div className="mt-3 space-y-1 text-sm">
            <HeaderLine label="From">
              <span className="text-slate-200">{from}</span>
              {content.fromEmail && content.fromName && (
                <span className="text-slate-400"> &lt;{content.fromEmail}&gt;</span>
              )}
            </HeaderLine>
            {content.to.length > 0 && (
              <HeaderLine label="To">
                <Recipients list={content.to} />
              </HeaderLine>
            )}
            {content.cc.length > 0 && (
              <HeaderLine label="Cc">
                <Recipients list={content.cc} />
              </HeaderLine>
            )}
            {content.bcc.length > 0 && (
              <HeaderLine label="Bcc">
                <Recipients list={content.bcc} />
              </HeaderLine>
            )}
            {content.date != null && (
              <HeaderLine label="Date">{formatDate(content.date)}</HeaderLine>
            )}
          </div>
        )}
      </div>

      {visibleAttachments.length > 0 && (
        <AttachmentBar
          sourceId={sourceId}
          messageId={messageId}
          attachments={visibleAttachments}
          ocrHits={ocrMatch.attachmentIndexes}
        />
      )}

      <div className="scroll-clear min-h-0 flex-1 overflow-y-auto">
        {content.itemKind === 'contact' && content.contact ? (
          <ContactCardView contact={content.contact} notes={content.text} />
        ) : content.itemKind === 'distlist' && content.distlist ? (
          <DistListCardView distlist={content.distlist} notes={content.text} />
        ) : (
          <>
            {content.itemKind === 'appointment' && content.appointment && (
              <AppointmentCardView appointment={content.appointment} />
            )}
            {content.itemKind === 'task' && content.task && <TaskCardView task={content.task} />}
            {content.itemKind === 'journal' && content.journal && (
              <JournalCardView journal={content.journal} />
            )}
            {sanitizedHtml ? (
              <EmailFrame
                html={sanitizedHtml}
                terms={terms}
                highlightImageUrls={highlightImageUrls}
                highlightBodyImageIndexes={ocrMatch.bodyImageIndexes}
                onImageClick={setPreview}
              />
            ) : content.text ? (
              <pre className="m-0 min-h-full whitespace-pre-wrap break-words bg-white px-6 py-4 font-sans text-sm text-slate-900">
                {terms.length ? <HighlightedText text={content.text} terms={terms} /> : content.text}
              </pre>
            ) : content.itemKind === 'email' ? (
              <div className="p-8 text-center text-sm text-slate-400">(No message content)</div>
            ) : null}
          </>
        )}
      </div>
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
      {showHeaders && (
        <HeadersDialog headers={content.headers} onClose={() => setShowHeaders(false)} />
      )}
    </section>
  )
}

/** Plain-text body with the active search terms highlighted; scrolls to the first. */
function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  const firstRef = useRef<HTMLElement>(null)
  const key = terms.join('')
  useEffect(() => {
    firstRef.current?.scrollIntoView({ block: 'center' })
  }, [text, key])

  const re = termsRegExp(terms)
  if (!re) return <>{text}</>
  const nodes: ReactNode[] = []
  let last = 0
  let i = 0
  let first = true
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const isFirst = first
    first = false
    nodes.push(
      <mark
        key={i++}
        ref={isFirst ? firstRef : undefined}
        className="rounded-sm bg-yellow-400 text-slate-900"
      >
        {m[0]}
      </mark>,
    )
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}

function Recipients({ list }: { list: RecipientInfo[] }) {
  return (
    <>
      {list.map((r, i) => (
        <span key={`${r.email}-${i}`}>
          {i > 0 && '; '}
          {r.name || r.email}
          {r.name && r.email ? ` <${r.email}>` : ''}
        </span>
      ))}
    </>
  )
}

function Chip({ tone, children }: { tone: 'slate' | 'amber' | 'green'; children: ReactNode }) {
  const tones = {
    slate: 'border-slate-700 bg-slate-800 text-slate-300',
    amber: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
    green: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  }
  return (
    <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

function HeaderLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-slate-400">{label}</span>
      <span className="min-w-0 flex-1 text-slate-300">{children}</span>
    </div>
  )
}
