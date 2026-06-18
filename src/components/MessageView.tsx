import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useApp } from '../store/store'
import type { MessageContent, RecipientInfo } from '../types'
import { formatDate } from '../lib/format'
import { categoryFromNameMime } from '../lib/detectType'
import { sanitizeEmailHtml } from '../lib/sanitizeHtml'
import { EmailFrame } from './EmailFrame'
import { AttachmentBar } from './attachments/AttachmentBar'
import { Printer } from './icons'

export function MessageView({
  sourceId,
  messageId,
  content,
}: {
  sourceId: string
  messageId: string
  content: MessageContent
}) {
  const [allowRemote, setAllowRemote] = useState(false)

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

  const sanitized = useMemo(
    () => (content.html ? sanitizeEmailHtml(content.html, cidUrls, allowRemote) : null),
    [content.html, cidUrls, allowRemote],
  )

  // Hide only inline *images* (they render inside the body); everything else —
  // including inline PDFs — stays visible as a downloadable/previewable chip.
  const exportSingle = useApp((s) => s.exportSingle)
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
          {!exportSelectionActive && (
            <button
              onClick={() => exportSingle(sourceId, messageId)}
              disabled={exporting}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60 disabled:opacity-60"
              data-tip="Save this email as PDF"
            >
              <Printer className="h-4 w-4" /> PDF
            </button>
          )}
        </div>
        <div className="mt-3 space-y-1 text-sm">
          <HeaderLine label="From">
            <span className="text-slate-200">{from}</span>
            {content.fromEmail && content.fromName && (
              <span className="text-slate-500"> &lt;{content.fromEmail}&gt;</span>
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
          {content.date != null && <HeaderLine label="Date">{formatDate(content.date)}</HeaderLine>}
        </div>
      </div>

      {visibleAttachments.length > 0 && (
        <AttachmentBar
          sourceId={sourceId}
          messageId={messageId}
          attachments={visibleAttachments}
        />
      )}

      {sanitized?.blockedRemote && !allowRemote && (
        <div className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-sm text-amber-200">
          <span>Remote images were blocked to protect your privacy.</span>
          <button
            onClick={() => setAllowRemote(true)}
            className="shrink-0 rounded-md bg-amber-500/20 px-3 py-1 font-medium transition hover:bg-amber-500/30"
          >
            Load remote content
          </button>
        </div>
      )}

      <div className="scroll-clear min-h-0 flex-1 overflow-y-auto">
        {sanitized ? (
          <EmailFrame html={sanitized.html} />
        ) : content.text ? (
          <pre className="m-0 min-h-full whitespace-pre-wrap break-words bg-white px-6 py-4 font-sans text-sm text-slate-900">
            {content.text}
          </pre>
        ) : (
          <div className="p-8 text-center text-sm text-slate-600">(No message content)</div>
        )}
      </div>
    </section>
  )
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

function HeaderLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 text-slate-300">{children}</span>
    </div>
  )
}
