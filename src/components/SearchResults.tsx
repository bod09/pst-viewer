import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useApp } from '../store/store'
import type { SearchHit } from '../types'
import { formatDateShort } from '../lib/format'
import { Paperclip, Spinner } from './icons'

export function SearchResults() {
  const results = useApp((s) => s.searchResults)
  const searching = useApp((s) => s.searching)
  const query = useApp((s) => s.searchQuery)
  const selectedId = useApp((s) => s.selection.messageId)
  const openHit = useApp((s) => s.openHit)
  const sources = useApp((s) => s.sources)
  const exportSel = useApp((s) => s.exportSel)
  const toggleExport = useApp((s) => s.toggleExport)
  const anyIndexing = sources.some((s) => s.status === 'ready' && !s.indexed)

  const labelFor = (id: string) => sources.find((s) => s.id === id)?.label ?? ''

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 68,
    overscan: 12,
  })

  return (
    <section className="flex h-full min-h-0 flex-col border-r border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Search results
        </span>
        {results.length > 0 && (
          <span className="text-[11px] text-slate-500">{results.length}</span>
        )}
      </div>

      {results.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-600">
          {searching ? (
            <>
              <Spinner className="h-5 w-5 text-sky-400" />
              Searching…
            </>
          ) : (
            <>
              <div>No matches for “{query}”.</div>
              {anyIndexing && (
                <div className="text-xs text-slate-500">Still indexing, try again shortly.</div>
              )}
            </>
          )}
        </div>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const hit = results[item.index]
              return (
                <div
                  key={`${hit.sourceId}:${hit.messageId}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <HitRow
                    hit={hit}
                    sourceLabel={labelFor(hit.sourceId)}
                    selected={hit.messageId === selectedId}
                    exportChecked={!!exportSel[`${hit.sourceId}:${hit.messageId}`]}
                    onClick={() => openHit(hit)}
                    onToggleExport={() => toggleExport(hit.sourceId, hit.messageId)}
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

function HitRow({
  hit,
  sourceLabel,
  selected,
  exportChecked,
  onClick,
  onToggleExport,
}: {
  hit: SearchHit
  sourceLabel: string
  selected: boolean
  exportChecked: boolean
  onClick: () => void
  onToggleExport: () => void
}) {
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
          <span className="min-w-0 flex-1 truncate text-sm text-slate-200" data-tip={hit.subject}>
            {hit.subject || '(no subject)'}
          </span>
          {hit.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
          <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
            {formatDateShort(hit.date)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-slate-500">
          <span className="truncate">{hit.from || '(unknown)'}</span>
          {sourceLabel && (
            <>
              <span className="text-slate-700">·</span>
              <span className="shrink-0 truncate text-slate-600">{sourceLabel}</span>
            </>
          )}
        </div>
      </button>
    </div>
  )
}
