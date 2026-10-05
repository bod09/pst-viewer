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
 * subjects), so all of them are treated as hostile: see safeName. And since a
 * name can still be refused by the disk, or by a rule this code does not know,
 * a message that cannot be saved is counted and left out (see EmlTreeWriter)
 * rather than ending the export.
 */
import type { EmlExportStep } from '../types'

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

/**
 * How long names and paths may be, in UTF-16 code units (what Windows counts)
 * and, per name, in UTF-8 bytes (what Linux and macOS count).
 *
 * - `path`: the export's own part of a path, from the folder the user picked
 *   down to a file, its own directory included. Windows limits a whole path to
 *   260 units unless long paths are enabled for both the system and the
 *   program, and the page cannot see the path of the picked folder. 160 leaves
 *   100 for that folder (`C:\Users\<name>\Documents\…`) and for the
 *   `.crswap` temporary file Chromium writes next to each file.
 * - `dir` and `file`: the longest folder and file name; a file name includes
 *   its date, any ` (2)` and `.eml`. When a folder is deep, or has deep
 *   subfolders, names get shorter, down to `minDir` and `minFile`, so the
 *   deepest file still fits `path`. That holds for 8 levels of folders below
 *   the export's directory however long their names; deeper than that, a
 *   path can pass `path`, and if Windows refuses it, that file is counted as
 *   not saved rather than stopping the export.
 * - `bytes`: well inside the 255 bytes most file systems allow per name, and
 *   the 143 of eCryptfs (encrypted home folders on Linux).
 */
const NAME_LIMITS = {
  path: 160,
  dir: 40,
  file: 72,
  minDir: 10,
  minFile: 28,
  bytes: 140,
} as const

// Characters a name must not contain. This is what Chromium refuses anywhere
// in a name written to a folder on disk (base::i18n::IsFilenameLegal, in
// base/i18n/file_util_icu.cc: `"*/:<>?\|`, controls, format characters and
// the Unicode non-characters U+FDD0-U+FDEF and U+xFFFE/U+xFFFF of every plane),
// plus line and paragraph separators and unpaired surrogates, which are not
// valid text. Format characters include the right-to-left override that can
// disguise an extension, and zero-width characters.
const NONCHARACTERS =
  '\\u{FDD0}-\\u{FDEF}' +
  Array.from({ length: 17 }, (_, plane) => {
    const hex = (n: number) => (plane * 0x10000 + n).toString(16)
    return `\\u{${hex(0xfffe)}}\\u{${hex(0xffff)}}`
  }).join('')
const UNSAFE = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f<>:"/\\\\|?*\\p{Cf}\\u2028\\u2029${NONCHARACTERS}]` +
    '|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  'gu',
)

// Chromium refuses white space, `.` and `~` at either end of a name (the same
// file, illegal_at_ends_); Windows silently drops trailing dots and spaces, and
// a leading dot hides a file.
const trimEnds = (s: string) => s.replace(/^[\s.~]+|[\s.~]+$/gu, '')

// Names Windows reserves, refused by Chromium on every platform
// (base::IsReservedNameOnWindows, base/files/file_util.cc): devices, with or
// without an extension, and two names the Explorer shell uses. COM0, LPT0, the
// superscript-digit ports and CONIN$/CONOUT$ are reserved by Windows too.
const RESERVED_DEVICE =
  /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\s*\..*)?$/i
const RESERVED_SHELL = /^(desktop\.ini|thumbs\.db)$/i

