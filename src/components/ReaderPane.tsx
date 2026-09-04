import { type ReactNode } from 'react'
import { useApp } from '../store/store'
import { MessageView } from './MessageView'
import { Spinner } from './icons'

export function ReaderPane() {
  const sourceId = useApp((s) => s.selection.sourceId)
  const messageId = useApp((s) => s.selection.messageId)
  const content = useApp((s) => s.messageContent)
  const loading = useApp((s) => s.contentLoading)
  const retryMessage = useApp((s) => s.retryMessage)

  if (!messageId || !sourceId) return <Empty>Select a message to read</Empty>
  if (loading) {
    return (
      <Empty>
        <Spinner className="mb-2 h-5 w-5 text-sky-400" />
        Loading message…
      </Empty>
    )
  }
  if (!content) {
    return (
      <Empty>
        <p className="max-w-sm leading-relaxed">
          This message could not be read. If the mailbox was moved or changed since it was
          opened, open the file again to carry on.
        </p>
        <button
          onClick={retryMessage}
          className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/60"
        >
          Try again
        </button>
      </Empty>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-hidden bg-slate-950">
      <MessageView key={messageId} sourceId={sourceId} messageId={messageId} content={content} />
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <section className="flex h-full flex-col items-center justify-center bg-slate-950 p-8 text-center text-sm text-slate-400">
      {children}
    </section>
  )
}
