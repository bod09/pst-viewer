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
  /** Theme base colour driving backgrounds/panels/text. Empty = default dark. */
  theme: string
}

export const DEFAULT_BRANDING: Branding = {
  name: 'PST Viewer',
  tagline: 'Local · Offline · Private',
  logo: '',
  accent: '',
  theme: '',
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

const USER_ACCENT_KEY = 'pstviewer.accent'
const USER_THEME_KEY = 'pstviewer.theme'

// The surface palette is the slate-* scale; regenerating it from one base
// colour re-themes backgrounds, borders and text tints in one move. The
// lightness/chroma ladder mirrors Tailwind's slate so contrast is preserved.
const THEME_LADDER: Array<[step: number, l: number, c: number]> = [
  [100, 96.8, 0.007],
  [200, 92.9, 0.013],
  [300, 86.9, 0.02],
  [400, 70.4, 0.035],
  [500, 55.4, 0.046],
  [600, 44.6, 0.043],
  [700, 37.2, 0.044],
  [800, 27.9, 0.042],
  [900, 20.8, 0.042],
  [950, 12.9, 0.042],
]

/** Exact OKLCh hue and chroma of a #rrggbb colour, so a custom theme keeps
 *  both the tone and the vividness of what was picked. */
function oklchOf(hex: string): { hue: number; chroma: number; L: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { hue: 257, chroma: 0.042, L: 0.35 }
  const n = parseInt(m[1], 16)
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const r = lin(n >> 16)
  const g = lin((n >> 8) & 0xff)
  const b = lin(n & 0xff)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s
  const b2 = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s
  const chroma = Math.sqrt(a * a + b2 * b2)
  const hue = ((Math.atan2(b2, a) * 180) / Math.PI + 360) % 360
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s
  return { hue, chroma, L }
}

// Surface lightness per step for a light theme (dark text on light panels);
// the dark ladder in THEME_LADDER simply scales with the picked lightness.
const LIGHT_L: Record<number, number> = {
  100: 21, 200: 30, 300: 40, 400: 50, 500: 60,
  600: 74, 700: 84, 800: 91, 900: 95, 950: 97.5,
}

function readUserTheme(): string {
  try {
    return localStorage.getItem(USER_THEME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function getUserTheme(): string {
  return readUserTheme()
}

export function setUserTheme(color: string): void {
  try {
    if (color) localStorage.setItem(USER_THEME_KEY, color)
    else localStorage.removeItem(USER_THEME_KEY)
  } catch {
    /* ignore */
  }
  applyTheme()
}

function applyTheme() {
  const base = readUserTheme() || current.theme
  const root = document.documentElement.style
  if (!base) {
    for (const [step] of THEME_LADDER) root.removeProperty(`--color-slate-${step}`)
    return
  }
  const { hue, chroma, L } = oklchOf(base)
  // How saturated the picked colour is relative to slate's own chroma decides
  // how vivid the whole ladder becomes; capped so text contrast survives.
  const scale = chroma < 0.015 ? 0 : Math.min(chroma / 0.042, 3)
  // The picked lightness sets how dark or light the whole theme is. Past the
  // midpoint the ladder flips to a light theme (dark text on light surfaces)
  // instead of wading through an unreadable grey middle.
  const light = L > 0.62
  const factor = 0.55 + L * 1.15 // dark themes: black picks go deeper, pale picks soften
  for (const [step, l, c] of THEME_LADDER) {
    // In dark themes only the surfaces (500-950) follow the picked lightness;
    // the text steps (100-400) stay bright so contrast holds on any depth.
    const lightness = light
      ? Math.min(LIGHT_L[step] + (L - 0.8) * 8, 98)
      : step >= 500
        ? Math.min(l * factor, 60)
        : l
    root.setProperty(
      `--color-slate-${step}`,
      `oklch(${lightness.toFixed(1)}% ${(c * scale).toFixed(4)} ${hue.toFixed(1)})`,
    )
  }
}

function readUserAccent(): string {
  try {
    return localStorage.getItem(USER_ACCENT_KEY) ?? ''
  } catch {
    return ''
  }
}

/** The user's own colour choice wins over the deployment's accent. */
export function getUserAccent(): string {
  return readUserAccent()
}

export function setUserAccent(color: string): void {
  try {
    if (color) localStorage.setItem(USER_ACCENT_KEY, color)
    else localStorage.removeItem(USER_ACCENT_KEY)
  } catch {
    /* ignore */
  }
  applyAccent()
}

function applyAccent() {
  const accent = readUserAccent() || current.accent
  const root = document.documentElement.style
  for (const [name, white] of ACCENT_TINTS) {
    if (accent) {
      root.setProperty(name, white ? `color-mix(in oklab, ${accent} ${100 - white}%, white)` : accent)
    } else {
      root.removeProperty(name)
    }
  }
}

function apply(b: Branding) {
  current = b
  document.title = b.name
  applyAccent()
  applyTheme()
  listeners.forEach((cb) => cb())
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Load branding.json (if customised) and apply it. Safe to call fire-and-forget. */
export async function initBranding(): Promise<void> {
  // The user's colour choices apply even if the branding file never loads.
  applyAccent()
  applyTheme()
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
      theme: str(o.theme),
    })
  } catch {
    // Missing or invalid file: keep defaults.
  }
}
