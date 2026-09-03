import { useState } from 'react'
import { useApp } from '../store/store'
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
      >
        <GearIcon className="h-5 w-5" />
      </button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/** Animated on/off switch. */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
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
          <Toggle checked={ocrEnabled} onChange={setOcrEnabled} />
        </div>
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-medium text-slate-100">Show empty folders</div>
            <div className="mt-1 text-xs leading-relaxed text-slate-400">
              Outlook creates the full folder set in every mailbox. Turn on to also list the
              folders that contain no messages.
            </div>
          </div>
          <Toggle checked={showEmptyFolders} onChange={setShowEmptyFolders} />
        </div>
      </div>
    </Dialog>
  )
}
