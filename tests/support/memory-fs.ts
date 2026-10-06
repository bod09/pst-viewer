/**
 * An in-memory folder that behaves like the one a browser hands a page through
 * the File System Access API, for testing code that writes an export to disk.
 *
 * It copies the behaviour that code has to cope with:
 * - getFileHandle and getDirectoryHandle fail with the same named errors
 *   (NotFoundError, TypeMismatchError, and TypeError for a refused name);
 * - creating a file leaves an empty file behind at once, before anything is
 *   written;
 * - what is written only becomes the file's content when the stream is
 *   closed, and is thrown away if it is aborted;
 * - a stream starts empty, or with the file's content if asked to keep it,
 *   and can seek and truncate the way the browser's does (a truncate to
 *   before the write position moves the position back to the new end);
 * - a failed write, seek or truncate errors the stream, as the browser's
 *   does: every later write, seek, truncate or close fails with the same
 *   error, and abort does nothing;
 * - a disk can treat names that differ only by case as the same name.
 *
 * `fail` lets a test make any single operation throw, the way a full disk, a
 * lost permission or a refused name would.
 */

export type Operation =
  | 'createFile'
  | 'createDirectory'
  | 'openWritable'
  | 'write'
  | 'seek'
  | 'truncate'
  | 'close'
  | 'remove'

export interface MemoryFsOptions {
  /** Treat names that differ only by case as the same, like Windows and macOS. */
  caseInsensitive?: boolean
  /** Return (or throw) an error to make this operation on this name fail. */
  fail?: (operation: Operation, name: string, path: string) => unknown
}

const dom = (name: string, message = name) => new DOMException(message, name)

export class MemoryFile {
  readonly kind = 'file' as const
  content = new Uint8Array(0)
  /** How many times a stream on this file was closed (so, how often it was written). */
  commits = 0

  constructor(
    readonly name: string,
    private parent: MemoryDirectory,
  ) {}

  get text(): string {
    return new TextDecoder().decode(this.content)
  }

  async getFile(): Promise<File> {
    return new File([this.content as Uint8Array<ArrayBuffer>], this.name)
  }

  async createWritable(options?: { keepExistingData?: boolean }) {
    const fs = this.parent.fs
    fs.check('openWritable', this.name, this.parent.pathTo(this.name))
    let buffer = options?.keepExistingData ? this.content.slice() : new Uint8Array(0)
    let position = 0
    let done = false
    const stream = {
      write: async (data: Uint8Array) => {
        if (done) throw new TypeError('the stream is closed')
        fs.check('write', this.name, this.parent.pathTo(this.name))
        const end = position + data.length
        if (end > buffer.length) {
          const grown = new Uint8Array(end)
          grown.set(buffer)
          buffer = grown
        }
        buffer.set(data, position)
        position = end
      },
      seek: async (offset: number) => {
        if (done) throw new TypeError('the stream is closed')
        fs.check('seek', this.name, this.parent.pathTo(this.name))
        position = offset
      },
      truncate: async (size: number) => {
        if (done) throw new TypeError('the stream is closed')
        fs.check('truncate', this.name, this.parent.pathTo(this.name))
        const cut = new Uint8Array(size)
        cut.set(buffer.subarray(0, Math.min(size, buffer.length)))
        buffer = cut
        position = Math.min(position, size)
      },
      close: async () => {
        if (done) throw new TypeError('the stream is closed')
        done = true
        fs.check('close', this.name, this.parent.pathTo(this.name))
        this.content = buffer
        this.commits++
      },
      abort: async () => {
        done = true
      },
    }
    // Once a write, seek or truncate has failed, the stream stays failed.
    let broken: unknown = null
    const erroring =
      <A extends unknown[]>(run: (...args: A) => Promise<void>) =>
      async (...args: A) => {
        if (broken) throw broken
        try {
          await run(...args)
        } catch (err) {
          broken = err
          throw err
        }
      }
    return {
      ...stream,
      write: erroring(stream.write),
      seek: erroring(stream.seek),
      truncate: erroring(stream.truncate),
      close: async () => {
        if (broken) throw broken
        await stream.close()
      },
    }
  }
}

