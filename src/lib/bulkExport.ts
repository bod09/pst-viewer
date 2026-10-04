/**
 * Saving many messages at once as a folder tree of .eml files.
 *
 * Files are written straight to a folder the user picks, through the File
 * System Access API, one message at a time; nothing is gathered in memory
 * first, which is what lets a mailbox of many gigabytes be exported at all.
 * The API exists only in Chromium-based browsers, so elsewhere the export
 * explains that instead of starting.
 *
 * Every name written to disk comes from the mail file (folder names and
 * subjects), so all of them are treated as hostile: see safeName.
 */

type DirectoryPicker = (options?: {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: string
}) => Promise<FileSystemDirectoryHandle>

const picker = (): DirectoryPicker | undefined =>
  (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker

/** Whether this browser can write a folder tree to disk. */
export function canExportToFolder(): boolean {
  return typeof picker() === 'function'
}

/** Ask for the folder to export into; null when the user cancels. */
export async function pickExportFolder(): Promise<FileSystemDirectoryHandle | null> {
  const show = picker()
  if (!show) return null
  try {
    return await show({ id: 'pstviewer-export', mode: 'readwrite', startIn: 'documents' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

// Characters that are not allowed, or not safe, in a file name on at least one
// common system, plus controls, invisible formatting characters (which include
// the right-to-left override that can disguise an extension), line and
// paragraph separators, and unpaired surrogates.
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f<>:"\/\\|?*\p{Cf}\u2028\u2029]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu

// Names Windows reserves for devices, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i

/** Cut a string to at most `max` bytes of UTF-8 without splitting a character. */
function clipBytes(s: string, max: number): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= max) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const n = enc.encode(ch).length
    if (used + n > max) break
    out += ch
    used += n
  }
  return out
}

/**
 * A name that is safe to create on any common file system, from text taken
 * out of a mail file. Path separators, reserved and invisible characters
 * become `_`; leading dots (hidden files, `..`) and trailing dots and spaces
 * (which Windows drops) go; device names like CON get a prefix; and the
 * result is cut to `maxBytes` of UTF-8, well inside the 255-byte limit file
 * systems put on one name. Letters in any script are kept.
 */
export function safeName(raw: string, fallback: string, maxBytes = 80): string {
  const tidy = (s: string) =>
    s
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
  let name = tidy(clipBytes(tidy(raw.normalize('NFC').replace(UNSAFE, '_')), maxBytes))
  if (!name) name = fallback
  if (RESERVED.test(name)) name = `_${name}`
  return name
}

/** "2001-05-14 1530", in local time, so exported files sort by date. */
function datePrefix(date: number | null): string {
  if (date == null || !Number.isFinite(date)) return ''
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}${two(d.getMinutes())} `
  )
}

/** The file name (without extension) for one exported message. */
export function messageBaseName(subject: string, date: number | null): string {
  return datePrefix(date) + safeName(subject, 'message')
}

/**
 * The names already used in one directory, so no two entries share one.
 * Compared case-insensitively, because Windows and macOS do, and messages
 * with the same subject are common. Folders and files share the namespace.
 */
export class NameSet {
  private taken = new Set<string>()

  /** `base` + `ext` if free, otherwise the first free `base (2)` + `ext`, … */
  take(base: string, ext = ''): string {
    let name = `${base}${ext}`
    for (let i = 2; this.taken.has(name.toLowerCase()); i++) name = `${base} (${i})${ext}`
    this.taken.add(name.toLowerCase())
    return name
  }
}

/**
 * Create a new directory called `name` inside `parent`, or `name (2)` and so
 * on if that is taken, so an export never writes into, or over, something
 * already on disk. Returns the handle and the name it ended up with.
 */
export async function createFreshDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<{ handle: FileSystemDirectoryHandle; name: string }> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${name} (${i})`
    try {
      await parent.getDirectoryHandle(candidate)
      continue // a folder of that name is already there
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TypeMismatchError') continue // a file
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
    }
    return { handle: await parent.getDirectoryHandle(candidate, { create: true }), name: candidate }
  }
}

/**
 * A directory in the export tree that is created only when the first file is
 * written into it, so folders with nothing to export leave no empty
 * directories behind. Its name is fixed (and reserved in its parent) up front,
 * so the tree is the same whatever order things are written in.
 */
export class ExportDirectory {
  readonly names = new NameSet()
  private handle: Promise<FileSystemDirectoryHandle> | null

  private constructor(
    private parent: ExportDirectory | null,
    private name: string,
    handle: FileSystemDirectoryHandle | null,
  ) {
    this.handle = handle ? Promise.resolve(handle) : null
  }

  static root(handle: FileSystemDirectoryHandle): ExportDirectory {
    return new ExportDirectory(null, '', handle)
  }

  /** A subdirectory for a mail folder, named safely and uniquely. */
  child(folderName: string): ExportDirectory {
    return new ExportDirectory(this, this.names.take(safeName(folderName, 'Folder')), null)
  }

  get(): Promise<FileSystemDirectoryHandle> {
    if (!this.handle) {
      const parent = this.parent as ExportDirectory
      this.handle = parent.get().then((p) => p.getDirectoryHandle(this.name, { create: true }))
      // Let a failed creation be tried again rather than remembered.
      this.handle.catch(() => {
        this.handle = null
      })
    }
    return this.handle
  }
}

/** One .eml being written: created on open, kept only if it is closed. */
export class EmlFileWriter {
  private constructor(
    private dir: FileSystemDirectoryHandle,
    private name: string,
    private stream: FileSystemWritableFileStream,
  ) {}

  static async open(
    dir: ExportDirectory,
    subject: string,
    date: number | null,
  ): Promise<EmlFileWriter> {
    const handle = await dir.get()
    const name = dir.names.take(messageBaseName(subject, date), '.eml')
    const file = await handle.getFileHandle(name, { create: true })
    try {
      return new EmlFileWriter(handle, name, await file.createWritable())
    } catch (err) {
      // Getting the handle already made an empty file; do not leave it behind.
      await handle.removeEntry(name).catch(() => {})
      throw err
    }
  }

  write(data: Uint8Array): Promise<void> {
    return this.stream.write(data as Uint8Array<ArrayBuffer>)
  }

  close(): Promise<void> {
    return this.stream.close()
  }

  /** Throw away a half-written file, so no truncated message is left behind. */
  async discard(): Promise<void> {
    await this.stream.abort().catch(() => {})
    await this.dir.removeEntry(this.name).catch(() => {})
  }
}
