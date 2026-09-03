import { useState } from 'react'
import { useApp } from '../store/store'
import { getUserAccent, setUserAccent, getUserTheme, setUserTheme } from '../lib/branding'
import { Dialog } from './Dialog'

export function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="3.2" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.51 1z"
      />
    </svg>
  )
}

/** Subtle gear button opening the settings dialog. */
export function SettingsButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 ${className ?? ''}`}
        data-tip="Settings"
        aria-label="Settings"
      >
        <GearIcon className="h-5 w-5" />
      </button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/** Animated on/off switch. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
        checked ? 'bg-sky-500' : 'bg-slate-700'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ocrEnabled = useApp((s) => s.ocrEnabled)
  const setOcrEnabled = useApp((s) => s.setOcrEnabled)
  const showEmptyFolders = useApp((s) => s.showEmptyFolders)
  const setShowEmptyFolders = useApp((s) => s.setShowEmptyFolders)
  const allowRemoteContent = useApp((s) => s.allowRemoteContent)
  const setAllowRemoteContent = useApp((s) => s.setAllowRemoteContent)

  return (
    <Dialog title="Settings" onClose={onClose} size="sm">
      <div className="space-y-5 p-5">
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-medium text-slate-100">
              Make text in images searchable
            </div>
            <div className="mt-1 text-xs leading-relaxed text-slate-400">
              Reads text in pictures (OCR) so it shows up in search. Turn off to skip it,
              since reading images makes opening a mailbox take longer.
            </div>
          </div>
          <Toggle checked={ocrEnabled} onChange={setOcrEnabled} label="Make text in images searchable" />
        </div>
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-medium text-slate-100">Load images from the internet</div>
            <div className="mt-1 text-xs leading-relaxed text-slate-400">
              Some emails link to pictures stored online instead of including them. Turn this
              off to show only what is inside the file, so opening a message never contacts
              the sender.
            </div>
          </div>
          <Toggle
            checked={allowRemoteContent}
            onChange={setAllowRemoteContent}
            label="Load images from the internet"
          />
        </div>
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-medium text-slate-100">Show empty folders</div>
            <div className="mt-1 text-xs leading-relaxed text-slate-400">
              Outlook creates the full folder set in every mailbox. Turn on to also list the
              folders that contain no messages.
            </div>
          </div>
          <Toggle checked={showEmptyFolders} onChange={setShowEmptyFolders} label="Show empty folders" />
        </div>
        <ColorRow
          title="Theme"
          description="The overall look: backgrounds, panels and text."
          presets={THEME_PRESETS}
          defaultSwatch="oklch(27.9% 0.042 257)"
          read={getUserTheme}
          write={setUserTheme}
        />
        <ColorRow
          title="Accent"
          description="Used for highlights, buttons and selection."
          presets={ACCENT_PRESETS}
          defaultSwatch="oklch(68.5% 0.169 237.3)"
          read={getUserAccent}
          write={setUserAccent}
        />
      </div>
    </Dialog>
  )
}

// Restrained, corporate-friendly tones: default blue, indigo, teal, bronze,
// burgundy, steel.
const ACCENT_PRESETS = ['', '#4f46e5', '#0d9488', '#b45309', '#9f1239', '#64748b']
// Theme presets: default slate, paper light, graphite, deep navy, forest,
// warm charcoal.
const THEME_PRESETS = ['', '#eef1f5', '#2e2e33', '#1b2a44', '#1d3229', '#2b2320']

function ColorRow({
  title,
  description,
  presets,
  defaultSwatch,
  read,
  write,
}: {
  title: string
  description: string
  presets: string[]
  defaultSwatch: string
  read: () => string
  write: (v: string) => void
}) {
  const [value, setValue] = useState(read())
  const pick = (color: string) => {
    write(color)
    setValue(color)
  }
  const isCustom = value !== '' && !presets.includes(value)
  const ring = (on: boolean) =>
    on
      ? 'ring-2 ring-slate-200 ring-offset-2 ring-offset-slate-900'
      : 'hover:ring-2 hover:ring-slate-500 hover:ring-offset-2 hover:ring-offset-slate-900'

  return (
    <div>
      <div className="text-sm font-medium text-slate-100">{title}</div>
      <div className="mt-1 text-xs leading-relaxed text-slate-400">{description}</div>
      <div className="mt-2.5 flex items-center gap-2.5">
        {presets.map((c) => (
          <button
            key={c || 'default'}
            onClick={() => pick(c)}
            data-tip={c ? undefined : 'Default'}
            aria-label={c ? `${title}: ${c}` : `${title}: default`}
            className={`h-6 w-6 rounded-full transition ${ring(value === c)}`}
            style={{ backgroundColor: c || defaultSwatch }}
          />
        ))}
        <label
          data-tip="Custom colour"
          className={`relative h-6 w-6 cursor-pointer overflow-hidden rounded-full transition ${ring(isCustom)}`}
          style={{
            background: isCustom
              ? value
              : 'conic-gradient(#e11d48, #d97706, #059669, #0891b2, #7c3aed, #e11d48)',
          }}
        >
          <input
            type="color"
            value={isCustom ? value : '#38bdf8'}
            onChange={(e) => pick(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>
    </div>
  )
}
