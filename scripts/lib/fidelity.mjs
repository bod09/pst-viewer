// @ts-check
/**
 * The working parts of the fidelity check: record what the worker reads from a
 * mailbox, and compare two such records.
 *
 * Used by scripts/fidelity.mjs (one mailbox, from the command line) and by
 * tests/worker/fidelity.test.ts (the baselines kept in the repository). It is
 * plain JavaScript so the script needs no build step; the types are in the
 * JSDoc comments.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {import('../../src/worker/pst.worker').PstWorkerApi} Api
 * @typedef {import('../../src/types').FolderNode} FolderNode
 * @typedef {import('../../src/types').SourceIndex} SourceIndex
 * @typedef {import('../../src/lib/zip').ZipScanResult} ZipScanResult
 *
 * @typedef {object} Row One message, as the list and the reader show it.
 * @property {string} id
 * @property {string} subject
 * @property {string} from
 * @property {string} to
 * @property {number | null} date
 * @property {boolean} att
 * @property {string} cls
 * @property {string} [body] Hash of the html and text bodies (sampled unless `full`).
 * @property {string} [atts] Attachment names, joined with "|".
 *
 * @typedef {object} FolderRecord
 * @property {string[]} path Folder names from the top of the tree down.
 * @property {number} nth 0, or more when an earlier folder has the same path.
 * @property {number} unreadable
 * @property {Row[]} rows
 *
 * @typedef {object} Snapshot
 * @property {number} format
 * @property {string} file
 * @property {boolean} full Whether every body was hashed, or one in ten.
 * @property {boolean} redacted Whether text was replaced by hashes of itself.
 * @property {number} messages
 * @property {number} bodies
 * @property {FolderRecord[]} folders
 */

/** Bumped when a snapshot's shape changes, so an old baseline is refused, not misread. */
export const FORMAT = 2

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** @param {string | null | undefined} s */
export const sha = (s) =>
  createHash('sha256')
    .update(s ?? '')
    .digest('hex')
    .slice(0, 16)

/**
 * Bundle the worker (and the zip scanner the page uses) for Node.
 *
 * The worker is browser code, but nothing it does while reading a mailbox
 * needs a browser: Comlink is replaced with a stub that hands us the API
 * object it would have exposed, and the index cache disables itself when
 * IndexedDB is absent, so every run is a fresh read.
 *
 * @returns {Promise<{ api: Api, scanZip: (file: File) => Promise<ZipScanResult> }>}
 */