// On Windows, Chromium also refuses a name containing `~` that could be an 8.3
// short name, since it could stand for another file's short name
// (IllegalCharacters::CouldBeInvalidShortName, related to CVE-2014-9390). It
// is checked on whole names, as they will be written, on every platform: the
// same export runs on all of them. `[` and `]` are left out of the characters
// that rule a short name out, which only makes this stricter.
const NOT_IN_SHORT_NAME = /[\s"\\/:+|<>=;?,*]/u
function couldBeShortNameWithTilde(name: string): boolean {
  if (name.length > 12 || !name.includes('~') || NOT_IN_SHORT_NAME.test(name)) return false
  const dot = name.indexOf('.')
  if (dot < 0) return name.length <= 8
  if (dot !== name.lastIndexOf('.')) return false
  return dot > 0 && dot <= 8 && dot + 4 >= name.length
}

/** Cut to at most `maxUnits` UTF-16 units and `maxBytes` UTF-8 bytes, never inside a character. */
function clip(s: string, maxUnits: number, maxBytes: number = NAME_LIMITS.bytes): string {
  let out = ''
  let units = 0
  let bytes = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (units + ch.length > maxUnits || bytes + n > maxBytes) break
    out += ch
    units += ch.length
    bytes += n
  }
  return out
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Hostile text made into something that can be part of a name. */
function clean(raw: string): string {
  return trimEnds(raw.normalize('NFC').replace(UNSAFE, '_').replace(/\s+/g, ' '))
}

/** A cleaned name cut to `max`: the fallback if nothing is left, reserved names prefixed. */
function fit(
  name: string,
  max: number,
  fallback: string,
  maxBytes: number = NAME_LIMITS.bytes,
): string {
  let out = trimEnds(clip(name, max, maxBytes))
  if (!out) out = trimEnds(clip(fallback, max, maxBytes))
  if (RESERVED_DEVICE.test(out) || RESERVED_SHELL.test(out)) {
    out = trimEnds(clip(`_${out}`, max, maxBytes))
  }
  return out
}

/**
 * A name that is safe to create on any common file system, from text taken
 * out of a mail file. Path separators, reserved and invisible characters and
 * non-characters become `_`; white space, dots and `~` go from both ends
 * (hidden files, `..`, names Windows would change); device names like CON get
 * a prefix; and the result is cut to `max` UTF-16 units and NAME_LIMITS.bytes
 * bytes. Letters in any script are kept.
 */
function safeName(raw: string, fallback: string, max: number = NAME_LIMITS.file): string {
  return fit(clean(raw), max, fallback)
}

/**
 * The same for a directory, whose dots also become `_`. Chromium judges a
 * directory's "extension" as it would a file's: it refuses `.lnk`, `.scf`,
 * `.url`, `.{CLSID}` and every type Safe Browsing rates dangerous, a list
 * that is not available to a page. With no dot, there is no extension.
 */
function safeFolderName(
  raw: string,
  fallback: string,
  max: number = NAME_LIMITS.dir,
): string {
  return fit(clean(raw).replace(/\./g, '_'), max, fallback)
}

/** "2001-05-14 1530 ", in local time, so exported files sort by date. */
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

/** The file name (without extension) for one exported message, at most `max` units. */
function messageBaseName(
  subject: string,
  date: number | null,
  max: number = NAME_LIMITS.file - 4,
): string {
  const prefix = datePrefix(date)
  return prefix + safeName(subject, 'message', max - prefix.length)
}

/**
 * The key two names share if a file system could take them for the same
 * name: Windows and macOS ignore case (and do not fold it the way JavaScript
 * does: NTFS takes `ΑΣ` and `ασ` as equal, JavaScript lowercases `ΑΣ` to
 * `ας`), and macOS ignores Unicode normalisation. Folding both ways and
 * decomposing compatibility characters makes more names clash than any one
 * file system would, which only costs a ` (2)`.
 */
const nameKey = (name: string) =>
  name.normalize('NFKD').toUpperCase().toLowerCase().normalize('NFKD')

/** `base` + `ext`, or `base (i)` + `ext`, within `max` units, as it will be written. */
function candidateName(base: string, ext: string, max: number, i = 1): string {
  const suffix = i === 1 ? '' : ` (${i})`
  // The suffix and extension are ASCII: one byte per unit.
  const room = suffix.length + ext.length
  let stem = fit(base, max - room, 'x', NAME_LIMITS.bytes - room)
  if (couldBeShortNameWithTilde(`${stem}${suffix}${ext}`)) stem = stem.replace(/~/g, '_')
  return `${stem}${suffix}${ext}`
}

/**
 * The names already used in one directory, so no two entries share one.
 * Compared by nameKey, because messages with the same subject are common.
 * Folders and files share the namespace.
 */
class NameSet {
  private taken = new Set<string>()

  has(name: string): boolean {
    return this.taken.has(nameKey(name))
  }

  /** The first free name of `base` + `ext`, `base (2)` + `ext`, … within `max` units. */
  take(base: string, ext = '', max: number = NAME_LIMITS.file): string {
    for (let i = 1; ; i++) {
      const name = candidateName(base, ext, max, i)
      if (!this.has(name)) {
        this.taken.add(nameKey(name))
        return name
      }
    }
  }
}

const isDom = (err: unknown, name: string) => err instanceof DOMException && err.name === name

/** Why something failed, in words for the summary. */
export const describeError = (err: unknown): string =>
  err instanceof Error ? err.message || err.name : String(err)

/**
 * Failures that every later write would hit too, so the export stops on them:
 * the disk is full, or the permission to write is gone or was never there.
 * Anything else (a name refused, a path too long, one file locked) is about one
 * file, and only that file is left out.
 */
function stopsExport(err: unknown): boolean {
  return (
    isDom(err, 'QuotaExceededError') || isDom(err, 'NotAllowedError') || isDom(err, 'SecurityError')
  )
}

/**
 * Whether `dir` already holds a file or folder called `name`, as the file
 * system sees it. Names the code thinks differ can still be the same on disk
 * (case and normalisation rules vary), and writing to a file that is already
 * there would replace it. Throws when the name itself is refused.
 */
async function entryExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch (err) {
    if (isDom(err, 'TypeMismatchError')) return true // a folder of that name
    if (isDom(err, 'NotFoundError')) return false
    throw err
  }
}

