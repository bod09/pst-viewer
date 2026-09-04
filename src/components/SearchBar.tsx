import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/store'
import { pst } from '../worker/client'
import { Close, Search, Spinner } from './icons'

/** Split a query into panel fields (known key:value pairs) plus free words. */
function parseQuery(q: string) {
  const f = { words: [] as string[], from: '', to: '', subject: '', person: '',
    mailbox: '', folder: '',
    attachment: false, flagged: false, unread: false, importance: '', after: '', before: '' }
  const TOKEN = /(\w+):"([^"]*)"|(\w+):(\S+)|("[^"]*")|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(q))) {
    const key = (m[1] ?? m[3])?.toLowerCase()
    const val = m[2] ?? m[4] ?? ''
    if (key === 'from') f.from = val
    else if (key === 'to') f.to = val
    else if (key === 'subject') f.subject = val
    else if (key === 'person') f.person = val
    else if (key === 'mailbox') f.mailbox = val
    else if (key === 'folder') f.folder = val
    else if (key === 'after') f.after = val
    else if (key === 'before') f.before = val
    else if (key === 'has' && val.toLowerCase().startsWith('attach')) f.attachment = true
    else if (key === 'is' && val === 'flagged') f.flagged = true
    else if (key === 'is' && val === 'unread') f.unread = true
    else if (key === 'is' && (val === 'high' || val === 'low')) f.importance = val
    else f.words.push(m[5] ?? m[6] ?? `${key}:${val}`)
  }
  return f
}

type Fields = ReturnType<typeof parseQuery>

function buildQuery(f: Fields): string {
  const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v)
  const parts = [...f.words]
  if (f.from) parts.push(`from:${quote(f.from)}`)
  if (f.to) parts.push(`to:${quote(f.to)}`)
  if (f.subject) parts.push(`subject:${quote(f.subject)}`)
  if (f.person) parts.push(`person:${quote(f.person)}`)
  if (f.mailbox) parts.push(`mailbox:${quote(f.mailbox)}`)
  if (f.folder) parts.push(`folder:${quote(f.folder)}`)
  if (f.attachment) parts.push('has:attachment')
  if (f.importance) parts.push(`is:${f.importance}`)
  if (f.flagged) parts.push('is:flagged')
  if (f.unread) parts.push('is:unread')
  if (f.after) parts.push(`after:${f.after}`)
  if (f.before) parts.push(`before:${f.before}`)
  return parts.join(' ')
}

const inputCls =
  'w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none'

function ChipToggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
        on
          ? 'border-sky-500 bg-sky-500/20 text-sky-300'
          : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-500'
      }`}
    >
      {children}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </div>
  )
}

/** Text input with people suggestions from the loaded mailboxes. */
/** Suggestion list geometry: the panel is a two-column grid with a 0.75rem
 *  gap, so a list anchored in either column spans the full content width. */
const dropdownCls = (side: 'left' | 'right') =>
  `absolute top-full z-50 mt-1 max-h-64 w-[calc(200%+0.75rem)] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl ${
    side === 'left' ? 'left-0' : 'left-[calc(-100%-0.75rem)]'
  }`

/**
 * A text field with a suggestion list under it.
 *
 * Up and Down walk the list, Enter takes the highlighted entry and Escape
 * closes just the list. Tab takes the highlighted entry too and then moves to
 * the next filter; the entries are deliberately not tab stops, since tabbing
 * through every suggestion to reach the next field is nobody's idea of a
 * shortcut.
 */
function SuggestInput({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  side = 'left',
  transform,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder?: string
  ariaLabel?: string
  side?: 'left' | 'right'
  /** Turns a chosen entry into the value to store (e.g. just the address). */
  transform?: (entry: string) => string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const shown = options.slice(0, 50)
  const isOpen = open && shown.length > 0

  // Reset the highlight whenever the list changes underneath it.
  useEffect(() => setActive(-1), [options.join('\u0000')])

  // Keep the highlighted entry in view when walking a long list.
  useEffect(() => {
    if (active < 0) return
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (entry: string) => {
    onChange(transform ? transform(entry) : entry)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!isOpen) {
        setOpen(true)
        return
      }
      setActive((i) => (i + 1) % shown.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!isOpen) return
      setActive((i) => (i <= 0 ? shown.length - 1 : i - 1))
    } else if (e.key === 'Enter' && isOpen && active >= 0) {
      e.preventDefault()
      pick(shown[active])
    } else if (e.key === 'Escape' && isOpen) {
      // Only the list closes; the filter panel stays where it is.
      e.stopPropagation()
      setOpen(false)
      setActive(-1)
    } else if (e.key === 'Tab') {
      // Take the highlighted entry on the way out, then let Tab move focus
      // as usual: having walked to an entry, leaving should keep it rather
      // than throw the choice away.
      if (isOpen && active >= 0) pick(shown[active])
      else {
        setOpen(false)
        setActive(-1)
      }
    }
  }

  return (
    <div className="relative">
      <input
        className={inputCls}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={isOpen && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {isOpen && (
        <div ref={listRef} id={listId} role="listbox" className={dropdownCls(side)}>
          {shown.map((o, i) => (
            <div
              key={o}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer truncate px-3 py-1.5 text-left text-sm transition ${
                i === active ? 'bg-slate-800 text-slate-100' : 'text-slate-200'
              }`}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Free-text field offering names already present in the open mailboxes. */
