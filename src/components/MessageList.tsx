import { useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useApp } from '../store/store'
import type { MessageMeta } from '../types'
import { formatDateShort } from '../lib/format'
import { Paperclip, Spinner } from './icons'

export function MessageList() {
  const messages = useApp((s) => s.messages)
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
          <span className="text-[11px] text-slate-500">{messages.length}</span>
        )}
      </div>

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
                    onClick={() => selectMessage(message.id)}
                    onToggleExport={() => sourceId && toggleExport(sourceId, message.id)}
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

function MessageRow({
  message,
  selected,
  exportChecked,
  onClick,
  onToggleExport,
}: {
  message: MessageMeta
  selected: boolean
  exportChecked: boolean
  onClick: () => void
  onToggleExport: () => void
}) {
  const from = message.fromName || message.fromEmail || '(unknown sender)'
  return (
    <div
      className={`flex h-full w-full items-stretch border-b border-slate-800/70 transition ${
        selected ? 'bg-sky-500/15' : 'hover:bg-slate-800/40'
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
          onChange={onToggleExport}
          className="h-4 w-4 cursor-pointer accent-sky-500"
        />
      </label>
      <button onClick={onClick} className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 pr-3 text-left">
        <div className="flex items-center gap-2">
          {!message.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-400" />}
          <span
            className={`min-w-0 flex-1 truncate text-sm ${
              message.isRead ? 'text-slate-300' : 'font-semibold text-slate-100'
            }`}
            data-tip={message.fromEmail || from}
          >
            {from}
          </span>
          {message.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
          <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
            {formatDateShort(message.date)}
          </span>
        </div>
        <div className="truncate text-[13px] text-slate-400" data-tip={message.subject}>
          {message.subject}
        </div>
      </button>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-sm text-slate-600">
      {children}
    </div>
  )
}
