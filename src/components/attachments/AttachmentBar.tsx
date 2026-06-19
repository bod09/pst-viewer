import { useState } from 'react'
import type { AttachmentMeta } from '../../types'
import { formatBytes } from '../../lib/format'
import { categoryFromNameMime, type PreviewCategory } from '../../lib/detectType'
import { AttachmentPreview } from './AttachmentPreview'
import { FileGeneric, MailIcon, Search } from '../icons'

export function AttachmentBar({
  sourceId,
  messageId,
  attachments,
  ocrHits = [],
}: {
  sourceId: string
  messageId: string
  attachments: AttachmentMeta[]
  ocrHits?: number[]
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const openMeta = openIndex == null ? null : attachments.find((a) => a.index === openIndex) ?? null

  return (
    <div className="border-b border-slate-800 bg-slate-900/40 px-6 py-2.5">
      <div className="flex flex-wrap gap-2">
        {attachments.map((a) => (
          <Chip
            key={a.index}
            meta={a}
            matched={ocrHits.includes(a.index)}
            onClick={() => setOpenIndex(a.index)}
          />
        ))}
      </div>

      {openMeta && (
        <AttachmentPreview
          sourceId={sourceId}
          messageId={messageId}
          meta={openMeta}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </div>
  )
}

const CATEGORY_BADGE: Record<PreviewCategory, string> = {
  image: 'bg-emerald-500/15 text-emerald-300',
  pdf: 'bg-rose-500/15 text-rose-300',
  text: 'bg-slate-500/20 text-slate-300',
  audio: 'bg-violet-500/15 text-violet-300',
  video: 'bg-fuchsia-500/15 text-fuchsia-300',
  email: 'bg-sky-500/15 text-sky-300',
  office: 'bg-blue-500/15 text-blue-300',
  archive: 'bg-amber-500/15 text-amber-300',
  other: 'bg-slate-500/20 text-slate-300',
}

function Chip({
  meta,
  matched,
  onClick,
}: {
  meta: AttachmentMeta
  matched?: boolean
  onClick: () => void
}) {
  const category = meta.isEmbeddedMessage ? 'email' : categoryFromNameMime(meta.name, meta.mime)
  const ext = meta.isEmbeddedMessage ? 'EML' : extLabel(meta.name)
  return (
    <button
      onClick={onClick}
      className={`group flex max-w-[18rem] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition ${
        matched
          ? 'border-amber-400/70 bg-amber-400/10 ring-2 ring-amber-400/60 hover:bg-amber-400/15'
          : 'border-slate-700 bg-slate-800/60 hover:border-slate-600 hover:bg-slate-700/60'
      }`}
      data-tip={matched ? `${meta.name} (contains your search text)` : meta.name}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${CATEGORY_BADGE[category]}`}
      >
        {meta.isEmbeddedMessage ? (
          <MailIcon className="h-4 w-4" />
        ) : ext ? (
          <span className="text-[9px] font-bold">{ext}</span>
        ) : (
          <FileGeneric className="h-4 w-4" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm text-slate-200">{meta.name}</span>
        {meta.size > 0 && (
          <span className="block text-[11px] text-slate-400">{formatBytes(meta.size)}</span>
        )}
      </span>
      {matched && <Search className="ml-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />}
    </button>
  )
}

function extLabel(name: string): string {
  const m = /\.([A-Za-z0-9]{1,4})$/.exec(name)
  return m ? m[1].toUpperCase() : ''
}
