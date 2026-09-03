/**
 * The terms to highlight for a query, using the same grammar as search:
 * key:value filter tokens are not highlighted (they constrain fields, they are
 * not text being looked for), a quoted phrase highlights as one whole phrase,
 * and a free token highlights exactly as typed.
 */
const FILTER_KEYS = new Set(['from', 'to', 'subject', 'person', 'has', 'is', 'before', 'after'])

export function queryTerms(query: string): string[] {
  const out = new Set<string>()
  const TOKEN = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(query))) {
    const key = (m[1] ?? m[3])?.toLowerCase()
    if (key && FILTER_KEYS.has(key)) continue
    const raw = (m[5] ?? m[6] ?? `${key}:${m[2] ?? m[4]}`).trim().toLowerCase()
    if (raw.length >= 2) out.add(raw)
  }
  return [...out]
}

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A case-insensitive regex matching any of the given (already-escaped-safe) terms. */
export function termsRegExp(terms: string[]): RegExp | null {
  if (!terms.length) return null
  return new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
}
