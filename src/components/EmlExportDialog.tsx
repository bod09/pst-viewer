import { useApp, type EmlExportJob } from '../store/store'
import { Dialog } from './Dialog'
import { Alert, Spinner } from './icons'

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

/** Progress, and then the outcome, of an export to a folder of .eml files. */
export function EmlExportDialog() {
  const job = useApp((s) => s.emlExport)
  const cancel = useApp((s) => s.cancelEmlExport)
  const close = useApp((s) => s.closeEmlExport)
  if (!job) return null

  const running = job.status === 'running'
  const title =
    job.status === 'unsupported'
      ? 'Export as .eml files'
      : running
        ? `Exporting ${job.title}`
        : `Export of ${job.title}`

  return (
    <Dialog title={title} onClose={close} size="sm" dismissible={!running}>
      <div role="status" aria-live="polite" className="space-y-4 p-5 text-sm leading-relaxed">
        {job.status === 'unsupported' ? (
          <Unsupported />
        ) : running ? (
          <Running job={job} />
        ) : (
          <Summary job={job} />
        )}
        <div className="flex justify-end">
          {running ? (
            <button
              onClick={cancel}
              className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 font-medium text-slate-200 transition hover:bg-slate-700/60"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={close}
              className="rounded-md bg-sky-500 px-3 py-1.5 font-medium text-white transition hover:bg-sky-400"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function Unsupported() {
  return (
    <p className="text-slate-300">
      Exporting many messages at once needs a Chromium-based browser, such as Chrome or Edge.
      It saves each message straight into a folder you choose, and this browser does not let
      web pages do that. Single messages can still be saved one at a time with the EML or PDF
      button.
    </p>
  )
}

function Running({ job }: { job: EmlExportJob }) {
  const done = job.exported + job.skipped
  // Folders give their counts up front, but files that would not open at all
  // are only found on the way, so the total can grow.
  const total = Math.max(job.total, done)
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <>
      <div className="flex items-center gap-2 text-slate-200">
        <Spinner className="h-4 w-4 shrink-0 text-sky-400" />
        <span>
          {done.toLocaleString()} of {plural(total, 'message')}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full bg-sky-500 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      {job.folders > 0 && (
        <p className="truncate text-slate-400" data-tip={job.current}>
          Folder {Math.min(job.foldersDone + 1, job.folders).toLocaleString()} of{' '}
          {job.folders.toLocaleString()}: {job.current}
        </p>
      )}
      {job.directory && (
        <p className="text-slate-400">
          Saving into <span className="text-slate-200">{job.directory}</span>, in the folder you
          chose.
        </p>
      )}
      {job.skipped > 0 && <Skipped n={job.skipped} />}
    </>
  )
}

function Summary({ job }: { job: EmlExportJob }) {
  const where = job.directory ? (
    <>
      {' '}
      into <span className="text-slate-100">{job.directory}</span>
    </>
  ) : null
  return (
    <>
      {job.status === 'done' && (
        <p className="text-slate-200">
          Saved {plural(job.exported, 'message')} as .eml files{where}, in the folder you chose.
        </p>
      )}
      {job.status === 'cancelled' && (
        <p className="text-slate-200">
          Export cancelled. {plural(job.exported, 'message')}{' '}
          {job.exported === 1 ? 'was' : 'were'} saved{where} before it stopped, each one complete.
        </p>
      )}
      {job.status === 'failed' && (
        <div className="flex gap-2 text-rose-300">
          <Alert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            The export stopped{job.error ? `: ${job.error.replace(/\.?$/, '')}` : ''}.{' '}
            {plural(job.exported, 'message')} {job.exported === 1 ? 'was' : 'were'}{' '}
            saved{where} before that.
          </p>
        </div>
      )}
      {job.skipped > 0 && <Skipped n={job.skipped} />}
    </>
  )
}

function Skipped({ n }: { n: number }) {
  return (
    <p className="text-amber-300">
      {plural(n, 'message')} could not be read, probably because of damage to the file, and{' '}
      {n === 1 ? 'was' : 'were'} skipped.
    </p>
  )
}