export class MemoryDirectory {
  readonly kind = 'directory' as const
  private children = new Map<string, MemoryDirectory | MemoryFile>()

  constructor(
    readonly name: string,
    readonly fs: MemoryFs,
    private parent: MemoryDirectory | null = null,
  ) {}

  private key(name: string): string {
    return this.fs.options.caseInsensitive ? name.toLowerCase() : name
  }

  pathTo(name: string): string {
    const own = this.parent ? this.parent.pathTo(this.name) : ''
    return own ? `${own}/${name}` : name
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    const existing = this.children.get(this.key(name))
    if (existing) {
      if (existing.kind !== 'file') throw dom('TypeMismatchError')
      return existing
    }
    if (!options?.create) throw dom('NotFoundError')
    this.fs.check('createFile', name, this.pathTo(name))
    const file = new MemoryFile(name, this)
    this.children.set(this.key(name), file)
    return file
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    const existing = this.children.get(this.key(name))
    if (existing) {
      if (existing.kind !== 'directory') throw dom('TypeMismatchError')
      return existing
    }
    if (!options?.create) throw dom('NotFoundError')
    this.fs.check('createDirectory', name, this.pathTo(name))
    const dir = new MemoryDirectory(name, this.fs, this)
    this.children.set(this.key(name), dir)
    return dir
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.has(this.key(name))) throw dom('NotFoundError')
    this.fs.check('remove', name, this.pathTo(name))
    this.children.delete(this.key(name))
  }

  /** Put a file in place directly, as if it had been there before the export. */
  seedFile(name: string, text = ''): MemoryFile {
    const file = new MemoryFile(name, this)
    file.content = new TextEncoder().encode(text)
    this.children.set(this.key(name), file)
    return file
  }

  /** Put a directory in place directly, as if it had been there before the export. */
  seedDirectory(name: string): MemoryDirectory {
    const dir = new MemoryDirectory(name, this.fs, this)
    this.children.set(this.key(name), dir)
    return dir
  }

  /** Names directly inside this directory, in the order they were created. */
  list(): string[] {
    return [...this.children.values()].map((c) => c.name)
  }

  file(name: string): MemoryFile {
    const entry = this.children.get(this.key(name))
    if (entry?.kind !== 'file') throw new Error(`no file called ${name} in ${this.name || 'the root'}`)
    return entry
  }

  dir(name: string): MemoryDirectory {
    const entry = this.children.get(this.key(name))
    if (entry?.kind !== 'directory') throw new Error(`no directory called ${name} in ${this.name || 'the root'}`)
    return entry
  }

  /** Every file below this directory as a path, with directories ending in "/". */
  tree(prefix = ''): string[] {
    return [...this.children.values()].flatMap((c) =>
      c.kind === 'file' ? [`${prefix}${c.name}`] : [`${prefix}${c.name}/`, ...c.tree(`${prefix}${c.name}/`)],
    )
  }
}

export class MemoryFs {
  readonly root: MemoryDirectory

  constructor(readonly options: MemoryFsOptions = {}) {
    this.root = new MemoryDirectory('', this)
  }

  /** The root as the type the code under test expects. */
  get handle(): FileSystemDirectoryHandle {
    return this.root as unknown as FileSystemDirectoryHandle
  }

  check(operation: Operation, name: string, path: string): void {
    const error = this.options.fail?.(operation, name, path)
    if (error) throw error
  }
}

/** The error a browser raises when the disk is full. */
export const quotaExceeded = () => dom('QuotaExceededError', 'The disk is full.')
/** The error a browser raises when permission to write has gone. */
export const notAllowed = () => dom('NotAllowedError', 'Permission was withdrawn.')
/** The error a browser raises for a name it will not create. */
export const nameRefused = () => new TypeError('Name is not allowed.')
