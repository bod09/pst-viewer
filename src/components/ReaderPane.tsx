import { type ReactNode } from 'react'
import { useApp } from '../store/store'
import { MessageView } from './MessageView'
import { Spinner } from './icons'

export function ReaderPane() {
  const sourceId = useApp((s) => s.selection.sourceId)
  const messageId = useApp((s) => s.selection.messageId)
  const content = useApp((s) => s.messageContent)
  const loading = useApp((s) => s.contentLoading)

  if (!messageId || !sourceId) return <Empty>Select a message to read</Empty>
  if (loading) {
    return (
      <Empty>
        <Spinner className="mb-2 h-5 w-5 text-sky-400" />
        Loading message…
      </Empty>
    )
  }
  if (!content) return <Empty>Could not load this message.</Empty>

  return (
    <div className="h-full min-h-0 overflow-hidden bg-slate-950">
      <MessageView key={messageId} sourceId={sourceId} messageId={messageId} content={content} />
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <section className="flex h-full flex-col items-center justify-center bg-slate-950 p-8 text-center text-sm text-slate-600">
      {children}
    </section>
  )
}
