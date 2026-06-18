/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** Format an epoch-ms timestamp as a short local date-time, or "" if null. */
export function formatDate(ms: number | null | undefined): string {
  if (ms == null) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Compact list-friendly date: time if today, "MMM d" this year, else "MMM d, yyyy". */
export function formatDateShort(ms: number | null | undefined): string {
  if (ms == null) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  )
}