export async function loadWorker() {
  const { build } = await import('vite')
  const outDir = join(ROOT, 'node_modules/.fidelity-build')
  const stub = join(outDir, 'comlink-stub.mjs')
  await mkdir(outDir, { recursive: true })
  await writeFile(
    stub,
    'export function expose(api) { globalThis.__pstWorkerApi = api }\n' +
      'export function proxy(v) { return v }\n' +
      'export function transfer(v) { return v }\n' +
      'export function wrap(v) { return v }\n',
  )

  await build({
    root: ROOT,
    logLevel: 'error',
    configFile: false,
    publicDir: false,
    resolve: { alias: { comlink: stub } },
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node20',
      // An SSR build resolves for Node and leaves dependencies to be imported
      // natively, instead of swapping in the browser shims a normal build uses
      // (node-forge's buffer shim in particular does not survive that).
      ssr: true,
      rollupOptions: {
        input: {
          worker: join(ROOT, 'src/worker/pst.worker.ts'),
          zip: join(ROOT, 'src/lib/zip.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  })
  // The build may split into several .js chunks; this marks them all as ESM
  // so Node imports them the way the bundler wrote them.
  await writeFile(join(outDir, 'package.json'), '{ "type": "module" }\n')

  await import(join(outDir, 'worker.js'))
  const api = /** @type {{ __pstWorkerApi?: Api }} */ (globalThis).__pstWorkerApi
  if (!api) throw new Error('worker did not expose its API')
  const { scanZipForPsts } = await import(join(outDir, 'zip.js'))
  return { api, scanZip: scanZipForPsts }
}

/**
 * Every folder in the tree with the path of names leading to it, the root
 * first (as the empty path), then in the order the sidebar shows them.
 *
 * A folder is known by its path, not its position, so a folder that appears
 * or disappears is reported as that folder rather than shifting every folder
 * after it. Two folders with the same path are told apart by `nth`.
 *
 * @param {FolderNode} root
 * @param {string[]} [prefix]
 * @returns {{ id: string, path: string[], nth: number }[]}
 */
export function folderPaths(root, prefix = []) {
  /** @type {{ id: string, path: string[], nth: number }[]} */
  const out = []
  /** @type {Map<string, number>} */
  const seen = new Map()
  /** @param {FolderNode} node @param {string[]} path */
  const walk = (node, path) => {
    const key = JSON.stringify(path)
    const nth = seen.get(key) ?? 0
    seen.set(key, nth + 1)
    out.push({ id: node.id, path, nth })
    for (const child of node.children ?? []) walk(child, [...path, child.name])
  }
  walk(root, prefix)
  return out
}

/**
 * Record what the worker reads from one open mailbox.
 *
 * @param {Api} api
 * @param {string} sourceId
 * @param {SourceIndex} index
 * @param {{ full: boolean, prefix?: string[] }} options
 * @returns {Promise<Pick<Snapshot, 'messages' | 'bodies' | 'folders'>>}
 */
export async function snapshotSource(api, sourceId, index, { full, prefix = [] }) {
  /** @type {FolderRecord[]} */
  const folders = []
  let messages = 0
  let bodies = 0

  for (const folder of folderPaths(index.rootFolder, prefix)) {
    const { messages: metas, unreadable } = await api.getFolderMessages(sourceId, folder.id)
    /** @type {Row[]} */
    const rows = []
    for (const [i, m] of metas.entries()) {
      // Identity and the fields the list shows. Recorded in folder order,
      // because a change that reorders or duplicates messages is exactly the
      // kind this check exists to catch.
      /** @type {Row} */
      const row = {
        id: m.id,
        subject: m.subject,
        from: `${m.fromName} <${m.fromEmail}>`,
        to: m.to,
        date: m.date,
        att: m.hasAttachments,
        cls: m.messageClass,
      }
      // Bodies are the expensive part, so sample unless `full`. A wrong-message
      // bug shows up in the metadata too, but the body hash is what proves the
      // content actually belongs to this message.
      if (full || i % 10 === 0) {
        const content = await api.getMessageContent(sourceId, m.id)
        row.body = sha(content ? `${content.html ?? ''}${content.text ?? ''}` : '')
        row.atts = (content?.attachments ?? []).map((a) => a.name).join('|')
        bodies++
      }
      rows.push(row)
      messages++
    }
    folders.push({ path: folder.path, nth: folder.nth, unreadable, rows })
  }
  return { messages, bodies, folders }
}

/**
 * Open a file the way dropping it on the app would, and record what is read.
 *
 * A mailbox opens as itself. A message opens as a one-message mailbox. A zip
 * is searched as the page searches it: every mailbox inside is read, each
 * under its own name, and the loose messages together as one more.
 *
 * @param {Api} api
 * @param {File} file
 * @param {{ full: boolean, scanZip: (file: File) => Promise<ZipScanResult> }} options
 * @returns {Promise<Snapshot>}
 */
export async function snapshotFile(api, file, { full, scanZip }) {
  /** @type {Snapshot} */
  const snapshot = {
    format: FORMAT,
    file: file.name,
    full,
    redacted: false,
    messages: 0,
    bodies: 0,
    folders: [],
  }
  let n = 0
  /** @param {(id: string) => Promise<SourceIndex>} open @param {string[]} prefix */
  const read = async (open, prefix) => {
    const sourceId = `fidelity-${n++}`
    const index = await open(sourceId)
    try {
      await api.indexSource(sourceId)
      const part = await snapshotSource(api, sourceId, index, { full, prefix })
      snapshot.messages += part.messages
      snapshot.bodies += part.bodies
      snapshot.folders.push(...part.folders)
    } finally {
      await api.closeSource(sourceId)
    }
  }

  if (/\.zip$/i.test(file.name)) {
    const { psts, msgs } = await scanZip(file)
    if (psts.length === 0 && msgs.length === 0) throw new Error('no mailbox or message files in this zip')
    for (const entry of psts) await read((id) => api.openSource(id, entry.file), [entry.path])
    if (msgs.length) {
      const files = msgs.map((m) => m.file)
      await read((id) => api.openMsgSource(id, files), ['(loose messages)'])
    }
  } else if (/\.(msg|eml)$/i.test(file.name)) {
    await read((id) => api.openMsgSource(id, [file]), [])
  } else {
    await read((id) => api.openSource(id, file), [])
  }
  return snapshot
}

/**
 * The same snapshot with every piece of text from the mailbox (folder names,
 * subjects, people, attachment names) replaced by a hash of itself.
 *
 * A redacted snapshot holds none of the mail's words and still fails when
 * any of it is read differently, which is how the baselines of the public
 * test mailboxes can be kept in the repository. It is not a way to publish
 * private mail: the hash of a short or guessable text ("Inbox", a common
 * subject) can be found by guessing.
 *
 * @param {Snapshot} snapshot
 * @returns {Snapshot}
 */
export function redact(snapshot) {
  if (snapshot.redacted) return snapshot
  return {
    ...snapshot,
    redacted: true,
    folders: snapshot.folders.map((f) => ({
      ...f,
      path: f.path.map(sha),
      rows: f.rows.map((r) => ({
        ...r,
        subject: sha(r.subject),
        from: sha(r.from),
        to: sha(r.to),
        ...(r.atts === undefined ? {} : { atts: sha(r.atts) }),
      })),
    })),
  }
}

/** @param {FolderRecord} f */
const folderKey = (f) => JSON.stringify([f.path, f.nth])

/**
 * What differs between a baseline and what is read now, in words that point
 * at the cause. Empty when they match.
 *
 * `plain` is the current snapshot before redaction, when the two being
 * compared are redacted: it lets a difference be shown as the folder and text
 * it is about, read from the mailbox in front of you, instead of as a hash.
 *
 * @param {Snapshot} baseline
 * @param {Snapshot} current
 * @param {Snapshot} [plain]
 * @param {number} [limit]
 * @returns {string[]}
 */
export function diff(baseline, current, plain = current, limit = 30) {
  /** @type {string[]} */
  const problems = []
  const redacted = current.redacted
  /** @param {unknown} v */
  const show = (v) => JSON.stringify(v)
  /** @param {FolderRecord} f */
  const nameOf = (f) => (f.path.length ? f.path.join(' > ') : '(top of the mailbox)') + (f.nth ? ` #${f.nth + 1}` : '')

  if (baseline.messages !== current.messages) {
    problems.push(`message count: baseline ${baseline.messages}, now ${current.messages}`)
  }

  const now = new Map(current.folders.map((f, i) => [folderKey(f), { folder: f, plain: plain.folders[i] }]))
  const before = new Set(baseline.folders.map(folderKey))

  for (const { folder, plain: plainFolder } of now.values()) {
    if (before.has(folderKey(folder))) continue
    // An empty folder appearing is still a change in what the sidebar shows.
    problems.push(`new folder: ${nameOf(plainFolder)} (${folder.rows.length} messages)`)
  }

  for (const old of baseline.folders) {
    if (problems.length > limit) break
    const match = now.get(folderKey(old))
    if (!match) {
      const name = redacted ? `a folder that held ${old.rows.length} messages (its name is hashed in the baseline)` : nameOf(old)
      problems.push(`folder gone: ${name}`)
      continue
    }
    const { folder, plain: plainFolder } = match
    const name = nameOf(plainFolder)
    if (old.unreadable !== folder.unreadable) {
      problems.push(`${name}: ${old.unreadable} unreadable in baseline, ${folder.unreadable} now`)
    }
    if (old.rows.length !== folder.rows.length) {
      problems.push(`${name}: ${old.rows.length} messages in baseline, ${folder.rows.length} now`)
    }
    const n = Math.min(old.rows.length, folder.rows.length)
    for (let i = 0; i < n && problems.length <= limit; i++) {
      const a = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (old.rows[i]))
      const b = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (folder.rows[i]))
      const p = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (plainFolder.rows[i]))
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (show(a[key]) === show(b[key])) continue
        // Hashes on both sides say nothing a person can use; the text as it
        // is read now does.
        const hashed = redacted && show(b[key]) !== show(p[key])
        problems.push(
          hashed
            ? `${name}[${i}] ${key}: differs from the baseline, now ${show(p[key])}`
            : `${name}[${i}] ${key}: ${show(a[key])} -> ${show(b[key])}`,
        )
        break
      }
    }
  }
  return problems.slice(0, limit)
}

/**
 * Why a stored baseline cannot be compared against, or null if it can.
 *
 * @param {unknown} baseline
 * @returns {string | null}
 */
export function unusable(baseline) {
  const b = /** @type {Partial<Snapshot> | null} */ (baseline)
  if (!b || typeof b !== 'object') return 'it is not a baseline'
  if (b.format !== FORMAT) return 'it was written by an older version of this check'
  if (typeof b.full !== 'boolean' || typeof b.redacted !== 'boolean' || !Array.isArray(b.folders)) {
    return 'it is incomplete'
  }
  return null
}

/**
 * Check a file against a baseline, sampling and redacting exactly as the
 * baseline was recorded, so the two can differ only if the mail is read
 * differently.
 *
 * @param {Api} api
 * @param {File} file
 * @param {Snapshot} baseline
 * @param {(file: File) => Promise<ZipScanResult>} scanZip
 * @returns {Promise<{ problems: string[], current: Snapshot }>}
 */
export async function check(api, file, baseline, scanZip) {
  const plain = await snapshotFile(api, file, { full: baseline.full, scanZip })
  const current = baseline.redacted ? redact(plain) : plain
  return { problems: diff(baseline, current, plain), current: plain }
}
