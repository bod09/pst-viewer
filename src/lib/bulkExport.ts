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

  /** Mark a name as used, exactly as given (see MboxFolder, which takes names in pairs). */
  reserve(name: string): void {
    this.taken.add(nameKey(name))
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

  /**
   * A subdirectory under a name the caller has already made safe and
   * reserved in `names` (an .mbox file's `.sbd`, see MboxFolder). Created
   * only when something is written into it, like any other.
   */
  subdirectory(name: string): ExportDirectory {
    // Room for a ` (2)` if the disk turns out to have the name already.
    return new ExportDirectory(this, name, name.length + 4, name, null)
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


// ---------------------------------------------------------------------------
// MBOX: one .mbox file per mail folder, in the mboxrd flavour.
//
// The tree is laid out the way Thunderbird keeps its own folders, which is
// also what ImportExportTools NG reads back with subfolders: a folder's mail
// is the file `Name.mbox`, and its subfolders go in a directory beside it
// called `Name.mbox.sbd`. A whole-mailbox export puts the top-level folders'
// files straight into the export's directory.

/** Which format a bulk export writes. */
export type ExportFormat = 'eml' | 'mbox'

const utf8 = new TextEncoder()

// How much a name grows on disk: `.mbox` on the file, `.mbox.sbd` on the
// directory of its subfolders.
const MBOX_EXT = '.mbox'
const SBD_EXT = '.sbd'
const SBD_ROOM = MBOX_EXT.length + SBD_EXT.length

/** `base.mbox`, or `base (2).mbox` and so on, whose `.sbd` is free as well. */
function takeMboxName(names: NameSet, base: string, max: number): string {
  for (let i = 1; ; i++) {
    const file = candidateName(base, MBOX_EXT, max + MBOX_EXT.length, i)
    const sbd = `${file}${SBD_EXT}`
    if (!names.has(file) && !names.has(sbd)) {
      names.reserve(file)
      names.reserve(sbd)
      return file
    }
  }
}

/**
 * Where one mail folder's messages go in an MBOX export: an .mbox file, and a
 * directory beside it for its subfolders. The two are named together, and,
 * as with ExportDirectory, nothing is created on disk until a message needs
 * it. If the disk refuses or already has the file's name, the file takes
 * another and its `.sbd` keeps the first: the mail is all there, only the
 * pairing an importer looks for is lost.
 */
export class MboxFolder {
  /** The directory this folder's subfolders go in (for the top, the export's own). */
  readonly subfolders: ExportDirectory
  /** Bytes of complete messages in the file, once it exists. */
  size = 0
  /** Whether the file exists on disk. */
  made = false
  /** Why the file cannot be created, once that is known, so it is not tried again. */
  broken: string | null = null
  private fileName: string | null

  private constructor(
    readonly parent: MboxFolder | null,
    /** The directory the file goes in. */
    readonly home: ExportDirectory,
    private base: string,
    private max: number,
    fileName: string | null,
  ) {
    this.fileName = fileName
    this.subfolders = fileName ? home.subdirectory(`${fileName}${SBD_EXT}`) : home
  }

  /**
   * The top of an MBOX export, in the export's directory, where its
   * subfolders' files go. Mail kept in the top itself (a whole mailbox's own,
   * which is rare) goes in `label.mbox`, named only when there is some.
   */
  static root(dir: ExportDirectory, label: string): MboxFolder {
    const max = clamp(NAME_LIMITS.path - (dir.pathLength + 1) - MBOX_EXT.length, NAME_LIMITS.minDir, NAME_LIMITS.dir)
    return new MboxFolder(null, dir, safeFolderName(label, 'Mailbox', max), max, null)
  }

  /**
   * The place for a subfolder: `Name.mbox` here, and `Name.mbox.sbd` for its
   * own subfolders, named safely and reserved now so the tree is the same
   * whatever order it is written in. `levelsBelow` is how deep the folder's
   * subfolders go, so names leave room for them within NAME_LIMITS.path (see
   * ExportDirectory.child).
   */
  child(folderName: string, levelsBelow = 0): MboxFolder {
    const dir = this.subfolders
    const max = clamp(
      NAME_LIMITS.path -
        (dir.pathLength + 1) -
        SBD_ROOM -
        levelsBelow * (NAME_LIMITS.minDir + SBD_ROOM + 1),
      NAME_LIMITS.minDir,
      NAME_LIMITS.dir,
    )
    const base = safeFolderName(folderName, 'Folder', max)
    return new MboxFolder(this, dir, base, max, takeMboxName(dir.names, base, max))
  }

  /** The file's name on disk, choosing it now if it has not been chosen. */
  name(): string {
    this.fileName ??= takeMboxName(this.home.names, this.base, this.max)
    return this.fileName
  }

  /** Take the next free name, after the disk turned out to have this one. */
  next(): string {
    this.fileName = takeMboxName(this.home.names, this.base, this.max)
    return this.fileName
  }

  /** Take a plain name, after the disk refused this one. */
  plain(): string {
    this.base = 'Folder'
    return this.next()
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The line that starts a message in an mbox file,
 * `From MAILER-DAEMON Thu Jan  1 00:00:00 1970`: asctime form, in UTC. The
 * date is the message's, or the time of the export when it has none or one
 * that asctime cannot write.
 */
function separatorLine(date: number | null, now: number): string {
  let d = new Date(date ?? Number.NaN)
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) d = new Date(now)
  const two = (n: number) => String(n).padStart(2, '0')
  return (
    `From MAILER-DAEMON ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ` +
    `${String(d.getUTCDate()).padStart(2, ' ')} ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ` +
    `${String(d.getUTCFullYear()).padStart(4, '0')}\n`
  )
}

const CR = 0x0d
const LF = 0x0a
const GT = 0x3e
const FROM_ = [0x46, 0x72, 0x6f, 0x6d, 0x20] // "From "

/**
 * Turns one message, arriving in pieces, into its mboxrd form: CRLF line
 * endings become LF, a line that starts with `From `, after any number of
 * `>`, gets one more `>` in front, and the message ends with a blank line.
 *
 * A piece can end anywhere, in the middle of a CRLF or of a `>>From `, so the
 * start of each line is held back until it is clear whether it needs the
 * extra `>`, and a CR at the end of a piece until it is clear whether an LF
 * follows it.
 */
export class MboxrdEncoder {
  // The start of the current line, held back: `quotes` times `>`, then the
  // first `matched` bytes of "From ". Kept as counts, so a line of a million
  // `>` costs nothing to hold. `atStart` is false once the line is known not
  // to need quoting.
  private atStart = true
  private quotes = 0
  private matched = 0
  private pendingCR = false
  private last = LF
  private out = new Uint8Array(0)
  private n = 0

  /** The message's next piece, ready to write. */
  push(data: Uint8Array): Uint8Array {
    // Each byte gives at most itself and a `>`, plus whatever was held back.
    this.begin(2 * data.length + this.quotes + this.matched + 2)
    // The middle of a line is copied in one go, up to the next CR or LF;
    // only the start and end of each line go a byte at a time.
    let nextCR = -1
    let nextLF = -1
    for (let i = 0; i < data.length; ) {
      if (this.atStart || this.pendingCR) {
        this.byte(data[i++])
        continue
      }
      if (nextCR < i) nextCR = data.indexOf(CR, i) >>> 0
      if (nextLF < i) nextLF = data.indexOf(LF, i) >>> 0
      const stop = Math.min(nextCR, nextLF, data.length)
      if (stop > i) {
        this.out.set(data.subarray(i, stop), this.n)
        this.n += stop - i
        this.last = data[stop - 1]
        i = stop
      }
      if (i < data.length) this.byte(data[i++])
    }
    return this.out.subarray(0, this.n)
  }

  /** Whatever is still held back, an end to the last line, and the blank line after the message. */
  end(): Uint8Array {
    this.begin(this.quotes + this.matched + 3)
    this.release()
    if (this.pendingCR) this.emit(CR)
    this.pendingCR = false
    if (this.last !== LF) this.emit(LF)
    this.emit(LF)
    return this.out.subarray(0, this.n)
  }

  private begin(size: number): void {
    this.out = new Uint8Array(size)
    this.n = 0
  }

  private emit(byte: number): void {
    this.out[this.n++] = byte
    this.last = byte
  }

  /** Write out what was held back, as it was: this line is not a separator. */
  private release(): void {
    for (let i = 0; i < this.quotes; i++) this.emit(GT)
    for (let i = 0; i < this.matched; i++) this.emit(FROM_[i])
    this.atStart = false
    this.quotes = 0
    this.matched = 0
  }

  private newLine(): void {
    this.emit(LF)
    this.atStart = true
  }

  private byte(byte: number): void {
    if (this.pendingCR) {
      this.pendingCR = false
      if (byte === LF) return this.newLine()
      // A CR on its own is part of the line, not the end of it.
      this.release()
      this.emit(CR)
    }
    if (this.atStart) {
      if (byte === GT && this.matched === 0) {
        this.quotes++
        return
      }
      if (byte === FROM_[this.matched]) {
        if (++this.matched === FROM_.length) {
          this.emit(GT)
          this.release()
        }
        return
      }
      this.release()
    }
    if (byte === CR) this.pendingCR = true
    else if (byte === LF) this.newLine()
    else this.emit(byte)
  }
}

/**
 * An .mbox file being written. It stays open while its folder's messages
 * arrive; what is written becomes the file's content when it is closed.
 */
class MboxFileWriter {
  /** Messages completed since it was opened, which a failed close would lose. */
  saved = 0
  /** The file's size when it was opened, which it goes back to if the stream is given up. */
  private readonly opened: number

  private constructor(
    readonly folder: MboxFolder,
    private dir: FileSystemDirectoryHandle,
    private stream: FileSystemWritableFileStream,
    /** Whether the file was there before this stream (and so holds earlier messages). */
    private existed: boolean,
  ) {
    this.opened = folder.size
  }

  /**
   * Open the folder's file, creating it the first time. A file closed earlier
   * in the export (a selection can come back to a folder, and a parent's file
   * can be made empty for its subfolders' sake) is opened again with its
   * content kept, and added to at the end.
   */
  static async open(folder: MboxFolder): Promise<MboxFileWriter> {
    if (folder.broken) throw new DirectoryError(folder.broken)
    const dir = await folder.home.get()
    if (folder.made) {
      const file = await dir.getFileHandle(folder.name())
      const stream = await file.createWritable({ keepExistingData: true })
      try {
        await stream.seek(folder.size)
      } catch (err) {
        await stream.abort().catch(() => {})
        throw err
      }
      return new MboxFileWriter(folder, dir, stream, true)
    }
    try {
      return await this.create(folder, dir, folder.name())
    } catch (err) {
      if (stopsExport(err)) throw err
    }
    // Refused: try a plain name, and if that fails too, leave this folder's
    // messages out without trying again for each one.
    try {
      return await this.create(folder, dir, folder.plain())
    } catch (err) {
      if (stopsExport(err)) throw err
      folder.broken = `An .mbox file could not be created: ${describeError(err)}`
      throw new DirectoryError(folder.broken)
    }
  }

  private static async create(
    folder: MboxFolder,
    dir: FileSystemDirectoryHandle,
    name: string,
  ): Promise<MboxFileWriter> {
    // The name is new to this export, but the disk may still see one like it.
    while (await entryExists(dir, name)) name = folder.next()
    const file = await dir.getFileHandle(name, { create: true })
    folder.made = true
    folder.size = 0
    try {
      return new MboxFileWriter(folder, dir, await file.createWritable(), false)
    } catch (err) {
      await removeMbox(folder, dir)
      throw err
    }
  }

  write(data: Uint8Array): Promise<void> {
    return this.stream.write(data as Uint8Array<ArrayBuffer>)
  }

  /** Cut the file back to `size` bytes, dropping a message that did not finish. */
  truncate(size: number): Promise<void> {
    return this.stream.truncate(size)
  }

  close(): Promise<void> {
    return this.stream.close()
  }

  /**
   * Give up on the stream: the file goes back to what it was when it was
   * opened, and one that was new is removed.
   */
  async abandon(): Promise<void> {
    await this.stream.abort().catch(() => {})
    this.folder.size = this.opened
    if (!this.existed) await removeMbox(this.folder, this.dir)
  }
}

/** Remove a folder's file, which holds no complete message. */
async function removeMbox(folder: MboxFolder, dir: FileSystemDirectoryHandle): Promise<void> {
  await dir.removeEntry(folder.name()).catch(() => {})
  folder.made = false
  folder.size = 0
}

/**
 * Writes the messages the worker sends (see EmlExportStep) into an MBOX
 * export tree, and keeps the counts for the summary, as EmlTreeWriter does
 * for .eml files, with the same rules for what is counted and what stops
 * the export.
 *
 * A folder's file stays open while its messages arrive, and is closed when a
 * message for another folder starts or the export ends. The file's size is
 * noted before each message; if the message cannot be read or saved
 * part-way, or the export is cancelled, the file is cut back to that size, so
 * every message saved is complete. If the file then cannot be closed, the
 * messages written to it since it was opened are counted as not saved.
 */
export class MboxTreeWriter {
  static readonly MAX_IN_A_ROW = EmlTreeWriter.MAX_IN_A_ROW

  exported = 0
  unreadable = 0
  unsaved = 0
  /** Why messages could not be saved, with how many each. */
  readonly reasons = new Map<string, number>()
  /** Why the export stopped, if it had to. */
  fatal: string | null = null

  private file: MboxFileWriter | null = null
  // Set while a message is being written: it turns the message into mboxrd.
  private encoder: MboxrdEncoder | null = null
  // Where the next byte goes in the open file.
  private position = 0
  // The current message failed and is already counted; drop the rest of it.
  private dropping = false
  private inARow = 0
  private folder: MboxFolder | null = null
  private readonly savedIn = new Set<MboxFolder>()

  constructor(
    private cancelled: () => boolean,
    private now: () => number = Date.now,
  ) {}

  /** Handle one step; false means stop the export. */
  async step(step: EmlExportStep, folderOf: (folderId: string) => MboxFolder): Promise<boolean> {
    if (this.cancelled() || this.fatal) {
      await this.discard()
      return false
    }
    try {
      if (step.kind === 'start') {
        await this.dropMessage()
        this.dropping = false
        this.folder = folderOf(step.folderId)
        const file = await this.fileFor(this.folder)
        this.position = this.folder.size
        this.encoder = new MboxrdEncoder()
        await this.put(file, utf8.encode(separatorLine(step.date, this.now())))
      } else if (step.kind === 'data') {
        if (this.file && this.encoder) await this.put(this.file, this.encoder.push(step.data))
      } else if (step.kind === 'end') {
        const file = this.file
        if (file && this.encoder) {
          await this.put(file, this.encoder.end())
          this.encoder = null
          file.folder.size = this.position
          file.saved++
          this.exported++
          this.inARow = 0
          if (!this.savedIn.has(file.folder)) {
            this.savedIn.add(file.folder)
            await this.makeParents(file.folder)
          }
        }
        this.dropping = false
      } else {
        await this.dropMessage()
        // A message that failed to save and then turned out unreadable is
        // already counted.
        if (!this.dropping) this.unreadable++
        this.dropping = false
      }
      return true
    } catch (err) {
      await this.dropMessage().catch(() => {})
      return this.failed(err)
    }
  }

  /**
   * Drop the message being written, if any, and close the file, keeping
   * every message completed before it. Called when the export ends, however
   * it ends.
   */
  async discard(): Promise<void> {
    try {
      await this.dropMessage()
      await this.closeFile()
    } catch (err) {
      // Already counted; only a failure every write would hit stops the export.
      if (stopsExport(err)) this.fatal ??= describeError(err)
    }
  }

  /** Write `data` to the file and move the position past it. */
  private async put(file: MboxFileWriter, data: Uint8Array): Promise<void> {
    if (data.length === 0) return
    await file.write(data)
    this.position += data.length
  }

  /**
   * Cut the file back to before the message being written, if there is one.
   * If even that fails, the stream is given up, and the messages it held are
   * counted as not saved.
   */
  private async dropMessage(): Promise<void> {
    const file = this.file
    if (!this.encoder || !file) return
    this.encoder = null
    try {
      await file.truncate(file.folder.size)
      this.position = file.folder.size
    } catch (err) {
      this.file = null
      await file.abandon()
      this.lose(file, err)
      throw err
    }
  }

  /** The open file for `folder`, closing another folder's first. */
  private async fileFor(folder: MboxFolder): Promise<MboxFileWriter> {
    if (this.file?.folder === folder) return this.file
    await this.closeFile()
    this.file = await MboxFileWriter.open(folder)
    return this.file
  }

  /**
   * Close the open file. If that fails, the messages written to it since it
   * was opened are counted as not saved; the error is passed on only if
   * every later write would fail too.
   */
  private async closeFile(): Promise<void> {
    const file = this.file
    this.file = null
    if (!file) return
    try {
      await file.close()
    } catch (err) {
      await file.abandon()
      this.lose(file, err)
      if (stopsExport(err)) throw err
      return
    }
    // A file none of whose messages could be saved, and that no subfolder
    // needs, is not left behind empty.
    if (file.folder.size === 0 && !this.needed(file.folder)) {
      await removeMbox(file.folder, await file.folder.home.get())
    }
  }

  /**
   * Give every folder above this one a file, if only an empty one: an
   * importer finds a `.sbd` directory through the file beside it, so without
   * one the subfolders would not come in with the tree. Failing to make one
   * costs only that, so it does not count against the message.
   */
  private async makeParents(folder: MboxFolder): Promise<void> {
    for (let p = folder.parent; p?.parent; p = p.parent) {
      if (p.made || p.broken) continue
      try {
        const empty = await MboxFileWriter.open(p)
        await empty.close().catch(async (err: unknown) => {
          await empty.abandon()
          throw err
        })
      } catch (err) {
        if (stopsExport(err)) throw err
      }
    }
  }

  /** Whether a folder below `folder` has saved a message (and so needs its file as a way in). */
  private needed(folder: MboxFolder): boolean {
    for (const f of this.savedIn) for (let p = f.parent; p; p = p.parent) if (p === folder) return true
    return false
  }

  /** Count the messages a lost stream held as not saved, with the reason. */
  private lose(file: MboxFileWriter, err: unknown): void {
    if (file.saved === 0) return
    this.exported -= file.saved
    this.unsaved += file.saved
    const reason = describeError(err)
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + file.saved)
    file.saved = 0
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
    // A file or folder that cannot be created, or a refused name, is about
    // that folder, not the disk (see EmlTreeWriter).
    if (err instanceof DirectoryError || err instanceof TypeError) return true
    if (!this.folder || !this.savedIn.has(this.folder)) return true
    if (++this.inARow >= MboxTreeWriter.MAX_IN_A_ROW) {
      const why = reason.replace(/\.$/, '')
      this.fatal = `${MboxTreeWriter.MAX_IN_A_ROW} messages in a row could not be saved (${why})`
      return false
    }
    return true
  }
}
