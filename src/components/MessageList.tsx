import { memo, useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useApp } from '../store/store'
import type { MessageMeta } from '../types'
import { formatDateShort } from '../lib/format'
import { Paperclip, Spinner } from './icons'

export function MessageList() {
  const messages = useApp((s) => s.messages)
  const unreadable = useApp((s) => s.messagesUnreadable)
  const loading = useApp((s) => s.messagesLoading)
  const sourceId = useApp((s) => s.selection.sourceId)
  const folderId = useApp((s) => s.selection.folderId)
  const selectedId = useApp((s) => s.selection.messageId)
  const selectMessage = useApp((s) => s.selectMessage)
  const exportSel = useApp((s) => s.exportSel)
  const toggleExport = useApp((s) => s.toggleExport)

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 68,
    overscan: 12,
  })

  return (
    <section className="flex h-full min-h-0 flex-col border-r border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Messages
        </span>
        {messages.length > 0 && (
          <span className="text-[11px] text-slate-400">{messages.length}</span>
        )}
      </div>

      {unreadable > 0 && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-300">
          {unreadable} {unreadable === 1 ? 'message' : 'messages'} here could not be read. The file
          may be damaged; everything readable is still shown.
        </div>
      )}

      {!folderId ? (
        <Centered>Select a folder</Centered>
      ) : loading ? (
        <Centered>
          <Spinner className="mb-2 h-5 w-5 text-sky-400" />
          Loading messages…
        </Centered>
      ) : messages.length === 0 ? (
        <Centered>No messages in this folder</Centered>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const message = messages[item.index]
              return (
                <div
                  key={message.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <MessageRow
                    message={message}
                    selected={message.id === selectedId}
                    exportChecked={!!sourceId && !!exportSel[`${sourceId}:${message.id}`]}
                    sourceId={sourceId}
                    onSelect={selectMessage}
                    onToggleExport={toggleExport}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

const MessageRow = memo(function MessageRow({
  message,
  selected,
  exportChecked,
  sourceId,
  onSelect,
  onToggleExport,
}: {
  message: MessageMeta
  selected: boolean
  exportChecked: boolean
  sourceId: string | null
  onSelect: (messageId: string) => void
  onToggleExport: (sourceId: string, messageId: string) => void
}) {
  // Contacts and distribution lists have no real sender; their name lives in the
  // subject, so show that in bold rather than an internal owner field.
  const isCardItem = /^IPM\.(Contact|DistList)/i.test(message.messageClass || '')
  const primary = isCardItem
    ? message.subject || '(no name)'
    : message.fromName || message.fromEmail || '(unknown sender)'
  const secondary = isCardItem ? '' : message.subject
  return (
    <div
      className={`flex h-full w-full items-stretch border-b border-b-slate-800/70 border-l-2 transition ${
        selected ? 'border-l-sky-400 bg-sky-500/15' : 'border-l-transparent hover:bg-slate-800/40'
      }`}
    >
      <label
        className="flex cursor-pointer items-center pl-3 pr-1"
        data-tip="Select for PDF export"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={exportChecked}
          onChange={() => sourceId && onToggleExport(sourceId, message.id)}
          className="h-4 w-4 cursor-pointer accent-sky-500"
        />
      </label>
      <button onClick={() => onSelect(message.id)} className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 pr-3 text-left">
        <div className="flex items-center gap-2">
          {!message.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-400" />}
          <span
            className={`min-w-0 flex-1 truncate text-sm ${
              message.isRead ? 'text-slate-300' : 'font-semibold text-slate-100'
            }`}
            data-tip={isCardItem ? primary : message.fromEmail || primary}
          >
            {primary}
          </span>
          {message.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
          {!isCardItem && (
            <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
              {formatDateShort(message.date)}
            </span>
          )}
        </div>
        {secondary && (
          <div className="truncate text-[13px] text-slate-400" data-tip={secondary}>
            {secondary}
          </div>
        )}
      </button>
    </div>
  )
})

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-sm text-slate-400">
      {children}
    </div>
  )
}
