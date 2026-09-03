import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useApp } from '../store/store'
import { pst } from '../worker/client'
import type { ContactMatch, MessageContent, OcrMatchResult, RecipientInfo } from '../types'
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
import { Code, Download, Printer, Search } from './icons'
import { Dialog } from './Dialog'

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
  const [contactQuery, setContactQuery] = useState<{ name: string; email: string } | null>(null)
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

  const allowRemoteContent = useApp((s) => s.allowRemoteContent)
  const sanitizedHtml = useMemo(
    () => (content.html ? sanitizeEmailHtml(content.html, cidUrls, allowRemoteContent) : null),
    [content.html, cidUrls, allowRemoteContent],
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
              <Person
                name={content.fromName}
                email={content.fromEmail}
                onLookup={setContactQuery}
              />
            </HeaderLine>
            {content.to.length > 0 && (
              <HeaderLine label="To">
                <Recipients list={content.to} onLookup={setContactQuery} />
              </HeaderLine>
            )}
            {content.cc.length > 0 && (
              <HeaderLine label="Cc">
                <Recipients list={content.cc} onLookup={setContactQuery} />
              </HeaderLine>
            )}
            {content.bcc.length > 0 && (
              <HeaderLine label="Bcc">
                <Recipients list={content.bcc} onLookup={setContactQuery} />
              </HeaderLine>
            )}
            {content.date != null && (
              <HeaderLine label="Date">{formatDate(content.date)}</HeaderLine>
            )}
          </div>
        )}
      </div>

      {contactQuery && (
        <ContactLookup query={contactQuery} onClose={() => setContactQuery(null)} />
      )}

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
              <pre className="m-0 min-h-full whitespace-pre-wrap break-words bg-white px-6 py-4 font-sans text-sm text-neutral-900">
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
        className="rounded-sm bg-yellow-400 text-neutral-900"
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

// Old internal Exchange mail has no SMTP addresses: recipients carry an X.500
// directory path (/O=.../CN=...) or a bare word doubling the display name.
// Only a real email address earns the "Name <address>" form; everything else
// shows the name alone (with the raw value on hover).
function showAddress(name: string, email: string): boolean {
  return Boolean(email) && email.includes('@') && email.toLowerCase() !== name.toLowerCase()
}

type LookupFn = (q: { name: string; email: string }) => void

/** A person in the header; clicking opens the person actions dialog. */
function Person({ name, email, onLookup }: { name: string; email: string; onLookup: LookupFn }) {
  const raw = !showAddress(name, email) && email && email !== name ? email : undefined
  return (
    <button
      onClick={() => onLookup({ name, email })}
      className="-mx-1 rounded px-1 text-left text-slate-200 transition hover:bg-slate-800"
      data-tip={raw}
    >
      {name || email || '(unknown sender)'}
      {showAddress(name, email) && <span className="text-slate-400"> &lt;{email}&gt;</span>}
    </button>
  )
}

function Recipients({ list, onLookup }: { list: RecipientInfo[]; onLookup: LookupFn }) {
  return (
    <>
      {list.map((r, i) => (
        <span key={`${r.email}-${i}`}>
          {i > 0 && '; '}
          <Person name={r.name} email={r.email} onLookup={onLookup} />
        </span>
      ))}
    </>
  )
}

/** Person actions: jump to their messages, and view their contact card. */
function ContactLookup({
  query,
  onClose,
}: {
  query: { name: string; email: string }
  onClose: () => void
}) {
  const [matches, setMatches] = useState<ContactMatch[] | null>(null)
  const [picked, setPicked] = useState<ContactMatch | null>(null)
  const [card, setCard] = useState<MessageContent | null>(null)
  const setSearchQuery = useApp((s) => s.setSearchQuery)
  const runSearch = useApp((s) => s.runSearch)

  useEffect(() => {
    let alive = true
    pst
      .findContacts(query.email, query.name)
      .then((r) => {
        if (!alive) return
        setMatches(r)
        if (r.length === 1) setPicked(r[0])
      })
      .catch(() => alive && setMatches([]))
    return () => {
      alive = false
    }
  }, [query])

  useEffect(() => {
    if (!picked) return
    let alive = true
    setCard(null)
    pst
      .getMessageContent(picked.sourceId, picked.messageId)
      .then((c) => alive && setCard(c))
      .catch(() => alive && setCard(null))
    return () => {
      alive = false
    }
  }, [picked])

  const showMessages = () => {
    const key = query.email.includes('@') ? query.email : query.name
    setSearchQuery(`person:"${key}"`)
    runSearch()
    onClose()
  }

  return (
    <Dialog title={query.name || query.email} onClose={onClose}>
      <div className="border-b border-slate-800 p-3">
        <button
          onClick={showMessages}
          className="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-left text-sm font-medium text-slate-200 transition hover:bg-slate-700/60"
        >
          <Search className="h-4 w-4 text-slate-400" />
          Show all messages with this person
        </button>
      </div>
      {matches === null && (
        <div className="p-6 text-center text-sm text-slate-400">Checking contacts…</div>
      )}
      {matches !== null && matches.length === 0 && (
        <div className="p-6 text-center text-sm text-slate-400">
          Not in the loaded mailboxes' contacts.
        </div>
      )}
      {matches !== null && matches.length > 1 && !picked && (
        <div className="p-3">
          {matches.map((m) => (
            <button
              key={`${m.sourceId}:${m.messageId}`}
              onClick={() => setPicked(m)}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800/70"
            >
              {m.name}
              {m.email && <span className="text-slate-400"> &lt;{m.email}&gt;</span>}
            </button>
          ))}
        </div>
      )}
      {picked && card && (
        <MessageView sourceId={picked.sourceId} messageId={picked.messageId} content={card} />
      )}
      {picked && !card && matches !== null && (
        <div className="p-6 text-center text-sm text-slate-400">Loading contact…</div>
      )}
    </Dialog>
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
