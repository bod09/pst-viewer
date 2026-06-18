import { useEffect } from 'react'
import { useApp } from '../store/store'
import { Close, Search, Spinner } from './icons'

export function SearchBar() {
  const query = useApp((s) => s.searchQuery)
  const setQuery = useApp((s) => s.setSearchQuery)
  const runSearch = useApp((s) => s.runSearch)
  const clearSearch = useApp((s) => s.clearSearch)
  const searching = useApp((s) => s.searching)

  // Debounce the search as the user types.
  useEffect(() => {
    const t = setTimeout(() => runSearch(), 180)
    return () => clearTimeout(t)
  }, [query, runSearch])

  return (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search all mail…"
        className="w-full rounded-lg border border-slate-700 bg-slate-800/60 py-2 pl-9 pr-9 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
      />
      {searching ? (
        <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sky-400" />
      ) : (
        query && (
          <button
            onClick={clearSearch}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-slate-200"
            data-tip="Clear search"
          >
            <Close className="h-4 w-4" />
          </button>
        )
      )}
    </div>
  )
}