function ListInput(props: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder?: string
  ariaLabel?: string
  side?: 'left' | 'right'
}) {
  const needle = props.value.trim().toLowerCase()
  const options = props.options.filter(
    (o) => !needle || (o.toLowerCase().includes(needle) && o.toLowerCase() !== needle),
  )
  return <SuggestInput {...props} options={options} />
}

/** Sender/recipient field, suggesting people seen in the open mailboxes. */
function PersonInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  side = 'left',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  ariaLabel?: string
  side?: 'left' | 'right'
}) {
  const [options, setOptions] = useState<string[]>([])

  useEffect(() => {
    if (!value.trim()) {
      setOptions([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      pst
        .suggestPeople(value, 6)
        .then((r) => {
          if (!alive) return
          setOptions(r.filter((o) => o.toLowerCase() !== value.toLowerCase()))
        })
        .catch(() => alive && setOptions([]))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [value])

  return (
    <SuggestInput
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      side={side}
      // Store just the address when the entry carries one.
      transform={(entry) => /<([^>]+)>\s*$/.exec(entry)?.[1] ?? entry}
    />
  )
}

export function SearchBar() {
  const query = useApp((s) => s.searchQuery)
  const setQuery = useApp((s) => s.setSearchQuery)
  const runSearch = useApp((s) => s.runSearch)
  const clearSearch = useApp((s) => s.clearSearch)
  const searching = useApp((s) => s.searching)
  const [panelOpen, setPanelOpen] = useState(false)
  const [fields, setFields] = useState<Fields>(() => parseQuery(''))
  const sources = useApp((s) => s.sources)
  const mailboxNames = useMemo(
    () => sources.filter((s) => s.status === 'ready').map((s) => s.label).filter(Boolean),
    [sources],
  )
  const showEmptyFolders = useApp((s) => s.showEmptyFolders)
  const folderNames = useMemo(() => {
    const names = new Set<string>()
    type Node = { name: string; messageCount: number; children: Node[] }
    const walk = (n: Node) => {
      // Only folders that hold messages can match, so an empty one would just
      // return nothing. They are listed only when empty folders are shown.
      const worthListing = showEmptyFolders || n.messageCount > 0
      if (worthListing && n.name && n.name !== '(unnamed folder)') names.add(n.name)
      for (const c of n.children) walk(c)
    }
    for (const src of sources) if (src.index) walk(src.index.rootFolder as unknown as Node)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [sources, showEmptyFolders])
  const wrapRef = useRef<HTMLDivElement>(null)

  // Debounce the search as the user types.
  useEffect(() => {
    const t = setTimeout(() => runSearch(), 180)
    return () => clearTimeout(t)
  }, [query, runSearch])

  // Close the filter panel on outside click or Escape.
  useEffect(() => {
    if (!panelOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      // Picking a suggestion removes it from the page before this runs, and a
      // detached node is inside nothing: treating that as a click outside
      // closed the whole panel and threw the choice away.
      if (!document.contains(target)) return
      if (wrapRef.current && !wrapRef.current.contains(target)) setPanelOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanelOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [panelOpen])

  const openPanel = () => {
    setFields(parseQuery(query))
    setPanelOpen(true)
  }
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }))
  const apply = () => {
    setQuery(buildQuery(fields))
    setPanelOpen(false)
  }
  const reset = () => setFields(parseQuery(fields.words.join(' ')))

  return (
    <div ref={wrapRef} className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={openPanel}
        placeholder="Search all mail…"
        className="w-full rounded-lg border border-slate-700 bg-slate-800/60 py-2 pl-9 pr-9 text-sm text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
      />
      {searching ? (
        <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sky-400" />
      ) : (
        query && (
          <button
            onClick={clearSearch}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-200"
            data-tip="Clear search"
          >
            <Close className="h-4 w-4" />
          </button>
        )
      )}

      {panelOpen && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1.5 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <PersonInput
                value={fields.from}
                onChange={(v) => set({ from: v })}
                placeholder="Name or address"
                ariaLabel="From"
              />
            </Field>
            <Field label="To">
              <PersonInput
                value={fields.to}
                onChange={(v) => set({ to: v })}
                placeholder="Name or address"
                ariaLabel="To"
                side="right"
              />
            </Field>
            <Field label="Subject contains">
              <input
                className={inputCls}
                aria-label="Subject contains"
                value={fields.subject}
                onChange={(e) => set({ subject: e.target.value })}
              />
            </Field>
            <Field label="Person">
              <PersonInput
                value={fields.person}
                onChange={(v) => set({ person: v })}
                placeholder="Sender or any recipient, incl. Cc/Bcc"
                ariaLabel="Person"
                side="right"
              />
            </Field>
            <Field label="Mailbox">
              <ListInput
                value={fields.mailbox}
                onChange={(v) => set({ mailbox: v })}
                options={mailboxNames}
                placeholder="All mailboxes"
                ariaLabel="Mailbox"
              />
            </Field>
            <Field label="Folder">
              <ListInput
                value={fields.folder}
                onChange={(v) => set({ folder: v })}
                options={folderNames}
                placeholder="All folders"
                ariaLabel="Folder"
                side="right"
              />
            </Field>
            <Field label="After">
              <input
                type="date"
                className={inputCls}
                aria-label="After"
                value={fields.after}
                onChange={(e) => set({ after: e.target.value })}
              />
            </Field>
            <Field label="Before">
              <input
                type="date"
                className={inputCls}
                aria-label="Before"
                value={fields.before}
                onChange={(e) => set({ before: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ChipToggle on={fields.attachment} onClick={() => set({ attachment: !fields.attachment })}>
              Has attachment
            </ChipToggle>
            <ChipToggle
              on={fields.importance === 'high'}
              onClick={() => set({ importance: fields.importance === 'high' ? '' : 'high' })}
            >
              High importance
            </ChipToggle>
            <ChipToggle
              on={fields.importance === 'low'}
              onClick={() => set({ importance: fields.importance === 'low' ? '' : 'low' })}
            >
              Low importance
            </ChipToggle>
            <ChipToggle on={fields.flagged} onClick={() => set({ flagged: !fields.flagged })}>
              Flagged
            </ChipToggle>
            <ChipToggle on={fields.unread} onClick={() => set({ unread: !fields.unread })}>
              Unread
            </ChipToggle>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[11px] text-slate-500">
              Tip: quotes search an exact phrase, e.g. "quarterly report"
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={reset}
                className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-700/60"
              >
                Reset
              </button>
              <button
                onClick={apply}
                className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400"
              >
                Search
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