/** Take names from `names` until one is free on disk too. */
async function claimName(
  dir: FileSystemDirectoryHandle,
  names: NameSet,
  base: string,
  ext: string,
  max: number,
): Promise<string> {
  for (;;) {
    const name = names.take(base, ext, max)
    if (!(await entryExists(dir, name))) return name
  }
}

/**
 * Create a new directory for the export inside `parent`, called `label` (made
 * safe), or `label (2)` and so on if that is taken, so an export never writes
 * into, or over, something already on disk. If the name is refused, the
 * directory is called `fallback` instead.
 */
export async function createFreshDirectory(
  parent: FileSystemDirectoryHandle,
  label: string,
  fallback: string,
): Promise<ExportDirectory> {
  const names = new NameSet()
  const make = async (base: string) => {
    const name = await claimName(parent, names, base, '', NAME_LIMITS.dir)
    return ExportDirectory.root(await parent.getDirectoryHandle(name, { create: true }), name)
  }
  try {
    return await make(safeFolderName(label, fallback))
  } catch (err) {
    if (stopsExport(err)) throw err
    return make(safeFolderName(fallback, 'Export'))
  }
}

/** A directory that could not be created, even under a plain name. */
class DirectoryError extends Error {}

/**
 * A directory in the export tree that is created only when the first file is
 * written into it, so folders with nothing to export leave no empty
 * directories behind. Its name is chosen (and reserved in its parent) up
 * front, so the tree is the same whatever order things are written in; it
 * changes only if the disk already has an entry by that name, or refuses it.
 */
export class ExportDirectory {
  readonly names = new NameSet()
  private handle: Promise<FileSystemDirectoryHandle> | null
  private broken: string | null = null

  private constructor(
    private parent: ExportDirectory | null,
    private base: string,
    private max: number,
    private name: string,
    handle: FileSystemDirectoryHandle | null,
  ) {
    this.handle = handle ? Promise.resolve(handle) : null
  }

  static root(handle: FileSystemDirectoryHandle, name: string): ExportDirectory {
    return new ExportDirectory(null, name, name.length, name, handle)
  }

  /** The directory's name on disk. */
  get nameOnDisk(): string {
    return this.name
  }

  /** Length of the path from the picked folder down to this directory, in UTF-16 units. */
  get pathLength(): number {
    return (this.parent ? this.parent.pathLength + 1 : 0) + this.name.length
  }

  /** The longest file name that keeps a path in this directory within NAME_LIMITS.path. */
  get fileMax(): number {
    return clamp(NAME_LIMITS.path - this.pathLength - 1, NAME_LIMITS.minFile, NAME_LIMITS.file)
  }

  /**
   * A subdirectory for a mail folder, named safely and uniquely. `levelsBelow`
   * is how deep the folder's own subfolders go, so room is kept for them and
   * for a file at the bottom.
   */
  child(folderName: string, levelsBelow = 0): ExportDirectory {
    const max = clamp(
      NAME_LIMITS.path -
        (this.pathLength + 1) -
        levelsBelow * (NAME_LIMITS.minDir + 1) -
        (NAME_LIMITS.minFile + 1),
      NAME_LIMITS.minDir,
      NAME_LIMITS.dir,
    )
    const base = safeFolderName(folderName, 'Folder', max)
    return new ExportDirectory(this, base, max, this.names.take(base, '', max), null)
  }

  get(): Promise<FileSystemDirectoryHandle> {
    if (this.broken) return Promise.reject(new DirectoryError(this.broken))
    if (!this.handle) {
      this.handle = this.create()
      // Let a failed creation be tried again rather than remembered.
      this.handle.catch(() => {
        this.handle = null
      })
    }
    return this.handle
  }

  private async create(): Promise<FileSystemDirectoryHandle> {
    const parentDir = this.parent as ExportDirectory
    const parent = await parentDir.get()
    const attempt = async (base: string, first: boolean) => {
      // The name reserved up front, unless the disk already has one like it.
      if (!first || (await entryExists(parent, this.name))) {
        this.name = await claimName(parent, parentDir.names, base, '', this.max)
      }
      return parent.getDirectoryHandle(this.name, { create: true })
    }
    try {
      return await attempt(this.base, true)
    } catch (err) {
      if (stopsExport(err)) throw err
    }
    // Refused: the disk or Chromium objects to the name (or the path), so try
    // a plain one. If that fails too, every message for this folder is
    // counted as not saved, without trying again for each one.
    try {
      return await attempt('Folder', false)
    } catch (err) {
      if (stopsExport(err)) throw err
      this.broken = `A folder could not be created: ${describeError(err)}`
      throw new DirectoryError(this.broken)
    }
  }
}

