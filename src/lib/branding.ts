import { useSyncExternalStore } from 'react'

/**
 * Runtime branding: `branding.json` is fetched from the web root at startup,
 * so a deployment can rebrand the app (name, tagline, logo, accent colour)
 * by replacing one file - e.g. a bind mount into the Docker image - with no
 * rebuild. See the Branding section in README.md.
 */

export interface Branding {
  /** Product name shown in the header and the browser tab. */
  name: string
  /** Short line under the name. */
  tagline: string
  /** Image URL for the header logo (path, or data: URI). Empty = default icon. */
  logo: string
  /** Accent colour (any CSS colour). Tints are derived from it. Empty = default. */
  accent: string
}

export const DEFAULT_BRANDING: Branding = {
  name: 'PST Viewer',
  tagline: 'Local · Offline · Private',
  logo: '',
  accent: '',
}

let current: Branding = DEFAULT_BRANDING
const listeners = new Set<() => void>()

export function useBranding(): Branding {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}

// Tailwind v4 exposes its palette as CSS custom properties and every utility
// class reads through them, so overriding the sky-* variables re-accents the
// whole UI. Lighter steps are derived by mixing the accent towards white.
const ACCENT_TINTS: Array<[string, number]> = [
  ['--color-sky-500', 0],
  ['--color-sky-400', 18],
  ['--color-sky-300', 36],
  ['--color-sky-200', 55],
  ['--color-sky-100', 75],
]

function apply(b: Branding) {
  current = b
  document.title = b.name
  if (b.accent) {
    const root = document.documentElement.style
    for (const [name, white] of ACCENT_TINTS) {
      root.setProperty(name, white ? `color-mix(in oklab, ${b.accent} ${100 - white}%, white)` : b.accent)
    }
  }
  listeners.forEach((cb) => cb())
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Load branding.json (if customised) and apply it. Safe to call fire-and-forget. */
export async function initBranding(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}branding.json`, { cache: 'no-cache' })
    if (!res.ok) return
    const raw: unknown = await res.json()
    if (typeof raw !== 'object' || raw === null) return
    const o = raw as Record<string, unknown>
    apply({
      name: str(o.name) || DEFAULT_BRANDING.name,
      tagline: str(o.tagline) || DEFAULT_BRANDING.tagline,
      logo: str(o.logo),
      accent: str(o.accent),
    })
  } catch {
    // Missing or invalid file: keep defaults.
  }
}