/** One .eml being written: created on open, kept only if it is closed. */
class EmlFileWriter {
  private constructor(
    private dir: FileSystemDirectoryHandle,
    private name: string,
    private stream: FileSystemWritableFileStream,
  ) {}

  /**
   * Start the file for a message in `dir`, named after its date and subject.
   * If that name is refused (by Chromium, or by the disk), it is tried once
   * more as `<date> message.eml`.
   */
  static async open(
    dir: ExportDirectory,
    subject: string,
    date: number | null,
  ): Promise<EmlFileWriter> {
    const handle = await dir.get()
    const max = dir.fileMax
    try {
      return await this.create(handle, dir.names, messageBaseName(subject, date, max - 4), max)
    } catch (err) {
      if (stopsExport(err)) throw err
      return this.create(handle, dir.names, `${datePrefix(date)}message`, max)
    }
  }

  private static async create(
    dir: FileSystemDirectoryHandle,
    names: NameSet,
    base: string,
    max: number,
  ): Promise<EmlFileWriter> {
    const name = await claimName(dir, names, base, '.eml', max)
    const file = await dir.getFileHandle(name, { create: true })
    try {
      return new EmlFileWriter(dir, name, await file.createWritable())
    } catch (err) {
      // Getting the handle already made an empty file; do not leave it behind.
      await dir.removeEntry(name).catch(() => {})
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

/**
 * Writes the messages the worker sends (see EmlExportStep) into an export
 * tree, and keeps the counts for the summary.
 *
 * A message that cannot be read is `unreadable`. A message that cannot be
 * saved (its name or path refused, its file failing to open, write or close)
 * is `unsaved`, with the reason kept, and the export goes on. It stops only on
 * a failure every later file would hit too (see stopsExport), or when
 * MAX_IN_A_ROW files in a row have failed, which means the same thing. Only
 * failures in a directory that has already taken a file count towards that:
 * a refused name, or a directory that takes no file at all (its path too
 * long, say), is about those files, not the disk.
 */
export class EmlTreeWriter {
  static readonly MAX_IN_A_ROW = 20

  exported = 0
  unreadable = 0
  unsaved = 0
  /** Why messages could not be saved, with how many each. */
  readonly reasons = new Map<string, number>()
  /** Why the export stopped, if it had to. */
  fatal: string | null = null

  private file: EmlFileWriter | null = null
  // The current message failed and is already counted; drop the rest of it.
  private dropping = false
  private inARow = 0
  // The directory of the current message, and the directories a file was saved in.
  private dir: ExportDirectory | null = null
  private readonly savedIn = new Set<ExportDirectory>()

  constructor(private cancelled: () => boolean) {}

  /** Handle one step; false means stop the export. */
  async step(step: EmlExportStep, dirOf: (folderId: string) => ExportDirectory): Promise<boolean> {
    if (this.cancelled() || this.fatal) {
      await this.discard()
      return false
    }
    try {
      if (step.kind === 'start') {
        await this.discard()
        this.dropping = false
        this.dir = dirOf(step.folderId)
        this.file = await EmlFileWriter.open(this.dir, step.subject, step.date)
      } else if (step.kind === 'data') {
        await this.file?.write(step.data)
      } else if (step.kind === 'end') {
        const file = this.file
        this.file = null
        if (file) {
          try {
            await file.close()
          } catch (err) {
            await file.discard()
            throw err
          }
          this.exported++
          this.inARow = 0
          if (this.dir) this.savedIn.add(this.dir)
        }
        this.dropping = false
      } else {
        await this.discard()
        // A message that failed to save and then turned out unreadable is
        // already counted.
        if (!this.dropping) this.unreadable++
        this.dropping = false
      }
      return true
    } catch (err) {
      await this.discard()
      return this.failed(err)
    }
  }

  /** Throw away the file being written, if any. */
  async discard(): Promise<void> {
    const file = this.file
    this.file = null
    await file?.discard()
  }

  private failed(err: unknown): boolean {
    const reason = describeError(err)
    if (stopsExport(err)) {
      this.fatal = reason
      return false
    }
    if (!this.dropping) {
      this.unsaved++
      this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1)
    }
    this.dropping = true
    // A folder that cannot be created, a refused name, or a folder none of
    // whose files can be saved is about that folder, not the disk.
    if (err instanceof DirectoryError || err instanceof TypeError) return true
    if (!this.dir || !this.savedIn.has(this.dir)) return true
    if (++this.inARow >= EmlTreeWriter.MAX_IN_A_ROW) {
      const why = reason.replace(/\.$/, '')
      this.fatal = `${EmlTreeWriter.MAX_IN_A_ROW} files in a row could not be saved (${why})`
      return false
    }
    return true
  }
}
